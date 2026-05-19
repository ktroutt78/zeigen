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

  // Plant the countdown window via NSWindow.setFrame (Cocoa points) instead
  // of Tauri's constructor x/y/width/height. The constructor route landed
  // the window at half size on macOS; identify overlays already work around
  // this with set_window_frame_cg.
  // Engine reports display frame in CG points (origin AND size — what
  // SCDisplay returns on M-series macs set to a scaled "looks like" mode).
  // Pass through unchanged.
  const monitors = await availableMonitors();
  const primary =
    monitors.find((m) => m.position.x === 0 && m.position.y === 0) ||
    monitors[0];
  const primaryCocoaHeight =
    primary && primary.scaleFactor
      ? primary.size.height / primary.scaleFactor
      : 1080;

  const win = new WebviewWindow(COUNTDOWN_LABEL, {
    url: `/#countdown?duration=${durationSec}`,
    title: "Countdown",
    // Initial size doesn't matter — set_window_frame_cg resizes post-create.
    width: 400,
    height: 400,
    decorations: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    visibleOnAllWorkspaces: true,
    shadow: false,
    focus: true,
  });

  win.once("tauri://created", async () => {
    try {
      await invoke("set_window_frame_cg", {
        label: COUNTDOWN_LABEL,
        cgX: displayFrame.x,
        cgY: displayFrame.y,
        width: displayFrame.w,
        height: displayFrame.h,
        primaryCocoaHeight,
      });
      await invoke("make_capture_invisible", { label: COUNTDOWN_LABEL });
    } catch (e) {
      console.error("countdown setup failed", e);
    }
  });
  win.once("tauri://error", (e) => {
    console.error("countdown window error", e);
  });
}

const IDENTIFY_LABEL_PREFIX = "identify-";

type DisplayShape = {
  x: number;
  y: number;
  width: number;
  height: number;
};

async function openIdentifyOverlays(displays: DisplayShape[]) {
  if (displays.length === 0) return;
  // Primary screen Cocoa height is needed in Rust to flip CG (top-left,
  // Y down) into Cocoa (bottom-left, Y up) for NSWindow.setFrameOrigin.
  // Pull it from the Tauri monitor at (0, 0).
  const monitors = await availableMonitors();
  const primary =
    monitors.find((m) => m.position.x === 0 && m.position.y === 0) ||
    monitors[0];
  const primaryCocoaHeight =
    primary && primary.scaleFactor
      ? primary.size.height / primary.scaleFactor
      : 1080;
  for (let i = 0; i < displays.length; i++) {
    const display = displays[i];
    const label = `${IDENTIFY_LABEL_PREFIX}${i}`;
    const existing = await WebviewWindow.getByLabel(label);
    if (existing) await existing.close().catch(() => {});
    new WebviewWindow(label, {
      url: `/#identify?n=${i + 1}`,
      title: "Identify",
      // Initial size doesn't matter — Rust setSize resizes after creation.
      // Constructor x/y omitted because Tauri silently drops negative on
      // macOS for screens left of primary.
      width: 400,
      height: 400,
      decorations: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      visibleOnAllWorkspaces: true,
      shadow: false,
      focus: false,
    });
    void (async () => {
      for (let attempt = 0; attempt < 50; attempt++) {
        const win = await WebviewWindow.getByLabel(label);
        if (win) {
          try {
            await invoke("set_window_frame_cg", {
              label,
              cgX: display.x,
              cgY: display.y,
              width: display.width,
              height: display.height,
              primaryCocoaHeight,
            });
            await invoke("make_capture_invisible", { label });
          } catch (e) {
            console.error(`[identify] ${label} setup failed`, e);
          }
          return;
        }
        await new Promise((r) => setTimeout(r, 20));
      }
      console.error(`[identify] ${label} window never registered`);
    })();
  }
}

const IDENTIFY_WINDOW_LABEL_PREFIX = "identify-window-";

