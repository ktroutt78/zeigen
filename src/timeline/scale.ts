import { fmt } from "../reviewShared";

// The one place that knows how recording time maps to timeline position.
// Positions are CSS percentages of the timeline's tracks column; pointer maths
// takes that column's bounding rect (every row shares it). Callers never
// compute `t / duration * 100` or `x / width * duration` themselves. Timeline
// zoom only widens the tracks column inside a scrolling viewport, so the
// column's rect already carries the zoom factor and scroll offset.

export type TimeScale = {
  duration: number;
  // Time -> CSS `left` percentage (0..100 inside the recording).
  pct: (t: number) => number;
  // Span -> CSS `width` percentage.
  widthPct: (start: number, end: number) => number;
  // Span -> pixels on a tracks column `trackWidth` px wide.
  pxWidth: (start: number, end: number, trackWidth: number) => number;
  // Time -> px from the tracks column's left edge.
  xAt: (t: number, trackWidth: number) => number;
  // Pointer x -> time, clamped to [0, duration].
  timeAtClientX: (clientX: number, rect: DOMRect) => number;
  // Pointer x -> time, unclamped (drags clamp against their own bounds).
  rawTimeAtClientX: (clientX: number, rect: DOMRect) => number;
  // Pixel distance -> seconds (whole-segment drags).
  secondsForPx: (px: number, rect: DOMRect) => number;
  // Ruler tick times for a tracks column `trackWidth` px wide.
  ticks: (trackWidth: number) => number[];
  // Largest zoom factor for a viewport `viewportWidth` px wide: one second
  // MAX_PX_PER_SEC wide, but never below 1 (fit).
  maxZoom: (viewportWidth: number) => number;
};

const TICK_STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
const MIN_TICK_GAP_PX = 70;
const MAX_PX_PER_SEC = 200;

export function timeScale(duration: number): TimeScale {
  const pxWidth = (start: number, end: number, trackWidth: number) =>
    ((end - start) / duration) * trackWidth;
  return {
    duration,
    pct: (t) => (t / duration) * 100,
    widthPct: (start, end) => ((end - start) / duration) * 100,
    pxWidth,
    xAt: (t, trackWidth) => (t / duration) * trackWidth,
    timeAtClientX: (clientX, rect) =>
      Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) * duration,
    rawTimeAtClientX: (clientX, rect) => ((clientX - rect.left) / rect.width) * duration,
    secondsForPx: (px, rect) => (px / rect.width) * duration,
    ticks: (trackWidth) => {
      // Smallest step whose ticks are at least MIN_TICK_GAP_PX apart.
      const step =
        TICK_STEPS.find((s) => pxWidth(0, s, trackWidth) >= MIN_TICK_GAP_PX) ??
        TICK_STEPS[TICK_STEPS.length - 1];
      const out: number[] = [];
      // Rounded to tenths so sub-second steps do not accumulate float error.
      for (let i = 0; i * step <= duration; i++) out.push(Math.round(i * step * 10) / 10);
      return out;
    },
    maxZoom: (viewportWidth) =>
      viewportWidth > 0 ? Math.max(1, (MAX_PX_PER_SEC * duration) / viewportWidth) : 1,
  };
}

// Ruler label: "00:04" on whole seconds, "00:04.5" between them.
export function tickLabel(t: number): string {
  const tenths = Math.round(t * 10);
  return tenths % 10 === 0 ? fmt(tenths / 10) : `${fmt(Math.floor(tenths / 10))}.${tenths % 10}`;
}
