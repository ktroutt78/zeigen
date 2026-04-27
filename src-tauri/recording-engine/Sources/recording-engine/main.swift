import AppKit
import Foundation

// Bring up AppKit/CoreGraphics in this CLI binary without launching a UI.
// SCK's window-capture path (SCContentFilter(desktopIndependentWindow:),
// SCShareableContent.windows access, etc.) and CGWindowList* APIs assert
// "CGS_REQUIRE_INIT" if CG isn't initialized — which it isn't by default
// in a daemon-style Swift CLI process. Touching NSApplication.shared
// triggers NSApplication's class load, which initializes CG; we don't
// call .run() so no run loop or Dock icon.
_ = NSApplication.shared

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
