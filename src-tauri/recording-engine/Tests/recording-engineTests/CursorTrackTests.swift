import AppKit
import XCTest
@testable import recording_engine

// Runs the real sampler for a second with no capture (no Screen Recording
// permission needed) and checks the version-2 sidecar: the "not in the video"
// mark, points_to_pixels, at least one shape with a decodable PNG, and a shape
// event at t = 0. Needs a logged-in GUI session (NSCursor.currentSystem), not
// any cursor movement.
final class CursorTrackTests: XCTestCase {
    func testTrackRecordsShapesAndMark() throws {
        let tracker = CursorTracker(
            mapping: .fixed(originX: 0, originY: 0, scale: 2),
            videoWidth: 3024, videoHeight: 1964,
            pointsToPixels: 2, cursorInVideo: false)
        tracker.start()
        // Anchor after the first shape poll, so the pre-anchor shape has to be
        // carried to t = 0.
        Thread.sleep(forTimeInterval: 0.1)
        tracker.setAnchor(mach: mach_absolute_time(), ptsSeconds: 0)
        Thread.sleep(forTimeInterval: 1.0)
        tracker.stop()

        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("cursor-track-\(UUID().uuidString).json")
        defer { try? FileManager.default.removeItem(at: url) }
        let count = try XCTUnwrap(tracker.writeTrack(to: url))
        XCTAssertGreaterThan(count, 60)

        let json = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        XCTAssertEqual(json["version"] as? Int, 2)
        XCTAssertEqual(json["cursor_in_video"] as? Bool, false)
        XCTAssertEqual(json["points_to_pixels"] as? Double, 2)

        let shapes = try XCTUnwrap(json["shapes"] as? [[String: Any]])
        XCTAssertFalse(shapes.isEmpty)
        for shape in shapes {
            let png = try XCTUnwrap(Data(base64Encoded: try XCTUnwrap(shape["png"] as? String)))
            let rep = try XCTUnwrap(NSBitmapImageRep(data: png))
            let width = try XCTUnwrap(shape["width"] as? Double)
            XCTAssertGreaterThan(width, 0)
            XCTAssertGreaterThan(rep.pixelsWide, Int(width))
            XCTAssertNotNil(shape["hot_x"] as? Double)
            XCTAssertNotNil(shape["hot_y"] as? Double)
        }

        let events = try XCTUnwrap(json["shape_events"] as? [[String: Any]])
        XCTAssertEqual(events.first?["t"] as? Double, 0)
        for e in events {
            let i = try XCTUnwrap(e["shape"] as? Int)
            XCTAssertTrue(shapes.indices.contains(i))
        }
    }
}
