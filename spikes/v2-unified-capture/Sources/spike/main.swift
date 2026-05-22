import AppKit
import AVFoundation
import CoreGraphics
import CoreMedia
import Foundation
import ScreenCaptureKit

// CG init — same pattern as src-tauri/recording-engine/Sources/recording-engine/main.swift:11.
// AVCaptureSession + CGDisplay enumeration touch CoreGraphics; without
// NSApplication.shared CG asserts CGS_REQUIRE_INIT in a daemon-style CLI.
_ = NSApplication.shared

enum Exit: Int32 {
    case ok = 0
    case usage = 64
    case permissionDenied = 70
    case displayNotFound = 71
    case micNotFound = 72
    case trackAUnavailable = 80
    case trackAClockMissing = 81
    case trackBSetupFailed = 83
    case sessionSetupFailed = 90
    case recordingFailed = 91
}

func die(_ code: Exit, _ msg: String) -> Never {
    FileHandle.standardError.write(Data((msg + "\n").utf8))
    exit(code.rawValue)
}

let usage = """
spike — V2.1 unified-capture probe
usage:
  spike --list-displays
  spike --list-mics
  spike --display <CGDirectDisplayID> [--mic <uniqueID>] [--duration <s>] [--track auto|A|B] --out <path>
"""

struct Args {
    var listDisplays = false
    var listMics = false
    var display: UInt32?
    var micUID: String?
    var duration: Double = 30
    var out: String?
    var track: String = "auto"
}

func parseArgs() -> Args {
    var a = Args()
    let argv = CommandLine.arguments
    var i = 1
    while i < argv.count {
        let arg = argv[i]
        func next(_ what: String) -> String {
            i += 1
            guard i < argv.count else { die(.usage, "USAGE: \(arg) requires \(what)") }
            return argv[i]
        }
        switch arg {
        case "--list-displays": a.listDisplays = true
        case "--list-mics":     a.listMics = true
        case "--display":
            let v = next("CGDirectDisplayID integer")
            guard let n = UInt32(v) else { die(.usage, "USAGE: --display expects integer, got \(v)") }
            a.display = n
        case "--mic":
            a.micUID = next("uniqueID")
        case "--duration":
            let v = next("seconds")
            guard let d = Double(v), d > 0 else { die(.usage, "USAGE: --duration expects positive seconds, got \(v)") }
            a.duration = d
        case "--out":
            a.out = next("path")
        case "--track":
            let v = next("auto|A|B")
            guard ["auto", "A", "B"].contains(v) else { die(.usage, "USAGE: --track expects auto|A|B, got \(v)") }
            a.track = v
        case "-h", "--help":
            print(usage)
            exit(0)
        default:
            die(.usage, "USAGE: unknown flag \(arg)\n\(usage)")
        }
        i += 1
    }
    return a
}

let args = parseArgs()

// MARK: --list-displays

if args.listDisplays {
    var count: UInt32 = 0
    CGGetActiveDisplayList(0, nil, &count)
    var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
    CGGetActiveDisplayList(count, &ids, &count)
    var nameByID: [UInt32: String] = [:]
    for s in NSScreen.screens {
        if let n = s.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber {
            nameByID[n.uint32Value] = s.localizedName
        }
    }
    print("CGDirectDisplayID\twidth×height\tis_primary\tlocalized_name\tavc_uniqueID")
    for id in ids {
        let pw = CGDisplayPixelsWide(id)
        let ph = CGDisplayPixelsHigh(id)
        let primary = CGDisplayIsMain(id) != 0
        let name = nameByID[id] ?? "unknown"
        print("\(id)\t\(pw)×\(ph)\t\(primary ? "yes" : "no")\t\(name)\tn/a")
    }
    exit(0)
}

// MARK: --list-mics

if args.listMics {
    let types: [AVCaptureDevice.DeviceType] = [.microphone, .external]
    let session = AVCaptureDevice.DiscoverySession(deviceTypes: types, mediaType: .audio, position: .unspecified)
    let defaultMic = AVCaptureDevice.default(for: .audio)
    print("uniqueID\tlocalizedName\tis_default")
    for d in session.devices {
        let isDefault = d.uniqueID == defaultMic?.uniqueID
        print("\(d.uniqueID)\t\(d.localizedName)\t\(isDefault ? "yes" : "no")")
    }
    exit(0)
}

