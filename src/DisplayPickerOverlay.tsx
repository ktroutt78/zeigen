import { useRef, useState } from "react";
import { emit } from "@tauri-apps/api/event";
import {
  hashParams,
  hitsElement,
  PickerHint,
  readPickerDisplay,
  usePickerPointer,
} from "./pickerOverlay";

// One per display. The display under the mouse is tinted with its name and
// size; the others are dimmed. A click on this display picks it (Cancel's
// rect excepted). Same poller plumbing as the window picker.
export default function DisplayPickerOverlay() {
  const { display, id, name } = useRef(
    (() => {
      const p = hashParams();
      return {
        display: readPickerDisplay(p),
        id: Number(p.get("id")),
        name: p.get("name") ?? "",
      };
    })(),
  ).current;
  const [hovered, setHovered] = useState(false);
  const cancelBtnRef = useRef<HTMLButtonElement | null>(null);

  usePickerPointer(
    "display-picker",
    display,
    (p) => setHovered(p !== null),
    (x, y) => {
      if (hitsElement(cancelBtnRef.current, x, y)) {
        emit("display-picker-cancelled").catch(() => {});
      } else {
        emit("display-picker-selected", { id }).catch(() => {});
      }
    },
  );

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        cursor: "pointer",
        userSelect: "none",
        boxSizing: "border-box",
        background: hovered ? "var(--picker-tint)" : "var(--picker-scrim)",
        border: hovered ? "4px solid var(--accent)" : "4px solid transparent",
      }}
    >
      <PickerHint
        text="Click a display to record it · Esc to cancel"
        cancelRef={cancelBtnRef}
      >
        <div
          style={{
            fontSize: 34,
            fontWeight: 650,
            letterSpacing: "-0.01em",
            color: hovered ? "var(--fg-primary)" : "var(--fg-secondary)",
          }}
        >
          {name}
        </div>
        <div style={{ fontSize: 18, color: "var(--fg-secondary)" }}>
          {display.dispW} x {display.dispH}
        </div>
      </PickerHint>
    </div>
  );
}
