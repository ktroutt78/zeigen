import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { WebviewWindow, getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { I, Icon, P } from "./components/icons";

const BUBBLE_LABEL = "webcam-bubble";
let bubbleDeviceName: string | null = null;

async function openBubble(deviceName: string) {
  if (bubbleDeviceName === deviceName) {
    const existing = await WebviewWindow.getByLabel(BUBBLE_LABEL);
    if (existing) {
      await existing.show().catch(() => {});
      return;
    }
  }

  const existing = await WebviewWindow.getByLabel(BUBBLE_LABEL);
  if (existing) await existing.close().catch(() => {});

  bubbleDeviceName = deviceName;

  const win = new WebviewWindow(BUBBLE_LABEL, {
    url: `/#bubble?name=${encodeURIComponent(deviceName)}`,
    title: "Webcam",
    width: 240,
    height: 240,
    minWidth: 120,
    minHeight: 120,
    decorations: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: true,
    skipTaskbar: true,
    visibleOnAllWorkspaces: true,
    shadow: false,
    parent: "main",
  });

  win.once("tauri://error", (e) => {
    console.error("bubble window error", e);
  });
}

async function closeBubble() {
  bubbleDeviceName = null;
  const existing = await WebviewWindow.getByLabel(BUBBLE_LABEL);
  if (existing) await existing.close().catch(() => {});
}

type Display = { id: number; name: string; width: number; height: number };
type Mic = { uid: string; name: string };
type Device = { index: number; name: string };
type DeviceList = { video: Device[]; audio: Device[]; screens: Device[] };
type EngineState = "idle" | "recording" | "paused";

type FinalizedRecording = {
  stamp: string;
  final_path: string;
  sources_dir: string | null;
  webcam_segments: string[];
  composited: boolean;
};

type EngineEvent =
  | { event: "ready"; version: string }
  | { event: "enumerated"; displays: Display[]; microphones: Mic[] }
  | { event: "started"; started_at: string }
  | { event: "progress"; frames: number; dropped: number; elapsed_s: number }
  | { event: "paused"; elapsed_s: number }
  | { event: "resumed"; elapsed_s: number }
  | {
      event: "stopped";
      output_path: string;
      duration_s: number;
      bytes: number;
      frames: number;
      dropped: number;
    }
  | { event: "error"; code: string; message: string };

type WebcamSize = "small" | "medium" | "large";
type Corner = "tl" | "tr" | "bl" | "br";

const NO_CAMERA = "__none__";

function isContinuity(name: string): boolean {
  return /iphone|continuity/i.test(name);
}

function App() {
  const [displays, setDisplays] = useState<Display[]>([]);
  const [mics, setMics] = useState<Mic[]>([]);
  const [cameras, setCameras] = useState<Device[]>([]);
  const [selectedDisplay, setSelectedDisplay] = useState<number | null>(null);
  const [selectedMic, setSelectedMic] = useState<string | null>(null);
  const [selectedCamera, setSelectedCamera] = useState<number | null>(null);
  const [bubbleSize, setBubbleSize] = useState<WebcamSize>("medium");
  const [bubbleCorner, setBubbleCorner] = useState<Corner>("br");
  const [state, setState] = useState<EngineState>("idle");
  const [progress, setProgress] = useState({ frames: 0, dropped: 0, elapsed_s: 0 });
  const [lastSaved, setLastSaved] = useState<string | null>(null);
  const [finalizeInfo, setFinalizeInfo] = useState<FinalizedRecording | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let unlistenFn: (() => void) | null = null;
    let cancelled = false;

    const setup = async () => {
      const unlisten = await listen<EngineEvent>("engine-event", (e) => {
        const ev = e.payload;
        switch (ev.event) {
          case "ready":
            break;
          case "enumerated":
            setDisplays(ev.displays);
            setMics(ev.microphones);
            setSelectedDisplay((prev) => prev ?? ev.displays[0]?.id ?? null);
            setSelectedMic((prev) => prev ?? ev.microphones[0]?.uid ?? null);
            break;
          case "started":
            setState("recording");
            setProgress({ frames: 0, dropped: 0, elapsed_s: 0 });
            setError(null);
            break;
          case "progress":
            setProgress({ frames: ev.frames, dropped: ev.dropped, elapsed_s: ev.elapsed_s });
            break;
          case "paused":
            setState("paused");
            break;
          case "resumed":
            setState("recording");
            break;
          case "stopped":
            setState("idle");
            setLastSaved(ev.output_path);
            setProgress({ frames: ev.frames, dropped: ev.dropped, elapsed_s: ev.duration_s });
            invoke<FinalizedRecording>("recording_finalize")
              .then(setFinalizeInfo)
              .catch((err) => setError(String(err)));
            break;
          case "error":
            setError(`${ev.code}: ${ev.message}`);
            invoke("recording_reset").catch(() => {});
            setState("idle");
            break;
        }
      });

      if (cancelled) {
        unlisten();
        return;
      }
      unlistenFn = unlisten;

      invoke("engine_enumerate").catch((err) => setError(String(err)));
      invoke<DeviceList>("enumerate_devices")
        .then((d) => setCameras(d.video))
        .catch((err) => setError(String(err)));
    };

    setup();

    return () => {
      cancelled = true;
      unlistenFn?.();
    };
  }, []);

  const start = async () => {
    if (selectedDisplay == null) return;
    try {
      setError(null);
      setFinalizeInfo(null);
      setLastSaved(null);
      await invoke<string>("engine_start", {
        displayId: selectedDisplay,
        microphoneUid: selectedMic,
        cameraIndex: selectedCamera,
        maxFps: 30,
        webcamSize: bubbleSize,
        webcamCorner: bubbleCorner,
      });
    } catch (err) {
      setError(String(err));
    }
  };

  const stop = () => invoke("engine_stop").catch((e) => setError(String(e)));

  const refresh = () => {
    invoke("engine_enumerate").catch((err) => setError(String(err)));
    invoke<DeviceList>("enumerate_devices")
      .then((d) => setCameras(d.video))
      .catch((err) => setError(String(err)));
  };

  const recording = state === "recording" || state === "paused";
  const cameraName =
    selectedCamera == null
      ? null
      : cameras.find((c) => c.index === selectedCamera)?.name ?? null;
  const cameraState: "none" | "selected" | "continuity" =
    selectedCamera == null
      ? "none"
      : cameraName && isContinuity(cameraName)
      ? "continuity"
      : "selected";

  useEffect(() => {
    if (cameraName) {
      openBubble(cameraName).catch((err) => setError(String(err)));
    } else {
      closeBubble().catch(() => {});
    }
  }, [cameraName]);

  useEffect(() => {
    // macOS keeps the app alive while any window remains open. Close the
    // bubble alongside the main window so the user's "close app" gesture
    // actually quits everything.
    const main = getCurrentWebviewWindow();
    let unlisten: (() => void) | null = null;
    main
      .onCloseRequested(() => {
        closeBubble().catch(() => {});
      })
      .then((u) => {
        unlisten = u;
      })
      .catch(() => {});
    return () => {
      unlisten?.();
    };
  }, []);

  return (
    <main
      className="accent-blue"
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        background: "var(--bg-window)",
        color: "var(--fg-primary)",
      }}
    >
      <BrandBar recording={recording} elapsed={progress.elapsed_s} onRefresh={refresh} />

      <SourceTiles />

      <div className="hairline" />

      <div
        style={{
          padding: "12px 14px",
          display: "grid",
          gridTemplateColumns: "auto 1fr",
          rowGap: 10,
          columnGap: 12,
          alignItems: "center",
          flex: 1,
        }}
      >
        <RowLabel icon={I.webcam} label="Camera" />
        <CameraRow
          cameras={cameras}
          value={selectedCamera}
          onChange={setSelectedCamera}
          cameraState={cameraState}
          disabled={recording}
        />

        {cameraState !== "none" && (
          <>
            <div />
            <WebcamControlsBar
              size={bubbleSize}
              onSize={setBubbleSize}
              corner={bubbleCorner}
              onCorner={setBubbleCorner}
              disabled={recording}
            />
          </>
        )}

        <RowLabel icon={I.mic} label="Microphone" />
        <select
          className="select"
          value={selectedMic ?? ""}
          onChange={(e) => setSelectedMic(e.target.value || null)}
          disabled={recording}
          style={{ width: "100%", fontSize: 12.5 }}
        >
          <option value="">No microphone</option>
          {mics.map((m) => (
            <option key={m.uid} value={m.uid}>
              {m.name}
            </option>
          ))}
        </select>

        <RowLabel icon={I.monitor} label="Screen" />
        <select
          className="select"
          value={selectedDisplay ?? ""}
          onChange={(e) => setSelectedDisplay(Number(e.target.value))}
          disabled={recording}
          style={{ width: "100%", fontSize: 12.5 }}
        >
          {displays.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name} — {d.width}×{d.height}
            </option>
          ))}
        </select>
      </div>

      <StatusStrip
        error={error}
        lastSaved={lastSaved}
        finalizeInfo={finalizeInfo}
        progress={progress}
        state={state}
        onDismiss={() => {
          setError(null);
          setLastSaved(null);
          setFinalizeInfo(null);
        }}
      />

      <FooterBar
        recording={recording}
        state={state}
        elapsed={progress.elapsed_s}
        canStart={state === "idle" && selectedDisplay != null}
        onStart={start}
        onStop={stop}
      />
    </main>
  );
}

