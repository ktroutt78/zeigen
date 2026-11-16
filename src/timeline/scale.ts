// The one place that knows how recording time maps to timeline position.
// Positions are CSS percentages of a full-width track row; pointer maths takes
// the row's bounding rect so every lane converts against its own row. Callers
// never compute `t / duration * 100` or `x / width * duration` themselves, so a
// later timeline zoom (factor + scroll offset) changes only this file.

export type TimeScale = {
  duration: number;
  // Time -> CSS `left` percentage (0..100 inside the recording).
  pct: (t: number) => number;
  // Span -> CSS `width` percentage.
  widthPct: (start: number, end: number) => number;
  // Pointer x -> time, clamped to [0, duration].
  timeAtClientX: (clientX: number, rect: DOMRect) => number;
  // Pointer x -> time, unclamped (drags clamp against their own bounds).
  rawTimeAtClientX: (clientX: number, rect: DOMRect) => number;
  // Pixel distance -> seconds (whole-segment drags).
  secondsForPx: (px: number, rect: DOMRect) => number;
};

export function timeScale(duration: number): TimeScale {
  return {
    duration,
    pct: (t) => (t / duration) * 100,
    widthPct: (start, end) => ((end - start) / duration) * 100,
    timeAtClientX: (clientX, rect) =>
      Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) * duration,
    rawTimeAtClientX: (clientX, rect) => ((clientX - rect.left) / rect.width) * duration,
    secondsForPx: (px, rect) => (px / rect.width) * duration,
  };
}
