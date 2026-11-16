# Plan: timeline rework + Scene track

Answers `docs/TIMELINE-BRIEF.md`. Written 2026-11-16 for Keith's yes or no. No code has been written.

## Summary

- The timeline becomes fixed, labelled rows (Video, Zoom, Scene, and Blur when a recording has redactions), all the same style, with one playhead through all of them.
- Hovering shows that moment in the big preview without moving the playhead. A click sets the playhead.
- A zoom slider and a Fit button spread the timeline out for precise edits.
- Hovering an empty part of the Zoom or Scene row shows a dashed ghost with a "+"; a click adds a segment there.
- A Scene row switches layout (no bubble, split screen, full webcam, full screen recording) with an animated move each way.
- No "Add track" button. The bubble can shrink during zooms, off until you turn it up.

Seven decisions at the end need your answer.

## What I found

### What Cap does in your recording

- Hovering anywhere on the timeline draws a thin grey line at the mouse and the preview shows that moment. The time readout and the red playhead do not move. A click moves the playhead there.
- Rows are the same height with an icon and name on the left. Hovering a row's name shows a small trash button for that row.
- Segments are full-height blocks with a darker bar on the left edge, a name and a value ("Automatic Zoom 1.5x", "Scene Default").
- Hovering an empty stretch of the Zoom or Scene row shows a dashed ghost segment with a "+" that follows the mouse.
- The recording never shows the zoom slider being used, or the list of Scene layouts. Those parts of this plan are my design, not a study of Cap.

### Why moving around feels finicky today

The timeline already scrubs on hover. The trouble is how.