// MARK: Recording mode — validate args

guard let displayID = args.display else {
    die(.usage, "USAGE: --display is required for recording\n\(usage)")
}
guard let outPath = args.out else {
    die(.usage, "USAGE: --out is required for recording\n\(usage)")
}

do {
    var count: UInt32 = 0
    CGGetActiveDisplayList(0, nil, &count)
    var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
    CGGetActiveDisplayList(count, &ids, &count)
    if !ids.contains(displayID) {
        die(.displayNotFound, "DISPLAY_NOT_FOUND: display \(displayID) not in active list \(ids)")
    }
}

let micDevice: AVCaptureDevice = {
    if let uid = args.micUID {
        guard let d = AVCaptureDevice(uniqueID: uid) else {
            die(.micNotFound, "MIC_NOT_FOUND: no AVCaptureDevice with uniqueID \(uid)")
        }
        return d
    }
    guard let d = AVCaptureDevice.default(for: .audio) else {
        die(.micNotFound, "MIC_NOT_FOUND: no default audio device")
    }
    return d
}()

// MARK: Permissions (CONTEXT D-07)
// Pre-request both before constructing AVCaptureSession so denial surfaces
// here with a clear code, not buried in AVCaptureSession's opaque failure path.

if !CGRequestScreenCaptureAccess() {
    die(.permissionDenied, "PERMISSION_DENIED: screen recording. Grant in System Settings → Privacy & Security → Screen Recording, then re-run.")
}

let micGranted = await withCheckedContinuation { (c: CheckedContinuation<Bool, Never>) in
    AVCaptureDevice.requestAccess(for: .audio) { ok in c.resume(returning: ok) }
}
if !micGranted {
    die(.permissionDenied, "PERMISSION_DENIED: microphone")
}

// MARK: Output prep

let outURL = URL(fileURLWithPath: outPath)
try? FileManager.default.createDirectory(at: outURL.deletingLastPathComponent(), withIntermediateDirectories: true)
try? FileManager.default.removeItem(at: outURL)
let trackSidecar = URL(fileURLWithPath: outPath + ".track")
try? FileManager.default.removeItem(at: trackSidecar)

// MARK: Track A — SDK probe for a screen-shaped AVCaptureDevice

func probeScreenAVDevice() -> (device: AVCaptureDevice?, enumerated: [String]) {
    let types: [AVCaptureDevice.DeviceType] = [
        .builtInWideAngleCamera,
        .external,
        .continuityCamera,
        .deskViewCamera,
    ]
    var enumerated: Set<String> = []
    let s = AVCaptureDevice.DiscoverySession(deviceTypes: types, mediaType: .video, position: .unspecified)
    for d in s.devices {
        enumerated.insert("\(d.deviceType.rawValue):\(d.localizedName)")
    }
    for d in AVCaptureDevice.devices(for: .video) {
        enumerated.insert("\(d.deviceType.rawValue):\(d.localizedName)")
        let raw = d.deviceType.rawValue.lowercased()
        if raw.contains("screen") || raw.contains("display") {
            return (d, Array(enumerated).sorted())
        }
    }
    return (nil, Array(enumerated).sorted())
}

final class MovieDelegate: NSObject, AVCaptureFileOutputRecordingDelegate {
    private let sem = DispatchSemaphore(value: 0)
    var error: Error?
    func fileOutput(_ output: AVCaptureFileOutput, didFinishRecordingTo outputFileURL: URL, from connections: [AVCaptureConnection], error: Error?) {
        self.error = error
        sem.signal()
    }
    func wait() { sem.wait() }
}

