// Redaction geometry + frost constants, shared by the Review preview and pinned
// against the Swift compositor (src-tauri/compositor-engine/main.swift). This is
// the SINGLE source of the rect-through-zoom transform on the TS side: the preview
// positions every frosted box with sourceRectToOutputRect, and the cross-language
// pin (redaction-gate/transform-pin.ts) asserts this same function agrees with the
// compositor to the pixel. Do not reimplement the transform anywhere else.
//
// The frost CONSTANTS below mirror the compositor's Swift defaults (which ship,
// because edit.rs passes only REDACT_REGIONS, not the REDACT_* tuning knobs). If a
// value is tuned by eye later, it must change in BOTH places — main.swift's default
// and here — or the preview stops matching the export. See DECISIONS 2026-07-25.

// "auto" (default): the compositor picks a dark frost over light content / light
// over dark, sampled once per region. "light"/"dark" force it (manual override).
export type RedactionTint = "auto" | "light" | "dark";
export type RedactionRegion = {
  x: number;
  y: number;
  w: number;
  h: number;
  start: number;
  end: number;
  tint?: RedactionTint;
};

// Frosted-glass parameters — identical to main.swift REDACT_* defaults.
export const REDACT_ALPHA = 0.6; // overlay opacity (aesthetics + residual attenuation)
export const REDACT_SATURATION = 0.5; // CIColorControls saturation
export const REDACT_RADIUS_K = 0.08; // radius = k * min(w,h) ...
export const REDACT_RADIUS_FLOOR = 16; // ... clamped to [floor, cap] in OUTPUT px.
export const REDACT_RADIUS_CAP = 90; // FLOOR is a safety parameter (DECISIONS 2026-07-25).

// Blur radius the compositor applies, in OUTPUT (post-zoom) pixels. min(w,h) is the
// region's post-zoom size, so a magnified region gets a proportionally larger radius.
export function redactRadius(outW: number, outH: number): number {
  return Math.min(
    Math.max(REDACT_RADIUS_K * Math.min(outW, outH), REDACT_RADIUS_FLOOR),
    REDACT_RADIUS_CAP,
  );
}

export type Rect = { x: number; y: number; w: number; h: number };

// The compositor's zoom sample at a time t: scale + center in SOURCE pixels
// (top-left origin, telemetry coordinates). null = no active zoom (identity).
export type ZoomSample = { scale: number; center_x: number; center_y: number } | null;

// Map a source-space redaction rect to OUTPUT-space pixels (top-left origin) under
// the given zoom, then clip to the frame. This mirrors main.swift's redaction stage
// EXACTLY: window origin winO = clamp(center, hw, W-hw) - hw; out = (src - winO) * s.
// main.swift works in CI bottom-left and this works top-left; the two are equivalent
// (proven by the commit-2 gate + the transform-pin here). null zoom -> s=1, winO=0,
// so the output rect equals the source rect (an unzoomed region lands on its pixels).
export function sourceRectToOutputRect(
  region: RedactionRegion,
  zoom: ZoomSample,
  W: number,
  H: number,
): Rect | null {
  const s = zoom && zoom.scale > 1.0001 ? zoom.scale : 1;
  // Zoom crop-window origin in source px (top-left). At s==1 this is (0,0).
  let winOx = 0;
  let winOy = 0;
  if (s > 1) {
    const hw = W / (2 * s);
    const hh = H / (2 * s);
    const cx = zoom!.center_x;
    const cy = zoom!.center_y;
    const qx = Math.min(Math.max(cx, hw), W - hw);
    const qy = Math.min(Math.max(cy, hh), H - hh);
    winOx = qx - hw;
    winOy = qy - hh;
  }
  const sx = region.x * W;
  const sy = region.y * H;
  const sw = region.w * W;
  const sh = region.h * H;
  const ox = (sx - winOx) * s;
  const oy = (sy - winOy) * s;
  const ow = sw * s;
  const oh = sh * s;
  // Clip to the frame (compositor uses CGRect.intersection); null if off-screen.
  const x0 = Math.max(0, ox);
  const y0 = Math.max(0, oy);
  const x1 = Math.min(W, ox + ow);
  const y1 = Math.min(H, oy + oh);
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// Sidecar write normalization for the redactions field: empty -> undefined so Rust's
// #[serde(skip_serializing_if = "Vec::is_empty")] keeps a no-op sidecar byte-identical
// to a pre-redaction one. Same skip-when-empty rule as zoom/bubble_zone. So deleting
// every box (with nothing else set) restores the exact pre-redaction sidecar bytes.
export function redactionsPayload(
  regions: RedactionRegion[],
): RedactionRegion[] | undefined {
  return regions.length ? regions : undefined;
}

