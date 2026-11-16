# Zoom polish + window capture: plan

Status: awaiting Keith's yes/no. No code has been changed.
Brief: `docs/ZOOM-POLISH-AND-CAPTURE-BRIEF.md`. Decisions so far: `docs/DECISIONS.md` 2026-11-15.

## The short version

1. **Zoom feels harsh because of the curve, the depth and the lack of blur, not because preview and export disagree.** Zeigen's camera covers the same distance in less time, zooms deeper, peaks at more than twice Cap's on-screen speed, and every moving frame is razor sharp. Fix: one camera path, computed once in Rust and played back by both the preview and the export, using a spring-style glide instead of the fixed 0.6s ramp. Nearby zooms pan into each other. Motion blur goes on moving frames at export.
2. **Auto-zoom is unexplained and its weakest rule fires a lot.** On your reference clip, 4 of 11 zooms were "cursor paused, no click", including one that starts on the very first frame. Fix: record and show the reason on every auto zoom first, then tighten the rules against clips you have marked up.
3. **Window capture drops popups because it asks macOS for exactly one window.** Fix: capture everything the app draws, cropped to the window's rectangle.

Five decisions are yours. They are collected at the end.

## What I measured: Cap vs Zeigen

Clips: `harness/reference/cap.mp4` and `zeigen.mp4`. I tracked every frame against the one before it to recover camera scale and position, so the numbers come from the pixels, not from either app's settings. The method reproduced Zeigen's known curve exactly (0.57s, symmetric, returns to 1.000x), which is how I know it is trustworthy. All speeds are at 1280px wide so the two clips compare directly.

| | Cap | Zeigen |
|---|---|---|
| Zoom depth | 1.5x every time | 1.7x or 2.0x |
| Zoom-in / zoom-out time | about 0.73s | 0.57s |
| Shape of the move | fast start, long soft landing: half the move is done in the first 27% of the time | symmetric S-curve: half done at the halfway point, then it stops as hard as it started |
| Time for the middle 80% of the move | about 0.32s | about 0.25s |
| Overshoot / bounce | none | none |
| Peak on-screen speed | 45 to 70 px per frame | 70 to 160 px per frame (up to 12% of the frame width in one frame) |
| Motion blur while moving | heavy: detail drops to roughly 15% of the at-rest level. Sideways smear on pans, outward smear on zooms. Cursor stays sharp. | none: mid-zoom frames are as sharp as still frames |
| Zooms in the clip | 8 in 125s | 11 in 104s |
| Pans while staying zoomed | 8 (0.6 to 0.8s each, same soft landing) | 0 |
| Shortest gap between a zoom-out and the next zoom-in | none shorter than 2.3s; closer targets are reached by panning | 1.2s, 1.3s, 1.7s, 2.0s: it zooms all the way out, waits a beat, and zooms back in |
| First zoom begins | 3.8s in | 0.07s in (the video opens mid-whip) |

What this says about feel:

- **Cap's move reads as a glide because it brakes for most of its duration.** Zeigen's reads as a snap because it accelerates and brakes equally hard and does it in less time over more distance.
- **Cap is slower on screen and still hides the motion with blur.** Zeigen is two to three times faster and shows every frame crisply, which is what a strobing "whip" looks like.
- **Cap does not zoom out between nearby targets.** Half of its camera moves are pans at constant zoom.

Limits of the measurement: scrolling page content looks like a small camera move to the tracker, so I ignored moves under 0.1s. The two clips are similar sessions, not the same actions, so the zoom counts are indicative only.

## How Cap does it (approach only; no code copied)

Read from Cap's current source by a research pass; file references are in my notes if you want them.

