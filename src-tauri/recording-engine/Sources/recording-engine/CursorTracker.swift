import AppKit
import CoreGraphics
import CryptoKit
import Foundation

// V3 Phase A cursor telemetry. Samples the cursor position at 120 Hz via
// CGEvent(source: nil) and detects clicks/scrolls by polling
// CGEventSourceCounterForEventType deltas on the same tick.
//
// Why polling and not an observer (deviation from V3-PLAN A.1, which
// specified NSEvent.addGlobalMonitorForEvents): on macOS 26 global mouse
// monitors install successfully but silently deliver nothing unless the
// process has the Input Monitoring TCC permission (verified empirically —
// a real click produced zero monitor callbacks while
// IOHIDCheckAccess(kIOHIDRequestTypeListenEvent) returned denied). The
// plan's hard constraint was "no new permission prompts"; the monitor
// can't honor it, so it's gone. CGEventSource counters and
// CGEvent(source: nil) are the same permission-free session-state family,
// and counter deltas catch even clicks shorter than one tick. Cost: click
// timestamps quantize to the 120 Hz tick (±8.3 ms, well inside the A.5
// one-frame/33 ms gate) and scroll events carry no dy magnitude — Phase C
// only needs "scrolling is happening here" to hold zoom, not the delta.
// A CGEventTap remains off the table (Accessibility permission).
//
// Timing (V3-PLAN A.2): every sample and event is stamped with
// mach_absolute_time(). RecordingSession provides one anchor pair — the
// mach time and output-timeline PTS of the first video frame AVAssetWriter
// accepted — and every timestamp becomes
// `machSeconds(sample) - machSeconds(anchor) + anchor_pts` at write time.
// Pause mirrors the writer's handling: samples during pause are skipped and
// the cumulative paused duration is subtracted, the same offset append()
// applies to sample-buffer PTS, so telemetry stays on the gapless output
// timeline. Pause can never precede the anchor (D-06 rejects pause before
// writer-start), so the anchor itself needs no pause correction.
//
// Coordinates are stored in video pixel space: display/area capture maps
// through the fixed origin offset + points-to-pixels scale the session
// computes at init; window capture maps through the window's current frame
// (cached at 10 Hz — CGWindowListCopyWindowInfo is ~1ms, too costly per
// 120 Hz tick) into the pixel size fixed at session start. If the window is
// resized mid-record SCK letterboxes the content, and this proportional
// mapping tracks that only approximately — same limitation as the bubble
// keyframe math.
//
// Cursor shape (CURSOR-SMOOTHING-PLAN step 2): the capture no longer burns
// the cursor into the pixels, so the export draws it from this log, which
// therefore also records what the cursor looked like. Every 6th tick (20 Hz)
// the sampler reads NSCursor.currentSystem (no permission prompt; ~2 ms) and
// hashes its TIFF data; each distinct shape is kept once as PNG and every
// change is logged with the same timestamp treatment as mouse events. The
// poll runs on the sampler queue, NOT the main queue: main.swift's main
// thread sits blocked in readLine() for the whole recording, so main-queue
// work would never run. currentSystem was verified to return live shapes
// when called off the main thread of a CLI process.
final class CursorTracker: @unchecked Sendable {
    enum Mapping {
        case fixed(originX: Double, originY: Double, scale: Double)
        case window(windowID: UInt32, pixelWidth: Int, pixelHeight: Int)
    }

    private struct Sample {
        let mach: UInt64
        let pausedTicks: UInt64
        let x: Double
        let y: Double
    }

    private struct MouseEvent {
        let mach: UInt64
        let pausedTicks: UInt64
        let kind: String
        let x: Double
        let y: Double
    }

    // One distinct cursor image. Sizes and hotspot are in screen points;
    // the hotspot is measured from the image's top-left.
    private struct Shape {
        let png: Data
        let width: Double
        let height: Double
        let hotX: Double
        let hotY: Double
    }

