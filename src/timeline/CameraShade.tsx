import { cameraAt, type CameraPath } from "../reviewShared";

// Shading inside a zoom block: the camera's zoom amount over the block's span,
// looked up from the camera path (the one the preview and export play). Height
// is (scale - 1) / (peak - 1), so a full block means "at this segment's zoom".
// The SVG stretches over the block, so sample k of n sits at k / (n - 1) of its
// width; no easing maths here, only lookups.

const PX_PER_SAMPLE = 2;
const MAX_SAMPLES = 200;

export default function CameraShade({
  camera,
  start,
  end,
  peak,
  blockWidth,
  color,
}: {
  camera: CameraPath;
  start: number;
  end: number;
  peak: number;
  blockWidth: number;
  color: string;
}) {
  const n = Math.max(2, Math.min(MAX_SAMPLES, Math.round(blockWidth / PX_PER_SAMPLE)));
  const pts: string[] = ["0,1"];
  for (let k = 0; k < n; k++) {
    const t = start + ((end - start) * k) / (n - 1);
    const s = cameraAt(camera, t)?.scale ?? 1;
    const y = Math.max(0, Math.min(1, (s - 1) / (peak - 1)));
    pts.push(`${k / (n - 1)},${1 - y}`);
  }
  pts.push("1,1");
  return (
    <svg
      viewBox="0 0 1 1"
      preserveAspectRatio="none"
      style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }}
      aria-hidden
    >
      <polygon points={pts.join(" ")} fill={color} opacity={0.25} />
    </svg>
  );
}
