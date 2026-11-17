import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { WebviewWindow, getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { availableMonitors } from "@tauri-apps/api/window";
import { emit } from "@tauri-apps/api/event";
import { ask, open as openDialog } from "@tauri-apps/plugin-dialog";
import { LogicalSize } from "@tauri-apps/api/dpi";
import "./styles/capture.css";
import { BUBBLE_SIZE_PT, PILL_STRIP_CSS, type BubbleSize } from "./constants/bubble";
import type { LibraryRecording } from "./RecordingsWindow";
import { openRecordingsWindow } from "./openRecordings";
import { recordingName } from "./recordingLabel";
import { captureKey, hotkeyGlyphs } from "./hotkey";
import { startBlockedReason } from "./startReason";

const DEFAULT_HOTKEY = "CmdOrCtrl+Shift+P";

// A capture-window setting remembered across restarts (this window's own
// localStorage; these never leave the frontend).
function useRemembered<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(`zeigen.${key}`);
      return raw == null ? initial : (JSON.parse(raw) as T);
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(`zeigen.${key}`, JSON.stringify(value));
    } catch {
      // Not remembered this time; the setting still applies.
    }
  }, [key, value]);
  return [value, setValue] as const;
}

const BUBBLE_LABEL = "webcam-bubble";
let bubbleDeviceName: string | null = null;

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

  await closeBubbleToolbar();
  if (existing) await existing.close().catch(() => {});
  bubbleDeviceName = deviceName;

  // The S / M / L picked on the bubble's toolbar, remembered in settings.
  const size = await invoke<{ bubble_size?: BubbleSize | null }>("get_settings")
    .then((s) => s.bubble_size ?? "medium")
    .catch(() => "medium" as const);
  const BUBBLE_W = BUBBLE_SIZE_PT[size];
  const BUBBLE_H = BUBBLE_W + PILL_STRIP_CSS;

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
    decorations: false,
    transparent: true,
    alwaysOnTop: true,
    // Fixed size by design. Even without a resize handle in the UI,
    // resizable: true lets macOS edge-drag resize borderless windows.
    resizable: false,
    skipTaskbar: true,
    visibleOnAllWorkspaces: true,
    shadow: false,
    // The bubble is never the frontmost/key window during recording, so the
    // WKWebView's default acceptsFirstMouse=false swallows the first click on
    // the Stop/pause pill as a key-transfer -- hence the "always double-click
    // Stop" bug. Deliver that first click to the DOM instead. (DECISIONS
    // 2026-07-28; separate from the picker key-steal.)
    acceptFirstMouse: true,
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
    } catch (e) {
      console.error("bubble setup failed", e);
    }
    void syncBubbleToolbar();
  });
  win.once("tauri://error", (e) => {
    console.error("bubble window error", e);
  });
}

async function closeBubble() {
  bubbleDeviceName = null;
  await closeBubbleToolbar();
  const existing = await WebviewWindow.getByLabel(BUBBLE_LABEL);
  if (existing) await existing.close().catch(() => {});
}

// The shape / size pill above the bubble (BubbleToolbar.tsx): its own small
// window, open only while the bubble is up AND the app is idle, so it can
// never be on screen during a countdown or a recording. (The engine also
// leaves Zeigen's windows out of display and area recordings, and a window
// recording captures only the picked window's app.)
const TOOLBAR_LABEL = "bubble-toolbar";
const TOOLBAR_W = 196;
const TOOLBAR_H = 42;
let toolbarWanted = false;

async function syncBubbleToolbar() {
  const [bubble, toolbar] = await Promise.all([
    WebviewWindow.getByLabel(BUBBLE_LABEL),
    WebviewWindow.getByLabel(TOOLBAR_LABEL),
  ]);
  if (!toolbarWanted || !bubble) {
    if (toolbar) await closeBubbleToolbar();
    return;
  }
  if (toolbar) return;
  const win = new WebviewWindow(TOOLBAR_LABEL, {
    url: "/#bubble-toolbar",
    title: "Webcam bubble",
    width: TOOLBAR_W,
    height: TOOLBAR_H,
    decorations: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    visibleOnAllWorkspaces: true,
    shadow: false,
    focus: false,
    // Like the bubble: the first click on a button reaches the button.
    acceptFirstMouse: true,
  });
  // Wanted may have flipped while the window was being made.
  win.once("tauri://created", () => {
    if (!toolbarWanted) void closeBubbleToolbar();
  });
}

async function closeBubbleToolbar() {
  await invoke("bubble_hover_stop").catch(() => {});
  const existing = await WebviewWindow.getByLabel(TOOLBAR_LABEL);
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
  // the window at half size on macOS; the picker overlays already work around
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
    } catch (e) {
      console.error("countdown setup failed", e);
    }
  });
  win.once("tauri://error", (e) => {
    console.error("countdown window error", e);
  });
}

