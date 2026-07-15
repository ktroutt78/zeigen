// THROWAWAY spike: GPU-native sub-pixel zoom via AVFoundation + Core Image.
// No oversample intermediate — CI samples sub-pixel in hardware (Metal).
// Mirrors Review.tsx zoomAt. Not part of the build; scratchpad only.
// Build: swiftc -O gpuzoom.swift -o gpuzoom
// Run:   ./gpuzoom <in.mp4> <out.mp4> <scenario> [trimStart trimDur]
import Foundation
import AVFoundation
import CoreImage

func easeInOutCubic(_ u: Double) -> Double { u < 0.5 ? 4*u*u*u : 1 - pow(-2*u+2, 3)/2 }

struct Seg { let start, end, scale, ramp, cxf, cyf: Double }

func zoomAt(_ segs: [Seg], _ t: Double) -> Double? {
    for s in segs where t >= s.start && t <= s.end {
        let ramp = min(s.ramp, (s.end - s.start) / 2)
        if ramp <= 0 { return s.scale }
        if t < s.start + ramp { return 1 + (s.scale - 1) * easeInOutCubic((t - s.start) / ramp) }
        if t > s.end - ramp   { return 1 + (s.scale - 1) * easeInOutCubic((s.end - t) / ramp) }
        return s.scale
    }
    return nil
}
func centerAt(_ segs: [Seg], _ t: Double) -> (Double, Double) {
    for s in segs where t >= s.start && t <= s.end { return (s.cxf, s.cyf) }
    return (0.5, 0.5)
}

let args = CommandLine.arguments
guard args.count >= 4 else { FileHandle.standardError.write("usage: gpuzoom in out scenario [trimStart trimDur]\n".data(using:.utf8)!); exit(2) }
let inURL = URL(fileURLWithPath: args[1])
let outURL = URL(fileURLWithPath: args[2])
let scenario = args[3]

// scenarios (clip-relative seconds); ramp 0.6 = real default, 2.5 = slow stress
var segs: [Seg] = []
var trimStart = 0.0, trimDur = 0.0
switch scenario {
case "slow":  segs = [Seg(start:0, end:5, scale:1.6, ramp:2.5, cxf:1750.0/1920, cyf:520.0/1080)]
              trimStart = 40; trimDur = 5
case "multi": segs = [Seg(start:1.5, end:5.0, scale:2.0, ramp:0.6, cxf:0.09, cyf:0.60),
                      Seg(start:6.0, end:9.5, scale:2.2, ramp:0.6, cxf:0.50, cyf:0.48),
                      Seg(start:10.5,end:14.0,scale:2.0, ramp:0.6, cxf:0.911,cyf:0.48)]
              trimStart = 45; trimDur = 15
case "const": segs = [Seg(start:0, end:9999, scale:1.5, ramp:0.0, cxf:0.5, cyf:0.5)]
              trimStart = 0; trimDur = Double(args.count>=6 ? Double(args[5]) ?? 91 : 91)
case "pass":  segs = []; trimStart = 0; trimDur = Double(args.count>=6 ? Double(args[5]) ?? 91 : 91)
case "ident": segs = []; trimStart = 0; trimDur = 91  // composition attached below -> re-encode floor
default: FileHandle.standardError.write("unknown scenario\n".data(using:.utf8)!); exit(2)
}
if args.count >= 6 { trimStart = Double(args[4]) ?? trimStart; trimDur = Double(args[5]) ?? trimDur }

let asset = AVURLAsset(url: inURL)
let comp = AVMutableVideoComposition(asset: asset) { request in
    let src = request.sourceImage
    let W = src.extent.width, H = src.extent.height
    let t = CMTimeGetSeconds(request.compositionTime) - trimStart
    guard let s = zoomAt(segs, t), s > 1.0001 else { request.finish(with: src, context: nil); return }
    let (cxf, cyf) = centerAt(segs, t)
    // top-left target -> Core Image bottom-left origin
    let cx = cxf * Double(W), cy = Double(H) - cyf * Double(H)
    let hw = Double(W) / (2 * s), hh = Double(H) / (2 * s)
    let qx = min(max(cx, hw), Double(W) - hw)
    let qy = min(max(cy, hh), Double(H) - hh)
    // out = s*p + (center - q*s): pure sub-pixel affine, hardware sampled
    let xf = CGAffineTransform(a: CGFloat(s), b: 0, c: 0, d: CGFloat(s),
                               tx: CGFloat(Double(W)/2 - qx*s), ty: CGFloat(Double(H)/2 - qy*s))
    let out = src.clampedToExtent().samplingLinear().transformed(by: xf).cropped(to: src.extent)
    request.finish(with: out, context: nil)
}
comp.frameDuration = CMTime(value: 1, timescale: 30)
comp.renderSize = CGSize(width: 1920, height: 1080)

guard let export = AVAssetExportSession(asset: asset, presetName: AVAssetExportPresetHighestQuality) else {
    FileHandle.standardError.write("no export session\n".data(using:.utf8)!); exit(1)
}
if scenario != "pass" { export.videoComposition = comp }   // pass = pure decode->encode floor
export.outputURL = outURL
export.outputFileType = .mp4
export.timeRange = CMTimeRange(start: CMTime(seconds: trimStart, preferredTimescale: 600),
                               duration: CMTime(seconds: trimDur, preferredTimescale: 600))
try? FileManager.default.removeItem(at: outURL)
let t0 = Date()
let sem = DispatchSemaphore(value: 0)
export.exportAsynchronously { sem.signal() }
sem.wait()
let dt = Date().timeIntervalSince(t0)
if export.status == .completed {
    print(String(format: "OK  scenario=%@  trim=[%.1f,+%.1f]  wall=%.2fs", scenario, trimStart, trimDur, dt))
} else {
    print("FAILED: \(export.status.rawValue) \(export.error?.localizedDescription ?? "")")
    exit(1)
}
