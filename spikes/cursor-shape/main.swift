// Throwaway test for CURSOR-SMOOTHING-PLAN step 1: can a plain helper process
// (like the recording engine: no app bundle, no window) read the system cursor's
// current shape without a permission prompt? Polls for a few seconds, saves each
// distinct shape as a PNG, and prints when the shape changed and what a poll costs.
//
//   swiftc -O main.swift -o cursorshape && ./cursorshape <out-dir> [seconds]
import AppKit
import CryptoKit

let args = CommandLine.arguments
guard args.count >= 2 else { print("usage: cursorshape <out-dir> [seconds]"); exit(1) }
let outDir = URL(fileURLWithPath: args[1])
let seconds = args.count > 2 ? Double(args[2]) ?? 8 : 8
try FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)

var seen: [String: Int] = [:]
var last = ""
var nilPolls = 0, polls = 0
var cost = 0.0
let start = Date()
while Date().timeIntervalSince(start) < seconds {
    let t0 = Date()
    let cursor = NSCursor.currentSystem
    let tiff = cursor?.image.tiffRepresentation
    cost += Date().timeIntervalSince(t0)
    polls += 1
    if let cursor, let tiff {
        let key = SHA256.hash(data: tiff).prefix(6).map { String(format: "%02x", $0) }.joined()
        if seen[key] == nil {
            seen[key] = seen.count
            let png = NSBitmapImageRep(data: tiff)!.representation(using: .png, properties: [:])!
            try png.write(to: outDir.appendingPathComponent("shape-\(seen[key]!).png"))
            let rep = cursor.image.representations.map { "\($0.pixelsWide)x\($0.pixelsHigh)" }.joined(separator: ",")
            print(String(format: "new shape %d: %.0fx%.0f pt, hotspot (%.0f,%.0f), pixel reps %@",
                         seen[key]!, cursor.image.size.width, cursor.image.size.height,
                         cursor.hotSpot.x, cursor.hotSpot.y, rep))
        }
        if key != last {
            print(String(format: "%5.2fs  shape %d", Date().timeIntervalSince(start), seen[key]!))
            last = key
        }
    } else { nilPolls += 1 }
    Thread.sleep(forTimeInterval: 0.05)
}
print(String(format: "polls %d, returned nothing %d, distinct shapes %d, mean cost %.2f ms per poll",
             polls, nilPolls, seen.count, cost / Double(polls) * 1000))