type DisplayShape = {
  x: number;
  y: number;
  width: number;
  height: number;
};

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
    // Not frontmost when another app is active, so the WKWebView's default
    // acceptsFirstMouse=false swallows the first click on Start Recording /
    // Stop as a key-transfer -- the "double-click when Zeigen isn't frontmost"
    // bug. Deliver the first click to the DOM. (DECISIONS 2026-07-28.)
    acceptFirstMouse: true,
  });

  win.once("tauri://created", async () => {
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
    // creation (same pattern as the countdown).
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

// Hover pickers (window and display): one transparent always-on-top overlay
// per display, placed with set_window_frame_cg. No overlay is ever focused or
// key: hover and click come from the native cursor poller (`picker-cursor` /
// `picker-click`), which every overlay maps to its own display, so hover works
// on every display (DECISIONS 2026-07-28). Overlays stay visible to screen
// capture on purpose: hiding them from capture hides them on USB-driven
// displays too (CLAUDE.md gotcha); they are closed before any recording.
//
// Resolves with the `<kind>-selected` payload, or null on cancel. Every exit
// (select, cancel, Esc in the main window or in an overlay, a setup error)
// goes through finish(), which stops the poller and closes every overlay.
let pickerOpen = false;
async function runPickerOverlays<T, D extends DisplayShape>(
  kind: "window-picker" | "display-picker",
  displays: D[],
  extraParams: (d: D) => Record<string, string>,
): Promise<T | null> {
  if (displays.length === 0 || pickerOpen) return null;
  pickerOpen = true;
  const labels = displays.map((_, i) => `${kind}-${i}`);
  const unlistens: Array<() => void> = [];
  let resolveFn!: (v: T | null) => void;
  const result = new Promise<T | null>((r) => {
    resolveFn = r;
  });
  let finished = false;
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") finish(null);
  };
  const finish = async (v: T | null) => {
    if (finished) return;
    finished = true;
    void invoke("picker_cursor_stop");
    window.removeEventListener("keydown", onKey);
    unlistens.forEach((u) => u());
    for (const label of labels) {
      const w = await WebviewWindow.getByLabel(label);
      if (w) await w.close().catch(() => {});
    }
    pickerOpen = false;
    resolveFn(v);
  };

  try {
    // The main window is key when its tile is clicked, and stays key (no
    // overlay takes focus), so Esc lands here.
    window.addEventListener("keydown", onKey);
    unlistens.push(await listen<T>(`${kind}-selected`, (e) => finish(e.payload)));
    unlistens.push(await listen(`${kind}-cancelled`, () => finish(null)));
    // Each overlay says when it is listening; restarting the poller (it is
    // idempotent) re-sends the current cursor position, so the display or
    // window under the mouse lights up before the mouse moves.
    unlistens.push(
      await listen("picker-overlay-ready", () => {
        if (!finished) void invoke("picker_cursor_start");
      }),
    );

    const cocoaH = await primaryCocoaHeight();
    for (let i = 0; i < displays.length; i++) {
      const d = displays[i];
      const label = labels[i];
      const params = new URLSearchParams({
        display_index: String(i + 1),
        origin_x: String(d.x),
        origin_y: String(d.y),
        disp_w: String(d.width),
        disp_h: String(d.height),
        ...extraParams(d),
      });
      const old = await WebviewWindow.getByLabel(label);
      if (old) await old.close().catch(() => {});
      new WebviewWindow(label, {
        url: `/#${kind}?${params.toString()}`,
        title: kind === "window-picker" ? "Pick Window" : "Pick Display",
        width: 400,
        height: 400,
        decorations: false,
        transparent: true,
        alwaysOnTop: true,
        skipTaskbar: true,
        resizable: false,
        visibleOnAllWorkspaces: true,
        shadow: false,
        // Never focus/key an overlay: keying one steals key from the others
        // (the priming-click root cause, DECISIONS 2026-07-28).
        focus: false,
      });
      void placeWhenRegistered(label, d, cocoaH);
    }
    void invoke("picker_cursor_start");
  } catch (e) {
    console.error(`[${kind}] setup failed`, e);
    void finish(null);
  }
  return result;
}

// Tauri's constructor x/y drops negative coords on macOS for screens left of
// primary, so place via set_window_frame_cg once the window exists.
async function placeWhenRegistered(label: string, d: DisplayShape, cocoaH: number) {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (await WebviewWindow.getByLabel(label)) {
      await invoke("set_window_frame_cg", {
        label,
        cgX: d.x,
        cgY: d.y,
        width: d.width,
        height: d.height,
        primaryCocoaHeight: cocoaH,
      }).catch((e) => console.error(`[picker] ${label} placement failed`, e));
      return;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  console.error(`[picker] ${label} window never registered`);
}

async function primaryCocoaHeight(): Promise<number> {
  const monitors = await availableMonitors();
  const primary =
    monitors.find((m) => m.position.x === 0 && m.position.y === 0) ||
    monitors[0];
  return primary && primary.scaleFactor
    ? primary.size.height / primary.scaleFactor
    : 1080;
}

// Window picker: each overlay gets the windows on its display, translated to
// display-relative points, plus the full front-to-back occluder stack so it
// can tell when the frontmost window under the cursor is one we didn't
// enumerate. Resolves to the chosen SCWindow id, or null on cancel.
async function openWindowPickerOverlays(
  displays: DisplayShape[],
  windows: WindowSource[],
  stack: StackWindow[],
): Promise<number | null> {
  const on = (r: { x: number; y: number; width: number; height: number }, d: DisplayShape) =>
    r.x < d.x + d.width && r.x + r.width > d.x && r.y < d.y + d.height && r.y + r.height > d.y;
  const picked = await runPickerOverlays<{ id: number }, DisplayShape>("window-picker", displays, (d) => ({
    wins: JSON.stringify(
      windows
        .filter((w) => w.on_screen && on(w, d))
        .map((w) => ({
          id: w.id,
          x: w.x - d.x,
          y: w.y - d.y,
          w: w.width,
          h: w.height,
          app: w.app,
          title: w.title,
          z: w.z,
        })),
    ),
    stack: JSON.stringify(
      stack
        .filter((s) => on(s, d))
        .map((s) => ({ id: s.id, x: s.x - d.x, y: s.y - d.y, w: s.width, h: s.height })),
    ),
  }));
  return picked?.id ?? null;
}

// Display picker: resolves to the chosen display's id, or null on cancel.
async function openDisplayPickerOverlays(displays: Display[]): Promise<number | null> {
  const picked = await runPickerOverlays<{ id: number }, Display>("display-picker", displays, (d) => ({
    id: String(d.id),
    name: d.name,
  }));
  return picked?.id ?? null;
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
  // webcamLeadMs is the webcam's start offset (measured per recording,
  // may be negative) the player applies via currentTime offset.
  screenPath: string;
  webcamPath: string | null;
  webcamLeadMs: number;
  // Capture source, so Review can gate the Corners control for window captures.
  sourceKind: SourceKind;
  // Window's SHORT side in POINTS (SCWindow.frame is point-space). Review turns
  // the ~11pt macOS window-corner radius into a frame fraction (11/pointShort,
  // scale-independent) to clip the window's own rounded corners just inside their
  // arc — otherwise SCK's opaque-black corner fill shows as wedges over a
  // background. null for display/area (no inherent corners) or if unknown.
  windowPointShort: number | null;
  // Reopened from the recordings library: Review keeps the folder on close.
  kept?: boolean;
  // What was recorded; the window title. null for older recordings.
  name: string | null;
  // Shown in Review when the move to the Save to folder failed at finalize.
  moveNote?: string | null;
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
    sourceKind: args.sourceKind,
  });
  if (args.webcamPath) {
    params.set("webcamPath", args.webcamPath);
  }
  if (args.windowPointShort != null) {
    params.set("windowPointShort", String(args.windowPointShort));
  }
  if (args.kept) {
    params.set("kept", "1");
  }
  if (args.moveNote) {
    params.set("moveNote", args.moveNote);
  }
  const url = `/#review?${params.toString()}`;
  const win = new WebviewWindow(label, {
    url,
    title: recordingName(args.name, args.sourceKind),
    width: 1280,
    height: 860,
    minWidth: 720,
    minHeight: 640,
    resizable: true,
    center: true,
    // Heavily-used editor with many buttons; requiring an activating click
    // first (normal macOS) is friction with no upside here. Deliver the first
    // click. (DECISIONS 2026-07-28; same family as the recording-control fix.)
    acceptFirstMouse: true,
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
  // Front-to-back stacking index from the engine (0 = frontmost). Used by
  // the hover picker to resolve the frontmost window under the cursor.
  z: number;
};
// One entry in the full front-to-back stack of on-screen layer-0 windows
// (index 0 = frontmost), pickable or not. The picker uses it to detect when
// the frontmost window under the cursor is one we didn't enumerate.
type StackWindow = {
  id: number;
  x: number;
  y: number;
  width: number;
  height: number;
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
  // clipboard even when no actual composited file exists at
  // this path (phase 15 c3 webcam recordings). save_recording derives
  // raw inputs from this path's parent/sources dir.
  scratch_mp4_path: string;
  // Phase 15 c3 dual-stream player inputs. screen_path always present;
  // webcam_path present iff a webcam was used (concat'd by c1 from
  // segments). webcam_lead_ms is the measured lead also written to the
  // sidecar for the export (composite::WEBCAM_LEAD_MS when unmeasured).
  screen_path: string;
  webcam_path: string | null;
  webcam_lead_ms: number;
  sources_dir: string | null;
  name: string | null;
  // Set when the recording could not be moved to the Save to folder.
  move_note: string | null;
};

// Where recordings and exports go now (storage.rs, storage_status).
type StorageStatus = {
  destination: string;
  chosen: string | null;
  chosen_available: boolean;
  warning: string | null;
};

type EngineEvent =
  | { event: "ready"; version: string }
  | { event: "enumerated"; displays: Display[]; microphones: Mic[]; windows: WindowSource[]; window_stack?: StackWindow[] }
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
  | { event: "stream_stopped" }
  | { event: "error"; code: string; message: string };

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
  CURSOR_TRACK_FAILED: "The cursor couldn't be recorded, so this recording has no cursor.",
  INVALID_COMMAND: "The recorder received an invalid command. Try again.",
  INVALID_STATE: "The recorder wasn't ready for that action. Try again.",
  INTERNAL: "The recorder hit an unexpected error and had to stop.",
};

// Trigger a fresh engine enumerate and resolve with THAT result, so the
// picker sees the current window z-order instead of whatever the last mount /
// hardware-change enumerate left in state (a stale stack is what made a
// maximized window shadow everything behind it). Resolves null on timeout or
// a failed invoke (e.g. permission denied) so the caller falls back to cached
// state rather than hanging.
type FreshEnum = {
  displays: Display[];
  windows: WindowSource[];
  windowStack: StackWindow[];
};
async function freshEnumerate(): Promise<FreshEnum | null> {
  let resolveFn!: (v: FreshEnum | null) => void;
  const done = new Promise<FreshEnum | null>((r) => {
    resolveFn = r;
  });
  const unlisten = await listen<EngineEvent>("engine-event", (e) => {
    if (e.payload.event !== "enumerated") return;
    const ev = e.payload;
    resolveFn({
      displays: ev.displays,
      windows: ev.windows ?? [],
      windowStack: ev.window_stack ?? [],
    });
  });
  const timer = setTimeout(() => resolveFn(null), 2000);
  try {
    await invoke("engine_enumerate");
  } catch {
    resolveFn(null);
  }
  try {
    return await done;
  } finally {
    clearTimeout(timer);
    unlisten();
  }
}

function App() {
  const [displays, setDisplays] = useState<Display[]>([]);
  const [windows, setWindows] = useState<WindowSource[]>([]);
  const [windowStack, setWindowStack] = useState<StackWindow[]>([]);
  const [mics, setMics] = useState<Mic[]>([]);
  const [cameras, setCameras] = useState<Device[]>([]);
  const [sourceKind, setSourceKind] = useState<SourceKind>("display");
  const [selectedDisplay, setSelectedDisplay] = useState<number | null>(null);
  const [selectedWindow, setSelectedWindow] = useState<number | null>(null);
  const [selectedArea, setSelectedArea] = useState<AreaSelection | null>(null);
  const [selectedMic, setSelectedMic] = useState<string | null>(null);
  const [selectedCamera, setSelectedCamera] = useState<number | null>(null);
  const [countdownDuration, setCountdownDuration] = useRemembered<CountdownDuration>("countdown", 5);
  const [lengthCapMode, setLengthCapMode] = useRemembered<LengthCapMode>("lengthCapMode", "off");
  const [lengthCapTargetSec, setLengthCapTargetSec] = useRemembered<number>("lengthCapTargetSec", 600);
  const [noiseReduction, setNoiseReduction] = useState<NrLevel>("med");
  const [state, setState] = useState<EngineState>("idle");
  // Start pressed; cleared once the state leaves idle (or the start fails).
  const [starting, setStarting] = useState(false);
  useEffect(() => {
    if (state !== "idle") setStarting(false);
  }, [state]);
  const [progress, setProgress] = useState({ frames: 0, dropped: 0, elapsed_s: 0 });
  const [lastSaved, setLastSaved] = useState<string | null>(null);
  const [finalizeInfo, setFinalizeInfo] = useState<FinalizedRecording | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hotkey, setHotkey] = useRemembered<string>("hotkey", DEFAULT_HOTKEY);
  // The backend registers the default at launch; put the remembered one back.
  useEffect(() => {
    if (hotkey === DEFAULT_HOTKEY) return;
    invoke("set_hotkey", { combo: hotkey }).catch((e) => {
      setHotkey(DEFAULT_HOTKEY);
      setError(`Couldn't restore the hotkey: ${e}`);
    });
    // Once, at launch: later changes go through Settings.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // The Save to folder's state, re-checked on focus and at Record.
  const [storage, setStorage] = useState<StorageStatus | null>(null);
  const refreshStorage = () =>
    invoke<StorageStatus>("storage_status")
      .then(setStorage)
      .catch((e) => setError(String(e)));
  useEffect(() => {
    void refreshStorage();
    window.addEventListener("focus", refreshStorage);
    return () => window.removeEventListener("focus", refreshStorage);
  }, []);
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

  // Load the persisted noise-reduction level on launch.
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
            // Main display first, then left to right; the picker follows
            // this order.
            const displays = [...ev.displays].sort(
              (a, b) =>
                Number(b.x === 0 && b.y === 0) - Number(a.x === 0 && a.y === 0) ||
                a.x - b.x ||
                a.y - b.y,
            );
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
            setWindowStack(ev.window_stack ?? []);
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
          case "stream_stopped":
            // macOS ended the screen capture (the stop button in the menu-bar
            // screen-sharing menu). Same as pressing Stop: Review opens with
            // what was captured.
            invoke("engine_stop").catch((e) => setError(String(e)));
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
                    // ctrlRef, not the closure var: this listener is registered
                    // once (empty-deps), so the bare `sourceKind` here is frozen at
                    // its mount value ("display") and every capture — window
                    // included — would open Review as a display, defeating the
                    // Corners gating. ctrlRef.current stays live (see the area
                    // check above).
                    sourceKind: ctrlRef.current.sourceKind,
                    windowPointShort: ctrlRef.current.windowPointShort,
                    name: info.name,
                    moveNote: info.move_note,
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
                    // ctrlRef, not the closure var: this listener is registered
                    // once (empty-deps), so the bare `sourceKind` here is frozen at
                    // its mount value ("display") and every capture — window
                    // included — would open Review as a display, defeating the
                    // Corners gating. ctrlRef.current stays live (see the area
                    // check above).
                    sourceKind: ctrlRef.current.sourceKind,
                    windowPointShort: ctrlRef.current.windowPointShort,
                    name: info.name,
                    moveNote: info.move_note,
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
    // scratch path to the actual exported file in the Save to folder.
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
    // Hides the bubble toolbar at once, before the countdown (or, with the
    // countdown off, the engine's started event) changes state.
    setStarting(true);
    try {
      setError(null);
      setFinalizeInfo(null);
      setLastSaved(null);
      // Shows the warning above Start when the Save to folder is unavailable;
      // the recording goes ahead into ~/Movies/Zeigen.
      void refreshStorage();

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

      // The webcam recorder opens the camera by name (the picker's indices
      // are ffmpeg's and only identify it here).
      const recordCamera =
        selectedCamera == null
          ? null
          : cameras.find((c) => c.index === selectedCamera)?.name ?? null;

      // What is being recorded: Review's window title and the Recordings
      // list's main line.
      let recordingName: string | null = null;
      if (sourceKind === "window") {
        const w = windows.find((x) => x.id === selectedWindow);
        // Many apps already put their name in the window title.
        if (w) {
          const hasApp = w.title.toLowerCase().includes(w.app.toLowerCase());
          recordingName = `${!w.title ? w.app : hasApp ? w.title : `${w.app} - ${w.title}`} (Window)`;
        }
      } else if (countdownDisplay) {
        recordingName = `${countdownDisplay.name} (${sourceKind === "area" ? "Area" : "Display"})`;
      }

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
          cameraName: recordCamera,
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
          setStarting(false);
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
        cameraName: recordCamera,
        maxFps: 30,
        recordedDisplayX: recordedRect?.x ?? null,
        recordedDisplayY: recordedRect?.y ?? null,
        recordedDisplayW: recordedRect?.w ?? null,
        recordedDisplayH: recordedRect?.h ?? null,
        areaX: sourceKind === "area" ? selectedArea?.x ?? null : null,
        areaY: sourceKind === "area" ? selectedArea?.y ?? null : null,
        areaWidth: sourceKind === "area" ? selectedArea?.width ?? null : null,
        areaHeight: sourceKind === "area" ? selectedArea?.height ?? null : null,
        name: recordingName,
      });

      // Area indicator + chip lifecycle is driven by useEffects on
      // sourceKind/selectedArea (so the dashed border persists from
      // marquee-confirm through recording-end), not by start() itself.
    } catch (err) {
      setState("idle");
      setStarting(false);
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
  // Short side (points) of the window being recorded — Review uses it to size the
  // corner-clip radius. null unless a window is the source and its dims are known.
  const windowPointShort =
    sourceKind === "window" && selectedWindow != null
      ? (() => {
          const w = windows.find((x) => x.id === selectedWindow);
          return w ? Math.min(w.width, w.height) : null;
        })()
      : null;
  const ctrlRef = useRef({
    state,
    canStartNow,
    start,
    stop,
    setSelectedCamera,
    setSelectedMic,
    setSelectedDisplay,
    sourceKind,
    windowPointShort,
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
    windowPointShort,
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

  // Live-hover window picker: highlight the window under the cursor across all
  // displays, click to select it (returns here and sets the Window source),
  // click empty space or Cancel to dismiss.
  const openWindowPicker = async () => {
    // Re-enumerate on open so the hit-test uses the CURRENT z-order, not the
    // frozen mount/hardware-change snapshot. Block on the fresh result (no
    // spinner — the small enumerate latency is honest); fall back to cached
    // state if it times out or fails.
    const t0 = performance.now();
    const fresh = await freshEnumerate();
    console.info(
      `[window-picker] re-enumerate ${(performance.now() - t0).toFixed(0)}ms${
        fresh ? "" : " (timeout/failed, using cached)"
      }`,
    );
    const src = fresh ?? { displays, windows, windowStack };
    const shapes: DisplayShape[] = src.displays.map((d) => ({
      x: d.x,
      y: d.y,
      width: d.width,
      height: d.height,
    }));
    const picked = await openWindowPickerOverlays(
      shapes,
      src.windows,
      src.windowStack,
    );
    if (picked != null) setSelectedWindow(picked);
    // On cancel (null) the prior selection is left untouched.
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
    let unlistenOpenRecording: (() => void) | null = null;
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
        } else if (id === "recordings") {
          openRecordingsWindow().catch(() => {});
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
      // The Recordings window's Open: reopen a kept recording in Review the
      // same way a fresh one opens, flagged kept so closing it keeps the
      // folder. One window per recording; a second Open focuses it.
      // libraryOpen covers the gap before a just-created window is findable.
      const libraryOpen = new Set<string>();
      const o = await listen<LibraryRecording>("open-recording", async (e) => {
        if (ctrlRef.current.state !== "idle") return;
        const rec = e.payload;
        const label = `review-${rec.stamp}`;
        // Already open (reopened earlier, or still open from its recording):
        // bring that window to the front.
        if (await invoke<boolean>("focus_window", { label })) return;
        if (libraryOpen.has(label)) return;
        libraryOpen.add(label);
        incReview();
        await openReview(
          label,
          {
            scratchPath: rec.scratch_mp4_path,
            screenPath: rec.screen_path,
            webcamPath: rec.webcam_path,
            webcamLeadMs: rec.webcam_lead_ms,
            sourceKind: rec.source_kind as SourceKind,
            windowPointShort: null,
            kept: true,
            name: rec.name,
          },
          () => {
            libraryOpen.delete(label);
            decReview();
          },
        );
      });
      if (cancelled) {
        a();
        b();
        r();
        o();
        return;
      }
      unlistenTray = a;
      unlistenHotkey = b;
      unlistenRecordAnother = r;
      unlistenOpenRecording = o;
    })();

    return () => {
      cancelled = true;
      unlistenTray?.();
      unlistenHotkey?.();
      unlistenRecordAnother?.();
      unlistenOpenRecording?.();
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
  // paused alike); close when camera is deselected or while a review
  // window is up — the preview has nothing to preview once the take is
  // done, and it would float over the review UI. It reopens on the same
  // camera when the review closes. The timer chip and control pill inside
  // the bubble are gated on recording state — see WebcamBubble.tsx — but
  // the window itself persists as long as the user wants a webcam in the
  // loop. In area mode anchor the bubble to the selected region's
  // bottom-right corner so an explicitly-re-enabled camera lands INSIDE
  // the recorded rect (otherwise the default primary-display corner may
  // fall outside the area and not appear in the recording).
  useEffect(() => {
    if (!cameraName || reviewActivity > 0) {
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
  }, [cameraName, reviewActivity, sourceKind, selectedArea, selectedDisplay, selectedWindow, displays, windows]);

  // The bubble's shape / size toolbar exists only while idle with a bubble up.
  const toolbarOn = cameraName != null && reviewActivity === 0 && state === "idle" && !starting;
  useEffect(() => {
    toolbarWanted = toolbarOn;
    void syncBubbleToolbar();
  }, [toolbarOn]);

  // The bubble's hover close button. The bubble window can't reach this
  // window's state directly, so it emits an event; treat it exactly like
  // picking "Off" in the camera dropdown (the lifecycle effect above then
  // closes the window, and the dropdown stays in sync).
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    listen("bubble-close-request", () => setSelectedCamera(null)).then((f) => {
      unlisten = f;
    });
    return () => {
      unlisten?.();
    };
  }, []);

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

  // Display tile: switch to display and, with more than one display, hover-
  // pick one across all of them (a cancel keeps the previous pick).
  const handleDisplayTileClick = async () => {
    setSourceKind("display");
    if (displays.length <= 1) {
      if (displays[0]) setSelectedDisplay(displays[0].id);
      return;
    }
    const picked = await openDisplayPickerOverlays(displays);
    if (picked != null) setSelectedDisplay(picked);
  };

  // Window tile: switch to window and start the hover picker straight away.
  const handleWindowTileClick = () => {
    setSourceKind("window");
    openWindowPicker().catch((e) => setError(String(e)));
  };

  // The device rows' On pill restores the last device chosen this session,
  // or the first available one.
  const lastCameraName = useRef<string | null>(null);
  if (cameraName) lastCameraName.current = cameraName;
  const lastMicUid = useRef<string | null>(null);
  if (selectedMic) lastMicUid.current = selectedMic;
  const offCamera =
    cameras.find((c) => c.name === lastCameraName.current) ?? cameras[0] ?? null;
  const offMic = mics.find((m) => m.uid === lastMicUid.current) ?? mics[0] ?? null;

  // The window is 380x600 (tauri.conf.json) and grows to fit when a state
  // needs more height (a long error, the settings view) instead of scrolling.
  const [view, setView] = useState<"main" | "settings">("main");
  const topRef = useRef<HTMLDivElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    let lastH = WINDOW_H;
    const fit = () => {
      const need =
        (topRef.current?.offsetHeight ?? 0) + (bottomRef.current?.offsetHeight ?? 0) + 32;
      const h = Math.max(WINDOW_H, Math.ceil(need));
      if (h === lastH) return;
      lastH = h;
      getCurrentWebviewWindow()
        .setSize(new LogicalSize(WINDOW_W, h))
        .catch(() => {});
    };
    const ro = new ResizeObserver(fit);
    if (topRef.current) ro.observe(topRef.current);
    if (bottomRef.current) ro.observe(bottomRef.current);
    return () => ro.disconnect();
  }, [view]);

  const busy = recording || state === "countdown";
  const pickDisabled = recording || displays.length === 0;

  if (view === "settings") {
    return (
      <main className="cap accent-blue">
        <div ref={topRef}>
          <div className="cap-header left" data-tauri-drag-region>
            <button
              className="cap-icon-btn"
              aria-label="Back"
              title="Back"
              onClick={() => setView("main")}
            >
              {Glyph.back}
            </button>
          </div>
          <h1 className="cap-title">Settings</h1>
          <SettingsView
            hotkey={hotkey}
            onHotkey={async (combo) => {
              await invoke("set_hotkey", { combo });
              setHotkey(combo);
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
            onRefresh={refresh}
            storage={storage}
            saveDirLocked={busy}
            onStorageChanged={refreshStorage}
          />
        </div>
        <div style={{ flex: 1 }} />
        <div ref={bottomRef}>
          <StatusLine
            error={error}
            warning={storage?.warning ?? null}
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
        </div>
      </main>
    );
  }

  const pick = (() => {
    if (sourceKind === "display") {
      const d = displays.find((x) => x.id === selectedDisplay);
      return d ? d.name : "Choose a display";
    }
    if (sourceKind === "window") {
      const w = windows.find((x) => x.id === selectedWindow);
      return w ? windowLabel(w) : windows.length ? "Choose a window" : "No windows available";
    }
    if (!selectedArea) return "No area selected";
    const d = displays.find((x) => x.id === selectedArea.display_id);
    return `${Math.round(selectedArea.width)} x ${Math.round(selectedArea.height)} on ${
      d?.name ?? `Display ${selectedArea.display_id}`
    }`;
  })();
  const blockedReason = startBlockedReason({
    state,
    sourceKind,
    picked: canStartNow,
    displays: displays.length,
    windows: windows.length,
    permissionDenied: error === ERROR_MESSAGES.PERMISSION_DENIED,
  });
  const hasPick =
    sourceKind === "display"
      ? selectedDisplay != null
      : sourceKind === "window"
      ? windows.some((w) => w.id === selectedWindow)
      : selectedArea != null;

  return (
    <main className="cap accent-blue">
      {compositeProgress !== null && (
        <CompositeProgressOverlay value={compositeProgress} />
      )}

      <div ref={topRef}>
        <div className="cap-header" data-tauri-drag-region>
          <button
            className="cap-icon-btn"
            aria-label="Recordings"
            title="Recordings"
            onClick={() => openRecordingsWindow().catch(() => {})}
          >
            {Glyph.recordings}
          </button>
          <button
            className="cap-icon-btn"
            aria-label="Settings"
            title="Settings"
            onClick={() => setView("settings")}
          >
            {Glyph.gear}
          </button>
        </div>

        <div className="cap-brand">
          <ZeigenMark />
          <span className="cap-brand-name">Zeigen</span>
          {recording && (
            <span className="cap-rec-chip">
              <span className="rec-dot" /> {state === "paused" ? "Paused" : "REC"}{" "}
              {fmtTime(progress.elapsed_s)}
            </span>
          )}
        </div>

        <section className="cap-section">
          <span className="cap-label">Record</span>
          <div className="cap-tiles">
            <SourceTile
              label="Display"
              icon={Glyph.display}
              on={sourceKind === "display"}
              disabled={recording}
              onClick={() => handleDisplayTileClick().catch((e) => setError(String(e)))}
            />
            <SourceTile
              label="Window"
              icon={Glyph.window}
              on={sourceKind === "window"}
              disabled={recording}
              onClick={handleWindowTileClick}
            />
            <SourceTile
              label="Area"
              icon={Glyph.area}
              on={sourceKind === "area"}
              disabled={recording}
              onClick={handleAreaTileClick}
            />
          </div>

          <div className="cap-pickline">
            <div className={`cap-pick${hasPick ? "" : " empty"}${pickDisabled ? " disabled" : ""}`}>
              <span className="cap-pick-text">{pick}</span>
              {sourceKind !== "area" && Glyph.chevron}
              {sourceKind === "display" ? (
                <select
                  className="cap-overlay-select"
                  aria-label="Display"
                  value={selectedDisplay ?? ""}
                  onChange={(e) => setSelectedDisplay(Number(e.target.value))}
                  disabled={pickDisabled}
                >
                  {displays.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}, {d.width} x {d.height}
                    </option>
                  ))}
                </select>
              ) : sourceKind === "window" ? (
                <select
                  className="cap-overlay-select"
                  aria-label="Window"
                  value={selectedWindow ?? ""}
                  onChange={(e) =>
                    setSelectedWindow(e.target.value === "" ? null : Number(e.target.value))
                  }
                  disabled={recording || windows.length === 0}
                >
                  <option value="" disabled>
                    Choose a window
                  </option>
                  {windows.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.app} - {w.title.trim() || "Untitled"}
                    </option>
                  ))}
                </select>
              ) : null}
            </div>
            {sourceKind === "area" && (
              <button className="cap-text-btn" onClick={openAreaPicker} disabled={pickDisabled}>
                {selectedArea ? "Redraw" : "Select"}
              </button>
            )}
          </div>
        </section>

        <section className="cap-section devices">
          <span className="cap-label">Camera and microphone</span>
          <DeviceRow
            kind="Camera"
            icon={Glyph.camera}
            on={cameraName != null}
            name={cameraName ?? offCamera?.name ?? "No camera found"}
            options={cameras.map((c) => ({ value: String(c.index), label: c.name }))}
            value={selectedCamera == null ? "" : String(selectedCamera)}
            onPick={(v) => setSelectedCamera(Number(v))}
            onToggle={() => setSelectedCamera(cameraName != null ? null : offCamera?.index ?? null)}
            disabled={recording}
          />
          <DeviceRow
            kind="Microphone"
            icon={Glyph.mic}
            on={selectedMic != null}
            name={
              mics.find((m) => m.uid === selectedMic)?.name ?? offMic?.name ?? "No microphone found"
            }
            options={mics.map((m) => ({ value: m.uid, label: m.name }))}
            value={selectedMic ?? ""}
            onPick={(v) => setSelectedMic(v)}
            onToggle={() => setSelectedMic(selectedMic != null ? null : offMic?.uid ?? null)}
            disabled={recording}
          />
        </section>
      </div>

      <div style={{ flex: 1 }} />

      <div ref={bottomRef}>
        <StatusLine
          error={error}
          warning={storage?.warning ?? null}
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
        {recording ? (
          <button className="cap-start stop" onClick={stop} disabled={state === "paused"}>
            <span className="cap-start-dot square" aria-hidden="true" />
            Stop
            <span className="cap-start-time">{fmtTime(progress.elapsed_s)}</span>
          </button>
        ) : (
          <button
            className="cap-start"
            onClick={start}
            disabled={state !== "idle" || !canStartNow}
          >
            <span className="cap-start-dot" aria-hidden="true" />
            {state === "countdown" ? "Starting" : "Start recording"}
            <span className="cap-start-key">{hotkeyGlyphs(hotkey)}</span>
          </button>
        )}
        <div className="cap-foot">
          {/* Why Start is disabled, when it is; otherwise what Start will do. */}
          {blockedReason ??
            `${countdownDuration === 0 ? "No countdown" : `${countdownDuration} s countdown`} · saves to ${
              storage?.destination ?? "~/Movies/Zeigen"
            }`}
        </div>
      </div>
    </main>
  );
}

