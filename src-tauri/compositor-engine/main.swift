// V3 Core Image compositor.
//   Phase 1 (DONE): identity re-encode, color round-trip proved (color mgmt off).
//   Phase 2 (DONE): zoom transform — SINGLE-resample lanczos with sub-pixel window.
//   Phase 5 (DONE, off by default): velocity-driven radial motion blur.
//
// Decodes a video, routes every frame through a CIContext, and re-encodes via
// AVAssetWriter -> VideoToolbox H.264 with EXPLICIT 8M ABR and BT.709 tags. Video
// only; audio stays in ffmpeg and muxes later.
//
// Zoom: crop the source to the sub-pixel window rect (CI is continuous -> the
// fractional crop is EXACT and free), then ONE CILanczosScaleTransform up to full
// frame. That is one resample with sub-pixel positioning, vs V2's three
// (lanczos-up-4x -> zoompan bicubic -> lanczos-down) and its s/4 pixel quantization.
// Zoom math (in_out_cubic ramps, clamped off-center window, Y-flip) mirrors
// gpuzoom.swift / Review.tsx exactly, so geometry matches V2.
//
// The per-frame velocity is computed here (marked below) so the Phase 5 motion blur
// consumes it as radius = floor + k*|velocity|.
//
// NOT wired into the app: nothing in the Rust export path invokes this. V2 (ffmpeg)
// stays the default. Build: swiftc -O main.swift -o cicompositor
// Run:   ./cicompositor <in.mp4> <out.mp4> [scenario]   (scenario omitted = identity)
//   scenarios: const | slow | multi   (clip-relative; mirror gpuzoom.swift)
//   env VELLOG=<path> writes a per-frame velocity CSV for validation.
import Foundation
import AVFoundation
import CoreImage
import CoreGraphics
import VideoToolbox

func fail(_ msg: String) -> Never {
    FileHandle.standardError.write((msg + "\n").data(using: .utf8)!)
    exit(1)
}

// --- Zoom model (mirrors gpuzoom.swift / Review.tsx zoomAt) ---
func easeInOutCubic(_ u: Double) -> Double { u < 0.5 ? 4*u*u*u : 1 - pow(-2*u+2, 3)/2 }
struct Seg { let start, end, scale, ramp, cxf, cyf: Double }  // cxf/cyf are top-left fractions
func zoomAt(_ segs: [Seg], _ t: Double) -> Double {
    for s in segs where t >= s.start && t <= s.end {
        let ramp = min(s.ramp, (s.end - s.start) / 2)
        if ramp <= 0 { return s.scale }
        if t < s.start + ramp { return 1 + (s.scale - 1) * easeInOutCubic((t - s.start) / ramp) }
        if t > s.end - ramp   { return 1 + (s.scale - 1) * easeInOutCubic((s.end - t) / ramp) }
        return s.scale
    }
    return 1.0
}
func centerAt(_ segs: [Seg], _ t: Double) -> (Double, Double) {
    for s in segs where t >= s.start && t <= s.end { return (s.cxf, s.cyf) }
    return (0.5, 0.5)
}

let args = CommandLine.arguments
guard args.count == 3 || args.count == 4 else {
    fail("usage: cicompositor <in.mp4> <out.mp4> [scenario]")
}
let inURL = URL(fileURLWithPath: args[1])
let outURL = URL(fileURLWithPath: args[2])
let scenario = args.count == 4 ? args[3] : "identity"
var segs: [Seg] = []
switch scenario {
case "identity": segs = []
case "const": segs = [Seg(start: 0, end: 9999, scale: 2.0, ramp: 0.0, cxf: 0.5, cyf: 0.5)]
case "slow":  segs = [Seg(start: 0, end: 5, scale: 1.6, ramp: 2.5, cxf: 1750.0/1920, cyf: 520.0/1080)]
case "multi": segs = [Seg(start: 1.5, end: 5.0, scale: 2.0, ramp: 0.6, cxf: 0.09, cyf: 0.60),
                      Seg(start: 6.0, end: 9.5, scale: 2.2, ramp: 0.6, cxf: 0.50, cyf: 0.48),
                      Seg(start: 10.5, end: 14.0, scale: 2.0, ramp: 0.6, cxf: 0.911, cyf: 0.48)]
// realistic single punch-in: 0.6s ramp to 2x off-center, hold, 0.6s out
case "punch": segs = [Seg(start: 1.0, end: 4.0, scale: 2.0, ramp: 0.6, cxf: 0.66, cyf: 0.42)]
default: fail("unknown scenario \(scenario)")
}
let env = ProcessInfo.processInfo.environment

// Zoom segments may come from a JSON file (env ZOOM_SEGMENTS), overriding the scenario.
// Array of {start,end,scale,ramp,cxf,cyf}. Lets the harness drive arbitrary sequences
// (incl. long non-repeating ones for the perf/thermal gate) without hardcoded scenarios,
// and mirrors how the app's sidecar zoom track would feed the compositor.
if let zp = env["ZOOM_SEGMENTS"], let data = FileManager.default.contents(atPath: zp) {
    struct JSeg: Decodable { let start, end, scale, ramp, cxf, cyf: Double }
    guard let js = try? JSONDecoder().decode([JSeg].self, from: data) else { fail("bad ZOOM_SEGMENTS json") }
    segs = js.map { Seg(start: $0.start, end: $0.end, scale: $0.scale, ramp: $0.ramp, cxf: $0.cxf, cyf: $0.cyf) }
}
let velLogPath = env["VELLOG"]
var velLog = "t,scale,dscale,blur_vel,blur_amount,content_speed\n"

// Motion blur (Phase 5): ONE CI layer, radius = floor + k*|v|, applied only while
// moving. For our scale-ramp zooms the motion is RADIAL (content flows out from the
// focus), so the correct blur is CIZoomBlur centered on the focus, NOT a directional
// smear. floor kills slow-ramp shimmer; k*|v| kills fast-ramp strobe. Default OFF so
// Phase 2 behavior is unchanged unless BLUR=on.
let blurOn = env["BLUR"] == "on"
let blurFloor = Double(env["BLUR_FLOOR"] ?? "2.0")!
let blurK = Double(env["BLUR_K"] ?? "0.35")!
let blurMax = Double(env["BLUR_MAX"] ?? "40")!
let blurEps = Double(env["BLUR_EPS"] ?? "0.4")!

// --- Watermark (Phase 4): screen-anchored logo PNG composited on the FINAL zoomed
// frame (output space — does NOT zoom, and applied after motion blur so it stays
// sharp). Params mirror composite.rs Watermark (supplied by save_recording args):
// corner tl|tr|bl|br, width-based scale_frac or legacy 10%-of-short-side height,
// alpha opacity. Placement is integer px (ffmpeg overlay snaps to int; sub-pixel
// would soften the logo edges — the Phase 3 finding). Absent WATERMARK_PNG -> none.
let wmCorner = env["WATERMARK_CORNER"] ?? "tr"
let wmScaleFrac = Double(env["WATERMARK_SCALE_FRAC"] ?? "")
let wmOpacity = Double(env["WATERMARK_OPACITY"] ?? "1.0")!

