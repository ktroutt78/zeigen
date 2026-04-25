import { useEffect } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { currentMonitor } from "@tauri-apps/api/window";
import { PhysicalPosition } from "@tauri-apps/api/dpi";

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

  const monX = monitor.position.x;
  const monY = monitor.position.y;
  const monW = monitor.size.width;
  const monH = monitor.size.height;

  const targets = [
    { x: monX + margin, y: monY + margin },
    { x: monX + monW - size.width - margin, y: monY + margin },
    { x: monX + margin, y: monY + monH - size.height - margin },
    { x: monX + monW - size.width - margin, y: monY + monH - size.height - margin },
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
