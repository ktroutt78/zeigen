import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { emit, listen } from "@tauri-apps/api/event";
import { revealItemInDir, openUrl } from "@tauri-apps/plugin-opener";
import { ask, open } from "@tauri-apps/plugin-dialog";
import { Icon, I, P } from "./components/icons";
import Waveform from "./Waveform";
import ScrubPreview from "./ScrubPreview";

// Review window. Left column is player + timeline; right column is an
// accordion panel (Annotate / Export / Share / Watermark sections plus a
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

type Annotation = {
  type: "text" | "arrow" | "blur" | "spotlight";
  start_time: number;
  end_time: number;
  position: Position;
  content: string;
  // Text-only: font size in source pixels. Defaults to 36 when absent.
  size?: number;
  // Arrow-only (C5), blur-only, and spotlight-only: end point in
  // source-fraction coords. Blur and spotlight reuse the arrow's two-point
  // shape as their rect corners — no new sidecar field, same reuse the
  // Rust side makes in edit.rs.
  endpoint?: Position;
  stroke?: number;
};

type Tool = "text" | "arrow" | "blur" | "spotlight" | null;

// Global per-recording annotation color — one color for all arrows/text on
// the recording (not per-annotation). White is the pre-feature hardcode, so
// absent/white means byte-identical legacy behavior. The last-picked color
// is remembered across recordings (localStorage, like the accordion state);
// the per-recording value travels to the export via the sidecar.
const ANNOTATION_COLORS = [
  { name: "White", hex: "#FFFFFF" },
  { name: "Black", hex: "#000000" },
  { name: "Red", hex: "#FF3B30" },
  { name: "Yellow", hex: "#FFD60A" },
  { name: "Blue", hex: "#0A84FF" },
] as const;
const DEFAULT_ANNOTATION_COLOR = "#FFFFFF";
const ANNOTATION_COLOR_LS_KEY = "review-annotation-color";

function loadAnnotationColor(): string {
  try {
    const raw = localStorage.getItem(ANNOTATION_COLOR_LS_KEY);
    return ANNOTATION_COLORS.some((c) => c.hex === raw) ? raw! : DEFAULT_ANNOTATION_COLOR;
  } catch {
    return DEFAULT_ANNOTATION_COLOR;
  }
}

function persistAnnotationColor(hex: string) {
  try {
    localStorage.setItem(ANNOTATION_COLOR_LS_KEY, hex);
  } catch {
    // Best-effort; the session still works from React state.
  }
}

// Dark colors get a light text pill (and vice versa) so the glyphs stay
// readable — mirrored by edit.rs's rasterize_text luminance flip so preview
// and export show the same pill.
function isDarkColor(hex: string): boolean {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128;
}

// Contrasting outline drawn under the arrow so it stays visible on any
// background — same luma rule and tones as the text pill flip, mirrored by
// edit.rs rasterize_arrow so preview and export match.
function contrastOutline(hex: string): string {
  return isDarkColor(hex) ? "#F5F5F7" : "#141416";
}

const DEFAULT_TEXT_SIZE = 36;
const ANNOTATION_DEFAULT_DURATION = 3;
const MIN_TEXT_SIZE = 12;
const MAX_TEXT_SIZE = 200;

type Editor = {
  tool: Tool;
  setTool: (t: Tool) => void;
  annotations: Annotation[];
  selectedIndex: number | null;
  setSelectedIndex: (n: number | null) => void;
  editingIndex: number | null;
  setEditingIndex: (n: number | null) => void;
  updateAnnotation: (idx: number, patch: Partial<Annotation>) => void;
  deleteAnnotation: (idx: number) => void;
  placeTextAt: (xFrac: number, yFrac: number) => void;
  placeArrow: (start: Position, end: Position) => void;
  placeBlur: (start: Position, end: Position) => void;
  placeSpotlight: (start: Position, end: Position) => void;
};

const DEFAULT_ARROW_STROKE = 8;
const ARROW_MIN_LENGTH_FRAC = 0.01;
// Below this, both drag dimensions are too small to redact/highlight
// anything meaningful — drop the drag instead of creating a near-zero-size
// region. Shared by both rect tools (blur, spotlight): same two-point drag
// gesture, same "too small to matter" threshold.
const REGION_MIN_SIZE_FRAC = 0.01;
// Rough visual match to edit.rs's BLUR_SIGMA_MIN_PX / BLUR_SIGMA_FRAC —
// same class of by-eye calibration as composite.rs's shadow gblur-vs-CSS-
// blur note. CSS backdrop-filter and ffmpeg gblur aren't the same math, so
// this is "looks about as strong," not a derived equivalence.
const BLUR_PREVIEW_PX = 18;
// Rough visual match to edit.rs's SPOTLIGHT_DIM_FACTOR (0.45) — a flat
// black overlay at this alpha approximates "45% brightness" closely enough
// for a live preview. Same "looks about as strong" caveat as BLUR_PREVIEW_PX.
const SPOTLIGHT_PREVIEW_DIM_ALPHA = 1 - 0.45;

type Trim = { in: number; out: number };

// Mirror of src-tauri/src/edit.rs::BubblePositionEntry. Round-tripped
// opaquely by the review window — finalize-time keyframes must survive
// any sidecar rewrite the review triggers (trim/annotation edits, or
// the empty-state delete path). Phase 15 c3's dual-stream player will
// read these directly to position the bubble in the preview.
type BubblePositionEntry = {
  t: number;
  x: number;
  y: number;
  diameter?: number | null;
};

type SidecarState = {
  trim?: Trim | null;
  annotations: Annotation[];
  bubble_position_log?: BubblePositionEntry[];
  // Original-timeline timestamp picked via the Thumbnail tool. null/undefined
  // means "use the export-time default" (0.5s in) applied on the Rust side.
  // Stored in original-timeline coords like annotation.start_time.
  thumbnail_time?: number | null;
  // Bubble corner roundness, 0.0 (square)..1.0 (circle). null/undefined =
  // circle via the legacy mask path — composite.rs keeps that branch
  // byte-identical to pre-E1, so the slider only writes the field when the
  // user moves it off full circle.
  bubble_roundness?: number | null;
  // Global color for all text/arrow annotations, "#RRGGBB". null/undefined
  // = white (the pre-feature hardcode) — only written when annotations
  // exist and the color is non-white, keeping legacy sidecars unchanged.
  annotation_color?: string | null;
};

const EMPTY_STATE: SidecarState = {
  trim: null,
  annotations: [],
  bubble_position_log: [],
  thumbnail_time: null,
  bubble_roundness: null,
  annotation_color: null,
};

// Effective sidecar color: null unless there are annotations to color AND
// the color differs from the white default. Keeps color-only state from
// dirtying a recording or keeping an otherwise-empty sidecar alive.
function normalizeAnnotationColor(s: SidecarState): string | null {
  const c = s.annotation_color ?? null;
  if (!c || s.annotations.length === 0) return null;
  return c.toUpperCase() === DEFAULT_ANNOTATION_COLOR ? null : c;
}
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
type AppSettings = { watermark: { logo_path: string | null; corner: string } };

// Watermark controls passed to ExportPanel. logoPath/corner persist via
// settings.json; apply is per-recording (not persisted).
type WatermarkUI = {
  logoPath: string | null;
  corner: WmCorner;
  apply: boolean;
  onPick: () => void;
  onRemove: () => void;
  onCorner: (c: WmCorner) => void;
  onToggleApply: () => void;
};

// Watermark preview passed to VideoStage. src is the convertFileSrc'd logo
// (or null when nothing should render); videoDims drives the content-box
// computation so the overlay tracks the letterboxed video, not the stage.
type WatermarkPreview = {
  src: string | null;
  corner: WmCorner;
  videoDims: { w: number; h: number } | null;
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
  if (a.annotations.length !== b.annotations.length) return false;
  for (let i = 0; i < a.annotations.length; i++) {
    if (JSON.stringify(a.annotations[i]) !== JSON.stringify(b.annotations[i])) return false;
  }
  const tta = a.thumbnail_time ?? null;
  const ttb = b.thumbnail_time ?? null;
  if ((tta == null) !== (ttb == null)) return false;
  if (tta != null && ttb != null && Math.abs(tta - ttb) > TRIM_EPS) return false;
  const bra = a.bubble_roundness ?? null;
  const brb = b.bubble_roundness ?? null;
  if ((bra == null) !== (brb == null)) return false;
  if (bra != null && brb != null && Math.abs(bra - brb) > 0.001) return false;
  if (normalizeAnnotationColor(a) !== normalizeAnnotationColor(b)) return false;
  return true;
}

