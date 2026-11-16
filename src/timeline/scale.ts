// The one place that knows how recording time maps to timeline position.
// Positions are CSS percentages of the timeline's tracks column; pointer maths
// takes that column's bounding rect (every row shares it). Callers never
// compute `t / duration * 100` or `x / width * duration` themselves, so a later
// timeline zoom (factor + scroll offset) changes only this file.

export type TimeScale = {
  duration: number;
  // Time -> CSS `left` percentage (0..100 inside the recording).
  pct: (t: number) => number;
  // Span -> CSS `width` percentage.
  widthPct: (start: number, end: number) => number;
  // Span -> pixels on a tracks column `trackWidth` px wide.
  pxWidth: (start: number, end: number, trackWidth: number) => number;
  // Pointer x -> time, clamped to [0, duration].
  timeAtClientX: (clientX: number, rect: DOMRect) => number;
  // Pointer x -> time, unclamped (drags clamp against their own bounds).
  rawTimeAtClientX: (clientX: number, rect: DOMRect) => number;
  // Pixel distance -> seconds (whole-segment drags).
  secondsForPx: (px: number, rect: DOMRect) => number;
  // Ruler tick times for a tracks column `trackWidth` px wide.
  ticks: (trackWidth: number) => number[];
};

const TICK_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
const MIN_TICK_GAP_PX = 70;

export function timeScale(duration: number): TimeScale {
  const pxWidth = (start: number, end: number, trackWidth: number) =>
    ((end - start) / duration) * trackWidth;
  return {
    duration,
    pct: (t) => (t / duration) * 100,
    widthPct: (start, end) => ((end - start) / duration) * 100,
    pxWidth,
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
      for (let t = 0; t <= duration; t += step) out.push(t);
      return out;
    },
  };
}
