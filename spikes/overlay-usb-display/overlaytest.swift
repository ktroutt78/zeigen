// Shows two labelled boxes on every display for 10 seconds.
// A is an ordinary window. B is the same window marked "hidden from screen
// capture" (NSWindow.sharingType = .none), which is what every Zeigen overlay does.
// Question: on a USB-driven display (DisplayLink, Silicon Motion InstantView),
// does B show up?  Run: swift spikes/overlay-usb-display/overlaytest.swift
import AppKit
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
var keep: [NSWindow] = []
func box(_ text: String, _ color: NSColor, _ rect: NSRect, hidden: Bool) {
    let w = NSWindow(contentRect: NSRect(x: 200, y: 200, width: 400, height: 400),
                     styleMask: [.borderless], backing: .buffered, defer: false)
    w.level = .floating
    w.collectionBehavior = [.canJoinAllSpaces]
    w.ignoresMouseEvents = true
    w.backgroundColor = color
    let label = NSTextField(labelWithString: text)
    label.font = .boldSystemFont(ofSize: 90)
    label.textColor = .white
    label.alignment = .center
    label.frame = NSRect(x: 0, y: rect.height / 2 - 60, width: rect.width, height: 120)
    w.contentView?.addSubview(label)
    if hidden { w.sharingType = .none }
    w.orderFrontRegardless()
    w.setFrame(rect, display: true)
    keep.append(w)
}
for s in NSScreen.screens {
    let f = s.frame, w = f.width * 0.3, h = f.height * 0.3, y = f.midY - h / 2
    box("A", .systemBlue, NSRect(x: f.minX + f.width * 0.15, y: y, width: w, height: h), hidden: false)
    box("B", .systemRed, NSRect(x: f.minX + f.width * 0.55, y: y, width: w, height: h), hidden: true)
    print(s.localizedName, "- A (blue, left) and B (red, right) placed")
}
RunLoop.current.run(until: Date().addingTimeInterval(10))
