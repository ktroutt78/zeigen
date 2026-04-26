import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { emit } from "@tauri-apps/api/event";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { Icon, I, P } from "./components/icons";

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

type SidecarState = {
  trim?: Trim | null;
  annotations: Annotation[];
};

const EMPTY_STATE: SidecarState = { trim: null, annotations: [] };
const SIDECAR_DEBOUNCE_MS = 350;
const TRIM_EPS = 0.05;

function readParams(): { path: string | null } {
  const hash = window.location.hash || "";
  const q = hash.indexOf("?");
  if (q < 0) return { path: null };
  const params = new URLSearchParams(hash.slice(q + 1));
  return { path: params.get("path") };
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

function isLogicallyEmpty(s: SidecarState, duration: number | null): boolean {
  return normalizeTrim(s.trim, duration) == null && s.annotations.length === 0;
}

export default function Review() {
  const [params] = useState(() => readParams());
  const sourcePath = params.path;
  const assetUrl = useMemo(
    () => (sourcePath ? convertFileSrc(sourcePath) : null),
    [sourcePath],
  );

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [duration, setDuration] = useState<number | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Edit state.
  const [trim, setTrim] = useState<Trim | null>(null);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [snapshot, setSnapshot] = useState<SidecarState>(EMPTY_STATE);

  const [saving, setSaving] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [showCloseModal, setShowCloseModal] = useState(false);
  const busy = saving || discarding;

  // Tracks the post-commit final path. Mirrored as a ref so saveRecording
  // can short-circuit synchronously without re-running the commit pipeline.
  // Phase 6 export rows read this state to decide whether they're enabled.
  const [committedPath, setCommittedPath] = useState<string | null>(null);
  const committedPathRef = useRef<string | null>(null);

  // In-flight promise for an active commit_recording call. Concurrent
  // saveRecording invocations (e.g., footer Save clicked twice before the
  // disabled state propagates through React render) share this promise so
  // commit_recording runs exactly once per scratch. Without this, the first
  // call moves scratch → final and the second hits canonicalize on the
  // now-missing scratch path.
  const saveInFlightRef = useRef<Promise<string | null> | null>(null);

  // Annotation editing state.
  const [tool, setTool] = useState<Tool>(null);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);

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
          setSnapshot({ trim: state.trim ?? null, annotations: state.annotations ?? [] });
          if (state.trim) setTrim(state.trim);
          if (state.annotations) setAnnotations(state.annotations);
        } else {
          setSnapshot(EMPTY_STATE);
        }
      })
      .catch((err) => setError(`read sidecar: ${err}`));
    return () => {
      cancelled = true;
    };
  }, [sourcePath]);

  // Initialize trim once duration is known and no sidecar trim was present.
  useEffect(() => {
    if (duration == null) return;
    setTrim((prev) => prev ?? { in: 0, out: duration });
  }, [duration]);

  const currentState: SidecarState = useMemo(
    () => ({ trim: trim ?? null, annotations }),
    [trim, annotations],
  );

  const dirty = useMemo(
    () => !statesEqual(currentState, snapshot, duration),
    [currentState, snapshot, duration],
  );

  // Debounced sidecar persistence on edit. Empty states are deleted to keep
  // the sources area tidy; non-empty states are written.
  useEffect(() => {
    if (!sourcePath || duration == null) return;
    const empty = isLogicallyEmpty(currentState, duration);
    const handle = window.setTimeout(() => {
      const norm: SidecarState = {
        trim: normalizeTrim(currentState.trim, duration),
        annotations: currentState.annotations,
      };
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

  // Commit the scratch recording to ~/Movies/Zeigen/. Edits in the current
  // sidecar (trim + annotations) are baked at move time via the same ffmpeg
  // pass that used to live behind "Save edits"; if there are no edits, the
  // backend skips ffmpeg and renames the scratch mp4 to its final home.
  // Either way the scratch directory is removed on success. Returns the
  // final path on success, null on failure. Sets committedPath state which
  // gates the Phase 6 export rows.
  const saveRecording = useCallback((): Promise<string | null> => {
    // Idempotent: once committed, every subsequent call returns the cached
    // final path. Guards against re-invoking commit_recording on the
    // now-stale scratch path (would fail canonicalize ENOENT).
    if (committedPathRef.current) return Promise.resolve(committedPathRef.current);
    if (saveInFlightRef.current) return saveInFlightRef.current;
    if (!sourcePath) return Promise.resolve(null);
    const promise = (async () => {
      setSaving(true);
      try {
        const norm: SidecarState = {
          trim: normalizeTrim(currentState.trim, duration),
          annotations: currentState.annotations,
        };
        const outPath = await invoke<string>("commit_recording", {
          scratchMp4Path: sourcePath,
          sidecar: norm,
        });
        // Notify main so its post-finalize toast updates from the now-stale
        // scratch path to the actual final ~/Movies/Zeigen/recording-….mp4.
        await emit("recording-committed", { final_path: outPath }).catch(() => {});
        committedPathRef.current = outPath;
        setCommittedPath(outPath);
        return outPath;
      } catch (err) {
        setError(`save recording: ${err}`);
        return null;
      } finally {
        setSaving(false);
        saveInFlightRef.current = null;
      }
    })();
    saveInFlightRef.current = promise;
    return promise;
  }, [sourcePath, currentState, duration]);

  // proceedingRef gates the close-requested handler so an in-flight
  // close (which we drive explicitly via destroy()) doesn't re-enter.
  const proceedingRef = useRef(false);

  // iPhone-screenshot semantics: every "this recording is going away"
  // event — footer Discard, close window, "Record another" — runs the
  // same cleanup. discard_recording on the Rust side is idempotent:
  // skips scratch removal if the dir is already gone (post-Save) and
  // always cleans the matching exports temp dir.
  const cleanupScratchAndExports = useCallback(async () => {
    if (saveInFlightRef.current) {
      try { await saveInFlightRef.current; } catch {}
    }
    if (!sourcePath) return;
    try {
      await invoke("discard_recording", { scratchMp4Path: sourcePath });
      // Tell main so its post-finalize toast clears.
      await emit("recording-discarded").catch(() => {});
    } catch (err) {
      console.error("cleanup failed:", err);
    }
  }, [sourcePath]);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    (async () => {
      const win = getCurrentWebviewWindow();
      const fn = await win.onCloseRequested(async (event) => {
        if (proceedingRef.current) return; // already greenlit
        event.preventDefault();
        // Already saved → silent close. The cache temp dir still needs
        // cleanup but the user has nothing to lose.
        if (committedPathRef.current) {
          proceedingRef.current = true;
          await cleanupScratchAndExports();
          await win.destroy().catch((err) => {
            proceedingRef.current = false;
            setError(`close: ${err}`);
          });
          return;
        }
        // Uncommitted → red X is an ambiguous gesture. Prompt for an
        // explicit choice. Footer Discard remains direct (no modal)
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

  // Footer Discard: instant cleanup + close. iPhone-screenshot semantics
  // — no confirm modal. The user explicitly chose discard; they meant it.
  const onFooterDiscard = useCallback(async () => {
    setDiscarding(true);
    try {
      await cleanupScratchAndExports();
      await closeWindow();
    } finally {
      setDiscarding(false);
    }
  }, [cleanupScratchAndExports, closeWindow]);

  // Footer Save commits the scratch but does NOT close the window. The
  // user can now reach the export rows (Copy, LinkedIn) on the final
  // file, plus the inline Reveal affordance next to the "Saved" button.
  const onFooterSave = useCallback(async () => {
    await saveRecording();
  }, [saveRecording]);

  // Footer Reveal — only shown post-Save. Reveals the final mp4 in Finder.
  const onFooterReveal = useCallback(async () => {
    if (!committedPath) return;
    try {
      await revealItemInDir(committedPath);
    } catch (err) {
      setError(`reveal in Finder: ${err}`);
    }
  }, [committedPath]);

  // Record another: same cleanup as Discard, then emit so main kicks
  // off a fresh capture, then close.
  const onFooterRecordAnother = useCallback(async () => {
    setDiscarding(true);
    try {
      await cleanupScratchAndExports();
      await fireRecordAnother();
      await closeWindow();
    } finally {
      setDiscarding(false);
    }
  }, [cleanupScratchAndExports, fireRecordAnother, closeWindow]);

  // Close-modal handlers (red X on uncommitted recording). Mirror the
  // footer buttons but each path also closes the window on success.
  const onModalSave = useCallback(async () => {
    const out = await saveRecording();
    if (out) {
      setShowCloseModal(false);
      // Save commits the scratch; cleanupScratchAndExports then runs an
      // idempotent discard_recording (no-op for scratch, cleans the
      // exports cache dir).
      await cleanupScratchAndExports();
      await closeWindow();
    } else {
      // Save failed; surface the error and let the user retry/discard.
      setShowCloseModal(false);
    }
  }, [saveRecording, cleanupScratchAndExports, closeWindow]);

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
  const primedRef = useRef(false);
  const primeFirstFrame = useCallback(() => {
    const v = videoRef.current;
    if (!v || primedRef.current) return;
    primedRef.current = true;
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
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        background: "var(--bg-window)",
        color: "var(--fg-primary)",
        fontFamily: "var(--font-system)",
      }}
    >
      <Header sourceName={sourceName} dirty={dirty} />
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
          onFooterDiscard={onFooterDiscard}
          onFooterSave={onFooterSave}
          onFooterRecordAnother={onFooterRecordAnother}
          onFooterReveal={onFooterReveal}
          saving={saving}
          busy={busy}
          committed={committedPath != null}
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
          committedPath={committedPath}
          busy={busy}
          setError={setError}
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

function Header({ sourceName, dirty }: { sourceName: string; dirty: boolean }) {
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
    </div>
  );
}

type LeftColumnProps = {
  assetUrl: string | null;
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
  onFooterDiscard: () => void;
  onFooterSave: () => Promise<void> | void;
  onFooterRecordAnother: () => Promise<void> | void;
  onFooterReveal: () => Promise<void> | void;
  saving: boolean;
  busy: boolean;
  committed: boolean;
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
      }}
    >
      <Toolbar duration={props.duration} trim={props.trim} editor={props.editor} />
      <VideoStage
        assetUrl={props.assetUrl}
        videoRef={props.videoRef}
        onLoadedMetadata={props.onLoadedMetadata}
        onTimeUpdate={props.onTimeUpdate}
        onPlay={props.onPlay}
        onPause={props.onPause}
        duration={props.duration}
        currentTime={props.currentTime}
        playing={props.playing}
        togglePlay={props.togglePlay}
        editor={props.editor}
      />
      <Timeline
        duration={props.duration}
        currentTime={props.currentTime}
        trim={props.trim}
        setTrim={props.setTrim}
        seek={props.seek}
        editor={props.editor}
      />
      <ActionFooter
        onDiscard={props.onFooterDiscard}
        onSave={props.onFooterSave}
        onRecordAnother={props.onFooterRecordAnother}
        onReveal={props.onFooterReveal}
        saving={props.saving}
        busy={props.busy}
        committed={props.committed}
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
  onLoadedMetadata: () => void;
  onTimeUpdate: () => void;
  onPlay: () => void;
  onPause: () => void;
  duration: number | null;
  currentTime: number;
  playing: boolean;
  togglePlay: () => void;
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
    <div style={{ position: "relative", padding: 16, background: "#0c0d10", flex: 1 }}>
      <div
        ref={stageRef}
        onClick={onStageClick}
        onPointerDown={onStagePointerDown}
        data-stage-bg="1"
        style={{
          position: "relative",
          aspectRatio: "16 / 9",
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
      </div>
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
  duration: number | null;
  currentTime: number;
  trim: Trim | null;
  setTrim: React.Dispatch<React.SetStateAction<Trim | null>>;
  seek: (t: number) => void;
  editor: Editor;
};

function Timeline(props: TimelineProps) {
  const trackRef = useRef<HTMLDivElement | null>(null);

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

  const onTrackClick = (e: React.MouseEvent) => {
    if (props.duration == null) return;
    const track = trackRef.current;
    if (!track) return;
    const rect = track.getBoundingClientRect();
    const t = ((e.clientX - rect.left) / rect.width) * props.duration;
    props.seek(t);
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
        onClick={onTrackClick}
        style={{ position: "relative", height: 44, marginTop: 6, cursor: "pointer" }}
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
            background:
              "repeating-linear-gradient(90deg," +
              "#3a2e36 0 8%, #4a3c44 8% 16%, #3f3138 16% 24%, #4d3f47 24% 32%," +
              "#37292f 32% 40%, #443840 40% 48%, #3c2e34 48% 56%, #50404a 56% 64%," +
              "#3d2f37 64% 72%, #463842 72% 80%, #392c33 80% 88%, #4a3c46 88% 100%)",
          }}
        >
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

function ActionFooter({
  onDiscard,
  onSave,
  onRecordAnother,
  onReveal,
  saving,
  busy,
  committed,
}: {
  onDiscard: () => Promise<void> | void;
  onSave: () => Promise<void> | void;
  onRecordAnother: () => Promise<void> | void;
  onReveal: () => Promise<void> | void;
  saving: boolean;
  busy: boolean;
  committed: boolean;
}) {
  // Save bakes & moves the scratch out; Discard destroys it. After commit
  // both targets are gone — disable both. Record another always works.
  // Post-commit the right side splits into a "Saved" status pseudo-button
  // and a Reveal-in-Finder action button.
  const recordAnotherEnabled = !busy;
  const scratchOpsEnabled = !busy && !committed;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "10px 16px",
        borderTop: "1px solid var(--border-faint)",
        background: "rgba(255,255,255,0.012)",
      }}
    >
      <div style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
        <button
          onClick={() => onRecordAnother()}
          disabled={!recordAnotherEnabled}
          className="btn-secondary"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            padding: "6px 12px",
            borderRadius: 6,
            height: 30,
            fontFamily: "var(--font-system)",
            fontSize: 12.5,
            fontWeight: 500,
            cursor: recordAnotherEnabled ? "pointer" : "not-allowed",
            opacity: recordAnotherEnabled ? 1 : 0.5,
          }}
        >
          <Icon d={P.play} size={11} stroke={0} fill="currentColor" />
          <span>Record another</span>
        </button>
        <button
          onClick={() => onDiscard()}
          disabled={!scratchOpsEnabled}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            background: "transparent",
            border: "1px solid transparent",
            color: "var(--recording-tint)",
            padding: "6px 12px",
            borderRadius: 6,
            height: 30,
            cursor: scratchOpsEnabled ? "pointer" : "not-allowed",
            fontFamily: "var(--font-system)",
            fontSize: 12.5,
            fontWeight: 500,
            opacity: scratchOpsEnabled ? 1 : 0.5,
          }}
        >
          {I.trash}
          <span>Discard recording</span>
        </button>
      </div>
      {committed ? (
        <div style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "6px 12px",
              height: 30,
              borderRadius: 6,
              fontSize: 12.5,
              fontWeight: 500,
              color: "var(--success-tint)",
            }}
          >
            <Icon d={P.check} size={13} stroke={1.8} />
            <span>Saved</span>
          </span>
          <button
            onClick={() => onReveal()}
            disabled={busy}
            className="btn-secondary"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "6px 12px",
              borderRadius: 6,
              height: 30,
              fontSize: 12.5,
              fontWeight: 500,
              cursor: busy ? "not-allowed" : "pointer",
              opacity: busy ? 0.5 : 1,
            }}
          >
            {I.finder}
            <span>Reveal</span>
          </button>
        </div>
      ) : (
        <button
          onClick={() => onSave()}
          disabled={!scratchOpsEnabled}
          className="btn-primary"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            padding: "6px 14px",
            borderRadius: 6,
            height: 30,
            fontSize: 12.5,
            fontWeight: 600,
            letterSpacing: "-0.005em",
            opacity: scratchOpsEnabled ? 1 : 0.6,
            cursor: scratchOpsEnabled ? "pointer" : "not-allowed",
          }}
        >
          <Icon d={P.check} size={13} stroke={1.6} />
          <span>{saving ? "Saving…" : "Save recording"}</span>
        </button>
      )}
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
          This recording hasn't been saved yet. Saving moves it to ~/Movies/Zeigen.
          Discarding deletes it.
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

