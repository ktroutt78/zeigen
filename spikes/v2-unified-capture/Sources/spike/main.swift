import AppKit
import AVFoundation
import CoreGraphics
import CoreMedia
import Foundation

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
    case trackBNotImplemented = 82
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

switch args.track {
case "A":
    runTrackA()
case "auto":
    // c1: auto = try A; no fallback (c2 adds B).
    runTrackA()
case "B":
    die(.trackBNotImplemented, "TRACK_B_NOT_IMPLEMENTED: Track B lands in c2")
default:
    die(.usage, "USAGE: --track \(args.track)")
}