// --- Background canvas + padding (BACKGROUND-PADDING-PLAN Slice 1): a terminal inset
// stage (after every overlay, before downscale) that scales the whole composed WxH
// frame UNIFORMLY by k = 1 - FRAME_PADDING (aspect preserved — NOT stretched) and
// centers it over a solid background. Because it runs after the overlays, the bubble
// and watermark inset WITH the recording instead of drifting into the margin. Canvas =
// source dims in v1, so the terminal downscale still caps the canvas to the output res.
// Absent/0 padding or no background -> inactive, the frame passes through byte-identical.
// Only solid is wired here; gradient/image are later slices. Slice 2 adds rounded
// corners, a drop shadow, and an inset border on the inset content (below).
func ciColor(hex: String) -> CIColor? {
    let s = (hex.hasPrefix("#") ? String(hex.dropFirst()) : hex)
        .trimmingCharacters(in: .whitespaces)
    guard s.count == 6, let v = UInt32(s, radix: 16) else { return nil }
    let r = CGFloat((v >> 16) & 0xff) / 255.0
    let g = CGFloat((v >> 8) & 0xff) / 255.0
    let b = CGFloat(v & 0xff) / 255.0
    // Tag sRGB so the fill matches the picked hex; CI converts to 709 at render.
    if let srgb = CGColorSpace(name: CGColorSpace.sRGB),
       let c = CIColor(red: r, green: g, blue: b, colorSpace: srgb) {
        return c
    }
    return CIColor(red: r, green: g, blue: b)
}
// Rounded-rect layers for the inset stage, drawn once with Core Graphics (static for
// the whole render). Filled = the corner mask (white, used as alpha) and the shadow
// silhouette (black). Stroked = the inset border. Neutral colors (black/white) are
// color-space-safe under the compositor's NSNull working space. Origin bottom-left to
// match CI; premultiplied-last alpha.
func roundedBitmap(w: Int, h: Int, radius: CGFloat,
                   draw: (CGContext, CGPath) -> Void) -> CIImage? {
    guard w > 0, h > 0, let cs = CGColorSpace(name: CGColorSpace.sRGB),
          let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8,
                              bytesPerRow: 0, space: cs,
                              bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
    else { return nil }
    ctx.clear(CGRect(x: 0, y: 0, width: w, height: h))
    let r = max(0, min(radius, CGFloat(min(w, h)) / 2))
    let path = CGPath(roundedRect: CGRect(x: 0, y: 0, width: w, height: h),
                      cornerWidth: r, cornerHeight: r, transform: nil)
    draw(ctx, path)
    return ctx.makeImage().map { CIImage(cgImage: $0) }
}
func roundedFill(w: Int, h: Int, radius: CGFloat, gray: CGFloat, alpha: CGFloat) -> CIImage? {
    roundedBitmap(w: w, h: h, radius: radius) { ctx, path in
        ctx.addPath(path)
        ctx.setFillColor(red: gray, green: gray, blue: gray, alpha: alpha)
        ctx.fillPath()
    }
}
func roundedStroke(w: Int, h: Int, radius: CGFloat, lineWidth: CGFloat,
                   gray: CGFloat, alpha: CGFloat) -> CIImage? {
    // Inset the stroke rect by half the line width so the whole stroke lands INSIDE the
    // content edge (an inner rim, not a fattened outer outline).
    let inset = lineWidth / 2
    guard w > 0, h > 0, let cs = CGColorSpace(name: CGColorSpace.sRGB),
          let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8,
                              bytesPerRow: 0, space: cs,
                              bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
    else { return nil }
    ctx.clear(CGRect(x: 0, y: 0, width: w, height: h))
    let r = max(0, min(radius, CGFloat(min(w, h)) / 2) - inset)
    let rect = CGRect(x: inset, y: inset, width: CGFloat(w) - lineWidth, height: CGFloat(h) - lineWidth)
    let path = CGPath(roundedRect: rect, cornerWidth: r, cornerHeight: r, transform: nil)
    ctx.addPath(path)
    ctx.setStrokeColor(red: gray, green: gray, blue: gray, alpha: alpha)
    ctx.setLineWidth(lineWidth)
    ctx.strokePath()
    return ctx.makeImage().map { CIImage(cgImage: $0) }
}
let framePadding = Double(env["FRAME_PADDING"] ?? "") ?? 0
// corner radius + inset border width are fractions of the inset content's SHORT side
// (resolution-independent, scale with the supersample); shadow is a 0..1 intensity.
let frameCornerFrac = Double(env["FRAME_CORNER_RADIUS"] ?? "") ?? 0
let frameShadow = Double(env["FRAME_SHADOW"] ?? "") ?? 0
let frameInsetFrac = Double(env["FRAME_INSET"] ?? "") ?? 0
// Shadow geometry scales with the PADDING MARGIN (the space the shadow lives in), so it
// fits at Tight and grows at Wide without ramming the frame edge — and it's an ELEVATION
// shadow (broad/soft/offset into the clear margin), not an edge-hugging separator, so it
// reads on light backgrounds even under high-contrast dark content. Internal knobs with
// tuned defaults (unexposed; used for calibration).
let shadowBlurK = Double(env["SHADOW_BLUR_K"] ?? "") ?? 0.85
let shadowDyK = Double(env["SHADOW_DY_K"] ?? "") ?? 0.45
let shadowAlphaK = Double(env["SHADOW_ALPHA_K"] ?? "") ?? 0.5
// Procedural gradient presets (BACKGROUND-PADDING-PLAN Slice 3): name -> (light stop,
// dark stop). Rendered VERTICAL, dark-top -> light-bottom (see backgroundImage), so the
// full range lands across the top+bottom margins (the bands seen) rather than the thin
// side slivers a diagonal crosses at an angle; stops are the steeper set so the gradient
// reads through a Tight margin. One member per hue family (graphite/indigo/teal/plum/
// ember) plus one light option (mist). The rim + elevation shadow are the contrast
// backstops. Mirrored in the TS UI (Slice 4) for preview parity.
let gradientPresets: [String: (String, String)] = [
    "graphite": ("#69748A", "#111318"),
    "indigo":   ("#5450A6", "#0F0D20"),
    "teal":     ("#2B7A76", "#061A19"),
    "plum":     ("#7F53A6", "#150B22"),
    "ember":    ("#B85A32", "#2E0F09"),
    "mist":     ("#F8FBFE", "#B2BECE"),
]
// Background colors as (top-left, bottom-right): a solid repeats one color; a gradient
// resolves its preset. nil = no background. bgIsGradient drives whether the canvas is a
// CILinearGradient or a flat fill (the flat fill keeps the proven Slice 1 solid path).
let bgIsGradient = env["BACKGROUND_KIND"] == "gradient"
let bgColors: (CIColor, CIColor)? = {
    switch env["BACKGROUND_KIND"] {
    case "solid":
        guard let hex = env["BACKGROUND_SOLID_HEX"], let c = ciColor(hex: hex) else { return nil }
        return (c, c)
    case "gradient":
        guard let name = env["BACKGROUND_GRADIENT"], let (a, b) = gradientPresets[name],
              let ca = ciColor(hex: a), let cb = ciColor(hex: b) else { return nil }
        return (ca, cb)
    default:
        return nil
    }
}()
let insetActive = framePadding > 0 && bgColors != nil

