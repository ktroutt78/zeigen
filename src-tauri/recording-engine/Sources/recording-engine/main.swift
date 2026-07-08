import AVFoundation
import CoreGraphics
import Foundation

// Initialize the CoreGraphics window-server connection in this CLI binary.
// SCK's window-capture path (SCContentFilter(desktopIndependentWindow:),
// SCShareableContent.windows access, etc.) and CGWindowList* APIs assert
// "CGS_REQUIRE_INIT" if CG isn't initialized — which it isn't by default
// in a daemon-style Swift CLI process. Do NOT use NSApplication.shared for
// this: it registers the process with Launch Services as a launching
// Foreground app that never finishes launching (no .run()), which bounces
// a ghost Zeigen tile in the Dock for ~2 min, stalls SCK enumeration
// behind the launch handshake, and — because it shares the app's bundle id
// — makes AppleScript resolve "Zeigen" to this process, breaking
// `tell application "Zeigen" to quit`. CGMainDisplayID() establishes the
// CGS connection with no LS registration at all.
_ = CGMainDisplayID()

// D-08: pre-request both permissions before ready fires so AVCaptureSession
// never encounters a missing-mic-permission case mid-recording.
//
// Neither check is fatal. CGRequestScreenCaptureAccess() doesn't block for
// the user's response — it fires the system prompt and returns the
// *current* (pre-response) status immediately, so on a fresh/reset grant
// this reliably reads as not-yet-granted even though the user is about to
// approve it. Exiting here used to require killing and relaunching the
// whole app after every grant, since the dead engine process couldn't
// retroactively pick up a permission that arrived a second later. Instead,
// emit the failure (surfaced to the frontend) and keep running — the engine
// stays alive as a persistent connection, and handleStart/handleEnumerate
// already handle a still-missing permission gracefully via their own
// try/catch, so the very next "start" or "enumerate" command re-checks
// fresh once the user has actually granted access.
let screenGranted = CGRequestScreenCaptureAccess()
if !screenGranted {
    emit(.error(code: "PERMISSION_DENIED", message: "Screen Recording permission not granted"))
}
let micGranted = await withCheckedContinuation { (c: CheckedContinuation<Bool, Never>) in
    AVCaptureDevice.requestAccess(for: .audio) { ok in c.resume(returning: ok) }
}
if !micGranted {
    emit(.error(code: "PERMISSION_DENIED", message: "Microphone permission not granted"))
}

let engine = Engine()
emit(.ready(version: "0.1.0"))

while let line = readLine() {
    if line.isEmpty { continue }
    guard let data = line.data(using: .utf8) else {
        emit(.error(code: "INVALID_COMMAND", message: "non-utf8 line"))
        continue
    }
    do {
        let cmd = try JSONDecoder().decode(Command.self, from: data)
        await engine.handle(cmd)
    } catch {
        emit(.error(code: "INVALID_COMMAND", message: "\(error)"))
    }
}
