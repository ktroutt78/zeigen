import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { emit } from "@tauri-apps/api/event";
import { revealItemInDir, openUrl } from "@tauri-apps/plugin-opener";
import { ask, open } from "@tauri-apps/plugin-dialog";
import { Icon, I, P } from "./components/icons";
import Waveform from "./Waveform";
import ScrubPreview from "./ScrubPreview";

// Review window. Layout mirrors docs/design/surfaces/review.jsx — left
// column is player + timeline + action footer, right column is the Phase
// 6 export panel rendered at full visual fidelity but inert.
//
// Operates against the Phase 5.5 scratch path: Save commits the recording
// to ~/Movies/Zeigen/ (baking edits if any), Discard destroys the scratch
// dir entirely. Both close the window on success.

type Position = { x: number; y: number };

type Annotation = {
  type: "text" | "arrow";
  start_time: number;
  end_time: number;
  position: Position;
  content: string;
  // Text-only: font size in source pixels. Defaults to 36 when absent.
  size?: number;
  // Arrow-only (C5): end point in source-fraction coords + stroke width.
  endpoint?: Position;
  stroke?: number;
};

type Tool = "text" | "arrow" | null;
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
};

const DEFAULT_ARROW_STROKE = 8;
const ARROW_MIN_LENGTH_FRAC = 0.01;

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
};

const EMPTY_STATE: SidecarState = { trim: null, annotations: [], bubble_position_log: [] };
const SIDECAR_DEBOUNCE_MS = 350;
const TRIM_EPS = 0.05;

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
  return normalizeTrim(s.trim, duration) == null && s.annotations.length === 0 && noBubble;
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
  const [error, setError] = useState<string | null>(null);
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
  const [snapshot, setSnapshot] = useState<SidecarState>(EMPTY_STATE);

  const [saving, setSaving] = useState(false);
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
          });
          if (state.trim) setTrim(state.trim);
          if (state.annotations) setAnnotations(state.annotations);
          if (state.bubble_position_log) setBubblePositionLog(state.bubble_position_log);
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
    () => ({ trim: trim ?? null, annotations, bubble_position_log: bubblePositionLog }),
    [trim, annotations, bubblePositionLog],
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
      try {
        const result = await invoke<{ output_path: string }>("save_recording", {
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
        setSaving(false);
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

  // Global keyboard shortcuts: T/A → text tool, R → arrow tool (C5),
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
  }, [showCloseModal, tool, selectedIndex, editingIndex, deleteAnnotation]);

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
    if (trim && v.currentTime >= trim.out - 0.01) {
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

  const seek = useCallback((t: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = Math.max(0, Math.min(duration ?? Infinity, t));
  }, [duration]);

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
          seek={seek}
          trim={trim}
          setTrim={setTrim}
          audioStart={audioStart}
          watermarkPreview={{
            src: wmEffectiveLogo ? convertFileSrc(wmEffectiveLogo) : null,
            corner: wmCorner,
            videoDims,
          }}
          editor={{
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
          }}
        />
        <ExportPanel
          sourcePath={sourcePath}
          lastSavedPath={lastSavedPath}
          committedMp4Path={committedMp4Path}
          lastSavedAt={lastSavedAt}
          duration={duration}
          trim={trim}
          busy={busy}
          saving={saving}
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
  previewFailed,
}: {
  sourceName: string;
  dirty: boolean;
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
  seek: (t: number) => void;
  trim: Trim | null;
  setTrim: React.Dispatch<React.SetStateAction<Trim | null>>;
  audioStart: number | null;
  watermarkPreview: WatermarkPreview;
  editor: Editor;
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
      <Toolbar duration={props.duration} trim={props.trim} editor={props.editor} />
      <VideoStage
        assetUrl={props.playbackUrl}
        videoRef={props.videoRef}
        webcamUrl={props.webcamUrl}
        webcamVideoRef={props.webcamVideoRef}
        webcamLeadSec={props.webcamLeadSec}
        bubblePositionLog={props.bubblePositionLog}
        onLoadedMetadata={props.onLoadedMetadata}
        onTimeUpdate={props.onTimeUpdate}
        onPlay={props.onPlay}
        onPause={props.onPause}
        duration={props.duration}
        currentTime={props.currentTime}
        playing={props.playing}
        togglePlay={props.togglePlay}
        watermarkPreview={props.watermarkPreview}
        editor={props.editor}
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
        audioStart={props.audioStart}
        editor={props.editor}
      />
    </div>
  );
}

