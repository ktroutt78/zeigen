import type { TrackSegment } from "./SegmentRow";

// Where a new segment added at time t goes on a row whose segments never
// overlap: it starts at t, pulled back so it can reach minDur before the next
// segment, and runs defaultDur or up to the next segment. null when t is inside
// a segment or the gap around t is shorter than minDur. The timeline's ghost
// and the add itself both use this, so the ghost is exactly what a click adds.
export function placeSegment(
  t: number,
  segments: TrackSegment[],
  duration: number,
  defaultDur: number,
  minDur: number,
): TrackSegment | null {
  let lo = 0;
  let hi = duration;
  for (const s of segments) {
    if (s.end <= t) lo = Math.max(lo, s.end);
    else if (s.start >= t) hi = Math.min(hi, s.start);
    else return null;
  }
  const start = Math.max(lo, Math.min(t, hi - minDur));
  const end = Math.min(hi, start + defaultDur);
  return end - start < minDur ? null : { start, end };
}
