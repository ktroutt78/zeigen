import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useRecordingState } from "./useRecordingState";
import { PILL_STRIP_CSS } from "../constants/bubble";

// Poll the bubble's position every POLL_MS while recording. Tauri's
// `tauri://move` events don't fire reliably for OS-level drags via
// `data-tauri-drag-region` on macOS, so polling is more dependable than
// listening. Rust-side dedup (>2% movement OR >250ms since last entry)
// keeps the log compact even with a 200ms cadence.
const POLL_MS = 200;

async function reportPosition() {
  try {
    const win = getCurrentWebviewWindow();
    const [pos, size, scale] = await Promise.all([
      win.outerPosition(),
      win.outerSize(),
      win.scaleFactor(),
    ]);
    // Report the visible circle's center, not the window's. The circle is
    // anchored to the top of the window (with a transparent pill strip
    // below); its diameter mirrors the CSS rule in WebcamBubble.
    const pillStrip = PILL_STRIP_CSS * scale;
    const circleSize = Math.min(
      size.width,
      Math.max(0, size.height - pillStrip),
    );
    const cx = pos.x + size.width / 2;
    const cy = pos.y + circleSize / 2;
    await invoke("bubble_position_event", {
      xPhysical: cx,
      yPhysical: cy,
    });
  } catch {
    // Window may be transitioning (closing, hidden) — drop silently.
  }
}

export function useBubblePositionLog() {
  const { state } = useRecordingState();
  useEffect(() => {
    if (state !== "recording" && state !== "paused") return;
    // Immediate first sample captures whatever position the user placed
    // the bubble at *before* hitting Start.
    reportPosition();
    const id = window.setInterval(reportPosition, POLL_MS);
    return () => window.clearInterval(id);
  }, [state]);
}