// Phase 15 c3 bubble keyframe interpolation. Mirror of composite.rs's
// inline-expression logic — given the sidecar's bubble_position_log and
// a current playback time, return where the bubble should sit. x/y are
// normalized [0..1] within the recorded display frame; diameter is in
// physical pixels (matched against the screen video's natural width to
// derive a CSS pixel size). Returns null when there's no log (screen-
// only or pre-Phase-8 recordings) — caller renders no bubble.
//
// Linear interpolation between keyframes is the same shape composite.rs
// uses via `overlay=x=...:y=...` expressions at export time, so preview
// and saved file place the bubble at the same fractional coords.
const DEFAULT_BUBBLE_DIAMETER_PX = 240; // mirrors WebcamSize::Medium
function bubbleAt(
  log: BubblePositionEntry[],
  t: number,
): { x: number; y: number; diameter: number } | null {
  if (log.length === 0) return null;
  const diameter = log[0].diameter ?? DEFAULT_BUBBLE_DIAMETER_PX;
  if (t <= log[0].t) {
    return { x: log[0].x, y: log[0].y, diameter };
  }
  for (let i = 1; i < log.length; i++) {
    if (t <= log[i].t) {
      const a = log[i - 1];
      const b = log[i];
      const dt = b.t - a.t;
      if (dt <= 0) return { x: b.x, y: b.y, diameter };
      const frac = (t - a.t) / dt;
      return {
        x: a.x + (b.x - a.x) * frac,
        y: a.y + (b.y - a.y) * frac,
        diameter,
      };
    }
  }
  // Past last keyframe — hold at the last logged position. Matches
  // composite.rs's final `gte(t,T)` branch which keeps the bubble fixed.
  const last = log[log.length - 1];
  return { x: last.x, y: last.y, diameter };
}

function isLogicallyEmpty(s: SidecarState, duration: number | null): boolean {
  // Bubble keyframes are finalize-time data the review must preserve —
  // even a "no edits yet" sidecar with only bubble_position_log is NOT
  // empty, or the delete branch below would wipe the keyframes.
  const noBubble = !s.bubble_position_log || s.bubble_position_log.length === 0;
  const noThumb = s.thumbnail_time == null;
  const noRoundness = s.bubble_roundness == null;
  return (
    normalizeTrim(s.trim, duration) == null &&
    s.annotations.length === 0 &&
    noBubble &&
    noThumb &&
    noRoundness
  );
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
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  // Round-tripped opaquely. The frontend never mutates this; it just
  // preserves what finalize wrote so sidecar rewrites (trim/annotation
  // edits, empty-state delete path) don't wipe the bubble keyframes.
  const [bubblePositionLog, setBubblePositionLog] = useState<BubblePositionEntry[]>([]);
  const [bubbleRoundness, setBubbleRoundness] = useState<number | null>(null);
  // Global annotation color. Initialized from the remembered preference;
  // the sidecar-read effect overrides it for recordings that already have
  // annotations (so opening an old recording never recolors it).
  const [annotationColor, setAnnotationColor] = useState<string>(loadAnnotationColor);
  const onAnnotationColor = useCallback((hex: string) => {
    setAnnotationColor(hex);
    persistAnnotationColor(hex);
  }, []);
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

  // Annotation editing state.
  const [tool, setTool] = useState<Tool>(null);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);

  // Watermark (c3). logoPath + corner are the remembered global settings;
  // apply is per-recording (default on once a logo is set) — turning it off
  // skips the watermark on this clip without forgetting the logo. videoDims
  // is captured at metadata so the preview can size against the real frame.
  const [wmLogoPath, setWmLogoPath] = useState<string | null>(null);
  const [wmCorner, setWmCorner] = useState<WmCorner>("tr");
  const [wmApply, setWmApply] = useState(false);
  const [videoDims, setVideoDims] = useState<{ w: number; h: number } | null>(null);

  useEffect(() => {
    invoke<AppSettings>("get_settings")
      .then((s) => {
        const lp = s.watermark?.logo_path ?? null;
        const c = (s.watermark?.corner ?? "tr") as WmCorner;
        setWmLogoPath(lp);
        setWmCorner(WM_CORNERS.includes(c) ? c : "tr");
        setWmApply(!!lp);
      })
      .catch((err) => console.warn("get_settings failed", err));
  }, []);

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

  const updateAnnotation = useCallback(
    (idx: number, patch: Partial<Annotation>) => {
      setAnnotations((prev) =>
        prev.map((a, i) => (i === idx ? { ...a, ...patch } : a)),
      );
    },
    [],
  );

  const deleteAnnotation = useCallback(
    (idx: number) => {
      setAnnotations((prev) => prev.filter((_, i) => i !== idx));
      setSelectedIndex(null);
      setEditingIndex(null);
    },
    [],
  );

  const placeTextAt = useCallback(
    (xFrac: number, yFrac: number) => {
      const t = videoRef.current?.currentTime ?? 0;
      const end = duration != null ? Math.min(duration, t + ANNOTATION_DEFAULT_DURATION) : t + ANNOTATION_DEFAULT_DURATION;
      const ann: Annotation = {
        type: "text",
        start_time: t,
        end_time: end,
        position: { x: xFrac, y: yFrac },
        content: "",
        size: DEFAULT_TEXT_SIZE,
      };
      setAnnotations((prev) => {
        const next = [...prev, ann];
        const newIdx = next.length - 1;
        // Defer selection/edit-mode state to a microtask so the new index is
        // valid against the freshly-rendered list.
        Promise.resolve().then(() => {
          setSelectedIndex(newIdx);
          setEditingIndex(newIdx);
        });
        return next;
      });
      setTool(null);
    },
    [duration],
  );

  const placeArrow = useCallback(
    (start: Position, end: Position) => {
      const t = videoRef.current?.currentTime ?? 0;
      const endT =
        duration != null ? Math.min(duration, t + ANNOTATION_DEFAULT_DURATION) : t + ANNOTATION_DEFAULT_DURATION;
      const ann: Annotation = {
        type: "arrow",
        start_time: t,
        end_time: endT,
        position: start,
        endpoint: end,
        stroke: DEFAULT_ARROW_STROKE,
        content: "",
      };
      setAnnotations((prev) => {
        const next = [...prev, ann];
        const newIdx = next.length - 1;
        Promise.resolve().then(() => {
          setSelectedIndex(newIdx);
        });
        return next;
      });
      setTool(null);
    },
    [duration],
  );

  const placeBlur = useCallback(
    (start: Position, end: Position) => {
      const t = videoRef.current?.currentTime ?? 0;
      const endT =
        duration != null ? Math.min(duration, t + ANNOTATION_DEFAULT_DURATION) : t + ANNOTATION_DEFAULT_DURATION;
      const ann: Annotation = {
        type: "blur",
        start_time: t,
        end_time: endT,
        position: start,
        endpoint: end,
        content: "",
      };
      setAnnotations((prev) => {
        const next = [...prev, ann];
        const newIdx = next.length - 1;
        Promise.resolve().then(() => {
          setSelectedIndex(newIdx);
        });
        return next;
      });
      setTool(null);
    },
    [duration],
  );

  const placeSpotlight = useCallback(
    (start: Position, end: Position) => {
      const t = videoRef.current?.currentTime ?? 0;
      const endT =
        duration != null ? Math.min(duration, t + ANNOTATION_DEFAULT_DURATION) : t + ANNOTATION_DEFAULT_DURATION;
      const ann: Annotation = {
        type: "spotlight",
        start_time: t,
        end_time: endT,
        position: start,
        endpoint: end,
        content: "",
      };
      setAnnotations((prev) => {
        const next = [...prev, ann];
        const newIdx = next.length - 1;
        Promise.resolve().then(() => {
          setSelectedIndex(newIdx);
        });
        return next;
      });
      setTool(null);
    },
    [duration],
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
            annotations: state.annotations ?? [],
            bubble_position_log: state.bubble_position_log ?? [],
            thumbnail_time: state.thumbnail_time ?? null,
            bubble_roundness: state.bubble_roundness ?? null,
            annotation_color: state.annotation_color ?? null,
          });
          if (state.trim) setTrim(state.trim);
          if (state.annotations) setAnnotations(state.annotations);
          if (state.bubble_position_log) setBubblePositionLog(state.bubble_position_log);
          if (state.thumbnail_time != null) setThumbnailTime(state.thumbnail_time);
          if (state.bubble_roundness != null) setBubbleRoundness(state.bubble_roundness);
          // Recordings with existing annotations keep their own color
          // (absent = white, the pre-feature behavior) — the remembered
          // preference only seeds recordings that have no annotations yet.
          if (state.annotation_color != null) {
            setAnnotationColor(state.annotation_color);
          } else if ((state.annotations ?? []).length > 0) {
            setAnnotationColor(DEFAULT_ANNOTATION_COLOR);
          }
        } else {
          setSnapshot(EMPTY_STATE);
        }
      })
      .catch((err) => setError(`read sidecar: ${err}`));
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
      annotations,
      bubble_position_log: bubblePositionLog,
      thumbnail_time: thumbnailTime,
      bubble_roundness: bubbleRoundness,
      annotation_color: annotationColor,
    }),
    [trim, annotations, bubblePositionLog, thumbnailTime, bubbleRoundness, annotationColor],
  );

  const dirty = useMemo(
    () => !statesEqual(currentState, snapshot, duration),
    [currentState, snapshot, duration],
  );

  // Debounced sidecar persistence on edit. Empty states are deleted to keep
  // the sources area tidy; non-empty states are written. Any sidecar change
  // also invalidates committedMp4Path — the cached LinkedIn baseline is now
  // stale, so the next LinkedIn click chains a fresh save instead of
  // shipping the old bake.
  useEffect(() => {
    if (!sourcePath || duration == null) return;
    const empty = isLogicallyEmpty(currentState, duration);
    const handle = window.setTimeout(() => {
      const norm: SidecarState = {
        trim: normalizeTrim(currentState.trim, duration),
        annotations: currentState.annotations,
        bubble_position_log: currentState.bubble_position_log,
        thumbnail_time: currentState.thumbnail_time ?? null,
        bubble_roundness: currentState.bubble_roundness ?? null,
        annotation_color: normalizeAnnotationColor(currentState),
      };
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
        }>("save_recording", {
          stamp,
          sourcePath,
          format: spec.format,
          resolution: spec.resolution,
          fps: spec.format === "gif" ? spec.fps : undefined,
          watermarkLogo: wmEffectiveLogo,
          watermarkCorner: wmCorner,
        });
        setLastSavedPath(result.output_path);
        setLastSavedAt(Date.now());
        if (spec.format === "mp4") setCommittedMp4Path(result.output_path);
        if (result.thumbnail_out_of_trim) {
          setNotice(
            "Thumbnail was outside the trim range — used the start of the trimmed output instead. Pick a new thumbnail to override.",
          );
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
    [sourcePath, wmEffectiveLogo, wmCorner],
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

  // Global keyboard shortcuts: T/A → text tool, R → arrow tool (C5),
  // Space → play/pause, ←/→ → seek, ,/. → frame-step (Premiere/Final Cut
  // convention — doesn't collide with arrow-key seeking), Shift+,/. (</>)
  // → cycle playback speed (YouTube's own binding for the same keys),
  // Esc → cancel tool/selection, Backspace/Delete → delete selection.
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
      if (key === "t" || key === "a") {
        e.preventDefault();
        setTool((prev) => (prev === "text" ? null : "text"));
        setSelectedIndex(null);
        setEditingIndex(null);
      } else if (key === "r") {
        e.preventDefault();
        setTool((prev) => (prev === "arrow" ? null : "arrow"));
        setSelectedIndex(null);
        setEditingIndex(null);
      } else if (key === "b") {
        e.preventDefault();
        setTool((prev) => (prev === "blur" ? null : "blur"));
        setSelectedIndex(null);
        setEditingIndex(null);
      } else if (key === "s") {
        e.preventDefault();
        setTool((prev) => (prev === "spotlight" ? null : "spotlight"));
        setSelectedIndex(null);
        setEditingIndex(null);
      } else if (e.key === " ") {
        e.preventDefault();
        togglePlay();
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
        setPlaybackRate((r) => cyclePlaybackRate(r, -1));
      } else if (e.key === ">") {
        e.preventDefault();
        setPlaybackRate((r) => cyclePlaybackRate(r, 1));
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
        if (editingIndex != null) {
          setEditingIndex(null);
        } else if (selectedIndex != null) {
          setSelectedIndex(null);
        } else if (tool != null) {
          setTool(null);
        }
      } else if (e.key === "Backspace" || e.key === "Delete") {
        if (selectedIndex != null && editingIndex == null) {
          e.preventDefault();
          deleteAnnotation(selectedIndex);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    showCloseModal,
    tool,
    selectedIndex,
    editingIndex,
    deleteAnnotation,
    togglePlay,
    seek,
    frameStep,
    duration,
  ]);

  // Shared by VideoStage, Timeline, and the right panel's Annotate section.
  const editorApi: Editor = {
    tool,
    setTool,
    annotations,
    selectedIndex,
    setSelectedIndex,
    editingIndex,
    setEditingIndex,
    updateAnnotation,
    deleteAnnotation,
    placeTextAt,
    placeArrow,
    placeBlur,
    placeSpotlight,
  };

  const thumbnailControls: ThumbnailControls = {
    thumbnailTime,
    setThumbnailTime,
    previewUrl: playbackUrl,
    getCurrentTime: () => videoRef.current?.currentTime ?? 0,
  };

  // Post-trim length shown in the header (the old toolbar's info strip
  // merged here when the toolbar moved into the Annotate section).
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
          onPause={() => setPlaying(false)}
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
          }}
          editor={editorApi}
          annotationColor={annotationColor}
          thumbnailTime={thumbnailTime}
          bubbleRoundness={bubbleRoundness}
        />
        <ExportPanel
          sourcePath={sourcePath}
          editor={editorApi}
          thumbnail={thumbnailControls}
          annotationColor={annotationColor}
          onAnnotationColor={onAnnotationColor}
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
            onPick: onPickLogo,
            onRemove: onRemoveLogo,
            onCorner: onCornerChange,
            onToggleApply,
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
  editor: Editor;
  // Global per-recording annotation color (text glyphs, arrow stroke).
  annotationColor: string;
  // Timeline marker only — the thumbnail picker itself lives in the right
  // panel's Annotate section.
  thumbnailTime: number | null;
  // Read-only: stamped into the sidecar at record time (recorder UI owns
  // the control); Review only previews it via BubbleLayer's border-radius.
  bubbleRoundness: number | null;
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
        editor={props.editor}
        annotationColor={props.annotationColor}
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
        editor={props.editor}
        thumbnailTime={props.thumbnailTime}
      />
    </div>
  );
}

