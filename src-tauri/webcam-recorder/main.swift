// webcam-recorder: records one camera to an H.264 mp4 on a fixed 30 fps grid.
//
//   webcam-recorder "<camera name>" <out.mp4>
//
// Replaces the ffmpeg avfoundation webcam process. ffmpeg always picks the
// camera's highest-rate 1280x720 mode, and with an iPhone (Continuity) camera
// a client asking for a different mode than the preview makes macOS restart the
// phone stream, which drops the menu-bar zoom. A session preset without touching
// activeFormat joins the preview's stream instead (spikes/webcam-identity).
//
// Frame k of the file has PTS k/30 exactly: the export shows webcam frame N on
// output frame N, so the file must be on the grid. A camera gap is filled by
// repeating the previous frame; a frame landing on an already written slot is
// dropped.
//
// stdout: one line {"event":"first_frame","host_s":<seconds>} when frame 0 is
// written (its capture time on the host clock), for the A/V lead measurement.
// Stop: a line "q" on stdin, or stdin EOF (parent gone). Exit 0 once the file
// is finished; errors go to stderr with a non-zero exit.
import AVFoundation

let fps: Int32 = 30

func fail(_ msg: String) -> Never {
    FileHandle.standardError.write("webcam-recorder: \(msg)\n".data(using: .utf8)!)
    exit(1)
}

guard CommandLine.arguments.count == 3 else { fail("usage: webcam-recorder <camera name> <out.mp4>") }
let cameraName = CommandLine.arguments[1]
let outURL = URL(fileURLWithPath: CommandLine.arguments[2])

let devices = AVCaptureDevice.DiscoverySession(
    deviceTypes: [.continuityCamera, .external, .builtInWideAngleCamera],
    mediaType: .video, position: .unspecified).devices
guard let device = devices.first(where: { $0.localizedName == cameraName }) else {
    fail("no camera named \"\(cameraName)\" (have: \(devices.map(\.localizedName)))")
}

final class Recorder: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
    let session: AVCaptureSession
    var writer: AVAssetWriter?
    var input: AVAssetWriterInput?
    var adaptor: AVAssetWriterInputPixelBufferAdaptor?
    var firstPTS = CMTime.invalid
    var nextSlot: Int64 = 0
    var previous: CVPixelBuffer?
    var duplicated = 0
    var dropped = 0

    init(session: AVCaptureSession) { self.session = session }

    func captureOutput(_ output: AVCaptureOutput, didOutput sb: CMSampleBuffer, from connection: AVCaptureConnection) {
        guard let pb = CMSampleBufferGetImageBuffer(sb) else { return }
        let pts = CMSampleBufferGetPresentationTimeStamp(sb)
        if writer == nil { startWriter(pb, pts) }
        guard let input, let adaptor, input.isReadyForMoreMediaData else { return }

        let slot = Int64((CMTimeGetSeconds(pts - firstPTS) * Double(fps)).rounded())
        if slot < nextSlot { dropped += 1; return }
        // Fill a camera gap with the previous frame so the count stays on time.
        if let previous {
            while nextSlot < slot && input.isReadyForMoreMediaData {
                adaptor.append(previous, withPresentationTime: CMTime(value: nextSlot, timescale: fps))
                nextSlot += 1; duplicated += 1
            }
        }
        guard nextSlot == slot, input.isReadyForMoreMediaData else { return }
        adaptor.append(pb, withPresentationTime: CMTime(value: slot, timescale: fps))
        nextSlot = slot + 1
        previous = pb
    }

    private func startWriter(_ pb: CVPixelBuffer, _ pts: CMTime) {
        guard let w = try? AVAssetWriter(outputURL: outURL, fileType: .mp4) else { fail("cannot create \(outURL.path)") }
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: CVPixelBufferGetWidth(pb),
            AVVideoHeightKey: CVPixelBufferGetHeight(pb),
            AVVideoCompressionPropertiesKey: [
                AVVideoAverageBitRateKey: 4_000_000,
                AVVideoExpectedSourceFrameRateKey: fps,
                AVVideoMaxKeyFrameIntervalKey: fps * 2,
            ],
        ])
        input.expectsMediaDataInRealTime = true
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: nil)
        guard w.canAdd(input) else { fail("cannot add writer input") }
        w.add(input)
        guard w.startWriting() else { fail("startWriting: \(w.error?.localizedDescription ?? "?")") }
        w.startSession(atSourceTime: .zero)
        writer = w; self.input = input; self.adaptor = adaptor
        firstPTS = pts

        // Frame 0's capture time on the host clock (the screen engine's clock).
        let host = session.synchronizationClock.map {
            CMSyncConvertTime(pts, from: $0, to: CMClockGetHostTimeClock())
        } ?? pts
        let line = "{\"event\":\"first_frame\",\"host_s\":\(String(format: "%.6f", CMTimeGetSeconds(host)))}\n"
        FileHandle.standardOutput.write(line.data(using: .utf8)!)
    }

    // Called on the frames queue after the session has stopped.
    func finish() -> Int32 {
        guard let writer, let input else {
            FileHandle.standardError.write("webcam-recorder: no frames captured\n".data(using: .utf8)!)
            return 1
        }
        input.markAsFinished()
        let done = DispatchSemaphore(value: 0)
        writer.finishWriting { done.signal() }
        done.wait()
        if writer.status != .completed {
            FileHandle.standardError.write("webcam-recorder: finish: \(writer.error?.localizedDescription ?? "?")\n".data(using: .utf8)!)
            return 1
        }
        FileHandle.standardError.write("webcam-recorder: frames=\(nextSlot) duplicated=\(duplicated) dropped=\(dropped)\n".data(using: .utf8)!)
        return 0
    }
}

