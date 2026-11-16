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

// The camera path from Rust (camera.rs via the camera_path command): the ONE
// definition of zoom motion, the same path the export plays. samples[i] =
// [scale, cx, cy] at t = i * step; (cx, cy) is the crop window's centre as a
// fraction of the frame, top-left origin, always inside the frame.
export type CameraPath = { step: number; samples: [number, number, number][] };

// Camera at playhead time t: linear interpolation between neighbouring samples,
// held at the last sample past the end. A lookup, not motion maths; it must
// behave exactly like cameraAt in compositor-engine/main.swift.
export function cameraAt(
  path: CameraPath | null,
  t: number,
): { scale: number; cx: number; cy: number } | null {
  if (!path || path.samples.length === 0) return null;
  const x = Math.max(t, 0) / path.step;
  const i = Math.floor(x);
  if (i >= path.samples.length - 1) {
    const [scale, cx, cy] = path.samples[path.samples.length - 1];
    return { scale, cx, cy };
  }
  const a = path.samples[i], b = path.samples[i + 1], u = x - i;
  return {
    scale: a[0] + (b[0] - a[0]) * u,
    cx: a[1] + (b[1] - a[1]) * u,
    cy: a[2] + (b[2] - a[2]) * u,
  };
}

// Scene segments (TIMELINE-PLAN step 5): stretches of the video with one layout.
// Wire values are scene.rs Layout's snake_case serde names.
export type SceneLayout = "no_bubble" | "split" | "full_webcam" | "full_screen";
export const SCENE_LAYOUTS: { id: SceneLayout; label: string }[] = [
  { id: "no_bubble", label: "No bubble" },
  { id: "split", label: "Split screen" },
  { id: "full_webcam", label: "Full webcam" },
  { id: "full_screen", label: "Full screen" },
];
export const SCENE_DEFAULT_DURATION = 3;
export const SCENE_MIN_DURATION = 1;

// The layout path from Rust (scene.rs via the scene_path command): the ONE
// definition of where the screen and the webcam sit, the same path the export
// plays. samples[i] at t = i * step, fractions of the output picture, top-left
// origin: [screen x, y, w, h, frame, webcam x, y, w, h, radius, alpha].
export type ScenePath = { step: number; samples: number[][] };

// Layout at playhead time t: the same lookup as cameraAt (and sceneAt in
// compositor-engine/main.swift).
export function sceneAt(path: ScenePath, t: number): number[] {
  const x = Math.max(t, 0) / path.step;
  const i = Math.floor(x);
  if (i >= path.samples.length - 1) return path.samples[path.samples.length - 1];
  const a = path.samples[i], b = path.samples[i + 1], u = x - i;
  return a.map((v, k) => v + (b[k] - v) * u);
}