// Anchored to the right panel's Annotate section (fixed position, left of
// the panel so it floats over the video). Renders a paused <video> seeked to
// the captured currentTime so the user confirms the exact frame. The
// preview does NOT show the composited bubble/annotations/watermark — those
// are overlays in the main player — so the popover spells that out so the
// user isn't surprised by the final embedded poster.
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
          // collapsed Annotate section, so no row rect exists yet).
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
          at {time.toFixed(2)}s · webcam bubble + annotations are added in the final export
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

// Full-width row inside the Annotate section. Same states as the old
// toolbar's ToolButton, but stacked vertically the rows can never outgrow
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
  editor: Editor;
  annotationColor: string;
};

function VideoStage(props: VideoStageProps) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  // Shared drag-to-draw state for the arrow, blur, and spotlight tools — all
  // three are "two points, drag from start to end" gestures; only the
  // placement callback and the live preview shape differ.
  const [drawingShape, setDrawingShape] = useState<{
    tool: "arrow" | "blur" | "spotlight";
    start: Position;
    end: Position;
  } | null>(null);

  // videoDims drives the letterbox-aware content box below — annotation
  // coordinates must be captured relative to the actual video frame, not
  // the (possibly larger, if the source isn't 16:9) stage box, since that's
  // how the Rust export interprets position/endpoint fractions.
  const videoDims = props.watermarkPreview.videoDims;

  const onStageClick = (e: React.MouseEvent) => {
    if (props.editor.tool !== "text") {
      // Click on empty stage with no tool active = deselect.
      if (props.editor.tool == null && (e.target as HTMLElement).dataset.stageBg === "1") {
        props.editor.setSelectedIndex(null);
        props.editor.setEditingIndex(null);
      }
      return;
    }
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect) return;
    const box = contentBox({ width: rect.width, height: rect.height }, videoDims);
    const stagePx = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    // Reject clicks landing in the letterbox bars — outside the video itself.
    if (
      stagePx.x < box.x ||
      stagePx.x > box.x + box.w ||
      stagePx.y < box.y ||
      stagePx.y > box.y + box.h
    ) {
      return;
    }
    const frac = toContentFrac(stagePx, box);
    props.editor.placeTextAt(frac.x, frac.y);
  };

  const onStagePointerDown = (e: React.PointerEvent) => {
    const tool = props.editor.tool;
    if (tool !== "arrow" && tool !== "blur" && tool !== "spotlight") return;
    if ((e.target as HTMLElement).dataset.stageBg !== "1") return;
    e.preventDefault();
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect) return;
    const box = contentBox({ width: rect.width, height: rect.height }, videoDims);
    const startPx = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    if (
      startPx.x < box.x ||
      startPx.x > box.x + box.w ||
      startPx.y < box.y ||
      startPx.y > box.y + box.h
    ) {
      return;
    }
    const start = toContentFrac(startPx, box);
    setDrawingShape({ tool, start, end: start });
    const onMove = (ev: PointerEvent) => {
      const r = stageRef.current?.getBoundingClientRect();
      if (!r) return;
      const b = contentBox({ width: r.width, height: r.height }, videoDims);
      const end = toContentFrac({ x: ev.clientX - r.left, y: ev.clientY - r.top }, b);
      setDrawingShape({ tool, start, end });
    };
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      const r = stageRef.current?.getBoundingClientRect();
      if (!r) {
        setDrawingShape(null);
        return;
      }
      const b = contentBox({ width: r.width, height: r.height }, videoDims);
      const end = toContentFrac({ x: ev.clientX - r.left, y: ev.clientY - r.top }, b);
      setDrawingShape(null);
      if (tool === "arrow") {
        const dx = end.x - start.x;
        const dy = end.y - start.y;
        const lenFrac = Math.sqrt(dx * dx + dy * dy);
        if (lenFrac < ARROW_MIN_LENGTH_FRAC) return;
        props.editor.placeArrow(start, end);
      } else {
        const wFrac = Math.abs(end.x - start.x);
        const hFrac = Math.abs(end.y - start.y);
        if (wFrac < REGION_MIN_SIZE_FRAC || hFrac < REGION_MIN_SIZE_FRAC) return;
        if (tool === "blur") {
          props.editor.placeBlur(start, end);
        } else {
          props.editor.placeSpotlight(start, end);
        }
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const cursor =
    props.editor.tool === "text" ||
    props.editor.tool === "arrow" ||
    props.editor.tool === "blur" ||
    props.editor.tool === "spotlight"
      ? "crosshair"
      : "default";

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
        onPointerDown={onStagePointerDown}
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
          cursor,
        }}
      >
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
        <BubbleLayer
          stageRef={stageRef}
          screenVideoRef={props.videoRef}
          webcamVideoRef={props.webcamVideoRef}
          webcamUrl={props.webcamUrl}
          webcamLeadSec={props.webcamLeadSec}
          bubblePositionLog={props.bubblePositionLog}
          bubbleRoundness={props.bubbleRoundness}
          scrubbingRef={props.scrubbingRef}
          videoDims={props.watermarkPreview.videoDims}
        />
        <AnnotationLayer
          stageRef={stageRef}
          videoRef={props.videoRef}
          editor={props.editor}
          annotationColor={props.annotationColor}
          currentTime={props.currentTime}
          drawingShape={drawingShape}
          videoDims={videoDims}
        />
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
// tpad=start_mode=clone). Position + diameter come from the sidecar's
// bubble_position_log via bubbleAt(); fall back to nothing when no log
// (screen-only recordings or no webcam).
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
    // phase 14 (be4aa02). Set once per effect run; rAF only mutates
    // transform.
    w.style.width = `${cssDiameter}px`;
    w.style.height = `${cssDiameter}px`;
    w.style.visibility = "visible";

    let rafId = 0;
    const tick = () => {
      const t = s.currentTime;
      const bubble = bubbleAt(bubblePositionLog, t);
      if (bubble) {
        const centerX = cx + bubble.x * cw;
        const centerY = cy + bubble.y * ch;
        const tx = centerX - cssDiameter / 2;
        const ty = centerY - cssDiameter / 2;
        // transform order is right-to-left: scaleX(-1) flips around the
        // element's center first (default transform-origin 50% 50%),
        // then translate(...) shifts the flipped result. Same final
        // placement as the prior left/top + scaleX(-1) form.
        w.style.transform = `translate(${tx}px, ${ty}px) scaleX(-1)`;
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);

    return () => cancelAnimationFrame(rafId);
  }, [
    screenVideoRef,
    webcamVideoRef,
    bubblePositionLog,
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
        // Soft drop shadow — matched in the export by a tiny_skia + gblur
        // pass in composite.rs. Tuning the two to look the same is by-eye
        // (CSS and ffmpeg render shadows differently); see composite.rs's
        // shadow constants for the conversion.
        boxShadow: "0 8px 24px rgba(0, 0, 0, 0.22)",
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
        style={{ position: "absolute", height: logoH, width: "auto", ...anchor }}
      />
    </div>
  );
}