// Outline a captured window with a translucent rectangle + corner badge so
// the user can confirm "yes, that's the window I picked." Mirrors the
// display-identify pattern: open a transparent NSWindow at the target's
// CG bounds, let the overlay component handle its own fade-out and self-close.
async function openIdentifyWindowOverlay(window: WindowSource) {
  const monitors = await availableMonitors();
  const primary =
    monitors.find((m) => m.position.x === 0 && m.position.y === 0) ||
    monitors[0];
  const primaryCocoaHeight =
    primary && primary.scaleFactor
      ? primary.size.height / primary.scaleFactor
      : 1080;
  const label = `${IDENTIFY_WINDOW_LABEL_PREFIX}${window.id}`;
  const existing = await WebviewWindow.getByLabel(label);
  if (existing) await existing.close().catch(() => {});
  const params = new URLSearchParams({
    app: window.app,
    title: window.title,
  });
  new WebviewWindow(label, {
    url: `/#identify-window?${params.toString()}`,
    title: "Identify",
    // Initial size doesn't matter — Rust set_window_frame_cg resizes after
    // creation. Constructor x/y omitted because Tauri silently drops
    // negative on macOS for screens left of primary.
    width: 400,
    height: 400,
    decorations: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    visibleOnAllWorkspaces: true,
    shadow: false,
    focus: false,
  });
  void (async () => {
    for (let attempt = 0; attempt < 50; attempt++) {
      const win = await WebviewWindow.getByLabel(label);
      if (win) {
        try {
          await invoke("set_window_frame_cg", {
            label,
            cgX: window.x,
            cgY: window.y,
            width: window.width,
            height: window.height,
            primaryCocoaHeight,
          });
          await invoke("make_capture_invisible", { label });
        } catch (e) {
          console.error(`[identify-window] ${label} setup failed`, e);
        }
        return;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    console.error(`[identify-window] ${label} window never registered`);
  })();
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

const MARQUEE_LABEL_PREFIX = "marquee-";

export type AreaSelection = {
  display_id: number;
  x: number;
  y: number;
  width: number;
  height: number;
};

// One transparent always-on-top window per display. Marquee draws within;
// the user picks on whichever display they drag on. Returns the chosen
// rect (display-relative points + display_id) or null on cancel/Esc.
// `existing` prefills the rect on its origin display so flipping
// modes doesn't blow away a prior selection.
async function openMarqueeOverlays(
  displays: DisplayShape[],
  displayIds: number[],
  existing: AreaSelection | null = null,
): Promise<AreaSelection | null> {
  if (displays.length === 0) return null;

  const monitors = await availableMonitors();
  const primary =
    monitors.find((m) => m.position.x === 0 && m.position.y === 0) ||
    monitors[0];
  const primaryCocoaHeight =
    primary && primary.scaleFactor
      ? primary.size.height / primary.scaleFactor
      : 1080;

  const labels: string[] = [];

  for (let i = 0; i < displays.length; i++) {
    const d = displays[i];
    const displayId = displayIds[i];
    const label = `${MARQUEE_LABEL_PREFIX}${i}`;
    labels.push(label);
    const existingForThis =
      existing && existing.display_id === displayId ? existing : null;
    const params = new URLSearchParams({
      display_id: String(displayId),
      display_index: String(i + 1),
      display_width: String(d.width),
      display_height: String(d.height),
    });
    if (existingForThis) {
      params.set("x", String(existingForThis.x));
      params.set("y", String(existingForThis.y));
      params.set("w", String(existingForThis.width));
      params.set("h", String(existingForThis.height));
    }

    const old = await WebviewWindow.getByLabel(label);
    if (old) await old.close().catch(() => {});

    new WebviewWindow(label, {
      url: `/#marquee?${params.toString()}`,
      title: "Select Area",
      width: 400,
      height: 400,
      decorations: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      visibleOnAllWorkspaces: true,
      shadow: false,
      focus: i === 0,
    });

    void (async () => {
      for (let attempt = 0; attempt < 50; attempt++) {
        const win = await WebviewWindow.getByLabel(label);
        if (win) {
          try {
            await invoke("set_window_frame_cg", {
              label,
              cgX: d.x,
              cgY: d.y,
              width: d.width,
              height: d.height,
              primaryCocoaHeight,
            });
            await invoke("make_capture_invisible", { label });
          } catch (e) {
            console.error(`[marquee] ${label} setup failed`, e);
          }
          return;
        }
        await new Promise((r) => setTimeout(r, 20));
      }
      console.error(`[marquee] ${label} window never registered`);
    })();
  }

  return new Promise(async (resolve) => {
    const closeAll = async () => {
      for (const label of labels) {
        const w = await WebviewWindow.getByLabel(label);
        if (w) await w.close().catch(() => {});
      }
    };
    const unlistens: Array<() => void> = [];
    const finish = async (result: AreaSelection | null) => {
      unlistens.forEach((u) => u());
      await closeAll();
      resolve(result);
    };
    unlistens.push(
      await listen<AreaSelection>("marquee-confirmed", (e) => {
        finish(e.payload);
      }),
    );
    unlistens.push(
      await listen("marquee-cancelled", () => {
        finish(null);
      }),
    );
  });
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

type Display = {
  id: number;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
};
type WindowSource = {
  id: number;
  app: string;
  bundle_id?: string;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  on_screen: boolean;
};
type Mic = { uid: string; name: string };
type Device = { index: number; name: string };
type DeviceList = { video: Device[]; audio: Device[]; screens: Device[] };
type SourceKind = "display" | "window";
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
  | { event: "enumerated"; displays: Display[]; microphones: Mic[]; windows: WindowSource[] }
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

const NO_CAMERA = "__none__";

function isContinuity(name: string): boolean {
  return /iphone|continuity/i.test(name);
}

function App() {
  const [displays, setDisplays] = useState<Display[]>([]);
  const [windows, setWindows] = useState<WindowSource[]>([]);
  const [mics, setMics] = useState<Mic[]>([]);
  const [cameras, setCameras] = useState<Device[]>([]);
  const [sourceKind, setSourceKind] = useState<SourceKind>("display");
  const [selectedDisplay, setSelectedDisplay] = useState<number | null>(null);
  const [selectedWindow, setSelectedWindow] = useState<number | null>(null);
  const [selectedMic, setSelectedMic] = useState<string | null>(null);
  const [selectedCamera, setSelectedCamera] = useState<number | null>(null);
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
  // Fraction in [0,1] while ffmpeg composite is running. null when idle or done.
  // The main window stays visible while this is non-null so the user sees a
  // progress bar instead of staring at nothing during a multi-minute composite.
  const [compositeProgress, setCompositeProgress] = useState<number | null>(null);

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
            // Alpha sort by app then title; focus-aware "currently focused
            // app to the top" lands in a follow-up commit.
            const wins = [...(ev.windows ?? [])].sort((a, b) => {
              const app = a.app.localeCompare(b.app);
              return app !== 0 ? app : a.title.localeCompare(b.title);
            });
            setDisplays(displays);
            setMics(mics);
            setWindows(wins);
            setSelectedDisplay((prev) => prev ?? displays[0]?.id ?? null);
            setSelectedMic((prev) => prev ?? mics[0]?.uid ?? null);
            // Don't auto-select a window — empty default forces an explicit
            // pick once the user toggles the Window source.
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
            setCompositeProgress(0);
            invoke<FinalizedRecording>("recording_finalize")
              .then(async (info) => {
                setFinalizeInfo(info);
                await openReview(`review-${info.stamp}`, info.scratch_mp4_path, decReview);
              })
              .catch((err) => {
                setError(String(err));
                decReview();
              })
              .finally(() => {
                setCompositeProgress(null);
              });
            break;
          case "error":
            setError(`${ev.code}: ${ev.message}`);
            // Engine self-resets to idle on any error it emits — sending
            // Stop here would produce a follow-on INVALID_STATE error
            // that overwrites the original. Use the local-only cleanup.
            invoke("recording_cleanup_local").catch(() => {});
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
    let unlistenComposite: (() => void) | null = null;
    listen<number>("composite-progress", (e) => {
      // If we've already cleared (finalize resolved → review window opened),
      // drop the event. Tauri delivers events asynchronously, so a tail
      // progress sample can arrive after the .finally cleanup and would
      // otherwise resurrect the modal over the main window.
      setCompositeProgress((prev) => (prev === null ? null : e.payload));
    }).then((fn) => {
      if (cancelled) fn();
      else unlistenComposite = fn;
    });
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
      unlistenComposite?.();
    };
  }, []);

  const start = async () => {
    if (sourceKind === "display" && selectedDisplay == null) return;
    if (sourceKind === "window" && selectedWindow == null) return;
    try {
      setError(null);
      setFinalizeInfo(null);
      setLastSaved(null);

      // Resolve the screen the countdown should land on. Display mode uses
      // the chosen display directly; window mode picks whichever display
      // contains the captured window's center (falls back to primary).
      // engine_start additionally needs recorded_display_* in display mode
      // for bubble-position-log fraction conversion — window mode skips
      // those and the engine drives bubble fractions off its 5Hz
      // window_frame events instead.
      const monitors = await availableMonitors();
      let countdownDisplay: Display | undefined;
      if (sourceKind === "display") {
        countdownDisplay = displays.find((d) => d.id === selectedDisplay);
      } else {
        const win = windows.find((w) => w.id === selectedWindow);
        if (win) {
          const cx = win.x + win.width / 2;
          const cy = win.y + win.height / 2;
          countdownDisplay = displays.find(
            (d) => cx >= d.x && cx < d.x + d.width && cy >= d.y && cy < d.y + d.height,
          );
        }
      }
      const monitor = countdownDisplay
        ? monitors.find(
            (m) =>
              m.position.x === countdownDisplay!.x &&
              m.position.y === countdownDisplay!.y,
          ) || monitors[0]
        : monitors[0];
      const recordedFrame: DisplayFrame = {
        x: countdownDisplay?.x ?? monitor?.position.x ?? 0,
        y: countdownDisplay?.y ?? monitor?.position.y ?? 0,
        w: countdownDisplay?.width ?? monitor?.size.width ?? 0,
        h: countdownDisplay?.height ?? monitor?.size.height ?? 0,
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
        displayId: sourceKind === "display" ? selectedDisplay : null,
        windowId: sourceKind === "window" ? selectedWindow : null,
        microphoneUid: selectedMic,
        cameraIndex: selectedCamera,
        maxFps: 30,
        recordedDisplayX: sourceKind === "display" ? recordedFrame.x : null,
        recordedDisplayY: sourceKind === "display" ? recordedFrame.y : null,
        recordedDisplayW: sourceKind === "display" ? recordedFrame.w : null,
        recordedDisplayH: sourceKind === "display" ? recordedFrame.h : null,
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
      // Force state back to idle even if the cancel event has no
      // listener (countdown already completed but engine never sent
      // started — a stuck state we need to recover from).
      emit("countdown-cancelled").catch(() => {});
      setState("idle");
      invoke("recording_reset").catch(() => {});
      return;
    }
    invoke("engine_stop").catch((e) => setError(String(e)));
  };

  const canStartNow =
    sourceKind === "display" ? selectedDisplay != null : selectedWindow != null;
  const ctrlRef = useRef({
    state,
    canStartNow,
    start,
    stop,
    setSelectedCamera,
    setSelectedMic,
    setSelectedDisplay,
  });
  ctrlRef.current = {
    state,
    canStartNow,
    start,
    stop,
    setSelectedCamera,
    setSelectedMic,
    setSelectedDisplay,
  };

  // c3-only debug hook for visually testing the marquee overlay before c4
  // wires it to the picker. Cmd+Shift+M opens marquee windows on all known
  // displays; result is logged. Remove (or replace with the picker trigger)
  // when c4 lands.
  useEffect(() => {
    const debugOpen = async () => {
      const shapes: DisplayShape[] = displays.map((d) => ({
        x: d.x,
        y: d.y,
        width: d.width,
        height: d.height,
      }));
      const ids = displays.map((d) => d.id);
      const result = await openMarqueeOverlays(shapes, ids);
      console.log("[marquee debug] result:", result);
    };
    (window as unknown as { __zeigenOpenMarquee: () => Promise<void> })
      .__zeigenOpenMarquee = debugOpen;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey && e.shiftKey && (e.key === "m" || e.key === "M")) {
        e.preventDefault();
        void debugOpen();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [displays]);

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
        source_kind: sourceKind,
        selected_window: selectedWindow,
      },
    }).catch(() => {});
  }, [
    state,
    displays,
    mics,
    cameras,
    selectedDisplay,
    selectedMic,
    selectedCamera,
    sourceKind,
    selectedWindow,
  ]);

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

  // Broadcast recording state so satellite windows (bubble, timer chip) get
  // their controls in sync even if they missed the engine's `started` event
  // (late listener registration, focus-related event drops, etc.). Goes
  // alongside the existing engine-event subscription as a redundant signal.
  useEffect(() => {
    emit("recording-state", {
      state,
      elapsed_s: progress.elapsed_s,
      cap_sec: capSec,
    }).catch(() => {});
  }, [state, progress.elapsed_s, capSec]);

  // Watchdog: detect a stuck "countdown" state (engine accepted start but
  // never emitted `started` or `error` — e.g., engine crash). Fires
  // `countdownDuration + 5` seconds after entering countdown; cleared
  // immediately if state transitions normally. Recovers the UI without
  // requiring an app force-quit.
  useEffect(() => {
    if (state !== "countdown") return;
    const ms = (countdownDuration + 5) * 1000;
    const id = window.setTimeout(() => {
      setError(
        "Recording engine didn't respond. If this persists, restart Zeigen.",
      );
      setState("idle");
      invoke("recording_reset").catch(() => {});
    }, ms);
    return () => window.clearTimeout(id);
  }, [state, countdownDuration]);

  // Hide the main window during recording so it doesn't appear in the capture,
  // and keep it hidden across the recording → finalize → review handoff.
  // Main reshows once every open review window has been closed.
  //
  // Exception: while ffmpeg composite is running we surface the main window
  // anyway so the user sees the progress bar — otherwise the screen looks
  // frozen for the duration of the composite (tens of seconds on multi-min
  // recordings).
  useEffect(() => {
    const win = getCurrentWebviewWindow();
    const compositing = compositeProgress !== null;
    if ((state === "idle" && reviewActivity === 0) || compositing) {
      win.show().catch(() => {});
    } else {
      win.hide().catch(() => {});
    }
  }, [state, reviewActivity, compositeProgress]);

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
          if (c.state === "idle" && c.canStartNow) c.start();
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
          if (c.canStartNow) c.start();
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
        if (c.state === "idle" && c.canStartNow) c.start();
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

      {compositeProgress !== null && (
        <CompositeProgressOverlay value={compositeProgress} />
      )}

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

      <SourceTiles
        sourceKind={sourceKind}
        onSourceKind={setSourceKind}
        disabled={recording}
      />

      <div className="hairline" />

      <div
        style={{
          padding: "16px 18px",
          display: "grid",
          // minmax(0, 1fr) instead of 1fr — without the explicit 0 min,
          // a 1fr track grows to fit its intrinsic min-content (e.g. a
          // long select option label) and pushes the fixed 480px capture
          // window into horizontal scroll.
          gridTemplateColumns: "auto minmax(0, 1fr)",
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

        {sourceKind === "display" ? (
          <>
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
                    recording || displays.length === 0
                      ? "not-allowed"
                      : "pointer",
                }}
              >
                {I.search}
              </button>
            </div>
          </>
        ) : (
          <>
            <RowLabel icon={I.window} label="Window" />
            <WindowRow
              windows={windows}
              value={selectedWindow}
              onChange={setSelectedWindow}
              onIdentify={(w) =>
                openIdentifyWindowOverlay(w).catch((e) => setError(String(e)))
              }
              disabled={recording}
            />
          </>
        )}
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
        canStart={
          state === "idle" &&
          (sourceKind === "display"
            ? selectedDisplay != null
            : selectedWindow != null)
        }
        onStart={start}
        onStop={stop}
      />
    </main>
  );
}

