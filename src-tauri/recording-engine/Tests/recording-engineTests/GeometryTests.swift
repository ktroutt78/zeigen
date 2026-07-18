import XCTest
@testable import recording_engine

// Guards the capture-side backing-scale change: capture dimensions and the
// cursor telemetry scale MUST stay in the same coordinate space. If the video
// doubles (2x Retina capture) but the cursor scale is left at 1.0, `video_size`
// doubles while telemetry x/y stay in points, so every zoom focus resolves to
// half its fraction and drifts toward the top-left — a silent failure. These
// tests fail if that coupling breaks.
final class GeometryTests: XCTestCase {

    // The load-bearing invariant: width == round(scale * pointWidth) and
    // likewise for height. captureGeometry returns width/height/scale as one
    // coupled triple, so a caller physically cannot take dims from the backing
    // factor while taking scale from something else.
    func testGeometryLocksScaleToDims() {
        let cases: [(Double, Double, Double)] = [
            (1512, 982, 2.0),                 // 14" MBP "Default" 2x
            (1470, 956, 2.0),                 // 14" MBP alt scaled mode
            (1920, 1080, 1.0),                // external 1x display
            (1800, 1169, 3024.0 / 1800.0),    // "More Space" non-integer HiDPI
        ]
        for (pw, ph, bs) in cases {
            let g = RecordingSession.captureGeometry(
                pointWidth: pw, pointHeight: ph, backingScale: bs)
            XCTAssertEqual(
                g.width, max(2, Int((pw * g.scale).rounded())),
                "width must equal round(scale*pointWidth) — dims and scale diverged")
            XCTAssertEqual(
                g.height, max(2, Int((ph * g.scale).rounded())),
                "height must equal round(scale*pointHeight) — dims and scale diverged")
            XCTAssertEqual(g.scale, bs, accuracy: 1e-9)
        }
    }

    // The concrete win: a 1512x982 logical Retina display captures at its
    // 3024x1964 backing store with scale 2.0. Before the change this produced
    // 1512x982 at scale 1.0 (logical), which is what upscaled non-existent
    // pixels under zoom.
    func testRetina2xCapturesBackingStore() {
        let g = RecordingSession.captureGeometry(
            pointWidth: 1512, pointHeight: 982, backingScale: 2.0)
        XCTAssertEqual(g, RecordingSession.CaptureGeometry(width: 3024, height: 1964, scale: 2.0))
    }

    // A cursor at screen center must land at the video center regardless of
    // backing scale — this is exactly the fraction zoom detection divides by
    // (center_x / video_size.width). Reproduces the .fixed mapping math against
    // the coupled geometry: a divergence here is the "drifts top-left" bug.
    func testCenteredCursorMapsToVideoCenterAtAnyScale() {
        for bs in [1.0, 2.0, 2.52] {
            let pw = 1512.0, ph = 982.0
            let g = RecordingSession.captureGeometry(pointWidth: pw, pointHeight: ph, backingScale: bs)
            // .fixed maps (point - origin) * scale; origin 0 here. A centered
            // cursor must land within half a pixel of the video center. The
            // divergence bug (scale left at 1x while dims double) lands it at a
            // quarter-frame — hundreds of pixels off, caught with huge margin.
            let mappedX = (pw / 2.0) * g.scale
            let mappedY = (ph / 2.0) * g.scale
            XCTAssertLessThanOrEqual(abs(mappedX - Double(g.width) / 2.0), 0.5,
                "centered cursor must map within 0.5px of video center X")
            XCTAssertLessThanOrEqual(abs(mappedY - Double(g.height) / 2.0), 0.5,
                "centered cursor must map within 0.5px of video center Y")
        }
    }

    // A malformed backing scale (<=0, e.g. an unreadable display mode) must fall
    // back to 1x, never zero or invert the dimensions.
    func testNonPositiveScaleFallsBackTo1x() {
        let g = RecordingSession.captureGeometry(
            pointWidth: 1920, pointHeight: 1080, backingScale: 0)
        XCTAssertEqual(g, RecordingSession.CaptureGeometry(width: 1920, height: 1080, scale: 1.0))
    }
}