function BrandBar({
  recording,
  elapsed,
  onRefresh,
}: {
  recording: boolean;
  elapsed: number;
  onRefresh: () => void;
}) {
  return (
    <div
      style={{
        height: 42,
        padding: "0 14px",
        display: "flex",
        alignItems: "center",
        borderBottom: "1px solid var(--border-faint)",
        background: "linear-gradient(to bottom, #2a2a2c, #232325)",
      }}
    >
      <span
        style={{
          width: 18,
          height: 18,
          borderRadius: 5,
          background: "linear-gradient(135deg, var(--accent), oklch(0.5 0.18 250))",
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
          marginLeft: 7,
          fontWeight: 600,
          fontSize: 13,
          letterSpacing: "-0.01em",
        }}
      >
        Zeigen
      </span>
      {recording && (
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            marginLeft: 10,
            padding: "2px 7px",
            borderRadius: 99,
            background: "var(--recording-soft)",
            border: "1px solid oklch(0.62 0.18 25 / 0.35)",
            color: "var(--recording-tint)",
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            fontWeight: 500,
          }}
        >
          <span className="rec-dot" /> REC {fmtTime(elapsed)}
        </span>
      )}
      <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 2 }}>
        <button
          className="btn-ghost"
          title="Refresh devices"
          onClick={onRefresh}
          style={{ padding: 5, color: "var(--fg-secondary)" }}
        >
          {I.history}
        </button>
        <button
          className="btn-ghost"
          title="Preferences"
          style={{ padding: 5, color: "var(--fg-secondary)" }}
        >
          {I.gear}
        </button>
      </div>
    </div>
  );
}

