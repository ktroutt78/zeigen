import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { WebviewWindow, getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { availableMonitors } from "@tauri-apps/api/window";
import { emit } from "@tauri-apps/api/event";
import { I, Icon, P } from "./components/icons";
import { PILL_STRIP_CSS } from "./constants/bubble";

const DEFAULT_HOTKEY = "CmdOrCtrl+Shift+P";

const BUBBLE_LABEL = "webcam-bubble";
let bubbleDeviceName: string | null = null;

const BUBBLE_W = 240;
const BUBBLE_H = BUBBLE_W + PILL_STRIP_CSS;
const BUBBLE_MIN = 120;
const BUBBLE_MARGIN = 24;

// Anchor rect for placing the bubble. Coords + size are in logical
// points in screen space (matches Display.x/y/width/height from the
// engine and selectedArea screen-space math).
type BubbleAnchor = { x: number; y: number; w: number; h: number };

async function openBubble(deviceName: string, anchor: BubbleAnchor) {
  // Primary display Cocoa height for the CG -> Cocoa flip in
  // set_window_frame_cg. Same lookup the countdown overlay uses.
  const monitors = await availableMonitors();
  const primary =
    monitors.find((m) => m.position.x === 0 && m.position.y === 0) ||
    monitors[0];
  const primaryCocoaHeight =
    primary && primary.scaleFactor
      ? primary.size.height / primary.scaleFactor
      : 1080;

  const existing = await WebviewWindow.getByLabel(BUBBLE_LABEL);

  if (existing && bubbleDeviceName === deviceName) {
    // Same camera, picker may have switched recording target. Leave the
    // bubble where the user dragged it if it still overlaps the new
    // anchor; re-place to the anchor's bottom-right only if zero overlap.
    // Uses the current size (not BUBBLE_W/H) so manual ring-resize sticks.
    const scale = await existing.scaleFactor();
    const pos = await existing.outerPosition();
    const size = await existing.outerSize();
    const cur = {
      x: pos.x / scale,
      y: pos.y / scale,
      w: size.width / scale,
      h: size.height / scale,
    };
    const intersects =
      cur.x + cur.w > anchor.x &&
      cur.x < anchor.x + anchor.w &&
      cur.y + cur.h > anchor.y &&
      cur.y < anchor.y + anchor.h;
    if (!intersects) {
      const targetX = anchor.x + anchor.w - cur.w - BUBBLE_MARGIN;
      const targetY = anchor.y + anchor.h - cur.h - BUBBLE_MARGIN;
      await invoke("set_window_frame_cg", {
        label: BUBBLE_LABEL,
        cgX: targetX,
        cgY: targetY,
        width: cur.w,
        height: cur.h,
        primaryCocoaHeight,
      }).catch((e) => console.error("bubble re-anchor failed", e));
    }
    await existing.show().catch(() => {});
    return;
  }

  if (existing) await existing.close().catch(() => {});
  bubbleDeviceName = deviceName;

  // Plant via set_window_frame_cg on tauri://created. Tauri's constructor
  // x/y drops negative coords for screens left of primary and can land
  // half-size on non-primary displays (countdown precedent at
  // App.tsx:118-121, macos.rs:70-72).
  const targetX = anchor.x + anchor.w - BUBBLE_W - BUBBLE_MARGIN;
  const targetY = anchor.y + anchor.h - BUBBLE_H - BUBBLE_MARGIN;

  const win = new WebviewWindow(BUBBLE_LABEL, {
    url: `/#bubble?name=${encodeURIComponent(deviceName)}`,
    title: "Webcam",
    width: BUBBLE_W,
    height: BUBBLE_H,
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

  win.once("tauri://created", async () => {
    try {
      await invoke("set_window_frame_cg", {
        label: BUBBLE_LABEL,
        cgX: targetX,
        cgY: targetY,
        width: BUBBLE_W,
        height: BUBBLE_H,
        primaryCocoaHeight,
      });
      await invoke("make_capture_invisible", { label: BUBBLE_LABEL });
    } catch (e) {
      console.error("bubble setup failed", e);
    }
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
// Sized to fit the RecordingControlPill (timer + pause + stop). Chrome
// around the pill is transparent and draggable.
const TIMER_CHIP_W = 200;
const TIMER_CHIP_H = 44;
const TIMER_CHIP_MARGIN = 24;

async function openTimerChip(anchor: BubbleAnchor | null = null) {
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
      // Position via set_window_frame_cg (CG points, top-left origin).
      // Tauri's PhysicalPosition setPosition path mis-routes across
      // mixed-scale multi-monitor setups because availableMonitors
      // positions are chained in PHYSICAL pixels, not logical points —
      // dividing each monitor's position by its OWN scale doesn't yield
      // a consistent global logical coord space. set_window_frame_cg
      // accepts CG points directly and handles the Cocoa Y-flip in Rust.
      const monitors = await availableMonitors();
      const primary =
        monitors.find((m) => m.position.x === 0 && m.position.y === 0) ||
        monitors[0];
      const primaryCocoaHeight =
        primary && primary.scaleFactor
          ? primary.size.height / primary.scaleFactor
          : 1080;
      let cgX: number;
      let cgY: number;
      if (anchor) {
        // Just below the anchor's bottom edge, horizontally centered.
        cgX = anchor.x + anchor.w / 2 - TIMER_CHIP_W / 2;
        cgY = anchor.y + anchor.h + TIMER_CHIP_MARGIN;
      } else {
        // Default: primary display's bottom-right corner. Primary's
        // logical dimensions = physical / scale (safe because primary is
        // always at the (0,0) origin in both coord spaces).
        const primaryW = primary
          ? primary.size.width / primary.scaleFactor
          : 1920;
        const primaryH = primary
          ? primary.size.height / primary.scaleFactor
          : 1080;
        cgX = primaryW - TIMER_CHIP_W - TIMER_CHIP_MARGIN;
        cgY = primaryH - TIMER_CHIP_H - TIMER_CHIP_MARGIN;
      }
      await invoke("set_window_frame_cg", {
        label: TIMER_CHIP_LABEL,
        cgX,
        cgY,
        width: TIMER_CHIP_W,
        height: TIMER_CHIP_H,
        primaryCocoaHeight,
      });
    } catch (e) {
      console.error("timer-chip positioning failed", e);
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

const AREA_INDICATOR_LABEL = "area-indicator";

// Transparent always-on-top dashed-border window sized to the area's
// screen-space rect. Click-through and hidden from SCK so it never blocks
// interaction or appears in the recording. Shown for the duration of an
// area-mode recording so the user can always see what's being captured.
async function openAreaIndicator(rect: {
  x: number;
  y: number;
  w: number;
  h: number;
}) {
  const existing = await WebviewWindow.getByLabel(AREA_INDICATOR_LABEL);
  if (existing) await existing.close().catch(() => {});

  const monitors = await availableMonitors();
  const primary =
    monitors.find((m) => m.position.x === 0 && m.position.y === 0) ||
    monitors[0];
  const primaryCocoaHeight =
    primary && primary.scaleFactor
      ? primary.size.height / primary.scaleFactor
      : 1080;

  new WebviewWindow(AREA_INDICATOR_LABEL, {
    url: `/#area-indicator`,
    title: "Recording area",
    // Initial size doesn't matter — set_window_frame_cg resizes after
    // creation (same pattern as identify/countdown).
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
      const win = await WebviewWindow.getByLabel(AREA_INDICATOR_LABEL);
      if (win) {
        try {
          await invoke("set_window_frame_cg", {
            label: AREA_INDICATOR_LABEL,
            cgX: rect.x,
            cgY: rect.y,
            width: rect.w,
            height: rect.h,
            primaryCocoaHeight,
          });
          await invoke("make_capture_invisible", { label: AREA_INDICATOR_LABEL });
          await win.setIgnoreCursorEvents(true);
        } catch (e) {
          console.error("[area-indicator] setup failed", e);
        }
        return;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    console.error("[area-indicator] window never registered");
  })();
}

async function closeAreaIndicator() {
  const existing = await WebviewWindow.getByLabel(AREA_INDICATOR_LABEL);
  if (existing) await existing.close().catch(() => {});
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

type ReviewOpenArgs = {
  // Logical scratch identity — what discard/save/clipboard pin against.
  // Always set; for phase 15 c3 webcam recordings the file at this path
  // does not exist (no composited mp4 at finalize), but the path string
  // is still the canonical key.
  scratchPath: string;
  // Phase 15 c3 dual-stream inputs. screenPath is the raw screen capture
  // (sources/screen.mp4 for webcam recordings; scratchPath for screen-
  // only). webcamPath is the c1 concat'd webcam.mp4 — null if no webcam.
  // webcamLeadMs is the calibrated camera-start delay the player applies
  // via currentTime offset.
  screenPath: string;
  webcamPath: string | null;
  webcamLeadMs: number;
};

async function openReview(
  label: string,
  args: ReviewOpenArgs,
  onDestroyed: () => void,
): Promise<void> {
  // Each recording gets its own review window via a unique label
  // (review-<stamp>). Existing reviews stay open in the background — see
  // PHASE-5-CONTEXT.md D-15. The capability scope `review-*` covers them.
  const params = new URLSearchParams({
    path: args.scratchPath,
    screenPath: args.screenPath,
    webcamLeadMs: String(args.webcamLeadMs),
  });
  if (args.webcamPath) {
    params.set("webcamPath", args.webcamPath);
  }
  const url = `/#review?${params.toString()}`;
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
type SourceKind = "display" | "window" | "area";
type EngineState = "idle" | "countdown" | "recording" | "paused";
type CountdownDuration = 0 | 3 | 5;
type LengthCapMode = "off" | "target";
type NrLevel = "off" | "low" | "med" | "high";

type FinalizedRecording = {
  stamp: string;
  scratch_dir: string;
  // Logical key — survives as the param to discard_recording / save /
  // clipboard / linkedin even when no actual composited file exists at
  // this path (phase 15 c3 webcam recordings). save_recording derives
  // raw inputs from this path's parent/sources dir.
  scratch_mp4_path: string;
  // Phase 15 c3 dual-stream player inputs. screen_path always present;
  // webcam_path present iff a webcam was used (concat'd by c1 from
  // segments). webcam_lead_ms mirrors composite::WEBCAM_LEAD_MS so the
  // dual-stream player offsets webcam.currentTime to match composite's
  // tpad behavior at export time.
  screen_path: string;
  webcam_path: string | null;
  webcam_lead_ms: number;
  sources_dir: string | null;
  webcam_segments: string[];
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

// Friendly banner copy per engine error code. Unmapped codes fall back to the
// raw `CODE: message` form; the raw code+message always stay in console.error.
const ERROR_MESSAGES: Record<string, string> = {
  PERMISSION_DENIED:
    "Screen Recording or Microphone permission isn't granted. Grant it in System Settings > Privacy & Security, then try again.",
  DISPLAY_NOT_FOUND: "That display is no longer available. Re-select a display and try again.",
  WINDOW_NOT_FOUND: "That window is no longer available. Re-select a window and try again.",
  MIC_NOT_FOUND: "The selected microphone is no longer available. Pick another mic and try again.",
  OUTPUT_PATH_INVALID: "Couldn't write the recording to disk. Check the destination folder exists and is writable.",
  WRITER_FAILED: "The recording couldn't be saved (writer error). Try again.",
  MIC_NO_FIRST_SAMPLE: "The microphone produced no audio. Check the mic and try recording again.",
  CLOCK_MISMATCH: "Couldn't sync the audio and video clocks. Try recording again.",
  MIC_SESSION_FAILED: "The microphone stopped mid-recording. Your recording was saved up to that point.",
  INVALID_COMMAND: "The recorder received an invalid command. Try again.",
  INVALID_STATE: "The recorder wasn't ready for that action. Try again.",
  INTERNAL: "The recorder hit an unexpected error and had to stop.",
};

function App() {
  const [displays, setDisplays] = useState<Display[]>([]);
  const [windows, setWindows] = useState<WindowSource[]>([]);
  const [mics, setMics] = useState<Mic[]>([]);
  const [cameras, setCameras] = useState<Device[]>([]);
  const [sourceKind, setSourceKind] = useState<SourceKind>("display");
  const [selectedDisplay, setSelectedDisplay] = useState<number | null>(null);
  const [selectedWindow, setSelectedWindow] = useState<number | null>(null);
  const [selectedArea, setSelectedArea] = useState<AreaSelection | null>(null);
  const [selectedMic, setSelectedMic] = useState<string | null>(null);
  const [selectedCamera, setSelectedCamera] = useState<number | null>(null);
  const [countdownDuration, setCountdownDuration] =
    useState<CountdownDuration>(5);
  const [lengthCapMode, setLengthCapMode] = useState<LengthCapMode>("off");
  const [lengthCapTargetSec, setLengthCapTargetSec] = useState<number>(600);
  const [noiseReduction, setNoiseReduction] = useState<NrLevel>("med");
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

  // Load persisted noise-reduction level on launch.
  useEffect(() => {
    invoke<{ noise_reduction?: string }>("get_settings")
      .then((s) => {
        const lvl = s.noise_reduction;
        if (lvl === "off" || lvl === "low" || lvl === "med" || lvl === "high") {
          setNoiseReduction(lvl);
        }
      })
      .catch(() => {});
  }, []);

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
            // Prefer the built-in mic by default: Bluetooth headsets (e.g.
            // AirPods) sort first alphabetically but degrade to low-quality
            // SCO audio while their mic is active, and iPhone Continuity
            // audio is flaky (drops when the phone sleeps). Fall back to
            // any non-Continuity mic, then to whatever exists.
            setSelectedMic((prev) => {
              if (prev) return prev;
              const builtin = mics.find((m) => /built-in|macbook/i.test(m.name));
              const nonContinuity = mics.find(
                (m) => !/iphone|ipad|continuity/i.test(m.name),
              );
              return (builtin ?? nonContinuity ?? mics[0])?.uid ?? null;
            });
            // Don't auto-select a window — empty default forces an explicit
            // pick once the user toggles the Window source.
            // A prior enumerate can have failed on a permission error (see
            // the window-focus retry below) — clear it now that a fresh
            // enumerate actually succeeded, so granting access in System
            // Settings and coming back doesn't leave a stale error banner.
            setError(null);
            break;
          }
          case "started":
            // Pre-warm fires real engine Start; ignore its started event
            // so the UI doesn't flip from countdown to recording mid-warm.
            if (prewarmInFlightRef.current) break;
            setState("recording");
            setProgress({ frames: 0, dropped: 0, elapsed_s: 0 });
            setError(null);
            break;
          case "progress":
            // Same guard — pre-warm produces ~2-3 progress ticks before
            // its Stop fires; those must not surface as real progress.
            if (prewarmInFlightRef.current) break;
            setProgress({ frames: ev.frames, dropped: ev.dropped, elapsed_s: ev.elapsed_s });
            break;
          case "paused":
            setState("paused");
            break;
          case "resumed":
            setState("recording");
            break;
          case "stopped":
            // Pre-warm's Stop emits a stopped event with output_path
            // pointing at the .prewarm- scratch dir. Without this guard
            // the frontend treats the throwaway as a real save: shows
            // a "Saved" toast, calls recording_finalize (which fails
            // since there's no ActiveRecording in Rust state), and
            // opens a review window. The path-filter is intrinsic to
            // the event (no timing race); the ref filter is the primary
            // guard for the 100ms grace window after prewarm_capture
            // settles. Either matching → silently drop.
            if (
              prewarmInFlightRef.current ||
              ev.output_path.includes("/.prewarm-")
            ) {
              break;
            }
            setState("idle");
            incReview();
            setLastSaved(ev.output_path);
            setProgress({ frames: ev.frames, dropped: ev.dropped, elapsed_s: ev.duration_s });
            setCompositeProgress(0);
            // After an area-mode recording: stash the selection and clear
            // it so the persistent dashed border + Start chip go away.
            // The review window's "Record another" can restore it via
            // lastUsedAreaRef; Save/Discard leave it consumed (user
            // redraws next time).
            {
              const c = ctrlRef.current;
              if (c.sourceKind === "area" && c.selectedArea) {
                lastUsedAreaRef.current = c.selectedArea;
                c.setSelectedArea(null);
              }
            }
            invoke<FinalizedRecording>("recording_finalize")
              .then(async (info) => {
                setFinalizeInfo(info);
                await openReview(
                  `review-${info.stamp}`,
                  {
                    scratchPath: info.scratch_mp4_path,
                    screenPath: info.screen_path,
                    webcamPath: info.webcam_path,
                    webcamLeadMs: info.webcam_lead_ms,
                  },
                  decReview,
                );
              })
              .catch((err) => {
                // V2.3 c3.S2 race tolerance: when handleStop and a
                // handleSessionRuntimeError-spawned Task overlap on the
                // engine actor's reentry window, the engine emits BOTH a
                // stopped and an error event for the same recording. Both
                // event handlers invoke recording_finalize; whichever hits
                // the Rust state Mutex first takes it via .take(). The
                // loser returns "no active recording" — silent decrement
                // here, the other handler already saved the recording.
                const errStr = String(err);
                if (errStr === "no active recording") {
                  decReview();
                  return;
                }
                setError(
                  errStr.includes("RECORDING_FAILED_BEFORE_START")
                    ? "Recording couldn't start. Please try again."
                    : errStr,
                );
                decReview();
              })
              .finally(() => {
                setCompositeProgress(null);
              });
            break;
          case "error":
            // Keep the raw code+message in logs regardless of banner copy.
            console.error("[engine] error", ev.code, ev.message);
            setError(ERROR_MESSAGES[ev.code] ?? `${ev.code}: ${ev.message}`);
            // The engine self-resets to idle on any error it emits, so the
            // frontend must NOT send Stop (that would produce a follow-on
            // INVALID_STATE that overwrites the original error).
            setState("idle");
            // V2.3 c3.S2: universal post-error finalize. Replaces the
            // prior MIC_SESSION_FAILED-only salvage branch + the `else`
            // branch's recording_cleanup_local. The old cleanup path
            // discarded whatever was on disk — but when the engine fires
            // a fatal AFTER user Stop (handleStop and handleFatalError
            // racing on the actor's reentry window — see RecordingSession
            // tearDownAfterFatalError running during handleStop's
            // `await s.stop()` suspension), BOTH a stopped and an error
            // event hit App.tsx. The old code routed stopped to finalize
            // but error to cleanup_local, so whichever Tauri command
            // reached the Rust state Mutex first took it. cleanup_local
            // winning meant a real multi-second recording silently
            // discarded ("no active recording" data-loss bug).
            //
            // Universal finalize means both handlers race on the same
            // .take() and both try to SAVE. Whichever wins runs concat
            // and opens review; the loser bails with "no active
            // recording" via the .take()/?-propagation at lib.rs:380-388
            // — proven zero side effects (no file touches, no subprocess
            // spawn, no scratch mutation before the take).
            //
            // c3.S1's RECORDING_FAILED_BEFORE_START sentinel makes
            // recording_finalize safe to call universally: when there's
            // nothing on disk, it bails with that sentinel. The friendly
            // map message set above is accurate for most error codes
            // already; only MIC_SESSION_FAILED's "saved up to that
            // point" text lies on sentinel-bail, so the catch refines
            // banner copy only for that code.
            incReview();
            setCompositeProgress(0);
            invoke<FinalizedRecording>("recording_finalize")
              .then(async (info) => {
                setFinalizeInfo(info);
                await openReview(
                  `review-${info.stamp}`,
                  {
                    scratchPath: info.scratch_mp4_path,
                    screenPath: info.screen_path,
                    webcamPath: info.webcam_path,
                    webcamLeadMs: info.webcam_lead_ms,
                  },
                  decReview,
                );
              })
              .catch((err) => {
                const errStr = String(err);
                if (errStr === "no active recording") {
                  // c3.S2 race tolerance: the stopped handler already
                  // finalized this recording. Silent decrement; the
                  // friendly map banner above is the user-facing message.
                  decReview();
                  return;
                }
                if (
                  errStr.includes("RECORDING_FAILED_BEFORE_START") &&
                  ev.code === "MIC_SESSION_FAILED"
                ) {
                  // Refine only the MIC_SESSION_FAILED friendly text on
                  // sentinel-bail — other codes' friendly map entries
                  // accurately describe their failure already.
                  setError("Recording couldn't start. Please try again.");
                } else if (!errStr.includes("RECORDING_FAILED_BEFORE_START")) {
                  // Unexpected error (not the sentinel, not the race) —
                  // surface verbatim, replacing the friendly map text.
                  setError(errStr);
                }
                decReview();
              })
              .finally(() => {
                setCompositeProgress(null);
              });
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
          ? { ...prev, scratch_mp4_path: finalPath, sources_dir: null }
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
    if (sourceKind === "area" && selectedArea == null) return;
    try {
      setError(null);
      setFinalizeInfo(null);
      setLastSaved(null);

      // Resolve the screen the countdown should land on. Display + area
      // modes use the chosen display directly; window mode picks whichever
      // display contains the captured window's center (falls back to
      // primary). Window mode passes null for recordedDisplay_* — the
      // engine drives bubble fractions off its 5Hz window_frame events
      // instead. Display + area modes pass a screen-space rect: display
      // mode uses the full display; area mode uses the selected sub-region
      // (display origin + area offset, area size).
      const monitors = await availableMonitors();
      let countdownDisplay: Display | undefined;
      if (sourceKind === "display") {
        countdownDisplay = displays.find((d) => d.id === selectedDisplay);
      } else if (sourceKind === "area" && selectedArea) {
        countdownDisplay = displays.find((d) => d.id === selectedArea.display_id);
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
      const fullDisplayFrame: DisplayFrame = {
        x: countdownDisplay?.x ?? monitor?.position.x ?? 0,
        y: countdownDisplay?.y ?? monitor?.position.y ?? 0,
        w: countdownDisplay?.width ?? monitor?.size.width ?? 0,
        h: countdownDisplay?.height ?? monitor?.size.height ?? 0,
        scale: monitor?.scaleFactor ?? 1,
      };
      // recordedRect is the screen-space rect of what's actually being
      // captured — full display for display mode, sub-region for area mode.
      let recordedRect: { x: number; y: number; w: number; h: number } | null = null;
      if (sourceKind === "display" && countdownDisplay) {
        recordedRect = {
          x: countdownDisplay.x,
          y: countdownDisplay.y,
          w: countdownDisplay.width,
          h: countdownDisplay.height,
        };
      } else if (sourceKind === "area" && selectedArea && countdownDisplay) {
        // Rust recordedDisplay_* is i32/u32 — round here so fractional
        // marquee points don't fail Tauri's argument validation.
        recordedRect = {
          x: Math.round(countdownDisplay.x + selectedArea.x),
          y: Math.round(countdownDisplay.y + selectedArea.y),
          w: Math.round(selectedArea.width),
          h: Math.round(selectedArea.height),
        };
      }

      // Countdown clamps to the selected region in area mode (so the user
      // sees what's actually being captured). Display/window modes show
      // the countdown on the host display.
      const countdownFrame: DisplayFrame =
        sourceKind === "area" && recordedRect
          ? { ...recordedRect, scale: fullDisplayFrame.scale }
          : fullDisplayFrame;

      if (countdownDuration > 0) {
        setState("countdown");
        // Per-recording pre-warm runs concurrently with the countdown
        // so its ~1.2s cost is hidden inside the countdown window. The
        // throwaway capture cycle warms macOS framework caches
        // (avfoundation device-open, VTCompressionSession, SCK
        // first-capture-call) that otherwise pay first-call init lag on
        // the first recording of a session, producing the audio-lag
        // sync issue. Best-effort: any failure inside prewarm is logged
        // Rust-side and never blocks the real recording. Skipped when
        // countdown is Off — those users opted out of any delay.
        // Set BEFORE invoke so any engine event from pre-warm sees the
        // ref already true. Cleared 100ms after settle (in either
        // resolve or reject path) to cover late-arriving Tauri events.
        prewarmInFlightRef.current = true;
        const prewarmPromise = invoke("prewarm_capture", {
          displayId:
            sourceKind === "display"
              ? selectedDisplay
              : sourceKind === "area"
              ? selectedArea?.display_id ?? null
              : null,
          windowId: sourceKind === "window" ? selectedWindow : null,
          microphoneUid: selectedMic,
          cameraIndex: selectedCamera,
          maxFps: 30,
          areaX: sourceKind === "area" ? selectedArea?.x ?? null : null,
          areaY: sourceKind === "area" ? selectedArea?.y ?? null : null,
          areaWidth:
            sourceKind === "area" ? selectedArea?.width ?? null : null,
          areaHeight:
            sourceKind === "area" ? selectedArea?.height ?? null : null,
        })
          .catch(() => {
            /* logged Rust-side; pre-warm failure must never block */
          })
          .finally(() => {
            setTimeout(() => {
              prewarmInFlightRef.current = false;
            }, 100);
          });
        // Hard ceiling on the prewarm await. Pre-warm's Rust-side
        // bounded budget is ~1.2s (Track A 500ms + Track B 800+400ms).
        // 1500ms covers normal variance with margin and fires well
        // inside the 3s minimum countdown. If the timeout wins,
        // prewarm_abort short-circuits both tracks and we proceed to
        // the real recording — a wedged pre-warm can never strand the
        // user beyond the countdown window.
        const PREWARM_HARD_TIMEOUT_MS = 1500;
        const prewarmBounded: Promise<"completed" | "timeout"> = Promise.race([
          prewarmPromise.then(() => "completed" as const),
          new Promise<"timeout">((resolve) =>
            setTimeout(() => resolve("timeout"), PREWARM_HARD_TIMEOUT_MS),
          ),
        ]);
        const result = await awaitCountdown(countdownDuration, countdownFrame);
        if (result === "cancelled") {
          // Abort the pre-warm. Drain the bounded promise so the engine
          // has returned to .idle before the next user action.
          invoke("prewarm_abort").catch(() => {});
          await prewarmBounded;
          setState("idle");
          return;
        }
        // Wait for pre-warm to finish (engine back to .idle, scratch
        // cleaned) before the real engine_start fires. With a 3s/5s
        // countdown this has typically already resolved.
        const pwResult = await prewarmBounded;
        if (pwResult === "timeout") {
          // Rust-side pre-warm hit a pathological hang. Abort and
          // proceed — engine_start's actor-serialized state machine
          // will surface any residual INVALID_STATE as a normal error.
          // eslint-disable-next-line no-console
          console.warn("[prewarm] hard timeout — aborting and proceeding");
          invoke("prewarm_abort").catch(() => {});
        }
        playGoSound();
      }

      await invoke<string>("engine_start", {
        displayId:
          sourceKind === "display"
            ? selectedDisplay
            : sourceKind === "area"
            ? selectedArea?.display_id ?? null
            : null,
        windowId: sourceKind === "window" ? selectedWindow : null,
        microphoneUid: selectedMic,
        cameraIndex: selectedCamera,
        maxFps: 30,
        recordedDisplayX: recordedRect?.x ?? null,
        recordedDisplayY: recordedRect?.y ?? null,
        recordedDisplayW: recordedRect?.w ?? null,
        recordedDisplayH: recordedRect?.h ?? null,
        areaX: sourceKind === "area" ? selectedArea?.x ?? null : null,
        areaY: sourceKind === "area" ? selectedArea?.y ?? null : null,
        areaWidth: sourceKind === "area" ? selectedArea?.width ?? null : null,
        areaHeight: sourceKind === "area" ? selectedArea?.height ?? null : null,
      });

      // Area indicator + chip lifecycle is driven by useEffects on
      // sourceKind/selectedArea (so the dashed border persists from
      // marquee-confirm through recording-end), not by start() itself.
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
    sourceKind === "display"
      ? selectedDisplay != null
      : sourceKind === "window"
      ? selectedWindow != null
      : selectedArea != null;
  const ctrlRef = useRef({
    state,
    canStartNow,
    start,
    stop,
    setSelectedCamera,
    setSelectedMic,
    setSelectedDisplay,
    sourceKind,
    selectedArea,
    setSelectedArea,
  });
  ctrlRef.current = {
    state,
    canStartNow,
    start,
    stop,
    setSelectedCamera,
    setSelectedMic,
    setSelectedDisplay,
    sourceKind,
    selectedArea,
    setSelectedArea,
  };
  // Last area selection used by a recording. Persisted across the
  // stop-clears-selection cycle so "Record another" in the review window
  // can restore it without making the user redraw.
  const lastUsedAreaRef = useRef<AreaSelection | null>(null);
  // True while a pre-warm capture cycle is in flight. The engine emits
  // started / progress / stopped events for the throwaway too, and
  // those events flow through the same engine-event listener that
  // drives the real recording's UI state. Without this guard, pre-warm
  // would flip state to "recording" mid-countdown, surface progress
  // counters from the throwaway, and trigger a "Saved" toast +
  // recording_finalize call on the throwaway's stop. Cleared 100ms
  // after prewarm_capture settles to cover any late-arriving Tauri
  // events from the pre-warm window.
  const prewarmInFlightRef = useRef(false);
  // Set true after restoring lastUsedAreaRef; an effect on selectedArea
  // kicks off start() once React commits the restored value.
  const [pendingAreaStart, setPendingAreaStart] = useState(false);

  const openAreaPicker = async () => {
    const shapes: DisplayShape[] = displays.map((d) => ({
      x: d.x,
      y: d.y,
      width: d.width,
      height: d.height,
    }));
    const ids = displays.map((d) => d.id);
    const result = await openMarqueeOverlays(shapes, ids, selectedArea);
    if (result) setSelectedArea(result);
    // On cancel (result null) the prior selection (if any) is preserved
    // per the "selection persists across mode-switches" locked decision.
  };

  // Click handler for the Selected Area picker tile. Routes:
  //  - From display/window -> enter area mode + auto-hide bubble. Open
  //    marquee only when no selection exists (selectionspersists across
  //    mode-switches; switching back doesn't force a redraw).
  //  - Already in area mode -> open marquee (user wants to redraw).
  // The "Bubble auto-hide in Area mode" locked decision: clear camera only
  // on the first entry, not on every re-click. Once the user explicitly
  // re-enables a camera while in area mode, subsequent re-clicks of the
  // tile leave it intact.
  const handleAreaTileClick = () => {
    const wasArea = sourceKind === "area";
    if (!wasArea) {
      setSourceKind("area");
      setSelectedCamera(null);
    }
    if (selectedArea == null || wasArea) {
      void openAreaPicker();
    }
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
        source_kind: sourceKind,
        selected_window: selectedWindow,
        selected_area: selectedArea,
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
    selectedArea,
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
      // Area mode: if the last recording cleared selectedArea on stop,
      // restore it from lastUsedAreaRef before starting. The
      // pendingAreaStart effect picks up the restored value and calls
      // start() after React commits the state update.
      const r = await listen<{}>("record-another", () => {
        const c = ctrlRef.current;
        if (
          c.sourceKind === "area" &&
          c.selectedArea == null &&
          lastUsedAreaRef.current
        ) {
          c.setSelectedArea(lastUsedAreaRef.current);
          setPendingAreaStart(true);
          return;
        }
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

  // Re-enumerate when audio/video hardware connects, drops, or wakes after
  // launch (e.g. AirPods pairing late). WebKit surfaces these as `devicechange`;
  // debounce because a single connect typically fires it several times.
  const deviceChangeTimer = useRef<number | null>(null);
  useEffect(() => {
    const onDeviceChange = () => {
      if (deviceChangeTimer.current !== null)
        window.clearTimeout(deviceChangeTimer.current);
      deviceChangeTimer.current = window.setTimeout(refresh, 250);
    };
    navigator.mediaDevices.addEventListener("devicechange", onDeviceChange);
    return () => {
      navigator.mediaDevices.removeEventListener(
        "devicechange",
        onDeviceChange,
      );
      if (deviceChangeTimer.current !== null)
        window.clearTimeout(deviceChangeTimer.current);
    };
  }, []);

  // Re-enumerate on window focus, but only while a permission error is
  // showing. The most common cause of a failed initial enumerate is Screen
  // Recording not granted yet — unlike Mic/Camera, macOS has no inline
  // "Allow" for it, so the only path is Open System Settings, toggle it on,
  // then switch back to Zeigen. That switch-back is a focus event; without
  // this, the permission error from the first (too-early) enumerate just
  // sits there until something else happens to retry it. The gate matters:
  // an unconditional focus listener re-enumerates on every focus bounce
  // (e.g. the webcam preview window opening after a camera pick), and each
  // SCK enumerate freezes the pickers for seconds and flashes the
  // screen-observation indicator in the menu bar.
  const permissionErrorShowing = error === ERROR_MESSAGES.PERMISSION_DENIED;
  useEffect(() => {
    if (!permissionErrorShowing) return;
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [permissionErrorShowing]);

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
  // wants a webcam in the loop. In area mode anchor the bubble to the
  // selected region's bottom-right corner so an explicitly-re-enabled
  // camera lands INSIDE the recorded rect (otherwise the default primary-
  // display corner may fall outside the area and not appear in the
  // recording).
  useEffect(() => {
    if (!cameraName) {
      closeBubble().catch(() => {});
      return;
    }
    let anchor: BubbleAnchor | null = null;
    if (sourceKind === "area" && selectedArea) {
      const d = displays.find((x) => x.id === selectedArea.display_id);
      if (d) {
        anchor = {
          x: d.x + selectedArea.x,
          y: d.y + selectedArea.y,
          w: selectedArea.width,
          h: selectedArea.height,
        };
      }
    } else if (sourceKind === "display" && selectedDisplay != null) {
      const d = displays.find((x) => x.id === selectedDisplay);
      if (d) {
        anchor = { x: d.x, y: d.y, w: d.width, h: d.height };
      }
    } else if (sourceKind === "window" && selectedWindow != null) {
      const w = windows.find((wn) => wn.id === selectedWindow);
      if (w) {
        anchor = { x: w.x, y: w.y, w: w.width, h: w.height };
      }
    }
    // No source picked yet or lookup miss — fall back to the primary
    // display. The deps below re-fire this effect as soon as the picker
    // resolves, and openBubble's re-anchor logic corrects placement.
    if (!anchor) {
      const m = displays[0];
      if (m) anchor = { x: m.x, y: m.y, w: m.width, h: m.height };
    }
    if (anchor) {
      openBubble(cameraName, anchor).catch((err) => setError(String(err)));
    }
  }, [cameraName, sourceKind, selectedArea, selectedDisplay, selectedWindow, displays, windows]);

  // Dashed-border area indicator persists from marquee-confirm through
  // recording-end. Driven purely by selection state — not by recording
  // state — so the user always sees "this is what will be / is being
  // captured" once they've picked a region. Closes when they leave area
  // mode or clear the selection.
  useEffect(() => {
    if (sourceKind === "area" && selectedArea) {
      const d = displays.find((x) => x.id === selectedArea.display_id);
      if (d) {
        openAreaIndicator({
          x: Math.round(d.x + selectedArea.x),
          y: Math.round(d.y + selectedArea.y),
          w: Math.round(selectedArea.width),
          h: Math.round(selectedArea.height),
        }).catch((e) => console.error("openAreaIndicator failed", e));
      }
    } else {
      closeAreaIndicator().catch(() => {});
    }
  }, [sourceKind, selectedArea, displays]);

  // Timer/control chip lifecycle. Shown:
  //  - in area mode (idle/recording/paused) whenever the bubble isn't
  //    holding the pause/stop controls — chip shows Start when idle and
  //    pause/stop when recording.
  //  - in display/window mode during recording only when there's no
  //    camera (existing pre-Phase-9 behavior — bubble pill takes over
  //    when a camera is selected).
  // Bubble pill only renders during active recording, so an idle area
  // mode with a camera still needs the chip for the Start button.
  useEffect(() => {
    const recActive = state === "recording" || state === "paused";
    const bubbleHasControls = recActive && cameraState !== "none";
    const inAreaWithSel = sourceKind === "area" && selectedArea != null;
    const showChip =
      !bubbleHasControls &&
      (inAreaWithSel || (recActive && cameraState === "none"));
    if (showChip) {
      let anchor: BubbleAnchor | null = null;
      if (inAreaWithSel && selectedArea) {
        const d = displays.find((x) => x.id === selectedArea.display_id);
        if (d) {
          anchor = {
            x: d.x + selectedArea.x,
            y: d.y + selectedArea.y,
            w: selectedArea.width,
            h: selectedArea.height,
          };
        }
      }
      openTimerChip(anchor).catch(() => {});
    } else {
      closeTimerChip().catch(() => {});
    }
  }, [state, cameraState, sourceKind, selectedArea, displays]);

  // The chip window's "Start Recording" button (idle state) emits this
  // event since it lives in a separate window and can't call start()
  // directly. Use ctrlRef to dodge stale closures on canStartNow/state.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    (async () => {
      const fn = await listen("request-area-start", () => {
        const c = ctrlRef.current;
        if (c.state === "idle" && c.canStartNow) {
          c.start();
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

  // Bridge for "Record another" in area mode: setSelectedArea above is
  // async (React commits on next render), so start() needs to wait for
  // the restore to land. This effect fires once selectedArea is back
  // and clears the pending flag.
  useEffect(() => {
    if (pendingAreaStart && selectedArea && state === "idle") {
      setPendingAreaStart(false);
      void start();
    }
  }, [pendingAreaStart, selectedArea, state]);

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
        noiseReduction={noiseReduction}
        onNoiseReduction={(v) => {
          setNoiseReduction(v);
          invoke("set_noise_reduction", { level: v }).catch((e) => setError(String(e)));
        }}
      />

      <SourceTiles
        sourceKind={sourceKind}
        onSourceKind={setSourceKind}
        onAreaClick={handleAreaTileClick}
        selectedArea={selectedArea}
        displays={displays}
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
        ) : sourceKind === "window" ? (
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
        ) : (
          <>
            <RowLabel icon={I.area} label="Area" />
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div
                style={{
                  flex: 1,
                  fontSize: 12.5,
                  color: selectedArea ? "var(--fg-primary)" : "var(--fg-tertiary)",
                  fontFamily: "var(--font-system)",
                }}
              >
                {selectedArea
                  ? (() => {
                      const d = displays.find((x) => x.id === selectedArea.display_id);
                      const name = d?.name ?? `Display ${selectedArea.display_id}`;
                      return `${Math.round(selectedArea.width)} × ${Math.round(selectedArea.height)} on ${name}`;
                    })()
                  : "No area selected"}
              </div>
              <button
                className="btn-ghost"
                onClick={openAreaPicker}
                disabled={recording || displays.length === 0}
                style={{
                  padding: "5px 10px",
                  fontSize: 12,
                  color: "var(--fg-secondary)",
                  flexShrink: 0,
                  opacity: recording || displays.length === 0 ? 0.4 : 1,
                  cursor:
                    recording || displays.length === 0
                      ? "not-allowed"
                      : "pointer",
                }}
              >
                {selectedArea ? "Redraw" : "Select"}
              </button>
            </div>
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
        canStart={state === "idle" && canStartNow}
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
  onAreaClick,
  selectedArea,
  displays,
  disabled,
}: {
  sourceKind: SourceKind;
  onSourceKind: (k: SourceKind) => void;
  onAreaClick: () => void;
  selectedArea: AreaSelection | null;
  displays: Display[];
  disabled: boolean;
}) {
  // Display + Window + Selected Area are wired source kinds. Webcam Only
  // remains a visual placeholder.
  const areaSub = (() => {
    if (sourceKind !== "area") return "Drag a region to record";
    if (!selectedArea) return "Drag to select";
    const display = displays.find((d) => d.id === selectedArea.display_id);
    const dLabel = display?.name ?? `Display ${selectedArea.display_id}`;
    return `${Math.round(selectedArea.width)} × ${Math.round(selectedArea.height)} on ${dLabel}`;
  })();
  const tiles: Array<{
    id: string;
    label: string;
    sub: string;
    icon: React.ReactNode;
    kind?: SourceKind;
    customClick?: () => void;
  }> = [
    { id: "display", label: "Entire Display", sub: "Pick a screen", icon: I.monitor, kind: "display" },
    { id: "window", label: "Window", sub: "Pick an app window", icon: I.window, kind: "window" },
    { id: "area", label: "Selected Area", sub: areaSub, icon: I.area, kind: "area", customClick: onAreaClick },
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
              if (!interactive) return;
              if (s.customClick) s.customClick();
              else if (s.kind) onSourceKind(s.kind);
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
        label="Ready"
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
  noiseReduction,
  onNoiseReduction,
}: {
  hotkey: string;
  onHotkey: (combo: string) => void;
  countdownDuration: CountdownDuration;
  onCountdownDuration: (v: CountdownDuration) => void;
  lengthCapMode: LengthCapMode;
  onLengthCapMode: (v: LengthCapMode) => void;
  lengthCapTargetSec: number;
  onLengthCapTargetSec: (v: number) => void;
  noiseReduction: NrLevel;
  onNoiseReduction: (v: NrLevel) => void;
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
          placeholder="CmdOrCtrl+Shift+P"
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
        Examples: CmdOrCtrl+Shift+P, Alt+Shift+5
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
              type="number"
              min={1}
              max={120}
              aria-label="Length cap minutes"
              value={Math.round(lengthCapTargetSec / 60)}
              onChange={(e) => {
                const m = Math.max(1, Math.min(120, Number(e.target.value) || 1));
                onLengthCapTargetSec(m * 60);
              }}
              style={{
                width: 56,
                background: "var(--bg-input)",
                border: "1px solid var(--border-subtle)",
                borderRadius: "var(--r-sm)",
                color: "var(--fg-primary)",
                fontFamily: "var(--font-mono)",
                fontSize: 12,
                padding: "4px 8px",
                textAlign: "center",
                // Plain typeable field — no select chevron, no spinner arrows.
                appearance: "textfield",
                MozAppearance: "textfield",
                WebkitAppearance: "textfield",
              }}
            />
            <span style={{ color: "var(--fg-tertiary)", fontSize: 11 }}>min</span>
          </>
        )}
      </label>
      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          color: "var(--fg-secondary)",
        }}
      >
        <span style={{ minWidth: 88 }}>Noise reduction</span>
        <div
          role="radiogroup"
          aria-label="Noise reduction"
          style={{
            display: "inline-flex",
            background: "var(--bg-input)",
            border: "1px solid var(--border-subtle)",
            borderRadius: "var(--r-sm)",
            padding: 2,
          }}
        >
          {(["off", "low", "med", "high"] as NrLevel[]).map((v) => {
            const active = noiseReduction === v;
            const label =
              v === "off" ? "Off" : v === "low" ? "Low" : v === "med" ? "Med" : "High";
            return (
              <button
                key={v}
                role="radio"
                aria-checked={active}
                onClick={() => onNoiseReduction(v)}
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
                {label}
              </button>
            );
          })}
        </div>
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
