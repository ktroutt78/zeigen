# Brief: timeline rework + Scene track

Keith spends a lot of time in Review, and the timeline is the part that fights him. The goal is a timeline that feels like Cap's: stacked, labelled tracks, hover to scrub, zoom in for detail, and a Scene track for switching layouts.

Reference: `harness/reference/cap-timeline.mp4` (gitignored), Keith's 52-second screen recording of Cap's editor. Study it before planning. As before, Cap is AGPLv3: study the approach, don't copy the code.

Investigate first. Read the timeline code (`Review.tsx`, `SegmentTrack.tsx`, `Waveform.tsx`, `ScrubPreview.tsx`) and come back with a plan Keith can say yes or no to. No code until he approves.

## What Keith wants

### 1. Moving around the timeline is finicky
**What Keith sees:** scrubbing and moving the playhead in Review takes effort.
**What Cap does (see the video):** moving the mouse over the timeline shows that moment in the preview right away, with a hover line following the mouse. No click or drag needed to look around; a click sets the playhead.
**Goal:** hover to preview, click to set. Find out why today's scrubbing feels finicky (gated seeks, scrub thumbnails, hit areas) and fix the root cause, not just add hover.

### 2. Zooms on a real, labelled track
**What Keith sees:** zoom capsules float in an unlabelled lane under the waveform.
**What Cap does:** stacked rows with a label and icon on the left (Video, Zoom, Scene), each with a full-width track background, the same height and style, and the playhead running through every row. Segments show their name and value (e.g. "Automatic Zoom 1.5x").
**Goal:** Video, Zoom and Scene as real rows. Show each zoom's reason on its segment. Widen the segment handles: today they're 6px (`SegmentTrack.tsx:331`).

### 3. Zoom in on the timeline
**What Cap does:** a zoom slider (minus and plus magnifiers) next to the playback controls. Zooming in spreads the time ruler out for precise edits.
**Goal:** zoom in and out, plus a quick way back to fit the whole video. Today the timeline always fits the whole recording to the width.

### 4. Hover to add on a track
**What Cap does:** hovering an empty part of the Zoom or Scene row shows a dashed ghost segment with a "+" at the cursor, and clicking adds a segment there.
**Goal:** the same way to add zooms and scenes. It replaces "click the lane to add".

### 5. Scene track
**What Keith wants:** a Scene row where he marks stretches of the video to change layout, with an animated transition each way:
- Default: screen recording with the webcam bubble
- No bubble: screen recording only
- Split screen: screen and webcam side by side
- Full webcam: talking to camera
- Full screen recording: screen with no bubble, at full size

The main case is cutting from the demo to full-screen webcam, then back to the demo.

**Constraints:**
- Defined once and rendered by both preview and export (the standing rule), the same pattern as the camera path.
- cicompositor stays the single render path.
- The Scene and Zoom rows need to agree on what wins when a zoom overlaps a full-webcam scene. Propose a rule.

### 6. Add track: keep it small
Cap has an "Add track" button and extra rows (e.g. 3D). Keith doesn't need lots of track types. Propose whether Zeigen needs an Add track control at all, or whether fixed Video, Zoom and Scene rows are simpler. The coding standards favour simpler.

### 7. Bubble shrinks during zooms
**What Cap does:** a "Size During Zoom" setting in its camera panel. While the screen is zoomed, the webcam bubble gets smaller, so it covers less of the detail the zoom is showing.
**Keith's take:** not sure yet. Propose whether it's worth it. The simplest version is a fixed shrink during zooms, eased in and out with the camera path so it moves with the zoom, possibly with one slider. Like everything else, it's defined once and rendered by both preview and export. It overlaps with the Scene and Zoom interplay in item 5, so decide them together.

### Related backlog items to fold in or rule out
- Auto-zoom on a button: Cap's Zoom row has a "Generate" button, while Zeigen runs detection when Review opens. Propose where this lives on the new Zoom row.
- Timeline shading doesn't show the real camera motion (`docs/DEBT.md`).

## Plan format
For each item: what's wrong today (with file and line references), the approach and why, the files that change, how the work is split between Fable and the implementer, and the clip or check Keith uses to judge it. Suggest an order. A good default is 1 to 4 first (the timeline itself), then 5 (Scene), since Scene builds on the new rows.

Write it to `docs/TIMELINE-PLAN.md`.