function AnnotationLayer({
  stageRef,
  videoRef,
  editor,
  annotationColor,
  currentTime,
  drawingShape,
  videoDims,
}: {
  stageRef: React.MutableRefObject<HTMLDivElement | null>;
  videoRef: React.MutableRefObject<HTMLVideoElement | null>;
  editor: Editor;
  annotationColor: string;
  currentTime: number;
  drawingShape: { tool: "arrow" | "blur" | "spotlight"; start: Position; end: Position } | null;
  videoDims: { w: number; h: number } | null;
}) {
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        pointerEvents: "none",
      }}
    >
      {editor.annotations.map((ann, idx) => {
        const visible =
          currentTime >= ann.start_time - 0.001 && currentTime <= ann.end_time + 0.001;
        const isSelected = editor.selectedIndex === idx;
        const isEditing = editor.editingIndex === idx;
        // Text/arrow stay visible while selected/editing regardless of
        // playhead position — an editing aid so you can nudge them without
        // scrubbing into their active window. Blur and spotlight are
        // different: their whole point is "only visible in this window," so
        // keeping them rendered outside that range (even while selected for
        // a timeline-handle resize) would misrepresent what the export
        // actually does. The timeline pip's band + resize handles don't
        // depend on this render — they key off isSelected directly — so
        // this doesn't block resizing from the timeline.
        const staysVisibleWhenInactive =
          ann.type !== "blur" && ann.type !== "spotlight" && (isSelected || isEditing);
        if (!visible && !staysVisibleWhenInactive) return null;
        if (ann.type === "text") {
          return (
            <TextAnnotationView
              key={idx}
              ann={ann}
              idx={idx}
              stageRef={stageRef}
              videoRef={videoRef}
              editor={editor}
              color={annotationColor}
              isSelected={isSelected}
              isEditing={isEditing}
              videoDims={videoDims}
            />
          );
        }
        if (ann.type === "arrow" && ann.endpoint) {
          return (
            <ArrowAnnotationView
              key={idx}
              ann={ann}
              idx={idx}
              stageRef={stageRef}
              editor={editor}
              color={annotationColor}
              isSelected={isSelected}
              videoDims={videoDims}
            />
          );
        }
        if (ann.type === "blur" && ann.endpoint) {
          return (
            <BlurAnnotationView
              key={idx}
              ann={ann}
              idx={idx}
              stageRef={stageRef}
              editor={editor}
              isSelected={isSelected}
              videoDims={videoDims}
            />
          );
        }
        if (ann.type === "spotlight" && ann.endpoint) {
          return (
            <SpotlightAnnotationView
              key={idx}
              ann={ann}
              idx={idx}
              stageRef={stageRef}
              editor={editor}
              isSelected={isSelected}
              videoDims={videoDims}
            />
          );
        }
        return null;
      })}
      {drawingShape?.tool === "arrow" && (
        <ArrowPreview
          start={drawingShape.start}
          end={drawingShape.end}
          stageRef={stageRef}
          color={annotationColor}
          videoDims={videoDims}
        />
      )}
      {drawingShape?.tool === "blur" && (
        <BlurPreview
          start={drawingShape.start}
          end={drawingShape.end}
          stageRef={stageRef}
          videoDims={videoDims}
        />
      )}
      {drawingShape?.tool === "spotlight" && (
        <SpotlightPreview
          start={drawingShape.start}
          end={drawingShape.end}
          stageRef={stageRef}
          videoDims={videoDims}
        />
      )}
    </div>
  );
}

