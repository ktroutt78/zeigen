import AVFoundation
import CoreMedia
import Foundation
import ScreenCaptureKit

final class RecordingSession: NSObject, SCStreamOutput, @unchecked Sendable {
    private let outputURL: URL
    private let stream: SCStream
    private let writer: AVAssetWriter
    private let videoInput: AVAssetWriterInput
    private let audioInput: AVAssetWriterInput?

    private let lock = NSLock()
    private var started = false
    private var paused = false
    private var sessionStartPTS: CMTime = .invalid
    private var totalPausedDuration: CMTime = .zero
    private var pauseStartedAt: CMTime?
    private var lastOutputPTS: CMTime = .invalid
    private var frames = 0
    private var dropped = 0
    private var audioAppended = 0
    private var audioDropped = 0

    private var lastVideoBuffer: CMSampleBuffer?
    private var lastVideoArrivalHost: CMTime = .invalid
    private var heartbeatTimer: DispatchSourceTimer?

    var frameCount: Int { lock.withLock { frames } }
    var droppedCount: Int { lock.withLock { dropped } }
    var elapsedSeconds: Double {
        lock.withLock {
            guard lastOutputPTS.isValid, sessionStartPTS.isValid else { return 0 }
            return CMTimeGetSeconds(lastOutputPTS - sessionStartPTS)
        }
    }

    enum Source {
        case display(UInt32)
        case window(UInt32)
    }

    init(source: Source, microphoneUID: String?, outputPath: String, maxFPS: Int) async throws {
        self.outputURL = URL(fileURLWithPath: outputPath)

        let parent = outputURL.deletingLastPathComponent()
        guard FileManager.default.fileExists(atPath: parent.path) else {
            throw EngineError(code: "OUTPUT_PATH_INVALID", message: "parent dir missing: \(parent.path)")
        }
        try? FileManager.default.removeItem(at: outputURL)

        let shareable = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)

        let filter: SCContentFilter
        let width: Int
        let height: Int
        switch source {
        case .display(let displayID):
            guard let display = shareable.displays.first(where: { $0.displayID == displayID }) else {
                throw EngineError(code: "DISPLAY_NOT_FOUND", message: "display_id \(displayID) not present")
            }
            filter = SCContentFilter(display: display, excludingWindows: [])
            width = Int(display.width)
            height = Int(display.height)
        case .window(let windowID):
            guard let window = shareable.windows.first(where: { $0.windowID == windowID }) else {
                throw EngineError(code: "WINDOW_NOT_FOUND", message: "window_id \(windowID) not present")
            }
            filter = SCContentFilter(desktopIndependentWindow: window)
            // SCWindow.frame is in points; SCK delivers at the size we ask
            // for in config.width/height. Ask for native pixels so the
            // capture isn't downscaled on a Retina display: multiply the
            // window's point size by the scale of the display containing
            // its center. Falls back to 1.0 if no containing display is
            // found (window straddling the void after a display unplug).
            let scale = Self.displayScale(for: window.frame, in: shareable.displays)
            width = max(2, Int((window.frame.width * scale).rounded()))
            height = max(2, Int((window.frame.height * scale).rounded()))
        }

        let writer = try AVAssetWriter(outputURL: outputURL, fileType: .mp4)
        let videoSettings: [String: Any] = [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: width,
            AVVideoHeightKey: height,
            AVVideoCompressionPropertiesKey: [
                AVVideoAverageBitRateKey: 8_000_000,
                AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
            ],
        ]
        let videoInput = AVAssetWriterInput(mediaType: .video, outputSettings: videoSettings)
        videoInput.expectsMediaDataInRealTime = true
        guard writer.canAdd(videoInput) else {
            throw EngineError(code: "WRITER_FAILED", message: "cannot add video input")
        }
        writer.add(videoInput)

