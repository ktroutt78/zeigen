# Cursor smoothing: short plan

Status: APPROVED 2026-11-15 (smoothing before blur; every save renders; size slider in, custom icon out). Cursor-shape test passed.

## Should it come before blur?

Yes. Do cursor smoothing first, then motion blur.

- Blur's hardest question is how the cursor looks when the camera moves. With today's baked-in cursor it smears with the picture. Once Zeigen draws its own cursor, the cursor is drawn after the blur and stays sharp, as in Cap. Doing blur first means tuning and judging a smeared cursor that is about to disappear.
- The cursor is the bigger visible problem now. Blur is polish on a camera move that already looks right.

## What is actually wrong

- The cursor in the recording is exactly what macOS drew, frame by frame (`RecordingSession.swift:296`). Every small hand movement is in the pixels, the video only has 30 frames a second to show it, and a 1.5x to 1.7x zoom magnifies it. There is nothing in the export that can calm it, because it is not a separate thing; it is part of the picture.
- Zeigen already logs where the cursor was 120 times a second, with clicks (`CursorTracker.swift`). It uses that only to decide where to zoom.

## Approach

1. **Record without the cursor.** New recordings turn the system cursor off in the capture. The cursor log stays as it is.
2. **Also log what the cursor looked like.** Arrow, pointing hand, text I-beam and so on: when the shape changes, save the new image once and note the time. Without this every cursor would be an arrow.
3. **Compute one smoothed cursor path in Rust,** the same way the camera path works: computed once, looked up by both the preview and the export.
   - The smoothing is centred in time: each point is a weighted average of where the cursor was just before and just after. That removes jitter without making the cursor lag behind what is happening on screen. A recording is finished before it is smoothed, so the future is known.
   - At every click the cursor is pinned to the true click position, so it never appears to click beside a button.
   - This is a correction to what I said in the zoom plan. I expected to reuse the camera's spring. A spring smooths by lagging, and Cap needs extra machinery (leading the target, anticipating clicks) to hide that lag. Centred smoothing has no lag to hide, so it is less code. What is shared with the camera work is the pattern, not the spring.
4. **Draw the cursor at export, after the zoom and after the blur.** It follows the camera, grows with the zoom as today, and stays sharp while the picture smears.
5. **Draw the same cursor in the preview** from the same path, so the preview matches.
6. **One strength setting in Review:** Off, Light, Smooth. I will tune the three on your reference recording; you pick the default. Off draws the raw path, which should look like today.

## What changes for you

- **Old recordings keep their baked-in cursor** and cannot be smoothed. Only recordings made after this ships.
- **Every save goes through the renderer.** Today a recording with no zoom, no webcam, no watermark and no background is saved by copying the video untouched, which is nearly instant. Without a baked-in cursor that copy would have no cursor in it, so those saves would render instead. On the reference recording a render took about 13 seconds for 104 seconds of video. Recordings that already use zoom or the webcam bubble are unaffected, since they render today.
- **The raw recording on disk has no cursor.** Anything that reads it directly (the scrub thumbnails, the poster frame) will show no cursor unless I draw it there too. I would leave thumbnails without one.

## Every export path draws the cursor

Added at Keith's request: no path may silently produce a video with no cursor.

The export paths that exist in the code today, and how each gets its video:

| Path | Where | Today |
|---|---|---|
| Save as MP4 | `save_recording` in `edit.rs` | renderer if zoom / webcam / watermark / background, otherwise an untouched copy or plain re-encode |
| Save as GIF | `save_recording` in `edit.rs` | renderer under the same conditions, otherwise straight to the GIF encoder |
| Copy to clipboard | `clipboard.rs` | same as Save as MP4 |

All three go through one function (`run_edit_pipeline`, `edit.rs`), and that function has exactly two branches that skip the renderer (plain MP4, plain GIF). So the rule goes in that one place: a recording made without a baked-in cursor always takes the renderer, for MP4, GIF and clipboard alike.

**LinkedIn and R2 link do not exist in the code.** LinkedIn export was removed in July and hosted sharing was dropped in Phase 6; only CLAUDE.md's Scope line still mentions them. If either comes back it must go through the same function and inherits the rule.

How "silently" is ruled out:
- Each recording is marked at stop as "cursor not in the video". The export reads that mark, not the presence of the cursor log.
- If a marked recording's cursor log is missing or unreadable, the export fails with a clear error instead of producing a cursorless file.
- One automated test per path (MP4, GIF, clipboard): export a marked recording with no other edits and check that cursor pixels are in the output where the log says the cursor was.

## Cursor style

- **Size comes nearly free** once Zeigen draws the cursor: one slider.
- **A different icon is not free.** There are a dozen system shapes, and a custom style needs a matching drawing for each. I would leave style on the backlog.

## Files that change

- `src-tauri/recording-engine/Sources/recording-engine/RecordingSession.swift`, `CursorTracker.swift`: cursor off in capture; log shape changes.
- New Rust module for the smoothed cursor path, plus a Tauri command for the preview.
- `src-tauri/compositor-engine/main.swift`: draw the cursor.
- `src-tauri/src/edit.rs`: pass the cursor path and images to the export; send no-edit saves through the renderer.
- `src/Review.tsx`: draw the cursor in the preview; the strength setting.

## How the work is split

1. **Throwaway test (me).** Prove the engine can read the cursor's current shape without a new permission prompt. If it cannot, the fallback is a single arrow for everything, and I come back to you before going further.
2. **Capture changes (implementer).**
3. **Smoothed path (me).** Tested without video.
4. **Export draws the cursor (implementer).** Checkpoint: I give you the reference session re-recorded and exported at Off, Light and Smooth.
5. **Preview draws the cursor (implementer).**
6. **Strength setting and size slider (implementer).**

## The clip to record

Step 4 needs a new recording, because the existing reference was captured with the cursor baked in. A 60-second SnowDash session at your normal mouse speed: move between far-apart controls, click several, hover over a table while reading, select some text. Then judge:
- The cursor travels in calm curves, not twitches.
- Every click lands exactly on what you clicked.
- The cursor is never behind the action.
- It changes to a hand over links and an I-beam over text, as it did live.

## Decisions I need from you

1. **Cursor smoothing before blur:** I recommend yes.
2. **Every save renders, including recordings with no edits:** I recommend accepting it. The alternative is keeping the baked-in cursor for no-edit saves, which means two kinds of recording and an unsmoothed cursor in exactly the plain ones.
3. **Size slider in, custom icon out:** I recommend yes.

## What I have not verified

- That the cursor's shape can be read from the recording engine without a permission prompt on this macOS version.
- How long a no-edit save takes on a long recording. The 13 seconds is one measurement on one clip.
- How the three strengths feel. That is yours to judge on a real recording.
