// Throwaway measurement: does the new window capture add load while recording?
// Opens its own animated window (a steady, repeatable workload), then measures
// each capture method for a few seconds: CPU used by this process, CPU used by
// WindowServer (the system compositor, where capture cost mostly lands), and
// frames delivered. Also measures the two polling loops the engine runs.
//
//   swiftc -O main.swift -o captureload && ./captureload [seconds-per-phase]
// The capture phases need Screen Recording permission for the terminal.
import AppKit
import CryptoKit
import ScreenCaptureKit

let phaseSeconds = CommandLine.arguments.count > 1 ? Double(CommandLine.arguments[1]) ?? 8 : 8
let pollsOnly = CommandLine.arguments.contains("polls-only")   // skip the capture phases
setvbuf(stdout, nil, _IONBF, 0)

func ownCPU() -> Double {
    var u = rusage(); getrusage(RUSAGE_SELF, &u)
    return Double(u.ru_utime.tv_sec) + Double(u.ru_utime.tv_usec) / 1e6
         + Double(u.ru_stime.tv_sec) + Double(u.ru_stime.tv_usec) / 1e6
}
// WindowServer's accumulated CPU time, read with ps (it belongs to another user).
func windowServerCPU() -> Double {
    let p = Process(); p.executableURL = URL(fileURLWithPath: "/bin/ps")
    p.arguments = ["-axo", "cputime=,comm="]
    let pipe = Pipe(); p.standardOutput = pipe
    try? p.run()
    // Read before waiting: the full process list overflows the pipe otherwise.
    let out = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
    p.waitUntilExit()
    guard let line = out.split(separator: "\n").first(where: { $0.hasSuffix("/WindowServer") }) else { return -1 }
    let t = line.trimmingCharacters(in: .whitespaces).split(separator: " ")[0]   // [hh:]mm:ss.ss
    return t.split(separator: ":").reduce(0.0) { $0 * 60 + (Double($1) ?? 0) }
}

final class Counter: NSObject, SCStreamOutput, @unchecked Sendable {
    private let lock = NSLock(); private var n = 0
    func stream(_ s: SCStream, didOutputSampleBuffer b: CMSampleBuffer, of type: SCStreamOutputType) {
        lock.withLock { n += 1 }
    }
    func take() -> Int { lock.withLock { let v = n; n = 0; return v } }
}

@MainActor func makeWindow() -> NSWindow {
    let w = NSWindow(contentRect: NSRect(x: 120, y: 120, width: 1200, height: 800),
                     styleMask: [.titled], backing: .buffered, defer: false)
    w.title = "Zeigen capture load test"
    let v = NSView(frame: w.contentView!.bounds); v.wantsLayer = true
    v.layer!.backgroundColor = NSColor(white: 0.12, alpha: 1).cgColor
    // A grid of text rows sliding sideways forever: every frame differs, like a
    // window being scrolled or a dialog being dragged over it.
    let strip = CATextLayer()
    strip.string = (0..<40).map { "row \($0)   Sales 128,031   Profit 5,278   Region West   Quantity 12" }.joined(separator: "\n")
    strip.fontSize = 15; strip.foregroundColor = NSColor.white.cgColor
    strip.frame = CGRect(x: 0, y: 0, width: 1600, height: 800); strip.contentsScale = 2
    v.layer!.addSublayer(strip)
    let a = CABasicAnimation(keyPath: "position.x"); a.fromValue = 600; a.toValue = 1000
    a.duration = 2; a.autoreverses = true; a.repeatCount = .infinity
    strip.add(a, forKey: "slide")
    w.contentView!.addSubview(v); w.orderFrontRegardless()
    return w
}

func cursorHashPoll() {   // what CursorTracker does 20x a second
    if let tiff = NSCursor.currentSystem?.image.tiffRepresentation { _ = SHA256.hash(data: tiff) }
}
func boundsPoll(_ id: CGWindowID) {   // what the window follow does 30x a second
    _ = CGWindowListCopyWindowInfo([.optionIncludingWindow], id)
}