const WINDOW_W = 380;
const WINDOW_H = 600;

function windowLabel(w: WindowSource): string {
  const t = w.title.trim();
  return t ? `${w.app} - ${t}` : w.app;
}

// Line icons from the capture-compact mockup (24x24, stroke).
const svg24 = (children: React.ReactNode, size = 17) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.7}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {children}
  </svg>
);
const Glyph = {
  recordings: svg24(
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m10 9 5 3-5 3z" />
    </>,
  ),
  gear: svg24(
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </>,
  ),
  back: svg24(<path d="m15 6-6 6 6 6" />),
  display: svg24(
    <>
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M8 20h8M12 16v4" />
    </>,
    20,
  ),
  window: svg24(
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 9h18" />
    </>,
    20,
  ),
  area: svg24(
    <path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3" />,
    20,
  ),
  camera: svg24(
    <>
      <rect x="3" y="6" width="13" height="12" rx="2" />
      <path d="m16 10 5-3v10l-5-3" />
    </>,
    16,
  ),
  mic: svg24(
    <>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </>,
    16,
  ),
  chevron: svg24(<path d="m6 9 6 6 6-6" />, 12),
};

function ZeigenMark() {
  return (
    <svg width="30" height="30" viewBox="0 0 120 120" aria-hidden="true" style={{ flexShrink: 0 }}>
      <rect x="6" y="6" width="108" height="108" rx="26" fill="var(--accent)" />
      <path d="M28 32 H92 V46 L48 78 H92 V92 H28 V78 L72 46 H28 Z" fill="var(--accent-fg)" />
    </svg>
  );
}