function TextAnnotationView({
  ann,
  idx,
  stageRef,
  videoRef,
  editor,
  color,
  isSelected,
  isEditing,
  videoDims,
}: {
  ann: Annotation;
  idx: number;
  stageRef: React.MutableRefObject<HTMLDivElement | null>;
  videoRef: React.MutableRefObject<HTMLVideoElement | null>;
  editor: Editor;
  color: string;
  isSelected: boolean;
  isEditing: boolean;
  videoDims: { w: number; h: number } | null;
}) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const box = useContentBox(stageRef, videoDims);

  // Compute font size in CSS pixels: source-pixel size scaled by the video
  // content box's rendered height vs source video height (not the stage's
  // own height — those differ whenever the source isn't 16:9 and the video
  // letterboxes inside the stage). Falls back to a 1:1 mapping until video
  // metadata is known.
  const sourceHeight = videoRef.current?.videoHeight || 0;
  const scale = sourceHeight && box.h ? box.h / sourceHeight : 1;
  const sizeSrc = ann.size ?? DEFAULT_TEXT_SIZE;
  const sizeCss = sizeSrc * scale;
  const pos = toStagePx(ann.position, box);

  const startBodyDrag = (e: React.PointerEvent) => {
    e.stopPropagation();
    if (isEditing) return;
    if (!isSelected) {
      editor.setSelectedIndex(idx);
    }
    const stage = stageRef.current?.getBoundingClientRect();
    if (!stage) return;
    const dragBox = contentBox({ width: stage.width, height: stage.height }, videoDims);
    const startX = e.clientX;
    const startY = e.clientY;
    const startPos = ann.position;
    const onMove = (ev: PointerEvent) => {
      const dx = (ev.clientX - startX) / dragBox.w;
      const dy = (ev.clientY - startY) / dragBox.h;
      editor.updateAnnotation(idx, {
        position: {
          x: Math.max(0, Math.min(1, startPos.x + dx)),
          y: Math.max(0, Math.min(1, startPos.y + dy)),
        },
      });
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const startResize = (corner: "tl" | "tr" | "bl" | "br") => (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const stage = stageRef.current?.getBoundingClientRect();
    if (!stage || !sourceHeight) return;
    const startY = e.clientY;
    const startSize = ann.size ?? DEFAULT_TEXT_SIZE;
    // Sign convention: dragging away from the body grows; toward shrinks.
    const grow = corner === "br" || corner === "bl" ? 1 : -1;
    const onMove = (ev: PointerEvent) => {
      const dy = (ev.clientY - startY) * grow;
      const dySrc = dy / scale; // CSS px → source px
      const next = Math.max(MIN_TEXT_SIZE, Math.min(MAX_TEXT_SIZE, startSize + dySrc));
      editor.updateAnnotation(idx, { size: next });
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  // Auto-focus contentEditable when entering edit mode.
  useEffect(() => {
    if (isEditing) {
      const el = bodyRef.current;
      if (!el) return;
      el.focus();
      // Place caret at end.
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
  }, [isEditing]);

  const onBodyClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!isSelected) editor.setSelectedIndex(idx);
  };
  const onBodyDoubleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    editor.setSelectedIndex(idx);
    editor.setEditingIndex(idx);
  };
  const onContentBlur = () => {
    const text = bodyRef.current?.innerText.trim() ?? "";
    if (text === "") {
      // Empty annotations are dropped on commit.
      editor.deleteAnnotation(idx);
      return;
    }
    if (text !== ann.content) {
      editor.updateAnnotation(idx, { content: text });
    }
    editor.setEditingIndex(null);
  };
  const onContentKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      bodyRef.current?.blur();
    } else if (e.key === "Escape") {
      e.preventDefault();
      bodyRef.current?.blur();
    }
  };

  const showHandles = isSelected && !isEditing;

  return (
    <div
      onPointerDown={startBodyDrag}
      onClick={onBodyClick}
      onDoubleClick={onBodyDoubleClick}
      style={{
        position: "absolute",
        left: pos.x,
        top: pos.y,
        padding: `${Math.max(3, sizeCss * 0.15)}px ${Math.max(6, sizeCss * 0.3)}px`,
        // Pill luminance flips against dark glyph colors — mirrored by
        // edit.rs rasterize_text so preview and export match.
        background: isDarkColor(color)
          ? "rgba(245,245,247,0.86)"
          : "rgba(20,20,22,0.86)",
        color,
        borderRadius: Math.max(3, sizeCss * 0.15),
        border: isDarkColor(color)
          ? "0.5px solid rgba(0,0,0,0.18)"
          : "0.5px solid rgba(255,255,255,0.18)",
        fontFamily: "var(--font-system)",
        fontSize: `${sizeCss}px`,
        lineHeight: 1.2,
        fontWeight: 600,
        letterSpacing: "-0.005em",
        boxShadow: "0 6px 16px rgba(0,0,0,0.45)",
        outline: isSelected ? "1.5px solid var(--accent)" : "none",
        outlineOffset: 2,
        cursor: isEditing ? "text" : isSelected ? "move" : "pointer",
        pointerEvents: "auto",
        whiteSpace: "pre-wrap",
        userSelect: isEditing ? "text" : "none",
      }}
    >
      <div
        ref={bodyRef}
        contentEditable={isEditing}
        suppressContentEditableWarning
        onBlur={onContentBlur}
        onKeyDown={onContentKeyDown}
        spellCheck={false}
        style={{
          outline: "none",
          minWidth: isEditing && ann.content === "" ? `${Math.max(60, sizeCss * 2)}px` : undefined,
        }}
      >
        {ann.content || (isEditing ? "" : "Type here…")}
      </div>
      {showHandles && (
        <>
          <ResizeHandle pos="tl" onPointerDown={startResize("tl")} />
          <ResizeHandle pos="tr" onPointerDown={startResize("tr")} />
          <ResizeHandle pos="bl" onPointerDown={startResize("bl")} />
          <ResizeHandle pos="br" onPointerDown={startResize("br")} />
        </>
      )}
    </div>
  );
}