    private struct ShapeEvent {
        let mach: UInt64
        let pausedTicks: UInt64
        let shape: Int
    }

    static let sampleRateHz = 120

    // Event kinds detected per tick, via session counter deltas.
    private static let counterKinds: [(CGEventType, String)] = [
        (.leftMouseDown, "left_down"),
        (.leftMouseUp, "left_up"),
        (.rightMouseDown, "right_down"),
        (.scrollWheel, "scroll"),
    ]

    private let mapping: Mapping
    private let videoWidth: Int
    private let videoHeight: Int
    private let pointsToPixels: Double
    private let cursorInVideo: Bool

    private let lock = NSLock()
    private var samples: [Sample] = []
    private var events: [MouseEvent] = []
    private var anchorMach: UInt64?
    private var anchorPTS: Double = 0
    private var anchorSet = false
    private var paused = false
    private var pausedCumTicks: UInt64 = 0
    private var pauseStartMach: UInt64?
    private var cachedWindowFrame: CGRect?
    private var stopped = false
    private var shapes: [Shape] = []
    private var shapeEvents: [ShapeEvent] = []

    private var timer: DispatchSourceTimer?
    // Sampler-queue-only state.
    private var tick = 0
    private var lastCounts: [UInt32]
    private var shapeIndexByHash: [SHA256Digest: Int] = [:]
    // Shape seen by the latest poll, and the shape the last logged event
    // carries. Kept apart so a change while paused is logged on resume.
    private var currentShape: Int?
    private var loggedShape: Int?

    private static let timebase: mach_timebase_info_data_t = {
        var tb = mach_timebase_info_data_t()
        mach_timebase_info(&tb)
        return tb
    }()

    private static func machToSeconds(_ ticks: Double) -> Double {
        ticks * Double(timebase.numer) / Double(timebase.denom) / 1_000_000_000
    }

    // pointsToPixels converts screen points to video pixels (sizes the
    // cursor at export). cursorInVideo records whether the capture burns
    // the system cursor into the pixels.
    init(mapping: Mapping, videoWidth: Int, videoHeight: Int, pointsToPixels: Double, cursorInVideo: Bool) {
        self.mapping = mapping
        self.videoWidth = videoWidth
        self.videoHeight = videoHeight
        self.pointsToPixels = pointsToPixels
        self.cursorInVideo = cursorInVideo
        self.lastCounts = Self.counterKinds.map {
            CGEventSource.counterForEventType(.combinedSessionState, eventType: $0.0)
        }
        if case .window(let wid, _, _) = mapping {
            cachedWindowFrame = Self.queryWindowFrame(wid)
        }
    }

    // Set exactly once by RecordingSession when AVAssetWriter accepts the
    // first video frame. ptsSeconds is that frame's position on the output
    // timeline (adjustedPTS - sessionStartPTS).
    func setAnchor(mach: UInt64, ptsSeconds: Double) {
        lock.withLock {
            guard !anchorSet else { return }
            anchorSet = true
            anchorMach = mach
            anchorPTS = ptsSeconds
        }
    }

    func start() {
        let t = DispatchSource.makeTimerSource(queue: DispatchQueue(label: "engine.cursor"))
        t.schedule(deadline: .now(), repeating: 1.0 / Double(Self.sampleRateHz), leeway: .milliseconds(1))
        t.setEventHandler { [weak self] in self?.sampleTick() }
        t.resume()
        timer = t
    }

    func pause() {
        lock.withLock {
            guard !paused else { return }
            paused = true
            pauseStartMach = mach_absolute_time()
        }
    }

    func resume() {
        lock.withLock {
            guard paused else { return }
            paused = false
            if let s = pauseStartMach {
                pausedCumTicks += mach_absolute_time() - s
                pauseStartMach = nil
            }
        }
    }

    func stop() {
        timer?.cancel()
        timer = nil
        lock.withLock { stopped = true }
    }

