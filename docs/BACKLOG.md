# Backlog

Keith's running list of improvements. Fable groups these, proposes an order, and Keith re-ranks. Nothing here is approved for work until it's in a plan Keith has signed off.

## In progress

- Zoom polish, explainable auto-zoom, window capture popups: see `docs/ZOOM-POLISH-AND-CAPTURE-BRIEF.md`.

## Ideas from Cap (2026-11-15)

Seen in Cap while recording the reference clip. Study Cap's approach (AGPLv3: approach only, don't copy code).

- **Export progress.** Show frames done out of total, a circular progress indicator that fills, and an estimated time remaining while exporting.
- **Cursor smoothing.** Let Keith choose how smooth mouse movement looks (Cap has presets plus custom). Related to the zoom work: the camera reacts to the cursor, so whichever smoothing the cursor gets should be consistent with the camera path.
- **Cursor style.** Let Keith pick the cursor icon used in the export.
- **Scene changes on the timeline.** A Scene track (like Cap's, under the Zoom track) where Keith marks stretches of the video to switch layout, with an animated transition each way. The main case: cut from the screen recording to full-screen webcam (talking to camera), then transition back to the screen recording. Also: hide the webcam bubble and bring it back, and switch between full screen and partial screen.
- **Timeline zoom.** Zeigen's timeline always fits the whole recording to the window width (`SegmentTrack.tsx` maps the full duration to the track width), so you can't zoom in. Add zoom-in for precise edits on long recordings, with a one-click "fit whole video" to get back. Cap has a zoom slider next to the timeline. This also helps the "fiddly zoom editing" complaint: on a 6-minute recording a 6px handle covers a lot of time.
- **Auto-zoom on a button.** Cap only adds auto zooms when you press Generate on the Zoom track. Zeigen runs detection automatically when Review opens (`Review.tsx:1304`). Decide together with the auto-zoom reasons work (Problem 2).
