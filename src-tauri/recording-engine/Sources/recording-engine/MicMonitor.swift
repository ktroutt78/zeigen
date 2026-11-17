import AVFoundation
import Foundation

// The one place the microphone is opened. While the capture window is showing
// with the mic on, the app keeps this running: it reports a level for the
// meter in the microphone row, and it means the mic is already live when a
// recording starts. macOS stops and restarts the built-in mic once just after
// it is opened (about 0.4 s, DECISIONS 2026-11-17); with the mic kept open
// that has happened long before Start. A recording borrows the running
// monitor by setting `sink`; it never opens the mic itself.
final class MicMonitor: NSObject, AVCaptureAudioDataOutputSampleBufferDelegate, @unchecked Sendable {
    let uid: String
    let session = AVCaptureSession()
    let queue = DispatchQueue(label: "engine.audio")

    private let lock = NSLock()
    private var sink: ((CMSampleBuffer) -> Void)?
    private var lastLevelAt = DispatchTime(uptimeNanoseconds: 0)

    init(uid: String) throws {
        self.uid = uid
        let discovery = AVCaptureDevice.DiscoverySession(
            deviceTypes: [.microphone, .external],
            mediaType: .audio,
            position: .unspecified
        )
        guard let device = discovery.devices.first(where: { $0.uniqueID == uid }) else {
            throw EngineError(code: "MIC_NOT_FOUND", message: "microphone_uid \(uid) not present")
        }
        let input = try AVCaptureDeviceInput(device: device)
        guard session.canAddInput(input) else {
            throw EngineError(code: "INTERNAL", message: "AVCaptureSession cannot add mic input")
        }
        session.addInput(input)

        // Mono Float32 PCM at 48 kHz: the rate the AAC encoder writes at, and
        // the shape the recording's limiter and the level meter read.
        let output = AVCaptureAudioDataOutput()
        output.audioSettings = [
            AVFormatIDKey: kAudioFormatLinearPCM,
            AVLinearPCMBitDepthKey: 32,
            AVLinearPCMIsFloatKey: true,
            AVLinearPCMIsBigEndianKey: false,
            AVLinearPCMIsNonInterleaved: false,
            AVSampleRateKey: 48_000.0,
            AVNumberOfChannelsKey: 1,
        ]
        guard session.canAddOutput(output) else {
            throw EngineError(code: "INTERNAL", message: "AVCaptureSession cannot add audio output")
        }
        session.addOutput(output)
        super.init()
        output.setSampleBufferDelegate(self, queue: queue)
    }

    func start() {
        if !session.isRunning { session.startRunning() }
    }

    func stop() {
        setSink(nil)
        session.stopRunning()
    }

    // Clearing the sink and then draining the queue guarantees no buffer is
    // still on its way to the old sink.
    func setSink(_ newSink: ((CMSampleBuffer) -> Void)?) {
        lock.withLock { sink = newSink }
        if newSink == nil { queue.sync { } }
    }

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        guard sampleBuffer.isValid else { return }
        // Level first: the recording's limiter changes the samples in place.
        let now = DispatchTime.now()
        if now.uptimeNanoseconds - lastLevelAt.uptimeNanoseconds >= 66_000_000,
           let level = Self.level(of: sampleBuffer) {
            lastLevelAt = now
            emit(.mic_level(level: level))
        }
        let current = lock.withLock { sink }
        current?(sampleBuffer)
    }

    // Loudest sample in the buffer, mapped from -50...0 dBFS to 0...1.
    private static func level(of buffer: CMSampleBuffer) -> Double? {
        guard let block = CMSampleBufferGetDataBuffer(buffer) else { return nil }
        var length = 0
        var pointer: UnsafeMutablePointer<CChar>?
        guard CMBlockBufferGetDataPointer(
            block, atOffset: 0, lengthAtOffsetOut: nil, totalLengthOut: &length, dataPointerOut: &pointer
        ) == kCMBlockBufferNoErr, let pointer else { return nil }
        let count = length / MemoryLayout<Float>.size
        guard count > 0 else { return nil }
        var peak: Float = 0
        pointer.withMemoryRebound(to: Float.self, capacity: count) { samples in
            for i in 0..<count { peak = max(peak, abs(samples[i])) }
        }
        guard peak > 0 else { return 0 }
        let db = 20 * log10(Double(peak))
        return min(1, max(0, (db + 50) / 50))
    }
}