// --- Webcam bubble (Phase 4): a SECOND video stream, composited on the final zoomed
// frame (screen-anchored, constant placement). Mask + shadow silhouette PNGs are
// pre-rendered (by the harness now, by Rust reusing composite.rs later) and fed to
// both renderers, so only the composite math differs. Diameter drives the shadow
// geometry exactly like composite.rs. Absent BUBBLE_WEBCAM -> no bubble.
let bubbleWebcam = env["BUBBLE_WEBCAM"]
let bubbleMaskPath = env["BUBBLE_MASK_PNG"]
let bubbleShadowPath = env["BUBBLE_SHADOW_PNG"]
let bubbleDiameter = Double(env["BUBBLE_DIAMETER"] ?? "240")!
let bubbleZone = env["BUBBLE_ZONE"] ?? "br"          // {t,c,b}{l,c,r} 3x3 grid
let bubbleShadowAlpha = Double(env["BUBBLE_SHADOW_ALPHA"] ?? "0.22")!
// composite.rs gblur sigma=round(0.075*d); CIGaussianBlur radius = k*sigma (tuning knob).
let bubbleShadowRadiusK = Double(env["BUBBLE_SHADOW_RADIUS_K"] ?? "3.0")!
// Webcam A/V lead: V2 freezes the first webcam frame for WEBCAM_LEAD_MS (composite.rs)
// via tpad=start_mode=clone, so the bubble reads in sync from t=0 despite the camera
// lagging SCK screen capture at startup. cicompositor pulls the webcam 1:1, so replicate
// the freeze: hold webcam frame 0 across the first `lead` screen frames, then advance
// (webcam frame shown at screen frame i = max(0, i - lead)). Rust passes
// round(WEBCAM_LEAD_MS/1000 * fps); default 0 leaves the pre-wiring standalone/harness
// behavior (naive 1:1 pull) unchanged.
let bubbleLeadFrames = Int(env["BUBBLE_LEAD_FRAMES"] ?? "0") ?? 0
// Webcam trim skip: on a trimmed export V2 drops max(0, trim_in - WEBCAM_LEAD_MS) of
// the webcam front (composite.rs wc_skip) so the bubble at output t=0 shows content
// from (trim_in - lead) — the same 105ms lead as the untrimmed start. Rust passes it
// as a frame count; we discard that many webcam samples before the loop, then apply
// the (residual) BUBBLE_LEAD_FRAMES freeze. Output frame i -> webcam frame
// skip + max(0, i - lead), matching V2's [tpad pad_lead][trim wc_skip] chain exactly.
let bubbleWebcamSkipFrames = Int(env["BUBBLE_WEBCAM_SKIP_FRAMES"] ?? "0") ?? 0
// Bubble depth treatment (DECISIONS.md 2026-07-16). The V3 DEFAULT is `elevated`:
// an offset-down-right drop shadow (matches a PowerPoint "offset bottom-right"
// shadow). `flat` is the legacy single tight shadow, kept for comparison via env.
//
// Offset-drop-shadow model: the silhouette is the SAME SIZE as the bubble, offset
// DOWN-RIGHT by a small fraction of the diameter, MODERATELY blurred (radius well
// under the bubble radius so the peak survives — a blur > radius washes it out;
// a silhouette LARGER than the bubble rings the top-left). Composited under the
// opaque bubble: the top-left of the shadow is fully occluded (no halo), only the
// bottom-right escapes -> reads as a lit object, not a glow. blur 0.04xd LOOKS
// too small but isn't: it's the CI Gaussian radius on a same-size silhouette, and
// it's calibrated to the reference (escape ~0.105xD right+down, ~0.39 darkening on
// white, 0 on left+up). See DECISIONS.md for the model history.
let bubbleDepth = env["BUBBLE_DEPTH"] ?? "elevated"
let elevBlurFrac = Double(env["BUBBLE_ELEV_BLUR_FRAC"] ?? "0.04")!
let elevOffsetFrac = Double(env["BUBBLE_ELEV_OFFSET_FRAC"] ?? "0.05")!     // down
let elevOffsetXFrac = Double(env["BUBBLE_ELEV_OFFSET_X_FRAC"] ?? "0.05")!  // right
let elevAlpha = Double(env["BUBBLE_ELEV_ALPHA"] ?? "0.48")!

// --- Redaction (REDACTION-PLAN): frosted-glass panels over static source-space
// rects, active over [start,end] on the ORIGINAL timeline. Env REDACT_REGIONS = a
// path to a JSON array of {x,y,w,h,start,end,tint}; x/y/w/h are source-frame
// fractions, top-left origin, and tint is "light"|"dark". Applied AFTER zoom +
// motion-blur and BEFORE the bubble/watermark, so the panel covers exactly the
// composed screen content the viewer sees, and the rect is transformed through the
// SAME zoom so it stays glued to its content. Absent/empty -> nothing runs and the
// frame path is byte-identical to pre-feature (Vec::is_empty on the Rust side).
// tint: "auto" (default) samples the region's mean luminance ONCE and picks a dark
// frost over light content / light frost over dark content, held for the region's
// duration (no per-frame re-sample -> no flicker). "light"/"dark" force it.
enum Tint { case auto, light, dark }
struct Redaction { let x, y, w, h, start, end: Double; let tint: Tint }
var redactions: [Redaction] = []
if let rp = env["REDACT_REGIONS"], let data = FileManager.default.contents(atPath: rp) {
    struct JRedact: Decodable { let x, y, w, h, start, end: Double; let tint: String? }
    guard let js = try? JSONDecoder().decode([JRedact].self, from: data) else { fail("bad REDACT_REGIONS json") }
    redactions = js.map {
        let tint: Tint = $0.tint == "light" ? .light : $0.tint == "dark" ? .dark : .auto
        return Redaction(x: $0.x, y: $0.y, w: $0.w, h: $0.h, start: $0.start, end: $0.end, tint: tint)
    }
}
// Frosted-glass tuning. alpha = overlay opacity (aesthetics + residual attenuation);
// radius = clamp(k*min(w,h), floor, cap) in output px. The FLOOR is a SAFETY
// parameter (REDACTION-PLAN §3, DECISIONS 2026-07-25) — heavy blur is what erases
// the text; it may rise but not fall without a stated reason. saturation mutes
// color bleed. Defaults are the plan's starting values; tuned by eye later.
let redactAlpha = Double(env["REDACT_ALPHA"] ?? "0.6")!
let redactRadiusK = Double(env["REDACT_RADIUS_K"] ?? "0.08")!
let redactRadiusFloor = Double(env["REDACT_RADIUS_FLOOR"] ?? "16")!
let redactRadiusCap = Double(env["REDACT_RADIUS_CAP"] ?? "90")!
let redactSaturation = Double(env["REDACT_SATURATION"] ?? "0.5")!
let redactDebug = env["REDACT_DEBUG"] == "on"
// Base layer: "pixelate" (mosaic — quantizes within-cell info, NOT invertible) or
// "blur" (legacy gaussian — shape-preserving + invertible, kept only for A/B; it
// CANNOT redact large text, see DECISIONS 2026-07-26). Default = pixelate.
//
// CELL SIZE is the safety parameter (DECISIONS 2026-07-26): cell = clamp(K*minDim,
// FLOOR, CAP). It must exceed the text stroke width or the mosaic preserves the
// glyph (cell 16 leaked, 24 held on big bold). FLOOR is the safety floor — it does
// not come down without a logged reason; K/CAP are aesthetic. REDACT_CELL forces an
// absolute cell for calibration sweeps.
let redactMode = env["REDACT_MODE"] ?? "pixelate"
let redactCellK = Double(env["REDACT_CELL_K"] ?? "0.3")!
// FLOOR = 24, the known-safe value (DECISIONS 2026-07-27). It was briefly dropped to
// 10 for finer small-text mosaic, but that let a short small-values strip export
// LEGIBLE (cell 11). The floor is THE safety guarantee — the stroke-clamp below is a
// secondary check only, NOT the guarantee: stroke is ~1/4 of a character, so
// cell > 1.5*stroke is satisfied while a digit still survives. Do not lower again
// without eye-validated tuning across sizes (a ratio is not predictive — big text was
// safe at cell/charH 0.33 while the strip failed at 0.38).
let redactCellFloor = Double(env["REDACT_CELL_FLOOR"] ?? "24")!
let redactCellCap = Double(env["REDACT_CELL_CAP"] ?? "220")!
// SECONDARY check (not the safety guarantee — the floor is): still clamp cell up to
// MARGIN x the measured stroke, so a pathological small-box-over-thick-strokes case
// can't slip under the floor. It essentially never fires while the floor is 24.
let redactStrokeMargin = Double(env["REDACT_CELL_STROKE_MARGIN"] ?? "1.5")!
let redactCellForce = Double(env["REDACT_CELL"] ?? "")

try? FileManager.default.removeItem(at: outURL)

let asset = AVURLAsset(url: inURL)

// Synchronous track load (CLI tool).
let sem0 = DispatchSemaphore(value: 0)
var videoTrack: AVAssetTrack?
Task {
    videoTrack = try? await asset.loadTracks(withMediaType: .video).first
    sem0.signal()
}
sem0.wait()
guard let track = videoTrack else { fail("no video track") }