function CompositeProgressOverlay({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 50,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0, 0, 0, 0.55)",
        backdropFilter: "blur(6px)",
        WebkitBackdropFilter: "blur(6px)",
      }}
    >
      <div
        style={{
          minWidth: 320,
          padding: "20px 22px",
          borderRadius: 14,
          background: "var(--bg-window)",
          border: "1px solid var(--border-faint)",
          boxShadow: "0 18px 48px rgba(0,0,0,0.45)",
          display: "flex",
          flexDirection: "column",
          gap: 10,
        }}
      >
        <div
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: "var(--fg-primary)",
          }}
        >
          Compositing recording…
        </div>
        <div
          style={{
            position: "relative",
            height: 6,
            borderRadius: 99,
            background: "var(--border-faint)",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              position: "absolute",
              inset: 0,
              right: "auto",
              width: `${pct}%`,
              background: "oklch(0.66 0.18 252)",
              transition: "width 200ms ease-out",
            }}
          />
        </div>
        <div
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            color: "var(--fg-secondary)",
            display: "flex",
            justifyContent: "space-between",
          }}
        >
          <span>{pct}%</span>
          <span>{value < 0.99 ? "merging webcam + screen" : "finishing up"}</span>
        </div>
      </div>
    </div>
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
      <svg
        width="18"
        height="18"
        viewBox="0 0 120 120"
        aria-label="Zeigen"
        style={{ display: "block", flexShrink: 0 }}
      >
        <rect x="6" y="6" width="108" height="108" rx="26" fill="oklch(0.58 0.18 252)" />
        <path
          d="M28 32 H92 V46 L48 78 H92 V92 H28 V78 L72 46 H28 Z"
          fill="oklch(0.36 0.16 260)"
        />
        <path d="M28 32 H92 V40 H28 Z" fill="#000" opacity="0.22" />
      </svg>
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

