# Resume — Thumbnail picker shipped (2026-06-13)

## What shipped

User-pickable poster frame for every saved MP4. Two surfaces, both populated automatically:

- **Embedded `attached_pic` in the MP4** — read by Finder/QuickLook thumbnails, macOS Spotlight previews, HTML5 `<video poster>`, iOS Photos, and most messenger preview surfaces. The chosen frame shows up everywhere a representation layer renders the file.
- **Default at 0.5s when the user picks nothing** — every export gets a sensible poster with zero user action. Eliminates the black/half-rendered frame-0 problem that affected every prior save.

UI surface is minimal: fourth tool button in the review toolbar (Trim/Text/Arrow/**Thumbnail**, "M" shortcut), inline confirm popover anchored under the button showing a paused-video snapshot at the scrub position, Use/Cancel. A bookmark-shaped tick on the timeline at the picked time, click-to-jump, muted styling + tooltip when the pick falls outside the active trim range. Trim-out-of-range fallback also fires a one-time `NoticeStrip` toast on save.

## Architecture

`SidecarState.thumbnail_time: Option<f64>` — original-timeline coords, same convention as `annotation.start_time` and `bubble_position_log.t`. None means "use export-time default (0.5s)." Round-trips through the `.annotations.json` sidecar.

`save_recording` calls `try_embed_poster(&output, &sidecar, is_mp4)` strictly after `run_edit_pipeline` returns Ok. The helper:

1. Maps original-timeline → output-timeline: `output_t = (thumbnail_time.unwrap_or(0.5) - trim.start).clamp(0.0, out_duration - 0.1)`. Out-of-trim picks clamp to start of trimmed output.
2. Extracts frame to a hidden sibling jpg (`.<stem>.poster-src.jpg`), used only as input to the mjpeg remux.
3. Remuxes `output.mp4 + jpg → output.mp4.poster.tmp` with `-c copy -c:v:1 mjpeg -disposition:v:1 attached_pic -f mp4`.
4. ffprobe-validates the tmp (stream 0 is video with attached_pic=0, stream 1 is attached_pic=1).
5. Atomic `fs::rename(tmp, output)` — only happens after every check passes.
6. Cleans up the hidden jpg regardless of outcome.

Best-effort discipline: the helper's return is discarded. Any failure path (extract fails, remux fails, validation fails, rename fails) logs `[poster] ...` to stderr, cleans up its own tmp files, and leaves the original `output.mp4` untouched. The MP4 deliverable is sacred from the moment `run_edit_pipeline` returns.

GIF saves skip the helper entirely (GIF has no `attached_pic` concept). No sidecar jpg gets written for any format.

## The `-f mp4` patch

First production runs of the embed silently failed with `Unable to choose an output format for '...poster.tmp'`. The tmp filename uses `.poster.tmp` so it's obviously transient on disk, but ffmpeg can't infer the muxer from that extension. Explicit `-f mp4` tells ffmpeg the format directly and the tmp extension stays clearly-temp. Single-arg fix on the remux command.

The best-effort wrapper held during this bug: every silent embed failure logged the ffmpeg error and left the un-embedded MP4 intact. No corrupted files, no broken saves.

## QuickTime Player.app caveat

QT Player.app shows **frame 0 of the primary video stream** as its before-play still, NOT the `attached_pic`. This is a Player.app design choice — there's no clean mp4-format-level fix without modifying the actual video stream (e.g. prepending a 1-frame chosen-poster intro to track 0, which adds a ~33ms flash on every playback start).

`attached_pic` IS honored by Finder/QuickLook, HTML5 `<video poster>`, iOS Photos, Slack/Discord/Messenger previews. Documented in the `try_embed_poster` doc-comment so the next person reading the code understands why QT Player isn't covered.

## Five-ish commits

| sha | what |
|---|---|
| (this) | feat(thumbnail): user-pickable poster + default-0.5s embed in every saved MP4 |

(Single bundled commit — the four moving parts — backend schema, frontend state/UI, backend embed helper, save-time notice — are tightly coupled and shipped together. Splitting would not improve reviewability.)

## Validated end-to-end

- (a) Pick a thumbnail mid-timeline → `attached_pic` extracted in the MP4 IS the chosen frame (verified by decoding stream v:1 to PNG).
- (b) QuickTime Player: shows frame 0 — accepted limitation, documented.
- (c) Finder thumbnail (QuickLook at 64/128/256/512/1024 px): chosen frame on every size. Verified after `qlmanage -r cache` to clear stale pre-fix entries.
- (d) Default-0.5s path: confirmed against a save where the user never touched the Thumbnail picker — embedded poster is a real content frame at ~0.5s, not black/frame 0.

## Followups / not in this ship

- Prepend-1-frame hack to make QT Player.app show the chosen poster — feasible but adds a per-export re-encode + a 33ms playback intro flash, deemed worse than the QT Player quirk.
- Reset-to-default action ("clear thumbnail") — replace-only is enough today.
