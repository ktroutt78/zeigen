import { useEffect } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { currentMonitor } from "@tauri-apps/api/window";
import { PhysicalPosition } from "@tauri-apps/api/dpi";
import { PILL_STRIP_CSS } from "../constants/bubble";

const SNAP_THRESHOLD_CSS_PX = 32;
const EDGE_MARGIN_CSS_PX = 16;
const DRAG_END_DEBOUNCE_MS = 200;

async function snapToNearestCorner() {
  const win = getCurrentWebviewWindow();
  const monitor = await currentMonitor();
  if (!monitor) return;

  const scale = await win.scaleFactor();
  const size = await win.outerSize();
  const pos = await win.outerPosition();

  const threshold = SNAP_THRESHOLD_CSS_PX * scale;
  const margin = EDGE_MARGIN_CSS_PX * scale;
  const pillStrip = PILL_STRIP_CSS * scale;

  // The snap target is the visible circle's frame, not the window's.
  // Circle is anchored to the top of the window and horizontally centered;
  // its diameter matches the CSS rule in WebcamBubble:
  // min(window.width, window.height - PILL_STRIP_CSS).
  const circleSize = Math.min(size.width, Math.max(0, size.height - pillStrip));
  const circleOffsetX = Math.max(0, (size.width - circleSize) / 2);

  const monX = monitor.position.x;
  const monY = monitor.position.y;
  const monW = monitor.size.width;
  const monH = monitor.size.height;

  // Target window positions chosen so the circle (not the window) lands
  // at the corner with EDGE_MARGIN. The pill strip below the circle may
  // extend past the bottom edge for bottom-corner snaps; that's intentional.
  const targets = [
    { x: monX + margin - circleOffsetX, y: monY + margin },
    { x: monX + monW - circleSize - margin - circleOffsetX, y: monY + margin },
    { x: monX + margin - circleOffsetX, y: monY + monH - circleSize - margin },
    {
      x: monX + monW - circleSize - margin - circleOffsetX,
      y: monY + monH - circleSize - margin,
    },
  ];

  let best = -1;
  let bestDist = Infinity;
  for (let i = 0; i < targets.length; i++) {
    const dx = pos.x - targets[i].x;
    const dy = pos.y - targets[i].y;
    const dist = Math.hypot(dx, dy);
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }

  if (best >= 0 && bestDist <= threshold && bestDist > 0.5) {
    await win.setPosition(
      new PhysicalPosition(targets[best].x, targets[best].y),
    );
  }
}

export function useCornerSnap() {
  useEffect(() => {
    let cancelled = false;
    let debounce: number | null = null;
    let unlisten: (() => void) | null = null;

    const start = async () => {
      const win = getCurrentWebviewWindow();
      const fn = await win.onMoved(() => {
        if (cancelled) return;
        if (debounce !== null) window.clearTimeout(debounce);
        debounce = window.setTimeout(() => {
          snapToNearestCorner().catch(() => {});
        }, DRAG_END_DEBOUNCE_MS);
      });
      if (cancelled) {
        fn();
        return;
      }
      unlisten = fn;
    };

    start();

    return () => {
      cancelled = true;
      if (debounce !== null) window.clearTimeout(debounce);
      if (unlisten) unlisten();
    };
  }, []);
}