- **One camera path, simulated once.** Zoom amount and camera centre each chase a target with a spring. The path is computed at a fixed small time step from the start of the recording and stored; preview and export both just look up the stored path. There is no "transition duration" setting at all. The soft landing I measured is the spring.
- **Nearby zooms need no special rule.** When one zoom ends and another begins, the spring is simply given a new target and carries its speed across. Back-to-back zooms become a pan.
- **It does not follow the cursor continuously.** While zoomed, it keeps the camera still until the cursor leaves a box about half the visible width, then re-aims once and glides there. That is the series of pans I measured.
- **Blur is computed from how far the picture moved since the previous frame**, in one pass: an outward smear when the move is mostly zoom, a straight smear when it is mostly pan. No blur under 1px of movement. It is not built by rendering extra in-between frames.
- **Auto-zoom is clicks only.** Each click becomes a zoom from 0.3s before to 2.5s after; clicks within 2.5s of each other merge. No reason is stored. It runs from a button, not automatically.
- **Preview and export are literally the same renderer.**

## Problem 1: zoom motion

### What is actually wrong

1. **The curve is a fixed 0.6s ease-in-out on scale only.** The same formula exists twice and the copies agree: `src/Review.tsx:166` (preview) and `src-tauri/compositor-engine/main.swift:39` (export). So the brief's guess that the two might disagree is not the cause; the preview faithfully shows a harsh curve.
2. **The camera position has no path of its own.** A zoom stores one fixed centre (`Review.tsx:102`, `edit.rs:1566`). The sideways travel during a zoom-in is a side effect of keeping the crop inside the frame (`main.swift:863-866`). For a target 40% across the frame at 2x, the centre moves 59px in one frame and 9px in the next, then stops dead mid-zoom. That hard stop is part of the "whip".
3. **A zoom must return to 1x before the next one can start.** Each zoom is stored as "1x, up, hold, back to 1x" and zooms may not overlap (`Review.tsx:1339`). The detector also forces 1.2s between them (`zoom.rs:84`, `zoom.rs:511`). On your clip the zoom at 92.7s ends and the next starts 1.3s later.
4. **Motion blur exists but is switched off and is the wrong kind for pans.** The export has an outward-only blur behind a flag (`main.swift:92`, `main.swift:894`) that the app never sets (`edit.rs:695-800`).
5. **Auto zooms are deep.** 2.0x near edges and 1.7x elsewhere (`zoom.rs:127-128`). Deeper zoom means more distance covered in the same time.

### Approach

**One camera path, defined once in Rust, played back by both renderers.**

- A new Rust module turns the zoom segments into a camera path: scale and centre at a fixed small time step for the whole recording. The scale and the centre each glide to their target with a critically damped spring (the kind that settles without bouncing), tuned to land on Cap's measured shape: about 0.7s, half done by about 30% of the time, no overshoot.
- The preview asks Rust for the path and looks up the current time. The export receives the same path as a file and looks up each frame's time. Neither renderer contains any easing maths, so they cannot drift apart. This replaces the two copies of the curve, which get deleted. It satisfies the standing rule "defined once, rendered by both".
- **Zooms within about 2.5s of each other are joined**: the camera holds its zoom across the gap and pans to the next target. Farther apart, it zooms out and back in as today. This is the "pan between nearby zooms" you asked for, and it is the same thing Cap's stepwise re-aim produces.
- **The zoom heads straight for its target from the first frame.** The centre is expressed so it is always inside the frame, which removes the mid-zoom hard stop.
- **Timing on the timeline keeps its meaning.** A segment still starts moving at its left edge and is back to wide by its right edge. Existing recordings and saved sidecars need no conversion; they just get the new motion.

Why a spring and not a nicer fixed curve: a fixed curve needs special handling for every interrupted or back-to-back move. A spring handles all of them with one rule (new target, keep your speed), which is less code and is exactly why Cap's pans look continuous.

**Motion blur at export: based on how far the picture moved since the previous frame.**

- Mostly-zoom frames get the outward blur that already exists; mostly-pan frames get a straight smear in the direction of travel. Still frames are untouched. The cursor is part of the picture in Zeigen, so it will blur with it (Cap keeps it sharp because it draws its own cursor; see "Cursor smoothing" below).
- I am not rendering extra in-between frames. That would multiply the render cost of every moving frame by however many sub-frames are used; the one-pass blur adds one filter to moving frames only, which at these move lengths is a small share of the video. I will measure and report the export-time change on your reference clip before it becomes the default. I have not measured it yet.
- Strength is a taste call. I will give you your own clip rendered at off, light and medium, and you pick.
- **The preview will not show the blur.** The preview is a CSS transform on a video element and cannot do a directional smear cheaply. The camera path will match exactly; the blur will be export-only. That is a gap against "preview must match" and I will record it in `docs/DEBT.md`. Decision 2 below.

