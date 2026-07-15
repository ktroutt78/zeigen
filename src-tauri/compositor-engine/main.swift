// V3 Core Image compositor — Phase 1: identity re-encode.
//
// Decodes a video, routes every frame through a CIContext (identity filter for
// now — the point is to exercise the exact color path V3 will use), and re-encodes
// via AVAssetWriter -> VideoToolbox H.264 with EXPLICIT 8M ABR and BT.709 color
// tags. No zoom, no overlays yet. Video only; audio stays in ffmpeg and muxes later.
//
// This is the seam where all later phases plug in (zoom transform, overlay layers,
// motion blur). Phase 1's whole job is to prove the color round-trip is correct on
// the simplest possible pipeline, measured by the harness, before any overlay can
// confound a color delta.
//
// NOT wired into the app yet: nothing in the Rust export path invokes this. V2
// (ffmpeg) stays the default. Build: swiftc -O main.swift -o cicompositor
// Run:   ./cicompositor <in.mp4> <out.mp4>
import Foundation
import AVFoundation
import CoreImage
import VideoToolbox

func fail(_ msg: String) -> Never {
    FileHandle.standardError.write((msg + "\n").data(using: .utf8)!)
    exit(1)
}

let args = CommandLine.arguments
guard args.count == 3 else { fail("usage: cicompositor <in.mp4> <out.mp4>") }
let inURL = URL(fileURLWithPath: args[1])
let outURL = URL(fileURLWithPath: args[2])
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

writerInput.requestMediaDataWhenReady(on: queue) {
    while writerInput.isReadyForMoreMediaData {
        guard let sample = readerOutput.copyNextSampleBuffer(),
              let pixels = CMSampleBufferGetImageBuffer(sample) else {
            writerInput.markAsFinished()
            writer.finishWriting { done.signal() }
            return
        }
        let pts = CMSampleBufferGetPresentationTimeStamp(sample)
        // No colorSpace override: CI reads the 709 video-range attachments the
        // decoder put on the YCbCr buffer, so input color is interpreted, not guessed.
        let src = CIImage(cvPixelBuffer: pixels)

        // Identity for Phase 1. Later phases replace this with the layer stack.
        let out = src

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
    let dt = Date().timeIntervalSince(t0)
    print(String(format: "OK  %dx%d  %d frames  wall=%.2fs", W, H, frames, dt))
} else {
    fail("writer status \(writer.status.rawValue): \(writer.error?.localizedDescription ?? "?")")
}