function SourceTiles() {
  // Phase 3 supports primary display only. The other tiles match the design
  // for visual consistency but are non-functional until later phases.
  const tiles = [
    { id: "display", label: "Entire Display", sub: "Primary display", icon: I.monitor, on: true },
    { id: "window", label: "Window", sub: "Coming soon", icon: I.window, on: false },
    { id: "area", label: "Selected Area", sub: "Coming soon", icon: I.area, on: false },
    { id: "webcam", label: "Webcam Only", sub: "Coming soon", icon: I.webcam, on: false },
  ];

  return (
    <div style={{ padding: 14, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
      {tiles.map((s) => {
        const active = s.on;
        const dim = !s.on;
        return (
          <div
            key={s.id}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 11,
              padding: "11px 12px",
              background: active ? "var(--accent-soft)" : "var(--bg-elevated)",
              border: `1px solid ${active ? "var(--accent)" : "var(--border-faint)"}`,
              borderRadius: 8,
              textAlign: "left",
              color: dim ? "var(--fg-tertiary)" : "var(--fg-primary)",
              fontFamily: "var(--font-system)",
              boxShadow: active ? "0 0 0 3px var(--accent-soft)" : "none",
              transition: "all 120ms cubic-bezier(0.4, 0, 0.2, 1)",
              opacity: dim ? 0.55 : 1,
            }}
          >
            <span
              style={{
                width: 30,
                height: 30,
                borderRadius: 7,
                flexShrink: 0,
                background: active ? "var(--accent)" : "var(--bg-input)",
                color: active ? "#fff" : "var(--fg-secondary)",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                border: "1px solid var(--border-faint)",
              }}
            >
              {s.icon}
            </span>
            <span style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0 }}>
              <span style={{ fontSize: 12.5, fontWeight: 600, letterSpacing: "-0.005em" }}>
                {s.label}
              </span>
              <span style={{ fontSize: 11, color: "var(--fg-tertiary)" }}>{s.sub}</span>
            </span>
          </div>
        );
      })}
    </div>
  );
}

function RowLabel({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 7,
        color: "var(--fg-secondary)",
        fontSize: 12,
      }}
    >
      {icon}
      <span>{label}</span>
    </div>
  );
}

