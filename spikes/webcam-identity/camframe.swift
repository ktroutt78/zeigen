// Spike (2026-11-16): why the iPhone (Continuity) camera's menu-bar zoom is lost
// when Zeigen records.
//
// Grabs one frame from the first camera whose name contains "iPhone".
//   camframe out.png [frame number, default 90] [60 = switch to the 60 fps mode]
//   swiftc -O camframe.swift -o /somewhere/else/camframe
// (Build the binary outside this folder: a loose binary next to Info.plist picks
// up that plist's bundle id.)
//
// Findings, with the zoom set to about 1.9x in the macOS camera menu:
// - One process alone, started cold: zoomed. True for this tool and for ffmpeg.
// - This tool running, a second copy joins (same 30 fps mode): both zoomed.
// - This tool running, ffmpeg joins: both go wide. ContinuityCaptureAgent logs a
//   StopStream/StartStream pair as the stream moves from FR:30 to FR:60.
// - This tool alone switching itself to the 60 fps mode mid-stream: goes wide.
// So the zoom is lost whenever the phone stream restarts in a different mode.
// ffmpeg's avfoundation input always picks the 1280x720 [1-60] mode; the preview
// uses [1-30]. Bundle identity is not the cause: every process here was seen by
// ContinuityCaptureAgent as "missing bundleID", including with Info.plist embedded
// (-Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker Info.plist).
import AVFoundation
import CoreImage

let grabAt = CommandLine.arguments.count > 2 ? Int(CommandLine.arguments[2])! : 90
final class Grabber: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
    let out: URL
    var count = 0
    init(out: URL) { self.out = out }
    func captureOutput(_ o: AVCaptureOutput, didOutput sb: CMSampleBuffer, from c: AVCaptureConnection) {
        count += 1
        guard count == grabAt, let pb = CMSampleBufferGetImageBuffer(sb) else { return }
        let img = CIImage(cvPixelBuffer: pb)
        try! CIContext().writePNGRepresentation(of: img, to: out, format: .RGBA8, colorSpace: CGColorSpaceCreateDeviceRGB())
        print("wrote \(out.path) \(Int(img.extent.width))x\(Int(img.extent.height))")
        exit(0)
    }
}

print("bundle id: \(Bundle.main.bundleIdentifier ?? "none")")
let devices = AVCaptureDevice.DiscoverySession(deviceTypes: [.continuityCamera, .external, .builtInWideAngleCamera], mediaType: .video, position: .unspecified).devices
print(devices.map(\.localizedName))
guard let dev = devices.first(where: { $0.localizedName.contains("iPhone") && !$0.localizedName.contains("Desk") }) else { print("no iPhone camera"); exit(1) }
let session = AVCaptureSession()
session.addInput(try! AVCaptureDeviceInput(device: dev))
// Third argument "60": pick the 1280x720 mode that goes up to 60 fps (the one ffmpeg picks).
if CommandLine.arguments.count > 3, CommandLine.arguments[3] == "60" {
    let f = dev.formats.first { let d = CMVideoFormatDescriptionGetDimensions($0.formatDescription)
        return d.width == 1280 && d.height == 720 && $0.videoSupportedFrameRateRanges.contains { $0.maxFrameRate >= 60 } }!
    try! dev.lockForConfiguration(); dev.activeFormat = f
    dev.activeVideoMinFrameDuration = CMTime(value: 1, timescale: 60); dev.activeVideoMaxFrameDuration = CMTime(value: 1, timescale: 60); dev.unlockForConfiguration()
} else {
    session.sessionPreset = .hd1280x720
}
let output = AVCaptureVideoDataOutput()
let grabber = Grabber(out: URL(fileURLWithPath: CommandLine.arguments[1]))
output.setSampleBufferDelegate(grabber, queue: DispatchQueue(label: "frames"))
session.addOutput(output)
session.startRunning()
DispatchQueue.main.asyncAfter(deadline: .now() + 40) { print("timeout, frames=\(grabber.count)"); exit(2) }
RunLoop.main.run()
