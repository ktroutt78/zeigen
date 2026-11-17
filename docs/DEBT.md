# Debt

Things left worse than we'd like, with why. Newest at top. Remove an entry when it is paid.

## Save to folder: untried and rough (2026-11-17)

- Not run in the app. Untried: a real external drive, unplugging it mid-take or before Save, the move at Stop onto the LaCie, the pending retry, the Settings row and its Move/Leave prompt, and the webview actually playing video and thumbnails from the chosen folder (the runtime asset-scope grant is proven only with `is_allowed` in a unit test).
- No progress is shown while finalize copies a recording to an external drive. The main window is hidden and Review opens only when the copy ends, so a long take on a slow drive looks like a pause after Stop.
- The Move offered on a folder change shows only "Moving N recordings..." and then the result, with no per-recording progress, and only in the Settings view (leaving Settings hides it; the move still runs).
- The pending retry runs whenever the chosen folder is available and is not ~/Movies/Zeigen, not only when it is on another volume. Otherwise a recording waiting for a drive would never move after the setting changes to an internal folder. With no chosen folder, leftover markers are cleared.
- Checking the folder writes and removes a tiny probe file each time the main window gains focus and at Record; on a spun-down drive that wakes it.
- "In use" (skipped by moves) is a Review window or the recording in progress. Between finalize returning and Review's window existing there is a moment where a retry could move the folder Review is about to open; it needs the drive to come back in that moment.
- A recording list can hold old paths for a pending recording until it reloads after `library-changed`; an Open in that moment opens Review on the old, now-moved folder.
- If deleting the original fails after a verified copy, the remains stay in ~/Movies/Zeigen/.recordings without a marker; they show up again only if the setting goes back to the default.

## Compact capture window and hover pickers: untried (2026-11-17)

- Seen only in headless Chrome with stubbed Tauri calls. Not tried in the app: the overlaid title bar (whether the Recordings and Settings icons line up with the traffic lights, and dragging the window by that row), the window growing to fit a long error, and the native selects laid invisibly over the picker line and device rows.
- The display picker and the window picker's hover on every display have not been run on real displays, including the USB InstantView BenQ. Both rely on the cursor poller and on overlays that stay visible to capture.
- Esc cancels a picker through the main window, which stays key while the overlays are up. If the user clicks some other app first, Esc goes there; Cancel or (for windows) a click on empty space still works.
- Hotkey, countdown and length cap are still session-only (they were before this change); only noise reduction and bubble shape persist.
- The "iPhone connected" pill beside the camera is gone; the camera row shows the device name instead.

## Review lighter restyle: loose ends (2026-11-17)

- Looked at only in headless Chrome with the Tauri APIs stubbed and a synthetic test video, not in the real WKWebView window. Not seen there: the webcam bubble, the Bubble panel with a real bubble, the camera shading in zoom blocks, the post-save "Reveal in Finder" line, the GIF export rows, and the Save progress fill.
- At the minimum window width (720) the timeline's trim readout ("In · Out · Length") wraps onto three lines beside the zoom controls.
- Zoom, scene and blur blocks still fill the whole row height with a 5px radius, inside a lane rounded at 9px; a block starting at 0:00 or ending at the end pokes past the lane's corner by a pixel or two.
- The video stage keeps its own dark fill and hairline border inside the preview panel (it is the picture surface, and its border is part of what the overlays measure; left alone to keep preview and export matched).

## Review polish: names, play bar, empty-row hints (2026-11-16)

- Nothing here has been looked at in the app; checked by type check, build, and the sidecar and folder-scan tests.
- Names are built once, at Record. A window whose title changes during the recording keeps its starting title. Recordings made before this have no name and show the date and "Screen Recording" as before.
- Every named recording now gets a sidecar at finalize, and Review no longer treats a sidecar holding only a name as empty. That should keep no-edit screen-only recordings in the list (the first item of the entry below), but it has not been tried.
- The empty-row hint sits in the middle of the lane, and the hover ghost's "+" draws under it when the pointer is near the middle.
- The play bar's strip takes about 40px from the picture. At 1280x860 the picture may now be height-limited and slightly smaller than before; not measured.

## Recordings library grid: what is rough (2026-11-17)

- Seen only in headless Chrome with stubbed Tauri calls and real thumbnails made from the library into a temp dir. Not opened in the app: clicking a card, Rename, Show in Finder, Delete, the hover ring and the "..." fade, and thumbnails filling in live are all untried.
- A thumbnail that ffmpeg cannot make is tried again on every list (each focus). Only a recording whose screen file probes fine but will not give a frame hits this; an unreadable file is skipped because its failed probe is cached.
- Deleting a recording while its thumbnail is being made could race: ffmpeg may write `.thumb-tmp.jpg` into the folder as it is removed, and the delete then fails with "directory not empty". The window is a fraction of a second, once per recording.
- If the background fill-in finishes before the list call returns, the list overwrites that update and the thumbnail shows only after the next focus.
- Thumbnails are letterboxed (contain) on the canvas colour, so tall window and area recordings get wide dark side bars. Cover cropped too much of those; not tuned per shape.
- The menu opens below the "..." button and is not flipped near the bottom of the window; it scrolls with the grid.
- Search filters by name only, and the header count and size are for the whole library, not the filtered view.

## Recordings window: rough edges (2026-11-16)

- A recording whose edit state is "logically empty" has no sidecar (Review deletes it), and the list skips folders without one. A screen-only display recording with no edits would vanish from the list. None of the nine kept recordings is affected today; it matters once step 2 puts every new recording in the library. Fix: list folders by their screen file and treat a missing sidecar as defaults, or stop Review deleting an empty sidecar for kept recordings.
- Discarding a reopened recording, or saving from it, sends the same `recording-discarded` / `recording-committed` events a fresh recording does, so the main window's status strip clears or updates even when it was showing a different recording.
- The window learns "recording in progress" from engine `started` / `stopped` / `error` events. A pre-warm's start and stop briefly disable Open; if the window opens mid-recording it shows Open enabled (the main window still refuses the request unless idle).
- Nobody has opened a recording through the window yet; it was checked by type check, the folder-scan test, and a read-only listing of the real library.

## Native webcam recorder: what is rough (2026-11-16)

- The recorder's stderr (errors and its frames/duplicated/dropped line) goes to the app's stderr, which is nowhere for a Dock launch.
- The engine's `first_frame` now fires when the writer starts (screen.mp4's time zero) rather than on the first screen frame, which can be earlier when the mic is slow to start. The bubble position log is anchored on it, so that anchor moved too, in the direction of screen.mp4's time zero.

## Scene layouts: what is approximate or untested (2026-11-16)

- Preview and export take every position, size, corner and fade from the same layout path, but the shadows are drawn by different engines (CSS box-shadow against a Core Image blur), so their softness is close, not identical. The default bubble's shadow also falls to the other side in the preview when a recording has no scenes (the mirror flips it); with scenes it matches the export.
- The watermark is drawn on the screen picture, so it disappears with the screen during a full-webcam scene.
- Lip-sync in a full-webcam export: the export shows webcam frame N on output frame N. Recordings made with ffmpeg could have a 0.1s gap in the webcam file, after which the export's webcam runs about two frames (0.07s) early. New recordings write the webcam on a fixed 30 fps grid (a gap is filled with the previous frame), so frame N is always at N/30; older recordings keep the problem. Not judged by eye yet.
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