    private func sampleTick() {
        guard let loc = CGEvent(source: nil)?.location else { return }
        let now = mach_absolute_time()

        // Counter deltas since the previous tick. Read before the
        // paused/stopped check so pauses don't replay clicks accumulated
        // while paused on the first tick after resume.
        var fired: [String] = []
        for (i, kind) in Self.counterKinds.enumerated() {
            let count = CGEventSource.counterForEventType(.combinedSessionState, eventType: kind.0)
            if count != lastCounts[i] {
                lastCounts[i] = count
                fired.append(kind.1)
            }
        }

        tick += 1
        if case .window(let wid, _, _) = mapping, tick % 12 == 1 {
            let f = Self.queryWindowFrame(wid)
            if let f { lock.withLock { cachedWindowFrame = f } }
        }
        if tick % 6 == 1 {
            pollShape()
        }

        lock.withLock {
            if stopped || paused { return }
            let (x, y) = mapLocked(loc)
            samples.append(Sample(mach: now, pausedTicks: pausedCumTicks, x: x, y: y))
            for kind in fired {
                events.append(MouseEvent(mach: now, pausedTicks: pausedCumTicks, kind: kind, x: x, y: y))
            }
            if let shape = currentShape, shape != loggedShape {
                loggedShape = shape
                shapeEvents.append(ShapeEvent(mach: now, pausedTicks: pausedCumTicks, shape: shape))
            }
        }
    }

    // Sampler-queue only. Updates currentShape, registering the image the
    // first time it is seen.
    private func pollShape() {
        guard let cursor = NSCursor.currentSystem,
              let tiff = cursor.image.tiffRepresentation
        else { return }
        let hash = SHA256.hash(data: tiff)
        if let index = shapeIndexByHash[hash] {
            currentShape = index
            return
        }
        let size = cursor.image.size
        guard let png = Self.pngForExport(tiff: tiff, pointWidth: Double(size.width)) else { return }
        let shape = Shape(
            png: png,
            width: Double(size.width), height: Double(size.height),
            hotX: Double(cursor.hotSpot.x), hotY: Double(cursor.hotSpot.y))
        let index = lock.withLock {
            shapes.append(shape)
            return shapes.count - 1
        }
        shapeIndexByHash[hash] = index
        currentShape = index
    }

    // PNG of the one pixel representation whose width is nearest 4x the
    // point width (ties go to the larger); the largest if the point width
    // is unknown.
    static func pngForExport(tiff: Data, pointWidth: Double) -> Data? {
        let reps = NSBitmapImageRep.imageReps(with: tiff).compactMap { $0 as? NSBitmapImageRep }
        let target = pointWidth > 0 ? 4 * pointWidth : .infinity
        let best = reps.min { a, b in
            let da = abs(Double(a.pixelsWide) - target), db = abs(Double(b.pixelsWide) - target)
            return da != db ? da < db : a.pixelsWide > b.pixelsWide
        }
        return best?.representation(using: .png, properties: [:])
    }

    // Caller must hold `lock` (reads cachedWindowFrame).
    private func mapLocked(_ p: CGPoint) -> (Double, Double) {
        switch mapping {
        case .fixed(let ox, let oy, let scale):
            return ((Double(p.x) - ox) * scale, (Double(p.y) - oy) * scale)
        case .window(_, let pw, let ph):
            guard let f = cachedWindowFrame, f.width > 0, f.height > 0 else {
                return (Double(p.x), Double(p.y))
            }
            return (
                (Double(p.x) - Double(f.minX)) / Double(f.width) * Double(pw),
                (Double(p.y) - Double(f.minY)) / Double(f.height) * Double(ph)
            )
        }
    }

    private static func queryWindowFrame(_ windowID: UInt32) -> CGRect? {
        guard let raw = CGWindowListCopyWindowInfo([.optionIncludingWindow], windowID) as? [[String: Any]],
              let entry = raw.first,
              let boundsDict = entry[kCGWindowBounds as String] as? NSDictionary,
              let bounds = CGRect(dictionaryRepresentation: boundsDict)
        else { return nil }
        return bounds
    }