        var audioInput: AVAssetWriterInput?
        if microphoneUID != nil {
            let settings: [String: Any] = [
                AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVSampleRateKey: 48_000,
                AVNumberOfChannelsKey: 1,
                AVEncoderBitRateKey: 128_000,
            ]
            let input = AVAssetWriterInput(mediaType: .audio, outputSettings: settings)
            input.expectsMediaDataInRealTime = true
            guard writer.canAdd(input) else {
                throw EngineError(code: "WRITER_FAILED", message: "cannot add audio input")
            }
            writer.add(input)
            audioInput = input
        }

        let config = SCStreamConfiguration()
        config.width = width
        config.height = height
        config.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(maxFPS))
        config.queueDepth = 6
        config.showsCursor = true
        config.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
        if microphoneUID != nil {
            config.captureMicrophone = true
            config.microphoneCaptureDeviceID = microphoneUID
        }

        let stream = SCStream(filter: filter, configuration: config, delegate: nil)

        self.stream = stream
        self.writer = writer
        self.videoInput = videoInput
        self.audioInput = audioInput
        super.init()

        try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: DispatchQueue(label: "engine.video"))
        if microphoneUID != nil {
            try stream.addStreamOutput(self, type: .microphone, sampleHandlerQueue: DispatchQueue(label: "engine.mic"))
        }
    }

    func start() async throws {
        try await stream.startCapture()
        startHeartbeat()
    }

    private func startHeartbeat() {
        let timer = DispatchSource.makeTimerSource(queue: DispatchQueue(label: "engine.heartbeat"))
        timer.schedule(deadline: .now() + 0.2, repeating: 0.2)
        timer.setEventHandler { [weak self] in
            self?.heartbeatTick()
        }
        timer.resume()
        self.heartbeatTimer = timer
    }

    private func heartbeatTick() {
        lock.lock()
        let isPaused = paused
        let isStarted = started
        let lastBuffer = lastVideoBuffer
        let lastArrival = lastVideoArrivalHost
        lock.unlock()

        guard isStarted, !isPaused, let lastBuffer, lastArrival.isValid else { return }

        let now = CMClockGetTime(CMClockGetHostTimeClock())
        let elapsed = CMTimeGetSeconds(now - lastArrival)
        if elapsed < 0.2 { return }

        var timing = CMSampleTimingInfo(
            duration: .invalid,
            presentationTimeStamp: now,
            decodeTimeStamp: .invalid
        )
        var dup: CMSampleBuffer?
        let status = CMSampleBufferCreateCopyWithNewTiming(
            allocator: kCFAllocatorDefault,
            sampleBuffer: lastBuffer,
            sampleTimingEntryCount: 1,
            sampleTimingArray: &timing,
            sampleBufferOut: &dup
        )
        guard status == noErr, let dup else { return }
        append(dup, to: videoInput, isVideo: true)
    }

    func pause() {
        lock.withLock {
            paused = true
            pauseStartedAt = CMClockGetTime(CMClockGetHostTimeClock())
        }
    }

    func resume() {
        lock.withLock {
            paused = false
            if let pauseStart = pauseStartedAt {
                let now = CMClockGetTime(CMClockGetHostTimeClock())
                totalPausedDuration = totalPausedDuration + (now - pauseStart)
                pauseStartedAt = nil
            }
        }
    }

    func stop() async throws -> RecordingResult {
        heartbeatTimer?.cancel()
        heartbeatTimer = nil

        try await stream.stopCapture()

        videoInput.markAsFinished()
        audioInput?.markAsFinished()

        await withCheckedContinuation { cont in
            writer.finishWriting {
                cont.resume()
            }
        }

        if writer.status == .failed {
            throw EngineError(code: "WRITER_FAILED", message: writer.error?.localizedDescription ?? "unknown")
        }

        logStderr("audio stats: appended=\(audioAppended) dropped=\(audioDropped)")

        let bytes = (try? FileManager.default.attributesOfItem(atPath: outputURL.path)[.size] as? Int64) ?? 0
        return RecordingResult(
            path: outputURL.path,
            duration: elapsedSeconds,
            bytes: bytes,
            frames: frameCount,
            dropped: droppedCount
        )
    }

    // MARK: SCStreamOutput

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard sampleBuffer.isValid else { return }

        switch type {
        case .screen:
            guard let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
                  let status = attachments.first?[.status] as? Int,
                  status == SCFrameStatus.complete.rawValue
            else { return }
            lock.withLock {
                lastVideoBuffer = sampleBuffer
                lastVideoArrivalHost = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
            }
            append(sampleBuffer, to: videoInput, isVideo: true)
        case .microphone:
            guard let audioInput else { return }
            append(sampleBuffer, to: audioInput, isVideo: false)
        default:
            break
        }
    }

    // MARK: Writer feed

    private func append(_ buffer: CMSampleBuffer, to input: AVAssetWriterInput, isVideo: Bool) {
        lock.lock()

        if paused {
            lock.unlock()
            return
        }

        let rawPTS = CMSampleBufferGetPresentationTimeStamp(buffer)
        if !started {
            writer.startWriting()
            writer.startSession(atSourceTime: rawPTS)
            sessionStartPTS = rawPTS
            started = true
        }

        let offset = totalPausedDuration
        let adjustedPTS = rawPTS - offset
        lastOutputPTS = adjustedPTS
        if isVideo {
            frames += 1
        }
        let readyToAppend = input.isReadyForMoreMediaData

        lock.unlock()

        guard readyToAppend else {
            lock.withLock {
                if isVideo { dropped += 1 } else { audioDropped += 1 }
            }
            return
        }

        let finalBuffer: CMSampleBuffer
        if offset == .zero {
            finalBuffer = buffer
        } else {
            guard let adjusted = adjustTiming(buffer, offset: offset) else {
                lock.withLock {
                    if isVideo { dropped += 1 } else { audioDropped += 1 }
                }
                return
            }
            finalBuffer = adjusted
        }

        let ok = input.append(finalBuffer)
        if !isVideo {
            lock.withLock {
                if ok { audioAppended += 1 } else { audioDropped += 1 }
            }
        }
    }

    // Find the SCK display containing the window's center, then derive
    // points-to-pixels by comparing the display's pixel size to its frame.
    // Falls back to 1.0 (treat points as pixels) when the window doesn't
    // overlap any known display.
    static func displayScale(for windowFrame: CGRect, in displays: [SCDisplay]) -> CGFloat {
        let center = CGPoint(x: windowFrame.midX, y: windowFrame.midY)
        guard let display = displays.first(where: { $0.frame.contains(center) }),
              display.frame.width > 0
        else {
            return 1.0
        }
        return CGFloat(display.width) / display.frame.width
    }

    private func adjustTiming(_ buffer: CMSampleBuffer, offset: CMTime) -> CMSampleBuffer? {
        var count: CMItemCount = 0
        CMSampleBufferGetSampleTimingInfoArray(buffer, entryCount: 0, arrayToFill: nil, entriesNeededOut: &count)
        if count <= 0 { count = 1 }
        var timings = [CMSampleTimingInfo](repeating: CMSampleTimingInfo(), count: Int(count))
        CMSampleBufferGetSampleTimingInfoArray(buffer, entryCount: count, arrayToFill: &timings, entriesNeededOut: nil)
        for i in 0..<Int(count) {
            if timings[i].presentationTimeStamp.isValid {
                timings[i].presentationTimeStamp = timings[i].presentationTimeStamp - offset
            }
            if timings[i].decodeTimeStamp.isValid {
                timings[i].decodeTimeStamp = timings[i].decodeTimeStamp - offset
            }
        }
        var adjusted: CMSampleBuffer?
        let status = CMSampleBufferCreateCopyWithNewTiming(
            allocator: kCFAllocatorDefault,
            sampleBuffer: buffer,
            sampleTimingEntryCount: count,
            sampleTimingArray: timings,
            sampleBufferOut: &adjusted
        )
        guard status == noErr else { return nil }
        return adjusted
    }
}

extension NSLock {
    @discardableResult
    func withLock<T>(_ body: () throws -> T) rethrows -> T {
        lock(); defer { unlock() }
        return try body()
    }
}