let sizeSem = DispatchSemaphore(value: 0)
var naturalSize = CGSize.zero
var nominalFPS: Float = 30
var srcDuration: Double = 0
Task {
    naturalSize = (try? await track.load(.naturalSize)) ?? .zero
    nominalFPS = (try? await track.load(.nominalFrameRate)) ?? 30
    srcDuration = CMTimeGetSeconds((try? await asset.load(.duration)) ?? .zero)
    sizeSem.signal()
}
sizeSem.wait()
let W = Int(naturalSize.width), H = Int(naturalSize.height)
guard W > 0, H > 0 else { fail("bad dimensions \(W)x\(H)") }
// CFR output rate. nominalFrameRate UNDER-reports on an idle-skipped VFR capture
// (it's the average incl. static stretches — e.g. 24 on a 30fps-target recording),
// and a grid below the active-content peak would subsample real motion frames. The
// recorder targets 30 (minimumFrameInterval 1/30), so floor the grid at 30; a
// genuinely higher-rate source (nominal > 30) is still honored.
let fps = max(30, Int(nominalFPS.rounded()))

// Output resolution: composite at source WxH, then (when OUTPUT_* request smaller
// dims) append a terminal Lanczos downscale before the writer — mirrors V2's
// mp4_scale, which likewise scales AFTER the overlays. Rust passes even,
// aspect-matched dims (v3_output_dims); absent -> output == source.
let outW = Int(env["OUTPUT_WIDTH"] ?? "") ?? W
let outH = Int(env["OUTPUT_HEIGHT"] ?? "") ?? H
let downscaleOut = outW > 0 && outH > 0 && (outW != W || outH != H)

// Trim window (seconds, original timeline). The output grid runs [trimIn, trimOut]
// but output PTS is rebased to 0; source frames and zoom are sampled at the ORIGINAL
// time tSrc = trimIn + frames/fps, so a zoom straddling the cut renders its correct
// partial scale at t=0 with no per-segment shift. Absent -> whole source, byte-
// identical to the untrimmed path (nothing below fires when trimIn==0 && trimOut>=dur).
let trimIn = max(0.0, Double(env["TRIM_IN"] ?? "0") ?? 0.0)
let trimOut = { () -> Double in
    let v = Double(env["TRIM_OUT"] ?? "") ?? srcDuration
    return v > 0 ? v : srcDuration
}()
let isTrimmed = trimIn > 0.0001 || (srcDuration > 0 && trimOut < srcDuration - 0.0001)

// Bitrate at a constant ~0.18 bits/pixel (BITS_PER_PIXEL), the same density the
// historical flat 8 Mbps encoded at 1512x982x30 logical. Scaling by the actual
// OUTPUT pixels x fps keeps quality-per-pixel constant: ~32 Mbps at a 3024x1964
// backing capture, ~13 Mbps at a 1920x1246 supersampled 1080p export — instead of
// starving 4x the pixels on a fixed 8 Mbps. VideoToolbox ABR undershoots this
// ceiling on compressible screen content, so it costs little on typical dashboards.
let bitsPerPixel = Double(env["BITS_PER_PIXEL"] ?? "0.18") ?? 0.18
let outBitrate = max(4_000_000, Int(Double(outW * outH) * Double(fps) * bitsPerPixel))

// --- Reader: decode to native 709 video-range YCbCr, so CIImage interprets the
// source color from the buffer's own attachments instead of us guessing a transfer
// on a BGRA buffer (that guess shifted luma ~27 dB in Phase 1's first measurement). ---
guard let reader = try? AVAssetReader(asset: asset) else { fail("reader init") }
let readerOutput = AVAssetReaderTrackOutput(
    track: track,
    outputSettings: [kCVPixelBufferPixelFormatTypeKey as String:
                        kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange])
// CFR resampling holds a source frame across multiple output ticks during an idle
// gap, so the held buffer must survive the next copyNextSampleBuffer — copy it out
// of the reader's reused memory rather than referencing it.
readerOutput.alwaysCopiesSampleData = true
guard reader.canAdd(readerOutput) else { fail("cannot add reader output") }
reader.add(readerOutput)
// Trim: restrict decode to [trimIn, trimOut]. AVAssetReader decodes from the
// preceding sync sample and delivers frames with PTS in range, so it's frame-
// accurate (matches V2's -ss/-to first-frame-at-or-after-trimIn) AND avoids
// decoding-and-discarding everything before a late cut. Delivered PTS stay in the
// ORIGINAL timeline, which is what the tSrc comparison below expects. Set only when
// trimming, so the untrimmed path is unchanged.
if isTrimmed {
    reader.timeRange = CMTimeRange(
        start: CMTime(seconds: trimIn, preferredTimescale: 600),
        end: CMTime(seconds: trimOut, preferredTimescale: 600))
}

// --- Webcam reader (bubble): a second stream, decoded in lockstep — ONE webcam frame
// pulled per screen frame. KNOWN GAP: this assumes screen and webcam share the same
// fps (true for our captures). It does NOT handle composite.rs's WEBCAM_LEAD_MS A/V
// lead, nor a webcam at a different frame rate — if webcam fps ever differs from the
// screen, the bubble will drift out of sync and this 1:1 pull must become PTS-matched.
// Harmless while fps matches; surfaces here the moment it doesn't.
var webcamOutput: AVAssetReaderTrackOutput? = nil
var webcamReader: AVAssetReader? = nil
if let wcPath = bubbleWebcam {
    let wcAsset = AVURLAsset(url: URL(fileURLWithPath: wcPath))
    let wcSem = DispatchSemaphore(value: 0)
    var wcTrack: AVAssetTrack? = nil
    Task { wcTrack = try? await wcAsset.loadTracks(withMediaType: .video).first; wcSem.signal() }
    wcSem.wait()
    guard let wt = wcTrack, let wr = try? AVAssetReader(asset: wcAsset) else { fail("webcam reader init") }
    // Decode native 709 video-range YCbCr (NOT BGRA): a BGRA decode makes the reader
    // guess the YUV->RGB matrix, which lands hardest on green (green depends most on
    // both chroma channels) — the Phase 1 color-guess class. Native YCbCr lets CI read
    // the color from the buffer's own attachments. hflip/crop/scale/mask run fine on it.
    let wo = AVAssetReaderTrackOutput(track: wt, outputSettings:
        [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange])
    wo.alwaysCopiesSampleData = false
    guard wr.canAdd(wo) else { fail("cannot add webcam output") }
    wr.add(wo)
    guard wr.startReading() else { fail("webcam startReading: \(wr.error?.localizedDescription ?? "?")") }
    // Trim: drop the first `bubbleWebcamSkipFrames` webcam frames so output frame 0
    // shows webcam content from (trim_in - lead) — V2's wc_skip. Discard by frame
    // count (not time) to match V2's frame mapping exactly. Cheap: 720p decode, and
    // only the skipped frames, done once before the render loop.
    if bubbleWebcamSkipFrames > 0 {
        var dropped = 0
        while dropped < bubbleWebcamSkipFrames, wo.copyNextSampleBuffer() != nil {
            dropped += 1
        }
    }
    webcamOutput = wo; webcamReader = wr
}

// --- Writer: VideoToolbox H.264, explicit 8M ABR, BT.709 tags ---
guard let writer = try? AVAssetWriter(outputURL: outURL, fileType: .mp4) else { fail("writer init") }
let writerInput = AVAssetWriterInput(mediaType: .video, outputSettings: [
    AVVideoCodecKey: AVVideoCodecType.h264,
    AVVideoWidthKey: outW,
    AVVideoHeightKey: outH,
    AVVideoCompressionPropertiesKey: [
        AVVideoAverageBitRateKey: outBitrate,
        AVVideoProfileLevelKey: kVTProfileLevel_H264_High_AutoLevel as String,
        AVVideoExpectedSourceFrameRateKey: fps,
        AVVideoMaxKeyFrameIntervalKey: fps * 2,
    ],
    AVVideoColorPropertiesKey: [
        AVVideoColorPrimariesKey: AVVideoColorPrimaries_ITU_R_709_2,
        AVVideoTransferFunctionKey: AVVideoTransferFunction_ITU_R_709_2,
        AVVideoYCbCrMatrixKey: AVVideoYCbCrMatrix_ITU_R_709_2,
    ],
])
writerInput.expectsMediaDataInRealTime = false
// Render CI straight to 709 video-range YCbCr (no RGB intermediate). Measured
// equivalent to a BGRA intermediate at 45.4 dB once color management is off (below).
let outFmt = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
let adaptor = AVAssetWriterInputPixelBufferAdaptor(
    assetWriterInput: writerInput,
    sourcePixelBufferAttributes: [
        kCVPixelBufferPixelFormatTypeKey as String: outFmt,
        kCVPixelBufferWidthKey as String: outW,
        kCVPixelBufferHeightKey as String: outH,
    ])
