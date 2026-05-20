# Decisions

Append-only log. Newest at top. Don't re-litigate settled decisions — if you want to revisit one, add a new entry that supersedes it.

---

## 2026-05-20 — Record another disables during active save (D-04 exception)

PHASE-11-CONTEXT D-04 said Record another stays active in all states (pre-commit, mid-save, post-commit). In practice "all states" assumed a normal flow, not an in-flight save. Clicking Record another mid-save fires `discard_recording` against the scratch directory while ffmpeg is still reading it — same shape as the bugs that produced the 119 GB orphan-cleanup incident.

The button now disables when `saving === true` (in addition to the existing `discarding` gate). Otherwise it remains active in every state — including post-save, which is what D-04 was really protecting.

## 2026-05-20 — Sidecar change invalidates the LinkedIn MP4 baseline cache

Phase 11 c4 added `committedMp4Path` so the LinkedIn export chain reuses the most recent MP4 save instead of producing a fresh `recording-<stamp>-N.mp4` every click. But that cache goes stale the moment the user edits the sidecar (trim, text, arrow) after a save: a subsequent LinkedIn click would otherwise ship the old bake.

The debounced sidecar-write effect now also calls `setCommittedMp4Path(null)`, so the next LinkedIn click chains a fresh `save_recording({mp4, source})` against the live sidecar. The cost is one extra ffmpeg pass per LinkedIn-after-edit; the alternative — silently shipping stale edits — is the worse failure mode.

## 2026-05-19 — Save unifies commit + export; scratch + sidecar stay live until close

Every Phase 11 save re-reads the raw scratch mp4 + current sidecar and produces a fresh file in `~/Movies/Zeigen/`. The scratch directory is **not** removed on first save anymore — it survives until the review window closes (red X, Record another, Discard, app close). Subsequent saves in the same session re-read raw + live sidecar and write a new collision slot (`recording-<stamp>.<ext>`, `-2.<ext>`, ...).

Supersedes the Phase 5.5 single-commit lifecycle, where the first save renamed scratch → final and locked the recording. The trade-off:

- **Benefit:** edits stay editable across saves. A user who saves MP4-720p, watches it, and notices a bad trim can fix the sidecar and re-save without re-recording.
- **Cost:** one ffmpeg pass per save, even when the user is only changing resolution. Acceptable — saves are user-initiated, not hot-path; and the "single ffmpeg invocation per save" rule from PHASE-11-CONTEXT line 18 is preserved (every save is exactly one pass; thumbnail extraction is a separate background spawn and doesn't count).

The noop MP4-Source path remains zero-ffmpeg: `std::fs::hard_link` with `std::fs::copy` fallback.

## 2026-05-19 — MP4 default resolution: 1080p

`save_recording` defaults MP4 to 1080p across the `[ 480p | 720p | 1080p | Source ]` preset set. Large-display captures (often >3840px wide on Studio Display / external 4K monitors) produce source mp4s that are unwieldy to share — recipients struggle to download, open, or paste them into other tools. 1080p is the widely-shareable sweet spot for screencast/demo material. `Source` remains available for max-quality archival.

GIF default stays at 720p (Phase 10 D-01). The defaults differ because MP4 is the primary share format and GIF is the lossy auxiliary.

## 2026-04-26 — DisplayLink-driven displays don't get overlay UI

DisplayLink (and other third-party USB-to-video extension drivers) register their virtual displays with `CGDisplay` and `ScreenCaptureKit`, so they enumerate in the Screen dropdown and record correctly. They are NOT first-class `NSScreen`s, and `NSWindow.setFrame:display:` placement on coordinates inside their bounds is silently dropped or clamped by macOS. This affects the countdown overlay (Phase 3.5) and the Identify-display button (Phase 7) — neither will render on a DisplayLink screen even though the math is correct for native displays.

No application-layer fix exists. Workarounds floating around (private APIs, kernel shims) aren't worth shipping for a personal demo tool. Documented as a known limitation in README and CLAUDE.md gotchas.

## 2026-04-26 — Phase 7 ships three of six deliverables

Capture window sizing, identify-display button, and the new app icon ship. Recording preset picker, settings persistence, error surface, and DMG installer are deferred to a future polish phase. Rationale: the three shipped items address concrete UX friction the user kept hitting; the deferred items are either YAGNI for the immediate use case (preset picker — the user's demos are always 16:9) or have natural homes in a separate ship-prep phase (DMG, settings persistence, error surface).

## 2026-04-26 — Phase 6 ships local + clipboard + LinkedIn destinations only

Hosted "Upload & Share Link" is deliberately out of scope. The path requires either user-supplied Cloudflare credentials (too much friction for a personal demo tool) or a hosted backend (significant infrastructure, costs, and ongoing liability). Zeigen is positioned as a local recording tool with smart export paths, not a hosted sharing service. The roadmap originally enumerated R2 + Pages + SigV4 + viewer site; none of that ships, and no follow-up phase is planned.

## 2026-04-26 — Phase 6 uses iPhone screenshot semantics for review-window lifecycle

Closing the review window discards the recording — no prompt. Save and Discard are explicit footer buttons; everything else (close, no choice) defaults to discard. Copy to Clipboard and LinkedIn export are independent destinations that produce temp/separate files without committing the source recording. The Phase 5.5 Save/Discard/Cancel close-prompt is removed entirely.

This reverses the close-prompt portion of the 2026-04-25 "Recordings go to scratch on finalize" entry. The scratch-on-finalize part stands; the modal does not. Rationale: independent destinations made the close-prompt confusing because users could have already used the recording (clipboard, LinkedIn) before deciding whether to keep the local copy.

Implementation:
- Footer "Save recording" — commits scratch → final. Optional. Window stays open after commit so the user can use the export rows. Reveal-in-Finder affordance appears next to the disabled "Saved" pseudo-button.
- Footer "Discard recording" — destructive, deletes scratch + per-recording temp dir. No confirm modal — the click is itself the explicit choice. Disabled after Save (scratch is gone).
- "Record another" — same cleanup as Discard, then emits `record-another`, then closes.
- Close window (title bar X) — when committed, silent cleanup + destroy. When uncommitted, shows a Save / Discard / Cancel modal (Discard default, matching the original Phase 5.5 modal). Rationale for keeping this one prompt: the red X is an ambiguous gesture (users habitually close windows), unlike the explicit footer Discard click. Without confirmation, accidental close → silent discard punishes the wrong instinct.
- Copy to Clipboard row — copies the source mp4 to `~/Library/Caches/com.zeigen.app/exports/recording-<stamp>/` and points NSPasteboard at the temp copy. Does not commit. Available regardless of save state.
- Export for LinkedIn row — produces a separate `recording-<stamp>-linkedin.mp4` in `~/Movies/Zeigen/`. Does not commit the original. The LinkedIn-preset file persists across all cleanup events. (Wired in a follow-up commit; row shows "Soon" in this commit.)
- The Saved Locally row is removed — Save lives only on the footer.
- Temp files cleaned on Discard, close, "Record another." App-launch sweep removes any per-recording temp dir older than 24h. No app-quit cleanup.

UX consequence the user accepted: copying to clipboard then closing the review window invalidates the paste — NSPasteboard's fileURL points at a now-deleted temp file. Documented behavior consistent with the iPhone-screenshot framing ("explicit Save = keep, anything else = throw away").

## 2026-04-25 — Webcam mirror handling

Composite applies `hflip` to match the preview's `scaleX(-1)`. Result is preview/recording always match each other; absolute orientation depends on whether the camera pre-mirrors (Continuity does, FaceTime HD does not).

## 2026-04-25 — Recordings go to scratch on finalize, not final path

Recording-finalize writes the composited mp4 to `~/Movies/Zeigen/.scratch/<id>/` and the review window operates on that scratch file. The final commit to `~/Movies/Zeigen/recording-….mp4` requires an explicit user **Save** action; **Discard** deletes the scratch dir in full. Closing review with unsaved state prompts Save/Discard/Cancel (Discard default). Matches the mental model of all comparable tools (Loom, CleanShot X, QuickTime, ScreenFlow). The previous auto-save behavior was a Phase 5 implementation choice that conflicted with this model — corrected in Phase 5.5.

## 2026-04-25 — `--warning` token added for length-cap 80% tint

`--warning: oklch(0.72 0.16 70)` and `--warning-tint: oklch(0.82 0.14 70)`. Family-consistent with the existing `--accent` / `--recording` / `--success` triplet (all chroma ~0.16, hue 70 between recording's 25 and success's 155), but lifted to lightness 0.72 — pure 0.62 read muddy on the dark bubble pill at 11px. The 100% length-cap state reuses `--recording`. `--warning` does not get a paired bg/surface token; `--recording` doesn't have one either.

## 2026-04-25 — Bubble position log: array-only schema from introduction

`bubble_position_log` lands as an array of `{t, x, y}` entries from day one. No scalar `bubble_position` form was ever shipped, so there is no backward-compat fallback to a "single-entry log at t=0" — that path was speculatively documented during planning and removed once the implementation surface was clear.

## 2026-04-25 — Bubble position log coordinates: fractions of the recorded display, clamped

`x` and `y` in the log are fractions [0..1] of the *recorded display's* physical pixel frame (origin and size sent into `engine_start` from React via `availableMonitors()`). If the user drags the bubble off the recorded display onto another, coordinates clamp to [0, 1] — the composite overlay sticks to the nearest edge rather than disappearing or rendering off-frame. Multi-display correctness for picking the right monitor falls back to size-match in the rare ambiguous case.

## 2026-04-25 — Webcam bubble draggable, free drag with corner snapping, pre-record and during-record

Matches Loom and CleanShot. Position adjustable mid-record so users can move the bubble out of the way of content they're demoing.

## 2026-04-25 — Countdown duration / skip semantics

5s / 3s / Off as the user-facing knob. No separate "skip hotkey toggle" setting — the right control is duration, not a parallel skip mechanism. Esc cancels (no recording starts), Spacebar/Enter skips (recording starts immediately). Countdown is not baked into the recording.

## 2026-04-25 — Timer primary surface on the webcam bubble, not the menu bar

Users look at the bubble constantly during recording (they're checking themselves on camera). Menu bar requires eyes-up movement that defeats the "am I close to my limit" use case. Standalone draggable chip is the fallback when no webcam. Menu bar is secondary backup, free to add since the tray icon already exists.

## 2026-04-25 — Length cap is a warning, not enforcement; 80% / 100% thresholds are not user-configurable

Recording never auto-stops at the cap. Warning tints (orange at 80%, red at 100%) live on the bubble/chip surface only — menu bar stays visually clean. Thresholds fixed for now; YAGNI on configurability until someone asks.

## 2026-04-25 — `makeCaptureInvisible()` shared utility

All floating windows visible during recording must call it (sets `NSWindow.sharingType = .none` so SCK doesn't capture them). Consumers: floating preview, countdown overlay, draggable bubble, standalone timer chip. Single utility, multiple consumers — prevents the Phase 5 two-bubble class of bug from recurring.

## 2026-04-25 — "Discard edits" is non-destructive

The Phase 5 footer's "Discard edits" button resets trim handles and clears annotation overlays — it does not delete the source recording. Destructive delete is deferred to a future phase with a confirmation dialog. The mockup's original "Discard recording" wording was too aggressive for review-screen UX.

## 2026-04-25 — Phase 5 scaffolds the Phase 6 export panel disabled

Review window ships with the full Phase 6 export panel rendered at visual fidelity but inert (opacity 0.4, `pointer-events: none`, "Coming in Phase 6" caption). Phase 6 only removes the disable. Avoids re-laying out the window when Phase 6 lands and gives the user a visible roadmap.

## 2026-04-25 — Review window is a separate Tauri window

Recording stop opens a new Tauri window labeled `review`; main window stays hidden through Phase 4 and into review. Keeps capture and review concerns isolated and future-proofs for multi-recording flows. Mockup sizing (940px) is the reference.

## 2026-04-25 — Phase 5 trim re-encodes via VideoToolbox

Trim always re-encodes through `h264_videotoolbox`. No stream-copy keyframe-snap fast path. Frame accuracy beats UX surprises where cuts silently land on the nearest keyframe. Hardware encoding makes the cost negligible on Apple Silicon.

## 2026-04-25 — Share link expiration: none

Links are permanent. Mockup proposed 30 days; rejected to keep behavior simple. No expiration UI, no cleanup job.

## 2026-04-25 — Custom domain: no

Use the default Cloudflare Pages subdomain (e.g., `zeigen-share.pages.dev`). Custom domain adds DNS, cert renewal, and an external dependency without proportional value for a personal tool.

## 2026-04-25 — Old `~/Movies/Dashcast/` recordings: leave in place

No auto-migration on first Zeigen launch. Folder is harmless. Move or delete manually if/when desired.

## 2026-04-25 — Public name: Zeigen (not a codename)

Treat as final. Titlebars, save paths, viewer UI, share URLs all use "Zeigen." Pronunciation: TSIGH-gen (German "to show").

## 2026-04-25 — Tauri bundle ID: com.zeigen.app

Renamed from `com.dashcast.app` while still in dev. No installed builds in the wild, so no migration needed.