function Toolbar({
  duration,
  trim,
  editor,
}: {
  duration: number | null;
  trim: Trim | null;
  editor: Editor;
}) {
  const len =
    trim && duration != null
      ? Math.max(0, trim.out - trim.in)
      : duration != null
      ? duration
      : null;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "10px 14px",
        borderBottom: "1px solid var(--border-faint)",
        color: "var(--fg-secondary)",
        fontSize: 12,
      }}
    >
      <div style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
        <span style={{ color: "var(--fg-primary)", fontWeight: 500, fontSize: 12.5 }}>
          Untitled Recording
        </span>
        <span style={{ color: "var(--fg-tertiary)" }}>·</span>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-tertiary)" }}>
          {fmt(len)} · .mp4
        </span>
      </div>
      <div style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
        <ToolButton icon={P.edit} label="Trim" kbd="T" active={false} disabled />
        <ToolButton
          icon="M2 13h12M5 10l3-7 3 7M6.5 8h3"
          label="Text"
          kbd="A"
          active={editor.tool === "text"}
          onClick={() => editor.setTool(editor.tool === "text" ? null : "text")}
        />
        <ToolButton
          icon="M3 8h9M9 5l3 3-3 3"
          label="Arrow"
          kbd="R"
          active={editor.tool === "arrow"}
          onClick={() => editor.setTool(editor.tool === "arrow" ? null : "arrow")}
        />
      </div>
    </div>
  );
}

function ToolButton({
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
  kbd: string;
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
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "5px 9px",
        height: 26,
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
      <span>{label}</span>
      <span style={{ marginLeft: 4, color: "var(--fg-tertiary)", fontSize: 10.5 }}>{kbd}</span>
    </button>
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
  onLoadedMetadata: () => void;
  onTimeUpdate: () => void;
  onPlay: () => void;
  onPause: () => void;
  duration: number | null;
  currentTime: number;
  playing: boolean;
  togglePlay: () => void;
  watermarkPreview: WatermarkPreview;
  editor: Editor;
};

function VideoStage(props: VideoStageProps) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [drawingArrow, setDrawingArrow] = useState<{
    start: Position;
    end: Position;
  } | null>(null);

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
    const xFrac = (e.clientX - rect.left) / rect.width;
    const yFrac = (e.clientY - rect.top) / rect.height;
    if (xFrac < 0 || xFrac > 1 || yFrac < 0 || yFrac > 1) return;
    props.editor.placeTextAt(xFrac, yFrac);
  };

  const onStagePointerDown = (e: React.PointerEvent) => {
    if (props.editor.tool !== "arrow") return;
    if ((e.target as HTMLElement).dataset.stageBg !== "1") return;
    e.preventDefault();
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect) return;
    const startX = (e.clientX - rect.left) / rect.width;
    const startY = (e.clientY - rect.top) / rect.height;
    if (startX < 0 || startX > 1 || startY < 0 || startY > 1) return;
    const start = { x: startX, y: startY };
    setDrawingArrow({ start, end: start });
    const onMove = (ev: PointerEvent) => {
      const r = stageRef.current?.getBoundingClientRect();
      if (!r) return;
      const ex = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
      const ey = Math.max(0, Math.min(1, (ev.clientY - r.top) / r.height));
      setDrawingArrow({ start, end: { x: ex, y: ey } });
    };
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      const r = stageRef.current?.getBoundingClientRect();
      if (!r) {
        setDrawingArrow(null);
        return;
      }
      const ex = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
      const ey = Math.max(0, Math.min(1, (ev.clientY - r.top) / r.height));
      const dx = ex - start.x;
      const dy = ey - start.y;
      const lenFrac = Math.sqrt(dx * dx + dy * dy);
      setDrawingArrow(null);
      if (lenFrac < ARROW_MIN_LENGTH_FRAC) return;
      props.editor.placeArrow(start, { x: ex, y: ey });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const cursor =
    props.editor.tool === "text" || props.editor.tool === "arrow" ? "crosshair" : "default";

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
          videoDims={props.watermarkPreview.videoDims}
        />
        <AnnotationLayer
          stageRef={stageRef}
          videoRef={props.videoRef}
          editor={props.editor}
          currentTime={props.currentTime}
          drawingArrow={drawingArrow}
        />
        <PlayerOverlay
          playing={props.playing}
          duration={props.duration}
          currentTime={props.currentTime}
          togglePlay={props.togglePlay}
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
  videoDims,
}: {
  stageRef: React.MutableRefObject<HTMLDivElement | null>;
  screenVideoRef: React.MutableRefObject<HTMLVideoElement | null>;
  webcamVideoRef: React.MutableRefObject<HTMLVideoElement | null>;
  webcamUrl: string | null;
  webcamLeadSec: number;
  bubblePositionLog: BubblePositionEntry[];
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
      align();
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

    // Letterbox math identical to WatermarkPreviewLayer — bubble lives
    // inside the video content box, not the stage box. Stable per effect
    // run; deps include stage size + videoDims so resize re-runs the
    // effect with fresh values.
    const { w: vw, h: vh } = videoDims;
    const videoAspect = vw / vh;
    const stageAspect = stage.width / stage.height;
    let cw: number;
    let ch: number;
    if (videoAspect > stageAspect) {
      cw = stage.width;
      ch = stage.width / videoAspect;
    } else {
      ch = stage.height;
      cw = stage.height * videoAspect;
    }
    const cx = (stage.width - cw) / 2;
    const cy = (stage.height - ch) / 2;

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
        position: "absolute",
        left: 0,
        top: 0,
        borderRadius: "50%",
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
  const { w: vw, h: vh } = preview.videoDims;
  const videoAspect = vw / vh;
  const stageAspect = stage.width / stage.height;
  let cw: number;
  let ch: number;
  if (videoAspect > stageAspect) {
    cw = stage.width;
    ch = stage.width / videoAspect;
  } else {
    ch = stage.height;
    cw = stage.height * videoAspect;
  }
  const cx = (stage.width - cw) / 2;
  const cy = (stage.height - ch) / 2;

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
  currentTime,
  drawingArrow,
}: {
  stageRef: React.MutableRefObject<HTMLDivElement | null>;
  videoRef: React.MutableRefObject<HTMLVideoElement | null>;
  editor: Editor;
  currentTime: number;
  drawingArrow: { start: Position; end: Position } | null;
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
        if (!visible && !isSelected && !isEditing) return null;
        if (ann.type === "text") {
          return (
            <TextAnnotationView
              key={idx}
              ann={ann}
              idx={idx}
              stageRef={stageRef}
              videoRef={videoRef}
              editor={editor}
              isSelected={isSelected}
              isEditing={isEditing}
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
              isSelected={isSelected}
            />
          );
        }
        return null;
      })}
      {drawingArrow && <ArrowPreview start={drawingArrow.start} end={drawingArrow.end} />}
    </div>
  );
}