function ResizeHandle({
  pos,
  onPointerDown,
}: {
  pos: "tl" | "tr" | "bl" | "br";
  onPointerDown: (e: React.PointerEvent) => void;
}) {
  const top = pos === "tl" || pos === "tr" ? -4 : "calc(100% - 3px)";
  const left = pos === "tl" || pos === "bl" ? -4 : "calc(100% - 3px)";
  const cursor =
    pos === "tl" || pos === "br" ? "nwse-resize" : "nesw-resize";
  return (
    <span
      onPointerDown={onPointerDown}
      style={{
        position: "absolute",
        top,
        left,
        width: 7,
        height: 7,
        borderRadius: 1.5,
        background: "#fff",
        border: "1px solid var(--accent)",
        cursor,
        touchAction: "none",
      }}
    />
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
// BubbleLayer — now also used by annotation capture/render so a drawn box
// can't drift from how the Rust export interprets position/endpoint
// (always a fraction of the true video frame; ffmpeg's pixel space has no
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

function ArrowMarker({ id, fill }: { id: string; fill: string }) {
  return (
    <marker
      id={id}
      markerWidth="6"
      markerHeight="6"
      refX="5.5"
      refY="3"
      orient="auto"
      markerUnits="strokeWidth"
      // The contrast outline strokes past the 6x6 marker box; without this
      // the marker viewport clips it.
      style={{ overflow: "visible" }}
    >
      <path
        d="M0,0 L6,3 L0,6 z"
        fill={fill}
        stroke={contrastOutline(fill)}
        strokeWidth={0.7}
        strokeLinejoin="round"
        // Stroke under fill — the rim sits outside the head silhouette,
        // matching the export's outline-then-fill paint order.
        paintOrder="stroke"
      />
    </marker>
  );
}

function ArrowAnnotationView({
  ann,
  idx,
  stageRef,
  editor,
  color,
  isSelected,
  videoDims,
}: {
  ann: Annotation;
  idx: number;
  stageRef: React.MutableRefObject<HTMLDivElement | null>;
  editor: Editor;
  color: string;
  isSelected: boolean;
  videoDims: { w: number; h: number } | null;
}) {
  const box = useContentBox(stageRef, videoDims);
  const endpoint = ann.endpoint!;
  const stroke = ann.stroke ?? DEFAULT_ARROW_STROKE;

  // Display stroke: scale source px to CSS px using stage height as a proxy
  // (we don't always know source dims here). At common sizes this is close
  // enough for preview; saved arrow PNG uses the same source-px stroke.
  const strokeCss = Math.max(2, Math.min(8, stroke * 0.35));
  const markerId = `arrow-head-${idx}`;

  const { x: sx, y: sy } = toStagePx(ann.position, box);
  const { x: ex, y: ey } = toStagePx(endpoint, box);

  const startEndpointDrag = (which: "start" | "end") => (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (!isSelected) editor.setSelectedIndex(idx);
    const stage = stageRef.current?.getBoundingClientRect();
    if (!stage) return;
    const dragBox = contentBox({ width: stage.width, height: stage.height }, videoDims);
    const onMove = (ev: PointerEvent) => {
      const frac = toContentFrac({ x: ev.clientX - stage.left, y: ev.clientY - stage.top }, dragBox);
      if (which === "start") {
        editor.updateAnnotation(idx, { position: frac });
      } else {
        editor.updateAnnotation(idx, { endpoint: frac });
      }
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const startBodyDrag = (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (!isSelected) editor.setSelectedIndex(idx);
    const stage = stageRef.current?.getBoundingClientRect();
    if (!stage) return;
    const dragBox = contentBox({ width: stage.width, height: stage.height }, videoDims);
    const startX = e.clientX;
    const startY = e.clientY;
    const startPos = ann.position;
    const startEnd = endpoint;
    const onMove = (ev: PointerEvent) => {
      const dx = (ev.clientX - startX) / dragBox.w;
      const dy = (ev.clientY - startY) / dragBox.h;
      const np = {
        x: Math.max(0, Math.min(1, startPos.x + dx)),
        y: Math.max(0, Math.min(1, startPos.y + dy)),
      };
      const ne = {
        x: Math.max(0, Math.min(1, startEnd.x + dx)),
        y: Math.max(0, Math.min(1, startEnd.y + dy)),
      };
      editor.updateAnnotation(idx, { position: np, endpoint: ne });
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  return (
    <svg
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        pointerEvents: "none",
        overflow: "visible",
      }}
    >
      <defs>
        <ArrowMarker id={markerId} fill={color} />
      </defs>
      {/* Contrast outline under the shaft (head outline lives in the
          marker via paint-order) */}
      <line
        x1={sx}
        y1={sy}
        x2={ex}
        y2={ey}
        stroke={contrastOutline(color)}
        strokeWidth={strokeCss + 2}
        strokeLinecap="round"
      />
      {/* Visible shaft */}
      <line
        x1={sx}
        y1={sy}
        x2={ex}
        y2={ey}
        stroke={color}
        strokeWidth={strokeCss}
        strokeLinecap="round"
        markerEnd={`url(#${markerId})`}
      />
      {/* Wider hit area for body-drag (transparent) */}
      <line
        x1={sx}
        y1={sy}
        x2={ex}
        y2={ey}
        stroke="transparent"
        strokeWidth={Math.max(strokeCss + 8, 12)}
        strokeLinecap="round"
        style={{ pointerEvents: isSelected ? "stroke" : "stroke", cursor: "move" }}
        onPointerDown={startBodyDrag}
        onClick={(e) => {
          e.stopPropagation();
          if (!isSelected) editor.setSelectedIndex(idx);
        }}
      />
      {isSelected && (
        <>
          <EndpointHandle cx={sx} cy={sy} onPointerDown={startEndpointDrag("start")} />
          <EndpointHandle cx={ex} cy={ey} onPointerDown={startEndpointDrag("end")} />
        </>
      )}
    </svg>
  );
}

// Redact-region preview. Same two-point drag model as ArrowAnnotationView
// (position + endpoint, whole-body drag translates both) — rendered as an
// HTML div with a CSS blur instead of an SVG line, since the region needs
// a rect, not a stroke. Corner handles are plain HTML circles (PointHandle)
// rather than EndpointHandle's SVG <circle>, since this view has no <svg>
// wrapper to host one.
//
// Positions relative to the letterbox-aware content box (via useContentBox),
// same convention as Bubble/Watermark and now Text/Arrow/Spotlight too —
// matches how the Rust export reads position/endpoint as a fraction of the
// true video frame, independent of any letterbox bars the stage renders
// when the source isn't 16:9.
function BlurAnnotationView({
  ann,
  idx,
  stageRef,
  editor,
  isSelected,
  videoDims,
}: {
  ann: Annotation;
  idx: number;
  stageRef: React.MutableRefObject<HTMLDivElement | null>;
  editor: Editor;
  isSelected: boolean;
  videoDims: { w: number; h: number } | null;
}) {
  const box = useContentBox(stageRef, videoDims);
  const endpoint = ann.endpoint!;

  const p0 = toStagePx(ann.position, box);
  const p1 = toStagePx(endpoint, box);
  const x0 = Math.min(p0.x, p1.x);
  const y0 = Math.min(p0.y, p1.y);
  const x1 = Math.max(p0.x, p1.x);
  const y1 = Math.max(p0.y, p1.y);

  const startCornerDrag = (which: "position" | "endpoint") => (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (!isSelected) editor.setSelectedIndex(idx);
    const stage = stageRef.current?.getBoundingClientRect();
    if (!stage) return;
    const dragBox = contentBox({ width: stage.width, height: stage.height }, videoDims);
    const onMove = (ev: PointerEvent) => {
      const frac = toContentFrac({ x: ev.clientX - stage.left, y: ev.clientY - stage.top }, dragBox);
      if (which === "position") {
        editor.updateAnnotation(idx, { position: frac });
      } else {
        editor.updateAnnotation(idx, { endpoint: frac });
      }
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const startBodyDrag = (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (!isSelected) editor.setSelectedIndex(idx);
    const stage = stageRef.current?.getBoundingClientRect();
    if (!stage) return;
    const dragBox = contentBox({ width: stage.width, height: stage.height }, videoDims);
    const startX = e.clientX;
    const startY = e.clientY;
    const startPos = ann.position;
    const startEnd = endpoint;
    const onMove = (ev: PointerEvent) => {
      const dx = (ev.clientX - startX) / dragBox.w;
      const dy = (ev.clientY - startY) / dragBox.h;
      const np = {
        x: Math.max(0, Math.min(1, startPos.x + dx)),
        y: Math.max(0, Math.min(1, startPos.y + dy)),
      };
      const ne = {
        x: Math.max(0, Math.min(1, startEnd.x + dx)),
        y: Math.max(0, Math.min(1, startEnd.y + dy)),
      };
      editor.updateAnnotation(idx, { position: np, endpoint: ne });
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  return (
    <>
      <div
        onPointerDown={startBodyDrag}
        onClick={(e) => {
          e.stopPropagation();
          if (!isSelected) editor.setSelectedIndex(idx);
        }}
        style={{
          position: "absolute",
          left: x0,
          top: y0,
          width: Math.max(0, x1 - x0),
          height: Math.max(0, y1 - y0),
          backdropFilter: `blur(${BLUR_PREVIEW_PX}px)`,
          WebkitBackdropFilter: `blur(${BLUR_PREVIEW_PX}px)`,
          background: "rgba(255,255,255,0.02)",
          outline: isSelected ? "1.5px solid var(--accent)" : "1px dashed rgba(255,255,255,0.5)",
          outlineOffset: isSelected ? 0 : -1,
          cursor: "move",
          pointerEvents: "auto",
        }}
      />
      {isSelected && (
        <>
          <PointHandle x={p0.x} y={p0.y} onPointerDown={startCornerDrag("position")} />
          <PointHandle x={p1.x} y={p1.y} onPointerDown={startCornerDrag("endpoint")} />
        </>
      )}
    </>
  );
}

// Plain-HTML analog of EndpointHandle (which is an SVG <circle> and needs
// an <svg> host) — same size/treatment, usable directly inside the div-
// based BlurAnnotationView.
function PointHandle({
  x,
  y,
  onPointerDown,
}: {
  x: number;
  y: number;
  onPointerDown: (e: React.PointerEvent) => void;
}) {
  return (
    <div
      onPointerDown={onPointerDown}
      style={{
        position: "absolute",
        left: x - 5,
        top: y - 5,
        width: 10,
        height: 10,
        borderRadius: "50%",
        background: "#fff",
        border: "1.5px solid var(--accent)",
        cursor: "grab",
        touchAction: "none",
        pointerEvents: "auto",
      }}
    />
  );
}

function EndpointHandle({
  cx,
  cy,
  onPointerDown,
}: {
  cx: number;
  cy: number;
  onPointerDown: (e: React.PointerEvent) => void;
}) {
  return (
    <circle
      cx={cx}
      cy={cy}
      r={5}
      fill="#fff"
      stroke="var(--accent)"
      strokeWidth={1.5}
      style={{ pointerEvents: "auto", cursor: "grab", touchAction: "none" }}
      onPointerDown={onPointerDown}
    />
  );
}

function ArrowPreview({
  start,
  end,
  stageRef,
  color,
  videoDims,
}: {
  start: Position;
  end: Position;
  stageRef: React.MutableRefObject<HTMLDivElement | null>;
  color: string;
  videoDims: { w: number; h: number } | null;
}) {
  const box = useContentBox(stageRef, videoDims);
  const p1 = toStagePx(start, box);
  const p2 = toStagePx(end, box);
  const markerId = "arrow-preview-head";
  return (
    <svg
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        pointerEvents: "none",
        overflow: "visible",
      }}
    >
      <defs>
        <ArrowMarker id={markerId} fill={color} />
      </defs>
      <line
        x1={p1.x}
        y1={p1.y}
        x2={p2.x}
        y2={p2.y}
        stroke={contrastOutline(color)}
        strokeOpacity="0.85"
        strokeWidth={6}
        strokeLinecap="round"
      />
      <line
        x1={p1.x}
        y1={p1.y}
        x2={p2.x}
        y2={p2.y}
        stroke={color}
        strokeOpacity="0.85"
        strokeWidth={4}
        strokeLinecap="round"
        markerEnd={`url(#${markerId})`}
      />
    </svg>
  );
}

// Live drag preview for the blur tool — a dashed marquee, no blur effect
// applied yet (the actual redaction only renders once the region is
// committed as an annotation). Percentage-based like TextAnnotationView,
// since this is a direct child of the same full-stage AnnotationLayer div.
function BlurPreview({
  start,
  end,
  stageRef,
  videoDims,
}: {
  start: Position;
  end: Position;
  stageRef: React.MutableRefObject<HTMLDivElement | null>;
  videoDims: { w: number; h: number } | null;
}) {
  const box = useContentBox(stageRef, videoDims);
  const p1 = toStagePx(start, box);
  const p2 = toStagePx(end, box);
  return (
    <div
      style={{
        position: "absolute",
        left: Math.min(p1.x, p2.x),
        top: Math.min(p1.y, p2.y),
        width: Math.abs(p2.x - p1.x),
        height: Math.abs(p2.y - p1.y),
        border: "1.5px dashed rgba(255,255,255,0.85)",
        background: "rgba(255,255,255,0.06)",
        pointerEvents: "none",
      }}
    />
  );
}

// Spotlight preview — inverse of BlurAnnotationView: instead of blurring the
// rect, dims everything OUTSIDE it. Same two-point drag model (position +
// endpoint, whole-body drag translates both, corner PointHandles resize),
// same rect math, reused verbatim from BlurAnnotationView's startCornerDrag/
// startBodyDrag shape.
//
// The dim itself is a single CSS box-shadow with a huge spread
// (`0 0 0 9999px`) on the rect div — a standard "spotlight cutout" trick.
// The spread fills everything outside the rect's box with the dim color and
// is naturally clipped by the stage's own `overflow: hidden`, so no second
// full-stage overlay element is needed.
function SpotlightAnnotationView({
  ann,
  idx,
  stageRef,
  editor,
  isSelected,
  videoDims,
}: {
  ann: Annotation;
  idx: number;
  stageRef: React.MutableRefObject<HTMLDivElement | null>;
  editor: Editor;
  isSelected: boolean;
  videoDims: { w: number; h: number } | null;
}) {
  const box = useContentBox(stageRef, videoDims);
  const endpoint = ann.endpoint!;

  const p0 = toStagePx(ann.position, box);
  const p1 = toStagePx(endpoint, box);
  const x0 = Math.min(p0.x, p1.x);
  const y0 = Math.min(p0.y, p1.y);
  const x1 = Math.max(p0.x, p1.x);
  const y1 = Math.max(p0.y, p1.y);

  const startCornerDrag = (which: "position" | "endpoint") => (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (!isSelected) editor.setSelectedIndex(idx);
    const stage = stageRef.current?.getBoundingClientRect();
    if (!stage) return;
    const dragBox = contentBox({ width: stage.width, height: stage.height }, videoDims);
    const onMove = (ev: PointerEvent) => {
      const frac = toContentFrac({ x: ev.clientX - stage.left, y: ev.clientY - stage.top }, dragBox);
      if (which === "position") {
        editor.updateAnnotation(idx, { position: frac });
      } else {
        editor.updateAnnotation(idx, { endpoint: frac });
      }
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const startBodyDrag = (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (!isSelected) editor.setSelectedIndex(idx);
    const stage = stageRef.current?.getBoundingClientRect();
    if (!stage) return;
    const dragBox = contentBox({ width: stage.width, height: stage.height }, videoDims);
    const startX = e.clientX;
    const startY = e.clientY;
    const startPos = ann.position;
    const startEnd = endpoint;
    const onMove = (ev: PointerEvent) => {
      const dx = (ev.clientX - startX) / dragBox.w;
      const dy = (ev.clientY - startY) / dragBox.h;
      const np = {
        x: Math.max(0, Math.min(1, startPos.x + dx)),
        y: Math.max(0, Math.min(1, startPos.y + dy)),
      };
      const ne = {
        x: Math.max(0, Math.min(1, startEnd.x + dx)),
        y: Math.max(0, Math.min(1, startEnd.y + dy)),
      };
      editor.updateAnnotation(idx, { position: np, endpoint: ne });
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  return (
    <>
      <div
        onPointerDown={startBodyDrag}
        onClick={(e) => {
          e.stopPropagation();
          if (!isSelected) editor.setSelectedIndex(idx);
        }}
        style={{
          position: "absolute",
          left: x0,
          top: y0,
          width: Math.max(0, x1 - x0),
          height: Math.max(0, y1 - y0),
          boxShadow: `0 0 0 9999px rgba(0,0,0,${SPOTLIGHT_PREVIEW_DIM_ALPHA})`,
          outline: isSelected ? "1.5px solid var(--accent)" : "1px dashed rgba(255,255,255,0.5)",
          outlineOffset: isSelected ? 0 : -1,
          cursor: "move",
          pointerEvents: "auto",
        }}
      />
      {isSelected && (
        <>
          <PointHandle x={p0.x} y={p0.y} onPointerDown={startCornerDrag("position")} />
          <PointHandle x={p1.x} y={p1.y} onPointerDown={startCornerDrag("endpoint")} />
        </>
      )}
    </>
  );
}

// Live drag preview for the spotlight tool — a dashed marquee, no dim effect
// applied yet, same as BlurPreview (the actual dim only renders once the
// region is committed as an annotation).
function SpotlightPreview({
  start,
  end,
  stageRef,
  videoDims,
}: {
  start: Position;
  end: Position;
  stageRef: React.MutableRefObject<HTMLDivElement | null>;
  videoDims: { w: number; h: number } | null;
}) {
  const box = useContentBox(stageRef, videoDims);
  const p1 = toStagePx(start, box);
  const p2 = toStagePx(end, box);
  return (
    <div
      style={{
        position: "absolute",
        left: Math.min(p1.x, p2.x),
        top: Math.min(p1.y, p2.y),
        width: Math.abs(p2.x - p1.x),
        height: Math.abs(p2.y - p1.y),
        border: "1.5px dashed rgba(255,255,255,0.85)",
        background: "rgba(255,255,255,0.06)",
        pointerEvents: "none",
      }}
    />
  );
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
  editor: Editor;
  thumbnailTime: number | null;
};

function Timeline(props: TimelineProps) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [hover, setHover] = useState<{ time: number; rect: DOMRect } | null>(null);
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

  const onTrackPointerMove = (e: React.PointerEvent) => {
    if (props.duration == null) return;
    const track = trackRef.current;
    if (!track) return;
    const rect = track.getBoundingClientRect();
    setHover({ time: timeAt(e.clientX, rect, props.duration), rect });
  };

  const onTrackPointerLeave = () => setHover(null);

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

        {/* Annotation pips — one per annotation. Dot drags the whole window
            (start+end together, duration preserved); when selected, a
            highlighted band + two edge handles appear so start/end can be
            resized independently — the video content under a blur region
            can shift take-to-take, so the redaction window needs to track
            it rather than staying pinned at its creation-time 3s default. */}
        {props.duration != null &&
          props.editor.annotations.map((ann, idx) => {
            const duration = props.duration as number;
            const mid = (ann.start_time + ann.end_time) / 2;
            const pct = (mid / duration) * 100;
            const startPct = (ann.start_time / duration) * 100;
            const endPct = (ann.end_time / duration) * 100;
            const selected = props.editor.selectedIndex === idx;
            const onPipDown = (e: React.PointerEvent) => {
              e.stopPropagation();
              e.preventDefault();
              props.editor.setSelectedIndex(idx);
              const track = trackRef.current;
              if (!track || props.duration == null) return;
              const rect = track.getBoundingClientRect();
              const startX = e.clientX;
              const startStart = ann.start_time;
              const startEnd = ann.end_time;
              const onMove = (ev: PointerEvent) => {
                const dx = ((ev.clientX - startX) / rect.width) * duration;
                const dur = startEnd - startStart;
                let nextStart = Math.max(0, startStart + dx);
                let nextEnd = nextStart + dur;
                if (nextEnd > duration) {
                  nextEnd = duration;
                  nextStart = nextEnd - dur;
                }
                props.editor.updateAnnotation(idx, {
                  start_time: nextStart,
                  end_time: nextEnd,
                });
              };
              const onUp = () => {
                window.removeEventListener("pointermove", onMove);
                window.removeEventListener("pointerup", onUp);
              };
              window.addEventListener("pointermove", onMove);
              window.addEventListener("pointerup", onUp);
            };
            const onEdgeDown = (side: "start" | "end") => (e: React.PointerEvent) => {
              e.stopPropagation();
              e.preventDefault();
              props.editor.setSelectedIndex(idx);
              const track = trackRef.current;
              if (!track || props.duration == null) return;
              const rect = track.getBoundingClientRect();
              const fixedStart = ann.start_time;
              const fixedEnd = ann.end_time;
              const onMove = (ev: PointerEvent) => {
                const t = ((ev.clientX - rect.left) / rect.width) * duration;
                if (side === "start") {
                  const next = Math.max(0, Math.min(fixedEnd - 0.1, t));
                  props.editor.updateAnnotation(idx, { start_time: next });
                } else {
                  const next = Math.min(duration, Math.max(fixedStart + 0.1, t));
                  props.editor.updateAnnotation(idx, { end_time: next });
                }
              };
              const onUp = () => {
                window.removeEventListener("pointermove", onMove);
                window.removeEventListener("pointerup", onUp);
              };
              window.addEventListener("pointermove", onMove);
              window.addEventListener("pointerup", onUp);
            };
            const label =
              ann.type === "text"
                ? "T"
                : ann.type === "arrow"
                  ? "→"
                  : ann.type === "blur"
                    ? "B"
                    : "S";
            return (
              <div key={idx}>
                {selected && (
                  <div
                    style={{
                      position: "absolute",
                      left: `${startPct}%`,
                      width: `${Math.max(0, endPct - startPct)}%`,
                      top: -2,
                      height: 14,
                      background: "rgba(255,255,255,0.12)",
                      border: "1px solid var(--accent)",
                      borderRadius: 3,
                      pointerEvents: "none",
                    }}
                  />
                )}
                <div
                  onPointerDown={onPipDown}
                  style={{
                    position: "absolute",
                    left: `${pct}%`,
                    top: -2,
                    transform: "translateX(-50%)",
                    cursor: "grab",
                  }}
                >
                  <span
                    style={{
                      display: "inline-block",
                      width: 14,
                      height: 14,
                      borderRadius: 99,
                      background: selected ? "var(--accent)" : "var(--bg-elevated)",
                      border: "1px solid var(--accent)",
                      color: selected ? "#fff" : "var(--accent)",
                      textAlign: "center",
                      lineHeight: "12px",
                      fontSize: 9,
                      fontWeight: 700,
                      fontFamily: "var(--font-system)",
                    }}
                  >
                    {label}
                  </span>
                </div>
                {selected && (
                  <>
                    <AnnotationEdgeHandle pct={startPct} side="start" onPointerDown={onEdgeDown("start")} />
                    <AnnotationEdgeHandle pct={endPct} side="end" onPointerDown={onEdgeDown("end")} />
                  </>
                )}
              </div>
            );
          })}

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

// Per-annotation start/end resize handle — same ew-resize visual language
// as TrimHandle, scaled down to sit at the annotation pip's row instead of
// spanning the full track height.
function AnnotationEdgeHandle({
  pct,
  side,
  onPointerDown,
}: {
  pct: number;
  side: "start" | "end";
  onPointerDown: (e: React.PointerEvent) => void;
}) {
  return (
    <div
      onPointerDown={onPointerDown}
      style={{
        position: "absolute",
        left: `${pct}%`,
        top: -2,
        width: 6,
        height: 14,
        transform: side === "start" ? "translateX(-100%)" : "translateX(0)",
        background: "var(--accent)",
        borderRadius: 2,
        cursor: "ew-resize",
        boxShadow: "0 1px 2px rgba(0,0,0,0.4)",
        touchAction: "none",
      }}
    />
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
// First-run default is export-forward; change DEFAULT_OPEN_SECTION if the
// workflow ranking shifts (e.g. when editing becomes primary).
type SectionId = "annotate" | "export" | "share" | "watermark";
const SECTION_IDS: SectionId[] = ["annotate", "export", "share", "watermark"];
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

function ExportPanel({
  sourcePath,
  editor,
  thumbnail,
  annotationColor,
  onAnnotationColor,
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
  editor: Editor;
  thumbnail: ThumbnailControls;
  annotationColor: string;
  onAnnotationColor: (hex: string) => void;
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

  // Activating a tool (row click or T/A/R/B/S shortcut) auto-expands
  // Annotate so the active-tool highlight is never hidden inside a
  // collapsed section.
  useEffect(() => {
    if (editor.tool != null) openSection("annotate");
  }, [editor.tool, openSection]);

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

  // M opens the popover, expanding Annotate first so the thumbnail row is
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
      openSection("annotate");
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
        mp4Path = await onSave({ format: "mp4", resolution: "source" });
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
          title="Annotate"
          open={openId === "annotate"}
          onToggle={() => toggleSection("annotate")}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {/* Trim row stays (disabled) until timeline trim passes the
                functional checklist — docs/REVIEW-PANEL-CHECKLIST.md. */}
            <ToolRow
              icon={P.edit}
              label="Trim"
              active={false}
              disabled
              title="Trim with the timeline handles below, or press I / O"
            />
            <ToolRow
              icon="M2 13h12M5 10l3-7 3 7M6.5 8h3"
              label="Text"
              kbd="A"
              active={editor.tool === "text"}
              onClick={() => editor.setTool(editor.tool === "text" ? null : "text")}
            />
            <ToolRow
              icon="M3 8h9M9 5l3 3-3 3"
              label="Arrow"
              kbd="R"
              active={editor.tool === "arrow"}
              onClick={() => editor.setTool(editor.tool === "arrow" ? null : "arrow")}
            />
            <ToolRow
              icon="M2 3h12v10H2z M2 3l12 10M14 3L2 13"
              label="Blur"
              kbd="B"
              active={editor.tool === "blur"}
              onClick={() => editor.setTool(editor.tool === "blur" ? null : "blur")}
            />
            <ToolRow
              icon="M8 3a5 5 0 100 10 5 5 0 000-10z M8 0.5v2M8 13.5v2M0.5 8h2M13.5 8h2"
              label="Spotlight"
              kbd="S"
              active={editor.tool === "spotlight"}
              onClick={() => editor.setTool(editor.tool === "spotlight" ? null : "spotlight")}
            />
            <ToolRow
              icon="M5 2h6v11l-3-2.5L5 13z"
              label="Thumbnail"
              kbd="M"
              active={thumbnail.thumbnailTime != null}
              onClick={onThumbnailClick}
            />
            {/* One color for ALL arrows/text on this recording — global,
                not per-annotation. */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                padding: "6px 9px",
              }}
            >
              <span
                style={{
                  flex: 1,
                  fontSize: 12,
                  fontWeight: 500,
                  color: "var(--fg-secondary)",
                }}
              >
                Color
              </span>
              {ANNOTATION_COLORS.map((c) => (
                <button
                  key={c.hex}
                  title={c.name}
                  onClick={() => onAnnotationColor(c.hex)}
                  style={{
                    width: 18,
                    height: 18,
                    borderRadius: "50%",
                    background: c.hex,
                    border:
                      annotationColor === c.hex
                        ? "2px solid var(--accent)"
                        : "1px solid var(--border-default)",
                    cursor: "pointer",
                    padding: 0,
                  }}
                />
              ))}
            </div>
          </div>
          {popoverOpen && capturedTime != null && (
            <ThumbnailPopover
              previewUrl={thumbnail.previewUrl}
              time={capturedTime}
              onUse={useFrame}
              onCancel={() => setPopoverOpen(false)}
            />
          )}
        </Section>

        <Section
          title="Export"
          open={openId === "export"}
          onToggle={() => toggleSection("export")}
        >
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
        </Section>

        <Section
          title="Share"
          open={openId === "share"}
          onToggle={() => toggleSection("share")}
        >
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
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
