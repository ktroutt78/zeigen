import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "./App.css";

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

function App() {
  const [displays, setDisplays] = useState<Display[]>([]);
  const [mics, setMics] = useState<Mic[]>([]);
  const [cameras, setCameras] = useState<Device[]>([]);
  const [selectedDisplay, setSelectedDisplay] = useState<number | null>(null);
  const [selectedMic, setSelectedMic] = useState<string | null>(null);
  const [selectedCamera, setSelectedCamera] = useState<number | null>(null);
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
        .then((d) => {
          setCameras(d.video);
        })
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
      await invoke<string>("engine_start", {
        displayId: selectedDisplay,
        microphoneUid: selectedMic,
        cameraIndex: selectedCamera,
        maxFps: 30,
      });
    } catch (err) {
      setError(String(err));
    }
  };

  const pause = () => invoke("engine_pause").catch((e) => setError(String(e)));
  const resume = () => invoke("engine_resume").catch((e) => setError(String(e)));
  const stop = () => invoke("engine_stop").catch((e) => setError(String(e)));

  const finalize = async () => {
    try {
      const info = await invoke<FinalizedRecording>("recording_finalize");
      setFinalizeInfo(info);
    } catch (err) {
      setError(String(err));
    }
  };

  const canStart = state === "idle" && selectedDisplay != null;

  const refresh = () => invoke("engine_enumerate").catch((err) => setError(String(err)));

  return (
    <main className="container">
      <h1>Recording</h1>

      <section className="refresh-row">
        <button onClick={refresh} disabled={state !== "idle"}>
          Refresh devices
        </button>
      </section>

      <section>
        <label>
          <span>Screen</span>
          <select
            value={selectedDisplay ?? ""}
            onChange={(e) => setSelectedDisplay(Number(e.target.value))}
            disabled={state !== "idle"}
          >
            {displays.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name} — {d.width}×{d.height}
              </option>
            ))}
          </select>
        </label>

        <label>
          <span>Microphone</span>
          <select
            value={selectedMic ?? ""}
            onChange={(e) => setSelectedMic(e.target.value || null)}
            disabled={state !== "idle"}
          >
            <option value="">No microphone</option>
            {mics.map((m) => (
              <option key={m.uid} value={m.uid}>
                {m.name}
              </option>
            ))}
          </select>
        </label>

        <label>
          <span>Webcam</span>
          <select
            value={selectedCamera ?? ""}
            onChange={(e) =>
              setSelectedCamera(e.target.value === "" ? null : Number(e.target.value))
            }
            disabled={state !== "idle"}
          >
            <option value="">No webcam</option>
            {cameras.map((c) => (
              <option key={c.index} value={c.index}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
      </section>

      <section className="controls">
        <button className="primary" onClick={start} disabled={!canStart}>
          Record
        </button>
        <button onClick={pause} disabled={state !== "recording"}>
          Pause
        </button>
        <button onClick={resume} disabled={state !== "paused"}>
          Resume
        </button>
        <button onClick={stop} disabled={state === "idle"}>
          Stop
        </button>
      </section>

      <StatusLine state={state} progress={progress} />

      {error && <p className="error">{error}</p>}
      {lastSaved && state === "idle" && (
        <p className="saved">Screen saved to {lastSaved}</p>
      )}
      {finalizeInfo && (
        <FinalizeInfo info={finalizeInfo} onRetry={finalize} />
      )}
    </main>
  );
}

function FinalizeInfo({
  info,
  onRetry,
}: {
  info: FinalizedRecording;
  onRetry: () => void;
}) {
  return (
    <section className="finalize">
      <h2>Finalize</h2>
      <ul className="finalize-fields">
        <li>
          <span className="k">stamp</span>
          <span className="v">{info.stamp}</span>
        </li>
        <li>
          <span className="k">final_path</span>
          <span className="v">{info.final_path}</span>
        </li>
        {info.sources_dir && (
          <li>
            <span className="k">sources_dir</span>
            <span className="v">{info.sources_dir}</span>
          </li>
        )}
        {info.webcam_segments.length > 0 && (
          <li>
            <span className="k">webcam_segments</span>
            <span className="v">
              <ol>
                {info.webcam_segments.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ol>
            </span>
          </li>
        )}
        <li>
          <span className="k">composited</span>
          <span className="v">{info.composited ? "yes" : "no (control-flow test only)"}</span>
        </li>
      </ul>
      <button onClick={onRetry}>Re-fetch finalize info</button>
    </section>
  );
}

function StatusLine({
  state,
  progress,
}: {
  state: EngineState;
  progress: { frames: number; dropped: number; elapsed_s: number };
}) {
  const label = state === "idle" ? "Idle" : state === "paused" ? "Paused" : "Recording";
  const time = useMemo(() => formatElapsed(progress.elapsed_s), [progress.elapsed_s]);
  return (
    <div className={`status status-${state}`}>
      <span className="dot" />
      <span className="label">{label}</span>
      <span className="time">{time}</span>
      <span className="frames">
        {progress.frames} frames{progress.dropped ? ` · ${progress.dropped} dropped` : ""}
      </span>
    </div>
  );
}

function formatElapsed(seconds: number): string {
  const s = Math.floor(seconds);
  const mm = String(Math.floor(s / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

export default App;