function CameraRow({
  cameras,
  value,
  onChange,
  cameraState,
  disabled,
}: {
  cameras: Device[];
  value: number | null;
  onChange: (n: number | null) => void;
  cameraState: "none" | "selected" | "continuity";
  disabled: boolean;
}) {
  const selectValue = value == null ? NO_CAMERA : String(value);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <select
        className="select"
        value={selectValue}
        onChange={(e) => {
          const v = e.target.value;
          onChange(v === NO_CAMERA ? null : Number(v));
        }}
        disabled={disabled}
        style={{
          flex: 1,
          fontSize: 12.5,
          color: cameraState === "none" ? "var(--fg-tertiary)" : "var(--fg-primary)",
        }}
      >
        <option value={NO_CAMERA}>No webcam</option>
        {cameras.map((c) => (
          <option key={c.index} value={c.index}>
            {c.name}
          </option>
        ))}
      </select>
      {cameraState === "continuity" && <ContinuityPill />}
    </div>
  );
}

function ContinuityPill() {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        padding: "3px 8px",
        background: "var(--success-soft)",
        border: "1px solid oklch(0.62 0.13 155 / 0.34)",
        borderRadius: 99,
        color: "var(--success-tint)",
        fontSize: 10.5,
        fontWeight: 500,
        whiteSpace: "nowrap",
        letterSpacing: "-0.005em",
      }}
    >
      <span
        style={{
          width: 5,
          height: 5,
          borderRadius: 99,
          background: "var(--success-tint)",
          boxShadow: "0 0 0 2px oklch(0.62 0.13 155 / 0.32)",
        }}
      />
      iPhone connected
    </span>
  );
}

function WebcamControlsBar({
  size,
  onSize,
  corner,
  onCorner,
  disabled,
}: {
  size: WebcamSize;
  onSize: (s: WebcamSize) => void;
  corner: Corner;
  onCorner: (c: Corner) => void;
  disabled: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 14,
        padding: "8px 10px",
        background: "var(--bg-input)",
        border: "1px solid var(--border-faint)",
        borderRadius: 6,
        opacity: disabled ? 0.55 : 1,
        pointerEvents: disabled ? "none" : "auto",
      }}
    >
      <div style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
        <span style={{ fontSize: 11, color: "var(--fg-tertiary)" }}>Size</span>
        <SizePicker value={size} onChange={onSize} />
      </div>
      <div style={{ width: 1, height: 16, background: "var(--border-faint)" }} />
      <div style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
        <span style={{ fontSize: 11, color: "var(--fg-tertiary)" }}>Corner</span>
        <CornerPicker value={corner} onChange={onCorner} />
      </div>
      <div
        style={{
          marginLeft: "auto",
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          color: "var(--fg-tertiary)",
          fontSize: 11,
        }}
      >
        <Icon d={<circle cx="8" cy="8" r="5" />} size={11} stroke={1.4} />
        <span>Circle</span>
      </div>
    </div>
  );
}

