# Phase 9 handoff — Selected Area recording

Phase 9 is **not started**; this handoff captures the agreed plan and decisions so the next session can begin step 1 without re-litigating.

## Phase entry

See `docs/PLAN.md` Phase 9: Selected Area recording. Read that first — it's the source of truth for deliverables and the Done-when gate. Key product framing:

- Intended for **short clips** where the recording surface is much smaller than the full display.
- **Bubble is off by default in Area mode.** User can opt back in via the device picker if they want a webcam in the recording.
- Third capture mode alongside Display (Phase 2) and Window (Phase 8).

## Build order (agreed 2026-05-17)

Sequenced to put the technical risk first. SCK unit semantics bit Phase 8 (logical vs physical points at the JS→Rust boundary) — proving the engine layer works before any UI exists keeps that pain contained.

1. **Engine spike** — Add `CaptureMode::Area` variant in the Swift helper (`src-tauri/recording-engine/`). Wire `SCStreamConfiguration.sourceRect` (region of source display) and `destinationRect` (output frame). Hardcode a test rect like `{display_id: <primary>, x: 100, y: 100, w: 800, h: 600}` and verify the output mp4 is exactly 800×600 and shows the right region. One commit. **This step catches all the unit-system pain.**
2. **Rust + IPC** — Extend `engine_start` and IPC schema (`docs/IPC-SPEC.md`) to accept area params `{display_id, x, y, w, h}`. Plumb through `UiState` (new `source_kind = "area"` and `selected_area` field, mirroring Phase 8's `selected_window`).
3. **Marquee overlay UI** — Full-screen always-on-top transparent Tauri window per display. Dim mask with a draggable selection rectangle. Live `WxH` indicator. Esc cancels, Enter/double-click confirms, click on dim mask cancels. Must call `makeCaptureInvisible(window)` from Phase 3.5 so the overlay itself doesn't bleed into the recording.
4. **Source picker integration** — Add **Area** to the Display/Window picker. Choosing it routes to the marquee. Hide the bubble window + clear webcam selection from the engine call. Picker shows `Area 1280x720 @ Display 1` once a selection exists.
5. **Polish** — Countdown overlay (Phase 3.5) clamped to selected region. Tray Start gate extended to require a non-empty Area selection. Any UAT items that surface during testing.

## Decisions locked

- **Bubble auto-hide in Area mode.** Stays off until user explicitly re-enables (not auto-restored when switching back to Display/Window). Simpler state, fewer surprises.
- **Single-display selection only.** Marquee drag is clamped to whichever display the drag started on. Multi-display marquee is YAGNI.
- **Free-aspect drag.** No 16:9 / 1:1 / 9:16 presets in v1.
- **Selection persists across mode-switches.** User can flip Area → Display → Area without re-drawing the rect.
- **No minimum selection size enforced.** If user draws 50×50, that's the recording.

## Worth knowing from Phase 8

These are gotchas already documented in `docs/PHASE_8_HANDOFF.md` but they bear directly on Phase 9 — read them in context before step 1:

- **SCDisplay returns logical points, not physical pixels, on M-series macs in scaled "looks like" modes.** A 14" MBP at "More Space" returns 1470×956, not 2940×1912. Apple's docs are misleading here. Treat `DisplayInfo` from the engine as points across the board. For Area mode, the marquee will produce a rect in logical points; SCK's `sourceRect` expects... actually go verify what SCK expects for `sourceRect` against the SCK docs **before writing the spike** — this is the unit-system trap.
- **Engine needs `_ = NSApplication.shared` at startup** (already in `main.swift` since Phase 8). Required for any AppKit-touching code path in the helper.
- **Window filter pattern** (`Engine.swift::filterShareableWindows`) is the model for the new `CaptureMode::Area` enumeration / setup code. Phase 8 added `CaptureMode` enum; extend it, don't replace.
- **Engine errors must use `recording_cleanup_local`, not `recording_reset`** (App.tsx error handler). The latter sends Stop to an already-idle engine → INVALID_STATE → original error gets overwritten.
- **DisplayLink-driven displays** can be enumerated but `NSWindow.setFrame` on them is unreliable. Marquee overlay placement on those displays may not render — same constraint as Phase 7's identify-display button. Document this if it bites.

## Worth knowing from the 2026-05-17 session (not started)

- The bubble framing model (resize-as-zoom vs resize-as-viewport) was explored at length this session. Conclusion: **leave it as-is** (object-fit: cover, scale-to-bubble). The viewport model requires either a separate zoom control or a much larger default bubble — neither is worth doing now. **Do not revisit unless the user asks.**
- A draft `crop=target:target` change to `src-tauri/src/composite.rs` was applied and then reverted within the session. Working tree is clean on that file.
- `WebcamBubble.tsx` was likewise edited and reverted. Working tree is clean.
- Only `docs/PLAN.md` has uncommitted changes — the Phase 9 entry and the Post-Phase-10 renumber.

## Long-running dev

From the Phase 8 handoff (still applies):
```
nohup npm run tauri dev > /tmp/zeigen-dev.log 2>&1 & disown
```
Engine stderr lands in `/tmp/zeigen-dev.log` with `[engine]` prefix.

## Open Phase 8 items, deferred to after Phase 9

Per `docs/PHASE_8_HANDOFF.md`, these are still open:
- Composite bubble size match (the user accepted current behavior — closed as WONTFIX unless reopened)
- c6 focus-aware sort for window picker
- Tray Window submenu
- c8 edge cases (window closed mid-record, on_screen false handling)
- Visual window picker (deferred, YAGNI)

None block Phase 9. Revisit after Phase 9 ships.

## First action on next session

Open `docs/PLAN.md` and `docs/PHASE_8_HANDOFF.md`, then start step 1 of the build order above (engine spike with hardcoded rect). Commit the spike as `phase 9 c1: engine SCK sourceRect plumbing`.
