# Debt

Things left worse than we'd like, with why. Newest at top. Remove an entry when it is paid.

## Click and scroll times in the cursor log land on half-second steps (2026-11-15)

The engine checks for clicks 120 times a second (`CursorTracker.swift`) and its comments promise click times good to about 8ms. The logs say otherwise: in every recording checked (five, including both `harness/reference` sources and zoom-rules clip 1) every click time sits on a half-second grid with a per-recording offset (clip 1: all at x.40 or x.90). So a logged click can be up to half a second late, a quick click's press and release share one time, and the logged position is where the cursor was at the grid moment, not at the click. Cursor position samples are fine (every ~8ms). Cause not established; the likely suspect is that the macOS click counters the engine reads only update twice a second. Found while marking the reference clips; left alone so the three clips are recorded the same way. Look at it before the first detector rule change, because the detector's click and drag timing is built on these numbers.

## Dragging the window during a window recording wobbles; crossing displays is rough (2026-11-15)

Window recordings now capture the window's app on its display, cropped to the window, so the app's menus and dialogs are in the picture. The crop is kept on the window by checking its position (about 30 times a second, about 120 while it is moving). The crop can only move after the window has, so while the window is dragged it shakes inside the frame: an empty strip of up to 13px at the trailing edge that varies frame to frame (19px before the faster check). Dragging onto another display gives about a second of badly framed picture during the crossing (empty areas up to 460px measured), and if macOS resizes the window to fit the new display the picture is letterboxed for the rest of the recording. A window that is not moved is unaffected. The old single-window capture followed a dragged window perfectly but had no popups. Accepted by Keith 2026-11-15: he rarely drags a window while recording. Fix idea is on the backlog ("Clean window drag while recording").

## Zoom lane shading no longer matches the real motion (2026-11-15)

The timeline's zoom segments still shade 0.6s "ramp" shoulders at each end. The real motion is now the spring glide (about 0.7s, released before the segment end), zooms within 2.5s of each other are joined by a pan with no zoom-out at all, and the camera re-aims inside a segment. None of that is drawn on the lane. Belongs with the backlog item "Zoom gets its own timeline row".

## Scrub thumbnails and the poster frame have no cursor (2026-11-15)

New recordings have no cursor in the raw video. The preview and every export draw one; the timeline scrub thumbnails and the embedded poster frame are taken from the raw video and do not. Left out on purpose in `docs/CURSOR-SMOOTHING-PLAN.md`.

## Cursor shape logging costs 3 to 4% of a core while recording (2026-11-15)

While recording, the engine reads and hashes the system cursor image about 20 times a second (`CursorTracker.swift`). Measured standalone three times at 3.2 to 4.2% of one core (`spikes/capture-load`), with no change in WindowServer's load. Not measured inside a real recording. If it ever matters, compare something cheaper than a hash of the full image.

## Detector still forces a 1.2s gap between zooms (2026-11-15)

`zoom.rs` still clips suggestions so they sit at least 1.2s apart (`MERGE_GAP_S`). The camera now joins zooms within 2.5s with a pan, so the forced gap is pointless but harmless. Left alone because detector behaviour is frozen until the reference clips are marked up.

## Motion blur is export-only (2026-11-15)

The exported video smears moving camera frames; the Review preview does not. The camera path itself (timing, framing) is identical in both. Reason: the preview is a CSS transform on a `<video>` element and cannot do a directional or radial smear cheaply; matching it would mean rebuilding the preview on a different drawing technology for a ~0.7s effect. Accepted by Keith 2026-11-15 (`docs/DECISIONS.md`). Violates the standing rule "preview and export must match" for this one effect.
