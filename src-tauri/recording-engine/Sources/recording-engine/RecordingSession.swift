import AVFoundation
import CoreGraphics
import CoreMedia
import Foundation
import os
import ScreenCaptureKit

// V2.2 Track B shape: SCStream owns screen, AVCaptureSession owns mic.
// Both produce host-time CMSampleBuffers. AVAssetWriter is gated by
// writer-start max-origin alignment (D-02) and stop-time PTS cutoff
// clamp (D-03) so the muxed MP4's audio/video durations match within
// the V2.1-predicted envelope (D-11 acceptance: abs_drift_ms < 100ms).
// SCStream takes its delegate at init, before RecordingSession exists, so the
// delegate is this small object and the session hooks in afterwards.
final class StreamStopWatcher: NSObject, SCStreamDelegate, @unchecked Sendable {
    var onStop: ((any Error) -> Void)?
    func stream(_ stream: SCStream, didStopWithError error: any Error) { onStop?(error) }
}

final class RecordingSession: NSObject,
    SCStreamOutput,
    AVCaptureAudioDataOutputSampleBufferDelegate,
    @unchecked Sendable
{
    private let outputURL: URL
    private let stream: SCStream
    private let stopWatcher: StreamStopWatcher
    private let captureSession: AVCaptureSession?
    private let writer: AVAssetWriter
    private let videoInput: AVAssetWriterInput
    private let audioInput: AVAssetWriterInput?
    private let onFatalError: @Sendable (EngineError) -> Void

    private let lock = NSLock()
    private var started = false
    // Latest screen frame seen before the writer started, so the file can
    // open with a real picture at time zero (see the writer-start gate).
    private var preStartVideo: CMSampleBuffer?
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
    private var micDropped = false
    private var interruptionObserver: (any NSObjectProtocol)?
    private var runtimeErrorObserver: (any NSObjectProtocol)?
    // V2.2 c2 per-pipeline PTS monotonicity tracker. Closes a cross-queue
    // race specific to the two-source architecture: SCStream's screen
    // delegate queue and the heartbeat timer queue both feed videoInput,
    // and the heartbeat dups host_now while SCK frames carry capture-time
    // PTS — a late SCK frame after a heartbeat can have PTS < the
    // heartbeat's, which transitions AVAssetWriter to .failed.
    // Drop-on-regression preserves writer monotonicity.
    private var lastAppendedRawVideoPTS: CMTime = .invalid
    private var lastAppendedRawAudioPTS: CMTime = .invalid
    // Host-clock time of the last audio buffer received (D-15c). Drives the
    // mid-recording sample-cessation watchdog; recorded on receipt so pause
    // (which still delivers buffers) does not false-trigger it.
    private var lastAudioArrivalHost: CMTime = .invalid
    private var regressionDropsVideo = 0
    private var regressionDropsAudio = 0

    private var lastVideoBuffer: CMSampleBuffer?
    private var lastVideoArrivalHost: CMTime = .invalid
    private var heartbeatTimer: DispatchSourceTimer?
    private let audioQueue: DispatchQueue?

    // V3 Phase A cursor telemetry. Non-nil iff capture_cursor is on, in
    // which case a telemetry sidecar is written at stop and the system
    // cursor is left out of the pixels (the export draws it from the
    // sidecar, CURSOR-SMOOTHING-PLAN). cursorAnchorSet guards the one-shot anchor
    // handoff (first video frame accepted by the writer) without locking
    // the tracker on every frame.
    private let cursorTracker: CursorTracker?
    private var cursorAnchorSet = false

    let capturedWindowID: UInt32?

    // Window capture records the window's display narrowed to the window's
    // app, cropped to the window (so the app's menus, popovers, sheets and
    // dialogs are in the picture). The crop has to follow the window, so
    // this holds what the follow loop needs. nil for display/area capture
    // and for the single-window fallback.
    private struct WindowFollow {
        let windowID: UInt32
        let app: SCRunningApplication
        let displays: [SCDisplay]
        let startDisplay: SCDisplay
        let startFrame: CGRect
        let width: Int
        let height: Int
        let maxFPS: Int
        let showsCursor: Bool
    }
    private let windowFollow: WindowFollow?
    private var followTask: Task<Void, Never>?

    var frameCount: Int { lock.withLock { frames } }
    var droppedCount: Int { lock.withLock { dropped } }
    var writerStarted: Bool { lock.withLock { started } }
    var elapsedSeconds: Double {
        lock.withLock {
            guard lastOutputPTS.isValid, sessionStartPTS.isValid else { return 0 }
            return CMTimeGetSeconds(lastOutputPTS - sessionStartPTS)
        }
    }

    // Host-clock time cut out of the file by pauses so far. The webcam
    // recorder cuts the same amount so both files stay in step.
    var pausedTotalSeconds: Double {
        lock.withLock { CMTimeGetSeconds(totalPausedDuration) }
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
        captureCursor: Bool,
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

        // Zeigen's own windows (timer chip, area indicator, floating bubble,
        // countdown) are left out of display and area recordings here, not by
        // NSWindow.sharingType = .none: a window hidden that way never reaches
        // USB-driven displays (DisplayLink, InstantView). Zeigen is this
        // process's parent; the bundle id covers the installed app.
        let ownApps = shareable.applications.filter {
            $0.processID == getppid()
                || (Bundle.main.bundleIdentifier != nil && $0.bundleIdentifier == Bundle.main.bundleIdentifier)
        }
        let filter: SCContentFilter
        let width: Int
        let height: Int
        let resolvedWindowID: UInt32?
        // SCK default: CGRect.zero on sourceRect means "capture the full source".
        // For .area we override with a display-relative point rect.
        var sourceRect: CGRect = .zero
        // Screen-points → video-pixels mapping for cursor telemetry
        // (V3-PLAN A.2): same origin offset and scale factor each capture
        // mode already uses for its output dimensions.
        let cursorMapping: CursorTracker.Mapping
        // Screen points → video pixels, recorded in the sidecar so the export
        // can size the cursor it draws.
        let pointsToPixels: Double
        var followTarget: (windowID: UInt32, app: SCRunningApplication, display: SCDisplay, frame: CGRect)?
        switch source {
        case .display(let displayID):
            guard let display = shareable.displays.first(where: { $0.displayID == displayID }) else {
                throw EngineError(code: "DISPLAY_NOT_FOUND", message: "display_id \(displayID) not present")
            }
            filter = SCContentFilter(display: display, excludingApplications: ownApps, exceptingWindows: [])
            // Capture at the display's BACKING resolution (2x on Retina), not
            // the logical point size SCDisplay.width reports on macOS 26. Cursor
            // scale comes from the SAME geometry so telemetry and video stay
            // locked (see captureGeometry).
            let geo = Self.captureGeometry(
                pointWidth: Double(display.width),
                pointHeight: Double(display.height),
                backingScale: Self.backingScale(for: displayID)
            )
            width = geo.width
            height = geo.height
            resolvedWindowID = nil
            cursorMapping = .fixed(
                originX: Double(display.frame.origin.x),
                originY: Double(display.frame.origin.y),
                scale: geo.scale
            )
            pointsToPixels = geo.scale
        case .window(let windowID):
            guard let window = shareable.windows.first(where: { $0.windowID == windowID }) else {
                throw EngineError(code: "WINDOW_NOT_FOUND", message: "window_id \(windowID) not present")
            }
            // Record the display the window's centre is on, narrowed to the
            // window's app and cropped to the window: the app's popups are
            // separate windows, which a single-window filter leaves out.
            // Fallback, for this recording only: when SCK reports no owning
            // app or no display contains the window's centre, capture the
            // single window as before (no popups, no follow needed).
            let centre = CGPoint(x: window.frame.midX, y: window.frame.midY)
            if let app = window.owningApplication,
               let display = shareable.displays.first(where: { $0.frame.contains(centre) }) {
                filter = SCContentFilter(display: display, including: [app], exceptingWindows: [])
                sourceRect = Self.cropRect(window.frame, on: display)
                followTarget = (windowID, app, display, window.frame)
            } else {
                filter = SCContentFilter(desktopIndependentWindow: window)
            }
            // SCWindow.frame is in points; SCK delivers at the size we ask
            // for in config.width/height. Ask for native pixels so the
            // capture isn't downscaled on a Retina display: multiply the
            // window's point size by the scale of the display containing
            // its center. Falls back to 1.0 if no containing display is
            // found (window straddling the void after a display unplug).
            let geo = Self.captureGeometry(
                pointWidth: Double(window.frame.width),
                pointHeight: Double(window.frame.height),
                backingScale: Self.displayScale(for: window.frame, in: shareable.displays)
            )
            width = geo.width
            height = geo.height
            resolvedWindowID = windowID
            // .window maps the cursor through the live window frame to
            // pixelWidth/Height, so it tracks geo.width/height directly.
            cursorMapping = .window(windowID: windowID, pixelWidth: width, pixelHeight: height)
            pointsToPixels = Double(width) / Double(window.frame.width)
        case .area(let displayID, let pointRect):
            guard let display = shareable.displays.first(where: { $0.displayID == displayID }) else {
                throw EngineError(code: "DISPLAY_NOT_FOUND", message: "display_id \(displayID) not present")
            }
            filter = SCContentFilter(display: display, excludingApplications: ownApps, exceptingWindows: [])
            let geo = Self.captureGeometry(
                pointWidth: Double(pointRect.width),
                pointHeight: Double(pointRect.height),
                backingScale: Self.backingScale(for: displayID)
            )
            width = geo.width
            height = geo.height
            resolvedWindowID = nil
            sourceRect = pointRect
            // Area rect is display-relative points; cursor locations are
            // global points, so the mapping origin is display + rect.
            cursorMapping = .fixed(
                originX: Double(display.frame.origin.x + pointRect.origin.x),
                originY: Double(display.frame.origin.y + pointRect.origin.y),
                scale: geo.scale
            )
            pointsToPixels = geo.scale
        }
        self.capturedWindowID = resolvedWindowID
        // With telemetry on, the cursor is left out of the pixels: the export
        // draws its own (smoothed) cursor from the sidecar. With telemetry off
        // there is nothing to draw it from, so it stays burned in.
        let showsCursor = !captureCursor
        self.cursorTracker = captureCursor
            ? CursorTracker(
                mapping: cursorMapping, videoWidth: width, videoHeight: height,
                pointsToPixels: pointsToPixels, cursorInVideo: showsCursor)
            : nil

        let writer = try AVAssetWriter(outputURL: outputURL, fileType: .mp4)
        // Bitrate at a constant ~0.18 bits/pixel — the density the historical flat
        // 8 Mbps encoded at 1512x982x30 logical. Scaling by the ACTUAL capture
        // pixels x fps keeps quality-per-pixel constant now that a Retina capture is
        // 4x the pixels (a 3024x1964 backing capture lands ~32 Mbps instead of a
        // starved 8). VideoToolbox ABR undershoots on compressible screen content.
        let captureBitrate = max(4_000_000, Int(Double(width * height) * Double(maxFPS) * 0.18))
        let videoSettings: [String: Any] = [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: width,
            AVVideoHeightKey: height,
            AVVideoCompressionPropertiesKey: [
                AVVideoAverageBitRateKey: captureBitrate,
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

        let config = Self.makeConfig(
            width: width, height: height, sourceRect: sourceRect,
            maxFPS: maxFPS, showsCursor: showsCursor)
        if let t = followTarget {
            self.windowFollow = WindowFollow(
                windowID: t.windowID, app: t.app, displays: shareable.displays,
                startDisplay: t.display, startFrame: t.frame,
                width: width, height: height, maxFPS: maxFPS, showsCursor: showsCursor)
        } else {
            self.windowFollow = nil
        }

        let stopWatcher = StreamStopWatcher()
        self.stopWatcher = stopWatcher
        let stream = SCStream(filter: filter, configuration: config, delegate: stopWatcher)

        self.stream = stream
        self.captureSession = captureSession
        self.writer = writer
        self.videoInput = videoInput
        self.audioInput = audioInput
        let audioQ: DispatchQueue? = (audioOutputToWire != nil) ? DispatchQueue(label: "engine.audio") : nil
        self.audioQueue = audioQ
        super.init()

        stopWatcher.onStop = { [weak self] error in self?.streamStoppedBySystem(error) }
        try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: DispatchQueue(label: "engine.video"))
        if let ao = audioOutputToWire, let aq = audioQ {
            ao.setSampleBufferDelegate(self, queue: aq)
        }
        if let cs = captureSession {
            interruptionObserver = NotificationCenter.default.addObserver(
                forName: AVCaptureSession.wasInterruptedNotification, object: cs, queue: nil
            ) { [weak self] note in self?.handleSessionInterruption(note) }
            runtimeErrorObserver = NotificationCenter.default.addObserver(
                forName: AVCaptureSession.runtimeErrorNotification, object: cs, queue: nil
            ) { [weak self] note in self?.handleSessionRuntimeError(note) }
        }
    }

    func start() async throws {
        try await stream.startCapture()
        captureSession?.startRunning()
        if captureSession != nil {
            do {
                try verifyClockParity()
            } catch {
                // Streams are running but writer never started; tear down
                // before propagating so the engine returns to idle cleanly.
                removeNotificationObservers()
                try? await stream.stopCapture()
                captureSession?.stopRunning()
                throw error
            }
            // Engineering-only fault injection — not in IPC contract (D-12).
            if ProcessInfo.processInfo.environment["ZEIGEN_FORCE_MIC_SESSION_ERROR"] == "1" {
                DispatchQueue.global().asyncAfter(deadline: .now() + 0.100) { [weak self] in
                    guard let self else { return }
                    let shouldFire: Bool = self.lock.withLock {
                        guard !self.fatalErrorFired, self.cutoffPTS == nil else { return false }
                        self.fatalErrorFired = true
                        return true
                    }
                    guard shouldFire else { return }
                    self.onFatalError(EngineError(code: "MIC_SESSION_FAILED",
                        message: "synthetic via ZEIGEN_FORCE_MIC_SESSION_ERROR=1"))
                }
            }
        }
        cursorTracker?.start()
        startHeartbeat()
        if windowFollow != nil {
            followTask = Task { [weak self] in await self?.followWindow() }
        }
    }

    // Keeps the crop on the window: checked at ~30 Hz while it sits still and at
    // ~120 Hz while it is moving (and for half a second after). The crop can only
    // move after the window has, so during a drag it trails by a varying few
    // pixels, which shows as the window shaking in the frame; at 30 Hz that was
    // 5 to 19 px on a real drag (owner, 2026-11-15), hence the faster rate while
    // moving. Runs from stream start until stop/teardown,
    // including while paused so the crop is right at resume. A bounds change
    // re-aims sourceRect (position and size: a resized window is scaled into
    // the fixed output size). When the window's centre crosses onto another
    // display, the content filter switches to that display first; without it
    // the crop leaves the filtered display and the video silently ends.
    // Errors are logged and never stop the recording.
    private func followWindow() async {
        guard let f = windowFollow else { return }
        var display = f.startDisplay
        var last = f.startFrame
        var fastChecksLeft = 0   // > 0 while the window is, or was just, moving
        while !Task.isCancelled {
            try? await Task.sleep(for: .milliseconds(fastChecksLeft > 0 ? 8 : 33))
            fastChecksLeft = max(0, fastChecksLeft - 1)
            guard !Task.isCancelled,
                  let bounds = CursorTracker.queryWindowFrame(f.windowID), bounds != last
            else { continue }
            last = bounds
            fastChecksLeft = 60
            let centre = CGPoint(x: bounds.midX, y: bounds.midY)
            if let d = f.displays.first(where: { $0.frame.contains(centre) }), d.displayID != display.displayID {
                do {
                    try await stream.updateContentFilter(
                        SCContentFilter(display: d, including: [f.app], exceptingWindows: []))
                    display = d
                } catch {
                    logStderr("window follow: could not switch to display \(d.displayID): \(error)")
                }
            }
            guard !Task.isCancelled else { break }
            let config = Self.makeConfig(
                width: f.width, height: f.height, sourceRect: Self.cropRect(bounds, on: display),
                maxFPS: f.maxFPS, showsCursor: f.showsCursor)
            do {
                try await stream.updateConfiguration(config)
            } catch {
                logStderr("window follow: could not re-aim the crop to \(bounds): \(error)")
            }
        }
    }

    // A global window frame (points, top-left origin) as a sourceRect, which
    // is relative to the captured display's top-left.
    private static func cropRect(_ frame: CGRect, on display: SCDisplay) -> CGRect {
        frame.offsetBy(dx: -display.frame.minX, dy: -display.frame.minY)
    }

    // The one place the stream configuration is built: at init, and again by
    // the window follow loop each time it re-aims the crop.
    private static func makeConfig(
        width: Int, height: Int, sourceRect: CGRect, maxFPS: Int, showsCursor: Bool
    ) -> SCStreamConfiguration {
        let config = SCStreamConfiguration()
        config.width = width
        config.height = height
        config.sourceRect = sourceRect
        config.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(maxFPS))
        config.queueDepth = 6
        // Burned in only when telemetry is off (see showsCursor in init). The
        // sidecar's "cursor_in_video" mark records which case this is.
        config.showsCursor = showsCursor
        config.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
        // Exclude the window's own drop shadow. Applies ONLY to single-window
        // filters, i.e. today the window-capture fallback (no owning app or
        // no display found); the normal window path records a display
        // filtered to the app, where it has no effect. In a single-window
        // capture the default (false) INCLUDES the shadow, which frames the
        // window inside the window-sized buffer: the window (and its rounded
        // corners) ends up INSET, surrounded by the shadow region that 4:2:0
        // flattens to opaque black. Over a background canvas that black shows
        // as crescents at the window's corners that no frame-corner clip can
        // reach, and the inset also scaled the window DOWN (lost resolution).
        // Excluding it makes the window fill the frame at native size, so its
        // corners sit at the frame corners where the export's corner-clip
        // aligns. (macOS 14+.)
        config.ignoreShadowsSingleWindow = true
        // captureMicrophone deliberately left unset: V2.2 routes mic
        // through AVCaptureSession (Track B).
        return config
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
        var dropped = micDropped
        let lastAudioArrival = lastAudioArrivalHost
        let stopping = cutoffPTS != nil
        let fatalFired = fatalErrorFired
        lock.unlock()

        guard isStarted, !isPaused, let lastBuffer, lastArrival.isValid else { return }

        let hostNow = CMClockGetTime(CMClockGetHostTimeClock())
        let elapsed = CMTimeGetSeconds(hostNow - lastArrival)
        if elapsed < 0.2 { return }

        // D-15c: mid-recording audio-cessation watchdog. A full Continuity
        // departure or device removal stops delivering audio buffers
        // without firing wasInterrupted/runtimeError, so micDropped is
        // never set and video would freeze (see D-15a). If audio was
        // flowing and no buffer has arrived for >1s — and we're not paused
        // (guarded above), stopping, or already torn down — treat it as a
        // drop, routing to the same action as an interruption.
        if !dropped, !stopping, !fatalFired, lastAudioArrival.isValid,
           CMTimeGetSeconds(hostNow - lastAudioArrival) > 1.0 {
            lock.withLock { markMicDropped(reason: "sample-cessation") }
            dropped = true
        }

        // Cap dup PTS at audio's last appended PTS so video never runs
        // ahead of audio. AVCaptureAudioDataOutput can buffer up to ~75ms
        // of audio under load; without this cap, a heartbeat firing
        // shortly before stop dups host_now while audio's last sample is
        // tens of ms behind, leaving video_dur > audio_dur (V2.2 drift
        // bar). Audio carries the timeline in V2.2; video tracks it.
        // D-15a: once the mic has dropped, audio is finished and no longer
        // carries the timeline — release the cap so video continues
        // video-only (advancing with hostNow) instead of freezing at the
        // last audio PTS.
        let dupPTS: CMTime
        if !dropped && lastAudio.isValid && CMTimeCompare(hostNow, lastAudio) > 0 {
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
        cursorTracker?.pause()
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
        cursorTracker?.resume()
    }

    func stop() async throws -> RecordingResult {
        heartbeatTimer?.cancel()
        heartbeatTimer = nil
        // Wait for the follow loop to finish so no crop/filter update is in
        // flight when the stream stops.
        followTask?.cancel()
        await followTask?.value
        followTask = nil
        // Stop sampling at the stop command so telemetry ends where the
        // cutoff clamp ends the video; the sidecar is written after the
        // writer finalizes, below.
        cursorTracker?.stop()
        removeNotificationObservers()

        // Cutoff clamp before teardown — late samples from either pipeline
        // (SCK in-flight callbacks, AVCaptureSession queue drain) get
        // rejected deterministically rather than racing markAsFinished
        // (D-03).
        lock.withLock {
            if cutoffPTS == nil {
                cutoffPTS = CMClockGetTime(CMClockGetHostTimeClock())
            }
        }

        // macOS may already have stopped the stream (the stop button in the
        // menu-bar screen-sharing menu); stopCapture then throws -3808. That
        // must not skip finalizing the file below.
        do { try await stream.stopCapture() } catch { logStderr("stopCapture: \(error)") }
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
            // D-15a (a2): normally audio bounds the session (clamps video
            // down to kill drift — D-13 mechanism 3 / the take-9 fix). But
            // once the mic has dropped, audio finished early and video
            // legitimately runs longer, so bound at video instead;
            // otherwise endSession would clamp back to the stale drop-time
            // audio PTS and truncate the video-only tail. Gated on
            // micDropped (NOT max(v,a)) so the normal drift clamp is
            // untouched — in healthy recording video can sit slightly above
            // audio from buffering, and that must still clamp to audio.
            let end: CMTime
            if was && micDropped && lastAppendedRawVideoPTS.isValid {
                end = lastAppendedRawVideoPTS - totalPausedDuration
            } else if was && lastAppendedRawAudioPTS.isValid {
                end = lastAppendedRawAudioPTS - totalPausedDuration
            } else {
                end = .invalid
            }
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

        // V3 Phase A: write the telemetry sidecar next to the mp4, using
        // the same hidden-dotfile convention as edit.rs:sidecar_path().
        // Telemetry is capture-owned and immutable; the annotations sidecar
        // is user-edited state — separate files, separate lifecycles.
        //
        // The cursor is not in the video when the tracker exists, so a missing
        // sidecar means a recording with no cursor at all. That is reported as
        // cursorTrackError (Engine emits it as an error after `stopped`)
        // rather than only logged. No sidecar is expected when no file was
        // written (didStart false).
        var cursorTrackPath: String?
        var cursorSampleCount: Int?
        var cursorTrackError: String?
        if let tracker = cursorTracker {
            let stem = outputURL.deletingPathExtension().lastPathComponent
            let trackURL = outputURL.deletingLastPathComponent()
                .appendingPathComponent(".\(stem).cursor.json")
            do {
                if let count = try tracker.writeTrack(to: trackURL) {
                    cursorTrackPath = trackURL.path
                    cursorSampleCount = count
                } else if didStart {
                    cursorTrackError = "no video frame was written, so the cursor log has nothing to align to"
                }
            } catch {
                cursorTrackError = "\(error)"
            }
            if let cursorTrackError { logStderr("cursor track write failed: \(cursorTrackError)") }
        }

        return RecordingResult(
            path: outputURL.path,
            duration: elapsedSeconds,
            bytes: bytes,
            frames: frameCount,
            dropped: droppedCount,
            cursorTrackPath: cursorTrackPath,
            cursorSampleCount: cursorSampleCount,
            cursorTrackError: cursorTrackError
        )
    }

    // Mid-recording error path (MIC_NO_FIRST_SAMPLE in c2; c3 adds
    // MIC_SESSION_FAILED via the AVCaptureSession runtime-error observer).
    // Engine.handleFatalError calls this from the actor; we tear down
    // whatever has been written so far symmetrically.
    func tearDownAfterFatalError() async {
        heartbeatTimer?.cancel()
        heartbeatTimer = nil
        // Cancelled but not awaited: this path bounds a possibly stalled
        // stream (D-14 below), and an in-flight update could stall with it.
        // The loop checks cancellation before every update, so at most one
        // already-issued call lands, and its error is only logged.
        followTask?.cancel()
        followTask = nil
        // Fatal path saves partial video state on the way out; no telemetry
        // sidecar is written — just stop sampling and remove the monitor.
        cursorTracker?.stop()
        removeNotificationObservers()

        lock.withLock {
            if cutoffPTS == nil {
                cutoffPTS = CMClockGetTime(CMClockGetHostTimeClock())
            }
        }

        // D-14: a fatal error firing within ~100ms of a Continuity-backed
        // session can stall stream.stopCapture() indefinitely. Bound it so
        // the writer finalization below still runs and the error reaches
        // IPC. Structured concurrency awaits all children even after
        // cancel, so an uncancellable stalled stop would never return —
        // hence detached tasks racing a one-shot continuation. Capturing
        // self is region-clean (RecordingSession is @unchecked Sendable),
        // and the orphaned stop is harmless: cutoffPTS is set above so any
        // late buffers clamp, and self.stream is a `let` that is never
        // reused — the next recording builds a fresh RecordingSession with
        // its own SCStream (Engine.swift:192). The resume flag lives in an
        // OSAllocatedUnfairLock (not a bare Bool) so it is Sendable state
        // the detached closures can carry across region isolation.
        let stopStart = DispatchTime.now()
        let resumeState = OSAllocatedUnfairLock(initialState: false)
        let stoppedCleanly: Bool = await withCheckedContinuation { cont in
            @Sendable func resumeOnce(_ clean: Bool) {
                let shouldResume = resumeState.withLock { resumed -> Bool in
                    if resumed { return false }
                    resumed = true
                    return true
                }
                if shouldResume { cont.resume(returning: clean) }
            }
            Task.detached { try? await self.stream.stopCapture(); resumeOnce(true) }
            Task.detached { try? await Task.sleep(nanoseconds: 1_000_000_000); resumeOnce(false) }
        }
        if !stoppedCleanly {
            let ms = Int(Double(DispatchTime.now().uptimeNanoseconds - stopStart.uptimeNanoseconds) / 1_000_000)
            logStderr("TEARDOWN_TIMEOUT after \(ms)ms during fatal-error path")
        }
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

    // MARK: Stream stopped by macOS

    // macOS stopped the stream on its own: the user pressed the stop button in
    // the menu-bar screen-sharing menu, or the capture failed. The recording
    // ends here: clamp the timeline now so no frozen frames or audio pile up
    // after the last real frame, and tell the app, which runs its normal Stop.
    // Our own stop sets cutoffPTS first, so this ignores it.
    private func streamStoppedBySystem(_ error: any Error) {
        let ours = lock.withLock { () -> Bool in
            if cutoffPTS != nil { return true }
            cutoffPTS = CMClockGetTime(CMClockGetHostTimeClock())
            return false
        }
        if ours { return }
        logStderr("screen stream stopped by the system: \(error)")
        emit(.stream_stopped)
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
        // D-15c: stamp arrival on receipt — before the limiter and the
        // pause/cutoff checks in append() — so the cessation watchdog sees
        // a live mic even while paused (buffers still flow when paused).
        lock.withLock { lastAudioArrivalHost = CMClockGetTime(CMClockGetHostTimeClock()) }
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
        // first_frame is emitted when the writer session starts: that
        // moment is screen.mp4's time zero. Rust anchors bubble keyframes on
        // its receipt and measures the webcam lead against host_s. Declared
        // before the lock's defer so it runs after the unlock.
        var sessionStartedAt: CMTime?
        defer {
            if let t = sessionStartedAt {
                emit(.first_frame(stream: "screen", host_s: CMTimeGetSeconds(t)))
            }
        }
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
                    // macOS starts the built-in mic, then stops and restarts
                    // it once while its privacy indicator comes up; the
                    // restart takes about 0.4 s (system log, 2026-11-17). The
                    // old 250 ms wait only passed when a buffer slipped out
                    // before that restart. Nothing is lost by waiting: the
                    // recording begins at the first mic sample either way.
                    DispatchQueue.global().asyncAfter(deadline: .now() + Self.micFirstSampleWait) { [weak self] in
                        self?.checkMicTimeout()
                    }
                }
            }
        } else {
            if !firstAudioPTS.isValid {
                firstAudioPTS = rawPTS
            }
            // D-07 bucket-1: audio input already finished after interruption;
            // drop late-arriving samples before they hit a closed input.
            if micDropped { return }
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
                sessionStartedAt = origin
                // The screen frames that arrived while the mic warmed up were
                // dropped, so the next one lands a frame or two after time
                // zero. A video track that starts late reads back with a black
                // filler frame in the gap (AVAssetReader, the Review player).
                // Write the screen as it stood, at time zero.
                if !isVideo, let early = preStartVideo,
                   let first = adjustTiming(early, offset: CMSampleBufferGetPresentationTimeStamp(early) - origin),
                   videoInput.isReadyForMoreMediaData, videoInput.append(first) {
                    lastAppendedRawVideoPTS = origin
                }
                preStartVideo = nil
            } else {
                // Earlier pipeline produced before the other warmed up: drop,
                // keeping the latest screen frame for the start.
                if isVideo { preStartVideo = buffer }
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
                // V3 Phase A alignment anchor (A.2): the first video frame
                // the writer accepted, paired with mach time now — receipt
                // and append happen in the same callback, microseconds
                // apart. adjustedPTS - sessionStartPTS is this frame's
                // position on the output timeline.
                if !cursorAnchorSet, let tracker = cursorTracker {
                    cursorAnchorSet = true
                    tracker.setAnchor(
                        mach: mach_absolute_time(),
                        ptsSeconds: CMTimeGetSeconds(adjustedPTS - sessionStartPTS)
                    )
                }
            } else {
                lastAppendedRawAudioPTS = rawPTS
                audioAppended += 1
            }
        } else {
            if isVideo { dropped += 1 } else { audioDropped += 1 }
        }
    }

    // D-01 clock parity smoke. Called after captureSession.startRunning().
    // Verifies synchronizationClock is non-nil and host-time sampling is
    // well-behaved. ZEIGEN_FORCE_CLOCK_MISMATCH=1 unconditionally fails (D-12).
    private func verifyClockParity() throws {
        // Engineering-only fault injection — not in IPC contract (D-12).
        if ProcessInfo.processInfo.environment["ZEIGEN_FORCE_CLOCK_MISMATCH"] == "1" {
            throw EngineError(code: "CLOCK_MISMATCH", message: "forced via ZEIGEN_FORCE_CLOCK_MISMATCH=1")
        }
        guard captureSession?.synchronizationClock != nil else {
            throw EngineError(code: "CLOCK_MISMATCH",
                message: "AVCaptureSession.synchronizationClock is nil after startRunning")
        }
        let t1 = CMClockGetTime(CMClockGetHostTimeClock())
        let t2 = CMClockGetTime(CMClockGetHostTimeClock())
        let delta = CMTimeGetSeconds(t2 - t1)
        if delta < 0 || delta > 0.001 {
            throw EngineError(code: "CLOCK_MISMATCH",
                message: "host-time round-trip \(String(format: "%.6f", delta))s exceeds 1ms tolerance")
        }
    }

    // D-07 bucket 1 — AVCaptureSessionWasInterrupted (Continuity drop, etc.).
    // Marks audio finished; recording continues video-only. No IPC event
    // (deferred to V2.3 per CONTEXT D-07).
    private func handleSessionInterruption(_ note: Notification) {
        lock.withLock { markMicDropped(reason: "interrupted") }
    }

    // D-07 bucket-1 action, shared by the interruption observer and the
    // D-15c cessation watchdog. Caller must hold `lock`. Marks audio
    // finished so recording continues video-only (the heartbeat cap then
    // releases — D-15a). AVCaptureSessionInterruptionReasonKey is iOS-only,
    // so the reason is our own categorization, not the OS reason code.
    private func markMicDropped(reason: String) {
        guard !micDropped else { return }
        micDropped = true
        logStderr("MIC_DROPPED reason=\(reason)")
        audioInput?.markAsFinished()
    }

    // D-07 bucket 2 — AVCaptureSessionRuntimeError (genuine session failure).
    // Routes through onFatalError → handleFatalError so Engine tears down
    // and returns to idle, same path as MIC_NO_FIRST_SAMPLE.
    private func handleSessionRuntimeError(_ note: Notification) {
        let shouldFire: Bool = lock.withLock {
            guard !fatalErrorFired, cutoffPTS == nil else { return false }
            fatalErrorFired = true
            return true
        }
        guard shouldFire else { return }
        let error = note.userInfo?[AVCaptureSessionErrorKey] as? Error
        onFatalError(EngineError(
            code: "MIC_SESSION_FAILED",
            message: error?.localizedDescription ?? "AVCaptureSession runtime error"
        ))
    }

    private func removeNotificationObservers() {
        if let obs = interruptionObserver {
            NotificationCenter.default.removeObserver(obs)
            interruptionObserver = nil
        }
        if let obs = runtimeErrorObserver {
            NotificationCenter.default.removeObserver(obs)
            runtimeErrorObserver = nil
        }
    }

    deinit {
        removeNotificationObservers()
    }

    private static let micFirstSampleWait: TimeInterval = 2.0

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
            message: "first mic sample not received within \(Self.micFirstSampleWait)s of first video sample"
        ))
    }

    // Backing-store scale for a display (pixels per point) from its current
    // display mode. On a 2x Retina panel this is 2.0. SCDisplay.width returns
    // POINTS on macOS 26 (not pixels, despite Apple's docs), so the old
    // `SCDisplay.width / frame.width` ratio collapsed to 1.0 and we captured at
    // LOGICAL resolution — every zoom then upscaled pixels that were never
    // captured. CGDisplayModeGetPixelWidth/GetWidth is the real per-display
    // backing factor. Falls back to 1.0 if the mode can't be read.
    static func backingScale(for displayID: CGDirectDisplayID) -> Double {
        guard let mode = CGDisplayCopyDisplayMode(displayID) else { return 1.0 }
        let pointW = mode.width
        guard pointW > 0 else { return 1.0 }
        return Double(mode.pixelWidth) / Double(pointW)
    }

    // Capture dimensions + cursor scale, kept COUPLED by construction. Callers
    // MUST take width/height AND the cursor `scale` from the SAME returned
    // value: if the capture doubles but the cursor scale stays 1.0, video_size
    // doubles while telemetry x/y stay in points, and every zoom focus resolves
    // to half its fraction (drifts toward the top-left). Returning both from one
    // function makes that divergence impossible; `geometry_locks_scale_to_dims`
    // pins the invariant width == round(scale * pointWidth).
    struct CaptureGeometry: Equatable { let width: Int; let height: Int; let scale: Double }
    static func captureGeometry(
        pointWidth: Double, pointHeight: Double, backingScale: Double
    ) -> CaptureGeometry {
        let s = backingScale > 0 ? backingScale : 1.0
        return CaptureGeometry(
            width: max(2, Int((pointWidth * s).rounded())),
            height: max(2, Int((pointHeight * s).rounded())),
            scale: s
        )
    }

    // Find the SCK display containing the window's center, then read its
    // backing scale. Falls back to 1.0 (treat points as pixels) when the window
    // doesn't overlap any known display.
    static func displayScale(for windowFrame: CGRect, in displays: [SCDisplay]) -> Double {
        let center = CGPoint(x: windowFrame.midX, y: windowFrame.midY)
        guard let display = displays.first(where: { $0.frame.contains(center) }) else {
            return 1.0
        }
        return backingScale(for: display.displayID)
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
