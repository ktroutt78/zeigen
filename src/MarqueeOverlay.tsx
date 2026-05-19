import { useCallback, useEffect, useRef, useState } from "react";
import { emit } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

const SNAP_PX = 8;
const MIN_DRAG_PX = 4;

type Rect = { x: number; y: number; w: number; h: number };

type Params = {
  displayId: number;
  displayIndex: number;
  displayWidth: number;
  displayHeight: number;
  initial: Rect | null;
};

function readParams(): Params {
  const hash = window.location.hash || "";
  const q = hash.indexOf("?");
  const params = new URLSearchParams(q >= 0 ? hash.slice(q + 1) : "");
  const num = (k: string, def = 0) => Number(params.get(k) ?? def);
  const initial: Rect | null = params.has("x")
    ? { x: num("x"), y: num("y"), w: num("w"), h: num("h") }
    : null;
  return {
    displayId: num("display_id"),
    displayIndex: num("display_index", 1),
    displayWidth: num("display_width"),
    displayHeight: num("display_height"),
    initial,
  };
}

function snap(value: number, edge: number): number {
  return Math.abs(value - edge) <= SNAP_PX ? edge : value;
}

function normalizeRect(a: { x: number; y: number }, b: { x: number; y: number }): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    w: Math.abs(b.x - a.x),
    h: Math.abs(b.y - a.y),
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export default function MarqueeOverlay() {
  const params = useRef<Params>(readParams()).current;
  const [selection, setSelection] = useState<Rect | null>(params.initial);
  const [dragging, setDragging] = useState(false);
  const dragStart = useRef<{ x: number; y: number } | null>(null);
  const dragMoved = useRef(false);

  const cancel = useCallback(() => {
    emit("marquee-cancelled").catch(() => {});
  }, []);

  const confirm = useCallback(
    (rect: Rect) => {
      if (rect.w <= 0 || rect.h <= 0) return;
      emit("marquee-confirmed", {
        display_id: params.displayId,
        x: rect.x,
        y: rect.y,
        width: rect.w,
        height: rect.h,
      }).catch(() => {});
    },
    [params.displayId],
  );

  useEffect(() => {
    // Take keyboard focus so Esc/Enter land here rather than getting swallowed
    // by whatever window had focus when the marquee opened.
    getCurrentWebviewWindow()
      .setFocus()
      .catch(() => {});

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        cancel();
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (selection && selection.w > 0 && selection.h > 0) confirm(selection);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cancel, confirm, selection]);

  const pointToDisplay = (e: React.PointerEvent | PointerEvent) => {
    // Window covers exactly one display, set via set_window_frame_cg, so the
    // event's client coords ARE the display-relative point coords.
    return {
      x: clamp(e.clientX, 0, params.displayWidth),
      y: clamp(e.clientY, 0, params.displayHeight),
    };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    // Multi-display: the marquee window that gets the first pointerdown is
    // the active one. Take focus so subsequent Enter/Esc keystrokes land
    // here, not on the window that got focus at create-time.
    getCurrentWebviewWindow()
      .setFocus()
      .catch(() => {});
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const p = pointToDisplay(e);
    dragStart.current = p;
    dragMoved.current = false;
    setDragging(true);
    setSelection({ x: p.x, y: p.y, w: 0, h: 0 });
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragging || !dragStart.current) return;
    const start = dragStart.current;
    const raw = pointToDisplay(e);
    // Snap-to-edge on whichever side is currently the "moving" edge.
    const snappedX = snap(snap(raw.x, 0), params.displayWidth);
    const snappedY = snap(snap(raw.y, 0), params.displayHeight);
    const dx = Math.abs(raw.x - start.x);
    const dy = Math.abs(raw.y - start.y);
    if (dx + dy >= MIN_DRAG_PX) dragMoved.current = true;
    setSelection(normalizeRect(start, { x: snappedX, y: snappedY }));
  };

  const onPointerUp = (e: React.PointerEvent) => {
    if (!dragging) return;
    setDragging(false);
    dragStart.current = null;
    (e.target as Element).releasePointerCapture?.(e.pointerId);
    if (!dragMoved.current) {
      // Click without drag = cancel.
      cancel();
    }
  };

  const onSelectionDoubleClick = () => {
    if (selection && selection.w > 0 && selection.h > 0) confirm(selection);
  };

  const dimColor = "rgba(0, 0, 0, 0.42)";
  const accentColor = "#3b82f6";

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        cursor: "crosshair",
        userSelect: "none",
        background: "transparent",
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      {selection && selection.w > 0 && selection.h > 0 ? (
        <>
          <div style={{ position: "absolute", left: 0, top: 0, right: 0, height: selection.y, background: dimColor }} />
          <div style={{ position: "absolute", left: 0, top: selection.y + selection.h, right: 0, bottom: 0, background: dimColor }} />
          <div style={{ position: "absolute", left: 0, top: selection.y, width: selection.x, height: selection.h, background: dimColor }} />
          <div
            style={{
              position: "absolute",
              left: selection.x + selection.w,
              top: selection.y,
              right: 0,
              height: selection.h,
              background: dimColor,
            }}
          />
          <div
            onDoubleClick={onSelectionDoubleClick}
            // Swallow pointerdown so it doesn't bubble to the parent overlay
            // and restart a zero-size drag (which would then cancel on
            // pointerup-without-movement, beating the dblclick handler).
            onPointerDown={(e) => e.stopPropagation()}
            style={{
              position: "absolute",
              left: selection.x,
              top: selection.y,
              width: selection.w,
              height: selection.h,
              border: `1.5px solid ${accentColor}`,
              boxShadow: "0 0 0 1px rgba(0,0,0,0.4) inset",
              cursor: "default",
            }}
          />
          <div
            style={{
              position: "absolute",
              left: selection.x + 6,
              top: selection.y + 6,
              padding: "3px 7px",
              borderRadius: 4,
              background: "rgba(0, 0, 0, 0.72)",
              color: "#fff",
              fontFamily: "var(--font-system, -apple-system, BlinkMacSystemFont, sans-serif)",
              fontSize: 11,
              fontVariantNumeric: "tabular-nums",
              fontWeight: 500,
              letterSpacing: "0.01em",
              pointerEvents: "none",
            }}
          >
            {Math.round(selection.w)} × {Math.round(selection.h)}
          </div>
        </>
      ) : (
        <div style={{ position: "absolute", inset: 0, background: dimColor }} />
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
          fontFamily: "var(--font-system, -apple-system, BlinkMacSystemFont, sans-serif)",
          fontSize: 12,
          letterSpacing: "0.01em",
          pointerEvents: "none",
          display: "flex",
          gap: 14,
        }}
      >
        <span>Drag to select area on Display {params.displayIndex}</span>
        <span style={{ opacity: 0.65 }}>·</span>
        <span style={{ opacity: 0.85 }}>Enter to confirm · Esc to cancel</span>
      </div>
    </div>
  );
}