function ExportPanel({
  sourcePath,
  committedPath,
  busy,
  setError,
}: {
  sourcePath: string | null;
  committedPath: string | null;
  busy: boolean;
  setError: (msg: string | null) => void;
}) {
  // Effective source is the committed final path when it exists, else
  // the scratch path. Copy and LinkedIn read whichever is current — they
  // don't care about save state under the new architecture.
  const effectiveSource = committedPath || sourcePath;

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
    if (!effectiveSource) return;
    const stamp = parseStampFromPath(effectiveSource);
    if (!stamp) {
      setError(`copy to clipboard: cannot parse stamp from ${effectiveSource}`);
      return;
    }
    try {
      await invoke("clipboard_copy_recording", { stamp, sourcePath: effectiveSource });
      setCopiedAt(Date.now());
    } catch (err) {
      setError(`copy to clipboard: ${err}`);
    }
  }, [effectiveSource, setError]);

  // ⌘C shortcut mirrors the row click. Skip when the user has a
  // selection or is focused on an editable element so the system's
  // default text-copy behavior wins.
  useEffect(() => {
    if (!effectiveSource || busy) return;
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey || e.shiftKey || e.altKey || e.ctrlKey) return;
      if (e.key.toLowerCase() !== "c") return;
      const target = e.target as HTMLElement | null;
      if (target?.isContentEditable) return;
      if (target?.tagName === "INPUT" || target?.tagName === "TEXTAREA") return;
      const sel = window.getSelection();
      if (sel && sel.toString().length > 0) return;
      e.preventDefault();
      onCopyClipboard();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [effectiveSource, busy, onCopyClipboard]);

  return (
    <div style={{ display: "flex", flexDirection: "column", background: "var(--bg-sidebar)" }}>
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
          Export
        </span>
      </div>

      <div style={{ padding: "0 12px 8px", display: "flex", flexDirection: "column", gap: 6 }}>
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
          disabled={!effectiveSource || busy}
        />
        <DestRow
          icon={<Icon d="M2.5 5h11v9h-11zM5 8.5v3M5 6.5h.01M7.5 11.5v-3c0-.8.7-1.5 1.5-1.5s1.5.7 1.5 1.5v3M10.5 11.5v-3" size={13} stroke={1.4} />}
          title="Export for LinkedIn"
          sub="MP4 · ≤ 10 min · 1080p capped"
          kbd={<span style={{ fontSize: 10, color: "var(--fg-quaternary)", fontWeight: 600, letterSpacing: "0.04em", textTransform: "uppercase" }}>Soon</span>}
          disabled
        />
      </div>

      <div className="hairline" style={{ margin: "6px 14px" }} />

      <div
        aria-hidden="true"
        style={{
          opacity: 0.4,
          pointerEvents: "none",
          padding: "6px 14px 10px",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            justifyContent: "space-between",
            gap: 8,
            marginBottom: 8,
          }}
        >
          <span
            style={{
              fontSize: 10.5,
              color: "var(--fg-tertiary)",
              letterSpacing: "0.06em",
              textTransform: "uppercase",
              fontWeight: 600,
            }}
          >
            Quick export
          </span>
          <span
            style={{
              fontSize: 10,
              color: "var(--fg-quaternary)",
              letterSpacing: "0.04em",
              textTransform: "uppercase",
              fontWeight: 600,
            }}
          >
            Coming later
          </span>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          {["MP4", "GIF", "ProRes"].map((f) => (
            <button
              key={f}
              className="btn-secondary"
              style={{ flex: 1, fontSize: 12, padding: "6px 0", height: 28 }}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      <div style={{ flex: 1 }} />
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