guard writer.canAdd(writerInput) else { fail("cannot add writer input") }
writer.add(writerInput)

// Color management OFF (workingColorSpace = NSNull). Phase 1 measured that CI's
// managed 709->linear->709 round-trip lifts luma ~2.75 levels (a transfer-curve
// mismatch): PSNR-Y 32.9 dB, err_mean -2.75. Disabling it removes the shift
// entirely -> 45.4 dB, err_mean +0.01. We composite in the source's own
// (non-linear) space, matching V2's gamma-space behavior, and never pay CI's
// transfer tax. NOTE for later phases: blur/motion-blur are physically "more
// correct" in linear light; if a specific overlay looks wrong we revisit managed
// color with an explicit input-space match, but identity does NOT want it.
let ciContext = CIContext(options: [.workingColorSpace: NSNull()])
let cs709 = CGColorSpace(name: CGColorSpace.itur_709)!

guard reader.startReading() else { fail("startReading: \(reader.error?.localizedDescription ?? "?")") }
guard writer.startWriting() else { fail("startWriting: \(writer.error?.localizedDescription ?? "?")") }
writer.startSession(atSourceTime: .zero)

let queue = DispatchQueue(label: "v3.compositor")
let done = DispatchSemaphore(value: 0)
var frames = 0
let t0 = Date()
let Wd = Double(W), Hd = Double(H)
// velocity-tracking state (a fixed source point's output-space motion frame to frame)
var prevO0x = Wd / 2, prevO0y = Hd / 2, prevScale = 1.0, havePrev = false

// Background canvas (WxH = source dims; canvas = source in v1). Static for the whole
// render, so build once. A gradient is a CILinearGradient light-corner (top-left) ->
// deep-corner (bottom-right), so the built-in top-left light pairs with the downward
// elevation shadow; a solid is the flat fill (proven Slice 1 path).
let backgroundImage: CIImage? = {
    guard insetActive, let (a, b) = bgColors else { return nil }
    let canvas = CGRect(x: 0, y: 0, width: Wd, height: Hd)
    guard bgIsGradient, let g = CIFilter(name: "CILinearGradient") else {
        return CIImage(color: a).cropped(to: canvas)
    }
    // Vertical, dark-top -> light-bottom: the full A->B range lands across the TOP
    // and BOTTOM margins (the bands you actually see), not the thin side margins a
    // diagonal cuts across at an angle. b is the dark stop, a the light stop.
    g.setValue(CIVector(x: 0, y: Hd), forKey: "inputPoint0")   // top (CI y-up)
    g.setValue(b, forKey: "inputColor0")                        // dark at top
    g.setValue(CIVector(x: 0, y: 0), forKey: "inputPoint1")     // bottom
    g.setValue(a, forKey: "inputColor1")                        // light at bottom
    return (g.outputImage ?? CIImage(color: a)).cropped(to: canvas)
}()

// --- Frame styling geometry + static layers (BACKGROUND-PADDING-PLAN Slice 2). The
// inset content occupies an integer (W*k)x(H*k) rect centered on the canvas; the corner
// mask, drop shadow, and inset border are constant for the whole render, so build once.
let insetK = 1.0 - framePadding
let insetW = Int((Wd * insetK).rounded())
let insetH = Int((Hd * insetK).rounded())
let insetOx = ((Wd - Double(insetW)) / 2).rounded()   // content origin in canvas (CI bottom-left)
let insetOy = ((Hd - Double(insetH)) / 2).rounded()
let insetShort = Double(min(insetW, insetH))
let cornerPx = CGFloat(frameCornerFrac * insetShort)

// Rounded-corner alpha mask at content-local extent. nil when square -> the Slice 1
// path (no masking, no resample cost) is preserved exactly.
let contentMask: CIImage? = (insetActive && cornerPx >= 0.5)
    ? roundedFill(w: insetW, h: insetH, radius: cornerPx, gray: 1.0, alpha: 1.0)
    : nil

// Background + drop shadow, composited once. Shadow = a black rounded silhouette
// (matching the content corners), blurred and offset DOWN, placed under the content.
// Blur/offset scale with content size; FRAME_SHADOW is the opacity intensity. A dark
// shadow reads on LIGHT backgrounds; on DARK backgrounds the inset border carries the
// edge separation — that is why both exist. Returns the bare bg when shadow is 0.
let bgWithShadow: CIImage? = {
    guard insetActive, let bg = backgroundImage else { return nil }
    guard frameShadow > 0,
          let sil = roundedFill(w: insetW, h: insetH, radius: cornerPx,
                                gray: 0.0, alpha: CGFloat(min(1.0, shadowAlphaK * frameShadow)))
    else { return bg }
    let marginShort = framePadding * min(Wd, Hd) / 2   // the tighter (vertical) margin
    let blur = shadowBlurK * marginShort
    let dy = shadowDyK * marginShort
    let shadow = sil.applyingFilter("CIGaussianBlur", parameters: [kCIInputRadiusKey: blur])
        .transformed(by: CGAffineTransform(translationX: insetOx, y: insetOy - dy))
        .cropped(to: CGRect(x: 0, y: 0, width: Wd, height: Hd))
    return shadow.composited(over: bg)
}()

// Inset border: a thin light rim on the content edge (canvas-placed). nil when 0.
let borderLayer: CIImage? = {
    guard insetActive, frameInsetFrac > 0 else { return nil }
    let lw = max(1.0, CGFloat(frameInsetFrac * insetShort))
    return roundedStroke(w: insetW, h: insetH, radius: cornerPx, lineWidth: lw,
                         gray: 1.0, alpha: 0.5)?
        .transformed(by: CGAffineTransform(translationX: insetOx, y: insetOy))
        .cropped(to: CGRect(x: 0, y: 0, width: Wd, height: Hd))
}()

// Pre-scale the watermark once (constant for the whole recording) and precompute
// its integer top-left. scale: width-based round(sw*frac) (aspect kept) or legacy
// round(0.10*min(sw,sh)) height (composite.rs metrics); opacity multiplies alpha.
var wmComposite: CIImage? = nil
if let wp = env["WATERMARK_PNG"], let logo = CIImage(contentsOf: URL(fileURLWithPath: wp)) {
    let shortSide = min(Wd, Hd)
    let factor = wmScaleFrac.map { ($0 * Wd).rounded() / logo.extent.width }
        ?? ((shortSide * 0.10).rounded() / logo.extent.height)
    var layer = logo.applyingFilter("CILanczosScaleTransform",
        parameters: [kCIInputScaleKey: factor, kCIInputAspectRatioKey: 1.0])
    if wmOpacity < 0.999 {
        layer = layer.applyingFilter("CIColorMatrix",
            parameters: ["inputAVector": CIVector(x: 0, y: 0, z: 0, w: wmOpacity)])
    }
    let ow = layer.extent.width, oh = layer.extent.height
    let p = (shortSide * 0.02).rounded()  // composite.rs padding = 2% of short side
    // ffmpeg corner (top-left origin) -> CI bottom-left; integer placement.
    let leftX = p, rightX = Wd - ow - p
    let topY = Hd - p - oh, botY = p
    let (tx, ty): (Double, Double)
    switch wmCorner {
    case "tl": (tx, ty) = (leftX, topY)
    case "bl": (tx, ty) = (leftX, botY)
    case "br": (tx, ty) = (rightX, botY)
    default:   (tx, ty) = (rightX, topY)  // tr (composite.rs default)
    }
    wmComposite = layer.transformed(
        by: CGAffineTransform(translationX: tx.rounded(), y: ty.rounded()))
}