function SourceTiles({
  sourceKind,
  onSourceKind,
  disabled,
}: {
  sourceKind: SourceKind;
  onSourceKind: (k: SourceKind) => void;
  disabled: boolean;
}) {
  // Display + Window are wired source kinds. Selected Area and Webcam Only
  // remain visual placeholders for now — the design intentionally shows the
  // full grid so the destinations look planned, not absent.
  const tiles: Array<{
    id: string;
    label: string;
    sub: string;
    icon: React.ReactNode;
    kind?: SourceKind;
  }> = [
    { id: "display", label: "Entire Display", sub: "Pick a screen", icon: I.monitor, kind: "display" },
    { id: "window", label: "Window", sub: "Pick an app window", icon: I.window, kind: "window" },
    { id: "area", label: "Selected Area", sub: "Coming soon", icon: I.area },
    { id: "webcam", label: "Webcam Only", sub: "Coming soon", icon: I.webcam },
  ];

  return (
    <div style={{ padding: 16, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
      {tiles.map((s) => {
        const selectable = s.kind !== undefined;
        const active = selectable && s.kind === sourceKind;
        const dim = !selectable;
        const interactive = selectable && !disabled;
        return (
          <button
            key={s.id}
            type="button"
            onClick={() => {
              if (interactive && s.kind) onSourceKind(s.kind);
            }}
            disabled={!interactive}
            style={{
              all: "unset",
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
              opacity: dim ? 0.55 : disabled ? 0.7 : 1,
              cursor: interactive ? "pointer" : "not-allowed",
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
          </button>
        );
      })}
    </div>
  );
}

function WindowRow({
  windows,
  value,
  onChange,
  onIdentify,
  disabled,
}: {
  windows: WindowSource[];
  value: number | null;
  onChange: (n: number | null) => void;
  onIdentify: (w: WindowSource) => void;
  disabled: boolean;
}) {
  const empty = windows.length === 0;
  const selected = value == null ? null : windows.find((w) => w.id === value);
  return (
    // minWidth: 0 + overflow: hidden on the wrapper, plus minmax(0, 1fr)
    // on the parent grid (above) — three places to clamp because webkit's
    // native <select> still tries to grow to its widest option's text in
    // some layout configs.
    <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0, overflow: "hidden" }}>
      <select
        className="select"
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
        disabled={disabled || empty}
        style={{
          flex: 1,
          minWidth: 0,
          maxWidth: "100%",
          fontSize: 12.5,
          color: value == null ? "var(--fg-tertiary)" : "var(--fg-primary)",
          textOverflow: "ellipsis",
        }}
      >
        <option value="">{empty ? "No windows available" : "Select a window…"}</option>
        {windows.map((w) => {
          // App — Title; fall back to "Untitled" when SCK gives no title
          // (common for app panels and helper surfaces).
          const title = w.title.trim() || "Untitled";
          return (
            <option key={w.id} value={w.id}>
              {w.app} — {title}
            </option>
          );
        })}
      </select>
      <button
        className="btn-ghost"
        title="Identify window"
        onClick={() => selected && onIdentify(selected)}
        disabled={disabled || !selected}
        style={{
          padding: 5,
          color: "var(--fg-secondary)",
          flexShrink: 0,
          opacity: disabled || !selected ? 0.4 : 1,
          cursor: disabled || !selected ? "not-allowed" : "pointer",
        }}
      >
        {I.search}
      </button>
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