function SourceTile({
  label,
  icon,
  on,
  disabled,
  onClick,
}: {
  label: string;
  icon: React.ReactNode;
  on: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`cap-tile${on ? " on" : ""}`}
      aria-pressed={on}
      disabled={disabled}
      onClick={onClick}
    >
      {icon}
      {label}
    </button>
  );
}

// One device: its name over a transparent native <select> (click the row to
// choose) and an On/Off pill above it. Off is "no device"; the select's value
// is "" then, so choosing any device (even the one shown) turns it on.
function DeviceRow({
  kind,
  icon,
  on,
  name,
  options,
  value,
  onPick,
  onToggle,
  disabled,
}: {
  kind: string;
  icon: React.ReactNode;
  on: boolean;
  name: string;
  options: Array<{ value: string; label: string }>;
  value: string;
  onPick: (v: string) => void;
  onToggle: () => void;
  disabled: boolean;
}) {
  const empty = options.length === 0;
  return (
    <div className={`cap-device${on ? "" : " off"}${disabled ? " disabled" : ""}`}>
      <span className="cap-device-icon">{icon}</span>
      <span className="cap-device-name">{name}</span>
      <select
        className="cap-overlay-select"
        aria-label={kind}
        value={value}
        onChange={(e) => onPick(e.target.value)}
        disabled={disabled || empty}
      >
        <option value="" disabled>
          {kind} off
        </option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <button
        className={`cap-pill${on ? "" : " off"}`}
        aria-label={`${kind} ${on ? "on" : "off"}`}
        aria-pressed={on}
        onClick={onToggle}
        disabled={disabled || (empty && !on)}
      >
        {on ? "On" : "Off"}
      </button>
    </div>
  );
}