function TextAnnotationView({
  ann,
  idx,
  stageRef,
  videoRef,
  editor,
  isSelected,
  isEditing,
}: {
  ann: Annotation;
  idx: number;
  stageRef: React.MutableRefObject<HTMLDivElement | null>;
  videoRef: React.MutableRefObject<HTMLVideoElement | null>;
  editor: Editor;
  isSelected: boolean;
  isEditing: boolean;
}) {
  const bodyRef = useRef<HTMLDivElement | null>(null);

  // Compute font size in CSS pixels: source-pixel size scaled by display
  // height vs source video height. Falls back to a 1:1 mapping until video
  // metadata is known.
  const sourceHeight = videoRef.current?.videoHeight || 0;
  const stageHeight = stageRef.current?.getBoundingClientRect().height || 0;
  const scale = sourceHeight && stageHeight ? stageHeight / sourceHeight : 1;
  const sizeSrc = ann.size ?? DEFAULT_TEXT_SIZE;
  const sizeCss = sizeSrc * scale;

  const startBodyDrag = (e: React.PointerEvent) => {
    e.stopPropagation();
    if (isEditing) return;
    if (!isSelected) {
      editor.setSelectedIndex(idx);
    }
    const stage = stageRef.current?.getBoundingClientRect();
    if (!stage) return;
    const startX = e.clientX;
    const startY = e.clientY;
    const startPos = ann.position;
    const onMove = (ev: PointerEvent) => {
      const dx = (ev.clientX - startX) / stage.width;
      const dy = (ev.clientY - startY) / stage.height;
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
        left: `${ann.position.x * 100}%`,
        top: `${ann.position.y * 100}%`,
        padding: `${Math.max(3, sizeCss * 0.15)}px ${Math.max(6, sizeCss * 0.3)}px`,
        background: "rgba(20,20,22,0.86)",
        color: "#fff",
        borderRadius: Math.max(3, sizeCss * 0.15),
        border: "0.5px solid rgba(255,255,255,0.18)",
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

function ArrowMarker({ id }: { id: string }) {
  return (
    <marker
      id={id}
      markerWidth="6"
      markerHeight="6"
      refX="5.5"
      refY="3"
      orient="auto"
      markerUnits="strokeWidth"
    >
      <path d="M0,0 L6,3 L0,6 z" fill="#fff" />
    </marker>
  );
}

function ArrowAnnotationView({
  ann,
  idx,
  stageRef,
  editor,
  isSelected,
}: {
  ann: Annotation;
  idx: number;
  stageRef: React.MutableRefObject<HTMLDivElement | null>;
  editor: Editor;
  isSelected: boolean;
}) {
  const stageSize = useStageSize(stageRef);
  const endpoint = ann.endpoint!;
  const stroke = ann.stroke ?? DEFAULT_ARROW_STROKE;

  // Display stroke: scale source px to CSS px using stage height as a proxy
  // (we don't always know source dims here). At common sizes this is close
  // enough for preview; saved arrow PNG uses the same source-px stroke.
  const strokeCss = Math.max(2, Math.min(8, stroke * 0.35));
  const markerId = `arrow-head-${idx}`;

  const sx = ann.position.x * stageSize.width;
  const sy = ann.position.y * stageSize.height;
  const ex = endpoint.x * stageSize.width;
  const ey = endpoint.y * stageSize.height;

  const startEndpointDrag = (which: "start" | "end") => (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (!isSelected) editor.setSelectedIndex(idx);
    const stage = stageRef.current?.getBoundingClientRect();
    if (!stage) return;
    const onMove = (ev: PointerEvent) => {
      const fx = Math.max(0, Math.min(1, (ev.clientX - stage.left) / stage.width));
      const fy = Math.max(0, Math.min(1, (ev.clientY - stage.top) / stage.height));
      if (which === "start") {
        editor.updateAnnotation(idx, { position: { x: fx, y: fy } });
      } else {
        editor.updateAnnotation(idx, { endpoint: { x: fx, y: fy } });
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
    const startX = e.clientX;
    const startY = e.clientY;
    const startPos = ann.position;
    const startEnd = endpoint;
    const onMove = (ev: PointerEvent) => {
      const dx = (ev.clientX - startX) / stage.width;
      const dy = (ev.clientY - startY) / stage.height;
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
        <ArrowMarker id={markerId} />
      </defs>
      {/* Visible shaft */}
      <line
        x1={sx}
        y1={sy}
        x2={ex}
        y2={ey}
        stroke="#fff"
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

function ArrowPreview({ start, end }: { start: Position; end: Position }) {
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
        <ArrowMarker id={markerId} />
      </defs>
      <line
        x1={`${start.x * 100}%`}
        y1={`${start.y * 100}%`}
        x2={`${end.x * 100}%`}
        y2={`${end.y * 100}%`}
        stroke="#fff"
        strokeOpacity="0.85"
        strokeWidth={4}
        strokeLinecap="round"
        markerEnd={`url(#${markerId})`}
      />
    </svg>
  );
}

function PlayerOverlay({
  playing,
  duration,
  currentTime,
  togglePlay,
}: {
  playing: boolean;
  duration: number | null;
  currentTime: number;
  togglePlay: () => void;
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
  audioStart: number | null;
  editor: Editor;
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

  const startHandleDrag = useCallback(
    (side: "in" | "out") => (e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const track = trackRef.current;
      if (!track || props.duration == null) return;
      const rect = track.getBoundingClientRect();
      const move = (clientX: number) => {
        const t = ((clientX - rect.left) / rect.width) * (props.duration as number);
        props.setTrim((prev) => {
          if (!prev || props.duration == null) return prev;
          if (side === "in") {
            const next = Math.max(0, Math.min(prev.out - 0.1, t));
            return { in: next, out: prev.out };
          } else {
            const next = Math.min(props.duration, Math.max(prev.in + 0.1, t));
            return { in: prev.in, out: next };
          }
        });
      };
      const onMove = (ev: PointerEvent) => move(ev.clientX);
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
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
      }
      if (movedPastThreshold) seekAt(ev.clientX);
      setHover({ time: timeAt(ev.clientX, rect, duration), rect });
    };
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      if (!movedPastThreshold) seekAt(ev.clientX);
      else if (wasPlaying) props.videoRef.current?.play().catch(() => {});
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

        {/* Annotation pips — one per annotation, drag to shift in time */}
        {props.duration != null &&
          props.editor.annotations.map((ann, idx) => {
            const mid = (ann.start_time + ann.end_time) / 2;
            const pct = (mid / (props.duration as number)) * 100;
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
                const dx = ((ev.clientX - startX) / rect.width) * (props.duration as number);
                const dur = startEnd - startStart;
                let nextStart = Math.max(0, startStart + dx);
                let nextEnd = nextStart + dur;
                if (nextEnd > (props.duration as number)) {
                  nextEnd = props.duration as number;
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
            const label = ann.type === "text" ? "T" : "→";
            return (
              <div
                key={idx}
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
            );
          })}

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

function ExportPanel({
  sourcePath,
  lastSavedPath,
  committedMp4Path,
  lastSavedAt,
  duration,
  trim,
  busy,
  saving,
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
  lastSavedPath: string | null;
  committedMp4Path: string | null;
  lastSavedAt: number;
  duration: number | null;
  trim: Trim | null;
  busy: boolean;
  saving: boolean;
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
        overflowY: "auto",
      }}
    >
      {/* SAVE block */}
      <div style={{ padding: "12px 14px 8px" }}>
        <span
          style={{
            fontSize: 10.5,
            color: "var(--fg-tertiary)",
            letterSpacing: "0.06em",
            textTransform: "uppercase",
            fontWeight: 600,
          }}
        >
          Save
        </span>
      </div>

      <div style={{ padding: "0 14px 12px" }}>
        <ChipsRow label="Format">
          <div className="segmented">
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
        </ChipsRow>

        {format === "mp4" ? (
          <ChipsRow label="Resolution">
            <div className="segmented">
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
          </ChipsRow>
        ) : (
          <ChipsRow label="Resolution">
            <div className="segmented">
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
          </ChipsRow>
        )}

        {format === "gif" && (
          <ChipsRow label="FPS">
            <div className="segmented">
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
          </ChipsRow>
        )}

        <button
          onClick={onSaveClick}
          disabled={saveDisabled}
          className="btn-primary"
          style={{
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
          {justSaved ? (
            <>
              <Icon d={P.check} size={13} stroke={1.8} />
              <span>Saved</span>
            </>
          ) : saving ? (
            <span>Saving…</span>
          ) : (
            <>
              <Icon d={P.check} size={13} stroke={1.6} />
              <span>Save as {formatLabel}</span>
            </>
          )}
        </button>
      </div>

      <div className="hairline" style={{ margin: "0 14px" }} />

      {/* WATERMARK block */}
      <div style={{ padding: "10px 14px 6px" }}>
        <span
          style={{
            fontSize: 10.5,
            color: "var(--fg-tertiary)",
            letterSpacing: "0.06em",
            textTransform: "uppercase",
            fontWeight: 600,
          }}
        >
          Watermark
        </span>
      </div>

      <div style={{ padding: "0 14px 12px", display: "flex", flexDirection: "column", gap: 8 }}>
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
            <ChipsRow label="Corner">
              <div className="segmented">
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
            </ChipsRow>
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

      <div className="hairline" style={{ margin: "0 14px" }} />

      {/* OR EXPORT TO… block */}
      <div style={{ padding: "10px 14px 6px" }}>
        <span
          style={{
            fontSize: 10.5,
            color: "var(--fg-tertiary)",
            letterSpacing: "0.06em",
            textTransform: "uppercase",
            fontWeight: 600,
          }}
        >
          Or export to…
        </span>
      </div>

      <div style={{ padding: "0 12px 10px", display: "flex", flexDirection: "column", gap: 6 }}>
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

      <div className="hairline" style={{ margin: "0 14px" }} />

      {/* Lifecycle block */}
      <div
        style={{
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

      <div style={{ flex: 1 }} />
    </div>
  );
}

function ChipsRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 8,
        marginBottom: 6,
      }}
    >
      <span style={{ fontSize: 11.5, color: "var(--fg-secondary)" }}>{label}</span>
      {children}
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
