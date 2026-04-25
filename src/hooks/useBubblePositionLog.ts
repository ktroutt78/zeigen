import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

async function reportPosition() {
  const win = getCurrentWebviewWindow();
  const pos = await win.outerPosition();
  const size = await win.outerSize();
  const cx = pos.x + size.width / 2;
  const cy = pos.y + size.height / 2;
  await invoke("bubble_position_event", {
    xPhysical: cx,
    yPhysical: cy,
  }).catch(() => {});
}

export function useBubblePositionLog() {
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;

    const start = async () => {
      const win = getCurrentWebviewWindow();
      const fn = await win.onMoved(() => {
        if (cancelled) return;
        reportPosition().catch(() => {});
      });
      if (cancelled) {
        fn();
        return;
      }
      unlisten = fn;
      reportPosition().catch(() => {});
    };

    start();

    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, []);
}
