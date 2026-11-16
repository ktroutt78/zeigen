// Throwaway test for ZOOM-POLISH-PLAN problem 3 (window capture drops popups).
// Records ONE app's main window for a few seconds using the proposed approach:
// a display filter narrowed to that app (so its menus, popovers, sheets and
// dialogs are included), cropped to the window's rectangle, with the crop
// following the window if it moves. Not wired into Zeigen.
//
//   swiftc -O main.swift -o appcapture
//   ./appcapture "Google Chrome" out.mp4 20
import AVFoundation
import CoreGraphics
import Foundation
import ScreenCaptureKit

func die(_ m: String) -> Never { FileHandle.standardError.write((m + "\n").data(using: .utf8)!); exit(1) }

let args = CommandLine.arguments
guard args.count >= 3 else { die("usage: appcapture <app name or bundle id> <out.mp4> [seconds]") }
let name = args[1]
let outURL = URL(fileURLWithPath: args[2])
let seconds = args.count > 3 ? Double(args[3]) ?? 15 : 15
try? FileManager.default.removeItem(at: outURL)

final class Delegate: NSObject, SCStreamDelegate, SCRecordingOutputDelegate {
    func stream(_ stream: SCStream, didStopWithError error: Error) { die("stream stopped: \(error)") }
    func recordingOutput(_ r: SCRecordingOutput, didFailWithError error: Error) { die("recording failed: \(error)") }
}

func windowBounds(_ id: CGWindowID) -> CGRect? {
    guard let raw = CGWindowListCopyWindowInfo([.optionIncludingWindow], id) as? [[String: Any]],
          let b = raw.first?[kCGWindowBounds as String] as? NSDictionary else { return nil }
    return CGRect(dictionaryRepresentation: b)
}

let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
guard let app = content.applications.first(where: { $0.bundleIdentifier == name || $0.applicationName == name })
else { die("app not found: \(name). Running: \(content.applications.map(\.applicationName).sorted().joined(separator: ", "))") }
let appWindows = content.windows.filter { $0.owningApplication?.processID == app.processID && $0.windowLayer == 0 && $0.isOnScreen }
guard let window = appWindows.max(by: { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height })
else { die("no on-screen window for \(name)") }
let centre = CGPoint(x: window.frame.midX, y: window.frame.midY)
guard let display = content.displays.first(where: { $0.frame.contains(centre) }) else { die("window is not on a display") }

let filter = SCContentFilter(display: display, including: [app], exceptingWindows: [])
let scale = Double(filter.pointPixelScale)
func crop(_ f: CGRect) -> CGRect { f.offsetBy(dx: -display.frame.minX, dy: -display.frame.minY) }

let config = SCStreamConfiguration()
config.sourceRect = crop(window.frame)
config.width = Int(window.frame.width * scale)
config.height = Int(window.frame.height * scale)
config.minimumFrameInterval = CMTime(value: 1, timescale: 30)
config.showsCursor = true

let delegate = Delegate()
let stream = SCStream(filter: filter, configuration: config, delegate: delegate)
let rc = SCRecordingOutputConfiguration()
rc.outputURL = outURL
rc.videoCodecType = .h264
try stream.addRecordingOutput(SCRecordingOutput(configuration: rc, delegate: delegate))
try await stream.startCapture()
print("recording \"\(window.title ?? "")\" of \(app.applicationName): \(config.width)x\(config.height) px, window \(window.frame), scale \(scale), for \(seconds)s")
print("now: open a dropdown, right-click for a menu, trigger a dialog, then drag the window a little")

var last = window.frame
var moves = 0
for _ in 0..<Int(seconds * 10) {
    try await Task.sleep(nanoseconds: 100_000_000)
    guard let b = windowBounds(window.windowID), b != last else { continue }
    last = b
    moves += 1
    config.sourceRect = crop(b)
    try await stream.updateConfiguration(config)
}
try await stream.stopCapture()
print("done: \(outURL.path)  (crop re-aimed \(moves) times)")