let session = AVCaptureSession()
session.beginConfiguration()
guard let camInput = try? AVCaptureDeviceInput(device: device), session.canAddInput(camInput) else {
    fail("cannot open \(cameraName)")
}
session.addInput(camInput)
// A preset only, never activeFormat or frame durations: a different camera mode
// than the preview's restarts an iPhone camera stream and loses its zoom.
session.sessionPreset = session.canSetSessionPreset(.hd1280x720) ? .hd1280x720 : .high
let videoOutput = AVCaptureVideoDataOutput()
// No videoSettings: asking for a pixel format makes the session pick the camera's
// 1920x1080 mode instead of the preset's 1280x720 one, which restarts an iPhone
// stream the preview already has open (measured 2026-11-16: with the setting,
// 1080p frames and a StopStream/StartStream; without it, 720p and no restart).
let frames = DispatchQueue(label: "webcam.frames")
let recorder = Recorder(session: session)
videoOutput.setSampleBufferDelegate(recorder, queue: frames)
guard session.canAddOutput(videoOutput) else { fail("cannot add video output") }
session.addOutput(videoOutput)
session.commitConfiguration()

// The stdin thread and the session-error observer can both get here; one finishes.
let stopLock = NSLock()
func stopAndExit(code: Int32) -> Never {
    stopLock.lock()  // never unlocked: the second caller waits until exit
    session.stopRunning()
    let result = frames.sync { recorder.finish() }
    exit(code != 0 ? code : result)
}

NotificationCenter.default.addObserver(forName: AVCaptureSession.runtimeErrorNotification, object: session, queue: nil) { note in
    let err = note.userInfo?[AVCaptureSessionErrorKey] as? Error
    FileHandle.standardError.write("webcam-recorder: session error: \(err?.localizedDescription ?? "?")\n".data(using: .utf8)!)
    stopAndExit(code: 1)
}

session.startRunning()

// stdin: "q" or EOF stops. Runs off the main thread so the run loop keeps serving.
Thread.detachNewThread {
    while let line = readLine() {
        if line.trimmingCharacters(in: .whitespaces) == "q" { break }
    }
    stopAndExit(code: 0)
}
RunLoop.main.run()