@MainActor
func runTrackA() -> Never {
    let (screenDevice, enumerated) = probeScreenAVDevice()
    guard let device = screenDevice else {
        let listing = enumerated.isEmpty ? "  (none)" : enumerated.map { "  - \($0)" }.joined(separator: "\n")
        die(.trackAUnavailable, """
TRACK_A_UNAVAILABLE: no AVCaptureDevice with screen-shaped deviceType found.
macOS: \(ProcessInfo.processInfo.operatingSystemVersionString)
enumerated video devices:
\(listing)
""")
    }

    let session = AVCaptureSession()
    session.beginConfiguration()
    let screenInput: AVCaptureDeviceInput
    let micInput: AVCaptureDeviceInput
    do {
        screenInput = try AVCaptureDeviceInput(device: device)
        micInput = try AVCaptureDeviceInput(device: micDevice)
    } catch {
        die(.sessionSetupFailed, "SESSION_SETUP_FAILED: input construction: \(error)")
    }
    guard session.canAddInput(screenInput) else {
        die(.sessionSetupFailed, "SESSION_SETUP_FAILED: cannot add screen input")
    }
    session.addInput(screenInput)
    guard session.canAddInput(micInput) else {
        die(.sessionSetupFailed, "SESSION_SETUP_FAILED: cannot add mic input")
    }
    session.addInput(micInput)

    let output = AVCaptureMovieFileOutput()
    guard session.canAddOutput(output) else {
        die(.sessionSetupFailed, "SESSION_SETUP_FAILED: cannot add movie file output")
    }
    session.addOutput(output)
    session.commitConfiguration()

    // Clock identity: log session.synchronizationClock and host clock so
    // SPIKE-REPORT can record whether the unified path shares host time
    // (the common case) or runs against a session-internal clock.
    let clock = session.synchronizationClock
    let host = CMClockGetHostTimeClock()
    let clockID = clock.map { ObjectIdentifier($0).hashValue.description } ?? "nil"
    let hostID = ObjectIdentifier(host).hashValue.description
    let isHost = (clock === host)
    FileHandle.standardError.write(Data("""
session.synchronizationClock: \(clockID)
host clock: \(hostID)
clock === host: \(isHost)

""".utf8))
    guard clock != nil else {
        die(.trackAClockMissing, "TRACK_A_CLOCK_MISSING: session.synchronizationClock is nil")
    }

    let delegate = MovieDelegate()
    session.startRunning()
    output.startRecording(to: outURL, recordingDelegate: delegate)

    FileHandle.standardError.write(Data("recording \(args.duration)s → \(outPath)\n".utf8))
    Thread.sleep(forTimeInterval: args.duration)
    output.stopRecording()
    delegate.wait()
    session.stopRunning()

    if let err = delegate.error {
        die(.recordingFailed, "RECORDING_FAILED: \(err)")
    }

    try? "A".write(to: trackSidecar, atomically: true, encoding: .utf8)
    exit(Exit.ok.rawValue)
}

// MARK: Track B — SCK screen + AVCaptureSession mic, shared host clock
//
// SCStream's CMSampleBuffers carry timestamps in CMClockGetHostTimeClock()'s
// time base on macOS (v1.0 RecordingSession.swift:197/280 relies on this).
// AVCaptureSession's synchronizationClock is also host time by default.
// Track B's job is to verify both share that clock and then mux their
// CMSampleBuffers into one AVAssetWriter whose session start uses a single
// PTS from whichever stream arrives first.

struct SpikeError: Error, CustomStringConvertible {
    let message: String
    init(_ message: String) { self.message = message }
    var description: String { message }
}

final class TrackBRunner: NSObject, @unchecked Sendable, SCStreamOutput, AVCaptureAudioDataOutputSampleBufferDelegate {
    private let stream: SCStream
    private let session: AVCaptureSession
    private let writer: AVAssetWriter
    private let videoInput: AVAssetWriterInput
    private let audioInput: AVAssetWriterInput

    private let lock = NSLock()
    private var started = false
    private var firstVideoPTS: CMTime = .invalid
    private var firstAudioPTS: CMTime = .invalid
    private var videoSamples = 0
    private var audioSamples = 0

