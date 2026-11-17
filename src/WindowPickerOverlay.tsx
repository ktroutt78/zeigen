import { useMemo, useRef, useState } from "react";
import { emit } from "@tauri-apps/api/event";
import {
  hashParams,
  hitsElement,
  PickerHint,
  readPickerDisplay,
  usePickerPointer,
} from "./pickerOverlay";

// A window in this overlay's display-relative point coordinates. The launcher
// translates each SCWindow's global frame into the display it sits on.
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

// One window in the full front-to-back occluder stack (index 0 = frontmost),
// pickable or not. Same display-relative coords as PickWindow.
type StackEntry = { id: number; x: number; y: number; w: number; h: number };

function parseList<T>(s: string | null): T[] {
  try {
    return JSON.parse(s || "[]");
  } catch {
    return [];
  }
}

// Resolve what's under the point using the true OS z-order, not just our
// enumerated rects. Walk the occluder stack front-to-back and take the first
// window that contains the point:
//  - it's pickable  -> that window (highlight + click selects)
//  - not pickable    -> blocked: a window we didn't enumerate is in front, so
//                       show no highlight rather than silently selecting the
//                       pickable window behind it
//  - nothing there   -> empty (bare desktop)
function resolveAt(
  stack: StackEntry[],
  pickableById: Map<number, PickWindow>,
  px: number,
  py: number,
): { win: PickWindow | null; blocked: boolean } {
  for (const s of stack) {
    if (px < s.x || px > s.x + s.w || py < s.y || py > s.y + s.h) continue;
    const win = pickableById.get(s.id);
    return win ? { win, blocked: false } : { win: null, blocked: true };
  }
  return { win: null, blocked: false };
}

export default function WindowPickerOverlay() {
  const { display, stack, pickableById } = useRef(
    (() => {
      const p = hashParams();
      const windows = parseList<PickWindow>(p.get("wins"));
      return {
        display: readPickerDisplay(p),
        stack: parseList<StackEntry>(p.get("stack")),
        pickableById: new Map(windows.map((w) => [w.id, w])),
      };
    })(),
  ).current;
  const [hovered, setHovered] = useState<PickWindow | null>(null);
  const cancelBtnRef = useRef<HTMLButtonElement | null>(null);

  // Hover and click both come from the poller (see pickerOverlay.ts). Click
  // order: the on-screen Cancel button wins; then a pickable window ->
  // select; bare desktop -> cancel; a window we didn't enumerate (blocked) ->
  // nothing, so a miss is never a wrong pick or an accidental dismiss.
  usePickerPointer(
    "window-picker",
    display,
    (p) => {
      const next = p ? resolveAt(stack, pickableById, p.x, p.y).win : null;
      setHovered((prev) => (prev?.id === next?.id ? prev : next));
    },
    (x, y) => {
      if (hitsElement(cancelBtnRef.current, x, y)) {
        emit("window-picker-cancelled").catch(() => {});
        return;
      }
      const { win, blocked } = resolveAt(stack, pickableById, x, y);
      if (win) emit("window-picker-selected", { id: win.id }).catch(() => {});
      else if (!blocked) emit("window-picker-cancelled").catch(() => {});
    },
  );

  const label = useMemo(() => {
    if (!hovered) return null;
    const t = hovered.title.trim();
    return t ? `${hovered.app} - ${t}` : hovered.app;
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
            border: "3px solid var(--accent)",
            borderRadius: 6,
            background: "var(--picker-tint)",
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
                background: "var(--bg-overlay-strong)",
                borderRadius: 6,
                color: "var(--fg-primary)",
                fontFamily: "var(--font-system)",
                fontSize: 13,
                fontWeight: 600,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {label}
            </div>
          )}
        </div>
      )}
      <PickerHint
        text="Click a window to record it · click empty space or press Esc to cancel"
        cancelRef={cancelBtnRef}
      />
    </div>
  );
}
