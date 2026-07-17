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

// --- Webcam bubble (Phase 4): a SECOND video stream, composited on the final zoomed
// frame (screen-anchored, constant placement). Mask + shadow silhouette PNGs are
// pre-rendered (by the harness now, by Rust reusing composite.rs later) and fed to
// both renderers, so only the composite math differs. Diameter drives the shadow
// geometry exactly like composite.rs. Absent BUBBLE_WEBCAM -> no bubble.
let bubbleWebcam = env["BUBBLE_WEBCAM"]
let bubbleMaskPath = env["BUBBLE_MASK_PNG"]
let bubbleShadowPath = env["BUBBLE_SHADOW_PNG"]
let bubbleDiameter = Double(env["BUBBLE_DIAMETER"] ?? "240")!
let bubbleZone = env["BUBBLE_ZONE"] ?? "br"          // br|bl|tr|tl|bc|tc
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
Task {
    naturalSize = (try? await track.load(.naturalSize)) ?? .zero
    nominalFPS = (try? await track.load(.nominalFrameRate)) ?? 30
    sizeSem.signal()
}
sizeSem.wait()
let W = Int(naturalSize.width), H = Int(naturalSize.height)
guard W > 0, H > 0 else { fail("bad dimensions \(W)x\(H)") }
let fps = nominalFPS > 0 ? Int(nominalFPS.rounded()) : 30

// Output resolution: composite at source WxH, then (when OUTPUT_* request smaller
// dims) append a terminal Lanczos downscale before the writer — mirrors V2's
// mp4_scale, which likewise scales AFTER the overlays. Rust passes even,
// aspect-matched dims (v3_output_dims); absent -> output == source.
let outW = Int(env["OUTPUT_WIDTH"] ?? "") ?? W
let outH = Int(env["OUTPUT_HEIGHT"] ?? "") ?? H
let downscaleOut = outW > 0 && outH > 0 && (outW != W || outH != H)

// --- Reader: decode to native 709 video-range YCbCr, so CIImage interprets the
// source color from the buffer's own attachments instead of us guessing a transfer
// on a BGRA buffer (that guess shifted luma ~27 dB in Phase 1's first measurement). ---
guard let reader = try? AVAssetReader(asset: asset) else { fail("reader init") }
let readerOutput = AVAssetReaderTrackOutput(
    track: track,
    outputSettings: [kCVPixelBufferPixelFormatTypeKey as String:
                        kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange])
readerOutput.alwaysCopiesSampleData = false
guard reader.canAdd(readerOutput) else { fail("cannot add reader output") }
reader.add(readerOutput)

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
    webcamOutput = wo; webcamReader = wr
}

// --- Writer: VideoToolbox H.264, explicit 8M ABR, BT.709 tags ---
guard let writer = try? AVAssetWriter(outputURL: outURL, fileType: .mp4) else { fail("writer init") }
let writerInput = AVAssetWriterInput(mediaType: .video, outputSettings: [
    AVVideoCodecKey: AVVideoCodecType.h264,
    AVVideoWidthKey: outW,
    AVVideoHeightKey: outH,
    AVVideoCompressionPropertiesKey: [
        AVVideoAverageBitRateKey: 8_000_000,
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
    let vTop = bubbleZone.hasPrefix("t")
    // ffmpeg top-left (top-left origin), ow=oh=d for the bubble.
    let bx = hRight ? (Wd - d - p) : (hCenter ? (Wd - d) / 2 : p)
    let by = vTop ? p : (Hd - d - p)
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

writerInput.requestMediaDataWhenReady(on: queue) {
    while writerInput.isReadyForMoreMediaData {
        guard let sample = readerOutput.copyNextSampleBuffer(),
              let pixels = CMSampleBufferGetImageBuffer(sample) else {
            writerInput.markAsFinished()
            writer.finishWriting { done.signal() }
            return
        }
        let pts = CMSampleBufferGetPresentationTimeStamp(sample)
        let t = CMTimeGetSeconds(pts)
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
        if !adaptor.append(dst, withPresentationTime: pts) {
            fail("append failed: \(writer.error?.localizedDescription ?? "?")")
        }
        frames += 1
    }
}

done.wait()
if writer.status == .completed {
    if let vp = velLogPath { try? velLog.write(toFile: vp, atomically: true, encoding: .utf8) }
    let dt = Date().timeIntervalSince(t0)
    print(String(format: "OK  %dx%d->%dx%d  %d frames  scenario=%@  wall=%.2fs",
                 W, H, outW, outH, frames, scenario, dt))
} else {
    fail("writer status \(writer.status.rawValue): \(writer.error?.localizedDescription ?? "?")")
}