1. **The playhead itself follows the mouse** (`Review.tsx:4320-4348`). You cannot park the playhead and then move the mouse across the timeline to reach something, because crossing the timeline drags the playhead along. Where it ends up is wherever the mouse happened to leave. "Set to playhead" then reads that accidental spot.
2. **Hover does nothing while the video is playing** (`Review.tsx:4328-4333`).
3. **Only the 44px waveform strip accepts a click to set the playhead.** A click on the zoom lane adds a zoom instead (`SegmentTrack.tsx:90-117`), and a drag there does nothing.
4. **Zoom segments are hard to grab.** Only the small text pill in the middle can be dragged (`SegmentTrack.tsx:266-295`). The rest of the segment ignores the mouse. The edge handles are 6px wide, appear only after the segment is selected, and sit just outside the segment's edge (`SegmentTrack.tsx:296-301, 326-340`).
5. **The playhead line redraws only a few times a second during playback** (`Review.tsx:2018-2021`, it waits for the video's own progress event), so it steps along instead of gliding.
6. **Two previews at once.** While the big preview scrubs, a small thumbnail also pops up above the timeline (`Review.tsx:4719-4726`, `ScrubPreview.tsx`). The thumbnail is coarser, and it has no cursor in it (already in `docs/DEBT.md`).

Ruled out: slow seeking caused by the recording's sparse keyframes. Keyframes are up to 5.7 seconds apart in your latest recording, but the screen is recorded only when it changes, so there are just 32 frames in that gap, and a seek far from a keyframe timed the same as one right on it (about 0.15s each including program start-up, measured with ffmpeg). I could not time seeks inside the app's own video player.

### How the timeline is built today

- The whole timeline is one function inside `Review.tsx` (`4205-4729`), a 6,500-line file.
- Every row works out "where is time T on screen" for itself, as a percentage of the full width, in about ten places. That is why the timeline can only ever fit the whole recording: there is no single place that knows the scale.
- The redaction lane has its own separate look and its own collapse behaviour (`Review.tsx:4641-4717`).
- The zoom shading on the lane is the old 0.6s ramp, not the real camera motion (`SegmentTrack.tsx:125-132`, `docs/DEBT.md`).

### What Scene has to build on

- Preview: the screen video is moved and scaled by the camera path each frame (`Review.tsx:174`, `2968`), and the webcam is a second video drawn as the bubble (`BubbleLayer`, `Review.tsx:3330`).
- Export: cicompositor draws the screen, then the bubble, in `compositor-engine/main.swift` (`1036-1061`).
- The webcam is saved as its own file, 1280x720 at 30 frames a second. That is what makes full webcam and split screen possible after recording. It also means full webcam at a 1080p export is enlarged 1.5 times, so it will be softer than the screen recording.
- The export pulls one webcam frame per screen frame and its own comment says that is a known gap (`main.swift:448-452`). In a small bubble nobody notices lip-sync being slightly off. Full screen, you would.

## Approach

### Step 0: give the timeline its own files and one scale

Move the timeline out of `Review.tsx` into `src/timeline/`, and replace the ten separate percentage calculations with one scale that converts time to position and back. Nothing looks different after this step. Everything else depends on it: timeline zoom is impossible without it, and rows that share one playhead are much simpler with it.

- Files: new `src/timeline/Timeline.tsx`, `scale.ts`, `Row.tsx`, `Segment.tsx`; `Review.tsx` loses about 600 lines; `SegmentTrack.tsx` is replaced.
- Who: implementer, from a written spec. I review the diff.
- Your check: nothing to judge. I confirm trimming, zoom editing and redaction timing behave as before.

### Step 1: real rows (brief item 2)

- Video, Zoom and Scene rows, each with an icon and label on the left, the same height and background, one playhead and one hover line through all of them. A time ruler across the top.
- A Blur row appears only when the recording has redactions, in the same style as the others. It replaces the separate collapsible redaction lane.
- A zoom segment is a full-height block showing its reason and scale ("pause + 2 clicks 1.7x", or "Zoom 1.5x" for one you added). The whole block drags. Edge handles are 12px, inside the segment's edges, and always grabbable without selecting first.
- The shading inside a zoom segment is drawn from the real camera path, so you see the glide in, the hold, and joined zooms staying zoomed. This pays the "zoom lane shading" entry in `docs/DEBT.md`.
- The Video row keeps the waveform and the trim handles.
- Who: implementer builds the rows and segments. I do the camera-path shading, since it reads the path the preview and export share.
- Your check: open any recording with a few auto zooms. Each zoom should be readable at a glance, and you should be able to grab an edge on the first try.

### Step 2: hover to preview, click to set (brief item 1)

- Hover anywhere on any row: a hover line follows the mouse and the big preview shows that moment. The playhead and the time readout stay where they are.
- Mouse leaves the timeline: the preview returns to the playhead.
- Click anywhere that is not a segment: the playhead moves there. Dragging still scrubs.
- The playhead line glides during playback (redrawn every frame).
- The small thumbnail popup goes away, along with the thumbnail strip it builds each time Review opens, if nothing else turns out to need it. The big preview does that job, with the cursor in it.
- While dragging a segment or one of its edges, the big preview shows the frame at the edge you are moving.
- Files: `src/timeline/`, `Review.tsx` (the playhead becomes its own value, separate from where the video happens to be showing), delete `ScrubPreview.tsx` and possibly `thumbs.rs`.
- Who: me. Separating "where the playhead is" from "what the preview is showing" touches webcam sync, the loop preview and "Set to playhead", and is easy to get subtly wrong.
- Your check: park the playhead, sweep the mouse across the timeline and off it. The preview should follow the mouse and then return; the playhead should not have moved. Then click once and it should jump.

### Step 3: zoom in on the timeline (brief item 3)

- A slider with minus and plus magnifiers by the playback controls, and a Fit button that returns to the whole recording.
- Pinch, or Cmd plus scroll, zooms around the mouse position. Two-finger sideways scroll pans.
- During playback the view follows the playhead when it reaches the edge.
- Row labels stay fixed on the left while the tracks scroll.
- Who: implementer. I review.
- Your check: on a recording of a minute or more, zoom in until one second is about a thumb-width wide, nudge a zoom's edge by a fraction of a second, press Fit.

### Step 4: hover to add, and the Generate button (brief item 4)

- Hovering an empty part of the Zoom or Scene row shows a dashed ghost with a "+" at the default length, trimmed to fit the gap. A click adds it. No ghost appears where there is no room.
- This replaces "click the lane to add" and the "Click to add a zoom" strip.
- Auto-zoom on a button: detection still runs when Review opens, as now. The Zoom row's label gets a small Generate button that re-runs it, replacing only automatic zooms and never ones you placed or edited, plus a trash button that clears the row, as in Cap. Changing detection to run only when you press the button would change your workflow, so I have left that alone.
- Who: implementer. I review.
- Your check: hover the Zoom row between two zooms, click, and a zoom appears where the ghost was.

### Step 5: Scene row (brief item 5)

**The layouts.** A scene segment marks a stretch of the video with one of four layouts. Anything not covered by a segment is the default (screen with bubble), so there is no "Default" segment to place.

| Layout | What you see |
|---|---|
| No bubble | The screen as usual, bubble faded out |
| Split screen | Screen on the left, webcam as a tall rounded card on the right, over the Frame background |
| Full webcam | The webcam fills the picture |
| Full screen recording | The screen fills the picture edge to edge, no bubble, no Frame padding |

**How it is defined once.** The same pattern as the camera path. A new Rust module takes the scene segments and produces a sampled "layout path": for every 1/60s, where the screen picture sits, where the webcam picture sits, how round its corners are, and how visible each is. The preview and cicompositor both only look that path up. Neither contains any layout or transition maths, so they cannot drift apart. The transition is the same spring the zoom uses, about half a second: going to full webcam, the bubble grows from its corner to fill the picture, and shrinks back afterwards.

**Scene against Zoom: the rule I propose.** The Scene row decides where the screen picture and the webcam picture sit. The Zoom row decides what part of the screen recording shows inside the screen picture. They never fight, and there is no special case:

- Zoom during split screen: the left-hand screen picture zooms, the webcam card does not.
- Zoom during full webcam: the zoom keeps running out of sight. When the scene ends, the screen comes back already where the zoom says it should be.
- The Zoom row dims the part of a zoom that is hidden under a full-webcam scene, so you can see it has no visible effect there.

**Bubble shrinks during zooms (brief item 7).** Worth doing, as part of this step, because the layout path already says how big the bubble is at every moment. Feeding it the camera's zoom level makes the bubble shrink exactly in time with the zoom, in both preview and export, for very little extra work. One slider in the Bubble panel, "Size during zoom", from 100% (no change) down to 50%. I propose it starts at 100% so nothing changes until you move it; you pick the default after watching it.

**Other details.**
- The Scene row is hidden for recordings with no webcam.
- Selecting a scene segment shows its layout choice in the side panel.
- Scenes are saved in the same sidecar file as zooms and redactions.
- Lip-sync: before full webcam ships I will measure webcam sync in an export against the preview, and if the known gap shows, change the export to match webcam frames by time instead of by count.

**Files:** new `src-tauri/src/scene.rs`; `edit.rs` (sidecar and export wiring); `compositor-engine/main.swift` (draw screen and webcam from the layout path); `Review.tsx` (`VideoStage`, `BubbleLayer`); `src/timeline/` (Scene row); the side panel.

**Who:** I write `scene.rs` with its tests, the Scene and Zoom rule, and the compositor change. The implementer builds the preview side, the Scene row and the panel from my spec. I check that preview and export match frame for frame, the same way the camera path was checked.

**Your check:** record a minute with the webcam on. Add a full-webcam scene in the middle and a zoom that overlaps its start. Watch the preview, export, and watch the export. The bubble should grow to fill the picture and shrink back, the two should look the same, and your voice should match your lips while full screen.

### Brief item 6: Add track

No Add track control. The rows are fixed: Video, Zoom, Scene (only with a webcam), Blur (only with redactions). Nothing to add, so nothing to manage.

## Order

0. Own files and one scale (no visible change)
1. Real rows
2. Hover to preview, click to set
3. Timeline zoom
4. Hover to add, Generate button
5. Scene row, with bubble shrink

Steps 0 to 4 are the timeline itself and each leaves the app working, so you can use it between steps. I would install after steps 2, 4 and 5 for you to judge.

## What I could not verify

- How fast the app's own video player seeks. If hover preview feels laggy after step 2, the next thing to look at is recording with keyframes closer together, which would make files a little larger and would be your call.
- Whether lip-sync holds in a full-webcam export. Measured in step 5 before you see it.
- What "finicky" means to you beyond the six causes above. If something in that list is not what bothers you, or something is missing, say so before step 2.

## Decisions for you

1. **Hover while playing.** I propose the hover line shows but the preview keeps playing, and a click jumps playback there. The alternative is that hovering pauses and previews.
2. **Full webcam will be softer than the screen.** The webcam is recorded at 720p. Options: accept it and judge by watching (my recommendation), or record the webcam at 1080p, which means larger files and more work during recording.
3. **Split screen proportions.** I propose screen 62% of the width on the left, webcam card on the right. The screen picture gets smaller, so text is harder to read during a split.
4. **"No bubble" against "Full screen recording".** My reading of your list: "No bubble" keeps the Frame padding and background, "Full screen recording" drops them and fills the picture. With no Frame padding set, the two look identical, and I would then show only "No bubble". Say if you meant something else.
5. **Transition.** Animated move of about half a second (my proposal, and what the brief asks for), with no hard-cut option.
6. **Bubble shrink default.** Slider starts at 100% (no shrink) until you choose a default.
7. **Thumbnail popup removed.** The big preview replaces it. Say if you want it kept.