**Cursor follow stays closed, and Cap does not change my mind.** Cap does not follow continuously either; it re-aims in steps. Joined zooms give Zeigen the same result from the segments it already has. The one case this does not cover is a single long zoom where the cursor wanders out of view. If you see that in real recordings, the path module is where a re-aim rule would go.

**Editing.** I found no bug in the timeline editing, only friction: the resize handles are 6px wide (`src/components/SegmentTrack.tsx:331`) and a selected zoom shows the flat frame until you deselect or press Space (`Review.tsx:2916`). I will widen the grab area on the handles. Beyond that I would rather you tell me the specific fiddly moment after the motion is fixed, since some of "fiddly" is probably fixing bad targets and bad motion by hand.

**Cursor smoothing (backlog item): what should be shared.** Two things carry over and should not be built twice: the spring function, and the pattern of "Rust computes a path once, both renderers look it up". Cursor smoothing itself is a bigger job than it looks, because today the cursor is baked into the recorded pixels (`RecordingSession.swift:296`). Smoothing or restyling it means recording without the cursor and drawing our own at export. The camera should keep reading the raw cursor either way, as Cap's does, so the camera work does not depend on it.

### Files that change

- New `src-tauri/src/camera.rs`: the path function and its tests.
- `src-tauri/src/edit.rs`: write the path file for the export instead of the segment list.
- `src-tauri/compositor-engine/main.swift`: look up the path; delete the built-in curve; add the pan blur.
- `src/Review.tsx`, `src/redaction.ts`: preview and redaction boxes look up the path; delete the built-in curve.
- `src/components/SegmentTrack.tsx`: handle grab area; shading that shows when the camera is moving.
- `src-tauri/src/zoom.rs`: drop the forced 1.2s gap; default depth (decision 1).
- New `harness/zoom-measure/`: the frame tracker I used above, kept so every motion change is checked against the Cap numbers.

### How the work is split

1. **Camera path module (me).** The delicate part: the spring, the joining rule, staying inside the frame. Tested without any video.
2. **Export plays the path (implementer).** Swap the export over, delete its curve. Checked by running the tracker on an export and comparing to the table above.
3. **Preview plays the path (implementer).** Swap the preview and redaction over, delete their curve.
4. **Motion blur (implementer builds, I tune).** Ends with the three-strength comparison for you.
5. **Handles (implementer).** Small.

### The clip to record

A 45-second window recording of SnowDash, auto-zoom on, no edits:
- Click a filter on the far left, wait two seconds, click a button on the far right. Expect: one glide in, a pan across, no zoom-out in between.
- Then wait five seconds and click something in the middle. Expect: a zoom-out that settles softly, then a fresh glide in.
- Pause the export mid-move. Expect: the frame is smeared in the direction of travel, and sharp again the moment it stops.
- Play the same stretch in the preview. Expect: identical timing and framing, minus the blur.

## Problem 2: auto-zoom you can't explain

### What is actually wrong

1. **No reason is kept.** The detector knows why it fired (drag, right-click menu, or a pause) but throws that away. A zoom carries only an "auto" flag (`edit.rs:163`), and every segment on the timeline is labelled just "zoom" (`Review.tsx:4412`).
2. **The weakest trigger needs no click at all.** A cursor resting within about 150px for 0.8s becomes a zoom (`zoom.rs:56-57`, `zoom.rs:328`). On your reference recording, read from its own cursor log:

   | Zoom | Why it fired |
   |---|---|
   | 0.0s to 4.7s | pause, no click |
   | 5.9s to 8.0s | pause with 2 clicks |
   | 14.3s to 21.6s | pause, no click |
   | 29.3s to 34.0s | pause with 1 click |
   | 37.9s to 56.4s | drag |
   | 58.4s to 62.5s | drag |
   | 68.5s to 70.6s | pause, no click |
   | 73.6s to 76.4s | pause with 3 clicks |
   | 78.1s to 90.0s | drag |
   | 92.7s to 99.5s | drag |
   | 100.9s to 103.9s | pause, no click |

   Four of eleven are pauses with no click, including the first and last things the viewer sees. I expect these are most of the "not sure why" zooms, but that is a guess until you mark them.