    // Writes the telemetry sidecar (V3-PLAN A.3). Returns the number of
    // samples written, or nil when no video frame was ever written — no
    // anchor means nothing to align against, so no file is produced.
    // Samples/events that precede the first video frame (negative t) are
    // dropped: they have no corresponding video content. Shape events are
    // the exception: the last one before the first frame moves to t = 0.
    // Version 2 adds cursor_in_video, points_to_pixels, shapes and
    // shape_events; the version-1 fields are unchanged.
    func writeTrack(to url: URL) throws -> Int? {
        let (anchor, pts, snapSamples, snapEvents, snapShapes, snapShapeEvents):
            (UInt64?, Double, [Sample], [MouseEvent], [Shape], [ShapeEvent]) =
            lock.withLock { (anchorMach, anchorPTS, samples, events, shapes, shapeEvents) }
        guard let anchor else { return nil }
        let anchorSec = Self.machToSeconds(Double(anchor))

        func timelineT(_ mach: UInt64, _ pausedTicks: UInt64) -> Double {
            Self.machToSeconds(Double(mach) - Double(pausedTicks)) - anchorSec + pts
        }

        var lines: [String] = []
        lines.append("{")
        lines.append("\"version\":2,")
        lines.append("\"cursor_in_video\":\(cursorInVideo),")
        lines.append("\"points_to_pixels\":\(String(format: "%.6f", pointsToPixels)),")
        lines.append("\"anchor\":{\"first_frame_pts\":\(String(format: "%.6f", pts)),\"first_frame_mach\":\(anchor)},")
        lines.append("\"video_size\":{\"width\":\(videoWidth),\"height\":\(videoHeight)},")
        lines.append("\"sample_rate_hz\":\(Self.sampleRateHz),")

        var sampleLines: [String] = []
        for s in snapSamples {
            let t = timelineT(s.mach, s.pausedTicks)
            if t < 0 { continue }
            sampleLines.append(String(format: "{\"t\":%.4f,\"x\":%.1f,\"y\":%.1f}", t, s.x, s.y))
        }
        lines.append("\"samples\":[\(sampleLines.joined(separator: ","))],")

        var eventLines: [String] = []
        for e in snapEvents {
            let t = timelineT(e.mach, e.pausedTicks)
            if t < 0 { continue }
            eventLines.append(String(
                format: "{\"t\":%.4f,\"kind\":\"%@\",\"x\":%.1f,\"y\":%.1f}",
                t, e.kind, e.x, e.y))
        }
        lines.append("\"events\":[\(eventLines.joined(separator: ","))],")

        let shapeLines = snapShapes.map {
            String(format: "{\"png\":\"%@\",\"width\":%.2f,\"height\":%.2f,\"hot_x\":%.2f,\"hot_y\":%.2f}",
                   $0.png.base64EncodedString(), $0.width, $0.height, $0.hotX, $0.hotY)
        }
        lines.append("\"shapes\":[\(shapeLines.joined(separator: ","))],")

        // The shape in effect at the first video frame must be known, so the
        // list always opens at t = 0 with the latest shape logged at or
        // before it (or, failing that, the first one logged after it).
        var timedShapes = snapShapeEvents.map { (t: timelineT($0.mach, $0.pausedTicks), shape: $0.shape) }
        if let lastBefore = timedShapes.lastIndex(where: { $0.t <= 0 }) {
            timedShapes.removeFirst(lastBefore)
        }
        if !timedShapes.isEmpty { timedShapes[0].t = 0 }
        let shapeEventLines = timedShapes.map {
            String(format: "{\"t\":%.4f,\"shape\":%d}", $0.t, $0.shape)
        }
        lines.append("\"shape_events\":[\(shapeEventLines.joined(separator: ","))]")
        lines.append("}")

        let data = lines.joined(separator: "\n").data(using: .utf8) ?? Data()
        try data.write(to: url, options: .atomic)
        return sampleLines.count
    }
}