function SizePicker({
  value,
  onChange,
}: {
  value: WebcamSize;
  onChange: (s: WebcamSize) => void;
}) {
  const opts: { id: WebcamSize; label: string }[] = [
    { id: "small", label: "S" },
    { id: "medium", label: "M" },
    { id: "large", label: "L" },
  ];
  return (
    <div className="segmented" style={{ padding: 2 }}>
      {opts.map((o) => (
        <button
          key={o.id}
          className={value === o.id ? "on" : ""}
          onClick={() => onChange(o.id)}
          style={{ minWidth: 24 }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function CornerPicker({
  value,
  onChange,
}: {
  value: Corner;
  onChange: (c: Corner) => void;
}) {
  const corners: Corner[] = ["tl", "tr", "bl", "br"];
  return (
    <div
      style={{
        width: 34,
        height: 24,
        background: "var(--bg-input)",
        border: "1px solid var(--border-subtle)",
        borderRadius: 5,
        position: "relative",
        display: "grid",
        gridTemplateColumns: "1fr 1fr",
        gridTemplateRows: "1fr 1fr",
        padding: 2,
        gap: 1,
      }}
    >
      {corners.map((c) => {
        const on = value === c;
        return (
          <button
            key={c}
            onClick={() => onChange(c)}
            aria-label={`Corner ${c}`}
            style={{
              background: "transparent",
              border: "none",
              padding: 0,
              margin: 0,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: 1.5,
                background: on ? "var(--accent)" : "var(--fg-quaternary)",
              }}
            />
          </button>
        );
      })}
    </div>
  );
}

function FooterBar({
  recording,
  state,
  elapsed,
  canStart,
  onStart,
  onStop,
}: {
  recording: boolean;
  state: EngineState;
  elapsed: number;
  canStart: boolean;
  onStart: () => void;
  onStop: () => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "12px 14px",
        background: "rgba(255,255,255,0.015)",
        borderTop: "1px solid var(--border-faint)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          color: "var(--fg-tertiary)",
          fontSize: 11.5,
        }}
      >
        <Icon d={P.folder} size={12} stroke={1.25} />
        <span>
          Saves to{" "}
          <span style={{ color: "var(--fg-secondary)", fontFamily: "var(--font-mono)", fontSize: 11 }}>
            ~/Movies/Zeigen
          </span>
        </span>
      </div>
      {recording ? (
        <button
          onClick={onStop}
          disabled={state === "paused"}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            padding: "7px 14px 7px 11px",
            background: "var(--recording)",
            color: "#fff",
            border: "none",
            borderRadius: 6,
            fontFamily: "var(--font-system)",
            fontWeight: 600,
            fontSize: 13,
            letterSpacing: "-0.005em",
            cursor: "pointer",
            boxShadow: "var(--shadow-recording-ring)",
          }}
        >
          <span
            style={{
              width: 16,
              height: 16,
              borderRadius: 4,
              background: "rgba(255,255,255,0.18)",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <span style={{ width: 8, height: 8, borderRadius: 2, background: "#fff" }} />
          </span>
          <span style={{ fontVariantNumeric: "tabular-nums", fontFamily: "var(--font-mono)", fontSize: 12 }}>
            Stop · {fmtTime(elapsed)}
          </span>
        </button>
      ) : (
        <button
          className="btn-primary"
          onClick={onStart}
          disabled={!canStart}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            padding: "7px 14px 7px 11px",
            fontWeight: 600,
            letterSpacing: "-0.005em",
            opacity: canStart ? 1 : 0.55,
            cursor: canStart ? "pointer" : "not-allowed",
          }}
        >
          <span
            style={{
              width: 16,
              height: 16,
              borderRadius: 99,
              background: "rgba(255,255,255,0.2)",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <span style={{ width: 8, height: 8, borderRadius: 99, background: "#fff" }} />
          </span>
          Start Recording
        </button>
      )}
    </div>
  );
}

function StatusStrip({
  error,
  lastSaved,
  finalizeInfo,
  progress,
  state,
  onDismiss,
}: {
  error: string | null;
  lastSaved: string | null;
  finalizeInfo: FinalizedRecording | null;
  progress: { frames: number; dropped: number; elapsed_s: number };
  state: EngineState;
  onDismiss: () => void;
}) {
  if (error) {
    return (
      <StripRow
        tone="recording"
        label="Error"
        body={error}
        onDismiss={onDismiss}
      />
    );
  }
  if (state === "idle" && finalizeInfo) {
    return (
      <StripRow
        tone="success"
        label={finalizeInfo.composited ? "Composited" : "Saved"}
        body={finalizeInfo.final_path}
        onDismiss={onDismiss}
      />
    );
  }
  if (state === "idle" && lastSaved) {
    return (
      <StripRow
        tone="success"
        label="Saved"
        body={lastSaved}
        onDismiss={onDismiss}
      />
    );
  }
  if (state !== "idle" && progress.dropped > 0) {
    return (
      <StripRow
        tone="muted"
        label="Frames dropped"
        body={`${progress.dropped} of ${progress.frames}`}
      />
    );
  }
  return null;
}

function StripRow({
  tone,
  label,
  body,
  onDismiss,
}: {
  tone: "success" | "recording" | "muted";
  label: string;
  body: string;
  onDismiss?: () => void;
}) {
  const palette =
    tone === "recording"
      ? {
          bg: "var(--recording-soft)",
          border: "oklch(0.62 0.18 25 / 0.35)",
          accent: "var(--recording-tint)",
        }
      : tone === "success"
      ? {
          bg: "var(--success-soft)",
          border: "oklch(0.62 0.13 155 / 0.34)",
          accent: "var(--success-tint)",
        }
      : {
          bg: "var(--bg-elevated)",
          border: "var(--border-faint)",
          accent: "var(--fg-secondary)",
        };
  return (
    <div
      style={{
        margin: "0 14px 10px",
        padding: "6px 10px",
        background: palette.bg,
        border: `1px solid ${palette.border}`,
        borderRadius: 6,
        display: "flex",
        alignItems: "center",
        gap: 8,
        fontSize: 11.5,
        minHeight: 26,
      }}
    >
      <span style={{ color: palette.accent, fontWeight: 600, flexShrink: 0 }}>
        {label}
      </span>
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
        title={body}
      >
        {body}
      </span>
      {onDismiss && (
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
      )}
    </div>
  );
}

function fmtTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const mm = String(Math.floor(s / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

export default App;
