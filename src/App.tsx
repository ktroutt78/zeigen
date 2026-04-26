import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { WebviewWindow, getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { availableMonitors } from "@tauri-apps/api/window";
import { emit } from "@tauri-apps/api/event";
import { I, Icon, P } from "./components/icons";
import { PILL_STRIP_CSS } from "./constants/bubble";

const DEFAULT_HOTKEY = "CmdOrCtrl+Shift+R";

const BUBBLE_LABEL = "webcam-bubble";
let bubbleDeviceName: string | null = null;

const BUBBLE_W = 240;
const BUBBLE_H = BUBBLE_W + PILL_STRIP_CSS;
const BUBBLE_MIN = 120;
const BUBBLE_MARGIN = 24;

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

  // Default position: bottom-right of the primary display, computed in
  // logical pixels so the constructor places the window correctly without
  // a post-creation setPosition race.
  let x: number | undefined;
  let y: number | undefined;
  try {
    const monitors = await availableMonitors();
    const m = monitors[0];
    if (m) {
      const scale = m.scaleFactor || 1;
      const rightLogical = (m.position.x + m.size.width) / scale;
      const bottomLogical = (m.position.y + m.size.height) / scale;
      x = rightLogical - BUBBLE_W - BUBBLE_MARGIN;
      y = bottomLogical - BUBBLE_H - BUBBLE_MARGIN;
    }
  } catch {
    // Fall back to Tauri default position
  }

  const win = new WebviewWindow(BUBBLE_LABEL, {
    url: `/#bubble?name=${encodeURIComponent(deviceName)}`,
    title: "Webcam",
    width: BUBBLE_W,
    height: BUBBLE_H,
    x,
    y,
    minWidth: BUBBLE_MIN,
    minHeight: BUBBLE_MIN + PILL_STRIP_CSS,
    decorations: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: true,
    skipTaskbar: true,
    visibleOnAllWorkspaces: true,
    shadow: false,
  });

  win.once("tauri://created", () => {
    invoke("make_capture_invisible", { label: BUBBLE_LABEL }).catch((e) => {
      console.error("make_capture_invisible(bubble) failed", e);
    });
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

const COUNTDOWN_LABEL = "countdown";

type DisplayFrame = {
  x: number;
  y: number;
  w: number;
  h: number;
  scale: number;
};

async function openCountdown(
  durationSec: number,
  displayFrame: DisplayFrame,
) {
  const existing = await WebviewWindow.getByLabel(COUNTDOWN_LABEL);
  if (existing) await existing.close().catch(() => {});

  // Construct with the recorded display's exact frame in logical pixels —
  // no post-creation setSize/setPosition. The previous pattern raced with
  // initial paint on macOS, leaving a 100x100 window with the digit clipped.
  // Tauri's constructor accepts logical pixels; convert from the monitor's
  // physical frame using its scaleFactor.
  const scale = displayFrame.scale || 1;
  const wLogical = displayFrame.w / scale;
  const hLogical = displayFrame.h / scale;
  const xLogical = displayFrame.x / scale;
  const yLogical = displayFrame.y / scale;

  const win = new WebviewWindow(COUNTDOWN_LABEL, {
    url: `/#countdown?duration=${durationSec}`,
    title: "Countdown",
    width: wLogical,
    height: hLogical,
    x: xLogical,
    y: yLogical,
    decorations: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    visibleOnAllWorkspaces: true,
    shadow: false,
    focus: true,
  });

  win.once("tauri://created", () => {
    invoke("make_capture_invisible", { label: COUNTDOWN_LABEL }).catch((e) => {
      console.error("make_capture_invisible(countdown) failed", e);
    });
  });
  win.once("tauri://error", (e) => {
    console.error("countdown window error", e);
  });
}

const IDENTIFY_LABEL_PREFIX = "identify-";

type DisplayShape = { width: number; height: number };

async function openIdentifyOverlays(displays: DisplayShape[]) {
  if (displays.length === 0) return;
  const monitors = await availableMonitors();
  for (let i = 0; i < displays.length; i++) {
    const display = displays[i];
    const monitor =
      monitors.find(
        (m) =>
          m.size.width === display.width && m.size.height === display.height,
      ) || monitors[i];
    if (!monitor) continue;
    const scale = monitor.scaleFactor || 1;
    const label = `${IDENTIFY_LABEL_PREFIX}${i}`;
    const existing = await WebviewWindow.getByLabel(label);
    if (existing) await existing.close().catch(() => {});
    // Use logical coords for the constructor based on this monitor's scale,
    // then re-apply physical position + size on `tauri://created` so the
    // window lands on the correct display even when monitors have mixed
    // scale factors (e.g. Retina + external 1x).
    const win = new WebviewWindow(label, {
      url: `/#identify?n=${i + 1}`,
      title: "Identify",
      width: monitor.size.width / scale,
      height: monitor.size.height / scale,
      decorations: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      visibleOnAllWorkspaces: true,
      shadow: false,
      focus: false,
    });
    win.once("tauri://created", async () => {
      try {
        const { PhysicalPosition, PhysicalSize } = await import(
          "@tauri-apps/api/dpi"
        );
        await win.setSize(
          new PhysicalSize(monitor.size.width, monitor.size.height),
        );
        await win.setPosition(
          new PhysicalPosition(monitor.position.x, monitor.position.y),
        );
      } catch {
        // best effort
      }
      invoke("make_capture_invisible", { label }).catch(() => {});
    });
  }
}

const TIMER_CHIP_LABEL = "timer-chip";
const TIMER_CHIP_W = 140;
const TIMER_CHIP_H = 36;
const TIMER_CHIP_MARGIN = 24;

async function openTimerChip() {
  const existing = await WebviewWindow.getByLabel(TIMER_CHIP_LABEL);
  if (existing) {
    await existing.show().catch(() => {});
    return;
  }

  const win = new WebviewWindow(TIMER_CHIP_LABEL, {
    url: `/#timer-chip`,
    title: "Timer",
    width: TIMER_CHIP_W,
    height: TIMER_CHIP_H,
    decorations: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    visibleOnAllWorkspaces: true,
    shadow: false,
    focus: false,
  });

  win.once("tauri://created", async () => {
    invoke("make_capture_invisible", { label: TIMER_CHIP_LABEL }).catch((e) => {
      console.error("make_capture_invisible(timer-chip) failed", e);
    });
    try {
      const monitors = await availableMonitors();
      const m = monitors[0];
      if (!m) return;
      const scale = m.scaleFactor;
      const xPhys =
        m.position.x + m.size.width - (TIMER_CHIP_W + TIMER_CHIP_MARGIN) * scale;
      const yPhys =
        m.position.y + m.size.height - (TIMER_CHIP_H + TIMER_CHIP_MARGIN) * scale;
      const { PhysicalPosition } = await import("@tauri-apps/api/dpi");
      await win.setPosition(new PhysicalPosition(xPhys, yPhys));
    } catch {
      // best effort — the window will land at default if positioning fails
    }
  });
  win.once("tauri://error", (e) => {
    console.error("timer-chip window error", e);
  });
}

async function closeTimerChip() {
  const existing = await WebviewWindow.getByLabel(TIMER_CHIP_LABEL);
  if (existing) await existing.close().catch(() => {});
}

async function awaitCountdown(
  durationSec: number,
  displayFrame: DisplayFrame,
): Promise<"completed" | "cancelled"> {
  return new Promise(async (resolve) => {
    const unlistens: Array<() => void> = [];
    const finish = (r: "completed" | "cancelled") => {
      unlistens.forEach((u) => u());
      resolve(r);
    };
    unlistens.push(await listen("countdown-done", () => finish("completed")));
    unlistens.push(
      await listen("countdown-cancelled", () => finish("cancelled")),
    );
    await openCountdown(durationSec, displayFrame);
  });
}

// Played by the main window when the countdown completes. The countdown
// window itself can't reliably trigger audio (its AudioContext is locked
// until a user gesture inside that window, which doesn't happen on the
// natural-end path). The main window kept user-gesture context from the
// Start click moments earlier.
function playGoSound() {
  try {
    const AC =
      (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = "sine";
    osc.frequency.value = 880;
    const t = ctx.currentTime;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.35, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.32);
    osc.start(t);
    osc.stop(t + 0.36);
  } catch {
    // best effort — silence is acceptable
  }
}

async function openReview(
  label: string,
  finalPath: string,
  onDestroyed: () => void,
): Promise<void> {
  // Each recording gets its own review window via a unique label
  // (review-<stamp>). Existing reviews stay open in the background — see
  // PHASE-5-CONTEXT.md D-15. The capability scope `review-*` covers them.
  const url = `/#review?path=${encodeURIComponent(finalPath)}`;
  const win = new WebviewWindow(label, {
    url,
    title: "Screen Recording",
    width: 940,
    height: 640,
    minWidth: 720,
    minHeight: 520,
    resizable: true,
    center: true,
  });

  win.once("tauri://error", (e) => {
    console.error("review window error", e);
  });
  win.once("tauri://destroyed", () => {
    onDestroyed();
  });
}

type Display = { id: number; name: string; width: number; height: number };
type Mic = { uid: string; name: string };
type Device = { index: number; name: string };
type DeviceList = { video: Device[]; audio: Device[]; screens: Device[] };
type EngineState = "idle" | "countdown" | "recording" | "paused";
type CountdownDuration = 0 | 3 | 5;
type LengthCapMode = "off" | "target";

type FinalizedRecording = {
  stamp: string;
  scratch_dir: string;
  scratch_mp4_path: string;
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
  const [countdownDuration, setCountdownDuration] =
    useState<CountdownDuration>(5);
  const [lengthCapMode, setLengthCapMode] = useState<LengthCapMode>("off");
  const [lengthCapTargetSec, setLengthCapTargetSec] = useState<number>(600);
  const [state, setState] = useState<EngineState>("idle");
  const [progress, setProgress] = useState({ frames: 0, dropped: 0, elapsed_s: 0 });
  const [lastSaved, setLastSaved] = useState<string | null>(null);
  const [finalizeInfo, setFinalizeInfo] = useState<FinalizedRecording | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hotkey, setHotkey] = useState<string>(DEFAULT_HOTKEY);
  // Counter of in-flight or open review windows. Each `stopped` event
  // increments; the window's destroy listener (or finalize-error path)
  // decrements. Main window stays hidden while > 0.
  const [reviewActivity, setReviewActivity] = useState(0);
  const incReview = () => setReviewActivity((n) => n + 1);
  const decReview = () => setReviewActivity((n) => Math.max(0, n - 1));

  useEffect(() => {
    let unlistenFn: (() => void) | null = null;
    let cancelled = false;

    const setup = async () => {
      const unlisten = await listen<EngineEvent>("engine-event", (e) => {
        const ev = e.payload;
        switch (ev.event) {
          case "ready":
            break;
          case "enumerated": {
            // CGDirectDisplayID values (e.g. id=27) leak through as "Display 27"
            // from the engine. Rename to user-friendly Display 1..N matching
            // dropdown position so the Identify overlay numbers line up.
            const displays = [...ev.displays]
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((d, i) => ({ ...d, name: `Display ${i + 1}` }));
            const mics = [...ev.microphones].sort((a, b) =>
              a.name.localeCompare(b.name),
            );
            setDisplays(displays);
            setMics(mics);
            setSelectedDisplay((prev) => prev ?? displays[0]?.id ?? null);
            setSelectedMic((prev) => prev ?? mics[0]?.uid ?? null);
            break;
          }
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
            incReview();
            setLastSaved(ev.output_path);
            setProgress({ frames: ev.frames, dropped: ev.dropped, elapsed_s: ev.duration_s });
            invoke<FinalizedRecording>("recording_finalize")
              .then(async (info) => {
                setFinalizeInfo(info);
                await openReview(`review-${info.stamp}`, info.scratch_mp4_path, decReview);
              })
              .catch((err) => {
                setError(String(err));
                decReview();
              });
            break;
          case "error":
            setError(`${ev.code}: ${ev.message}`);
            invoke("recording_reset").catch(() => {});
            setState("idle");
            // Engine errors during recording happen before the stop/finalize
            // pipeline increments — nothing to decrement here.
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
        .then((d) =>
          setCameras([...d.video].sort((a, b) => a.name.localeCompare(b.name))),
        )
        .catch((err) => setError(String(err)));
    };

    setup();

    // The review window emits `recording-committed` after commit_recording
    // succeeds — main updates its post-finalize toast from the now-stale
    // scratch path to the actual final ~/Movies/Zeigen/recording-….mp4.
    // `recording-discarded` clears the toast since the file is gone.
    let unlistenCommitted: (() => void) | null = null;
    let unlistenDiscarded: (() => void) | null = null;
    listen<{ final_path: string }>("recording-committed", (e) => {
      const finalPath = e.payload.final_path;
      setLastSaved(finalPath);
      setFinalizeInfo((prev) =>
        prev
          ? { ...prev, scratch_mp4_path: finalPath, sources_dir: null, composited: false }
          : null,
      );
    }).then((fn) => {
      if (cancelled) fn();
      else unlistenCommitted = fn;
    });
    listen("recording-discarded", () => {
      setLastSaved(null);
      setFinalizeInfo(null);
    }).then((fn) => {
      if (cancelled) fn();
      else unlistenDiscarded = fn;
    });

    return () => {
      cancelled = true;
      unlistenFn?.();
      unlistenCommitted?.();
      unlistenDiscarded?.();
    };
  }, []);

  const start = async () => {
    if (selectedDisplay == null) return;
    try {
      setError(null);
      setFinalizeInfo(null);
      setLastSaved(null);

      // Resolve the recorded display's physical frame up front. The countdown
      // window needs it to land on the correct screen; engine_start needs it
      // for bubble-position-log fraction conversion.
      const display = displays.find((d) => d.id === selectedDisplay);
      const monitors = await availableMonitors();
      const monitor =
        (display &&
          monitors.find(
            (m) => m.size.width === display.width && m.size.height === display.height,
          )) ||
        monitors[0];
      const recordedFrame: DisplayFrame = {
        x: monitor?.position.x ?? 0,
        y: monitor?.position.y ?? 0,
        w: monitor?.size.width ?? 0,
        h: monitor?.size.height ?? 0,
        scale: monitor?.scaleFactor ?? 1,
      };

      if (countdownDuration > 0) {
        setState("countdown");
        const result = await awaitCountdown(countdownDuration, recordedFrame);
        if (result === "cancelled") {
          setState("idle");
          return;
        }
        playGoSound();
      }

      await invoke<string>("engine_start", {
        displayId: selectedDisplay,
        microphoneUid: selectedMic,
        cameraIndex: selectedCamera,
        maxFps: 30,
        webcamSize: bubbleSize,
        webcamCorner: bubbleCorner,
        recordedDisplayX: recordedFrame.x,
        recordedDisplayY: recordedFrame.y,
        recordedDisplayW: recordedFrame.w,
        recordedDisplayH: recordedFrame.h,
      });
    } catch (err) {
      setState("idle");
      setError(String(err));
    }
  };

  const stop = () => {
    if (state === "countdown") {
      // Stop pressed while the countdown is still playing — cancel the
      // countdown rather than asking the engine to stop a recording it
      // never started. Without this guard, Rust returns INVALID_STATE.
      emit("countdown-cancelled").catch(() => {});
      return;
    }
    invoke("engine_stop").catch((e) => setError(String(e)));
  };

  const ctrlRef = useRef({
    state,
    selectedDisplay,
    start,
    stop,
    setSelectedCamera,
    setSelectedMic,
    setSelectedDisplay,
  });
  ctrlRef.current = {
    state,
    selectedDisplay,
    start,
    stop,
    setSelectedCamera,
    setSelectedMic,
    setSelectedDisplay,
  };

  // Push UI state to Rust so the tray menu reflects current selections + state.
  // Elapsed time is pushed via a separate, lightweight command (update_tray_elapsed)
  // that only updates the title — calling set_menu while the menu is open
  // collapses it, so we only rebuild on real state/device changes here.
  useEffect(() => {
    invoke("update_tray_state", {
      state: {
        recording_state: state,
        displays,
        mics,
        cameras,
        selected_display: selectedDisplay,
        selected_mic: selectedMic,
        selected_camera: selectedCamera,
      },
    }).catch(() => {});
  }, [state, displays, mics, cameras, selectedDisplay, selectedMic, selectedCamera]);

  const trayElapsed =
    state === "recording" || state === "paused"
      ? Math.floor(progress.elapsed_s)
      : 0;
  useEffect(() => {
    if (state !== "recording" && state !== "paused") return;
    invoke("update_tray_elapsed", { elapsedS: trayElapsed }).catch(() => {});
  }, [state, trayElapsed]);

  // Broadcast length-cap to bubble/timer-chip windows. Emit on change AND every
  // second during recording — covers the late-mount race where a chip subscribes
  // after main has already emitted.
  const capSec = lengthCapMode === "target" ? lengthCapTargetSec : null;
  useEffect(() => {
    emit("length-cap", { capSec }).catch(() => {});
  }, [capSec]);
  useEffect(() => {
    if (state !== "recording" && state !== "paused") return;
    const id = window.setInterval(() => {
      emit("length-cap", { capSec }).catch(() => {});
    }, 1000);
    return () => window.clearInterval(id);
  }, [state, capSec]);

  // Hide the main window during recording so it doesn't appear in the capture,
  // and keep it hidden across the recording → finalize → review handoff.
  // Main reshows once every open review window has been closed.
  useEffect(() => {
    const win = getCurrentWebviewWindow();
    if (state === "idle" && reviewActivity === 0) {
      win.show().catch(() => {});
    } else {
      win.hide().catch(() => {});
    }
  }, [state, reviewActivity]);

  // Listen for tray clicks and global hotkey toggles.
  useEffect(() => {
    let unlistenTray: (() => void) | null = null;
    let unlistenHotkey: (() => void) | null = null;
    let unlistenRecordAnother: (() => void) | null = null;
    let cancelled = false;

    (async () => {
      const a = await listen<{ id?: string; action?: string }>("tray-action", (e) => {
        const c = ctrlRef.current;
        const id = e.payload.id ?? "";
        if (id === "start") {
          if (c.state === "idle" && c.selectedDisplay != null) c.start();
        } else if (id === "stop") {
          if (c.state !== "idle") c.stop();
        } else if (id === "pause") {
          invoke("engine_pause").catch(() => {});
        } else if (id === "resume") {
          invoke("engine_resume").catch(() => {});
        } else if (id.startsWith("cam:")) {
          const v = id.slice(4);
          c.setSelectedCamera(v === "none" ? null : Number(v));
        } else if (id.startsWith("mic:")) {
          const v = id.slice(4);
          c.setSelectedMic(v === "none" ? null : v);
        } else if (id.startsWith("disp:")) {
          c.setSelectedDisplay(Number(id.slice(5)));
        }
      });
      const b = await listen<{}>("hotkey-toggle", () => {
        const c = ctrlRef.current;
        if (c.state === "idle") {
          if (c.selectedDisplay != null) c.start();
        } else {
          c.stop();
        }
      });
      // The review window's "Record another" button emits this after it
      // resolves any pending Save/Discard. Capture window reshows via
      // the existing reviewActivity → 0 effect; here we kick off the
      // next recording so the user lands directly in countdown.
      const r = await listen<{}>("record-another", () => {
        const c = ctrlRef.current;
        if (c.state === "idle" && c.selectedDisplay != null) c.start();
      });
      if (cancelled) {
        a();
        b();
        r();
        return;
      }
      unlistenTray = a;
      unlistenHotkey = b;
      unlistenRecordAnother = r;
    })();

    return () => {
      cancelled = true;
      unlistenTray?.();
      unlistenHotkey?.();
      unlistenRecordAnother?.();
    };
  }, []);

  const refresh = () => {
    invoke("engine_enumerate").catch((err) => setError(String(err)));
    invoke<DeviceList>("enumerate_devices")
      .then((d) =>
        setCameras([...d.video].sort((a, b) => a.name.localeCompare(b.name))),
      )
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

  // Bubble window lifecycle is driven by camera selection, NOT recording
  // state. Open while a camera is selected (idle, countdown, recording,
  // paused alike); close only when camera is deselected. The timer chip
  // and control pill inside the bubble are gated on recording state — see
  // WebcamBubble.tsx — but the window itself persists as long as the user
  // wants a webcam in the loop.
  useEffect(() => {
    if (cameraName) {
      openBubble(cameraName).catch((err) => setError(String(err)));
    } else {
      closeBubble().catch(() => {});
    }
  }, [cameraName]);

  useEffect(() => {
    const showChip =
      (state === "recording" || state === "paused") && cameraState === "none";
    if (showChip) {
      openTimerChip().catch(() => {});
    } else {
      closeTimerChip().catch(() => {});
    }
  }, [state, cameraState]);

  useEffect(() => {
    // The tray icon keeps the process alive after the main window closes, so
    // the red close button alone won't quit. Treat it as an explicit quit.
    const main = getCurrentWebviewWindow();
    let unlisten: (() => void) | null = null;
    main
      .onCloseRequested(() => {
        closeBubble().catch(() => {});
        invoke("quit_app").catch(() => {});
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
      <BrandBar
        recording={recording}
        elapsed={progress.elapsed_s}
        onRefresh={refresh}
      />

      <SettingsPanel
        hotkey={hotkey}
        onHotkey={async (combo) => {
          try {
            await invoke("set_hotkey", { combo });
            setHotkey(combo);
          } catch (e) {
            setError(String(e));
          }
        }}
        countdownDuration={countdownDuration}
        onCountdownDuration={setCountdownDuration}
        lengthCapMode={lengthCapMode}
        onLengthCapMode={setLengthCapMode}
        lengthCapTargetSec={lengthCapTargetSec}
        onLengthCapTargetSec={setLengthCapTargetSec}
      />

      <SourceTiles />

      <div className="hairline" />

      <div
        style={{
          padding: "16px 18px",
          display: "grid",
          gridTemplateColumns: "auto 1fr",
          rowGap: 14,
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
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <select
            className="select"
            value={selectedDisplay ?? ""}
            onChange={(e) => setSelectedDisplay(Number(e.target.value))}
            disabled={recording}
            style={{ flex: 1, fontSize: 12.5 }}
          >
            {displays.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name} — {d.width}×{d.height}
              </option>
            ))}
          </select>
          <button
            className="btn-ghost"
            title="Identify displays"
            onClick={() =>
              openIdentifyOverlays(displays).catch((e) => setError(String(e)))
            }
            disabled={recording || displays.length === 0}
            style={{
              padding: 5,
              color: "var(--fg-secondary)",
              flexShrink: 0,
              opacity: recording || displays.length === 0 ? 0.4 : 1,
              cursor:
                recording || displays.length === 0 ? "not-allowed" : "pointer",
            }}
          >
            {I.search}
          </button>
        </div>
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
    <div style={{ padding: 16, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
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
              padding: "13px 12px",
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
        body={finalizeInfo.scratch_mp4_path}
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

function SettingsPanel({
  hotkey,
  onHotkey,
  countdownDuration,
  onCountdownDuration,
  lengthCapMode,
  onLengthCapMode,
  lengthCapTargetSec,
  onLengthCapTargetSec,
}: {
  hotkey: string;
  onHotkey: (combo: string) => void;
  countdownDuration: CountdownDuration;
  onCountdownDuration: (v: CountdownDuration) => void;
  lengthCapMode: LengthCapMode;
  onLengthCapMode: (v: LengthCapMode) => void;
  lengthCapTargetSec: number;
  onLengthCapTargetSec: (v: number) => void;
}) {
  const [draft, setDraft] = useState(hotkey);
  const dirty = draft.trim() !== hotkey && draft.trim().length > 0;
  return (
    <div
      style={{
        margin: "10px 14px 0",
        padding: 12,
        background: "var(--bg-elevated)",
        border: "1px solid var(--border-faint)",
        borderRadius: 6,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        fontSize: 12,
      }}
    >
      <span style={{ fontWeight: 600, color: "var(--fg-primary)" }}>Settings</span>
      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          color: "var(--fg-secondary)",
        }}
      >
        <span style={{ minWidth: 88 }}>Start/Stop hotkey</span>
        <input
          className="select"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="CmdOrCtrl+Shift+R"
          style={{
            flex: 1,
            fontFamily: "var(--font-mono)",
            fontSize: 12,
          }}
        />
        <button
          className="btn-primary"
          disabled={!dirty}
          onClick={() => onHotkey(draft.trim())}
          style={{
            padding: "5px 10px",
            opacity: dirty ? 1 : 0.5,
            cursor: dirty ? "pointer" : "not-allowed",
          }}
        >
          Apply
        </button>
      </label>
      <span style={{ color: "var(--fg-tertiary)", fontSize: 11 }}>
        Examples: CmdOrCtrl+Shift+R, Alt+Shift+5
      </span>
      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          color: "var(--fg-secondary)",
          marginTop: 4,
        }}
      >
        <span style={{ minWidth: 88 }}>Countdown</span>
        <div
          role="radiogroup"
          aria-label="Countdown duration"
          style={{
            display: "inline-flex",
            background: "var(--bg-input)",
            border: "1px solid var(--border-subtle)",
            borderRadius: "var(--r-sm)",
            padding: 2,
          }}
        >
          {([5, 3, 0] as CountdownDuration[]).map((v) => {
            const active = countdownDuration === v;
            return (
              <button
                key={v}
                role="radio"
                aria-checked={active}
                onClick={() => onCountdownDuration(v)}
                style={{
                  background: active ? "var(--accent-soft)" : "transparent",
                  color: active ? "var(--accent-tint)" : "var(--fg-secondary)",
                  border: "none",
                  cursor: "pointer",
                  padding: "4px 10px",
                  borderRadius: "var(--r-xs)",
                  fontSize: 12,
                  fontWeight: active ? 600 : 500,
                }}
              >
                {v === 0 ? "Off" : `${v}s`}
              </button>
            );
          })}
        </div>
      </label>
      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          color: "var(--fg-secondary)",
        }}
      >
        <span style={{ minWidth: 88 }}>Length cap</span>
        <div
          role="radiogroup"
          aria-label="Length cap mode"
          style={{
            display: "inline-flex",
            background: "var(--bg-input)",
            border: "1px solid var(--border-subtle)",
            borderRadius: "var(--r-sm)",
            padding: 2,
          }}
        >
          {(["off", "target"] as LengthCapMode[]).map((v) => {
            const active = lengthCapMode === v;
            return (
              <button
                key={v}
                role="radio"
                aria-checked={active}
                onClick={() => onLengthCapMode(v)}
                style={{
                  background: active ? "var(--accent-soft)" : "transparent",
                  color: active ? "var(--accent-tint)" : "var(--fg-secondary)",
                  border: "none",
                  cursor: "pointer",
                  padding: "4px 10px",
                  borderRadius: "var(--r-xs)",
                  fontSize: 12,
                  fontWeight: active ? 600 : 500,
                }}
              >
                {v === "off" ? "No limit" : "Set target"}
              </button>
            );
          })}
        </div>
        {lengthCapMode === "target" && (
          <>
            <input
              className="select"
              type="number"
              min={1}
              max={120}
              value={Math.round(lengthCapTargetSec / 60)}
              onChange={(e) => {
                const m = Math.max(1, Math.min(120, Number(e.target.value) || 1));
                onLengthCapTargetSec(m * 60);
              }}
              style={{
                width: 60,
                fontFamily: "var(--font-mono)",
                fontSize: 12,
              }}
            />
            <span style={{ color: "var(--fg-tertiary)", fontSize: 11 }}>min</span>
          </>
        )}
      </label>
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
