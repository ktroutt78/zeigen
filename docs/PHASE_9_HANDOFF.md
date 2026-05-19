# Phase 9 close-out — Selected Area recording

Phase 9 **shipped 2026-05-18**. This doc captures what landed, the decisions worth preserving, and the next-session candidate phases.

## Status

All 6 build-order steps from the original plan (plus one user-driven UX shift in c6) landed on `main`:

```
479c9ee phase 9 c6: persistent area indicator + start/control chip
7cf6d15 phase 9 c5: countdown clamp + bubble anchor
a852ffe phase 9 c4: source picker integration
141e306 phase 9 c3: marquee overlay UI
3a6df90 phase 9 c2: rust + IPC area plumbing
c90c37d phase 9 c1: engine SCK sourceRect plumbing
```

## Done-when gate verified

Per `docs/PLAN.md` Phase 9:

- [x] Drag a marquee over any portion of any display.
- [x] Start a recording from the marquee selection.
- [x] Final mp4's dimensions match the selection exactly.
- [x] Picking Area auto-hides the bubble; switching back to Display/Window does NOT auto-restore.
- [x] Explicitly re-enabling a webcam in Area mode brings the bubble back, positioned at the **bottom-right corner of the selected region** (anchor logic in `openBubble`).
- [x] Switching between Display / Window / Area in the picker works without restarting the app. Selection persists across mode-switches.

## What landed beyond the original plan

c6 was originally scoped as small polish ("dashed border while recording so the user sees what's captured"). It grew during the session into a richer interaction model that the user explicitly steered:

1. Persistent dashed-red border around the selected region — visible from marquee-confirm through recording-end, not just during the active recording.
2. A small pill **just outside the bottom edge** of the selection that:
   - shows **"Start Recording"** when idle (clicking it starts the recording),
   - cycles to **`[dot] mm:ss [pause] [stop]`** during recording — the same UI as the bubble's inline pill.
3. On Stop, the selection is **stashed and cleared** so the indicator + pill disappear with the review window. "Record another" in the review restores from the stash; Save/Discard leave the selection consumed (user redraws next time).

This is now the primary trigger path for area recordings — the main app's Start Recording button still works as a fallback.

## Files added

- `src/MarqueeOverlay.tsx` — the drag-to-select overlay window component.
- `src/AreaIndicator.tsx` — the persistent dashed-border window.
- `src/components/RecordingControlPill.tsx` — shared pause/stop pill, reused in the timer-chip and parallel to the bubble's inline pill.

## Decisions locked (preserved from pre-phase + refined during build)

