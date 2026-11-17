import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { emit, listen } from "@tauri-apps/api/event";

// Shared by the hover pickers (window and display). One overlay per display;
// none of them is ever the key window. Hover and click come from the native
// cursor poller (`picker-cursor` / `picker-click`, global CG points), so every
// display works without mouseMoved and without a priming click.

export type PickerDisplay = {
  displayIndex: number;
  // This display's CG global origin + size (points, top-left).
  originX: number;
  originY: number;
  dispW: number;
  dispH: number;
};

export function hashParams(): URLSearchParams {
  const hash = window.location.hash || "";
  const q = hash.indexOf("?");
  return new URLSearchParams(q >= 0 ? hash.slice(q + 1) : "");
}

export function readPickerDisplay(p: URLSearchParams): PickerDisplay {
  return {
    displayIndex: Number(p.get("display_index") ?? 1),
    originX: Number(p.get("origin_x") ?? 0),
    originY: Number(p.get("origin_y") ?? 0),
    dispW: Number(p.get("disp_w") ?? 0),
    dispH: Number(p.get("disp_h") ?? 0),
  };
}

// Window-relative == client coords (the overlay spans its display), so an
// element's client rect compares directly with a local point.
export function hitsElement(el: Element | null, x: number, y: number): boolean {
  const r = el?.getBoundingClientRect();
  return !!r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}

// Wires an overlay to the poller. `onMove` gets the local point, or null when
// the cursor is on another display; `onClick` fires only on the overlay whose
// display holds the click. Esc (when this overlay happens to be key) cancels.
// Emits `picker-overlay-ready` once listening, so the launcher can restart
// the poller and the current cursor position reaches every overlay.
export function usePickerPointer(
  kind: string,
  d: PickerDisplay,
  onMove: (p: { x: number; y: number } | null) => void,
  onClick: (x: number, y: number) => void,
) {
  const moveRef = useRef(onMove);
  const clickRef = useRef(onClick);
  moveRef.current = onMove;
  clickRef.current = onClick;

  useEffect(() => {
    const local = ([gx, gy]: [number, number]) => {
      const x = gx - d.originX;
      const y = gy - d.originY;
      return x < 0 || y < 0 || x > d.dispW || y > d.dispH ? null : { x, y };
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        emit(`${kind}-cancelled`).catch(() => {});
      }
    };
    window.addEventListener("keydown", onKey);
    const unMove = listen<[number, number]>("picker-cursor", (e) =>
      moveRef.current(local(e.payload)),
    );
    const unClick = listen<[number, number]>("picker-click", (e) => {
      const p = local(e.payload);
      if (p) clickRef.current(p.x, p.y);
    });
    Promise.all([unMove, unClick])
      .then(() => emit("picker-overlay-ready"))
      .catch(() => {});
    return () => {
      window.removeEventListener("keydown", onKey);
      unMove.then((f) => f());
      unClick.then((f) => f());
    };
  }, []);
}

// Centered card with the instructions and a Cancel button. Centered rather
// than bottom-anchored so the Dock (on any edge) never covers it. Cancel has
// no DOM handler: the overlay is not key, so the poller click hit-tests its
// rect instead (see `hitsElement`).
export function PickerHint({
  text,
  cancelRef,
  children,
}: {
  text: string;
  cancelRef: RefObject<HTMLButtonElement | null>;
  children?: ReactNode;
}) {
  return (
    <div
      style={{
        position: "absolute",
        left: "50%",
        top: "50%",
        transform: "translate(-50%, -50%)",
        maxWidth: "80%",
        padding: "14px 18px",
        borderRadius: "var(--r-lg)",
        background: "var(--bg-overlay-strong)",
        color: "var(--fg-primary)",
        fontFamily: "var(--font-system)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 10,
        textAlign: "center",
      }}
    >
      {children}
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <span style={{ fontSize: 12, color: "var(--fg-secondary)", pointerEvents: "none" }}>
          {text}
        </span>
        <button
          ref={cancelRef}
          style={{
            padding: "4px 10px",
            borderRadius: "var(--r-sm)",
            border: "none",
            background: "var(--bg-control-on)",
            color: "var(--fg-primary)",
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
