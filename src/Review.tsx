import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { emit, listen } from "@tauri-apps/api/event";
import { revealItemInDir, openUrl } from "@tauri-apps/plugin-opener";
import { ask, open } from "@tauri-apps/plugin-dialog";
import { Icon, I, P } from "./components/icons";
import SegmentTrack from "./components/SegmentTrack";
import Waveform from "./Waveform";
import ScrubPreview from "./ScrubPreview";

// Review window. Left column is player + timeline; right column is an
// accordion panel (Trim / Bubble / Zoom / Watermark / Export sections plus a
// pinned lifecycle footer). Supersedes the docs/design/surfaces/review.jsx
// mock's top-toolbar layout — the toolbar's intrinsic width outgrew the
// left column as tools were added, and the old label-beside-control rows
// overflowed the 296px panel (the CSS overflow-y:auto side effect turned
// that into a horizontal scrollbar).
//
// Operates against the Phase 5.5 scratch path: Save commits the recording
// to ~/Movies/Zeigen/ (baking edits if any), Discard destroys the scratch
// dir entirely. Both close the window on success.

type Position = { x: number; y: number };

type Trim = { in: number; out: number };

// Mirror of src-tauri/src/edit.rs::BubblePositionEntry. Round-tripped
// opaquely by the review window — finalize-time keyframes must survive
// any sidecar rewrite the review triggers (trim edits, or the
// empty-state delete path). Phase 15 c3's dual-stream player will
// read these directly to position the bubble in the preview.
type BubblePositionEntry = {
  t: number;
  x: number;
  y: number;
  diameter?: number | null;
};

// Mirror of src-tauri/src/edit.rs::ZoomKeyframe (zoom-layer step 2 schema).
// t is seconds on the original recording timeline; center is in video
// pixel space; auto_generated marks step-5 suggestion output
// (this UI only writes false — editing a suggested segment will clear it).
type ZoomEase = "in_out_cubic" | "linear";
type ZoomKeyframe = {
  t: number;
  scale: number;
  center_x: number;
  center_y: number;
  ease?: ZoomEase;
  auto_generated?: boolean;
};

// UI model — one zoom window the user edits on the timeline. The sidecar
// stores keyframes; segments<->keyframes conversion below.
type ZoomSegment = {
  start: number;
  end: number;
  scale: number;
  center_x: number;
  center_y: number;
  auto_generated: boolean;
};

const ZOOM_DEFAULT_DURATION = 3;
const ZOOM_MIN_DURATION = 0.5;
// V3-PLAN C.1 calm rules: 600ms ease-in-out ramps, 2.5x scale cap.
const ZOOM_RAMP_S = 0.6;
const ZOOM_MIN_SCALE = 1.1;
const ZOOM_MAX_SCALE = 2.5;
const ZOOM_DEFAULT_SCALE = 2.0;
// Looped slow preview of the selected zoom (Slice 1.5). Half speed so the
// 600ms ramps read as motion; a short pre-roll to see the ramp-in enter and
// a longer tail to see it settle. The window is clamped inside the trim
// range so the loop's own wrap never collides with the trim-out wrap.
const ZOOM_PREVIEW_RATE = 0.5;
const ZOOM_PREVIEW_PRE_S = 0.5;
const ZOOM_PREVIEW_POST_S = 1.0;

// Segment -> canonical keyframe run: 1.0 at the edges, full scale between,
// ramps ZOOM_RAMP_S long (halved for short segments). All keyframes of a
// segment share its center and auto_generated flag. Key order matters:
// statesEqual compares JSON.stringify against sidecar keyframes as Rust
// serializes them (t, scale, center_x, center_y, ease, auto_generated).
function zoomSegmentsToKeyframes(segments: ZoomSegment[]): ZoomKeyframe[] {
  const kfs: ZoomKeyframe[] = [];
  for (const seg of [...segments].sort((a, b) => a.start - b.start)) {
    const rest = {
      center_x: seg.center_x,
      center_y: seg.center_y,
      ease: "in_out_cubic" as ZoomEase,
      auto_generated: seg.auto_generated,
    };
    const dur = seg.end - seg.start;
    const ramp = Math.min(ZOOM_RAMP_S, dur / 2);
    kfs.push({ t: seg.start, scale: 1, ...rest });
    if (dur > 2 * ramp) {
      kfs.push({ t: seg.start + ramp, scale: seg.scale, ...rest });
      kfs.push({ t: seg.end - ramp, scale: seg.scale, ...rest });
    } else {
      kfs.push({ t: seg.start + dur / 2, scale: seg.scale, ...rest });
    }
    kfs.push({ t: seg.end, scale: 1, ...rest });
  }
  return kfs;
}

// Keyframes -> editable segments. A segment is a run from a scale-1
// keyframe through scale>1 interiors to the next scale-1 keyframe — the
// exact shape zoomSegmentsToKeyframes writes, so round-trip is identity for
// tracks this UI produced. Tracks from other writers parse best-effort (max
// interior scale wins) and the next edit canonicalizes them back to this
// shape on save.
function zoomKeyframesToSegments(kfs: ZoomKeyframe[]): ZoomSegment[] {
  const sorted = [...kfs].sort((a, b) => a.t - b.t);
  const segments: ZoomSegment[] = [];
  let i = 0;
  while (i < sorted.length) {
    if (sorted[i].scale <= 1.001) {
      i++;
      continue;
    }
    let j = i;
    while (j < sorted.length && sorted[j].scale > 1.001) j++;
    let peak = sorted[i];
    for (let k = i; k < j; k++) if (sorted[k].scale > peak.scale) peak = sorted[k];
    segments.push({
      start: i > 0 ? sorted[i - 1].t : sorted[i].t,
      end: j < sorted.length ? sorted[j].t : sorted[j - 1].t,
      scale: peak.scale,
      center_x: peak.center_x,
      center_y: peak.center_y,
      auto_generated: peak.auto_generated ?? false,
    });
    i = j;
  }
  return segments;
}

function easeInOutCubic(u: number): number {
  return u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
}

// Zoom state at playhead time t — the reference implementation of the
// sidecar keyframe semantics (600ms in_out_cubic ramps at the segment
// edges, full scale between) expressed over the canonical segment shape.
// The step-4 export renderer must reproduce exactly this curve for
// preview/export parity; do not change one without the other.
function zoomAt(
  segments: ZoomSegment[],
  t: number,
): { scale: number; center_x: number; center_y: number } | null {
  for (const seg of segments) {
    if (t < seg.start || t > seg.end) continue;
    const dur = seg.end - seg.start;
    const ramp = Math.min(ZOOM_RAMP_S, dur / 2);
    let scale: number;
    if (ramp <= 0) {
      scale = seg.scale;
    } else if (t < seg.start + ramp) {
      scale = 1 + (seg.scale - 1) * easeInOutCubic((t - seg.start) / ramp);
    } else if (t > seg.end - ramp) {
      scale = 1 + (seg.scale - 1) * easeInOutCubic((seg.end - t) / ramp);
    } else {
      scale = seg.scale;
    }
    return { scale, center_x: seg.center_x, center_y: seg.center_y };
  }
  return null;
}

// Timeline + stage + right-panel Zoom section share this.
type ZoomEditor = {
  segments: ZoomSegment[];
  selectedIndex: number | null;
  select: (i: number | null) => void;
  update: (i: number, patch: Partial<ZoomSegment>) => void;
  remove: (i: number) => void;
  // Wipe every zoom (auto + manual) and deselect — the escape hatch back to a
  // plain -c:v copy export after the mount-time auto-load populates the lane.
  clearAll: () => void;
  // Add a zoom starting at time t (clicked blank track); t inside an existing
  // zoom selects it instead. Add + select, never deselect-first.
  addAt: (t: number) => void;
  // Neighbor-bounded window per segment so zooms can't overlap.
  bounds: (i: number) => { min: number; max: number };
  canAdd: boolean;
  // Step 5: fill the lane with auto_generated suggestions from the cursor
  // telemetry. Replaces previous suggestions; manual segments are kept.
  suggest: () => void;
  suggesting: boolean;
  // True while a looped slow preview of the selected zoom is playing. Drives
  // the stage: un-suppresses the live zoom transform (so the motion is
  // visible) and hides the crop-box edit layer for the duration.
  looping: boolean;
};

// V2 Step 2: the ONE constant zone the export bakes the webcam bubble at.
// Wire values are the snake_case serde names of composite.rs's BubbleZone.
type BubbleZone =
  | "top_left"
  | "top_center"
  | "top_right"
  | "bottom_left"
  | "bottom_center"
  | "bottom_right";

// The 6 zones in 2x3 row-major order (top row, then bottom row) for the
// picker grid.
const BUBBLE_ZONES: BubbleZone[] = [
  "top_left",
  "top_center",
  "top_right",
  "bottom_left",
  "bottom_center",
  "bottom_right",
];

// Screen-pixel padding the export bakes the bubble off each pinned edge.
// Mirrors composite.rs PADDING_PX; used to offset the parked preview.
const BUBBLE_ZONE_PADDING_PX = 30;

function zoneHAlign(z: BubbleZone): "left" | "center" | "right" {
  if (z === "top_left" || z === "bottom_left") return "left";
  if (z === "top_center" || z === "bottom_center") return "center";
  return "right";
}

function zoneVAlign(z: BubbleZone): "top" | "bottom" {
  return z.startsWith("top") ? "top" : "bottom";
}

// Mirror of composite.rs resolve_zone's migration path: nearest of the FOUR
// corners to the position-log centroid; empty log -> bottom_right default.
// Keep this rule in sync with the Rust side — export re-derives it whenever
// bubble_zone is absent, so the preview and the exported file must agree.
function nearestCornerZone(log: BubblePositionEntry[]): BubbleZone {
  if (log.length === 0) return "bottom_right";
  const n = log.length;
  const cx = log.reduce((s, e) => s + e.x, 0) / n;
  const cy = log.reduce((s, e) => s + e.y, 0) / n;
  const right = cx >= 0.5;
  const bottom = cy >= 0.5;
  return bottom ? (right ? "bottom_right" : "bottom_left") : right ? "top_right" : "top_left";
}

type SidecarState = {
  trim?: Trim | null;
  bubble_position_log?: BubblePositionEntry[];
  // V2 Step 2: constant bubble zone picked in Review. null/undefined = no
  // explicit pick; export migrates from the position-log centroid (nearest
  // corner) via composite::resolve_zone. Only written once the user picks.
  bubble_zone?: BubbleZone | null;
  // Original-timeline timestamp picked via the Thumbnail tool. null/undefined
  // means "use the export-time default" (0.5s in) applied on the Rust side.
  // Stored in original-timeline coords.
  thumbnail_time?: number | null;
  // Bubble corner roundness, 0.0 (square)..1.0 (circle). null/undefined =
  // circle via the legacy mask path — composite.rs keeps that branch
  // byte-identical to pre-E1, so the slider only writes the field when the
  // user moves it off full circle.
  bubble_roundness?: number | null;
  // Zoom layer keyframes (step-2 schema). Undefined/empty = no zoom; the
  // debounced save writes the field only when non-empty so a no-zoom
  // sidecar stays byte-identical to a pre-zoom one (the step-2 governing
  // invariant — Rust's skip_serializing_if enforces the same on its side).
  zoom?: ZoomKeyframe[];
};

const EMPTY_STATE: SidecarState = {
  trim: null,
  bubble_position_log: [],
  thumbnail_time: null,
  bubble_roundness: null,
  bubble_zone: null,
  zoom: [],
};

const SIDECAR_DEBOUNCE_MS = 350;
const TRIM_EPS = 0.05;

// Keyboard transport constants. FRAME_SECONDS assumes 30fps — same
// assumption composite.rs's mask/shadow loop inputs make; screen
// captures are VFR so this is an approximation, not exact frame math.
const SEEK_SECONDS = 5;
const FRAME_SECONDS = 1 / 30;
const PLAYBACK_SPEEDS = [1, 1.5, 2] as const;

function cyclePlaybackRate(current: number, dir: 1 | -1): number {
  const idx = PLAYBACK_SPEEDS.indexOf(current as (typeof PLAYBACK_SPEEDS)[number]);
  const base = idx === -1 ? 0 : idx;
  const next = (base + dir + PLAYBACK_SPEEDS.length) % PLAYBACK_SPEEDS.length;
  return PLAYBACK_SPEEDS[next];
}

type WmCorner = "tl" | "tr" | "bl" | "br";
const WM_CORNERS: WmCorner[] = ["tl", "tr", "bl", "br"];

// Mirrors the Rust settings::Settings shape (settings.json).
type AppSettings = {
  watermark: {
    logo_path: string | null;
    corner: string;
    // Logo width as a fraction of video width; null = legacy sizing
    // (10% of the shorter dimension, by height).
    scale?: number | null;
    // Alpha multiplier 0..1; null = 1 (legacy, no fade filter).
    opacity?: number | null;
  };
};

// Watermark controls passed to ExportPanel. logoPath/corner/scale/opacity
// persist via settings.json; apply is per-recording (not persisted).
// `scale` is the raw setting (null = legacy sizing) — what exports receive;
// `scaleDisplay` is what the slider shows (the legacy-equivalent fraction
// until the user first drags).
type WatermarkUI = {
  logoPath: string | null;
  corner: WmCorner;
  apply: boolean;
  scale: number | null;
  scaleDisplay: number;
  opacity: number;
  onPick: () => void;
  onRemove: () => void;
  onCorner: (c: WmCorner) => void;
  onToggleApply: () => void;
  onScale: (frac: number) => void;
  onOpacity: (o: number) => void;
};

// Watermark preview passed to VideoStage. src is the convertFileSrc'd logo
// (or null when nothing should render); videoDims drives the content-box
// computation so the overlay tracks the letterboxed video, not the stage.
// scale/opacity mirror the export semantics (null scale = legacy sizing).
type WatermarkPreview = {
  src: string | null;
  corner: WmCorner;
  videoDims: { w: number; h: number } | null;
  scale: number | null;
  opacity: number;
};

// Thumbnail controls passed from Review → LeftColumn → Toolbar. The Toolbar
// renders the button + a popover anchored to it; the popover shows a paused
// preview <video> at whatever currentTime the user had when they clicked.
// previewUrl is the same source the main player uses (raw scratch during NR
// render window, preview-screen.mp4 once ready) — capture-time consistency
// matters less than just "show the same frame they're looking at."
type ThumbnailControls = {
  thumbnailTime: number | null;
  setThumbnailTime: (t: number | null) => void;
  previewUrl: string | null;
  getCurrentTime: () => number;
};


type ReviewParams = {
  // Logical scratch identity — what save/discard/clipboard pin against.
  path: string | null;
  // Phase 15 c3 dual-stream inputs. screenPath always set when path is
  // set (App.tsx sends both). webcamPath null for screen-only.
  screenPath: string | null;
  webcamPath: string | null;
  webcamLeadMs: number;
};

function readParams(): ReviewParams {
  const hash = window.location.hash || "";
  const q = hash.indexOf("?");
  if (q < 0) return { path: null, screenPath: null, webcamPath: null, webcamLeadMs: 280 };
  const params = new URLSearchParams(hash.slice(q + 1));
  const leadStr = params.get("webcamLeadMs");
  const lead = leadStr ? Number(leadStr) : 280;
  return {
    path: params.get("path"),
    screenPath: params.get("screenPath"),
    webcamPath: params.get("webcamPath"),
    webcamLeadMs: Number.isFinite(lead) ? lead : 280,
  };
}

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(i + 1) : p;
}

// Parse the recording stamp out of a path (scratch or final). All Phase 6
// commands that touch the per-recording exports temp dir need this stamp
// so they can compose the dir name independent of where the recording
// currently lives. Returns null for paths that don't look like ours.
function parseStampFromPath(p: string): string | null {
  const m = p.match(/recording-(\d{4}-\d{2}-\d{2}-\d{6})/);
  return m ? m[1] : null;
}

