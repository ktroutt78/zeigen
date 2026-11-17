import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  BUBBLE_SHAPE_ROUNDNESS,
  BUBBLE_SIZES,
  BUBBLE_SIZE_LABEL,
  BUBBLE_SIZE_PT,
  PILL_STRIP_CSS,
  shapeForRoundness,
  type BubbleShape,
  type BubbleSize,
} from "../constants/bubble";

// Shape and size pill above the floating webcam bubble, before recording.
// Its own small window (App.tsx opens it only while idle), attached to the
// bubble as a child window so it follows drags (macos.rs). Hover comes from
// the cursor poller ("bubble-hover"), because the bubble is rarely the key
// window and only the key window gets mouse-moved events.

const HIDE_DELAY_MS = 300;

const SHAPES: Array<[BubbleShape, string, React.ReactNode]> = [
  ["circle", "Circle", <circle cx="8" cy="8" r="5.5" />],
  ["rounded", "Rounded square", <rect x="2.5" y="2.5" width="11" height="11" rx="3.5" />],
  ["square", "Square", <rect x="2.5" y="2.5" width="11" height="11" rx="0.5" />],
];

export default function BubbleToolbar() {
  const [shown, setShown] = useState(false);
  const [shape, setShape] = useState<BubbleShape>("circle");
  const [size, setSize] = useState<BubbleSize>("medium");
  const shownRef = useRef(false);
  shownRef.current = shown;

  useEffect(() => {
    invoke<{ bubble_roundness?: number | null; bubble_size?: BubbleSize | null }>("get_settings")
      .then((s) => {
        setShape(shapeForRoundness(s.bubble_roundness));
        setSize(s.bubble_size ?? "medium");
      })
      .catch(() => {});
  }, []);

  // Hidden = clicks pass through to whatever is under the window.
  useEffect(() => {
    getCurrentWebviewWindow().setIgnoreCursorEvents(!shown).catch(() => {});
  }, [shown]);

  useEffect(() => {
    let hideTimer: number | null = null;
    const un = listen<[boolean, boolean]>("bubble-hover", (e) => {
      const [overBubble, overToolbar] = e.payload;
      // Over the toolbar counts only once it is showing.
      if (overBubble || (shownRef.current && overToolbar)) {
        if (hideTimer !== null) window.clearTimeout(hideTimer);
        hideTimer = null;
        setShown(true);
      } else if (hideTimer === null) {
        hideTimer = window.setTimeout(() => {
          hideTimer = null;
          setShown(false);
        }, HIDE_DELAY_MS);
      }
    });
    un.then(() => {
      invoke("attach_bubble_toolbar").catch(() => {});
      invoke("bubble_hover_start").catch(() => {});
    });
    return () => {
      if (hideTimer !== null) window.clearTimeout(hideTimer);
      un.then((f) => f()).catch(() => {});
      invoke("bubble_hover_stop").catch(() => {});
    };
  }, []);

  const pickShape = (s: BubbleShape) => {
    setShape(s);
    const roundness = BUBBLE_SHAPE_ROUNDNESS[s];
    emit("bubble-style", { roundness }).catch(() => {});
    invoke("set_bubble_roundness", { roundness }).catch(() => {});
  };
  const pickSize = (s: BubbleSize) => {
    setSize(s);
    invoke("set_bubble_size", { size: s }).catch(() => {});
    const d = BUBBLE_SIZE_PT[s];
    invoke("resize_bubble", { width: d, height: d + PILL_STRIP_CSS }).catch(() => {});
  };

  return (
    <div
      style={{
        width: "100vw",
        height: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        opacity: shown ? 1 : 0,
        transition: "opacity 120ms ease-out",
      }}
    >
      <div className="bubble-toolbar">
        {SHAPES.map(([s, title, glyph]) => (
          <button
            key={s}
            title={title}
            aria-label={title}
            aria-pressed={shape === s}
            className={shape === s ? "on" : undefined}
            onClick={() => pickShape(s)}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
              {glyph}
            </svg>
          </button>
        ))}
        <span className="bubble-toolbar-sep" />
        {BUBBLE_SIZES.map((s) => (
          <button
            key={s}
            title={`Size ${BUBBLE_SIZE_LABEL[s]}`}
            aria-label={`Size ${BUBBLE_SIZE_LABEL[s]}`}
            aria-pressed={size === s}
            className={size === s ? "on" : undefined}
            onClick={() => pickSize(s)}
          >
            {BUBBLE_SIZE_LABEL[s]}
          </button>
        ))}
      </div>
    </div>
  );
}
