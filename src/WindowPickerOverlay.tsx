import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { emit } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

// A window in this overlay's display-relative point coordinates. The launcher
// translates each SCWindow's global frame into the display it sits on, so the
// overlay can treat pointer client coords as display-relative directly (same
// invariant the marquee relies on — one overlay window per display).
type PickWindow = {
  id: number;
  x: number;
  y: number;
  w: number;
  h: number;
  app: string;
  title: string;
  z: number; // front-to-back, 0 = frontmost
};

type Params = {
  displayIndex: number;
  windows: PickWindow[];
};

function readParams(): Params {
  const hash = window.location.hash || "";
  const q = hash.indexOf("?");
  const params = new URLSearchParams(q >= 0 ? hash.slice(q + 1) : "");
  let windows: PickWindow[] = [];
  try {
    windows = JSON.parse(params.get("wins") || "[]");
  } catch {
    windows = [];
  }
  return {
    displayIndex: Number(params.get("display_index") ?? 1),
    windows,
  };
}

// Frontmost window under the point: among all windows whose rect contains it,
// the one with the lowest z. Returns null when the cursor is over bare desktop.
function hitTest(windows: PickWindow[], px: number, py: number): PickWindow | null {
  let best: PickWindow | null = null;
  for (const w of windows) {
    if (px < w.x || px > w.x + w.w || py < w.y || py > w.y + w.h) continue;
    if (!best || w.z < best.z) best = w;
  }
  return best;
}

export default function WindowPickerOverlay() {
  const params = useRef<Params>(readParams()).current;
  const [hovered, setHovered] = useState<PickWindow | null>(null);

  const cancel = useCallback(() => {
    emit("window-picker-cancelled").catch(() => {});
  }, []);

  useEffect(() => {
    getCurrentWebviewWindow()
      .setFocus()
      .catch(() => {});
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        cancel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cancel]);

  const onPointerMove = (e: React.PointerEvent) => {
    const next = hitTest(params.windows, e.clientX, e.clientY);
    // Only re-render on a change of target, not every pixel of movement.
    setHovered((prev) => (prev?.id === next?.id ? prev : next));
  };

  const label = useMemo(() => {
    if (!hovered) return null;
    const t = hovered.title.trim();
    return t ? `${hovered.app} — ${t}` : hovered.app;
  }, [hovered]);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        cursor: "crosshair",
        userSelect: "none",
        background: "transparent",
      }}
      onPointerMove={onPointerMove}
    >
      {hovered && (
        <div
          style={{
            position: "absolute",
            left: hovered.x,
            top: hovered.y,
            width: hovered.w,
            height: hovered.h,
            boxSizing: "border-box",
            border: "3px solid var(--accent, #0066ff)",
            borderRadius: 6,
            background: "rgba(0, 102, 255, 0.12)",
            boxShadow:
              "0 0 0 1px rgba(0,0,0,0.5) inset, 0 0 26px rgba(0, 102, 255, 0.5)",
            pointerEvents: "none",
          }}
        >
          {label && (
            <div
              style={{
                position: "absolute",
                top: 10,
                left: 10,
                maxWidth: "70%",
                padding: "6px 10px",
                background: "rgba(20,20,22,0.85)",
                backdropFilter: "blur(8px)",
                WebkitBackdropFilter: "blur(8px)",
                border: "1px solid var(--accent, #0066ff)",
                borderRadius: 6,
                color: "#fff",
                fontFamily:
                  "var(--font-system, -apple-system, BlinkMacSystemFont, sans-serif)",
                fontSize: 13,
                fontWeight: 600,
                letterSpacing: "-0.005em",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                boxShadow: "0 4px 14px rgba(0,0,0,0.55)",
              }}
            >
              {label}
            </div>
          )}
        </div>
      )}
      <div
        style={{
          position: "absolute",
          left: "50%",
          bottom: 22,
          transform: "translateX(-50%)",
          padding: "8px 14px",
          borderRadius: 8,
          background: "rgba(0, 0, 0, 0.72)",
          color: "#fff",
          fontFamily:
            "var(--font-system, -apple-system, BlinkMacSystemFont, sans-serif)",
          fontSize: 12,
          letterSpacing: "0.01em",
          pointerEvents: "none",
          display: "flex",
          gap: 14,
        }}
      >
        <span>Hover a window on Display {params.displayIndex}</span>
        <span style={{ opacity: 0.65 }}>·</span>
        <span style={{ opacity: 0.85 }}>Esc to cancel</span>
      </div>
    </div>
  );
}
