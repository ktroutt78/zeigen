// Height of the transparent strip below the webcam circle, in CSS pixels.
// The recording control pill renders here during recording/paused states.
// Used by WebcamBubble for layout, useCornerSnap to snap on the circle's
// frame (not the window's), and useBubblePositionLog to log the circle's
// center (not the window's).
export const PILL_STRIP_CSS = 50;

// The bubble's S / M / L sizes: circle diameter in screen points. Mirrors
// composite.rs WebcamSize::px (the Rust names are the stored values). The
// floating bubble window is this wide, the position log measures that
// window, and the export and Review draw the measured diameter, so what is
// picked on the bubble is what the recording shows.
export type BubbleSize = "small" | "medium" | "large";
export const BUBBLE_SIZES: BubbleSize[] = ["small", "medium", "large"];
export const BUBBLE_SIZE_PT: Record<BubbleSize, number> = { small: 180, medium: 240, large: 320 };
export const BUBBLE_SIZE_LABEL: Record<BubbleSize, string> = { small: "S", medium: "M", large: "L" };

// Shape presets on the bubble's toolbar, as bubble_roundness (null = circle,
// 0 = square; corner radius = roundness * diameter / 2).
export type BubbleShape = "circle" | "rounded" | "square";
export const BUBBLE_SHAPE_ROUNDNESS: Record<BubbleShape, number | null> = {
  circle: null,
  rounded: 0.52,
  square: 0,
};

// The preset a stored roundness reads as (a value from the old slider goes to
// the nearest preset).
export function shapeForRoundness(r: number | null | undefined): BubbleShape {
  if (r == null || r >= 0.76) return "circle";
  return r < 0.26 ? "square" : "rounded";
}

// Review's Size control: bubble_scale multiplies the recorded diameter, so
// picking S / M / L on a recording made at `recorded` is this ratio.
export function bubbleScaleFor(recorded: BubbleSize, target: BubbleSize): number {
  return BUBBLE_SIZE_PT[target] / BUBBLE_SIZE_PT[recorded];
}

// The S / M / L a recording currently shows (nearest, so a scale from the old
// Normal / Small control still highlights something).
export function sizeForScale(recorded: BubbleSize, scale: number): BubbleSize {
  const pt = BUBBLE_SIZE_PT[recorded] * scale;
  let best: BubbleSize = "medium";
  for (const s of BUBBLE_SIZES) {
    if (Math.abs(Math.log(BUBBLE_SIZE_PT[s] / pt)) < Math.abs(Math.log(BUBBLE_SIZE_PT[best] / pt))) best = s;
  }
  return best;
}