    init(display: SCDisplay, micDevice: AVCaptureDevice, outURL: URL) throws {
        let width = Int(display.width)
        let height = Int(display.height)

        // Writer settings match v1.0 RecordingSession.swift:111-143 so SPIKE-REPORT
        // measurements are apples-to-apples vs the v1.0 baseline.
        let writer = try AVAssetWriter(outputURL: outURL, fileType: .mp4)
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
        guard writer.canAdd(videoInput) else { throw SpikeError("cannot add video input to writer") }
        writer.add(videoInput)

        let audioSettings: [String: Any] = [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: 48_000,
            AVNumberOfChannelsKey: 1,
            AVEncoderBitRateKey: 128_000,
        ]
        let audioInput = AVAssetWriterInput(mediaType: .audio, outputSettings: audioSettings)
        audioInput.expectsMediaDataInRealTime = true
        guard writer.canAdd(audioInput) else { throw SpikeError("cannot add audio input to writer") }
        writer.add(audioInput)

        // SCStream — screen only. captureMicrophone deliberately NOT set:
        // Track B's defining choice is routing mic through AVCaptureSession.
        let filter = SCContentFilter(display: display, excludingWindows: [])
        let config = SCStreamConfiguration()
        config.width = width
        config.height = height
        config.minimumFrameInterval = CMTime(value: 1, timescale: 60)
        config.queueDepth = 6
        config.showsCursor = true
        config.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
        let stream = SCStream(filter: filter, configuration: config, delegate: nil)

        // AVCaptureSession — mic via AVCaptureAudioDataOutput so raw CMSampleBuffers
        // thread into the writer (movie file output can't be muxed with SCK).
        let session = AVCaptureSession()
        let micInput = try AVCaptureDeviceInput(device: micDevice)
        guard session.canAddInput(micInput) else { throw SpikeError("cannot add mic input to session") }
        session.addInput(micInput)

        let audioOutput = AVCaptureAudioDataOutput()
        // Force mono float PCM at 48 kHz so the AAC encoder input matches its output
        // 1:1 (the mic could otherwise be stereo, and writer downmix isn't guaranteed).
        audioOutput.audioSettings = [
            AVFormatIDKey: kAudioFormatLinearPCM,
            AVLinearPCMBitDepthKey: 32,
            AVLinearPCMIsFloatKey: true,
            AVLinearPCMIsBigEndianKey: false,
            AVLinearPCMIsNonInterleaved: false,
            AVSampleRateKey: 48_000.0,
            AVNumberOfChannelsKey: 1,
        ]
        guard session.canAddOutput(audioOutput) else { throw SpikeError("cannot add audio output to session") }
        session.addOutput(audioOutput)

        self.stream = stream
        self.session = session
        self.writer = writer
        self.videoInput = videoInput
        self.audioInput = audioInput
        super.init()

        try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: DispatchQueue(label: "spike.video"))
        audioOutput.setSampleBufferDelegate(self, queue: DispatchQueue(label: "spike.audio"))
    }

    func clockIdentitySnapshot(label: String) -> String {
        let sessionClock = session.synchronizationClock
        let hostClock = CMClockGetHostTimeClock()
        let sessionID = sessionClock.map { ObjectIdentifier($0).hashValue.description } ?? "nil"
        let hostID = ObjectIdentifier(hostClock).hashValue.description
        let sessionIsHost = (sessionClock === hostClock)
        return """
        [Track B clock identity — \(label)]
          AVCaptureSession.synchronizationClock: \(sessionID)
          host clock:                            \(hostID)
          session === host:                      \(sessionIsHost)
          SCStream PTS time base:                host clock (SCK samples carry CMClockGetHostTimeClock() timestamps)
        """
    }

    func startCapture() async throws {
        try await stream.startCapture()
        session.startRunning()
    }

    func stopCapture() async throws {
        try await stream.stopCapture()
        session.stopRunning()
        videoInput.markAsFinished()
        audioInput.markAsFinished()
        await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
            writer.finishWriting { cont.resume() }
        }
        if writer.status == .failed {
            throw writer.error ?? SpikeError("writer finished with status=failed and no error")
        }
    }

    func firstSampleSummary() -> String {
        lock.lock(); defer { lock.unlock() }
        let v = firstVideoPTS.isValid ? String(format: "%.6f", CMTimeGetSeconds(firstVideoPTS)) : "n/a"
        let a = firstAudioPTS.isValid ? String(format: "%.6f", CMTimeGetSeconds(firstAudioPTS)) : "n/a"
        let host = String(format: "%.6f", CMTimeGetSeconds(CMClockGetTime(CMClockGetHostTimeClock())))
        return "[Track B counters] video samples: \(videoSamples); audio samples: \(audioSamples); first video PTS: \(v)s; first audio PTS: \(a)s; host now: \(host)s"
    }

    // Sidecar carries the absolute host-time PTS of each pipeline's first
    // sample buffer as it arrived at the writer. The driver subtracts these
    // from each stream's ffprobe duration to compute a drift signal that
    // factors out startup-asymmetry (PLAN c2 measurement matrix amendment).
    func writePTSSidecar(to url: URL) throws {
        lock.lock(); defer { lock.unlock() }
        let v = firstVideoPTS.isValid ? CMTimeGetSeconds(firstVideoPTS) : Double.nan
        let a = firstAudioPTS.isValid ? CMTimeGetSeconds(firstAudioPTS) : Double.nan
        let content = "video=\(String(format: "%.6f", v))\naudio=\(String(format: "%.6f", a))\n"
        try content.write(to: url, atomically: true, encoding: .utf8)
    }

    // MARK: SCStreamOutput

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard sampleBuffer.isValid, type == .screen else { return }
        guard let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let status = attachments.first?[.status] as? Int,
              status == SCFrameStatus.complete.rawValue
        else { return }
        append(sampleBuffer, to: videoInput, isVideo: true)
    }

    // MARK: AVCaptureAudioDataOutputSampleBufferDelegate

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        guard sampleBuffer.isValid else { return }
        append(sampleBuffer, to: audioInput, isVideo: false)
    }

    private func append(_ buffer: CMSampleBuffer, to input: AVAssetWriterInput, isVideo: Bool) {
        lock.lock()
        let pts = CMSampleBufferGetPresentationTimeStamp(buffer)
        if !started {
            writer.startWriting()
            writer.startSession(atSourceTime: pts)
            started = true
        }
        if isVideo {
            videoSamples += 1
            if !firstVideoPTS.isValid { firstVideoPTS = pts }
        } else {
            audioSamples += 1
            if !firstAudioPTS.isValid { firstAudioPTS = pts }
        }
        let ready = input.isReadyForMoreMediaData
        lock.unlock()
        if !ready { return }
        input.append(buffer)
    }
}