3. **A zoom can start at time zero** (`zoom.rs:379`), so the video can open mid-move.
4. **It runs on its own every time Review opens** (`Review.tsx:1304`), so every recording arrives with these on it.
5. **There is a rule that deliberately skips a click followed by stillness** (`zoom.rs:341-359`), on the theory that you are watching a result elsewhere. Cap does the opposite and zooms on every click. I do not know yet which is right for your demos; the reasons will tell us.

### Approach

**Step 1: make it explainable, change no behaviour.** Each auto zoom gets a reason saved with it and shown on its timeline segment and in the Zoom panel: "drag", "right-click menu", "pause + 2 clicks", "pause, no click". Old recordings without a reason show plain "zoom" as today.

About the confidence score in the brief: I am not going to invent a number. The detector has no honest probability to offer, and a made-up "72%" would look more trustworthy than it is. The reason itself is the ranking: drags and menus are strong, pause-with-clicks is medium, pause-with-no-click is weak. If that turns out not to be enough to tell a bad rule from a bad threshold, I will revisit.

**Step 2: a fixed set of clips with your calls on them.** You record three short clips once (below). For each, you tell me by timestamp which zooms were right, which were wrong, and where one was missing. I store the cursor logs and your calls in the repo. From then on every detector change is scored against the same clips: wrong zooms, missed zooms, kept zooms. The detector already has three older recordings pinned this way (`zoom.rs:711-799`), so this extends an existing habit; the difference is these will have your judgement attached.

**Step 3: tighten, guided by step 2.** What I expect to propose, to be confirmed by your calls and not before:
- Pause-with-no-click zooms off.
- No zoom starting in the first second or ending in the last.
- Nearby zooms joined by a pan (comes free from Problem 1).

Dropped from the brief by your decision: typing as a signal.

### Files that change

- `src-tauri/src/zoom.rs`: keep the reason; later, the rule changes; scoring test.
- `src-tauri/src/edit.rs`: one optional "reason" field on a zoom, left out when empty so old sidecars are unaffected.
- `src/Review.tsx`: show the reason on the segment and in the panel.
- `src-tauri/tests/fixtures/`: the reference cursor logs and your calls.

### How the work is split

1. **Reasons end to end (implementer).** No behaviour change, so it is safe to ship alone.
2. **Reference set and scoring (me).** Needs your three clips and your calls.
3. **Rule changes (me decides, implementer applies).** One rule per commit, each with its before/after score.

### The clips to record (once)

Each 60 to 90 seconds, window recording, auto-zoom on, and do not discard them until I have copied the cursor logs:
1. **Click-through.** A normal SnowDash demo: filters, a dropdown, a drag, reading a result.
2. **Talking, not clicking.** Narrate over a dashboard while the cursor mostly rests or drifts. Ideally this produces no zooms.
3. **Scroll and read.** Scroll a long table, stop to read, scroll again.

To judge step 1: open any of them in Review. Every auto zoom should say why it exists, and you should be able to say "that reason is fine but the zoom is wrong" or "that reason should never zoom".

## Problem 3: window capture drops popups

### What is actually wrong

The brief's guess is right. Window recording asks macOS for a single window (`RecordingSession.swift:158`). Menus, dropdowns, popovers and dialogs are separate windows belonging to the same app, so they are never in the picture.

### Approach

Record everything that app draws on that display, cropped to the chosen window's rectangle. Zeigen already records a cropped region of a display for Area mode (`RecordingSession.swift:176-189`), so this is Area mode with two additions: the picture is limited to one app, and the crop follows the window.

