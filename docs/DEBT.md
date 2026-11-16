# Debt

Things left worse than we'd like, with why. Newest at top. Remove an entry when it is paid.

## Timeline steps 0 to 2 have never been driven by me (2026-11-16)

The timeline rework (own files, labelled rows, hover preview) passes the type check and build, and the formulas were read line by line, but I cannot operate the Review window, so drag, resize, hover and click behaviour were first exercised by Keith on the installed build. Known soft spots to watch: after a click parks the playhead while the mouse stays on the timeline, the webcam bubble shows the hovered moment until the mouse leaves; `Waveform.tsx` still maps time across its canvas itself, which timeline zoom (step 3) has to bring under the scale.

## Resting-cursor rule misjudges "read, then rest a long time, then leave" (2026-11-15)

Auto-zoom rule 1 decides whether a pause with no click is reading or a resting hand from how much of the time between the cursor's first and last movement it was moving. If you trace along a row for a few seconds, leave the cursor there for a long while, and then move it away while still inside the same small area, the long rest counts against the reading and the zoom is dropped. Reading and then resting until the cursor leaves the area quickly is fine. The tidier design is to split a pause into moving stretches and judge each; not done because no marked clip needs it.

## Dragging the window during a window recording wobbles; crossing displays is rough (2026-11-15)

Window recordings now capture the window's app on its display, cropped to the window, so the app's menus and dialogs are in the picture. The crop is kept on the window by checking its position (about 30 times a second, about 120 while it is moving). The crop can only move after the window has, so while the window is dragged it shakes inside the frame: an empty strip of up to 13px at the trailing edge that varies frame to frame (19px before the faster check). Dragging onto another display gives about a second of badly framed picture during the crossing (empty areas up to 460px measured), and if macOS resizes the window to fit the new display the picture is letterboxed for the rest of the recording. A window that is not moved is unaffected. The old single-window capture followed a dragged window perfectly but had no popups. Accepted by Keith 2026-11-15: he rarely drags a window while recording. Fix idea is on the backlog ("Clean window drag while recording").

## The poster frame has no cursor (2026-11-15)

New recordings have no cursor in the raw video. The preview and every export draw one; the embedded poster frame is taken from the raw video and does not. Left out on purpose in `docs/CURSOR-SMOOTHING-PLAN.md`. (The scrub thumbnails that shared this problem were removed 2026-11-16.)

## Cursor shape logging costs 3 to 4% of a core while recording (2026-11-15)

While recording, the engine reads and hashes the system cursor image about 20 times a second (`CursorTracker.swift`). Measured standalone three times at 3.2 to 4.2% of one core (`spikes/capture-load`), with no change in WindowServer's load. Not measured inside a real recording. If it ever matters, compare something cheaper than a hash of the full image.

## Detector still forces a 1.2s gap between zooms (2026-11-15)

`zoom.rs` still clips suggestions so they sit at least 1.2s apart (`MERGE_GAP_S`). The camera now joins zooms within 2.5s with a pan, so the forced gap is pointless but harmless. Left alone because detector behaviour is frozen until the reference clips are marked up.

## Motion blur is export-only (2026-11-15)

The exported video smears moving camera frames; the Review preview does not. The camera path itself (timing, framing) is identical in both. Reason: the preview is a CSS transform on a `<video>` element and cannot do a directional or radial smear cheaply; matching it would mean rebuilding the preview on a different drawing technology for a ~0.7s effect. Accepted by Keith 2026-11-15 (`docs/DECISIONS.md`). Violates the standing rule "preview and export must match" for this one effect.