function fmt(s: number | null | undefined): string {
  if (s == null || !isFinite(s)) return "--:--";
  const m = Math.floor(s / 60);
  const ss = Math.floor(s % 60);
  return `${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

// Normalize trim: an "untrimmed" range [0, duration] is logically equivalent
// to no trim at all. Storing the canonical form keeps dirty-detection honest
// and keeps the sidecar file empty for clips with no edits.
function normalizeTrim(trim: Trim | null | undefined, duration: number | null): Trim | null {
  if (!trim || duration == null) return null;
  if (trim.in <= TRIM_EPS && trim.out >= duration - TRIM_EPS) return null;
  return trim;
}

function statesEqual(a: SidecarState, b: SidecarState, duration: number | null): boolean {
  const ta = normalizeTrim(a.trim, duration);
  const tb = normalizeTrim(b.trim, duration);
  if ((ta == null) !== (tb == null)) return false;
  if (ta && tb && (Math.abs(ta.in - tb.in) > TRIM_EPS || Math.abs(ta.out - tb.out) > TRIM_EPS)) {
    return false;
  }
  const tta = a.thumbnail_time ?? null;
  const ttb = b.thumbnail_time ?? null;
  if ((tta == null) !== (ttb == null)) return false;
  if (tta != null && ttb != null && Math.abs(tta - ttb) > TRIM_EPS) return false;
  const bra = a.bubble_roundness ?? null;
  const brb = b.bubble_roundness ?? null;
  if ((bra == null) !== (brb == null)) return false;
  if (bra != null && brb != null && Math.abs(bra - brb) > 0.001) return false;
  if ((a.bubble_zone ?? null) !== (b.bubble_zone ?? null)) return false;
  const za = a.zoom ?? [];
  const zb = b.zoom ?? [];
  if (za.length !== zb.length) return false;
  for (let i = 0; i < za.length; i++) {
    if (JSON.stringify(za[i]) !== JSON.stringify(zb[i])) return false;
  }
  return true;
}

// V2 Step 2: the bubble no longer animates along the position log. It's
// parked at ONE constant zone (BubbleLayer computes the parked CSS transform
// from the effective zone). The log survives only as the diameter source and
// as the migration input for the zone default. DEFAULT_BUBBLE_DIAMETER_PX is
// the fallback when a sidecar logged no diameter.
const DEFAULT_BUBBLE_DIAMETER_PX = 240; // mirrors WebcamSize::Medium

function isLogicallyEmpty(s: SidecarState, duration: number | null): boolean {
  // Bubble keyframes are finalize-time data the review must preserve —
  // even a "no edits yet" sidecar with only bubble_position_log is NOT
  // empty, or the delete branch below would wipe the keyframes.
  const noBubble = !s.bubble_position_log || s.bubble_position_log.length === 0;
  const noThumb = s.thumbnail_time == null;
  const noRoundness = s.bubble_roundness == null;
  const noZone = s.bubble_zone == null;
  const noZoom = !s.zoom || s.zoom.length === 0;
  return (
    normalizeTrim(s.trim, duration) == null &&
    noBubble &&
    noThumb &&
    noRoundness &&
    noZone &&
    noZoom
  );
}

// The exact on-disk shape the debounced persist writes: normalized trim, and
// the two "absent unless set" fields (bubble_zone, zoom) dropped to undefined
// when empty so untouched / pre-feature sidecars stay byte-identical. Shared
// by the debounce and the mount-time zoom auto-load so both write the same
// bytes for the same state.
function sidecarWritePayload(s: SidecarState, duration: number): SidecarState {
  return {
    trim: normalizeTrim(s.trim, duration),
    bubble_position_log: s.bubble_position_log,
    thumbnail_time: s.thumbnail_time ?? null,
    bubble_roundness: s.bubble_roundness ?? null,
    bubble_zone: s.bubble_zone ?? undefined,
    zoom: s.zoom && s.zoom.length > 0 ? s.zoom : undefined,
  };
}

// Phase 14 c2. Tracks the NR-processed preview MP4 the main <video>
// switches to once arnndn has run over the scratch source — so the user
// can audibly verify NR before save. "rendering" is the eager wait at
// review-open (D-08 measured 0.63s for a 22s clip); "ready" carries the
// converted file URL; "failed" leaves playback on the raw scratch and
// surfaces a pip (D-10). Saved files unchanged (D-01).
type PreviewState =
  | { status: "rendering" }
  | { status: "ready"; url: string }
  | { status: "failed" };

export default function Review() {
  const [params] = useState(() => readParams());
  const sourcePath = params.path;
  // Phase 15 c3 dual-stream inputs. screenPath drives the screen <video>
  // (and the NR preview pipeline); webcamPath drives the bubble <video>;
  // webcamLeadMs is the camera-start delay applied via currentTime
  // offset to match composite::WEBCAM_LEAD_MS at export time. For
  // screen-only recordings webcamPath is null and the bubble renders
  // nothing — playback is single-stream against screenPath.
  const screenPath = params.screenPath ?? sourcePath;
  const webcamPath = params.webcamPath;
  const webcamLeadSec = params.webcamLeadMs / 1000;

  const assetUrl = useMemo(
    () => (screenPath ? convertFileSrc(screenPath) : null),
    [screenPath],
  );
  const webcamAssetUrl = useMemo(
    () => (webcamPath ? convertFileSrc(webcamPath) : null),
    [webcamPath],
  );

  // Screen <video> is the playback master. webcamVideoRef is slaved via
  // timeupdate/play/pause/seek/ratechange (see syncWebcamEffect below).
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const webcamVideoRef = useRef<HTMLVideoElement | null>(null);
  const [duration, setDuration] = useState<number | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [error, setError] = useState<string | null>(null);
  // Soft info message — currently only fired post-save when the user's
  // thumbnail pick fell outside the trim range and the backend used the
  // clamped fallback. Distinct from `error` (red, destructive styling).
  const [notice, setNotice] = useState<string | null>(null);
  // Notices are transient (e.g. "10 zooms suggested") — auto-dismiss after a
  // few seconds so the strip never lingers over the zoom lane. The × on the
  // strip still dismisses immediately.
  useEffect(() => {
    if (notice == null) return;
    const id = setTimeout(() => setNotice(null), 5000);
    return () => clearTimeout(id);
  }, [notice]);
  // S — audio-stream start_time in seconds, fetched once at review-open.
  // Threaded into Waveform alongside the video duration so peaks map onto the
  // video-time timeline instead of audio-time. Null until probe_audio_track
  // resolves; Waveform falls back to the pre-Phase-13 a/A mapping while null.
  const [audioStart, setAudioStart] = useState<number | null>(null);

  const [previewState, setPreviewState] = useState<PreviewState>({ status: "rendering" });
  // currentTime to restore across the raw→preview src swap. Captured
  // synchronously when the preview becomes ready (before React commits the
  // new src) because the browser resets currentTime to 0 on src change.
  const swapRestoreTimeRef = useRef<number | null>(null);

  // Edit state.
  const [trim, setTrim] = useState<Trim | null>(null);
  // Round-tripped opaquely. The frontend never mutates this; it just
  // preserves what finalize wrote so sidecar rewrites (trim edits,
  // empty-state delete path) don't wipe the bubble keyframes.
  const [bubblePositionLog, setBubblePositionLog] = useState<BubblePositionEntry[]>([]);
  const [bubbleRoundness, setBubbleRoundness] = useState<number | null>(null);
  // V2 Step 2: explicit bubble zone. null until the user picks one — the
  // effective zone for preview + picker highlight falls back to the
  // migration default (nearest corner to the log centroid). Only a real pick
  // dirties the sidecar; untouched recordings keep bubble_zone absent and the
  // export re-derives the same default.
  const [bubbleZone, setBubbleZone] = useState<BubbleZone | null>(null);
  // Original-timeline timestamp for the user's chosen poster frame. null =
  // unset; export-time default (0.5s in) is applied on the Rust side.
  const [thumbnailTime, setThumbnailTime] = useState<number | null>(null);
  const [snapshot, setSnapshot] = useState<SidecarState>(EMPTY_STATE);

  const [saving, setSaving] = useState(false);
  // 0-1 fraction from the Rust "save-progress" event, emitted from
  // ffmpeg's -progress out_time_us during save_recording. null when not
  // saving — distinct from 0 so the Save button can tell "about to start"
  // from "started, no progress line yet" if that distinction ever matters.
  const [saveProgress, setSaveProgress] = useState<number | null>(null);
  const [discarding, setDiscarding] = useState(false);
  const [showCloseModal, setShowCloseModal] = useState(false);
  const busy = saving || discarding;

  // Save-state: lastSavedPath drives Reveal target, Discard-disabled, and
  // the close-window modal gate (modal fires only when null). committedMp4Path
  // tracks the most recent MP4 specifically so the LinkedIn chain can reuse
  // an existing baseline instead of always producing a fresh commit. After a
  // GIF save these two diverge — lastSavedPath points at the .gif, but
  // committedMp4Path keeps the prior MP4 path so LinkedIn still targets MP4.
  const [lastSavedPath, setLastSavedPath] = useState<string | null>(null);
  const [committedMp4Path, setCommittedMp4Path] = useState<string | null>(null);
  const [lastSavedAt, setLastSavedAt] = useState(0);

  // Format/resolution/fps live here (not in ExportPanel) so the close-window
  // modal's Save button can commit with the user's current ExportPanel
  // selection instead of guessing defaults.
  const [format, setFormat] = useState<"mp4" | "gif">("mp4");
  const [mp4Res, setMp4Res] = useState<"480p" | "720p" | "1080p" | "source">("1080p");
  const [gifRes, setGifRes] = useState<"480p" | "720p" | "source">("720p");
  const [gifFps, setGifFps] = useState<10 | 15 | 20>(15);

  // Watermark (c3). logoPath + corner are the remembered global settings;
  // apply is per-recording (default on once a logo is set) — turning it off
  // skips the watermark on this clip without forgetting the logo. videoDims
  // is captured at metadata so the preview can size against the real frame.
  const [wmLogoPath, setWmLogoPath] = useState<string | null>(null);
  const [wmCorner, setWmCorner] = useState<WmCorner>("tr");
  const [wmApply, setWmApply] = useState(false);
  // Size/opacity (remembered in settings.json like corner). wmScale null =
  // legacy sizing; wmOpacity 1 = legacy full opacity — untouched sliders
  // leave the export filter string byte-identical.
  const [wmScale, setWmScale] = useState<number | null>(null);
  const [wmOpacity, setWmOpacity] = useState(1);
  const wmSettingsLoadedRef = useRef(false);
  const [videoDims, setVideoDims] = useState<{ w: number; h: number } | null>(null);

  // Zoom layer (step 3). UI state is segments; the sidecar stores the
  // step-2 keyframe schema — converted on read and in currentState below.
  const [zoomSegments, setZoomSegments] = useState<ZoomSegment[]>([]);
  const [zoomSelectedIndex, setZoomSelectedIndex] = useState<number | null>(null);
  // Flips true once the mount-time read_sidecar settles. Gates the zoom
  // auto-load below so it never runs before we know whether the sidecar
  // already carried a zoom track (which would double-suggest).
  const [sidecarLoaded, setSidecarLoaded] = useState(false);

  useEffect(() => {
    invoke<AppSettings>("get_settings")
      .then((s) => {
        const lp = s.watermark?.logo_path ?? null;
        const c = (s.watermark?.corner ?? "tr") as WmCorner;
        setWmLogoPath(lp);
        setWmCorner(WM_CORNERS.includes(c) ? c : "tr");
        setWmApply(!!lp);
        setWmScale(s.watermark?.scale ?? null);
        setWmOpacity(s.watermark?.opacity ?? 1);
        wmSettingsLoadedRef.current = true;
      })
      .catch((err) => console.warn("get_settings failed", err));
  }, []);

  // Debounced persist of the slider values — live drags update state per
  // tick; settings.json gets one write when the drag settles. Gated on the
  // initial load so mount doesn't write defaults back.
  useEffect(() => {
    if (!wmSettingsLoadedRef.current) return;
    const t = window.setTimeout(() => {
      invoke("set_watermark_style", {
        scale: wmScale,
        opacity: wmOpacity < 1 ? wmOpacity : null,
      }).catch((err) => console.warn("set_watermark_style failed", err));
    }, 350);
    return () => window.clearTimeout(t);
  }, [wmScale, wmOpacity]);

  // Logo natural dims — used to position an untouched Size slider at the
  // legacy sizing's width-equivalent, so the first drag starts from the
  // watermark's current visual size instead of jumping.
  const [wmLogoDims, setWmLogoDims] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    if (!wmLogoPath) {
      setWmLogoDims(null);
      return;
    }
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (!cancelled) setWmLogoDims({ w: img.naturalWidth, h: img.naturalHeight });
    };
    img.src = convertFileSrc(wmLogoPath);
    return () => {
      cancelled = true;
    };
  }, [wmLogoPath]);

  // Legacy sizing expressed as width-fraction of THIS recording's video:
  // logo height = 10% of shorter dim, width follows the logo's aspect.
  const wmLegacyFrac = useMemo(() => {
    if (!videoDims || !wmLogoDims || wmLogoDims.h === 0) return 0.15;
    const logoH = 0.1 * Math.min(videoDims.w, videoDims.h);
    const frac = (logoH * (wmLogoDims.w / wmLogoDims.h)) / videoDims.w;
    return Math.min(0.4, Math.max(0.05, frac));
  }, [videoDims, wmLogoDims]);

  const onPickLogo = useCallback(async () => {
    try {
      const picked = await open({
        multiple: false,
        filters: [{ name: "PNG", extensions: ["png"] }],
      });
      if (typeof picked !== "string") return; // cancelled
      const s = await invoke<AppSettings>("set_watermark_logo", { sourcePath: picked });
      setWmLogoPath(s.watermark?.logo_path ?? null);
      setWmApply(!!s.watermark?.logo_path);
    } catch (err) {
      setError(`watermark: ${err}`);
    }
  }, []);

  const onRemoveLogo = useCallback(async () => {
    try {
      await invoke("clear_watermark_logo");
    } catch (err) {
      console.warn("clear_watermark_logo failed", err);
    }
    setWmLogoPath(null);
    setWmApply(false);
  }, []);

  const onCornerChange = useCallback((c: WmCorner) => {
    setWmCorner(c);
    invoke("set_watermark_corner", { corner: c }).catch((err) =>
      console.warn("set_watermark_corner failed", err),
    );
  }, []);

  const onToggleApply = useCallback(() => setWmApply((a) => !a), []);

  // apply && logo set => the effective logo baked into exports / shown in
  // the preview. null otherwise (apply off, or no logo).
  const wmEffectiveLogo = wmApply && wmLogoPath ? wmLogoPath : null;

  const selectZoom = useCallback((i: number | null) => {
    setZoomSelectedIndex(i);
  }, []);

  // Any edit marks the segment manual — step-5 regeneration must never
  // stomp something the user touched.
  const updateZoom = useCallback((i: number, patch: Partial<ZoomSegment>) => {
    setZoomSegments((prev) =>
      prev.map((s, k) => (k === i ? { ...s, ...patch, auto_generated: false } : s)),
    );
  }, []);

  const deleteZoom = useCallback((i: number) => {
    setZoomSegments((prev) => prev.filter((_, k) => k !== i));
    setZoomSelectedIndex(null);
  }, []);

  // Add a zoom starting at time `t` (clicked blank track). Fits it into the
  // free window around t — zoom segments never overlap. t already inside a
  // zoom selects that zoom instead of adding (so clicking a zoom's band
  // selects it; clicking a gap adds + selects).
  const addZoomAt = useCallback(
    (t: number) => {
      if (duration == null || !videoDims) return;
      let lo = 0;
      let hi = duration;
      for (let i = 0; i < zoomSegments.length; i++) {
        const seg = zoomSegments[i];
        if (seg.end <= t) {
          lo = Math.max(lo, seg.end);
        } else if (seg.start >= t) {
          hi = Math.min(hi, seg.start);
        } else {
          selectZoom(i);
          return;
        }
      }
      const start = Math.max(lo, Math.min(t, hi - ZOOM_MIN_DURATION));
      const end = Math.min(hi, start + ZOOM_DEFAULT_DURATION);
      if (end - start < ZOOM_MIN_DURATION) {
        setNotice("No room for a zoom here");
        return;
      }
      const seg: ZoomSegment = {
        start,
        end,
        scale: ZOOM_DEFAULT_SCALE,
        center_x: videoDims.w / 2,
        center_y: videoDims.h / 2,
        auto_generated: false,
      };
      setZoomSegments((prev) => {
        const next = [...prev, seg].sort((a, b) => a.start - b.start);
        const idx = next.indexOf(seg);
        // Defer selection to a microtask so the new index is valid against
        // the freshly-rendered list.
        Promise.resolve().then(() => selectZoom(idx));
        return next;
      });
    },
    [duration, videoDims, zoomSegments, selectZoom],
  );

  // Clear-all escape hatch. Wipes both auto and manual zooms and deselects.
  // The mount-time auto-load has already fired (autoLoadedRef is set), so a
  // clear stays cleared for this window — the app never reopens a recording,
  // so it stays cleared for good.
  const clearAllZooms = useCallback(() => {
    setZoomSegments([]);
    setZoomSelectedIndex(null);
  }, []);

  // Step 5 suggestion detection — the manual "Re-suggest" button. Runs the
  // C.1 heuristic over the cursor telemetry on the Rust side; the result
  // replaces auto_generated segments only. Suggestions overlapping a manual
  // zoom are dropped — user-placed segments always win. This path is an
  // explicit edit: it notifies and (correctly) dirties the state, unlike the
  // silent mount-time auto-load below.
  //
  // AUTO-LOAD (owner-approved 2026-07-16; detector has earned it — see
  // DECISIONS.md; effect is `autoLoadedRef` below). It runs suggest ONCE at
  // review-open on a fresh recording, folds the result into the snapshot so
  // it reads as the default (not "— edited"), and Clear-all is the escape
  // hatch. NO persisted "already-suggested" flag is needed: each recording
  // gets exactly one review window (review-<stamp>) and the app never reopens
  // recordings, so the mount-time run happens exactly once and a Clear stays
  // cleared for free. IF reopening recordings is ever added, THAT is when a
  // persisted flag becomes necessary (an empty zoom track is written absent /
  // deletes the sidecar, so "never suggested" and "cleared" look identical).
  const [suggesting, setSuggesting] = useState(false);
  const suggestZooms = useCallback(async () => {
    if (!sourcePath || duration == null) return;
    setSuggesting(true);
    try {
      const kfs = await invoke<ZoomKeyframe[] | null>("suggest_zooms", {
        sourcePath,
      });
      if (kfs == null) {
        setNotice("No cursor telemetry for this recording");
        return;
      }
      const manual = zoomSegments.filter((s) => !s.auto_generated);
      const suggested = zoomKeyframesToSegments(kfs)
        .map((s) => ({ ...s, end: Math.min(s.end, duration) }))
        .filter(
          (s) =>
            s.end - s.start >= ZOOM_MIN_DURATION &&
            manual.every((m) => s.end <= m.start || s.start >= m.end),
        );
      setZoomSegments(
        [...manual, ...suggested].sort((a, b) => a.start - b.start),
      );
      setZoomSelectedIndex(null);
      setNotice(
        suggested.length === 0
          ? "No zoom-worthy moments detected"
          : `${suggested.length} zoom${suggested.length === 1 ? "" : "s"} suggested — drag, resize, or delete on the lane`,
      );
    } catch (err) {
      setError(`suggest zooms: ${err}`);
    } finally {
      setSuggesting(false);
    }
  }, [sourcePath, duration, zoomSegments]);

  // Mount-time auto-load. Fires exactly once per review window, when the
  // sidecar has settled, duration is known, and the lane is empty. Silent by
  // design — no notices — so a no-telemetry recording opens without a popup.
  // The one-shot flag is spent as soon as those preconditions hold (before
  // the empty check) so that a sidecar that ALREADY carried zooms marks the
  // window as auto-loaded and a later Clear-all can't re-trigger a suggest.
  const autoLoadedRef = useRef(false);
  useEffect(() => {
    if (autoLoadedRef.current) return;
    if (!sourcePath || duration == null || !sidecarLoaded) return;
    autoLoadedRef.current = true;
    if (zoomSegments.length > 0) return; // sidecar already had zooms — keep them
    (async () => {
      const kfs = await invoke<ZoomKeyframe[] | null>("suggest_zooms", {
        sourcePath,
      }).catch(() => null);
      if (kfs == null) return; // no cursor telemetry — silent
      const suggested = zoomKeyframesToSegments(kfs)
        .map((s) => ({ ...s, end: Math.min(s.end, duration) }))
        .filter((s) => s.end - s.start >= ZOOM_MIN_DURATION)
        .sort((a, b) => a.start - b.start);
      if (suggested.length === 0) return; // nothing zoom-worthy — silent
      const kf = zoomSegmentsToKeyframes(suggested);
      setZoomSegments(suggested);
      // Fold into the baseline so the header reads clean (not "— edited") on
      // open; a subsequent Clear then correctly reads as an edit.
      setSnapshot((prev) => ({ ...prev, zoom: kf }));
      // Persist now rather than waiting on the debounce — the export reads the
      // sidecar, and the folded state is dirty=false so nothing else forces a
      // write before an immediate save.
      invoke("write_sidecar", {
        sourcePath,
        state: sidecarWritePayload({ ...currentState, zoom: kf }, duration),
      }).catch((err) => setError(`write sidecar: ${err}`));
    })();
    // currentState is intentionally omitted from deps: the ref guarantees a
    // single run, and we want the value captured at that run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourcePath, duration, sidecarLoaded, zoomSegments]);

  // Neighbor-bounded window per segment — segments stay sorted and
  // non-overlapping because drags/resizes can't cross these bounds.
  const zoomBounds = useCallback(
    (i: number) => ({
      min: i > 0 ? zoomSegments[i - 1].end : 0,
      max:
        i < zoomSegments.length - 1
          ? zoomSegments[i + 1].start
          : (duration ?? Number.MAX_VALUE),
    }),
    [zoomSegments, duration],
  );

  const sourceName = sourcePath ? basename(sourcePath) : "Untitled Recording";

  // Read sidecar on mount; record snapshot for discard semantics.
  useEffect(() => {
    if (!sourcePath) return;
    let cancelled = false;
    invoke<SidecarState | null>("read_sidecar", { sourcePath })
      .then((state) => {
        if (cancelled) return;
        if (state) {
          setSnapshot({
            trim: state.trim ?? null,
            bubble_position_log: state.bubble_position_log ?? [],
            thumbnail_time: state.thumbnail_time ?? null,
            bubble_roundness: state.bubble_roundness ?? null,
            bubble_zone: state.bubble_zone ?? null,
            zoom: state.zoom ?? [],
          });
          if (state.trim) setTrim(state.trim);
          if (state.bubble_position_log) setBubblePositionLog(state.bubble_position_log);
          if (state.thumbnail_time != null) setThumbnailTime(state.thumbnail_time);
          if (state.bubble_roundness != null) setBubbleRoundness(state.bubble_roundness);
          if (state.bubble_zone != null) setBubbleZone(state.bubble_zone);
          if (state.zoom && state.zoom.length > 0) {
            setZoomSegments(zoomKeyframesToSegments(state.zoom));
          }
        } else {
          setSnapshot(EMPTY_STATE);
        }
        // Set last, after any setZoomSegments above, so the auto-load effect
        // sees the loaded zoom track (React batches these together) and never
        // mistakes a not-yet-applied read for an empty lane.
        setSidecarLoaded(true);
      })
      .catch((err) => {
        setError(`read sidecar: ${err}`);
        setSidecarLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [sourcePath]);

  // Fetch audio-track start_time once per review-open. Best-effort: failures
  // and no-audio sources fall through to 0, which gives the pre-Phase-13 a/A
  // mapping (the original drift bug) — acceptable as a fallback because the
  // probe is purely a render-alignment input.
  useEffect(() => {
    if (!sourcePath) {
      setAudioStart(null);
      return;
    }
    let cancelled = false;
    invoke<{ start: number; duration: number } | null>("probe_audio_track", {
      sourcePath,
    })
      .then((meta) => {
        if (cancelled) return;
        setAudioStart(meta?.start ?? 0);
      })
      .catch(() => {
        if (!cancelled) setAudioStart(0);
      });
    return () => {
      cancelled = true;
    };
  }, [sourcePath]);

  // Render the NR preview MP4 eagerly at review-open. Same arnndn pipeline
  // the save path uses (Phase 12 c3), video stream copied, audio re-encoded
  // — preview lives at .scratch/<id>/preview.mp4 (D-07) and rides the same
  // scratch lifecycle (discard removes it, save replaces it). On success
  // the main <video> swaps to the preview URL; on failure D-10 surfaces a
  // pip and the raw scratch keeps playing.
  useEffect(() => {
    if (!screenPath) {
      setPreviewState({ status: "rendering" });
      return;
    }
    let cancelled = false;
    setPreviewState({ status: "rendering" });
    // Phase 15 c3: NR preview now operates on screenPath (sources/
    // screen.mp4 for webcam recordings; scratchPath for screen-only).
    // preview_path_for resolves preview-screen.mp4 in the same dir.
    invoke<string>("render_preview_audio", { sourcePath: screenPath })
      .then((previewPath) => {
        if (cancelled) return;
        // Capture playback position before the src swap — the browser
        // resets currentTime when src changes, so we restore on the next
        // loadedmetadata.
        const v = videoRef.current;
        if (v) {
          swapRestoreTimeRef.current = v.currentTime;
          v.pause();
        }
        setPreviewState({ status: "ready", url: convertFileSrc(previewPath) });
      })
      .catch((err) => {
        console.warn("preview render failed", err);
        if (!cancelled) setPreviewState({ status: "failed" });
      });
    return () => {
      cancelled = true;
    };
  }, [screenPath]);

  // The main <video> plays the NR preview once ready; falls back to the
  // raw scratch during the eager render window and on D-10 failure. The
  // timeline waveform + scrub-preview stay on the raw URL (D-12 — waveform
  // shows the unprocessed signal for the Phase 12 c1 clipping highlight).
  const playbackUrl = useMemo(() => {
    if (previewState.status === "ready") return previewState.url;
    return assetUrl;
  }, [previewState, assetUrl]);

  // Initialize trim once duration is known and no sidecar trim was present.
  useEffect(() => {
    if (duration == null) return;
    setTrim((prev) => prev ?? { in: 0, out: duration });
  }, [duration]);

  const currentState: SidecarState = useMemo(
    () => ({
      trim: trim ?? null,
      bubble_position_log: bubblePositionLog,
      thumbnail_time: thumbnailTime,
      bubble_roundness: bubbleRoundness,
      bubble_zone: bubbleZone,
      zoom: zoomSegmentsToKeyframes(zoomSegments),
    }),
    [trim, bubblePositionLog, thumbnailTime, bubbleRoundness, bubbleZone, zoomSegments],
  );

  const dirty = useMemo(
    () => !statesEqual(currentState, snapshot, duration),
    [currentState, snapshot, duration],
  );

  // V2 Step 2: the zone actually used for the parked preview + picker
  // highlight. An explicit pick wins; otherwise the migration default
  // (nearest corner to the log centroid) — the same rule composite::resolve_zone
  // applies at export when bubble_zone is absent.
  const effectiveZone: BubbleZone = useMemo(
    () => bubbleZone ?? nearestCornerZone(bubblePositionLog),
    [bubbleZone, bubblePositionLog],
  );
  // Only offer the picker for webcam recordings — a zone is meaningless with
  // no bubble.
  const hasBubble = bubblePositionLog.length > 0;

  // Debounced sidecar persistence on edit. Empty states are deleted to keep
  // the sources area tidy; non-empty states are written. Any sidecar change
  // also invalidates committedMp4Path — the cached LinkedIn baseline is now
  // stale, so the next LinkedIn click chains a fresh save instead of
  // shipping the old bake.
  useEffect(() => {
    if (!sourcePath || duration == null) return;
    const empty = isLogicallyEmpty(currentState, duration);
    const handle = window.setTimeout(() => {
      // bubble_zone / zoom drop to undefined when unset so untouched /
      // pre-feature sidecars stay byte-identical (see sidecarWritePayload).
      const norm = sidecarWritePayload(currentState, duration);
      setCommittedMp4Path(null);
      if (empty) {
        invoke("delete_sidecar", { sourcePath }).catch((err) =>
          setError(`delete sidecar: ${err}`),
        );
      } else {
        invoke("write_sidecar", { sourcePath, state: norm }).catch((err) =>
          setError(`write sidecar: ${err}`),
        );
      }
    }, SIDECAR_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [sourcePath, currentState, duration]);

  // Single save entrypoint. Every call re-reads raw scratch + the live
  // sidecar (the backend reads the sidecar adjacent to sourcePath) and
  // produces one file in ~/Movies/Zeigen/. The scratch dir survives the
  // session so subsequent saves can re-bake against edited sidecars.
  //
  // Returns the output path on success, null on failure. Called by the
  // ExportPanel Save button, ⌘S, the close-window modal Save button, and
  // the LinkedIn chain. Updates lastSavedPath unconditionally; updates
  // committedMp4Path only for mp4 saves (LinkedIn baseline reuse).
  const onSave = useCallback(
    async (spec: {
      format: "mp4" | "gif";
      resolution: "480p" | "720p" | "1080p" | "source";
      fps?: number;
    }): Promise<string | null> => {
      if (!sourcePath) return null;
      const stamp = parseStampFromPath(sourcePath);
      if (!stamp) {
        setError(`save: cannot parse stamp from ${sourcePath}`);
        return null;
      }
      setSaving(true);
      setSaveProgress(0);
      // save-progress carries a 0-1 fraction from ffmpeg's -progress
      // out_time_us (see edit.rs::save_recording). Listen only for the
      // duration of this call — a fresh listener per save keeps it simple
      // and avoids leaking state across saves that never resolve.
      const unlisten = await listen<number>("save-progress", (event) => {
        setSaveProgress(event.payload);
      });
      try {
        const result = await invoke<{
          output_path: string;
          thumbnail_out_of_trim: boolean;
          // Present only when the export fell back to the V2 (ffmpeg) path for a
          // specific reason (trim, downscale, annotations, webcam-without-zoom,
          // multi-segment webcam, or a V3 runtime failure). Absent = the normal
          // V3 path (or plain copy / GIF). Surfaced so a quiet fall-through is
          // visible from the save itself, not guessed.
          route_note?: string | null;
        }>("save_recording", {
          stamp,
          sourcePath,
          format: spec.format,
          resolution: spec.resolution,
          fps: spec.format === "gif" ? spec.fps : undefined,
          watermarkLogo: wmEffectiveLogo,
          watermarkCorner: wmCorner,
          watermarkScale: wmScale,
          watermarkOpacity: wmOpacity < 1 ? wmOpacity : null,
        });
        setLastSavedPath(result.output_path);
        setLastSavedAt(Date.now());
        if (spec.format === "mp4") setCommittedMp4Path(result.output_path);
        const notices: string[] = [];
        if (result.thumbnail_out_of_trim) {
          notices.push(
            "Thumbnail was outside the trim range — used the start of the trimmed output instead. Pick a new thumbnail to override.",
          );
        }
        if (result.route_note) {
          // e.g. "rendered via V2 fallback: trimmed export"
          notices.push(result.route_note);
        }
        if (notices.length > 0) {
          setNotice(notices.join(" "));
        }
        // Notify main so its post-finalize toast updates from the scratch
        // path to whatever was just written under ~/Movies/Zeigen/.
        await emit("recording-committed", { final_path: result.output_path }).catch(
          () => {},
        );
        return result.output_path;
      } catch (err) {
        setError(`save: ${err}`);
        return null;
      } finally {
        unlisten();
        setSaving(false);
        setSaveProgress(null);
      }
    },
    [sourcePath, wmEffectiveLogo, wmCorner, wmScale, wmOpacity],
  );

  // proceedingRef gates the close-requested handler so an in-flight
  // close (which we drive explicitly via destroy()) doesn't re-enter.
  const proceedingRef = useRef(false);

  // iPhone-screenshot semantics: every "this recording is going away"
  // event — Discard, close window, "Record another" — runs the same
  // cleanup. discard_recording on the Rust side is idempotent: skips
  // scratch removal if the dir is already gone and always cleans the
  // matching exports temp dir.
  const cleanupScratchAndExports = useCallback(async () => {
    if (!sourcePath) return;
    try {
      await invoke("discard_recording", { scratchMp4Path: sourcePath });
      // Tell main so its post-finalize toast clears.
      await emit("recording-discarded").catch(() => {});
    } catch (err) {
      console.error("cleanup failed:", err);
    }
  }, [sourcePath]);

  // Mirror lastSavedPath into a ref so the long-lived close-requested
  // handler can read the current value without re-registering on each save.
  const lastSavedPathRef = useRef<string | null>(null);
  useEffect(() => {
    lastSavedPathRef.current = lastSavedPath;
  }, [lastSavedPath]);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    (async () => {
      const win = getCurrentWebviewWindow();
      const fn = await win.onCloseRequested(async (event) => {
        if (proceedingRef.current) return; // already greenlit
        event.preventDefault();
        // Any save already happened → silent close. The cache temp dir
        // still needs cleanup but the user has nothing to lose.
        if (lastSavedPathRef.current) {
          proceedingRef.current = true;
          await cleanupScratchAndExports();
          await win.destroy().catch((err) => {
            proceedingRef.current = false;
            setError(`close: ${err}`);
          });
          return;
        }
        // No save yet → red X is an ambiguous gesture. Prompt for an
        // explicit choice. Sidebar Discard remains direct (no modal)
        // because that click is itself the explicit choice.
        setShowCloseModal(true);
      });
      if (cancelled) {
        fn();
        return;
      }
      unlisten = fn;
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [cleanupScratchAndExports]);

  const closeWindow = useCallback(async () => {
    proceedingRef.current = true;
    await getCurrentWebviewWindow()
      .destroy()
      .catch((err) => {
        proceedingRef.current = false;
        setError(`close: ${err}`);
      });
  }, []);

  const fireRecordAnother = useCallback(async () => {
    await emit("record-another").catch(() => {});
  }, []);

  // Discard: instant cleanup + close. iPhone-screenshot semantics — no
  // confirm modal. The user explicitly chose discard; they meant it.
  // Disabled in the sidebar post-save so users can't accidentally delete
  // the scratch out from under future saves in the same session.
  const onDiscard = useCallback(async () => {
    setDiscarding(true);
    try {
      await cleanupScratchAndExports();
      await closeWindow();
    } finally {
      setDiscarding(false);
    }
  }, [cleanupScratchAndExports, closeWindow]);

  // Reveal — only shown post-save. Points at the most recent save in any
  // format (per D-13 — chronological, not format-prioritized).
  const onReveal = useCallback(async () => {
    if (!lastSavedPath) return;
    try {
      await revealItemInDir(lastSavedPath);
    } catch (err) {
      setError(`reveal in Finder: ${err}`);
    }
  }, [lastSavedPath]);

  // Record another: same cleanup as Discard, then emit so main kicks
  // off a fresh capture, then close.
  const onRecordAnother = useCallback(async () => {
    setDiscarding(true);
    try {
      await cleanupScratchAndExports();
      await fireRecordAnother();
      await closeWindow();
    } finally {
      setDiscarding(false);
    }
  }, [cleanupScratchAndExports, fireRecordAnother, closeWindow]);

  // Close-modal Save: commits with the current ExportPanel selection
  // (format/resolution/fps lifted to Review for exactly this reason),
  // then cleans + closes on success.
  const onModalSave = useCallback(async () => {
    const spec: {
      format: "mp4" | "gif";
      resolution: "480p" | "720p" | "1080p" | "source";
      fps?: number;
    } =
      format === "mp4"
        ? { format: "mp4", resolution: mp4Res }
        : { format: "gif", resolution: gifRes, fps: gifFps };
    const out = await onSave(spec);
    if (out) {
      setShowCloseModal(false);
      await cleanupScratchAndExports();
      await closeWindow();
    } else {
      // Save failed; surface the error and let the user retry/discard.
      setShowCloseModal(false);
    }
  }, [onSave, format, mp4Res, gifRes, gifFps, cleanupScratchAndExports, closeWindow]);

  const onModalDiscard = useCallback(async () => {
    setShowCloseModal(false);
    setDiscarding(true);
    try {
      await cleanupScratchAndExports();
      await closeWindow();
    } finally {
      setDiscarding(false);
    }
  }, [cleanupScratchAndExports, closeWindow]);

  const onModalCancel = useCallback(() => {
    setShowCloseModal(false);
  }, []);

  // Modal keyboard: Enter = Discard (destructive default per macOS
  // convention — Pages, Numbers, TextEdit), Esc = Cancel.
  useEffect(() => {
    if (!showCloseModal) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onModalCancel();
      } else if (e.key === "Enter") {
        e.preventDefault();
        onModalDiscard();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showCloseModal, onModalCancel, onModalDiscard]);

  // WebKit won't paint a video frame until the renderer is primed by
  // an actual playback start — preload="auto" + a seek-to-0.04 alone
  // leaves the element black on review-window open. A muted play() →
  // immediate pause() forces the first frame to paint, and the frame
  // stays visible after pause. Muted autoplay is permitted without a
  // user gesture; we restore the original muted state on pause.
  //
  // Phase 15 c3 fix: track which src has been primed. The raw → preview-
  // screen.mp4 swap (when render_preview_audio resolves) reassigns the
  // <video> src; the browser blanks the element and needs priming on the
  // new src too. The prior one-shot bool refused to re-prime, leaving
  // preview-screen.mp4 stuck on a black frame after the swap.
  const primedSrcRef = useRef<string | null>(null);
  const primeFirstFrame = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    const currentSrc = v.currentSrc || v.src;
    if (!currentSrc || primedSrcRef.current === currentSrc) return;
    primedSrcRef.current = currentSrc;
    const wasMuted = v.muted;
    v.muted = true;
    v.play()
      .then(() => {
        requestAnimationFrame(() => {
          v.pause();
          v.muted = wasMuted;
        });
      })
      .catch(() => {
        v.muted = wasMuted;
      });
  }, []);

  const onLoadedMetadata = () => {
    const v = videoRef.current;
    if (!v) return;
    setDuration(v.duration);
    if (v.videoWidth && v.videoHeight) {
      setVideoDims({ w: v.videoWidth, h: v.videoHeight });
    }
    // After the raw→preview src swap, restore the playback position the
    // user was at. Don't auto-play even if they were playing — new audio
    // under their ear without context is more disorienting than a brief
    // pause.
    if (swapRestoreTimeRef.current != null) {
      v.currentTime = swapRestoreTimeRef.current;
      swapRestoreTimeRef.current = null;
    }
    primeFirstFrame();
  };

  const onTimeUpdate = () => {
    const v = videoRef.current;
    if (!v) return;
    setCurrentTime(v.currentTime);
    // Loop-back only applies during active playback. Without the !v.paused
    // guard, seeking to trim.out itself while paused (trim-handle drag,
    // playhead scrub) would immediately snap back to trim.in — the out
    // handle could never preview its own boundary frame.
    if (trim && !v.paused && v.currentTime >= trim.out - 0.01) {
      v.currentTime = trim.in;
    }
  };

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      if (trim && (v.currentTime < trim.in || v.currentTime >= trim.out - 0.01)) {
        v.currentTime = trim.in;
      }
      v.play().catch(() => {});
    } else {
      v.pause();
    }
  }, [trim]);

  // Looped slow preview of the selected zoom (Slice 1.5). Stop is driven off
  // the video's own 'pause' event (see onPause below), so every exit path —
  // spacebar, the transport button, Escape, deselecting — funnels through one
  // teardown. loopingRef mirrors the state so those non-React callbacks can
  // read "are we looping?" synchronously. savedRateRef stashes the user's
  // global speed so it survives the forced half-speed. loopWindowRef holds
  // the clamped [start,end] the rAF below wraps within.
  const [loopingZoom, setLoopingZoom] = useState(false);
  const loopingRef = useRef(false);
  const savedRateRef = useRef(1);
  const loopWindowRef = useRef<{ start: number; end: number } | null>(null);

  const endZoomLoop = useCallback(() => {
    if (!loopingRef.current) return;
    loopingRef.current = false;
    loopWindowRef.current = null;
    setLoopingZoom(false);
    setPlaybackRate(savedRateRef.current);
    const v = videoRef.current;
    if (v) v.playbackRate = savedRateRef.current;
  }, []);

  const startZoomLoop = useCallback(() => {
    const v = videoRef.current;
    if (!v || duration == null) return;
    const i = zoomSelectedIndex;
    if (i == null) return;
    const seg = zoomSegments[i];
    if (!seg) return;
    const loMin = trim?.in ?? 0;
    const loMax = trim?.out ?? duration;
    const start = Math.max(loMin, seg.start - ZOOM_PREVIEW_PRE_S);
    const end = Math.min(loMax, seg.end + ZOOM_PREVIEW_POST_S);
    if (end <= start) return;
    loopWindowRef.current = { start, end };
    savedRateRef.current = playbackRate;
    loopingRef.current = true;
    setLoopingZoom(true);
    // Set the rate on the element directly too — the state effect applies a
    // frame later, and we don't want the first loop iteration at full speed.
    setPlaybackRate(ZOOM_PREVIEW_RATE);
    v.playbackRate = ZOOM_PREVIEW_RATE;
    v.currentTime = start;
    v.play().catch(() => {});
  }, [duration, zoomSelectedIndex, zoomSegments, trim, playbackRate]);

  const toggleZoomLoop = useCallback(() => {
    if (loopingRef.current) {
      // Let the pause event own teardown (endZoomLoop).
      videoRef.current?.pause();
    } else {
      startZoomLoop();
    }
  }, [startZoomLoop]);

  // Live rate change during a loop. Deliberately does NOT touch savedRateRef,
  // so cycling slow<->real while judging never leaks into the global speed —
  // endZoomLoop still restores whatever was set before the loop began.
  const setLoopPreviewRate = useCallback((rate: number) => {
    setPlaybackRate(rate);
    const v = videoRef.current;
    if (v) v.playbackRate = rate;
  }, []);

  // Wrap the loop within its window. One seek per cycle (only when the tail
  // is reached), so no seek-queue churn — a direct currentTime write is fine
  // and frame-accurate here. Runs only while looping.
  useEffect(() => {
    if (!loopingZoom) return;
    const v = videoRef.current;
    if (!v) return;
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const w = loopWindowRef.current;
      if (!w) return;
      if (v.currentTime >= w.end) v.currentTime = w.start;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [loopingZoom]);

  // Changing (or clearing) the zoom selection while a preview loops ends it —
  // pausing routes through endZoomLoop. Auto-move-only-on-play means selecting
  // a different zoom shouldn't silently keep looping the old one.
  useEffect(() => {
    if (loopingRef.current) videoRef.current?.pause();
  }, [zoomSelectedIndex]);

  // Gated seeking — at most one in-flight seek on the screen video, latest
  // target wins. Scrub drags deliver pointermove faster than WebKit can
  // complete seeks; writing currentTime per event churns the seek queue and
  // the displayed frame updates irregularly. Instead the newest target
  // lands in a ref and the 'seeked' handler below chases it, so the decoder
  // always works on the latest position and never on a backlog. Same
  // off-React pattern as BubbleLayer's rAF position loop.
  const seekTargetRef = useRef<number | null>(null);
  const seekPendingRef = useRef(false);
  // Last value actually written to currentTime. The chase compares target
  // against this, NOT against v.currentTime — some engines report a frame-
  // quantized position after the seek settles, and comparing against that
  // would re-issue the same target forever.
  const seekIssuedRef = useRef<number | null>(null);

  const seek = useCallback((t: number) => {
    const v = videoRef.current;
    if (!v) return;
    const clamped = Math.max(0, Math.min(duration ?? Infinity, t));
    if (v.readyState === 0) {
      // Pre-metadata there is no seek algorithm — the value just becomes
      // the default start position and 'seeked' never fires, so arming the
      // gate here would wedge it.
      v.currentTime = clamped;
      return;
    }
    seekTargetRef.current = clamped;
    if (!seekPendingRef.current) {
      seekPendingRef.current = true;
      seekIssuedRef.current = clamped;
      v.currentTime = clamped;
    }
  }, [duration]);

  // Chase half of the gate. Keyed on playbackUrl so the raw → NR-preview
  // src swap also resets the gate — a seek that died with the old src must
  // not leave seekPendingRef stuck true.
  useEffect(() => {
    seekPendingRef.current = false;
    seekTargetRef.current = null;
    seekIssuedRef.current = null;
    const v = videoRef.current;
    if (!v) return;
    const onSeeked = () => {
      const target = seekTargetRef.current;
      const issued = seekIssuedRef.current;
      if (target != null && (issued == null || Math.abs(target - issued) > 0.001)) {
        seekIssuedRef.current = target;
        v.currentTime = target;
      } else {
        seekPendingRef.current = false;
        seekTargetRef.current = null;
        seekIssuedRef.current = null;
      }
    };
    v.addEventListener("seeked", onSeeked);
    return () => v.removeEventListener("seeked", onSeeked);
  }, [playbackUrl]);

  // True while a timeline scrub or trim-handle drag is in flight. Read by
  // BubbleLayer's sync layer to skip per-seek webcam aligns during the
  // drag (the second decoder otherwise seeks in lockstep with every scrub
  // tick); endScrub does the single align that lands the bubble on the
  // final frame.
  const scrubbingRef = useRef(false);
  const beginScrub = useCallback(() => {
    scrubbingRef.current = true;
  }, []);
  const endScrub = useCallback(() => {
    scrubbingRef.current = false;
    // One align at pointer-up. Reading s.currentTime is correct even if
    // the last gated seek is still in flight — currentTime reflects the
    // assigned value immediately. If the mouse moved past the last issued
    // seek, the chase seek fires 'seeked' with scrubbing already false and
    // the sync layer's normal align covers it.
    const s = videoRef.current;
    const w = webcamVideoRef.current;
    if (!s || !w) return;
    const target = Math.max(0, s.currentTime - webcamLeadSec);
    if (Math.abs(w.currentTime - target) > 0.05) {
      try {
        w.currentTime = target;
      } catch {
        // Webcam metadata not loaded yet — the sync layer retries on its
        // next event.
      }
    }
  }, [webcamLeadSec]);

  // Applying playbackRate as a property (not a JSX attribute — HTMLMediaElement
  // has no such DOM attribute). Fires the video's native 'ratechange' event,
  // which the webcam sync layer (BubbleLayer's onRateChange) already listens
  // for to mirror the rate onto the webcam element.
  useEffect(() => {
    const v = videoRef.current;
    if (v) v.playbackRate = playbackRate;
  }, [playbackRate]);

  const frameStep = useCallback(
    (dir: 1 | -1) => {
      const v = videoRef.current;
      if (!v) return;
      v.pause();
      seek(v.currentTime + dir * FRAME_SECONDS);
    },
    [seek],
  );

  // Global keyboard shortcuts: Space → play/pause, ←/→ → seek, ,/. →
  // frame-step (Premiere/Final Cut convention — doesn't collide with
  // arrow-key seeking), Shift+,/. (</>) → cycle playback speed (YouTube's
  // own binding for the same keys), I/O → trim in/out, Esc → cancel
  // zoom selection, Backspace/Delete → delete the selected zoom.
  // Suppressed while the close modal is open (its own handler runs)
  // and while editing text content (contentEditable).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (showCloseModal) return;
      const target = e.target as HTMLElement | null;
      if (target?.isContentEditable) return;
      if (target?.tagName === "INPUT" || target?.tagName === "TEXTAREA") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      const key = e.key.toLowerCase();
      if (e.key === " ") {
        e.preventDefault();
        // A selected zoom turns Space into its looped slow preview; otherwise
        // it's the normal transport toggle.
        if (zoomSelectedIndex != null) toggleZoomLoop();
        else togglePlay();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        seek((videoRef.current?.currentTime ?? 0) - SEEK_SECONDS);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        seek((videoRef.current?.currentTime ?? 0) + SEEK_SECONDS);
      } else if (e.key === ",") {
        e.preventDefault();
        frameStep(-1);
      } else if (e.key === ".") {
        e.preventDefault();
        frameStep(1);
      } else if (e.key === "<") {
        e.preventDefault();
        // In a zoom loop </> toggle slow<->real only: the global 1/1.5/2
        // cycle omits 0.5x and can't return to it, so reusing it would strand
        // the preview off the judging speed. < = slow, > = real.
        if (loopingRef.current) setLoopPreviewRate(ZOOM_PREVIEW_RATE);
        else setPlaybackRate((r) => cyclePlaybackRate(r, -1));
      } else if (e.key === ">") {
        e.preventDefault();
        if (loopingRef.current) setLoopPreviewRate(1);
        else setPlaybackRate((r) => cyclePlaybackRate(r, 1));
      } else if (key === "i" && duration != null) {
        e.preventDefault();
        const t = videoRef.current?.currentTime ?? 0;
        setTrim((prev) => {
          const out = prev?.out ?? duration;
          return { in: Math.max(0, Math.min(out - 0.1, t)), out };
        });
      } else if (key === "o" && duration != null) {
        e.preventDefault();
        const t = videoRef.current?.currentTime ?? 0;
        setTrim((prev) => {
          const trimIn = prev?.in ?? 0;
          return { in: trimIn, out: Math.min(duration, Math.max(trimIn + 0.1, t)) };
        });
      } else if (e.key === "Escape") {
        e.preventDefault();
        if (loopingRef.current) {
          // Stop the preview first; keep the zoom selected so it can be
          // re-previewed or edited without re-selecting.
          videoRef.current?.pause();
        } else if (zoomSelectedIndex != null) {
          setZoomSelectedIndex(null);
        }
      } else if (e.key === "Backspace" || e.key === "Delete") {
        if (zoomSelectedIndex != null) {
          e.preventDefault();
          deleteZoom(zoomSelectedIndex);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    showCloseModal,
    zoomSelectedIndex,
    deleteZoom,
    togglePlay,
    toggleZoomLoop,
    setLoopPreviewRate,
    seek,
    frameStep,
    duration,
  ]);

  const zoomEditor: ZoomEditor = {
    segments: zoomSegments,
    selectedIndex: zoomSelectedIndex,
    select: selectZoom,
    update: updateZoom,
    remove: deleteZoom,
    clearAll: clearAllZooms,
    addAt: addZoomAt,
    bounds: zoomBounds,
    canAdd: duration != null && videoDims != null,
    suggest: suggestZooms,
    suggesting,
    looping: loopingZoom,
  };

  const thumbnailControls: ThumbnailControls = {
    thumbnailTime,
    setThumbnailTime,
    previewUrl: playbackUrl,
    getCurrentTime: () => videoRef.current?.currentTime ?? 0,
  };

  // Post-trim length shown in the header.
  const trimmedLen =
    trim && duration != null ? Math.max(0, trim.out - trim.in) : duration;

  return (
    <main
      className="accent-blue"
      style={{
        height: "100vh",
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        background: "var(--bg-window)",
        color: "var(--fg-primary)",
        fontFamily: "var(--font-system)",
      }}
    >
      <Header
        sourceName={sourceName}
        dirty={dirty}
        length={trimmedLen}
        previewFailed={previewState.status === "failed"}
      />
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 296px",
          flex: 1,
          minHeight: 0,
        }}
      >
        <LeftColumn
          assetUrl={assetUrl}
          playbackUrl={playbackUrl}
          webcamUrl={webcamAssetUrl}
          webcamVideoRef={webcamVideoRef}
          webcamLeadSec={webcamLeadSec}
          bubblePositionLog={bubblePositionLog}
          // Sprite extraction / canvas fallback consumes the screen
          // capture, not the scratch logical path. screenPath always set
          // (== sourcePath for screen-only recordings, sources/screen.mp4
          // for webcam recordings).
          sourcePath={screenPath}
          videoRef={videoRef}
          onLoadedMetadata={onLoadedMetadata}
          onTimeUpdate={onTimeUpdate}
          onPlay={() => setPlaying(true)}
          onPause={() => {
            setPlaying(false);
            endZoomLoop();
          }}
          duration={duration}
          currentTime={currentTime}
          playing={playing}
          togglePlay={togglePlay}
          playbackRate={playbackRate}
          seek={seek}
          scrubbingRef={scrubbingRef}
          onScrubStart={beginScrub}
          onScrubEnd={endScrub}
          trim={trim}
          setTrim={setTrim}
          audioStart={audioStart}
          watermarkPreview={{
            src: wmEffectiveLogo ? convertFileSrc(wmEffectiveLogo) : null,
            corner: wmCorner,
            videoDims,
            scale: wmScale,
            opacity: wmOpacity,
          }}
          zoom={zoomEditor}
          thumbnailTime={thumbnailTime}
          bubbleRoundness={bubbleRoundness}
          bubbleZone={effectiveZone}
        />
        <ExportPanel
          sourcePath={sourcePath}
          zoom={zoomEditor}
          thumbnail={thumbnailControls}
          bubbleZone={effectiveZone}
          onBubbleZone={setBubbleZone}
          hasBubble={hasBubble}
          lastSavedPath={lastSavedPath}
          committedMp4Path={committedMp4Path}
          lastSavedAt={lastSavedAt}
          duration={duration}
          trim={trim}
          busy={busy}
          saving={saving}
          saveProgress={saveProgress}
          format={format}
          setFormat={setFormat}
          mp4Res={mp4Res}
          setMp4Res={setMp4Res}
          gifRes={gifRes}
          setGifRes={setGifRes}
          gifFps={gifFps}
          setGifFps={setGifFps}
          onSave={onSave}
          onReveal={onReveal}
          onDiscard={onDiscard}
          onRecordAnother={onRecordAnother}
          setError={setError}
          watermark={{
            logoPath: wmLogoPath,
            corner: wmCorner,
            apply: wmApply,
            scale: wmScale,
            scaleDisplay: wmScale ?? wmLegacyFrac,
            opacity: wmOpacity,
            onPick: onPickLogo,
            onRemove: onRemoveLogo,
            onCorner: onCornerChange,
            onToggleApply,
            onScale: setWmScale,
            onOpacity: setWmOpacity,
          }}
        />
      </div>
      {error && <ErrorStrip error={error} onDismiss={() => setError(null)} />}
      {!error && notice && (
        <NoticeStrip notice={notice} onDismiss={() => setNotice(null)} />
      )}
      {showCloseModal && (
        <CloseModal
          onSave={onModalSave}
          onDiscard={onModalDiscard}
          onCancel={onModalCancel}
          busy={busy}
        />
      )}
    </main>
  );
}

function Header({
  sourceName,
  dirty,
  length,
  previewFailed,
}: {
  sourceName: string;
  dirty: boolean;
  // Post-trim clip length. Lived in the old toolbar's info strip; the
  // header is the only remaining info strip.
  length: number | null;
  previewFailed: boolean;
}) {
  return (
    <div
      style={{
        height: 42,
        padding: "0 14px",
        display: "flex",
        alignItems: "center",
        gap: 8,
        borderBottom: "1px solid var(--border-faint)",
        background: "linear-gradient(to bottom, #2a2a2c, #232325)",
      }}
    >
      <span
        style={{
          width: 18,
          height: 18,
          borderRadius: 5,
          background: "linear-gradient(135deg, var(--accent), var(--accent-deep))",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          color: "#fff",
        }}
      >
        <Icon d={P.play} size={9} stroke={0} fill="currentColor" />
      </span>
      <span
        style={{
          fontWeight: 600,
          fontSize: 13,
          letterSpacing: "-0.01em",
          color: "var(--fg-primary)",
        }}
        title={sourceName}
      >
        Screen Recording{dirty ? " — edited" : ""}
      </span>
      <span style={{ color: "var(--fg-tertiary)", fontSize: 12 }}>·</span>
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 11,
          color: "var(--fg-tertiary)",
        }}
      >
        {fmt(length)} · .mp4
      </span>
      <span style={{ color: "var(--fg-tertiary)", fontSize: 12 }}>·</span>
      <span style={{ color: "var(--fg-tertiary)", fontSize: 12 }}>just now</span>
      {previewFailed && (
        <span
          style={{
            marginLeft: "auto",
            padding: "2px 8px",
            borderRadius: 999,
            fontSize: 11,
            background: "rgba(255, 180, 0, 0.12)",
            color: "var(--warning, #f5b400)",
            border: "1px solid rgba(255, 180, 0, 0.3)",
          }}
          title="Save still applies noise reduction — only the in-window preview fell back to raw audio."
        >
          Preview is raw — save still applies NR
        </span>
      )}
    </div>
  );
}

type LeftColumnProps = {
  assetUrl: string | null;
  // playbackUrl swaps to the NR-preview MP4 when render_preview_audio
  // resolves (Phase 14 c2). Distinct from assetUrl, which stays on the raw
  // scratch URL for the waveform + scrub preview.
  playbackUrl: string | null;
  // Phase 15 c3 dual-stream — webcam is rendered as a CSS-positioned
  // circle slaved to the screen video's currentTime. Null for screen-
  // only recordings; in that case nothing renders for the bubble.
  webcamUrl: string | null;
  webcamVideoRef: React.MutableRefObject<HTMLVideoElement | null>;
  webcamLeadSec: number;
  bubblePositionLog: BubblePositionEntry[];
  sourcePath: string | null;
  videoRef: React.MutableRefObject<HTMLVideoElement | null>;
  onLoadedMetadata: () => void;
  onTimeUpdate: () => void;
  onPlay: () => void;
  onPause: () => void;
  duration: number | null;
  currentTime: number;
  playing: boolean;
  togglePlay: () => void;
  playbackRate: number;
  seek: (t: number) => void;
  // Scrub-drag lifecycle (see beginScrub/endScrub in Review). scrubbingRef
  // reaches BubbleLayer's sync layer; the callbacks reach Timeline's drag
  // handlers.
  scrubbingRef: React.MutableRefObject<boolean>;
  onScrubStart: () => void;
  onScrubEnd: () => void;
  trim: Trim | null;
  setTrim: React.Dispatch<React.SetStateAction<Trim | null>>;
  audioStart: number | null;
  watermarkPreview: WatermarkPreview;
  zoom: ZoomEditor;
  // Timeline marker only — the thumbnail picker itself lives in the right
  // panel's Export section.
  thumbnailTime: number | null;
  // Read-only: stamped into the sidecar at record time (recorder UI owns
  // the control); Review only previews it via BubbleLayer's border-radius.
  bubbleRoundness: number | null;
  // V2 Step 2: resolved bubble zone for the parked preview.
  bubbleZone: BubbleZone;
};

function LeftColumn(props: LeftColumnProps) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        borderRight: "1px solid var(--border-faint)",
        minWidth: 0,
        minHeight: 0,
        overflow: "hidden",
      }}
    >
      <VideoStage
        assetUrl={props.playbackUrl}
        videoRef={props.videoRef}
        webcamUrl={props.webcamUrl}
        webcamVideoRef={props.webcamVideoRef}
        webcamLeadSec={props.webcamLeadSec}
        bubblePositionLog={props.bubblePositionLog}
        bubbleRoundness={props.bubbleRoundness}
        bubbleZone={props.bubbleZone}
        scrubbingRef={props.scrubbingRef}
        onLoadedMetadata={props.onLoadedMetadata}
        onTimeUpdate={props.onTimeUpdate}
        onPlay={props.onPlay}
        onPause={props.onPause}
        duration={props.duration}
        currentTime={props.currentTime}
        playing={props.playing}
        togglePlay={props.togglePlay}
        playbackRate={props.playbackRate}
        watermarkPreview={props.watermarkPreview}
        zoom={props.zoom}
      />
      <Timeline
        assetUrl={props.assetUrl}
        sourcePath={props.sourcePath}
        videoRef={props.videoRef}
        duration={props.duration}
        currentTime={props.currentTime}
        trim={props.trim}
        setTrim={props.setTrim}
        seek={props.seek}
        onScrubStart={props.onScrubStart}
        onScrubEnd={props.onScrubEnd}
        audioStart={props.audioStart}
        zoom={props.zoom}
        thumbnailTime={props.thumbnailTime}
      />
    </div>
  );
}

// Anchored to the right panel's Export section (fixed position, left of
// the panel so it floats over the video). Renders a paused <video> seeked to
// the captured currentTime so the user confirms the exact frame. The
// preview does NOT show the composited bubble/watermark — those are overlays
// in the main player — so the popover spells that out so the user isn't
// surprised by the final embedded poster.
function ThumbnailPopover({
  previewUrl,
  time,
  onUse,
  onCancel,
}: {
  previewUrl: string | null;
  time: number;
  onUse: () => void;
  onCancel: () => void;
}) {
  const vRef = useRef<HTMLVideoElement | null>(null);
  const onMeta = () => {
    const v = vRef.current;
    if (v) v.currentTime = time;
  };
  return (
    <>
      <div
        onClick={onCancel}
        style={{
          position: "fixed",
          inset: 0,
          background: "transparent",
          zIndex: 999,
        }}
      />
      <div
        style={{
          // Fixed, just left of the 296px panel and below the header —
          // deterministic anchor that works whether the popover was opened
          // by click or by the M shortcut (which may have just expanded a
          // collapsed Export section, so no row rect exists yet).
          position: "fixed",
          top: 56,
          right: 308,
          width: 280,
          background: "var(--bg-elevated)",
          border: "1px solid var(--border-default)",
          borderRadius: 8,
          boxShadow: "0 8px 24px rgba(0,0,0,0.22)",
          padding: 12,
          zIndex: 1000,
        }}
      >
        <div
          style={{
            fontSize: 12,
            fontWeight: 500,
            color: "var(--fg-primary)",
            marginBottom: 8,
          }}
        >
          Use this frame as thumbnail?
        </div>
        <div
          style={{
            width: "100%",
            aspectRatio: "16 / 9",
            background: "#000",
            borderRadius: 4,
            overflow: "hidden",
            marginBottom: 8,
          }}
        >
          {previewUrl && (
            <video
              ref={vRef}
              src={previewUrl}
              preload="auto"
              muted
              playsInline
              onLoadedMetadata={onMeta}
              style={{ width: "100%", height: "100%", objectFit: "contain", display: "block" }}
            />
          )}
        </div>
        <div
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 10.5,
            color: "var(--fg-tertiary)",
            marginBottom: 8,
          }}
        >
          at {time.toFixed(2)}s · webcam bubble is added in the final export
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 6 }}>
          <button
            onClick={onCancel}
            style={{
              padding: "5px 11px",
              height: 26,
              background: "transparent",
              border: "1px solid var(--border-default)",
              borderRadius: 6,
              color: "var(--fg-secondary)",
              fontSize: 12,
              fontWeight: 500,
              cursor: "pointer",
            }}
          >
            Cancel
          </button>
          <button
            onClick={onUse}
            style={{
              padding: "5px 11px",
              height: 26,
              background: "var(--accent)",
              border: "1px solid var(--accent)",
              borderRadius: 6,
              color: "var(--accent-fg, white)",
              fontSize: 12,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Use this frame
          </button>
        </div>
      </div>
    </>
  );
}

// Full-width panel row (Trim label, Thumbnail picker). Same states as the
// old toolbar's ToolButton, but stacked vertically the rows can never outgrow
// the panel width.
function ToolRow({
  icon,
  label,
  kbd,
  active,
  disabled,
  onClick,
  title,
}: {
  icon: string;
  label: string;
  kbd?: string;
  active: boolean;
  disabled?: boolean;
  onClick?: () => void;
  title?: string;
}) {
  return (
    <button
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      title={title}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        width: "100%",
        padding: "5px 9px",
        height: 28,
        background: active ? "var(--accent-soft)" : "transparent",
        border: `1px solid ${active ? "var(--accent)" : "transparent"}`,
        borderRadius: 6,
        cursor: disabled ? "not-allowed" : "pointer",
        color: active ? "var(--fg-primary)" : "var(--fg-secondary)",
        opacity: disabled ? 0.45 : 1,
        fontFamily: "var(--font-system)",
        fontSize: 12,
        fontWeight: 500,
      }}
    >
      <Icon d={icon} size={12} stroke={1.4} />
      <span style={{ flex: 1, textAlign: "left" }}>{label}</span>
      {kbd && <span className="kbd">{kbd}</span>}
    </button>
  );
}

// Accordion section in the right panel. Header row is always visible;
// content renders only while open. Plain conditional render — no
// animation machinery.
function Section({
  title,
  open,
  onToggle,
  children,
}: {
  title: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div style={{ borderBottom: "1px solid var(--border-faint)" }}>
      <button
        onClick={onToggle}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: 7,
          padding: "10px 14px",
          background: "transparent",
          border: "none",
          cursor: "pointer",
          fontFamily: "var(--font-system)",
        }}
      >
        <span
          style={{
            display: "inline-flex",
            color: "var(--fg-tertiary)",
            transform: open ? "rotate(90deg)" : "none",
          }}
        >
          <Icon d={P.chevronRight} size={10} stroke={1.6} />
        </span>
        <span
          style={{
            fontSize: 10.5,
            color: "var(--fg-tertiary)",
            letterSpacing: "0.06em",
            textTransform: "uppercase",
            fontWeight: 600,
          }}
        >
          {title}
        </span>
      </button>
      {open && <div style={{ padding: "0 14px 12px" }}>{children}</div>}
    </div>
  );
}

// Label-above-control row. Replaces the old label-beside-control ChipsRow,
// whose side-by-side layout was what pushed 4-segment controls past the
// panel width.
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ fontSize: 11.5, color: "var(--fg-secondary)", marginBottom: 4 }}>
        {label}
      </div>
      {children}
    </div>
  );
}

type VideoStageProps = {
  assetUrl: string | null;
  videoRef: React.MutableRefObject<HTMLVideoElement | null>;
  // Phase 15 c3 — webcam <video> slaved to the screen video.
  webcamUrl: string | null;
  webcamVideoRef: React.MutableRefObject<HTMLVideoElement | null>;
  webcamLeadSec: number;
  bubblePositionLog: BubblePositionEntry[];
  bubbleRoundness: number | null;
  bubbleZone: BubbleZone;
  scrubbingRef: React.MutableRefObject<boolean>;
  onLoadedMetadata: () => void;
  onTimeUpdate: () => void;
  onPlay: () => void;
  onPause: () => void;
  duration: number | null;
  currentTime: number;
  playing: boolean;
  togglePlay: () => void;
  playbackRate: number;
  watermarkPreview: WatermarkPreview;
  zoom: ZoomEditor;
};

function VideoStage(props: VideoStageProps) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  // V2 Step 3: wrapper around the video that carries the zoom transform
  // (see the zoom rAF below).
  const zoomLayerRef = useRef<HTMLDivElement | null>(null);

  // videoDims drives the letterbox-aware content box below — the zoom
  // framing math is captured relative to the actual video frame, not the
  // (possibly larger, if the source isn't 16:9) stage box.
  const videoDims = props.watermarkPreview.videoDims;

  // Live zoom preview (step 3) — CSS scale+translate on the <video> only,
  // driven per-frame by the playhead against the interpolated zoom curve
  // (same rAF-outside-React pattern as BubbleLayer; React never writes
  // `transform` in the video's style object, so these imperative writes
  // survive re-renders). The webcam bubble is screen-anchored and must not
  // zoom. While a zoom segment is selected the video is held at identity:
  // edit view shows the full frame with the crop box (ZoomEditLayer);
  // deselect to watch the applied zoom. The exception is the looped slow
  // preview (zoom.looping) — it un-suppresses the transform while selected
  // so the motion is visible, time-multiplexing edit vs. watch.
  const zoomSegs = props.zoom.segments;
  const zoomEditing = props.zoom.selectedIndex != null;
  const zoomLooping = props.zoom.looping;
  const videoRefForZoom = props.videoRef;
  useEffect(() => {
    const video = videoRefForZoom.current;
    // V2 Step 3: the transform drives the wrapper around the video. The
    // webcam bubble / watermark are outside the wrapper (fixed).
    const layer = zoomLayerRef.current;
    if (!video || !layer) return;
    const reset = () => {
      layer.style.transform = "";
      layer.style.transformOrigin = "";
    };
    if (zoomSegs.length === 0 || (zoomEditing && !zoomLooping) || !videoDims) {
      reset();
      return;
    }
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const stage = stageRef.current;
      if (!stage) return;
      const z = zoomAt(zoomSegs, video.currentTime);
      if (!z || z.scale <= 1.001) {
        layer.style.transform = "";
        return;
      }
      // Framing: a crop rect of size content/s centered on the zoom
      // center, clamped inside the frame, scaled up to fill the content
      // box. The export renderer (edit.rs zoom_filter_fragment) mirrors this
      // math for preview/export parity — change one, change the other.
      const rect = stage.getBoundingClientRect();
      const b = contentBox({ width: rect.width, height: rect.height }, videoDims);
      const s = z.scale;
      const px = b.x + (z.center_x / videoDims.w) * b.w;
      const py = b.y + (z.center_y / videoDims.h) * b.h;
      const qx = Math.min(Math.max(px, b.x + b.w / (2 * s)), b.x + b.w - b.w / (2 * s));
      const qy = Math.min(Math.max(py, b.y + b.h / (2 * s)), b.y + b.h - b.h / (2 * s));
      layer.style.transformOrigin = "0 0";
      layer.style.transform = `translate(${b.x + b.w / 2 - s * qx}px, ${
        b.y + b.h / 2 - s * qy
      }px) scale(${s})`;
    };
    tick();
    return () => {
      cancelAnimationFrame(raf);
      reset();
    };
  }, [zoomSegs, zoomEditing, zoomLooping, videoDims, videoRefForZoom]);

  const onStageClick = (e: React.MouseEvent) => {
    // Click on the empty stage background = deselect any zoom, which leaves
    // edit view and re-arms the live preview transform.
    if ((e.target as HTMLElement).dataset.stageBg === "1") {
      props.zoom.select(null);
    }
  };

  return (
    <div
      style={{
        position: "relative",
        padding: 16,
        background: "#0c0d10",
        flex: 1,
        minHeight: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        ref={stageRef}
        onClick={onStageClick}
        data-stage-bg="1"
        style={{
          position: "relative",
          aspectRatio: "16 / 9",
          maxWidth: "100%",
          maxHeight: "100%",
          width: "100%",
          borderRadius: 8,
          overflow: "hidden",
          border: "1px solid rgba(255,255,255,0.06)",
          background: "#000",
        }}
      >
        {/* V2 Step 3: the screen video carries the zoom transform (applied to
            this wrapper by the zoom rAF). The webcam bubble + watermark stay
            OUTSIDE (screen-anchored) — rendering the bubble after this wrapper
            matches the export layer order (zoom -> webcam). */}
        {/* data-stage-bg here too: the video (pointerEvents:none) routes clicks
            to this transform wrapper, not the stage div behind it, so without the
            marker onStageClick's deselect never matched. Broke when this wrapper
            was inserted between the video and the stage (V2 Step 3 zoom). */}
        <div ref={zoomLayerRef} data-stage-bg="1" style={{ position: "absolute", inset: 0 }}>
          {props.assetUrl ? (
            <video
              ref={props.videoRef}
              src={props.assetUrl}
              onLoadedMetadata={props.onLoadedMetadata}
              onTimeUpdate={props.onTimeUpdate}
              onPlay={props.onPlay}
              onPause={props.onPause}
              playsInline
              preload="auto"
              style={{
                width: "100%",
                height: "100%",
                objectFit: "contain",
                background: "#000",
                pointerEvents: "none",
              }}
            />
          ) : (
            <div
              style={{
                position: "absolute",
                inset: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "var(--fg-tertiary)",
                fontSize: 12,
              }}
            >
              No source path
            </div>
          )}
        </div>
        <BubbleLayer
          stageRef={stageRef}
          screenVideoRef={props.videoRef}
          webcamVideoRef={props.webcamVideoRef}
          webcamUrl={props.webcamUrl}
          webcamLeadSec={props.webcamLeadSec}
          bubblePositionLog={props.bubblePositionLog}
          bubbleRoundness={props.bubbleRoundness}
          bubbleZone={props.bubbleZone}
          scrubbingRef={props.scrubbingRef}
          videoDims={props.watermarkPreview.videoDims}
        />
        {props.zoom.selectedIndex != null &&
          !props.zoom.looping &&
          props.zoom.segments[props.zoom.selectedIndex] && (
            <ZoomEditLayer
              stageRef={stageRef}
              videoDims={videoDims}
              seg={props.zoom.segments[props.zoom.selectedIndex]}
              onCenter={(cx, cy) => {
                const i = props.zoom.selectedIndex;
                if (i != null) props.zoom.update(i, { center_x: cx, center_y: cy });
              }}
            />
          )}
        <PlayerOverlay
          playing={props.playing}
          duration={props.duration}
          currentTime={props.currentTime}
          togglePlay={props.togglePlay}
          playbackRate={props.playbackRate}
        />
        <WatermarkPreviewLayer
          stageRef={stageRef}
          preview={props.watermarkPreview}
        />
      </div>
    </div>
  );
}

// Phase 15 c3 dual-stream bubble. Renders the webcam <video> as a CSS-
// positioned circle over the screen video. Slaved to the screen video
// via timeupdate/play/pause/seeking/seeked/ratechange — webcam.currentTime
// stays at max(0, screen.currentTime - LEAD_S) so the first ~280ms of
// playback shows the webcam's frozen first frame (mirroring composite.rs's
// tpad=start_mode=clone). V2 Step 2: position is the constant `bubbleZone`
// (parked, not animated); diameter comes from the sidecar's
// bubble_position_log. Falls back to nothing when no log (screen-only
// recordings or no webcam).
//
// CSS treatments mirror composite.rs's filter graph: transform scaleX(-1)
// for hflip, object-fit cover on a square element for crop='min(iw,ih)',
// border-radius 50% for the alphamerge mask. Same look as the live
// recording-time WebcamBubble preview component.
function BubbleLayer({
  stageRef,
  screenVideoRef,
  webcamVideoRef,
  webcamUrl,
  webcamLeadSec,
  bubblePositionLog,
  bubbleRoundness,
  bubbleZone,
  scrubbingRef,
  videoDims,
}: {
  stageRef: React.MutableRefObject<HTMLDivElement | null>;
  screenVideoRef: React.MutableRefObject<HTMLVideoElement | null>;
  webcamVideoRef: React.MutableRefObject<HTMLVideoElement | null>;
  webcamUrl: string | null;
  webcamLeadSec: number;
  bubblePositionLog: BubblePositionEntry[];
  bubbleRoundness: number | null;
  // V2 Step 2: the resolved zone the bubble is parked at (never null — the
  // caller falls back to the migration default). Only the position is
  // constant; the webcam <video> still plays via the sync layer.
  bubbleZone: BubbleZone;
  // True during a timeline scrub / trim-handle drag. The sync layer skips
  // per-seek webcam aligns while set — otherwise the webcam decoder seeks
  // in lockstep with every completed scrub seek. Review's endScrub does
  // the one align that matters when the drag ends.
  scrubbingRef: React.MutableRefObject<boolean>;
  // Phase 15 c3 rAF fix made currentTime obsolete here — the position
  // loop reads screenVideoRef.current.currentTime directly. Accepting
  // it would force callers to keep threading the prop; declining lets
  // the prop die at the VideoStage callsite.
  videoDims: { w: number; h: number } | null;
}) {
  const stage = useStageSize(stageRef);

  // Sync layer — screen video drives, webcam follows. 50ms drift window
  // is one frame at 30fps; correcting on every timeupdate keeps drift
  // bounded without thrashing the webcam decoder.
  useEffect(() => {
    const s = screenVideoRef.current;
    const w = webcamVideoRef.current;
    if (!s || !w) return;

    const target = () => Math.max(0, s.currentTime - webcamLeadSec);
    const align = () => {
      if (Math.abs(w.currentTime - target()) > 0.05) {
        try {
          w.currentTime = target();
        } catch {
          // Webcam metadata may not be loaded yet — first timeupdate
          // after webcam loadedmetadata will retry.
        }
      }
    };
    const onTimeUpdate = () => {
      // During a scrub drag every completed seek fires timeupdate; aligning
      // here would seek the webcam decoder in lockstep with the scrub.
      // endScrub does the single post-drag align instead.
      if (!scrubbingRef.current) align();
      // Phase 15 c3 fix: webcam needs play() once screen crosses LEAD
      // during ongoing playback. onPlay alone misses this — it fires
      // when the user clicks play (usually at t=0, before LEAD), so
      // the pre-LEAD guard skips the play call and nothing later
      // kicks the webcam off. Without this, align() runs every
      // timeupdate seeing webcam paused, scrubs it via seek to target,
      // and the bubble animates as 4-15fps stepped seeks instead of
      // smooth continuous play. Once webcam is playing, align()'s
      // 50ms drift threshold rarely fires — both videos advance at
      // 1x and the LEAD offset is preserved by the play-from-0 +
      // screen-LEAD-headstart arrangement.
      if (w.paused && !s.paused && s.currentTime >= webcamLeadSec) {
        w.play().catch(() => {});
      }
    };
    const onPlay = () => {
      align();
      // Don't try to play webcam during the pre-LEAD window — its
      // currentTime is 0 and ahead-of-screen play would race. The
      // first timeupdate past LEAD picks it up via onTimeUpdate above.
      if (s.currentTime >= webcamLeadSec) {
        w.play().catch(() => {});
      }
    };
    const onPause = () => {
      w.pause();
    };
    const onSeeking = () => {
      w.pause();
    };
    const onSeeked = () => {
      if (scrubbingRef.current) return; // endScrub aligns once at pointer-up
      align();
      if (!s.paused && s.currentTime >= webcamLeadSec) {
        w.play().catch(() => {});
      }
    };
    const onRateChange = () => {
      w.playbackRate = s.playbackRate;
    };
    // When webcam metadata first loads (and on src change), snap to
    // current target so playback doesn't start with an unaligned bubble.
    const onWebcamLoadedMeta = () => align();

    s.addEventListener("timeupdate", onTimeUpdate);
    s.addEventListener("play", onPlay);
    s.addEventListener("pause", onPause);
    s.addEventListener("seeking", onSeeking);
    s.addEventListener("seeked", onSeeked);
    s.addEventListener("ratechange", onRateChange);
    w.addEventListener("loadedmetadata", onWebcamLoadedMeta);
    return () => {
      s.removeEventListener("timeupdate", onTimeUpdate);
      s.removeEventListener("play", onPlay);
      s.removeEventListener("pause", onPause);
      s.removeEventListener("seeking", onSeeking);
      s.removeEventListener("seeked", onSeeked);
      s.removeEventListener("ratechange", onRateChange);
      w.removeEventListener("loadedmetadata", onWebcamLoadedMeta);
    };
  }, [screenVideoRef, webcamVideoRef, webcamLeadSec, webcamUrl]);

  // Phase 15 c3 fix: bubble position is driven by a requestAnimationFrame
  // loop that reads screenVideoRef.current.currentTime directly and writes
  // transform straight to the webcam element's style. React's render rate
  // (≈10Hz, bound by parent timeupdate) was too low for smooth bubble
  // glide during fast drags; rAF runs at ~60Hz independent of React. The
  // sync layer above is unaffected — it manipulates currentTime / play /
  // pause on the webcam element, not style.
  //
  // RIGOR: width, height, transform, visibility are MUTATED via this
  // effect and the ref callback below. They MUST NOT appear in the JSX
  // style prop — React would diff them against the JSX values and
  // overwrite the mutations on every re-render. Stable properties only
  // go in JSX style.
  useEffect(() => {
    const s = screenVideoRef.current;
    const w = webcamVideoRef.current;
    if (!s || !w) return;
    if (
      !videoDims ||
      stage.width === 0 ||
      stage.height === 0 ||
      bubblePositionLog.length === 0
    ) {
      w.style.visibility = "hidden";
      return;
    }

    // Bubble lives inside the video content box, not the stage box. Stable
    // per effect run; deps include stage size + videoDims so resize
    // re-runs the effect with fresh values.
    const { w: vw } = videoDims;
    const { x: cx, y: cy, w: cw, h: ch } = contentBox(stage, videoDims);

    const diameter = bubblePositionLog[0].diameter ?? DEFAULT_BUBBLE_DIAMETER_PX;
    const cssDiameter = (diameter / vw) * cw;

    // Size is constant per recording — bubble resize was removed in
    // phase 14 (be4aa02). Set once per effect run.
    w.style.width = `${cssDiameter}px`;
    w.style.height = `${cssDiameter}px`;
    w.style.visibility = "visible";

    // V2 Step 2: park the bubble at the constant zone (no rAF position loop —
    // position no longer follows playback time). Mirrors composite.rs's
    // constant overlay: PADDING off the pinned edges, centered on the free
    // axis. Padding scales by width (== by height under letterboxing). The
    // webcam <video> still plays via the sync layer; only its screen position
    // is fixed — exactly what the export bakes.
    const cssPad = (BUBBLE_ZONE_PADDING_PX / vw) * cw;
    const h = zoneHAlign(bubbleZone);
    const v = zoneVAlign(bubbleZone);
    const centerX =
      h === "left"
        ? cx + cssPad + cssDiameter / 2
        : h === "right"
          ? cx + cw - cssPad - cssDiameter / 2
          : cx + cw / 2;
    const centerY =
      v === "top"
        ? cy + cssPad + cssDiameter / 2
        : cy + ch - cssPad - cssDiameter / 2;
    const tx = centerX - cssDiameter / 2;
    const ty = centerY - cssDiameter / 2;
    // transform order is right-to-left: scaleX(-1) flips around the element's
    // center first (default transform-origin 50% 50%), then translate(...)
    // shifts the flipped result.
    w.style.transform = `translate(${tx}px, ${ty}px) scaleX(-1)`;
    // Offset-down-right drop shadow, mirroring the V3 export (main.swift
    // `elevated`): offset 0.05*d down-right, soft, alpha 0.48. Set here (not in
    // JSX) so it scales with cssDiameter like width/height/transform. CSS blur
    // and CI gaussian differ, so the blur px is by-eye against the export.
    const shOff = 0.05 * cssDiameter;
    const shBlur = 0.08 * cssDiameter;
    w.style.boxShadow = `${shOff.toFixed(1)}px ${shOff.toFixed(1)}px ${shBlur.toFixed(1)}px rgba(0,0,0,0.48)`;
  }, [
    screenVideoRef,
    webcamVideoRef,
    bubblePositionLog,
    bubbleZone,
    videoDims,
    stage.width,
    stage.height,
  ]);

  // Ref callback: assign to the parent's webcam ref AND set initial
  // visibility hidden, so the element doesn't flash at intrinsic webcam
  // dimensions at origin (0, 0) before the rAF effect's first tick. The
  // effect flips visibility to visible once it's ready to position.
  // Using visibility (not display) keeps the video decoder running.
  const setWebcamRef = useCallback(
    (node: HTMLVideoElement | null) => {
      webcamVideoRef.current = node;
      if (node) {
        node.style.visibility = "hidden";
      }
    },
    [webcamVideoRef],
  );

  if (!webcamUrl) return null;

  return (
    <video
      ref={setWebcamRef}
      src={webcamUrl}
      muted
      playsInline
      preload="auto"
      style={{
        // Stable properties only. width, height, transform, visibility are
        // mutated by the rAF effect / ref callback — see RIGOR note above.
        // (borderRadius is prop-driven, not rAF-mutated, so it's fine here.)
        position: "absolute",
        left: 0,
        top: 0,
        // E1 roundness: fraction of the full-circle radius. Mirrors the
        // export mask exactly — composite.rs corner radius is
        // roundness * diameter/2, and N% border-radius on a square element
        // is (N/50) * diameter/2. null = circle = legacy mask.
        borderRadius: `${(bubbleRoundness ?? 1) * 50}%`,
        objectFit: "cover",
        pointerEvents: "none",
        background: "#000",
        // boxShadow is set imperatively in the position effect (scales with
        // cssDiameter, mirrors the V3 export's offset-down-right drop shadow) —
        // kept out of JSX so a re-render doesn't clobber the scaled value.
      }}
    />
  );
}

// Live watermark preview. Mirrors the ffmpeg overlay: the logo sits in the
// chosen corner of the *video content box* (not the stage box), sized to
// 10% of the content's shorter dimension with 2% padding. Computing the
// content box from the video's intrinsic dims + the stage size makes the
// overlay track the letterboxed frame when the source aspect != 16:9.
function WatermarkPreviewLayer({
  stageRef,
  preview,
}: {
  stageRef: React.MutableRefObject<HTMLDivElement | null>;
  preview: WatermarkPreview;
}) {
  const stage = useStageSize(stageRef);
  if (!preview.src || !preview.videoDims || stage.width === 0 || stage.height === 0) {
    return null;
  }

  // Contain-fit the video inside the 16:9 stage box.
  const { x: cx, y: cy, w: cw, h: ch } = contentBox(stage, preview.videoDims);

  const shorter = Math.min(cw, ch);
  const logoH = shorter * 0.1;
  const pad = shorter * 0.02;
  // Width-fraction sizing when the Size slider has been touched, legacy
  // 10%-of-shorter-dim height otherwise — mirrors Watermark::filter_fragment
  // so the preview and the exported file agree.
  const sizing: React.CSSProperties =
    preview.scale != null
      ? { width: cw * preview.scale, height: "auto" }
      : { height: logoH, width: "auto" };
  const anchor: React.CSSProperties =
    preview.corner === "tl"
      ? { top: pad, left: pad }
      : preview.corner === "tr"
        ? { top: pad, right: pad }
        : preview.corner === "bl"
          ? { bottom: pad, left: pad }
          : { bottom: pad, right: pad };

  return (
    <div
      style={{
        position: "absolute",
        left: cx,
        top: cy,
        width: cw,
        height: ch,
        pointerEvents: "none",
      }}
    >
      <img
        src={preview.src}
        alt=""
        draggable={false}
        style={{ position: "absolute", opacity: preview.opacity, ...sizing, ...anchor }}
      />
    </div>
  );
}

// Zoom edit view (step 3) — shown while a zoom segment is selected. The
// stage holds the full untransformed frame; the dashed rect previews the
// visible region at the segment's scale (the same clamped framing the live
// preview transform and the step-4 export use) and the crosshair reticle
// drags the zoom center. Deselect (Esc or click the stage) to watch the
// applied zoom.
function ZoomEditLayer({
  stageRef,
  videoDims,
  seg,
  onCenter,
}: {
  stageRef: React.MutableRefObject<HTMLDivElement | null>;
  videoDims: { w: number; h: number } | null;
  seg: ZoomSegment;
  onCenter: (cx: number, cy: number) => void;
}) {
  const box = useContentBox(stageRef, videoDims);
  if (!videoDims || box.w === 0 || box.h === 0) return null;
  const p = toStagePx(
    { x: seg.center_x / videoDims.w, y: seg.center_y / videoDims.h },
    box,
  );
  const cropW = box.w / seg.scale;
  const cropH = box.h / seg.scale;
  const qx = Math.min(Math.max(p.x, box.x + cropW / 2), box.x + box.w - cropW / 2);
  const qy = Math.min(Math.max(p.y, box.y + cropH / 2), box.y + box.h - cropH / 2);
  const startDrag = (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const move = (ev: { clientX: number; clientY: number }) => {
      const stage = stageRef.current;
      if (!stage) return;
      const rect = stage.getBoundingClientRect();
      const b = contentBox({ width: rect.width, height: rect.height }, videoDims);
      const frac = toContentFrac({ x: ev.clientX - rect.left, y: ev.clientY - rect.top }, b);
      onCenter(frac.x * videoDims.w, frac.y * videoDims.h);
    };
    const onMove = (ev: PointerEvent) => move(ev);
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    move(e);
  };
  return (
    <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
      <div
        style={{
          position: "absolute",
          left: qx - cropW / 2,
          top: qy - cropH / 2,
          width: cropW,
          height: cropH,
          border: "1.5px dashed var(--accent)",
          borderRadius: 4,
          // Oversized shadow dims everything outside the crop rect — the
          // "what the zoomed export shows" affordance.
          boxShadow: "0 0 0 9999px rgba(12,13,16,0.45)",
          pointerEvents: "none",
        }}
      />
      <div
        onPointerDown={startDrag}
        style={{
          position: "absolute",
          left: p.x,
          top: p.y,
          transform: "translate(-50%, -50%)",
          cursor: "grab",
          pointerEvents: "auto",
          touchAction: "none",
        }}
      >
        <svg width={26} height={26} viewBox="0 0 26 26" style={{ display: "block" }} aria-hidden>
          <circle cx={13} cy={13} r={8} fill="none" stroke="var(--accent)" strokeWidth={2} />
          <path d="M13 0v6M13 20v6M0 13h6M20 13h6" stroke="var(--accent)" strokeWidth={2} />
          <circle cx={13} cy={13} r={1.8} fill="var(--accent)" />
        </svg>
      </div>
    </div>
  );
}

function useStageSize(stageRef: React.MutableRefObject<HTMLDivElement | null>) {
  const [size, setSize] = useState<{ width: number; height: number }>({ width: 0, height: 0 });
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const update = () => {
      const r = el.getBoundingClientRect();
      setSize({ width: r.width, height: r.height });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [stageRef]);
  return size;
}

// Letterbox-aware content box within the stage — the actual rendered video
// rect when the source aspect isn't 16:9 (the stage is CSS-locked to 16:9;
// `objectFit: contain` leaves bars otherwise). Single source of truth for
// math that used to be duplicated inline in WatermarkPreviewLayer and
// BubbleLayer — also used by the zoom edit layer so the crop box tracks the
// true video frame (always a fraction of it; ffmpeg's pixel space has no
// letterbox concept).
function contentBox(
  stage: { width: number; height: number },
  videoDims: { w: number; h: number } | null,
): { x: number; y: number; w: number; h: number } {
  if (!videoDims || stage.width === 0 || stage.height === 0) {
    return { x: 0, y: 0, w: stage.width, h: stage.height };
  }
  const videoAspect = videoDims.w / videoDims.h;
  const stageAspect = stage.width / stage.height;
  let w: number;
  let h: number;
  if (videoAspect > stageAspect) {
    w = stage.width;
    h = stage.width / videoAspect;
  } else {
    h = stage.height;
    w = stage.height * videoAspect;
  }
  return { x: (stage.width - w) / 2, y: (stage.height - h) / 2, w, h };
}

function useContentBox(
  stageRef: React.MutableRefObject<HTMLDivElement | null>,
  videoDims: { w: number; h: number } | null,
) {
  return contentBox(useStageSize(stageRef), videoDims);
}

// Content-box-relative fraction (the same convention the Rust export reads
// position/endpoint in) → absolute pixel position within the stage.
function toStagePx(
  frac: Position,
  box: { x: number; y: number; w: number; h: number },
): Position {
  return { x: box.x + frac.x * box.w, y: box.y + frac.y * box.h };
}

// Inverse — a stage-relative pixel position → content-box fraction, clamped
// to [0,1]. Used by pointer handlers capturing drag coordinates.
function toContentFrac(
  stagePx: Position,
  box: { x: number; y: number; w: number; h: number },
): Position {
  const fx = box.w > 0 ? (stagePx.x - box.x) / box.w : 0;
  const fy = box.h > 0 ? (stagePx.y - box.y) / box.h : 0;
  return { x: Math.max(0, Math.min(1, fx)), y: Math.max(0, Math.min(1, fy)) };
}

function PlayerOverlay({
  playing,
  duration,
  currentTime,
  togglePlay,
  playbackRate,
}: {
  playing: boolean;
  duration: number | null;
  currentTime: number;
  togglePlay: () => void;
  playbackRate: number;
}) {
  return (
    <div
      style={{
        position: "absolute",
        left: 12,
        right: 12,
        bottom: 12,
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "6px 10px",
        background: "var(--bg-overlay-thin)",
        backdropFilter: "blur(10px)",
        WebkitBackdropFilter: "blur(10px)",
        border: "0.5px solid rgba(255,255,255,0.1)",
        borderRadius: 8,
        color: "#fff",
      }}
    >
      <button
        onClick={togglePlay}
        style={{
          background: "transparent",
          border: "none",
          color: "#fff",
          cursor: "pointer",
          padding: 2,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
        }}
        aria-label={playing ? "Pause" : "Play"}
      >
        {playing ? (
          <Icon d={P.pause} size={14} stroke={1.6} />
        ) : (
          <Icon d={P.play} size={14} stroke={0} fill="currentColor" />
        )}
      </button>
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 11,
          color: "rgba(255,255,255,0.85)",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {fmt(currentTime)} / {fmt(duration)}
      </span>
      {playbackRate !== 1 && (
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            color: "var(--accent)",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {playbackRate}x
        </span>
      )}
    </div>
  );
}

type TimelineProps = {
  assetUrl: string | null;
  sourcePath: string | null;
  videoRef: React.MutableRefObject<HTMLVideoElement | null>;
  duration: number | null;
  currentTime: number;
  trim: Trim | null;
  setTrim: React.Dispatch<React.SetStateAction<Trim | null>>;
  seek: (t: number) => void;
  // Bracket every seek-per-pointermove drag (track scrub, trim handles) so
  // Review can suspend webcam aligns for the duration and do one align at
  // pointer-up.
  onScrubStart: () => void;
  onScrubEnd: () => void;
  audioStart: number | null;
  zoom: ZoomEditor;
  thumbnailTime: number | null;
};

function Timeline(props: TimelineProps) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [hover, setHover] = useState<{ time: number; rect: DOMRect } | null>(null);
  // Hover-scrub (Model A): true while a bare-hover skim is driving the playhead,
  // so onScrubStart/End fire once per skim session (webcam bubble aligns once at
  // the end, not per tick). Reset when a drag ends so the two stay in sync.
  const skimmingRef = useRef(false);
  const stamp = props.sourcePath ? parseStampFromPath(props.sourcePath) : null;

  const inPct =
    props.duration != null && props.trim != null ? (props.trim.in / props.duration) * 100 : 0;
  const outPct =
    props.duration != null && props.trim != null
      ? (props.trim.out / props.duration) * 100
      : 100;
  const playPct =
    props.duration != null ? (props.currentTime / props.duration) * 100 : 0;

  // Trim with your eyes: the video seeks to follow the handle during drag
  // so the user sees the exact frame they're cutting on. The bound NOT
  // being dragged (fixedIn/fixedOut) is captured once at drag-start rather
  // than read from a functional setTrim updater — it never changes during
  // this gesture, so a plain closure is enough and lets the seek live next
  // to the setTrim call instead of inside a state-updater side effect.
  const startHandleDrag = useCallback(
    (side: "in" | "out") => (e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const track = trackRef.current;
      if (!track || props.duration == null || !props.trim) return;
      const duration = props.duration;
      const rect = track.getBoundingClientRect();
      const fixedIn = props.trim.in;
      const fixedOut = props.trim.out;
      const video = props.videoRef.current;
      const wasPlaying = !!video && !video.paused;
      video?.pause();
      props.onScrubStart();
      const move = (clientX: number) => {
        const t = ((clientX - rect.left) / rect.width) * duration;
        if (side === "in") {
          const next = Math.max(0, Math.min(fixedOut - 0.1, t));
          props.setTrim({ in: next, out: fixedOut });
          props.seek(next);
        } else {
          const next = Math.min(duration, Math.max(fixedIn + 0.1, t));
          props.setTrim({ in: fixedIn, out: next });
          props.seek(next);
        }
      };
      const onMove = (ev: PointerEvent) => move(ev.clientX);
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        props.onScrubEnd();
        if (wasPlaying) video?.play().catch(() => {});
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [props],
  );

  const timeAt = (clientX: number, rect: DOMRect, duration: number) => {
    const frac = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return frac * duration;
  };

  const onTrackPointerDown = (e: React.PointerEvent) => {
    if (props.duration == null) return;
    const track = trackRef.current;
    if (!track) return;
    const rect = track.getBoundingClientRect();
    const startX = e.clientX;
    const duration = props.duration;
    const wasPlaying = !props.videoRef.current?.paused;
    let movedPastThreshold = false;
    const seekAt = (clientX: number) => {
      props.seek(timeAt(clientX, rect, duration));
    };
    const onMove = (ev: PointerEvent) => {
      if (!movedPastThreshold && Math.abs(ev.clientX - startX) > 3) {
        movedPastThreshold = true;
        if (wasPlaying) props.videoRef.current?.pause();
        props.onScrubStart();
      }
      if (movedPastThreshold) seekAt(ev.clientX);
      setHover({ time: timeAt(ev.clientX, rect, duration), rect });
    };
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      if (!movedPastThreshold) {
        seekAt(ev.clientX);
      } else {
        props.onScrubEnd();
        // Drag ended the scrub session; keep skim state in sync so the next
        // bare-hover re-arms onScrubStart instead of seeking un-gated.
        skimmingRef.current = false;
        if (wasPlaying) props.videoRef.current?.play().catch(() => {});
      }
      const overTrack =
        ev.clientX >= rect.left &&
        ev.clientX <= rect.right &&
        ev.clientY >= rect.top &&
        ev.clientY <= rect.bottom;
      if (!overTrack) setHover(null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  // Hover-scrub seek: a bare hover (no button) over a PAUSED video moves the
  // playhead + scrubs live via the gated seek (Model A: the playhead follows the
  // cursor and stays where you left it). Paused-only so it never fights playback;
  // gated seek + one-shot onScrubStart keep it from seek-flooding or churning the
  // webcam decoder. Shared by the main track and the zoom lane (same x->time).
  const skimSeek = (clientX: number) => {
    const track = trackRef.current;
    if (props.duration == null || !track) return;
    if (!props.videoRef.current?.paused) {
      // Playing (e.g. Space pressed while hovering): don't scrub over playback,
      // and end any active skim so scrubbingRef doesn't stay set during play.
      endSkim();
      return;
    }
    if (!skimmingRef.current) {
      skimmingRef.current = true;
      props.onScrubStart();
    }
    props.seek(timeAt(clientX, track.getBoundingClientRect(), props.duration));
  };
  const endSkim = () => {
    if (skimmingRef.current) {
      skimmingRef.current = false;
      props.onScrubEnd();
    }
  };

  const onTrackPointerMove = (e: React.PointerEvent) => {
    if (props.duration == null) return;
    const track = trackRef.current;
    if (!track) return;
    const rect = track.getBoundingClientRect();
    setHover({ time: timeAt(e.clientX, rect, props.duration), rect });
    if (e.buttons === 0) skimSeek(e.clientX); // hover, not a drag
  };

  const onTrackPointerLeave = () => {
    setHover(null);
    endSkim();
  };

  const trimLen =
    props.trim && props.duration != null ? Math.max(0, props.trim.out - props.trim.in) : null;

  return (
    <div
      style={{
        padding: "10px 16px 14px",
        borderTop: "1px solid var(--border-faint)",
        background: "rgba(255,255,255,0.012)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 6,
        }}
      >
        <span
          style={{
            fontSize: 11,
            color: "var(--fg-tertiary)",
            letterSpacing: "0.04em",
            textTransform: "uppercase",
            fontWeight: 600,
          }}
        >
          Timeline
        </span>
        {props.trim && trimLen != null && props.duration != null && trimLen < props.duration - TRIM_EPS ? (
          <span style={{ fontSize: 11, color: "var(--fg-secondary)", fontFamily: "var(--font-mono)" }}>
            In <span style={{ color: "var(--accent)" }}>{fmt(props.trim.in)}</span> · Out{" "}
            <span style={{ color: "var(--accent)" }}>{fmt(props.trim.out)}</span> · Length {fmt(trimLen)}
          </span>
        ) : (
          <span
            style={{
              fontSize: 11,
              color: "var(--fg-tertiary)",
              fontFamily: "var(--font-mono)",
            }}
          >
            {fmt(props.duration)}
          </span>
        )}
      </div>

      <div
        ref={trackRef}
        onPointerDown={onTrackPointerDown}
        onPointerMove={onTrackPointerMove}
        onPointerLeave={onTrackPointerLeave}
        style={{ position: "relative", height: 44, marginTop: 6, cursor: "pointer", touchAction: "none" }}
      >
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: 4,
            bottom: 4,
            borderRadius: 5,
            border: "1px solid var(--border-faint)",
            overflow: "hidden",
            background: "rgba(255,255,255,0.02)",
          }}
        >
          <Waveform
            assetUrl={props.assetUrl}
            videoDuration={props.duration}
            audioStart={props.audioStart}
          />
          {/* Dimmed regions outside trim */}
          {props.trim && props.duration != null && (
            <>
              <div
                style={{
                  position: "absolute",
                  left: 0,
                  top: 0,
                  bottom: 0,
                  width: `${inPct}%`,
                  background: "rgba(12,13,16,0.7)",
                }}
              />
              <div
                style={{
                  position: "absolute",
                  right: 0,
                  top: 0,
                  bottom: 0,
                  width: `${100 - outPct}%`,
                  background: "rgba(12,13,16,0.7)",
                }}
              />
            </>
          )}
        </div>

        {/* Thumbnail tick — sits below the track so it doesn't fight the
            playhead/trim handles visually. Click jumps the scrubber to the
            picked frame so the user can verify. Muted color + tooltip when
            the picked time falls outside the active trim range. */}
        {props.thumbnailTime != null && props.duration != null && (() => {
          const t = props.thumbnailTime;
          const pct = (t / props.duration) * 100;
          const outOfRange =
            props.trim != null &&
            (t < props.trim.in - TRIM_EPS || t > props.trim.out + TRIM_EPS);
          const color = outOfRange ? "var(--fg-tertiary)" : "var(--accent)";
          const title = outOfRange
            ? `Thumbnail at ${t.toFixed(2)}s — outside trim range, save will fall back to a frame inside the trimmed output`
            : `Thumbnail at ${t.toFixed(2)}s — click to jump`;
          return (
            <div
              onPointerDown={(e) => {
                e.stopPropagation();
                e.preventDefault();
                props.seek(t);
              }}
              title={title}
              style={{
                position: "absolute",
                left: `${pct}%`,
                top: "calc(100% + 1px)",
                transform: "translateX(-50%)",
                cursor: "pointer",
                pointerEvents: "auto",
              }}
            >
              <svg
                width={10}
                height={12}
                viewBox="0 0 10 12"
                style={{ display: "block" }}
                aria-hidden
              >
                <path
                  d="M0 0h10v12L5 9.5 0 12z"
                  fill={color}
                  opacity={outOfRange ? 0.6 : 1}
                />
              </svg>
            </div>
          );
        })()}

        {/* Trim handles */}
        {props.trim && props.duration != null && (
          <>
            <TrimHandle pct={inPct} side="in" onPointerDown={startHandleDrag("in")} />
            <TrimHandle pct={outPct} side="out" onPointerDown={startHandleDrag("out")} />
          </>
        )}

        {/* Playhead */}
        <div
          style={{
            position: "absolute",
            left: `${playPct}%`,
            top: -2,
            bottom: -2,
            width: 0,
            borderLeft: "1.5px solid #fff",
            transform: "translateX(-1px)",
            filter: "drop-shadow(0 0 4px rgba(255,255,255,0.4))",
            pointerEvents: "none",
          }}
        >
          <span
            style={{
              position: "absolute",
              top: -6,
              left: -5,
              width: 11,
              height: 11,
              borderRadius: 99,
              background: "#fff",
              boxShadow: "0 1px 4px rgba(0,0,0,0.5)",
            }}
          />
        </div>
      </div>

      {/* Zoom lane — second SegmentTrack row under the main track. Only
          rendered once zooms exist (added via the right panel's Zoom
          section) so no-zoom recordings keep today's layout. marginTop
          clears the thumbnail tick that hangs below the track. Bands stay
          visible unselected (alwaysBand): a zoom is a range the user
          reasons about, not a point. */}
      {props.zoom.segments.length > 0 && props.duration != null && (
        <div
          style={{ position: "relative", height: 44, marginTop: 16 }}
          onPointerMove={(e) => {
            // Hover-scrub over the zoom lane too — same x->time as the main
            // track (uses trackRef's rect). Pips/handles stopPropagation their
            // own pointerdown, so this only fires for bare hover.
            if (e.buttons === 0) skimSeek(e.clientX);
          }}
          onPointerLeave={endSkim}
        >
          <SegmentTrack
            segments={props.zoom.segments}
            duration={props.duration}
            selectedIndex={props.zoom.selectedIndex}
            onSelect={props.zoom.select}
            onAddAt={props.zoom.addAt}
            bandHeight={36}
            onChange={(i, p) => props.zoom.update(i, p)}
            onDragHover={(t) => {
              const track = trackRef.current;
              if (t == null || !track) {
                setHover(null);
                return;
              }
              // Reuse the main-track scrub preview: show the dragged zoom time's
              // frame above the timeline at that x. The main track isn't hovered
              // during a zoom-lane drag, so borrowing its rect + hover state is
              // safe and needs no second ScrubPreview.
              setHover({ time: t, rect: track.getBoundingClientRect() });
            }}
            label={() => "Z"}
            bounds={props.zoom.bounds}
            alwaysBand
            minGap={ZOOM_MIN_DURATION}
            ramp={ZOOM_RAMP_S}
            style={{ top: 4 }}
          />
        </div>
      )}

      <ScrubPreview
        assetUrl={props.assetUrl}
        recordingId={stamp}
        sourcePath={props.sourcePath}
        duration={props.duration}
        hoverTime={hover?.time ?? null}
        trackRect={hover?.rect ?? null}
      />
    </div>
  );
}

function TrimHandle({
  pct,
  side,
  onPointerDown,
}: {
  pct: number;
  side: "in" | "out";
  onPointerDown: (e: React.PointerEvent) => void;
}) {
  return (
    <div
      onPointerDown={onPointerDown}
      style={{
        position: "absolute",
        left: `${pct}%`,
        top: 0,
        bottom: 0,
        transform: side === "in" ? "translateX(-100%)" : "translateX(0)",
        width: 10,
        background: "var(--accent)",
        borderTopLeftRadius: side === "in" ? 4 : 0,
        borderBottomLeftRadius: side === "in" ? 4 : 0,
        borderTopRightRadius: side === "out" ? 4 : 0,
        borderBottomRightRadius: side === "out" ? 4 : 0,
        cursor: "ew-resize",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        boxShadow: "0 1px 2px rgba(0,0,0,0.4)",
        touchAction: "none",
      }}
    >
      <span style={{ width: 1, height: 14, background: "rgba(255,255,255,0.55)" }} />
    </div>
  );
}

function CloseModal({
  onSave,
  onDiscard,
  onCancel,
  busy,
}: {
  onSave: () => void;
  onDiscard: () => void;
  onCancel: () => void;
  busy: boolean;
}) {
  // Default focus on Discard, per macOS convention (Pages, Numbers,
  // TextEdit). Enter triggers Discard; Esc triggers Cancel.
  const discardRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    discardRef.current?.focus();
  }, []);

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.55)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
    >
      <div
        style={{
          background: "var(--bg-elevated)",
          border: "1px solid var(--border-strong)",
          borderRadius: 10,
          boxShadow: "var(--shadow-lg)",
          padding: 18,
          width: 360,
          color: "var(--fg-primary)",
          fontFamily: "var(--font-system)",
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>
          Save your recording?
        </div>
        <div style={{ fontSize: 12.5, color: "var(--fg-secondary)", lineHeight: 1.4 }}>
          You haven't saved this recording yet. Save to put a copy in ~/Movies/Zeigen.
          Discarding deletes the recording.
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          <button
            onClick={onCancel}
            className="btn-secondary"
            style={{ padding: "5px 12px", height: 28 }}
          >
            Cancel
          </button>
          <button
            ref={discardRef}
            onClick={onDiscard}
            disabled={busy}
            className="btn-secondary"
            style={{
              padding: "5px 12px",
              height: 28,
              borderColor: "var(--border-strong)",
              color: "var(--recording-tint)",
              opacity: busy ? 0.6 : 1,
              cursor: busy ? "wait" : "pointer",
            }}
          >
            Discard
          </button>
          <button
            onClick={onSave}
            disabled={busy}
            className="btn-primary"
            style={{
              padding: "5px 14px",
              height: 28,
              opacity: busy ? 0.6 : 1,
              cursor: busy ? "wait" : "pointer",
            }}
          >
            {busy ? "Working…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

function NoticeStrip({
  notice,
  onDismiss,
}: {
  notice: string;
  onDismiss: () => void;
}) {
  return (
    <div
      style={{
        position: "fixed",
        left: 14,
        right: 14,
        bottom: 14,
        padding: "6px 10px",
        background: "var(--accent-soft)",
        border: "1px solid var(--accent)",
        borderRadius: 6,
        display: "flex",
        alignItems: "center",
        gap: 8,
        fontSize: 11.5,
        zIndex: 999,
      }}
    >
      <span style={{ color: "var(--accent)", fontWeight: 600, flexShrink: 0 }}>Note</span>
      <span
        style={{
          color: "var(--fg-secondary)",
          fontSize: 11.5,
          flex: 1,
        }}
      >
        {notice}
      </span>
      <button
        onClick={onDismiss}
        aria-label="Dismiss"
        style={{
          background: "transparent",
          border: "none",
          color: "var(--fg-tertiary)",
          cursor: "pointer",
          padding: 0,
          lineHeight: 1,
          fontSize: 14,
        }}
      >
        ×
      </button>
    </div>
  );
}

function ErrorStrip({ error, onDismiss }: { error: string; onDismiss: () => void }) {
  return (
    <div
      style={{
        position: "fixed",
        left: 14,
        right: 14,
        bottom: 14,
        padding: "6px 10px",
        background: "var(--recording-soft)",
        border: "1px solid oklch(0.62 0.18 25 / 0.35)",
        borderRadius: 6,
        display: "flex",
        alignItems: "center",
        gap: 8,
        fontSize: 11.5,
        zIndex: 999,
      }}
    >
      <span style={{ color: "var(--recording-tint)", fontWeight: 600, flexShrink: 0 }}>Error</span>
      <span
        style={{
          color: "var(--fg-secondary)",
          fontFamily: "var(--font-mono)",
          fontSize: 11,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          flex: 1,
        }}
        title={error}
      >
        {error}
      </span>
      <button
        onClick={onDismiss}
        aria-label="Dismiss"
        style={{
          background: "transparent",
          border: "none",
          color: "var(--fg-tertiary)",
          cursor: "pointer",
          padding: 0,
          lineHeight: 1,
          fontSize: 14,
        }}
      >
        ×
      </button>
    </div>
  );
}

type SaveSpec = {
  format: "mp4" | "gif";
  resolution: "480p" | "720p" | "1080p" | "source";
  fps?: number;
};

// Exclusive accordion — one section open at a time; opening one collapses
// the rest, and clicking the open section's header closes it. The open
// section persists so the panel reopens the way the user last left it.
// Order mirrors the working flow (edit, dress up, output): Trim, Bubble,
// Zoom, Watermark, Export — with Export still the first-run default open.
// Position and default are independent; change DEFAULT_OPEN_SECTION if the
// workflow ranking shifts. A persisted id from an older build that isn't in
// SECTION_IDS (e.g. the removed "annotate"/"share") falls back to the default.
type SectionId = "trim" | "bubble" | "zoom" | "watermark" | "export";
const SECTION_IDS: SectionId[] = ["trim", "bubble", "zoom", "watermark", "export"];
const DEFAULT_OPEN_SECTION: SectionId | null = "export";
// Key versioned away from the old "review-panel-sections" multi-open
// format (a JSON object) so no migration parsing is needed.
const SECTIONS_LS_KEY = "review-panel-open-section";

function loadOpenSection(): SectionId | null {
  try {
    const raw = localStorage.getItem(SECTIONS_LS_KEY);
    if (raw == null) return DEFAULT_OPEN_SECTION;
    if (raw === "") return null; // user left everything collapsed
    return SECTION_IDS.includes(raw as SectionId)
      ? (raw as SectionId)
      : DEFAULT_OPEN_SECTION;
  } catch {
    return DEFAULT_OPEN_SECTION;
  }
}

function persistOpenSection(id: SectionId | null) {
  try {
    localStorage.setItem(SECTIONS_LS_KEY, id ?? "");
  } catch {
    // Best-effort; the session still works from React state.
  }
}

// V2 Step 2 zone picker: a 2x3 grid (4 corners + top/bottom mid-edges). Each
// cell is a mini 16:9 frame with a dot at that zone; the export bakes the
// bubble there and the preview parks it there. `value` is the effective zone
// (explicit pick or migration default), so the grid always shows a selection.
function ZonePicker({
  value,
  onChange,
}: {
  value: BubbleZone;
  onChange: (z: BubbleZone) => void;
}) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 6 }}>
      {BUBBLE_ZONES.map((z) => {
        const selected = z === value;
        const h = zoneHAlign(z);
        const v = zoneVAlign(z);
        const justifyContent =
          h === "left" ? "flex-start" : h === "right" ? "flex-end" : "center";
        const alignItems = v === "top" ? "flex-start" : "flex-end";
        return (
          <button
            key={z}
            title={z.replace("_", " ")}
            aria-label={z.replace("_", " ")}
            aria-pressed={selected}
            onClick={() => onChange(z)}
            style={{
              aspectRatio: "16 / 9",
              display: "flex",
              justifyContent,
              alignItems,
              padding: 5,
              borderRadius: 5,
              cursor: "pointer",
              background: "var(--bg-input)",
              border: selected
                ? "1.5px solid var(--accent)"
                : "1px solid var(--border-default)",
            }}
          >
            <span
              style={{
                width: 9,
                height: 9,
                borderRadius: "50%",
                background: selected ? "var(--accent)" : "var(--fg-tertiary)",
              }}
            />
          </button>
        );
      })}
    </div>
  );
}

function ExportPanel({
  sourcePath,
  zoom,
  thumbnail,
  bubbleZone,
  onBubbleZone,
  hasBubble,
  lastSavedPath,
  committedMp4Path,
  lastSavedAt,
  duration,
  trim,
  busy,
  saving,
  saveProgress,
  format,
  setFormat,
  mp4Res,
  setMp4Res,
  gifRes,
  setGifRes,
  gifFps,
  setGifFps,
  onSave,
  onReveal,
  onDiscard,
  onRecordAnother,
  setError,
  watermark,
}: {
  sourcePath: string | null;
  zoom: ZoomEditor;
  thumbnail: ThumbnailControls;
  // V2 Step 2: effective bubble zone (explicit pick or migration default),
  // the setter for an explicit pick, and whether this recording has a webcam
  // bubble at all (the section is hidden otherwise).
  bubbleZone: BubbleZone;
  onBubbleZone: (z: BubbleZone) => void;
  hasBubble: boolean;
  lastSavedPath: string | null;
  committedMp4Path: string | null;
  lastSavedAt: number;
  duration: number | null;
  trim: Trim | null;
  busy: boolean;
  saving: boolean;
  saveProgress: number | null;
  format: "mp4" | "gif";
  setFormat: (f: "mp4" | "gif") => void;
  mp4Res: "480p" | "720p" | "1080p" | "source";
  setMp4Res: (r: "480p" | "720p" | "1080p" | "source") => void;
  gifRes: "480p" | "720p" | "source";
  setGifRes: (r: "480p" | "720p" | "source") => void;
  gifFps: 10 | 15 | 20;
  setGifFps: (f: 10 | 15 | 20) => void;
  onSave: (spec: SaveSpec) => Promise<string | null>;
  onReveal: () => Promise<void> | void;
  onDiscard: () => Promise<void> | void;
  onRecordAnother: () => Promise<void> | void;
  setError: (msg: string | null) => void;
  watermark: WatermarkUI;
}) {
  // Transient post-save flash. Driven off lastSavedAt (parent state) so
  // the LinkedIn chain's implicit save also flashes the button. Reset to
  // 0 by a 1.5s timer; same shape as the legacy linkedinExportedAt badge.
  const [savedFlashAt, setSavedFlashAt] = useState(0);
  useEffect(() => {
    if (lastSavedAt === 0) return;
    setSavedFlashAt(lastSavedAt);
  }, [lastSavedAt]);
  const justSaved = savedFlashAt > 0;
  useEffect(() => {
    if (savedFlashAt === 0) return;
    const t = window.setTimeout(() => setSavedFlashAt(0), 1500);
    return () => window.clearTimeout(t);
  }, [savedFlashAt]);

  // Which section is open (exclusive), persisted so the panel reopens the
  // way the user last left it (same remembered-preference idea as bubble
  // roundness, but pure UI chrome — localStorage, not settings.json).
  const [openId, setOpenId] = useState<SectionId | null>(loadOpenSection);
  const toggleSection = useCallback((id: SectionId) => {
    setOpenId((prev) => {
      const next = prev === id ? null : id;
      persistOpenSection(next);
      return next;
    });
  }, []);
  const openSection = useCallback((id: SectionId) => {
    setOpenId((prev) => {
      if (prev === id) return prev;
      persistOpenSection(id);
      return id;
    });
  }, []);

  // Thumbnail popover — moved here from the old top toolbar. capturedTime
  // is grabbed at open so the preview shows the exact frame the user had
  // on screen even if playback moves while the popover is open.
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [capturedTime, setCapturedTime] = useState<number | null>(null);
  const onThumbnailClick = useCallback(() => {
    setCapturedTime(thumbnail.getCurrentTime());
    setPopoverOpen(true);
  }, [thumbnail]);

  // Escape closes the popover. Click-outside is handled by the backdrop.
  useEffect(() => {
    if (!popoverOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPopoverOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [popoverOpen]);

  // M opens the popover, expanding Export first so the thumbnail row is
  // visible behind it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "m" && e.key !== "M") return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return;
      }
      if (popoverOpen) return;
      e.preventDefault();
      openSection("export");
      onThumbnailClick();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [popoverOpen, openSection, onThumbnailClick]);

  const useFrame = () => {
    if (capturedTime != null) thumbnail.setThumbnailTime(capturedTime);
    setPopoverOpen(false);
  };

  const buildSpec = useCallback(
    (): SaveSpec =>
      format === "mp4"
        ? { format: "mp4", resolution: mp4Res }
        : { format: "gif", resolution: gifRes, fps: gifFps },
    [format, mp4Res, gifRes, gifFps],
  );

  const onSaveClick = useCallback(async () => {
    if (saving || !sourcePath) return;
    // GIF >30s confirm (Phase 10 D-04). Effective length honors the
    // sidecar trim — the pipeline trims before encoding, so the warning
    // should reflect post-trim duration.
    if (format === "gif") {
      const effectiveLength =
        trim && duration != null
          ? Math.max(0, trim.out - trim.in)
          : duration;
      if (effectiveLength != null && effectiveLength > 30) {
        const secs = Math.round(effectiveLength);
        const ok = await ask(
          `This GIF will be ~${secs}s long and may be large. Continue?`,
          { kind: "warning", okLabel: "Continue", cancelLabel: "Cancel" },
        );
        if (!ok) return;
      }
    }
    await onSave(buildSpec());
  }, [saving, sourcePath, format, trim, duration, onSave, buildSpec]);

  // Transient post-copy confirmation: NSPasteboard returns silently on
  // success and the row visual otherwise gives no feedback. Flip a flag
  // for ~1.5s so the row swaps its ⌘C kbd for a green check + "Copied".
  const [copiedAt, setCopiedAt] = useState(0);
  const copied = copiedAt > 0;
  useEffect(() => {
    if (copiedAt === 0) return;
    const t = window.setTimeout(() => setCopiedAt(0), 1500);
    return () => window.clearTimeout(t);
  }, [copiedAt]);

  const onCopyClipboard = useCallback(async () => {
    if (!sourcePath) return;
    const stamp = parseStampFromPath(sourcePath);
    if (!stamp) {
      setError(`copy to clipboard: cannot parse stamp from ${sourcePath}`);
      return;
    }
    try {
      // clipboard_copy_recording reads sidecar adjacent to the source
      // and runs the pipeline (Phase 11 c2), so the pasted mp4 reflects
      // the user's current edits without committing anything to Movies.
      await invoke("clipboard_copy_recording", {
        stamp,
        sourcePath,
        watermarkLogo: watermark.apply && watermark.logoPath ? watermark.logoPath : null,
        watermarkCorner: watermark.corner,
        watermarkScale: watermark.scale,
        watermarkOpacity: watermark.opacity < 1 ? watermark.opacity : null,
      });
      setCopiedAt(Date.now());
    } catch (err) {
      setError(`copy to clipboard: ${err}`);
    }
  }, [sourcePath, setError, watermark]);

  // LinkedIn export: ensure an MP4 baseline exists in ~/Movies/Zeigen/
  // (commits a fresh MP4-Source save if none yet this session — reuses
  // committedMp4Path otherwise per D-16), transcode that baseline to a
  // recording-<stamp>-linkedin.mp4, drop the caption template on the
  // pasteboard, open Safari to the share composer, and reveal the file
  // in Finder for the user to drag in. LinkedIn has no upload API for
  // personal profiles, so the manual drag is the design.
  const [linkedinExporting, setLinkedinExporting] = useState(false);
  const [linkedinExportedAt, setLinkedinExportedAt] = useState(0);
  const linkedinExported = linkedinExportedAt > 0;
  useEffect(() => {
    if (linkedinExportedAt === 0) return;
    const t = window.setTimeout(() => setLinkedinExportedAt(0), 1500);
    return () => window.clearTimeout(t);
  }, [linkedinExportedAt]);

  const onLinkedinExport = useCallback(async () => {
    if (!sourcePath || linkedinExporting) return;
    const stamp = parseStampFromPath(sourcePath);
    if (!stamp) {
      setError(`linkedin export: cannot parse stamp from ${sourcePath}`);
      return;
    }
    if (duration != null && duration > 600) {
      const ok = await ask(
        "LinkedIn caps videos at 10 minutes. Export anyway?",
        { kind: "warning", okLabel: "Export anyway", cancelLabel: "Cancel" },
      );
      if (!ok) return;
    }
    setLinkedinExporting(true);
    try {
      let mp4Path = committedMp4Path;
      if (!mp4Path) {
        // LinkedIn caps at 1080p, so export at 1080p (supersampled from the
        // backing-resolution capture) rather than Source/4K — same visible
        // result, a quarter of the pixels, no upload of detail LinkedIn discards.
        mp4Path = await onSave({ format: "mp4", resolution: "1080p" });
        if (!mp4Path) return; // onSave already surfaced an error
      }
      const outPath = await invoke<string>("linkedin_export", {
        stamp,
        sourcePath: mp4Path,
      });
      // Caption first so the user's clipboard has it ready when they
      // ⌘V into the LinkedIn post composer.
      await invoke("clipboard_copy_text", {
        text: "New screen recording — [your description here]",
      }).catch(() => {});
      // Open Safari first so its activate-on-launch fires, then reveal
      // in Finder — Finder ends up on top with the file selected, ready
      // for the user to drag it into the now-cued-up LinkedIn composer.
      await openUrl("https://www.linkedin.com/feed/?shareActive=true").catch(() => {});
      await revealItemInDir(outPath).catch(() => {});
      setLinkedinExportedAt(Date.now());
    } catch (err) {
      setError(`linkedin export: ${err}`);
    } finally {
      setLinkedinExporting(false);
    }
  }, [sourcePath, duration, linkedinExporting, committedMp4Path, onSave, setError]);

  // ⌘C copy + ⌘S save. Skip when the user has a selection or is focused
  // on an editable element so the system's default text-copy behavior wins.
  useEffect(() => {
    if (!sourcePath || busy) return;
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey || e.shiftKey || e.altKey || e.ctrlKey) return;
      const key = e.key.toLowerCase();
      if (key !== "c" && key !== "s") return;
      const target = e.target as HTMLElement | null;
      if (target?.isContentEditable) return;
      if (target?.tagName === "INPUT" || target?.tagName === "TEXTAREA") return;
      if (key === "c") {
        const sel = window.getSelection();
        if (sel && sel.toString().length > 0) return;
        e.preventDefault();
        onCopyClipboard();
      } else {
        e.preventDefault();
        onSaveClick();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sourcePath, busy, onCopyClipboard, onSaveClick]);

  const mp4ResOptions = ["480p", "720p", "1080p", "source"] as const;
  const gifResOptions = ["480p", "720p", "source"] as const;
  const saveDisabled = !sourcePath || saving;
  const formatLabel = format === "mp4" ? "MP4" : "GIF";

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        background: "var(--bg-sidebar)",
        minHeight: 0,
        overflow: "hidden",
      }}
    >
      {/* Sections scroll vertically if the window is short; horizontal
          overflow is impossible by construction (full-width rows only). */}
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", overflowX: "hidden" }}>
        <Section
          title="Trim"
          open={openId === "trim"}
          onToggle={() => toggleSection("trim")}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {/* The real trim UI is the timeline handles / I-O keys; this row
                is the label that points at them. */}
            <ToolRow
              icon={P.edit}
              label="Trim"
              active={false}
              disabled
              title="Trim with the timeline handles below, or press I / O"
            />
          </div>
        </Section>

        {hasBubble && (
          <Section
            title="Bubble"
            open={openId === "bubble"}
            onToggle={() => toggleSection("bubble")}
          >
            <Field label="Position">
              <ZonePicker value={bubbleZone} onChange={onBubbleZone} />
            </Field>
            <div style={{ fontSize: 11, color: "var(--fg-tertiary)", lineHeight: 1.35 }}>
              The webcam bubble is baked at this fixed spot on export.
            </div>
          </Section>
        )}

        <Section
          title="Zoom"
          open={openId === "zoom"}
          onToggle={() => toggleSection("zoom")}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                className="btn-secondary"
                style={{ flex: 1, height: 26, fontSize: 11.5 }}
                onClick={zoom.suggest}
                disabled={!zoom.canAdd || busy || zoom.suggesting}
              >
                {zoom.suggesting ? "Suggesting…" : "Re-suggest"}
              </button>
              <button
                className="btn-secondary"
                style={{ flex: 1, height: 26, fontSize: 11.5 }}
                onClick={zoom.clearAll}
                disabled={busy || zoom.segments.length === 0}
              >
                Clear all
              </button>
            </div>
            {zoom.selectedIndex != null && zoom.segments[zoom.selectedIndex] ? (
              <>
                <Field
                  label={`Scale — ${zoom.segments[zoom.selectedIndex].scale.toFixed(2)}x`}
                >
                  <input
                    type="range"
                    className="slider"
                    min={Math.round(ZOOM_MIN_SCALE * 100)}
                    max={Math.round(ZOOM_MAX_SCALE * 100)}
                    step={5}
                    value={Math.round(zoom.segments[zoom.selectedIndex].scale * 100)}
                    onChange={(e) => {
                      const i = zoom.selectedIndex;
                      if (i != null) zoom.update(i, { scale: Number(e.target.value) / 100 });
                    }}
                    style={{ width: "100%" }}
                  />
                </Field>
                <div style={{ fontSize: 11, color: "var(--fg-tertiary)" }}>
                  Drag the crosshair on the video to set the zoom center. Adjust
                  timing on the timeline lane. Deselect (Esc) to watch the zoom
                  in the preview.
                </div>
                <button
                  className="btn-secondary"
                  style={{ height: 26, fontSize: 11.5 }}
                  onClick={() => {
                    const i = zoom.selectedIndex;
                    if (i != null) zoom.remove(i);
                  }}
                >
                  Delete zoom
                </button>
              </>
            ) : zoom.segments.length > 0 ? (
              <div style={{ fontSize: 11, color: "var(--fg-tertiary)" }}>
                {zoom.segments.length === 1
                  ? "1 zoom"
                  : `${zoom.segments.length} zooms`}{" "}
                on the timeline. Select a Z pip to edit scale, center, and
                timing; playback previews the applied zoom.
              </div>
            ) : (
              <div style={{ fontSize: 11, color: "var(--fg-tertiary)" }}>
                No zooms. Click the timeline lane to add one, or Re-suggest
                from your cursor activity. Playback previews live.
              </div>
            )}
          </div>
        </Section>

        <Section
          title="Watermark"
          open={openId === "watermark"}
          onToggle={() => toggleSection("watermark")}
        >
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {watermark.logoPath ? (
            <>
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  fontSize: 12.5,
                  color: "var(--fg-primary)",
                  cursor: "pointer",
                }}
              >
                <input
                  type="checkbox"
                  className="accent-blue"
                  checked={watermark.apply}
                  onChange={watermark.onToggleApply}
                />
                <span>Apply watermark</span>
              </label>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span
                  title={watermark.logoPath}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    fontSize: 11.5,
                    color: "var(--fg-secondary)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {basename(watermark.logoPath)}
                </span>
                <button
                  className="btn-secondary"
                  style={{ height: 24, padding: "0 8px", fontSize: 11 }}
                  onClick={watermark.onPick}
                >
                  Change…
                </button>
                <button
                  className="btn-secondary"
                  style={{ height: 24, padding: "0 8px", fontSize: 11 }}
                  onClick={watermark.onRemove}
                >
                  Remove
                </button>
              </div>
              <Field label="Corner">
                <div className="segmented full">
                  {WM_CORNERS.map((c) => (
                    <button
                      key={c}
                      className={watermark.corner === c ? "on" : ""}
                      onClick={() => watermark.onCorner(c)}
                    >
                      {c.toUpperCase()}
                    </button>
                  ))}
                </div>
              </Field>
              <Field label={`Size — ${Math.round(watermark.scaleDisplay * 100)}% of width`}>
                <input
                  type="range"
                  className="slider"
                  min={5}
                  max={40}
                  step={1}
                  value={Math.round(watermark.scaleDisplay * 100)}
                  onChange={(e) => watermark.onScale(Number(e.target.value) / 100)}
                  style={{ width: "100%" }}
                />
              </Field>
              <Field label={`Opacity — ${Math.round(watermark.opacity * 100)}%`}>
                <input
                  type="range"
                  className="slider"
                  min={0}
                  max={100}
                  step={1}
                  value={Math.round(watermark.opacity * 100)}
                  onChange={(e) => watermark.onOpacity(Number(e.target.value) / 100)}
                  style={{ width: "100%" }}
                />
              </Field>
            </>
          ) : (
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ flex: 1, fontSize: 11.5, color: "var(--fg-tertiary)" }}>
                No logo chosen
              </span>
              <button
                className="btn-secondary"
                style={{ height: 24, padding: "0 10px", fontSize: 11 }}
                onClick={watermark.onPick}
              >
                Choose…
              </button>
            </div>
          )}
        </div>
        </Section>

        <Section
          title="Export"
          open={openId === "export"}
          onToggle={() => toggleSection("export")}
        >
        <div style={{ marginBottom: 8 }}>
          <ToolRow
            icon="M5 2h6v11l-3-2.5L5 13z"
            label="Thumbnail"
            kbd="M"
            active={thumbnail.thumbnailTime != null}
            onClick={onThumbnailClick}
          />
        </div>
        {popoverOpen && capturedTime != null && (
          <ThumbnailPopover
            previewUrl={thumbnail.previewUrl}
            time={capturedTime}
            onUse={useFrame}
            onCancel={() => setPopoverOpen(false)}
          />
        )}
        <Field label="Format">
          <div className="segmented full">
            {(["mp4", "gif"] as const).map((f) => (
              <button
                key={f}
                className={format === f ? "on" : ""}
                onClick={() => setFormat(f)}
                disabled={saving}
              >
                {f === "mp4" ? "MP4" : "GIF"}
              </button>
            ))}
          </div>
        </Field>

        {format === "mp4" ? (
          <Field label="Resolution">
            <div className="segmented full">
              {mp4ResOptions.map((r) => (
                <button
                  key={r}
                  className={mp4Res === r ? "on" : ""}
                  onClick={() => setMp4Res(r)}
                  disabled={saving}
                >
                  {r === "source" ? "Source" : r}
                </button>
              ))}
            </div>
          </Field>
        ) : (
          <Field label="Resolution">
            <div className="segmented full">
              {gifResOptions.map((r) => (
                <button
                  key={r}
                  className={gifRes === r ? "on" : ""}
                  onClick={() => setGifRes(r)}
                  disabled={saving}
                >
                  {r === "source" ? "Source" : r}
                </button>
              ))}
            </div>
          </Field>
        )}

        {format === "gif" && (
          <Field label="FPS">
            <div className="segmented full">
              {([10, 15, 20] as const).map((f) => (
                <button
                  key={f}
                  className={gifFps === f ? "on" : ""}
                  onClick={() => setGifFps(f)}
                  disabled={saving}
                >
                  {f}
                </button>
              ))}
            </div>
          </Field>
        )}

        <button
          onClick={onSaveClick}
          disabled={saveDisabled}
          className="btn-primary"
          style={{
            position: "relative",
            overflow: "hidden",
            marginTop: 8,
            width: "100%",
            padding: "8px 0",
            height: 32,
            fontSize: 12.5,
            fontWeight: 600,
            letterSpacing: "-0.005em",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 6,
            opacity: saveDisabled ? 0.6 : 1,
            cursor: saveDisabled ? "not-allowed" : "pointer",
          }}
        >
          {saving && saveProgress != null && (
            // Fill bar behind the label — a percent in text is easy to miss;
            // this makes progress visible at a glance without staring at digits.
            <span
              style={{
                position: "absolute",
                inset: 0,
                width: `${Math.round(saveProgress * 100)}%`,
                background: "rgba(255,255,255,0.22)",
                transition: "width 200ms linear",
              }}
            />
          )}
          <span style={{ position: "relative", display: "inline-flex", alignItems: "center", gap: 6 }}>
            {justSaved ? (
              <>
                <Icon d={P.check} size={13} stroke={1.8} />
                <span>Saved</span>
              </>
            ) : saving ? (
              <span>
                Saving…{saveProgress != null ? ` ${Math.round(saveProgress * 100)}%` : ""}
              </span>
            ) : (
              <>
                <Icon d={P.check} size={13} stroke={1.6} />
                <span>Save as {formatLabel}</span>
              </>
            )}
          </span>
        </button>

        {/* Export destinations — formerly the standalone Share section.
            Reveal in Finder stays post-save-only. */}
        <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 6 }}>
        <DestRow
          icon={<Icon d="M5 2h6v3M5 2v9a1 1 0 001 1h7a1 1 0 001-1V6L11 2M3 6h6v8" size={14} stroke={1.4} />}
          title="Copy to Clipboard"
          sub="Paste into Slack, Mail, Messages…"
          action={
            copied ? (
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                  fontSize: 11.5,
                  color: "var(--success-tint)",
                }}
              >
                <Icon d={P.check} size={12} stroke={1.8} />
                <span>Copied</span>
              </span>
            ) : undefined
          }
          kbd={
            copied ? undefined : (
              <>
                <span className="kbd">⌘</span>
                <span className="kbd">C</span>
              </>
            )
          }
          onClick={onCopyClipboard}
          disabled={!sourcePath || busy}
        />
        <DestRow
          icon={<Icon d="M2.5 5h11v9h-11zM5 8.5v3M5 6.5h.01M7.5 11.5v-3c0-.8.7-1.5 1.5-1.5s1.5.7 1.5 1.5v3M10.5 11.5v-3" size={13} stroke={1.4} />}
          title="Export for LinkedIn"
          sub={
            linkedinExporting
              ? "Transcoding…"
              : "MP4 · ≤ 10 min · 1080p capped"
          }
          action={
            linkedinExported ? (
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                  fontSize: 11.5,
                  color: "var(--success-tint)",
                }}
              >
                <Icon d={P.check} size={12} stroke={1.8} />
                <span>Exported</span>
              </span>
            ) : undefined
          }
          onClick={onLinkedinExport}
          disabled={!sourcePath || busy || linkedinExporting}
        />
        {lastSavedPath && (
          <DestRow
            icon={I.finder}
            title="Reveal in Finder"
            sub={basename(lastSavedPath)}
            onClick={() => onReveal()}
            disabled={busy}
          />
        )}
        </div>
        </Section>
      </div>

      {/* Pinned lifecycle footer — always visible, not part of the
          accordion. */}
      <div
        style={{
          borderTop: "1px solid var(--border-faint)",
          padding: "10px 14px 14px",
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        {/* D-04 exception: Record another disables during an active save
            so the discard branch can't race ffmpeg reading the scratch.
            `busy` already covers `saving || discarding`; spelled out for
            grep-ability. See DECISIONS.md 2026-05-20. */}
        <button
          onClick={() => onRecordAnother()}
          disabled={saving || busy}
          className="btn-secondary"
          style={{
            width: "100%",
            padding: "7px 0",
            height: 30,
            fontSize: 12.5,
            fontWeight: 500,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 6,
            cursor: saving || busy ? "not-allowed" : "pointer",
            opacity: saving || busy ? 0.5 : 1,
          }}
        >
          <Icon d={P.play} size={11} stroke={0} fill="currentColor" />
          <span>Record another</span>
        </button>
        <button
          onClick={() => onDiscard()}
          disabled={busy || lastSavedPath != null}
          style={{
            width: "100%",
            padding: "6px 0",
            height: 28,
            background: "transparent",
            border: "1px solid transparent",
            color: "var(--recording-tint)",
            fontSize: 12,
            fontWeight: 500,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 6,
            cursor: busy || lastSavedPath != null ? "not-allowed" : "pointer",
            opacity: busy || lastSavedPath != null ? 0.4 : 1,
            fontFamily: "var(--font-system)",
          }}
        >
          {I.trash}
          <span>Discard recording</span>
        </button>
      </div>
    </div>
  );
}

function DestRow({
  icon,
  title,
  sub,
  action,
  kbd,
  primary,
  onClick,
  disabled,
}: {
  icon: React.ReactNode;
  title: string;
  sub: string;
  action?: React.ReactNode;
  kbd?: React.ReactNode;
  primary?: boolean;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        display: "grid",
        gridTemplateColumns: "28px 1fr auto",
        alignItems: "center",
        gap: 10,
        padding: "9px 11px",
        width: "100%",
        background: primary ? "var(--accent-soft)" : "var(--bg-elevated)",
        border: `1px solid ${primary ? "var(--accent)" : "var(--border-faint)"}`,
        borderRadius: 7,
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.5 : 1,
        textAlign: "left",
        color: "var(--fg-primary)",
        fontFamily: "var(--font-system)",
      }}
    >
      <span
        style={{
          width: 26,
          height: 26,
          borderRadius: 6,
          background: primary ? "var(--accent)" : "var(--bg-input)",
          color: primary ? "#fff" : "var(--fg-secondary)",
          border: "1px solid var(--border-faint)",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {icon}
      </span>
      <span style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0 }}>
        <span style={{ fontSize: 12.5, fontWeight: 600, letterSpacing: "-0.005em" }}>{title}</span>
        <span
          style={{
            fontSize: 11,
            color: "var(--fg-tertiary)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {sub}
        </span>
      </span>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
        {action && <span style={{ color: "var(--fg-tertiary)" }}>{action}</span>}
        {kbd && <span style={{ display: "inline-flex", gap: 3 }}>{kbd}</span>}
      </span>
    </button>
  );
}
