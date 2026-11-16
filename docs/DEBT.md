# Debt

Things left worse than we'd like, with why. Newest at top. Remove an entry when it is paid.

## Scene layouts: what is approximate or untested (2026-11-16)

- Preview and export take every position, size, corner and fade from the same layout path, but the shadows are drawn by different engines (CSS box-shadow against a Core Image blur), so their softness is close, not identical. The default bubble's shadow also falls to the other side in the preview when a recording has no scenes (the mirror flips it); with scenes it matches the export.
- The watermark is drawn on the screen picture, so it disappears with the screen during a full-webcam scene.
- Lip-sync in a full-webcam export: the export shows webcam frame N on output frame N. Both are 30 frames a second with the same frame count in the four recordings checked, so it holds, but two of the four had one 0.1s gap in the webcam file, after which the export's webcam runs about two frames (0.07s) early. Matching by time instead of by count would remove that. Not judged by eye yet.
- For window recordings the export scales the screen's corner with the zoom and the preview does not (older than the scene work).
- Nobody has compared preview and export side by side for a scene yet; the export was checked by frames from a real recording, the preview only by type check and reading.

## Timeline: bubble during hover, and the waveform at high zoom (2026-11-16)

While the preview shows a hovered moment the webcam bubble stays on the playhead's moment (aligning it on every hover seek was the cost the scrub bracket exists to avoid). The waveform keeps 4096 peak buckets and a canvas capped at 8192px, so on a long recording zoomed far in it looks blocky. I cannot operate the Review window, so each timeline step is first exercised by Keith on the installed build.

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
