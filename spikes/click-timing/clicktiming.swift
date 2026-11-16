// Spike: how promptly does macOS update the permission-free event counters the
// recording engine reads for clicks and scrolls (CursorTracker.swift)?
// Cursor logs show click times on a half-second grid although the engine polls
// 120 times a second. This polls the same counters 1000 times a second for 15s
// and prints when each one changes. Run it, then click and scroll at irregular
// moments. No permission needed; it only reads counters.
//
//   swiftc -O spikes/click-timing/clicktiming.swift -o spikes/click-timing/clicktiming && spikes/click-timing/clicktiming
import AppKit
import CoreGraphics
import Foundation

let kinds: [(CGEventType, String)] = [
    (.leftMouseDown, "down"), (.leftMouseUp, "up"), (.scrollWheel, "scroll"), (.mouseMoved, "move"),
]
var last = kinds.map { CGEventSource.counterForEventType(.combinedSessionState, eventType: $0.0) }
var moveChanges: [Double] = []
// Round 2: two polled "is the left button down right now" readings, to see
// whether either is live (unlike the counters, which round 1 showed macOS
// refreshes only every 0.5s).
var cgDown = CGEventSource.buttonState(.combinedSessionState, button: .left)
var nsDown = NSEvent.pressedMouseButtons & 1 == 1
let t0 = Date()
print("Click about ten times at irregular moments for 15 seconds: some quick clicks, a couple held for a second.")
while true {
    let t = Date().timeIntervalSince(t0)
    if t > 15 { break }
    let cg = CGEventSource.buttonState(.combinedSessionState, button: .left)
    if cg != cgDown {
        cgDown = cg
        print(String(format: "%7.3f  CGEventSource.buttonState  %@", t, cg ? "DOWN" : "up"))
    }
    let ns = NSEvent.pressedMouseButtons & 1 == 1
    if ns != nsDown {
        nsDown = ns
        print(String(format: "%7.3f  NSEvent.pressedMouseButtons %@", t, ns ? "DOWN" : "up"))
    }
    for (i, k) in kinds.enumerated() {
        let c = CGEventSource.counterForEventType(.combinedSessionState, eventType: k.0)
        guard c != last[i] else { continue }
        let n = Int(c) - Int(last[i])
        last[i] = c
        if k.1 == "move" { moveChanges.append(t); continue }
        let since = CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: k.0)
        print(String(format: "%7.3f  %-6@ +%d  secondsSinceLast %.3f", t, k.1 as NSString, n, since))
    }
    usleep(1000)
}
let gaps = zip(moveChanges, moveChanges.dropFirst()).map { $1 - $0 }.sorted()
if gaps.isEmpty {
    print("move counter: \(moveChanges.count) changes")
} else {
    print(String(format: "move counter: %d changes, gap between changes min %.3f median %.3f max %.3f",
                 moveChanges.count, gaps[0], gaps[gaps.count / 2], gaps[gaps.count - 1]))
    print("move change times (first 20): " + moveChanges.prefix(20).map { String(format: "%.2f", $0) }.joined(separator: " "))
}