- **Bubble auto-hide in Area mode.** Entering area mode clears `selectedCamera`. Bubble stays off across mode switches until the user explicitly re-enables a webcam. Re-clicking the Area tile while already in area mode does NOT re-clear (preserves user's explicit choice mid-session).
- **Bubble anchor in Area mode.** Bubble lands at the bottom-right corner of the **selected region** (not the primary display's corner) so the explicit re-enable lands inside the recorded rect.
- **Single-display selection.** Marquee drag clamps to the display the drag started on.
- **Free-aspect drag.** No 16:9 / 1:1 / 9:16 presets.
- **Selection persists across mode-switches.** Display → Area → Display → Area preserves the rect.
- **No minimum selection size enforced.**
- **Selection consumed on Stop.** After stopping an area recording, the indicator + chip disappear and selectedArea clears. "Record another" restores from a single-slot ref. Save / Discard / any other path requires redrawing.
- **Countdown overlay spans the selected region** in area mode (not the host display). The component is `100vw/100vh`; sizing the window via `set_window_frame_cg` does the work.

## Gotchas worth knowing (next session)

- **SCK `sourceRect` semantics** confirmed by c1 spike: **logical points, display-relative, top-left origin.** No unit-system trap on this surface. `config.width/height` × `display.width / display.frame.width` keeps area output Retina-consistent with display/window paths. On M-series scaled Retina, scale resolves to 1.0 since SCDisplay reports points across the board (Phase 8 finding).
- **Tauri's `availableMonitors` returns positions in PHYSICAL pixels** chained across monitors at each monitor's own scale. Dividing by scale does NOT yield a consistent global logical coord space on mixed-scale multi-monitor setups — the timer chip landed on the wrong monitor before c6 switched it to `set_window_frame_cg`. Use `set_window_frame_cg` (CG points, top-left origin) for any cross-monitor positioning.
- **Tauri command argument types are strict.** `recordedDisplayX` etc. are `Option<i32>` on the Rust side; fractional point coords from the marquee fail JSON validation. `start()` rounds at the JS boundary via `Math.round()`. Add similar conversions for any new area-derived screen coordinates.
- **The Source enum is `RecordingSession.Source`, not `CaptureMode`**, despite the pre-phase handoff calling it `CaptureMode`. The Rust side has its own `CaptureMode` enum in `lib.rs`. Don't confuse them.

## Open from Phase 8, still deferred

- c6 focus-aware sort for window picker
- Tray Window submenu
- c8 edge cases (window closed mid-record, `on_screen: false` handling)
- Visual window picker (YAGNI)

## Closed Phase 8 items

- **Composite bubble size match** — WONTFIX. User accepted current behavior.

## Working tree state at close

`git status` clean. Latest commit: `479c9ee`. No stashed changes.

## Long-running dev (reminder)

```
nohup npm run tauri dev > /tmp/zeigen-dev.log 2>&1 & disown
```
Engine stderr lands in `/tmp/zeigen-dev.log` with `[engine]` prefix.

## Next session — Phase 10 candidate

User has agreed to scope these into Phase 10 (or split as needed). Both are tied to the **review window** (`src/Review.tsx`):

### 10.1 — GIF quick export

Replace the "Coming Later" placeholder in the QUICK EXPORT row of the review window with a working GIF export.

- Scope: short clips only, **no audio** (GIF doesn't carry audio anyway — simplifies the pipeline).
- Honor existing edits in the sidecar: **Trim**, **Text** annotations, **Arrow** annotations all apply to the GIF output.
- Output sizing: cap dimensions / frame rate so file size stays sane (specific limits TBD — research what Loom / similar tools default to).
- Path: ffmpeg `palettegen` + `paletteuse` for color-quantized GIF, or a single-pass low-fps option.
- Should respect the user's current trim window — only export the trimmed range.
- UX: clicking the GIF button should give immediate feedback (progress + save dialog like the MP4 path), no silent multi-minute waits.

### 10.2 — Timeline visualization

The current Timeline track is a decorative gradient (`src/Review.tsx`, search "TIMELINE"). Replace with something **functional** — leading candidate is **audio waveform**:

- Render the recording's audio amplitude across the timeline so the user can see where speech / sound happens, useful for trimming around content.
- Open question: how to extract the waveform — `ffmpeg -filter:a aresample,..., showwavespic` produces a still image, or pre-decode the AAC at low resolution into raw samples and draw on a `<canvas>`. Probably the latter for crisper visual + scrubbing affordances.
- Fallback if extraction is expensive: lazy-render after first paint of the review window so it doesn't block the user from playing the clip.
- Edge case: recordings with no microphone selected — show a flat/neutral track rather than failing.

### First action on next session

1. Open `docs/PHASE_9_HANDOFF.md` (this file) for full context.
2. Use `/gsd-add-phase` or equivalent to formalize Phase 10 in `docs/PLAN.md`. Suggested scope: split into 10.1 GIF and 10.2 Waveform, or keep as one phase with two deliverables.
3. The pre-phase handoff (originally referencing Phase 10 = "drawing tools") is now stale — drawing tools (text + arrow) already shipped in earlier phases. Reuse the Phase 10 slot for the work above.
