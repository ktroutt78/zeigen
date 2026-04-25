import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { Icon, I, P } from "./components/icons";

// Phase 5 review window. Layout mirrors docs/design/surfaces/review.jsx —
// left column is player + timeline + action footer, right column is the
// Phase 6 export panel rendered at full visual fidelity but inert.
//
// C2 adds the player (HTML5 <video> via asset://), trim handles with loop
// playback within [trimIn, trimOut], sidecar JSON read/write with
// snapshot-on-open, and the Save/Discard/Cancel close prompt with default
// Discard. Save edits is a stub here — C3 wires ffmpeg.

type Position = { x: number; y: number };

type Annotation = {
  type: "text" | "arrow";
  start_time: number;
  end_time: number;
  position: Position;
  content: string;
};

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
  const [hadInitialSidecar, setHadInitialSidecar] = useState(false);

  const [showCloseModal, setShowCloseModal] = useState(false);
  const [saving, setSaving] = useState(false);

  const sourceName = sourcePath ? basename(sourcePath) : "Untitled Recording";

  // Read sidecar on mount; record snapshot for discard semantics.
  useEffect(() => {
    if (!sourcePath) return;
    let cancelled = false;
    invoke<SidecarState | null>("read_sidecar", { sourcePath })
      .then((state) => {
        if (cancelled) return;
        if (state) {
          setHadInitialSidecar(true);
          setSnapshot({ trim: state.trim ?? null, annotations: state.annotations ?? [] });
          if (state.trim) setTrim(state.trim);
          if (state.annotations) setAnnotations(state.annotations);
        } else {
          setHadInitialSidecar(false);
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

  const restoreSnapshot = useCallback(async (): Promise<void> => {
    if (!sourcePath) return;
    setTrim(snapshot.trim ?? null);
    setAnnotations(snapshot.annotations);
    if (hadInitialSidecar && !isLogicallyEmpty(snapshot, duration)) {
      await invoke("write_sidecar", {
        sourcePath,
        state: {
          trim: normalizeTrim(snapshot.trim ?? null, duration),
          annotations: snapshot.annotations,
        },
      }).catch((err) => setError(`restore sidecar: ${err}`));
    } else {
      await invoke("delete_sidecar", { sourcePath }).catch((err) =>
        setError(`delete sidecar: ${err}`),
      );
    }
  }, [sourcePath, snapshot, hadInitialSidecar, duration]);

  // Save edits is a stub in C2. C3 wires ffmpeg via an `edit_save` Tauri
  // command that produces <original>-edited.mp4. The stub keeps the modal
  // and Save-button surface area working.
  const saveEdits = useCallback(async (): Promise<boolean> => {
    if (!sourcePath) return false;
    setSaving(true);
    try {
      // Persist current state synchronously so a future re-open sees it.
      const norm: SidecarState = {
        trim: normalizeTrim(currentState.trim, duration),
        annotations: currentState.annotations,
      };
      if (isLogicallyEmpty(norm, duration)) {
        await invoke("delete_sidecar", { sourcePath });
      } else {
        await invoke("write_sidecar", { sourcePath, state: norm });
      }
      // C3 will run the ffmpeg pipeline here and produce -edited.mp4.
      return true;
    } catch (err) {
      setError(`save edits: ${err}`);
      return false;
    } finally {
      setSaving(false);
    }
  }, [sourcePath, currentState, duration]);

  // Refs for the close-requested handler so it sees current dirty + saving
  // without re-registering the listener on every keystroke.
  const dirtyRef = useRef(dirty);
  const savingRef = useRef(saving);
  const proceedingRef = useRef(false);
  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);
  useEffect(() => {
    savingRef.current = saving;
  }, [saving]);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    (async () => {
      const win = getCurrentWebviewWindow();
      const fn = await win.onCloseRequested((event) => {
        if (proceedingRef.current) return; // already greenlit
        if (savingRef.current || dirtyRef.current) {
          event.preventDefault();
          setShowCloseModal(true);
        }
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
  }, []);

  const closeWindow = useCallback(async () => {
    proceedingRef.current = true;
    await getCurrentWebviewWindow()
      .close()
      .catch((err) => {
        proceedingRef.current = false;
        setError(`close: ${err}`);
      });
  }, []);

  const onModalSave = useCallback(async () => {
    const ok = await saveEdits();
    if (ok) await closeWindow();
  }, [saveEdits, closeWindow]);

  const onModalDiscard = useCallback(async () => {
    await restoreSnapshot();
    await closeWindow();
  }, [restoreSnapshot, closeWindow]);

  const onModalCancel = useCallback(() => {
    setShowCloseModal(false);
  }, []);

  // Modal keyboard handling: Enter = default (Discard), Esc = Cancel.
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

  // Footer Discard restores snapshot in place (no window close).
  const onFooterDiscard = useCallback(async () => {
    await restoreSnapshot();
  }, [restoreSnapshot]);

  const onFooterSave = useCallback(async () => {
    const ok = await saveEdits();
    if (ok) await closeWindow();
  }, [saveEdits, closeWindow]);

  // Player wiring.
  const onLoadedMetadata = () => {
    const v = videoRef.current;
    if (!v) return;
    setDuration(v.duration);
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
          dirty={dirty}
          saving={saving}
        />
        <ExportPanel />
      </div>
      {error && <ErrorStrip error={error} onDismiss={() => setError(null)} />}
      {showCloseModal && (
        <CloseModal
          onSave={onModalSave}
          onDiscard={onModalDiscard}
          onCancel={onModalCancel}
          saving={saving}
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
  onFooterDiscard: () => Promise<void> | void;
  onFooterSave: () => Promise<void> | void;
  dirty: boolean;
  saving: boolean;
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
      <Toolbar duration={props.duration} trim={props.trim} />
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
      />
      <Timeline
        duration={props.duration}
        currentTime={props.currentTime}
        trim={props.trim}
        setTrim={props.setTrim}
        seek={props.seek}
      />
      <ActionFooter
        onDiscard={props.onFooterDiscard}
        onSave={props.onFooterSave}
        dirty={props.dirty}
        saving={props.saving}
      />
    </div>
  );
}

function Toolbar({ duration, trim }: { duration: number | null; trim: Trim | null }) {
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
      <div style={{ display: "inline-flex", alignItems: "center", gap: 4, opacity: 0.5 }}>
        <ToolButton icon={P.edit} label="Trim" kbd="T" />
        <ToolButton icon="M2 13h12M5 10l3-7 3 7M6.5 8h3" label="Text" kbd="A" />
        <ToolButton icon="M3 8h9M9 5l3 3-3 3" label="Arrow" kbd="R" />
      </div>
    </div>
  );
}

function ToolButton({ icon, label, kbd }: { icon: string; label: string; kbd: string }) {
  return (
    <button
      disabled
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "5px 9px",
        height: 26,
        background: "transparent",
        border: "1px solid transparent",
        borderRadius: 6,
        cursor: "not-allowed",
        color: "var(--fg-secondary)",
        fontFamily: "var(--font-system)",
        fontSize: 12,
        fontWeight: 500,
      }}
      title="Coming in next commit"
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
};

function VideoStage(props: VideoStageProps) {
  return (
    <div style={{ position: "relative", padding: 16, background: "#0c0d10", flex: 1 }}>
      <div
        style={{
          position: "relative",
          aspectRatio: "16 / 9",
          width: "100%",
          borderRadius: 8,
          overflow: "hidden",
          border: "1px solid rgba(255,255,255,0.06)",
          background: "#000",
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
            preload="metadata"
            style={{ width: "100%", height: "100%", objectFit: "contain", background: "#000" }}
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
  dirty,
  saving,
}: {
  onDiscard: () => Promise<void> | void;
  onSave: () => Promise<void> | void;
  dirty: boolean;
  saving: boolean;
}) {
  const canSave = dirty && !saving;
  const canDiscard = dirty && !saving;
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
      <button
        onClick={() => onDiscard()}
        disabled={!canDiscard}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          background: "transparent",
          border: "1px solid transparent",
          color: "var(--fg-tertiary)",
          padding: "6px 12px",
          borderRadius: 6,
          height: 30,
          cursor: canDiscard ? "pointer" : "not-allowed",
          fontFamily: "var(--font-system)",
          fontSize: 12.5,
          fontWeight: 500,
          opacity: canDiscard ? 1 : 0.5,
        }}
      >
        {I.trash}
        <span>Discard edits</span>
      </button>
      <button
        onClick={() => onSave()}
        disabled={!canSave}
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
          opacity: canSave ? 1 : 0.55,
          cursor: canSave ? "pointer" : "not-allowed",
        }}
      >
        <Icon d={P.check} size={13} stroke={1.6} />
        <span>{saving ? "Saving…" : "Save edits"}</span>
      </button>
    </div>
  );
}

function CloseModal({
  onSave,
  onDiscard,
  onCancel,
  saving,
}: {
  onSave: () => void;
  onDiscard: () => void;
  onCancel: () => void;
  saving: boolean;
}) {
  // Default focus on Discard, per macOS convention (Pages, Numbers, TextEdit).
  // Enter triggers Discard; Esc triggers Cancel.
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
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>Save your edits?</div>
        <div style={{ fontSize: 12.5, color: "var(--fg-secondary)", lineHeight: 1.4 }}>
          You have unsaved changes to this recording. Discarding keeps the source recording on
          disk.
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
            className="btn-secondary"
            style={{
              padding: "5px 12px",
              height: 28,
              borderColor: "var(--border-strong)",
            }}
          >
            Discard
          </button>
          <button
            onClick={onSave}
            disabled={saving}
            className="btn-primary"
            style={{
              padding: "5px 14px",
              height: 28,
              opacity: saving ? 0.6 : 1,
              cursor: saving ? "wait" : "pointer",
            }}
          >
            {saving ? "Saving…" : "Save"}
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

function ExportPanel() {
  return (
    <div style={{ display: "flex", flexDirection: "column", background: "var(--bg-sidebar)" }}>
      <div style={{ padding: "12px 14px 8px" }}>
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            justifyContent: "space-between",
            gap: 8,
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
            Export
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
            Coming in Phase 6
          </span>
        </div>
      </div>

      <div
        aria-hidden="true"
        style={{
          opacity: 0.4,
          pointerEvents: "none",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div style={{ padding: "0 12px 8px", display: "flex", flexDirection: "column", gap: 6 }}>
          <DestRow
            primary
            icon={<Icon d={P.check} size={14} stroke={1.6} />}
            title="Saved Locally"
            sub="~/Movies/Zeigen/recording-…mp4"
            action={
              <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11.5 }}>
                {I.finder}
                <span>Reveal</span>
              </span>
            }
          />
          <DestRow
            icon={<Icon d="M5 2h6v3M5 2v9a1 1 0 001 1h7a1 1 0 001-1V6L11 2M3 6h6v8" size={14} stroke={1.4} />}
            title="Copy to Clipboard"
            sub="Paste into Slack, Mail, Messages…"
            kbd={
              <>
                <span className="kbd">⌘</span>
                <span className="kbd">C</span>
              </>
            }
          />
          <DestRow
            icon={<Icon d={P.cloud} size={14} stroke={1.5} />}
            title="Upload & Share Link"
            sub="zeigen-share.pages.dev/v/…"
            kbd={
              <>
                <span className="kbd">⌘</span>
                <span className="kbd">⇧</span>
                <span className="kbd">L</span>
              </>
            }
          />
          <DestRow
            icon={<Icon d="M2.5 5h11v9h-11zM5 8.5v3M5 6.5h.01M7.5 11.5v-3c0-.8.7-1.5 1.5-1.5s1.5.7 1.5 1.5v3M10.5 11.5v-3" size={13} stroke={1.4} />}
            title="Export for LinkedIn"
            sub="MP4 · ≤ 10 min · 1080p capped"
          />
        </div>

        <div className="hairline" style={{ margin: "6px 14px" }} />

        <div style={{ padding: "6px 14px 10px" }}>
          <div
            style={{
              fontSize: 10.5,
              color: "var(--fg-tertiary)",
              letterSpacing: "0.06em",
              textTransform: "uppercase",
              fontWeight: 600,
              marginBottom: 8,
            }}
          >
            Quick export
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
}: {
  icon: React.ReactNode;
  title: string;
  sub: string;
  action?: React.ReactNode;
  kbd?: React.ReactNode;
  primary?: boolean;
}) {
  return (
    <button
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
        cursor: "pointer",
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