func measure(_ name: String, frames: Counter?, every interval: Double? = nil, _ work: (() -> Void)? = nil) async {
    let (c0, w0, t0) = (ownCPU(), windowServerCPU(), Date())
    _ = frames?.take()
    if let interval, let work {
        while Date().timeIntervalSince(t0) < phaseSeconds { work(); try? await Task.sleep(for: .seconds(interval)) }
    } else {
        try? await Task.sleep(for: .seconds(phaseSeconds))
    }
    let dt = Date().timeIntervalSince(t0)
    let fps = frames.map { String(format: "%5.1f fps", Double($0.take()) / dt) } ?? "    -    "
    print(String(format: "%-46@ this process %5.1f%%   WindowServer %5.1f%%   %@",
                 name as NSString, (ownCPU() - c0) / dt * 100, (windowServerCPU() - w0) / dt * 100, fps))
}

func config(_ w: Int, _ h: Int, _ rect: CGRect) -> SCStreamConfiguration {
    let c = SCStreamConfiguration()
    c.width = w; c.height = h; c.sourceRect = rect
    c.minimumFrameInterval = CMTime(value: 1, timescale: 30); c.queueDepth = 6
    c.showsCursor = false; c.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
    c.ignoreShadowsSingleWindow = true
    return c
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
Task { @MainActor in
    let window = makeWindow()
    let wid = CGWindowID(window.windowNumber)
    try? await Task.sleep(for: .seconds(1))
    print("CPU as a percentage of ONE core, averaged over \(Int(phaseSeconds))s per line. Leave the machine alone while it runs.")
    await measure("no capture (the animated window alone)", frames: nil)
    await measure("cursor shape check, 20 per second", frames: nil, every: 1.0 / 20, cursorHashPoll)
    await measure("window position check, 30 per second", frames: nil, every: 1.0 / 30) { boundsPoll(wid) }

    if pollsOnly { exit(0) }
    let content: SCShareableContent
    do { content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true) }
    catch { print("capture phases skipped (no Screen Recording permission for this terminal): \(error)"); exit(0) }
    guard let scWindow = content.windows.first(where: { $0.windowID == wid }), let scApp = scWindow.owningApplication,
          let display = content.displays.first(where: { $0.frame.contains(CGPoint(x: scWindow.frame.midX, y: scWindow.frame.midY)) })
    else { print("could not find the test window in the shareable content"); exit(1) }

    let old = SCContentFilter(desktopIndependentWindow: scWindow)
    let new = SCContentFilter(display: display, including: [scApp], exceptingWindows: [])
    let scale = Double(new.pointPixelScale)
    let (pw, ph) = (Int(scWindow.frame.width * scale), Int(scWindow.frame.height * scale))
    let crop = scWindow.frame.offsetBy(dx: -display.frame.minX, dy: -display.frame.minY)
    print("test window \(pw)x\(ph) px on a display at scale \(scale)")

    for (name, filter, rect) in [("OLD capture: the single window", old, CGRect.zero),
                                 ("NEW capture: the app on its display, cropped", new, crop)] {
        let counter = Counter()
        let stream = SCStream(filter: filter, configuration: config(pw, ph, rect), delegate: nil)
        do {
            try stream.addStreamOutput(counter, type: .screen, sampleHandlerQueue: DispatchQueue(label: "frames"))
            try await stream.startCapture()
        } catch { print("\(name): capture did not start: \(error)"); continue }
        try? await Task.sleep(for: .seconds(1))
        await measure(name, frames: counter)
        if filter === new {
            await measure("NEW capture + window position check, 30/s", frames: counter, every: 1.0 / 30) { boundsPoll(wid) }
        }
        try? await stream.stopCapture()
    }
    exit(0)
}
app.run()
