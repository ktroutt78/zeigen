import AVFoundation
import CoreMedia
import Foundation
import ScreenCaptureKit

// V2.2 Track B shape: SCStream owns screen, AVCaptureSession owns mic.
// Both produce host-time CMSampleBuffers. AVAssetWriter is gated by
// writer-start max-origin alignment (D-02) and stop-time PTS cutoff
// clamp (D-03) so the muxed MP4's audio/video durations match within
// the V2.1-predicted envelope (D-11 acceptance: abs_drift_ms < 100ms).
final class RecordingSession: NSObject,
    SCStreamOutput,
    AVCaptureAudioDataOutputSampleBufferDelegate,
    @unchecked Sendable
{
    private let outputURL: URL
    private let stream: SCStream
    private let captureSession: AVCaptureSession?
    private let writer: AVAssetWriter
    private let videoInput: AVAssetWriterInput
    private let audioInput: AVAssetWriterInput?
    private let onFatalError: @Sendable (EngineError) -> Void

    private let lock = NSLock()
    private var started = false
    private var paused = false
    private var firstVideoPTS: CMTime = .invalid
    private var firstAudioPTS: CMTime = .invalid
    private var cutoffPTS: CMTime?
    private var sessionStartPTS: CMTime = .invalid
    private var totalPausedDuration: CMTime = .zero
    private var pauseStartedAt: CMTime?
    private var lastOutputPTS: CMTime = .invalid
    private var frames = 0
    private var dropped = 0
    private var audioAppended = 0
    private var audioDropped = 0
    private var micTimeoutScheduled = false
    private var fatalErrorFired = false
    private var heartbeatDups = 0
    // V2.2 c2 per-pipeline PTS monotonicity tracker. Closes a cross-queue
    // race specific to the two-source architecture: SCStream's screen
    // delegate queue and the heartbeat timer queue both feed videoInput,
    // and the heartbeat dups host_now while SCK frames carry capture-time
    // PTS — a late SCK frame after a heartbeat can have PTS < the
    // heartbeat's, which transitions AVAssetWriter to .failed.
    // Drop-on-regression preserves writer monotonicity.
    private var lastAppendedRawVideoPTS: CMTime = .invalid
    private var lastAppendedRawAudioPTS: CMTime = .invalid
    private var regressionDropsVideo = 0
    private var regressionDropsAudio = 0

    private var lastVideoBuffer: CMSampleBuffer?
    private var lastVideoArrivalHost: CMTime = .invalid
    private var heartbeatTimer: DispatchSourceTimer?
    private let audioQueue: DispatchQueue?

    let capturedWindowID: UInt32?

    var frameCount: Int { lock.withLock { frames } }
    var droppedCount: Int { lock.withLock { dropped } }
    var writerStarted: Bool { lock.withLock { started } }
    var elapsedSeconds: Double {
        lock.withLock {
            guard lastOutputPTS.isValid, sessionStartPTS.isValid else { return 0 }
            return CMTimeGetSeconds(lastOutputPTS - sessionStartPTS)
        }
    }

    enum Source {
        case display(UInt32)
        case window(UInt32)
        // rect is in logical points, relative to the display's top-left.
        case area(displayID: UInt32, rect: CGRect)
    }

    init(
        source: Source,
        microphoneUID: String?,
        outputPath: String,
        maxFPS: Int,
        onFatalError: @escaping @Sendable (EngineError) -> Void
    ) async throws {
        self.outputURL = URL(fileURLWithPath: outputPath)
        self.onFatalError = onFatalError

        let parent = outputURL.deletingLastPathComponent()
        guard FileManager.default.fileExists(atPath: parent.path) else {
            throw EngineError(code: "OUTPUT_PATH_INVALID", message: "parent dir missing: \(parent.path)")
        }
        try? FileManager.default.removeItem(at: outputURL)

        let shareable = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)

        let filter: SCContentFilter
        let width: Int
        let height: Int
        let resolvedWindowID: UInt32?
        // SCK default: CGRect.zero on sourceRect means "capture the full source".
        // For .area we override with a display-relative point rect.
        var sourceRect: CGRect = .zero
        switch source {
        case .display(let displayID):
            guard let display = shareable.displays.first(where: { $0.displayID == displayID }) else {
                throw EngineError(code: "DISPLAY_NOT_FOUND", message: "display_id \(displayID) not present")
            }
            filter = SCContentFilter(display: display, excludingWindows: [])
            width = Int(display.width)
            height = Int(display.height)
            resolvedWindowID = nil
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
            resolvedWindowID = windowID
        case .area(let displayID, let pointRect):
            guard let display = shareable.displays.first(where: { $0.displayID == displayID }) else {
                throw EngineError(code: "DISPLAY_NOT_FOUND", message: "display_id \(displayID) not present")
            }
            filter = SCContentFilter(display: display, excludingWindows: [])
            let scale = display.frame.width > 0
                ? CGFloat(display.width) / display.frame.width
                : 1.0
            width = max(2, Int((pointRect.width * scale).rounded()))
            height = max(2, Int((pointRect.height * scale).rounded()))
            resolvedWindowID = nil
            sourceRect = pointRect
        }
        self.capturedWindowID = resolvedWindowID

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

        // AVCaptureSession owns the mic when one is requested. Track B's
        // defining shape: mic CMSampleBuffers route through this session,
        // not through SCStream. SCStreamConfiguration.captureMicrophone
        // stays unset.
        var captureSession: AVCaptureSession? = nil
        var audioInput: AVAssetWriterInput? = nil
        var audioOutputToWire: AVCaptureAudioDataOutput? = nil
        if let micUID = microphoneUID {
            let discovery = AVCaptureDevice.DiscoverySession(
                deviceTypes: [.microphone, .external],
                mediaType: .audio,
                position: .unspecified
            )
            guard let micDevice = discovery.devices.first(where: { $0.uniqueID == micUID }) else {
                throw EngineError(code: "MIC_NOT_FOUND", message: "microphone_uid \(micUID) not present")
            }

            let cs = AVCaptureSession()
            let micInput = try AVCaptureDeviceInput(device: micDevice)
            guard cs.canAddInput(micInput) else {
                throw EngineError(code: "INTERNAL", message: "AVCaptureSession cannot add mic input")
            }
            cs.addInput(micInput)

            // Force mono Float32 PCM at 48 kHz so the AAC encoder sees the
            // sample rate it writes at, and so the Phase-12 limiter's
            // UnsafeMutablePointer<Float> cast matches the buffer shape
            // (PLAN c2 §"Verification steps" FLAG 2).
            let ao = AVCaptureAudioDataOutput()
            ao.audioSettings = [
                AVFormatIDKey: kAudioFormatLinearPCM,
                AVLinearPCMBitDepthKey: 32,
                AVLinearPCMIsFloatKey: true,
                AVLinearPCMIsBigEndianKey: false,
                AVLinearPCMIsNonInterleaved: false,
                AVSampleRateKey: 48_000.0,
                AVNumberOfChannelsKey: 1,
            ]
            guard cs.canAddOutput(ao) else {
                throw EngineError(code: "INTERNAL", message: "AVCaptureSession cannot add audio output")
            }
            cs.addOutput(ao)
            audioOutputToWire = ao

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
            captureSession = cs
        }

        let config = SCStreamConfiguration()
        config.width = width
        config.height = height
        config.sourceRect = sourceRect
        config.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(maxFPS))
        config.queueDepth = 6
        config.showsCursor = true
        config.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
        // captureMicrophone deliberately left unset: V2.2 routes mic
        // through AVCaptureSession (Track B).

        let stream = SCStream(filter: filter, configuration: config, delegate: nil)

        self.stream = stream
        self.captureSession = captureSession
        self.writer = writer
        self.videoInput = videoInput
        self.audioInput = audioInput
        let audioQ: DispatchQueue? = (audioOutputToWire != nil) ? DispatchQueue(label: "engine.audio") : nil
        self.audioQueue = audioQ
        super.init()

        try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: DispatchQueue(label: "engine.video"))
        if let ao = audioOutputToWire, let aq = audioQ {
            ao.setSampleBufferDelegate(self, queue: aq)
        }
    }

    func start() async throws {
        try await stream.startCapture()
        captureSession?.startRunning()
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
        let lastAudio = lastAppendedRawAudioPTS
        lock.unlock()

        guard isStarted, !isPaused, let lastBuffer, lastArrival.isValid else { return }

        let hostNow = CMClockGetTime(CMClockGetHostTimeClock())
        let elapsed = CMTimeGetSeconds(hostNow - lastArrival)
        if elapsed < 0.2 { return }

        // Cap dup PTS at audio's last appended PTS so video never runs
        // ahead of audio. AVCaptureAudioDataOutput can buffer up to ~75ms
        // of audio under load; without this cap, a heartbeat firing
        // shortly before stop dups host_now while audio's last sample is
        // tens of ms behind, leaving video_dur > audio_dur (V2.2 drift
        // bar). Audio carries the timeline in V2.2; video tracks it.
        let dupPTS: CMTime
        if lastAudio.isValid && CMTimeCompare(hostNow, lastAudio) > 0 {
            dupPTS = lastAudio
        } else {
            dupPTS = hostNow
        }

        var timing = CMSampleTimingInfo(
            duration: .invalid,
            presentationTimeStamp: dupPTS,
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
        lock.withLock { heartbeatDups += 1 }
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

        // Cutoff clamp before teardown — late samples from either pipeline
        // (SCK in-flight callbacks, AVCaptureSession queue drain) get
        // rejected deterministically rather than racing markAsFinished
        // (D-03).
        lock.withLock {
            if cutoffPTS == nil {
                cutoffPTS = CMClockGetTime(CMClockGetHostTimeClock())
            }
        }

        try await stream.stopCapture()
        captureSession?.stopRunning()
        // Symmetric drain for AVCaptureSession: stream.stopCapture()
        // awaits SCK in-flight callbacks, but captureSession.stopRunning()
        // returns sync — we need to flush the audio output's delegate
        // queue before markAsFinished so no late captureOutput races the
        // writer transition. sync block is a barrier on the audio queue.
        audioQueue?.sync { }

        // Trim-up via the normal append() path so pause-offset is applied
        // identically to other samples. Build the dup under a brief lock
        // (for lastVideoBuffer / state access), then call append() which
        // acquires the lock itself, applies the pause offset, and runs
        // the same monotonicity + cutoff checks heartbeats do.
        let trimDup: CMSampleBuffer? = lock.withLock {
            guard started, audioInput != nil, lastAppendedRawAudioPTS.isValid, let lastBuf = lastVideoBuffer else { return nil }
            if lastAppendedRawVideoPTS.isValid &&
               CMTimeCompare(lastAppendedRawVideoPTS, lastAppendedRawAudioPTS) >= 0 {
                return nil
            }
            var timing = CMSampleTimingInfo(
                duration: .invalid,
                presentationTimeStamp: lastAppendedRawAudioPTS,
                decodeTimeStamp: .invalid
            )
            var dup: CMSampleBuffer?
            let status = CMSampleBufferCreateCopyWithNewTiming(
                allocator: kCFAllocatorDefault,
                sampleBuffer: lastBuf,
                sampleTimingEntryCount: 1,
                sampleTimingArray: &timing,
                sampleBufferOut: &dup
            )
            return status == noErr ? dup : nil
        }
        if let dup = trimDup {
            append(dup, to: videoInput, isVideo: true)
        }

        // markAsFinished under the lock that gates input.append in
        // append(). Also compute the writer-space session end time
        // (lastAudio in adjusted PTS space, accounting for pause).
        // endSession upper-bounds the muxed track, so even if the
        // encoder silently dropped the trim dup, video duration is
        // padded to match audio's last sample.
        let result: (didStart: Bool, endTime: CMTime) = lock.withLock {
            let was = started
            if was {
                videoInput.markAsFinished()
                audioInput?.markAsFinished()
            }
            let end = (was && lastAppendedRawAudioPTS.isValid)
                ? lastAppendedRawAudioPTS - totalPausedDuration
                : CMTime.invalid
            return (was, end)
        }
        let didStart = result.didStart
        if result.endTime.isValid {
            writer.endSession(atSourceTime: result.endTime)
        }
        logStderr("session stats: audioAppended=\(audioAppended) audioDropped=\(audioDropped) videoFrames=\(frames) videoDropped=\(dropped) heartbeatDups=\(heartbeatDups) regressionDropsVideo=\(regressionDropsVideo) regressionDropsAudio=\(regressionDropsAudio)")

        if didStart {
            await withCheckedContinuation { cont in
                writer.finishWriting {
                    cont.resume()
                }
            }
            if writer.status == .failed {
                let ns = writer.error as NSError?
                logStderr("WRITER_FAILED diagnostic: status=\(writer.status.rawValue) domain=\(ns?.domain ?? "?") code=\(ns?.code ?? 0) underlying=\(String(describing: ns?.userInfo[NSUnderlyingErrorKey]))")
                throw EngineError(code: "WRITER_FAILED", message: writer.error?.localizedDescription ?? "unknown")
            }
        }

        let bytes = (try? FileManager.default.attributesOfItem(atPath: outputURL.path)[.size] as? Int64) ?? 0
        return RecordingResult(
            path: outputURL.path,
            duration: elapsedSeconds,
            bytes: bytes,
            frames: frameCount,
            dropped: droppedCount
        )
    }

    // Mid-recording error path (MIC_NO_FIRST_SAMPLE in c2; c3 adds
    // MIC_SESSION_FAILED via the AVCaptureSession runtime-error observer).
    // Engine.handleFatalError calls this from the actor; we tear down
    // whatever has been written so far symmetrically.
    func tearDownAfterFatalError() async {
        heartbeatTimer?.cancel()
        heartbeatTimer = nil

        lock.withLock {
            if cutoffPTS == nil {
                cutoffPTS = CMClockGetTime(CMClockGetHostTimeClock())
            }
        }

        try? await stream.stopCapture()
        captureSession?.stopRunning()
        audioQueue?.sync { }

        // Fatal-error teardown finalizes whatever was captured without
        // running stop()'s trim-up + endSession alignment. We're saving
        // partial state on the way out; drift bar doesn't apply.
        let didStart: Bool = lock.withLock {
            let was = started
            if was {
                videoInput.markAsFinished()
                audioInput?.markAsFinished()
            }
            return was
        }
        if didStart {
            await withCheckedContinuation { cont in
                writer.finishWriting {
                    cont.resume()
                }
            }
        }
    }

    // MARK: SCStreamOutput

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard sampleBuffer.isValid, type == .screen else { return }
        guard let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let status = attachments.first?[.status] as? Int,
              status == SCFrameStatus.complete.rawValue
        else { return }
        lock.withLock {
            lastVideoBuffer = sampleBuffer
            lastVideoArrivalHost = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        }
        append(sampleBuffer, to: videoInput, isVideo: true)
    }

    // MARK: AVCaptureAudioDataOutputSampleBufferDelegate

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        guard sampleBuffer.isValid, let audioInput else { return }
        // Phase 12 c2 soft-knee limiter (-1 dBFS) — same behavior as v1.0,
        // moved here from the SCStream .microphone branch (D-09).
        applyLimiterInPlace(sampleBuffer)
        append(sampleBuffer, to: audioInput, isVideo: false)
    }

    // MARK: Writer feed

    private func append(_ buffer: CMSampleBuffer, to input: AVAssetWriterInput, isVideo: Bool) {
        // V2.2 c2 lock discipline: input.append is held inside the lock
        // (NOT released-then-appended like v1.0's single-source path). The
        // two-pipeline shape pairs an audio captureOutput thread with the
        // actor thread tearing down the writer in stop(); releasing the
        // lock before input.append opens a race where markAsFinished
        // fires between the isReadyForMoreMediaData check and the actual
        // append, which Apple docs flag as an error and which transitions
        // the writer to .failed on macOS 26. input.append is microseconds
        // (enqueues to AVAssetWriter's internal serial queue) so the
        // added contention is negligible.
        lock.lock()
        defer { lock.unlock() }

        if paused { return }

        let rawPTS = CMSampleBufferGetPresentationTimeStamp(buffer)

        // Cutoff clamp — any sample past stop()'s cutoff gets dropped on
        // both pipelines (D-03). Catches in-flight SCK callbacks and
        // AVCaptureSession queue drain after stopRunning.
        if let cutoff = cutoffPTS, CMTimeCompare(rawPTS, cutoff) > 0 {
            return
        }

        // Track each pipeline's first PTS. Schedule the
        // MIC_NO_FIRST_SAMPLE timeout on first video arrival when audio
        // is configured (D-02).
        if isVideo {
            if !firstVideoPTS.isValid {
                firstVideoPTS = rawPTS
                if audioInput != nil && !micTimeoutScheduled {
                    micTimeoutScheduled = true
                    DispatchQueue.global().asyncAfter(deadline: .now() + 0.250) { [weak self] in
                        self?.checkMicTimeout()
                    }
                }
            }
        } else {
            if !firstAudioPTS.isValid {
                firstAudioPTS = rawPTS
            }
        }

        // Writer-start gate: wait for first sample from each configured
        // pipeline, then anchor session at max(firstVideoPTS, firstAudioPTS)
        // so the earlier pipeline's pre-origin samples collapse to ~0
        // audio prefix (D-02).
        if !started {
            let videoReady = firstVideoPTS.isValid
            let audioReady = (audioInput == nil) || firstAudioPTS.isValid
            if videoReady && audioReady {
                let origin: CMTime
                if audioInput == nil {
                    origin = firstVideoPTS
                } else {
                    origin = CMTimeCompare(firstVideoPTS, firstAudioPTS) > 0 ? firstVideoPTS : firstAudioPTS
                }
                writer.startWriting()
                writer.startSession(atSourceTime: origin)
                sessionStartPTS = origin
                started = true
            } else {
                // Earlier pipeline produced before the other warmed up — drop.
                return
            }
        }

        // Belt-and-suspenders: an in-flight pre-origin sample that slipped
        // through gate-open (CMSampleBuffer queues can reorder). Same
        // direction as the gate's drop; just covers post-gate edge cases.
        if CMTimeCompare(rawPTS, sessionStartPTS) < 0 {
            return
        }

        // Monotonicity guard. Two queues feed videoInput (SCStream's
        // screen delegate + the heartbeat timer); heartbeat dups host_now
        // while late SCK frames carry capture-time PTS. Without this
        // drop, a late SCK frame after a heartbeat tick regresses PTS and
        // transitions AVAssetWriter to .failed.
        let lastAppended = isVideo ? lastAppendedRawVideoPTS : lastAppendedRawAudioPTS
        if lastAppended.isValid && CMTimeCompare(rawPTS, lastAppended) <= 0 {
            if isVideo { regressionDropsVideo += 1 } else { regressionDropsAudio += 1 }
            return
        }

        let offset = totalPausedDuration
        let adjustedPTS = rawPTS - offset
        lastOutputPTS = adjustedPTS
        if isVideo { frames += 1 }

        guard input.isReadyForMoreMediaData else {
            if isVideo { dropped += 1 } else { audioDropped += 1 }
            return
        }

        let finalBuffer: CMSampleBuffer
        if offset == .zero {
            finalBuffer = buffer
        } else {
            guard let adjusted = adjustTiming(buffer, offset: offset) else {
                if isVideo { dropped += 1 } else { audioDropped += 1 }
                return
            }
            finalBuffer = adjusted
        }

        let ok = input.append(finalBuffer)
        if ok {
            if isVideo {
                lastAppendedRawVideoPTS = rawPTS
            } else {
                lastAppendedRawAudioPTS = rawPTS
                audioAppended += 1
            }
        } else {
            if isVideo { dropped += 1 } else { audioDropped += 1 }
        }
    }

    private func checkMicTimeout() {
        let shouldFire: Bool = lock.withLock {
            if firstAudioPTS.isValid { return false }
            if cutoffPTS != nil { return false }
            if fatalErrorFired { return false }
            fatalErrorFired = true
            return true
        }
        guard shouldFire else { return }
        onFatalError(EngineError(
            code: "MIC_NO_FIRST_SAMPLE",
            message: "first mic sample not received within 250ms of first video sample"
        ))
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

    // Per-sample soft-knee limiter at -1 dBFS. Below threshold, samples pass
    // through unchanged. Above threshold, magnitude follows
    // y = t + k * tanh((|x| - t) / k) which asymptotically approaches 1.0
    // without ever crossing it. Sign of x is preserved.
    private static let limiterThreshold: Float = 0.8913  // 10^(-1/20)
    private static let limiterKnee: Float = 1.0 - limiterThreshold

    private func applyLimiter(_ samples: UnsafeMutablePointer<Float>, count: Int) {
        let t = Self.limiterThreshold
        let k = Self.limiterKnee
        for i in 0..<count {
            let x = samples[i]
            let mag = x < 0 ? -x : x
            if mag <= t { continue }
            let over = mag - t
            let limited = t + k * tanh(over / k)
            samples[i] = x < 0 ? -limited : limited
        }
    }

    private func applyLimiterInPlace(_ buffer: CMSampleBuffer) {
        var ablSize = 0
        var status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            buffer,
            bufferListSizeNeededOut: &ablSize,
            bufferListOut: nil,
            bufferListSize: 0,
            blockBufferAllocator: nil,
            blockBufferMemoryAllocator: nil,
            flags: kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment,
            blockBufferOut: nil
        )
        guard status == noErr, ablSize > 0 else { return }
        let raw = UnsafeMutableRawPointer.allocate(byteCount: ablSize, alignment: 16)
        defer { raw.deallocate() }
        let abl = raw.bindMemory(to: AudioBufferList.self, capacity: 1)
        var blockBuffer: CMBlockBuffer?
        status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            buffer,
            bufferListSizeNeededOut: nil,
            bufferListOut: abl,
            bufferListSize: ablSize,
            blockBufferAllocator: nil,
            blockBufferMemoryAllocator: nil,
            flags: kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment,
            blockBufferOut: &blockBuffer
        )
        guard status == noErr else { return }
        let buffers = UnsafeMutableAudioBufferListPointer(abl)
        for ab in buffers {
            guard let data = ab.mData else { continue }
            let count = Int(ab.mDataByteSize) / MemoryLayout<Float>.size
            let p = data.bindMemory(to: Float.self, capacity: count)
            applyLimiter(p, count: count)
        }
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