// --- Webcam bubble static setup: the mask (applied per frame to the live webcam)
// and the shadow (fully static — blur + alpha + placement precomputed once). Shadow
// geometry mirrors composite.rs exactly (padding 0.25*d, sigma 0.075*d, offset d/30).
var bubbleMask: CIImage? = nil
var bubbleShadowLayers: [CIImage] = []   // composited under the bubble, in order
var bubbleTx = 0.0, bubbleTy = 0.0
if bubbleWebcam != nil {
    guard let mp = bubbleMaskPath, let mask = CIImage(contentsOf: URL(fileURLWithPath: mp))
        else { fail("bubble mask missing (BUBBLE_MASK_PNG)") }
    guard let shp = bubbleShadowPath, let shadow = CIImage(contentsOf: URL(fileURLWithPath: shp))
        else { fail("bubble shadow missing (BUBBLE_SHADOW_PNG)") }
    bubbleMask = mask
    let d = bubbleDiameter
    let p = Double(env["BUBBLE_PADDING"] ?? "30")!   // composite.rs PADDING_PX; env override for the harness
    let hRight = bubbleZone.hasSuffix("r"), hCenter = bubbleZone.hasSuffix("c")
    let vTop = bubbleZone.hasPrefix("t"), vCenter = bubbleZone.hasPrefix("c")
    // ffmpeg top-left (top-left origin), ow=oh=d for the bubble. Center row is
    // vertically centered (no edge padding); mirrors Review's BubbleLayer.
    let bx = hRight ? (Wd - d - p) : (hCenter ? (Wd - d) / 2 : p)
    let by = vTop ? p : (vCenter ? (Hd - d) / 2 : (Hd - d - p))
    bubbleTx = bx.rounded(); bubbleTy = (Hd - by - d).rounded()   // -> CI bottom-left
    // Bubble center in CI (bottom-left) coords; the shadow places relative to it.
    let bubbleCx = bubbleTx + d / 2, bubbleCy = bubbleTy + d / 2
    // Place a shadow layer: gaussian-blur the (black) silhouette, dim to `alpha`,
    // center it on the bubble offset `dropX` right and `dropY` down (screen-down =
    // CI-down). Canvas-agnostic — centers by the blurred extent. flat with
    // dropX=0, dropY=d/30 reproduces the prior placement.
    func shadowLayer(blur: Double, alpha: Double, dropX: Double, dropY: Double) -> CIImage {
        let blurred = shadow.applyingFilter("CIGaussianBlur",
            parameters: [kCIInputRadiusKey: blur]).cropped(to: shadow.extent)
        let dimmed = blurred.applyingFilter("CIColorMatrix",
            parameters: ["inputAVector": CIVector(x: 0, y: 0, z: 0, w: alpha)])
        let e = dimmed.extent
        return dimmed.transformed(by: CGAffineTransform(
            translationX: (bubbleCx + dropX - e.midX).rounded(),
            y: (bubbleCy - dropY - e.midY).rounded()))
    }
    switch bubbleDepth {
    case "elevated":  // offset-down-right drop shadow (same-size silhouette)
        bubbleShadowLayers = [shadowLayer(
            blur: elevBlurFrac * d, alpha: elevAlpha,
            dropX: elevOffsetXFrac * d, dropY: elevOffsetFrac * d)]
    default:  // flat: the current single drop shadow (sigma=0.075d, offset=d/30)
        bubbleShadowLayers = [shadowLayer(
            blur: bubbleShadowRadiusK * (0.075 * d).rounded(),
            alpha: bubbleShadowAlpha, dropX: 0, dropY: (d / 30.0).rounded())]
    }
}
var lastBubble: CIImage? = nil

// Per-region redaction sample: mean luminance (adaptive tint) + stroke width (cell
// safety clamp), computed ONCE the first time a region is active and HELD for its
// whole duration — no per-frame re-sample, so a static region over changing content
// can't flicker (owner requirement 2026-07-26). Keyed by region index.
var redactSampled: [Int: (dark: Bool, stroke: Double)] = [:]
func sampleRegion(_ img: CIImage, _ rect: CGRect) -> (dark: Bool, stroke: Double) {
    let w = max(1, Int(rect.width.rounded())), h = max(1, Int(rect.height.rounded()))
    var buf = [UInt8](repeating: 0, count: w * h * 4)
    let shifted = img.transformed(by: CGAffineTransform(translationX: -rect.minX, y: -rect.minY))
    ciContext.render(shifted, toBitmap: &buf, rowBytes: w * 4,
        bounds: CGRect(x: 0, y: 0, width: w, height: h), format: .RGBA8, colorSpace: cs709)
    func lumaAt(_ i: Int) -> Double {
        0.299 * Double(buf[i]) + 0.587 * Double(buf[i + 1]) + 0.114 * Double(buf[i + 2])
    }
    var sum = 0.0, lo = 255.0, hi = 0.0
    var i = 0
    while i < w * h * 4 {
        let l = lumaAt(i)
        sum += l; if l < lo { lo = l }; if l > hi { hi = l }
        i += 4
    }
    let mean = sum / Double(w * h)
    // Adaptive tint: dark frost over light content, light frost over dark content, so
    // the panel is always perceptible (a light frost on a light card was invisible).
    let dark = mean >= 128
    // Stroke width ~ 2*inkArea/inkPerimeter (same estimator as the gate harness).
    let mid = (lo + hi) / 2
    var darkCount = 0
    i = 0
    while i < w * h * 4 { if lumaAt(i) < mid { darkCount += 1 }; i += 4 }
    let inkIsDark = darkCount <= w * h - darkCount
    func ink(_ x: Int, _ y: Int) -> Bool {
        let l = lumaAt((y * w + x) * 4)
        return inkIsDark ? l < mid : l >= mid
    }
    var area = 0, perim = 0
    for y in 0..<h {
        for x in 0..<w where ink(x, y) {
            area += 1
            let edge = x == 0 || y == 0 || x == w - 1 || y == h - 1
                || !ink(x - 1, y) || !ink(x + 1, y) || !ink(x, y - 1) || !ink(x, y + 1)
            if edge { perim += 1 }
        }
    }
    let stroke = perim > 0 ? 2.0 * Double(area) / Double(perim) : 0
    return (dark, stroke)
}

// CFR resampling: emit output frames on a fixed `fps` grid instead of 1:1 with the
// VFR source. SCK skips unchanged (idle) frames, so the capture is VFR — a zoom keyed
// off frame PTS then lurches across an idle gap (the V3 stutter). For each output tick
// we composite the source frame CURRENT at tOut (held across gaps) and stamp a regular
// PTS, so the zoom animates in even 1/fps steps regardless of source frame drops.
func nextSourceFrame() -> (CMTime, CVPixelBuffer)? {
    guard let s = readerOutput.copyNextSampleBuffer(),
          let p = CMSampleBufferGetImageBuffer(s) else { return nil }
    return (CMSampleBufferGetPresentationTimeStamp(s), p)  // alwaysCopies -> p survives s
}
var pending = nextSourceFrame()   // next source frame not yet reached by the grid
var held: CVPixelBuffer? = nil    // source frame current at tOut, held across idle gaps
// Trimmed output length in frames (V2 -ss/-to parity). Int.max when untrimmed, so
// the untrimmed stop stays exactly the srcDuration+0.5/fps rule below (unchanged).
let stopFrames = isTrimmed ? Int(((trimOut - trimIn) * Double(fps)).rounded()) : Int.max

