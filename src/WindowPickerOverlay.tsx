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

// One window in the full front-to-back occluder stack (index 0 = frontmost),
// pickable or not. Same display-relative coords as PickWindow.
type StackEntry = { id: number; x: number; y: number; w: number; h: number };

type Params = {
  displayIndex: number;
  windows: PickWindow[];
  stack: StackEntry[];
};

function readParams(): Params {
  const hash = window.location.hash || "";
  const q = hash.indexOf("?");
  const params = new URLSearchParams(q >= 0 ? hash.slice(q + 1) : "");
  let windows: PickWindow[] = [];
  let stack: StackEntry[] = [];
  try {
    windows = JSON.parse(params.get("wins") || "[]");
  } catch {
    windows = [];
  }
  try {
    stack = JSON.parse(params.get("stack") || "[]");
  } catch {
    stack = [];
  }
  return {
    displayIndex: Number(params.get("display_index") ?? 1),
    windows,
    stack,
  };
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
  const params = useRef<Params>(readParams()).current;
  const pickableById = useRef(
    new Map(params.windows.map((w) => [w.id, w])),
  ).current;
  const [hovered, setHovered] = useState<PickWindow | null>(null);

  const cancel = useCallback(() => {
    emit("window-picker-cancelled").catch(() => {});
  }, []);

  const select = useCallback((id: number) => {
    emit("window-picker-selected", { id }).catch(() => {});
  }, []);

  useEffect(() => {
    // Esc is a bonus path: it only fires once this overlay is the key window,
    // which a borderless transparent window isn't until the pointer enters it
    // (see focusedRef below). The mouse paths are the guaranteed exits.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        cancel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cancel]);

  // Grab key focus the instant the overlay mounts. macOS delivers mouseMoved
  // only to the key window, so hover-to-highlight (the whole selection model)
  // is dead until this overlay is key. Focusing on mount makes hover live
  // immediately with no priming click; `focus: true` at creation is racy
  // because the async reposition and the app already being frontmost can drop
  // key status before the pointer ever enters.
  const focusedRef = useRef(false);
  useEffect(() => {
    focusedRef.current = true;
    getCurrentWebviewWindow()
      .setFocus()
      .catch(() => {});
  }, []);

  const onPointerMove = (e: React.PointerEvent) => {
    // Recovery fallback: if key was lost (e.g. a click landed elsewhere first),
    // reclaim it when the pointer re-enters.
    if (!focusedRef.current) {
      focusedRef.current = true;
      getCurrentWebviewWindow()
        .setFocus()
        .catch(() => {});
    }
    const next = resolveAt(params.stack, pickableById, e.clientX, e.clientY).win;
    // Only re-render on a change of target, not every pixel of movement.
    setHovered((prev) => (prev?.id === next?.id ? prev : next));
  };

  // Click commits: over a pickable window -> select it; over bare desktop ->
  // cancel. Over a window we didn't enumerate (blocked) -> do nothing, so a
  // miss never becomes a wrong selection or an accidental dismiss.
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const { win, blocked } = resolveAt(
      params.stack,
      pickableById,
      e.clientX,
      e.clientY,
    );
    if (win) select(win.id);
    else if (!blocked) cancel();
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
      onPointerDown={onPointerDown}
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
          padding: "8px 10px 8px 14px",
          borderRadius: 8,
          background: "rgba(0, 0, 0, 0.72)",
          color: "#fff",
          fontFamily:
            "var(--font-system, -apple-system, BlinkMacSystemFont, sans-serif)",
          fontSize: 12,
          letterSpacing: "0.01em",
          display: "flex",
          alignItems: "center",
          gap: 12,
        }}
      >
        <span style={{ pointerEvents: "none" }}>
          Click a window to select · click empty space to cancel
        </span>
        <button
          // Guaranteed mouse exit — stop the event reaching the root so it
          // cancels rather than being read as an empty-space click.
          onPointerDown={(e) => {
            e.stopPropagation();
            cancel();
          }}
          style={{
            padding: "4px 10px",
            borderRadius: 6,
            border: "1px solid rgba(255,255,255,0.25)",
            background: "rgba(255,255,255,0.08)",
            color: "#fff",
            fontFamily: "inherit",
            fontSize: 12,
            cursor: "pointer",
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
