import AppKit
import AVFoundation
import Foundation

// Bring up AppKit/CoreGraphics in this CLI binary without launching a UI.
// SCK's window-capture path (SCContentFilter(desktopIndependentWindow:),
// SCShareableContent.windows access, etc.) and CGWindowList* APIs assert
// "CGS_REQUIRE_INIT" if CG isn't initialized — which it isn't by default
// in a daemon-style Swift CLI process. Touching NSApplication.shared
// triggers NSApplication's class load, which initializes CG; we don't
// call .run() so no run loop or Dock icon.
_ = NSApplication.shared

// D-08: pre-request both permissions before ready fires so AVCaptureSession
// never encounters a missing-mic-permission case mid-recording.
let screenGranted = CGRequestScreenCaptureAccess()
if !screenGranted {
    emit(.error(code: "PERMISSION_DENIED", message: "Screen Recording permission not granted"))
    exit(1)
}
let micGranted = await withCheckedContinuation { (c: CheckedContinuation<Bool, Never>) in
    AVCaptureDevice.requestAccess(for: .audio) { ok in c.resume(returning: ok) }
}
if !micGranted {
    emit(.error(code: "PERMISSION_DENIED", message: "Microphone permission not granted"))
    exit(1)
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