function StatusLine({
  error,
  warning,
  lastSaved,
  finalizeInfo,
  progress,
  state,
  onDismiss,
}: {
  error: string | null;
  // The Save to folder is unavailable; quiet, no dismiss (it clears itself).
  warning: string | null;
  lastSaved: string | null;
  finalizeInfo: FinalizedRecording | null;
  progress: { frames: number; dropped: number; elapsed_s: number };
  state: EngineState;
  onDismiss: () => void;
}) {
  let tone: "error" | "success" | "muted";
  let label: string;
  let body: string;
  let path = false;
  if (error) {
    [tone, label, body] = ["error", "Error", error];
  } else if (state !== "idle" && progress.dropped > 0) {
    [tone, label, body] = ["muted", "Frames dropped", `${progress.dropped} of ${progress.frames}`];
  } else if (warning) {
    [tone, label, body] = ["muted", "Save to", warning];
  } else if (state === "idle" && finalizeInfo) {
    [tone, label, body, path] = ["success", "Ready", finalizeInfo.scratch_mp4_path, true];
  } else if (state === "idle" && lastSaved) {
    [tone, label, body, path] = ["success", "Saved", lastSaved, true];
  } else {
    return null;
  }
  return (
    <div className={`cap-status ${tone}`} role={tone === "error" ? "alert" : undefined}>
      <span className="cap-status-label">{label}</span>
      <span className={`cap-status-body${path ? " path" : ""}`} title={body}>
        {body}
      </span>
      {tone !== "muted" && (
        <button className="cap-status-x" onClick={onDismiss} aria-label="Dismiss">
          ×
        </button>
      )}
    </div>
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
        padding: 16,
        background: "var(--bg-overlay-medium)",
      }}
    >
      <div style={{ width: "100%", display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>Compositing recording</div>
        <div
          style={{
            position: "relative",
            height: 6,
            borderRadius: 99,
            background: "var(--bg-control-on)",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              position: "absolute",
              inset: 0,
              right: "auto",
              width: `${pct}%`,
              background: "var(--accent-bright)",
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

function SettingsView({
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
  onRefresh,
  storage,
  saveDirLocked,
  onStorageChanged,
}: {
  hotkey: string;
  // Registers the combination; rejects (keeping the old one) when it can't.
  onHotkey: (combo: string) => Promise<void>;
  countdownDuration: CountdownDuration;
  onCountdownDuration: (v: CountdownDuration) => void;
  lengthCapMode: LengthCapMode;
  onLengthCapMode: (v: LengthCapMode) => void;
  lengthCapTargetSec: number;
  onLengthCapTargetSec: (v: number) => void;
  noiseReduction: NrLevel;
  onNoiseReduction: (v: NrLevel) => void;
  onRefresh: () => void;
  storage: StorageStatus | null;
  saveDirLocked: boolean;
  onStorageChanged: () => Promise<void>;
}) {
  // "Moving 9 recordings…", then the result, or why the folder was refused.
  const [moveText, setMoveText] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);
  // path null = back to ~/Movies/Zeigen. After the change, offers to move the
  // recordings in the old library; Leave touches nothing.
  const changeSaveDir = async (path: string | null) => {
    setMoveText(null);
    try {
      const offer = await invoke<{ from: string; count: number; bytes: number } | null>(
        "set_save_dir",
        { path },
      );
      await onStorageChanged();
      if (!offer) return;
      const what = offer.count === 1 ? "recording" : `${offer.count} recordings`;
      const move = await ask(`Move your ${what} (${fmtBytes(offer.bytes)}) to the new folder?`, {
        title: "Move recordings?",
        okLabel: "Move",
        cancelLabel: "Leave",
      });
      if (!move) return;
      setMoving(true);
      setMoveText(`Moving ${offer.count === 1 ? "1 recording" : what}…`);
      setMoveText(await invoke<string>("move_recordings", { from: offer.from }));
    } catch (e) {
      setMoveText(String(e));
    } finally {
      setMoving(false);
    }
  };
  const chooseSaveDir = async () => {
    const picked = await openDialog({ directory: true, multiple: false, title: "Save to" });
    if (typeof picked === "string") await changeSaveDir(picked);
  };
  const saveDirFixed = saveDirLocked || moving;
  return (
    <div>
      <div className="cap-set-row">
        <span className="cap-label">Start and stop hotkey</span>
        <HotkeyRecorder hotkey={hotkey} onHotkey={onHotkey} />
      </div>

      <div className="cap-set-row">
        <span className="cap-label">Countdown</span>
        <Segmented
          label="Countdown"
          value={countdownDuration}
          options={[
            [5, "5 s"],
            [3, "3 s"],
            [0, "Off"],
          ]}
          onChange={onCountdownDuration}
        />
      </div>

      <div className="cap-set-row">
        <span className="cap-label">Length cap</span>
        <div className="cap-set-line">
          <Segmented
            label="Length cap"
            value={lengthCapMode}
            options={[
              ["off", "No limit"],
              ["target", "Set target"],
            ]}
            onChange={onLengthCapMode}
          />
          {lengthCapMode === "target" && (
            <>
              <input
                className="cap-input num"
                type="number"
                min={1}
                max={120}
                aria-label="Length cap minutes"
                value={Math.round(lengthCapTargetSec / 60)}
                onChange={(e) => {
                  const m = Math.max(1, Math.min(120, Number(e.target.value) || 1));
                  onLengthCapTargetSec(m * 60);
                }}
              />
              <span className="cap-help">min</span>
            </>
          )}
        </div>
      </div>

      <div className="cap-set-row">
        <span className="cap-label">Noise reduction</span>
        <Segmented
          label="Noise reduction"
          value={noiseReduction}
          options={[
            ["off", "Off"],
            ["low", "Low"],
            ["med", "Med"],
            ["high", "High"],
          ]}
          onChange={onNoiseReduction}
        />
      </div>

      <div className="cap-set-row">
        <span className="cap-label">Save to</span>
        <div className="cap-set-line">
          <span
            className="cap-help"
            title={storage?.chosen ?? "~/Movies/Zeigen"}
            style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
          >
            {storage?.chosen ?? "~/Movies/Zeigen"}
          </span>
          <button className="cap-btn" disabled={saveDirFixed} onClick={() => void chooseSaveDir()}>
            Choose…
          </button>
          <button
            className="cap-btn"
            disabled={saveDirFixed || !storage?.chosen}
            onClick={() => void changeSaveDir(null)}
          >
            Reset
          </button>
        </div>
        {storage?.chosen && !storage.chosen_available && (
          <span className="cap-help">Not available. Saving to ~/Movies/Zeigen until it is.</span>
        )}
        {saveDirLocked && <span className="cap-help">Can't be changed while recording</span>}
        {moveText && <span className="cap-help">{moveText}</span>}
      </div>

      <div className="cap-set-row">
        <span className="cap-label">Devices</span>
        <button className="cap-btn" onClick={onRefresh} style={{ alignSelf: "flex-start" }}>
          Refresh devices
        </button>
        <span className="cap-help">Look again for displays, windows, cameras and microphones</span>
      </div>
    </div>
  );
}

// Click, then press the new combination: it is registered at once. Esc cancels.
// While listening, the current hotkey is unregistered (hotkey_pause) so it
// can't start a recording, and macOS doesn't swallow it before we see it.
function HotkeyRecorder({
  hotkey,
  onHotkey,
}: {
  hotkey: string;
  onHotkey: (combo: string) => Promise<void>;
}) {
  const [listening, setListening] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!listening) return;
    invoke("hotkey_pause").catch(() => {});
    let done = false;
    const finish = (msg: string | null) => {
      done = true;
      setNote(msg);
      setListening(false);
    };
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (done) return;
      const r = captureKey(e);
      if (r.kind === "wait") return;
      if (r.kind === "cancel") return finish(null);
      if (r.kind === "refused") return setNote(r.message);
      done = true;
      onHotkey(r.combo)
        .then(() => finish(null))
        .catch(() =>
          finish(`Couldn't use ${hotkeyGlyphs(r.combo)}. macOS or another app may already use it.`),
        );
    };
    // Clicking elsewhere, or leaving the window, cancels.
    const onBlur = () => !done && finish(null);
    const onDown = (e: MouseEvent) => e.target !== btnRef.current && onBlur();
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", onBlur);
    window.addEventListener("mousedown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("mousedown", onDown, true);
      // Put the (possibly new) hotkey back; a no-op when already registered.
      invoke("hotkey_resume").catch(() => {});
    };
  }, [listening]);

  return (
    <>
      <button
        ref={btnRef}
        className={`cap-input cap-hotkey${listening ? " listening" : ""}`}
        aria-label="Start and stop hotkey"
        onClick={() => {
          setNote(null);
          setListening(true);
        }}
      >
        {listening ? "Press keys…" : hotkeyGlyphs(hotkey)}
      </button>
      <span className="cap-help">
        {note ?? (listening ? "Esc to cancel" : "Click, then press the new keys")}
      </span>
    </>
  );
}

// "850 MB", "4.2 GB".
function fmtBytes(bytes: number): string {
  const mb = bytes / 1e6;
  return mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${Math.max(1, Math.round(mb))} MB`;
}

function Segmented<T extends string | number>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: Array<[T, string]>;
  onChange: (v: T) => void;
}) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label} style={{ alignSelf: "flex-start" }}>
      {options.map(([v, text]) => (
        <button
          key={String(v)}
          role="radio"
          aria-checked={value === v}
          className={value === v ? "on" : undefined}
          onClick={() => onChange(v)}
        >
          {text}
        </button>
      ))}
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
