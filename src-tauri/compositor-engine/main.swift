// V3 Core Image compositor.
//   Phase 1 (DONE): identity re-encode, color round-trip proved (color mgmt off).
//   Phase 2 (THIS): zoom transform — SINGLE-resample lanczos with sub-pixel window.
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
// This is the seam where later phases plug in (overlay layers, motion blur). The
// per-frame velocity is computed here (marked below) so Phase 5 motion blur can
// consume it as radius = floor + k*|velocity|.
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

// --- Writer: VideoToolbox H.264, explicit 8M ABR, BT.709 tags ---
guard let writer = try? AVAssetWriter(outputURL: outURL, fileType: .mp4) else { fail("writer init") }
let writerInput = AVAssetWriterInput(mediaType: .video, outputSettings: [
    AVVideoCodecKey: AVVideoCodecType.h264,
    AVVideoWidthKey: W,
    AVVideoHeightKey: H,
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
        kCVPixelBufferWidthKey as String: W,
        kCVPixelBufferHeightKey as String: H,
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
        ciContext.render(out, to: dst, bounds: CGRect(x: 0, y: 0, width: W, height: H),
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
    print(String(format: "OK  %dx%d  %d frames  scenario=%@  wall=%.2fs", W, H, frames, scenario, dt))
} else {
    fail("writer status \(writer.status.rawValue): \(writer.error?.localizedDescription ?? "?")")
}
