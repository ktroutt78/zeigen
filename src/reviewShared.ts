// Constants and helpers shared by the Review window and its timeline
// (src/timeline/). Kept here so the timeline does not import Review at runtime.

export const ZOOM_MIN_DURATION = 0.5;
// Ramp length of the stored keyframe shape (sidecar format) and the lane's ramp
// shading. The motion itself comes from the camera path (camera.rs). 2.5x cap.
export const ZOOM_RAMP_S = 0.6;

export const TRIM_EPS = 0.05;

// Parse the recording stamp out of a path (scratch or final). All Phase 6
// commands that touch the per-recording exports temp dir need this stamp
// so they can compose the dir name independent of where the recording
// currently lives. Returns null for paths that don't look like ours.
export function parseStampFromPath(p: string): string | null {
  const m = p.match(/recording-(\d{4}-\d{2}-\d{2}-\d{6})/);
  return m ? m[1] : null;
}

export function fmt(s: number | null | undefined): string {
  if (s == null || !isFinite(s)) return "--:--";
  const m = Math.floor(s / 60);
  const ss = Math.floor(s % 60);
  return `${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}