@MainActor
func runTrackB() async -> Never {
    let shareable: SCShareableContent
    do {
        shareable = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
    } catch {
        die(.trackBSetupFailed, "TRACK_B_SETUP_FAILED: SCShareableContent: \(error)")
    }
    guard let display = shareable.displays.first(where: { $0.displayID == displayID }) else {
        let available = shareable.displays.map { String($0.displayID) }.joined(separator: ",")
        die(.displayNotFound, "DISPLAY_NOT_FOUND: display \(displayID) not in SCShareableContent (available: \(available))")
    }

    let runner: TrackBRunner
    do {
        runner = try TrackBRunner(display: display, micDevice: micDevice, outURL: outURL)
    } catch {
        die(.trackBSetupFailed, "TRACK_B_SETUP_FAILED: runner init: \(error)")
    }

    FileHandle.standardError.write(Data((runner.clockIdentitySnapshot(label: "pre-start") + "\n").utf8))

    do {
        try await runner.startCapture()
    } catch {
        die(.trackBSetupFailed, "TRACK_B_SETUP_FAILED: startCapture: \(error)")
    }

    FileHandle.standardError.write(Data((runner.clockIdentitySnapshot(label: "post-start") + "\n").utf8))
    FileHandle.standardError.write(Data("recording \(args.duration)s → \(outPath)\n".utf8))

    try? await Task.sleep(nanoseconds: UInt64(args.duration * 1_000_000_000))

    do {
        try await runner.stopCapture()
    } catch {
        die(.recordingFailed, "RECORDING_FAILED: \(error)")
    }

    FileHandle.standardError.write(Data((runner.firstSampleSummary() + "\n").utf8))

    let ptsSidecar = URL(fileURLWithPath: outPath + ".pts")
    try? runner.writePTSSidecar(to: ptsSidecar)

    try? "B".write(to: trackSidecar, atomically: true, encoding: .utf8)
    exit(Exit.ok.rawValue)
}

switch args.track {
case "A":
    runTrackA()
case "B":
    await runTrackB()
case "auto":
    // c2: auto = probe Track A; fall through to B if no screen-shaped device.
    let (screenDevice, _) = probeScreenAVDevice()
    if screenDevice != nil {
        runTrackA()
    } else {
        await runTrackB()
    }
default:
    die(.usage, "USAGE: --track \(args.track)")
}