What you would see:
- Menus, dropdowns, popovers, sheets and dialogs that the app opens over its window are recorded.
- Other apps' windows that overlap it are still left out, as today.
- The picker, the output size and the rest of your workflow do not change.

Known limits, stated up front:
- **A popup that hangs past the window's edge is cut off at the edge.** The brief suggested a margin around the window. I am leaving that out: a margin would put a strip of empty background around every recording to help an occasional case, and it complicates the rounded-corner handling that took five rounds to get right in July. If cut-off menus turn out to matter, a margin is a small follow-up.
- **Panels owned by macOS itself, not the app, will still be missing.** The file open/save panel is the main one.
- **A second window of the same app that overlaps the recorded one will show.**
- **If you drag the window while recording, the crop follows a fraction of a second behind.** Today it follows perfectly. Resizing mid-recording is no better or worse than today.
- **The window must be visible on the display.** Today a window on another Space can still be recorded; with this approach it cannot.

Three things downstream assume "one window fills the frame" and need checking, not rewriting: where the cursor is recorded (`CursorTracker.swift:200`), the shadow setting (`RecordingSession.swift:307`), and the export's measurement of the window's rounded corners (`main.swift:591`).

I have not run this yet. macOS's capture behaviour has surprised this project before, so the first step is a small throwaway test that proves popups appear and the corners still come out clean, before any app code changes. If the test fails, I come back to you with what I found.

### Files that change

- `src-tauri/recording-engine/Sources/recording-engine/RecordingSession.swift`: the capture filter and crop.
- `src-tauri/recording-engine/Sources/recording-engine/Engine.swift`: keep the crop on the window as it moves.
- Possibly `src-tauri/compositor-engine/main.swift`, only if the corner measurement needs adjusting.

### How the work is split

1. **Throwaway test (me).** Proves or kills the approach.
2. **Engine change (implementer).**
3. **Check corners, cursor position and zoom targets on a real window recording with a background (me).**

### The clip to record

A 30-second window recording of your browser showing SnowDash, with a background and padding set:
- Open a native dropdown, right-click for a context menu, and trigger one dialog. Expect: all three appear in the recording.
- Zoom should land on what you clicked, and the window's corners should be clean, as they are today.
- Then drag the window a short way. Expect: the recording keeps the window framed, with at most a brief lag.

## Suggested order

1. Camera path, export, preview (Problem 1, steps 1 to 3).
2. Window capture test and change (Problem 3). Independent of everything else, so the implementer can do it alongside.
3. Reasons on auto zooms (Problem 2, step 1).
4. Motion blur.
5. Reference clips, then rule changes.
6. Handles.

## Decisions I need from you

1. **Default auto-zoom depth.** Cap uses 1.5x; Zeigen uses 1.7x and 2.0x. I recommend 1.5x and 1.7x. It is the cheapest way to make every move gentler. The scale slider still goes to 2.5x for manual zooms.
2. **Motion blur in the export only, not the preview.** I recommend accepting this. The alternative is rebuilding the preview on a different drawing technology, which is not justified for a 0.7s effect.
3. **Join zooms that are within about 2.5s of each other with a pan.** I recommend yes; 2.5s is Cap's number and the widest gap where Zeigen currently yo-yos.
4. **Window recording changes for everyone, with no on/off switch.** I recommend yes. The cost is the list of limits above, chiefly the lag when dragging the window.
5. **Turn off pause-with-no-click zooms.** I recommend deciding this after you have seen the reasons on your own clips, not now.

## What I could not verify

- The export-time cost of motion blur. Not measured.
- Whether the capture change really includes every kind of popup and keeps clean corners. Untested until the throwaway test.
- Why each of Cap's zooms fired. I measured where and when Cap zoomed, but had no cursor log for the Cap clip.
- How the new motion feels. The numbers say it will match Cap's shape; only your eye on a real recording settles it.
- Preview smoothness. The preview reads the video's clock once per screen refresh; I have not measured whether that clock is fine-grained enough for a glide to look as smooth in the preview as in the export.