writerInput.requestMediaDataWhenReady(on: queue) {
    while writerInput.isReadyForMoreMediaData {
        // Output PTS is rebased to 0 (frames/fps); source + zoom are sampled at the
        // ORIGINAL time tSrc = trimIn + frames/fps. Untrimmed (trimIn==0) -> tSrc==tOut,
        // so this path is unchanged. The reader.timeRange already excludes < trimIn.
        let tSrc = trimIn + Double(frames) / Double(fps)
        // Advance to the latest source frame whose PTS <= tSrc; hold it across gaps.
        while let p = pending, CMTimeGetSeconds(p.0) <= tSrc {
            held = p.1
            pending = nextSourceFrame()
        }
        // Before the first in-range source PTS (>= trimIn), show that first frame.
        if held == nil, let p = pending {
            held = p.1
            pending = nextSourceFrame()
        }
        // Done: emitted the whole window, past trimOut, or drained the source.
        // A trim emits exactly round((trimOut-trimIn)*fps) frames to match V2's
        // -ss/-to count; without this cap the +0.5/fps end-tolerance (which exists
        // to include the untrimmed last frame) overruns a trim by one frame.
        let pastEnd = frames >= stopFrames
            || (trimOut > 0 ? tSrc > trimOut + 0.5 / Double(fps) : pending == nil)
        guard let pixels = held, !pastEnd else {
            writerInput.markAsFinished()
            writer.finishWriting { done.signal() }
            return
        }
        let t = tSrc  // original-timeline time -> zoom straddling the cut renders correctly
        // No colorSpace override: CI reads the 709 video-range attachments the
        // decoder put on the YCbCr buffer, so input color is interpreted, not guessed.
        let src = CIImage(cvPixelBuffer: pixels)

        // Zoom geometry (mirror gpuzoom/Review.tsx): clamped off-center window of
        // size W/s x H/s, focus mapped to output center. q is CI bottom-left px.
        let s = zoomAt(segs, t)
        let (cxf, cyf) = centerAt(segs, t)
        let cx = cxf * Wd, cy = Hd - cyf * Hd
        let hw = Wd / (2 * s), hh = Hd / (2 * s)
        let qx = min(max(cx, hw), Wd - hw)
        let qy = min(max(cy, hh), Hd - hh)

        var out = src
        if s > 1.0001 {
            // ONE lanczos resample: sub-pixel window crop (exact, CI is continuous)
            // -> translate window origin to 0 (exact) -> lanczos scale by s to WxH.
            let win = CGRect(x: qx - hw, y: qy - hh, width: Wd / s, height: Hd / s)
            let cropped = src.clampedToExtent().cropped(to: win)
            let atOrigin = cropped.transformed(
                by: CGAffineTransform(translationX: -win.origin.x, y: -win.origin.y))
            let scaled = atOrigin.applyingFilter("CILanczosScaleTransform",
                parameters: [kCIInputScaleKey: s, kCIInputAspectRatioKey: 1.0])
            out = scaled.cropped(to: CGRect(x: 0, y: 0, width: W, height: H))
        }

        // --- velocity for motion blur. The scale-ramp zoom moves content RADIALLY
        // from the focus, so the driver is the corner radial speed from the scale
        // rate, plus any off-center translational drift of the focus reference point.
        let o0x = s * (Wd / 2 - qx) + Wd / 2
        let o0y = s * (Hd / 2 - qy) + Hd / 2
        let transSpeed = havePrev ? hypot(o0x - prevO0x, o0y - prevO0y) : 0.0
        let radialEdge = havePrev ? 0.5 * hypot(Wd, Hd) * abs(s - prevScale) / s : 0.0
        let blurVel = radialEdge + transSpeed
        let blurAmount = (blurVel > blurEps) ? min(blurFloor + blurK * blurVel, blurMax) : 0.0

        // Phase 5 motion blur: ONE radial CIZoomBlur layer from the focus (output
        // center), amount = floor + k*|v|. floor absorbs slow-ramp shimmer; k*|v|
        // absorbs fast-ramp strobe. Applied to the content plane (pre-overlay).
        if blurOn && blurAmount > 0 {
            out = out.clampedToExtent()
                .applyingFilter("CIZoomBlur", parameters: [
                    "inputCenter": CIVector(x: Wd / 2, y: Hd / 2),
                    "inputAmount": blurAmount])
                .cropped(to: CGRect(x: 0, y: 0, width: W, height: H))
        }

        // --- Frosted-glass redaction. Each active region: transform its source-space
        // rect through the CURRENT zoom into output space, clip to frame, and paint a
        // frosted panel (heavy blur + desat + translucent tint) over the content.
        // Guarded on !isEmpty so a no-redaction export never enters here and stays
        // byte-identical to pre-feature.
        if !redactions.isEmpty {
            let winOx = qx - hw, winOy = qy - hh   // zoom crop origin in source CI px
            for (ri, r) in redactions.enumerated() where t >= r.start && t <= r.end {
                // Source rect in CI bottom-left px (r.* are top-left fractions).
                let sx = r.x * Wd
                let sy = Hd - (r.y + r.h) * Hd
                let sw = r.w * Wd, sh = r.h * Hd
                // Map to output (post-zoom) space: (src - winOrigin) * s. At s==1,
                // winOrigin==0 and s==1, so an unzoomed region lands on its own pixels.
                let ox = (sx - winOx) * s, oy = (sy - winOy) * s
                let region = CGRect(x: ox, y: oy, width: sw * s, height: sh * s)
                    .intersection(CGRect(x: 0, y: 0, width: Wd, height: Hd))
                if region.isNull || region.isEmpty { continue }
                // Sample the region's content ONCE (mean luma + stroke) from the
                // pre-redaction frame, then hold — no per-frame re-sample.
                let sample = redactSampled[ri] ?? {
                    let s0 = sampleRegion(out, region); redactSampled[ri] = s0; return s0
                }()
                let minDim = min(region.width, region.height)
                let radius = min(max(redactRadiusK * minDim, redactRadiusFloor), redactRadiusCap)
                // Cell: proxy for looks, then CLAMPED UP to MARGIN x measured stroke so
                // safety is measured per region, not assumed (a small box over thick
                // strokes can't slip under). Log when the stroke clamp binds.
                let proxyCell = min(max(redactCellK * minDim, redactCellFloor), redactCellCap)
                let safeCell = redactStrokeMargin * sample.stroke
                var cell = max(proxyCell, safeCell)
                if let forced = redactCellForce { cell = forced }
                let clamped = safeCell > proxyCell && redactCellForce == nil
                if redactDebug {
                    FileHandle.standardError.write(String(format:
                        "REDACT t=%.3f region=%.1f,%.1f %.1fx%.1f mode=%@ radius=%.2f cell=%.2f stroke=%.2f clampUp=%@\n",
                        t, region.minX, region.minY, region.width, region.height, redactMode,
                        radius, cell, sample.stroke, clamped ? "yes" : "no").data(using: .utf8)!)
                }
                // Base layer over the region's OWN content, edge-clamped so the panel is
                // a clean rectangle. Pixelate (mosaic, cell-quantized — destroys within-
                // cell info) or the legacy shape-preserving gaussian blur.
                var frost: CIImage
                if redactMode == "pixelate" {
                    // Grid EDGE-aligned to the region origin: translate the region to
                    // (0,0), pixelate with a cell edge at 0 (inputCenter = cell/2), crop,
                    // translate back. Without this the grid is corner-CENTERED and cells
                    // straddle the box edge by half a cell (tiles overhang the outline).
                    let atOrigin = out.transformed(
                        by: CGAffineTransform(translationX: -region.minX, y: -region.minY))
                        .clampedToExtent()
                    frost = atOrigin.applyingFilter("CIPixellate", parameters: [
                        kCIInputCenterKey: CIVector(x: cell / 2, y: cell / 2),
                        kCIInputScaleKey: cell])
                        .cropped(to: CGRect(x: 0, y: 0, width: region.width, height: region.height))
                        .transformed(by: CGAffineTransform(translationX: region.minX, y: region.minY))
                } else {
                    frost = out.cropped(to: region).clampedToExtent()
                        .applyingFilter("CIGaussianBlur",
                            parameters: [kCIInputRadiusKey: radius]).cropped(to: region)
                }
                if redactSaturation < 0.999 {
                    frost = frost.applyingFilter("CIColorControls",
                        parameters: [kCIInputSaturationKey: redactSaturation])
                }
                // Translucent tint, adaptive unless forced: out = a*C + (1-a)*frost.
                // Dark frost over light content / light frost over dark, so the panel
                // is always visible (a light frost on a light card vanished).
                let dark = r.tint == .light ? false : r.tint == .dark ? true : sample.dark
                let g: CGFloat = dark ? 0.12 : 0.95
                let tint = CIImage(color: CIColor(red: g, green: g, blue: g,
                    alpha: CGFloat(redactAlpha))).cropped(to: region)
                out = tint.composited(over: frost).composited(over: out)
            }
        }

        // Screen-anchored webcam bubble (before watermark; on the final frame). Pull
        // one webcam frame per screen frame: hflip -> centered square crop -> scale to
        // diameter -> circular/rounded mask. Shadow (static) under, bubble over.
        if let wo = webcamOutput, let mask = bubbleMask {
            // `frames` is the 0-based screen frame index here (incremented after
            // append below). Hold webcam frame 0 across the lead, then advance —
            // matches V2's tpad clone-freeze. When !pull, lastBubble carries the
            // held frame (also the natural behavior if the webcam stream ends first).
            let pullWebcam = (frames == 0) || (frames > bubbleLeadFrames)
            if pullWebcam,
               let wcSample = wo.copyNextSampleBuffer(),
               let wcPix = CMSampleBufferGetImageBuffer(wcSample) {
                let wc = CIImage(cvPixelBuffer: wcPix)
                let ww = wc.extent.width, wh = wc.extent.height
                let side = min(ww, wh)
                let flipped = wc.transformed(by: CGAffineTransform(a: -1, b: 0, c: 0, d: 1, tx: ww, ty: 0))
                let sq = CGRect(x: (ww - side) / 2, y: (wh - side) / 2, width: side, height: side)
                let atOrigin = flipped.cropped(to: sq).transformed(
                    by: CGAffineTransform(translationX: -sq.origin.x, y: -sq.origin.y))
                let scaled = atOrigin.applyingFilter("CILanczosScaleTransform",
                    parameters: [kCIInputScaleKey: bubbleDiameter / side, kCIInputAspectRatioKey: 1.0])
                let masked = scaled.applyingFilter("CIBlendWithMask",
                    parameters: ["inputBackgroundImage": CIImage.empty(), "inputMaskImage": mask])
                lastBubble = masked.transformed(by: CGAffineTransform(translationX: bubbleTx, y: bubbleTy))
            }
            for sh in bubbleShadowLayers { out = sh.composited(over: out) }
            if let bub = lastBubble { out = bub.composited(over: out) }
        }

        // Screen-anchored watermark: on the FINAL frame, after motion blur (stays
        // sharp), unaffected by zoom. Constant placement -> just source-over.
        if let wm = wmComposite {
            out = wm.composited(over: out)
        }

        // Background canvas + padding inset (BACKGROUND-PADDING-PLAN Slice 1/2). Scale the
        // finished WxH content UNIFORMLY by k = 1 - padding (one Lanczos pass, aspect kept
        // — not stretched), round its corners (Slice 2), and place it over the background
        // (which already carries the drop shadow) — then lay the inset border on top. Runs
        // after every overlay, so bubble/watermark inset WITH the recording; runs before
        // downscale, so the canvas (= source dims) is what the terminal Lanczos caps to
        // output res. Integer origin keeps the content on the pixel grid (sharp edges).
        if insetActive, let base = bgWithShadow {
            var content = out.cropped(to: CGRect(x: 0, y: 0, width: Wd, height: Hd))
                .applyingFilter("CILanczosScaleTransform",
                    parameters: [kCIInputScaleKey: insetK, kCIInputAspectRatioKey: 1.0])
                .cropped(to: CGRect(x: 0, y: 0, width: Double(insetW), height: Double(insetH)))
            if let mask = contentMask {
                content = content.applyingFilter("CIBlendWithMask",
                    parameters: ["inputBackgroundImage": CIImage.empty(), "inputMaskImage": mask])
            }
            out = content.transformed(by: CGAffineTransform(translationX: insetOx, y: insetOy))
                .composited(over: base)
            if let border = borderLayer { out = border.composited(over: out) }
        }

        // Terminal downscale to the requested output dims — AFTER every overlay, so
        // the bubble/watermark shrink with the frame exactly as V2's mp4_scale does.
        // One Lanczos pass over the exact WxH frame; crop to the even output rect.
        if downscaleOut {
            let sScale = Double(outH) / Hd
            let sAspect = (Double(outW) / Wd) / sScale
            out = out.cropped(to: CGRect(x: 0, y: 0, width: W, height: H))
                .clampedToExtent()
                .applyingFilter("CILanczosScaleTransform",
                    parameters: [kCIInputScaleKey: sScale, kCIInputAspectRatioKey: sAspect])
                .cropped(to: CGRect(x: 0, y: 0, width: outW, height: outH))
        }
        if velLogPath != nil {
            velLog += String(format: "%.4f,%.5f,%.5f,%.4f,%.4f,%.4f\n",
                t, s, s - prevScale, blurVel, blurAmount, transSpeed)
        }
        prevO0x = o0x; prevO0y = o0y; prevScale = s; havePrev = true

        guard let pool = adaptor.pixelBufferPool else { fail("no pixel buffer pool") }
        var outPB: CVPixelBuffer?
        CVPixelBufferPoolCreatePixelBuffer(nil, pool, &outPB)
        guard let dst = outPB else { fail("pool exhausted") }
        // Tag the YCbCr output so CI applies the 709 matrix and the encoder carries
        // the right atoms.
        CVBufferSetAttachment(dst, kCVImageBufferYCbCrMatrixKey,
            kCVImageBufferYCbCrMatrix_ITU_R_709_2, .shouldPropagate)
        CVBufferSetAttachment(dst, kCVImageBufferColorPrimariesKey,
            kCVImageBufferColorPrimaries_ITU_R_709_2, .shouldPropagate)
        CVBufferSetAttachment(dst, kCVImageBufferTransferFunctionKey,
            kCVImageBufferTransferFunction_ITU_R_709_2, .shouldPropagate)
        ciContext.render(out, to: dst, bounds: CGRect(x: 0, y: 0, width: outW, height: outH),
                          colorSpace: cs709)
        let outPTS = CMTime(value: Int64(frames), timescale: Int32(fps))
        if !adaptor.append(dst, withPresentationTime: outPTS) {
            fail("append failed: \(writer.error?.localizedDescription ?? "?")")
        }
        frames += 1
    }
}

done.wait()
if writer.status == .completed {
    if let vp = velLogPath { try? velLog.write(toFile: vp, atomically: true, encoding: .utf8) }
    let dt = Date().timeIntervalSince(t0)
    // scenario is the ZOOM preset (always "identity" when env-driven); the inset note
    // surfaces background/padding so a padded render is visible without sampling pixels.
    let bgDesc = bgIsGradient ? "gradient:\(env["BACKGROUND_GRADIENT"] ?? "?")" : "solid"
    let insetNote = insetActive
        ? String(format: "  bg=%@ pad=%.2f corner=%.3f shadow=%.2f inset=%.3f",
                 bgDesc, framePadding, frameCornerFrac, frameShadow, frameInsetFrac)
        : ""
    print(String(format: "OK  %dx%d->%dx%d  %d frames  scenario=%@%@  wall=%.2fs",
                 W, H, outW, outH, frames, scenario, insetNote, dt))
} else {
    fail("writer status \(writer.status.rawValue): \(writer.error?.localizedDescription ?? "?")")
}
