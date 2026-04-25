import AVFoundation
import CoreMedia
import Foundation
import ScreenCaptureKit

final class Recorder: NSObject, SCStreamOutput {
    let writer: AVAssetWriter
    let input: AVAssetWriterInput
    var sessionStarted = false
    var firstPTS: CMTime = .zero
    var droppedFrames = 0
    var appendedFrames = 0

    init(outputURL: URL, width: Int, height: Int) throws {
        try? FileManager.default.removeItem(at: outputURL)
        self.writer = try AVAssetWriter(outputURL: outputURL, fileType: .mov)
        let settings: [String: Any] = [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: width,
            AVVideoHeightKey: height,
            AVVideoCompressionPropertiesKey: [
                AVVideoAverageBitRateKey: 8_000_000,
                AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
            ],
        ]
        self.input = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
        self.input.expectsMediaDataInRealTime = true
        guard self.writer.canAdd(self.input) else {
            throw NSError(domain: "sckit-spike", code: 1, userInfo: [NSLocalizedDescriptionKey: "cannot add input to writer"])
        }
        self.writer.add(self.input)
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, sampleBuffer.isValid else { return }

        guard let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let status = attachments.first?[.status] as? Int,
              status == SCFrameStatus.complete.rawValue
        else { return }

        let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        if !sessionStarted {
            firstPTS = pts
            writer.startWriting()
            writer.startSession(atSourceTime: pts)
            sessionStarted = true
        }

        if input.isReadyForMoreMediaData {
            input.append(sampleBuffer)
            appendedFrames += 1
        } else {
            droppedFrames += 1
        }
    }
}

@main
struct Spike {
    static func main() async throws {
        let duration: TimeInterval = 30
        let outputURL = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
            .appendingPathComponent("../spike-sckit.mov")

        let shareable = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        guard let display = shareable.displays.first else {
            print("no displays available")
            exit(1)
        }

        let filter = SCContentFilter(display: display, excludingWindows: [])
        let config = SCStreamConfiguration()
        config.width = Int(display.width)
        config.height = Int(display.height)
        config.minimumFrameInterval = CMTime(value: 1, timescale: 30)
        config.queueDepth = 6
        config.showsCursor = true
        config.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange

        let recorder = try Recorder(outputURL: outputURL, width: Int(display.width), height: Int(display.height))

        let stream = SCStream(filter: filter, configuration: config, delegate: nil)
        try stream.addStreamOutput(recorder, type: .screen, sampleHandlerQueue: .main)

        print("recording \(Int(duration))s via ScreenCaptureKit")
        print("display: \(display.width)x\(display.height)")
        let wallStart = Date()
        try await stream.startCapture()
        try await Task.sleep(nanoseconds: UInt64(duration * 1_000_000_000))
        try await stream.stopCapture()

        recorder.input.markAsFinished()
        await recorder.writer.finishWriting()

        let wall = Date().timeIntervalSince(wallStart)
        let attrs = try FileManager.default.attributesOfItem(atPath: outputURL.path)
        let size = attrs[.size] as? Int ?? 0
        print("wall clock: \(String(format: "%.1f", wall))s")
        print("appended frames: \(recorder.appendedFrames), dropped: \(recorder.droppedFrames)")
        print("output: \(outputURL.standardizedFileURL.path)")
        print("size: \(size) bytes (\(String(format: "%.1f", Double(size) / 1_048_576)) MB)")
    }
}
