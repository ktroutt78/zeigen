# Phase 14: Final v1.0 polish — Context

**Gathered:** 2026-05-20
**Status:** Ready for planning

## Phase boundary

Two independent v1.0-shippable items that don't share implementation surface but do share the "polish before tag" framing. Sequence-independent — either can ship first.

1. **Webcam bubble opens on wrong display (14.1)** — `openBubble` in `src/App.tsx:25-93` defaults to `availableMonitors()[0]` (typically the OS primary) instead of the user-selected recording target. When the user picks a non-primary screen in the source picker, the bubble lands on a different display than the one being recorded. The fix is a placement plumbing change: switch the bubble's window creation off Tauri's constructor x/y/w/h (which has known macOS multi-display issues — half-size landings, dropped negative-x coords for screens-left-of-primary) onto the `set_window_frame_cg` path already used by the countdown overlay and identify overlays. Anchor the new placement to the picker's `selectedDisplay` (or window-mode host display). Capture-time UI only — no recording-pipeline change.

2. **Review preview audio parity (14.2)** — surfaced 2026-05-20 after Phase 12 c3 shipped. Review-window playback today uses raw scratch audio; the saved file gets `arnndn` noise reduction applied at save time. Users can't audibly verify NR before sharing — the 18:04 anomaly path on the May 20 ship recording is the canonical "NR over-suppressed speech" case the user didn't catch until after upload. Fix: generate a preview MP4 with `arnndn` applied at review-open (or first-play), point the `<video>` element at it. Audio-only parity — no trim, no annotations. Saved files unchanged. Capture pipeline unchanged.

Out of scope: WASM RNNoise in-browser (rejected — bundle weight + can't match save-time output byte-for-byte), on-demand A/B toggle (rejected — UI complexity not earned), capture-side limiter (12.3, still queued), settings persistence for bubble position-per-display, MP4 atom parse for display IDs, bubble-follows-cursor or bubble-snaps-to-active-screen behaviors, full export-pipeline parity in preview (trim + annotations), waveform regeneration for the preview file (reuses the existing audio-meta probe; waveform draws against the original scratch as today).

## Carried-forward decisions (PLAN.md, prior phase contexts, DECISIONS.md, CLAUDE.md)

- **Saved files unchanged** (Phase 12 D-01, Phase 5.5 reversibility): preview generation is a session-scratch artifact. The committed `~/Movies/Zeigen/recording-….mp4` still runs through the existing save pipeline; nothing about save changes in Phase 14.
- **Single ffmpeg/ffprobe invocation per intent** (Phase 5 D-01, Phase 10 D-06, Phase 12, Phase 13): the preview file is generated once per review-open per recording. No caching across opens (regenerated each time — D-11).
- **NSWindow.setFrame is the canonical macOS multi-display window placement primitive** (carried from Phase 7 identify overlays, Phase 3.5 countdown overlay): Tauri's constructor x/y and `set_position` both have known multi-display bugs on macOS — half-size landings (countdown precedent, `App.tsx:119-121`), dropped negative-x for screens-left-of-primary (`macos.rs:70-72`), wrong-screen resize from two-step `setFrameOrigin + set_size` (`macos.rs:96`). New placements that target non-primary displays route through `set_window_frame_cg` (`src-tauri/src/macos.rs:74-109`).
- **Bubble anchor semantics already established for Area mode** (PLAN.md Phase 9, PHASE_9_HANDOFF.md:50): "Bubble lands at the bottom-right corner of the selected region (not the primary display's corner)." Phase 14 extends this principle from "selected region" to "recording target" generally — display mode and window mode get the same intent.
- **Display ID is the canonical screen identifier**, not ordinals into `availableMonitors()` (PHASE_8_HANDOFF.md fix to LOGICAL points + display-ID-keyed coords). The picker's `selectedDisplay: number | null` is the SCDisplay ID; that ID is the lookup key into the `displays` array which carries the SCK-reported frame.
- **arnndn pipeline is already factored for video-copy + audio-only re-encode** (`edit.rs:721-722`, `mp4_video_can_copy` branch): when there's no trim and no overlay work, video bitstream copies and only audio re-encodes. The preview-file pipeline is exactly this branch — no new ffmpeg invocation shape.
- **Coding standards** — simplicity, no over-engineering, no defensive programming, no emojis (CLAUDE.md).

## Implementation decisions

### 14.1 — Webcam bubble placement (capture-time)

- **D-01: Bubble anchor source = recording target.** In display mode, the anchor is the rect of the user's `selectedDisplay`. In window mode, the anchor is the rect of the captured window's host display (the same display the engine routes window capture from). In area mode, anchor is the selected region rect (unchanged from today). When no source is selected yet (cameraName set but `selectedDisplay == null`), fall back to the primary display rect — picker-driven re-anchor (D-03) corrects it as soon as the user picks a screen.
- **D-02: Placement plumbing adopts `set_window_frame_cg`.** Mirror `openCountdown`'s pattern (`App.tsx:111-168`): create the `WebviewWindow` with a dummy initial size, then on `tauri://created` invoke `set_window_frame_cg` with the target rect in CG coords + the primary display's Cocoa height. Constructor `x`/`y`/`width`/`height` are no longer load-bearing for placement — they're just initial placeholders. The existing `make_capture_invisible` invocation already fires from the same `tauri://created` hook; the new placement call lands alongside it.
- **D-03: Re-anchor on picker change uses move-if-off-screen.** Extend the `openBubble` effect's deps in `App.tsx:1342` to include `selectedDisplay` (and the window-mode equivalent). On change: if the bubble's current rect intersects the new target's display bounds (any overlap), leave it where the user dragged it. If it has zero intersection, re-place to the new target's bottom-right corner with `BUBBLE_MARGIN`. Don't tear down the window — just call `set_window_frame_cg` again. Re-using the same placement primitive keeps the path uniform.
- **D-04: Window mode initial placement mirrors area mode.** Anchor to the captured window's bottom-right corner (with `BUBBLE_MARGIN`), not the host display's corner. Rationale identical to PHASE_9_HANDOFF.md:50 area-mode rationale — bubble lands inside the recorded frame. After initial placement, the existing IPC window-frame update path (`docs/IPC-SPEC.md:162`, 5Hz) continues to drive bubble follow as the captured window moves.
- **D-05: Naming reconciliation via display ID.** Placement looks up the target display in the `displays` state by ID (the SCK-reported ID the picker already uses), never by ordinal into `availableMonitors()`. The picker's "Display 1..N" alpha-sorted labels are display-side cosmetic; the underlying ID is the canonical identifier and matches engine-side.

### 14.2 — Review preview audio parity

- **D-06: Approach = background-generated preview file.** Run `arnndn` (reusing the existing pipeline in `edit.rs:725-745`) over the scratch audio at review-open, mux back with a video-stream copy, write to `.scratch/<id>/preview.mp4`. Point the review `<video>` at the preview file when ready. WASM-RNNoise rejected (bundle weight, not byte-equivalent to save-time output, drifts if capture-side audio work ships later). On-demand A/B toggle rejected (UI complexity not earned for a personal tool).
- **D-07: Preview file location and lifecycle.** `~/Movies/Zeigen/.scratch/<id>/preview.mp4` — sibling to the scratch MP4 and its sidecar. Regenerated on each review-open (no across-open persistence; the source scratch can't change between opens anyway, so the regenerate is a constant cost rather than a hit-rate game). Cleaned up by the existing scratch-lifecycle paths: scratch-discard removes the directory wholesale; save replaces it; close-without-commit removes it. No new cleanup code needed.
- **D-08: Eager vs lazy decided by measurement at planning time.** Time the `arnndn` pass against a representative scratch recording (suggest the Phase 13 c3 baseline or a fresh 1-2 min take). Threshold: **<2s → eager** (run at review-open, block the `<video>` swap behind it; user sees the same review-open delay they already accept for thumb-sprite extraction). **≥2s → lazy** with a visible "Preview generating…" status pip; raw scratch plays until preview is ready, then swap. Both paths share the same backend command — the difference is purely when the frontend calls it.
- **D-09: Preview scope = audio-only.** No trim, no annotations. Trim/annotation are export-time concerns; preview's only job is "let the user hear what NR did to the audio." This also matches the existing `mp4_video_can_copy` branch shape — no filter graph, no overlay work, just `arnndn` on audio + video-stream copy. Cheap and consistent with the save pipeline's noop-edit path.
- **D-10: Fallback = status pip + raw scratch playback.** If the preview generation fails or errors, the review keeps the raw scratch as the `<video>` source and shows a "Preview is raw — NR failed, save will still apply NR" status pip in the review chrome. Doesn't block playback, doesn't block save (export-side NR runs independently from the save pipeline, unchanged). Loud-failure path rejected — this is a personal tool, NR-fail is rare, and the user can still save and verify the file post-hoc if needed.
- **D-11: Forward-compat with capture-side audio work.** When the Phase 12 c3 capture-side limiter (still queued) ships, the preview file naturally stays in parity — `arnndn` operates on the same scratch audio that the limiter would already have shaped at capture time. No Phase 14 code change needed when 12.3 lands.
- **D-12: Waveform unchanged.** The Phase 13 c3 waveform continues to read the scratch source for its bucketing pass — the preview file is for `<video>` audio playback only, not for visual representation. Waveform amplitude already represents the unprocessed source, which is the right reference for the clipping highlight (Phase 12 c1). Keeping the waveform on scratch also means the Phase 13 audio-meta probe and S-offset math don't need re-pointing. **Consequence:** amber clipping indicators (Phase 12 c1) reflect the pre-NR signal, while playback and saved files are post-NR. The waveform shows what the mic captured; the audio represents what the user will share. For v1.0 this asymmetry is acceptable since clipping indicators are most useful as a capture-quality signal, not an export-quality signal.

### Claude's Discretion

- Exact name for the new Rust command (`generate_preview_audio`, `preview_render`, etc.) and exact name for any preview-related state in `Review.tsx` (e.g. `previewUrl`, `previewState`).
- Whether the preview-file generation is a dedicated `#[tauri::command]` or reuses an existing pipeline entry point with a "preview" flag — either is acceptable; lean toward a thin new wrapper to keep the save pipeline untouched.
- Exact form of the "Preview generating…" status pip (D-08 lazy path) and the "Preview is raw" fallback pip (D-10) — visual treatment to be decided at implementation time, in line with existing status-pip patterns in the review chrome.
- Exact form of the move-if-off-screen heuristic (D-03) — bounding-box intersection check is the simple implementation; could also tolerate "mostly visible" if rect intersection only at the edge feels janky in practice.
- Test approach for the new commands — likely `#[ignore]` baseline tests against the Phase 13 c3 fixture, mirroring the `probe_audio_track_baseline` pattern.
- Whether `selectedDisplay`-change re-anchor (D-03) should debounce or fire immediately — start with immediate; debounce only if rapid picker toggling feels bad in manual UAT.
- 14.1 and 14.2 are independent. Commit order is open to planning; suggest 14.1 first (smaller blast radius, single file region) followed by 14.2 (touches both Rust and TS).
- The eager-vs-lazy measurement for D-08 should run during planning (or earliest execution step) so the implementation choice is grounded in real timing, not a guess.

## Code context

### Reusable assets

- `src-tauri/src/macos.rs:74-109` (`set_window_frame_cg`) — the canonical multi-display window placement primitive. Already used by countdown overlay (`App.tsx:111-168`) and identify overlays (`App.tsx:179+`). Bubble placement adopts the same shape.
- `src/App.tsx:111-168` (`openCountdown`) — the precedent for "create with placeholder size, set_window_frame_cg on `tauri://created`, make_capture_invisible alongside." Direct template for the bubble fix.
- `src/App.tsx:25-93` (`openBubble`) — the file region under edit. Already has the right effect shape for camera-driven lifecycle; the change is to the placement path inside it, not the lifecycle around it.
- `src/App.tsx:1324-1342` — the effect that calls `openBubble`. Deps list extends; anchor computation extends.
- `src-tauri/src/edit.rs:721-745` — the `mp4_video_can_copy` branch + `arnndn` audio pipeline. The preview-file command is exactly this shape pointed at `.scratch/<id>/preview.mp4`.
- `src-tauri/src/edit.rs:880-895` — `audio_model_path()` is the model resolver already in use. Preview reuses it.
- `src/Review.tsx` — fetches sidecar / sprite / audio-meta at review-open. The preview-file fetch lands in the same effect group, same lifecycle window.

### Established patterns

- **Create webview with placeholder size + set_window_frame_cg on tauri://created** (countdown, identify overlays). The bubble adopts this for placement.
- **Probe / generate at review-open, store in component state, clean up on close** (Phase 12 c3 audio model, Phase 13 c3 audio-meta probe, thumb sprite). Preview file follows the same lifecycle, just with a longer-running subprocess for the lazy path.
- **Scratch lifecycle owns all per-recording temp artifacts** (Phase 5.5 D-04 + DECISIONS.md). Preview file lands inside the scratch dir so the existing cleanup paths sweep it without code change.
- **Display ID is the canonical screen identifier across the JS↔Rust boundary** (PHASE_8_HANDOFF.md). Bubble placement uses ID-keyed lookups into `displays` state.

### Integration points

- `src/App.tsx` — `openBubble` placement plumbing change (14.1); effect deps extension (14.1); preview-file invocation hook in Review-open path is in `Review.tsx`, not here.
- `src/Review.tsx` — preview-file fetch + state + `<video>` source swap (14.2); status pip surfaces for D-08 lazy state and D-10 fallback.
- `src-tauri/src/edit.rs` — new public function + `#[tauri::command]` for preview generation (14.2). Reuses the existing arnndn pipeline shape; no save-pipeline changes.
- `src-tauri/src/lib.rs` — register the new preview command in `invoke_handler![…]` (14.2).
- `src-tauri/src/macos.rs` — no change. Existing `set_window_frame_cg` is reused.

## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase scope and intent
- `docs/PLAN.md` §"Backlog" — preview audio parity entry (line 236) is the verbatim source for 14.2. The webcam-bubble-wrong-display bug surfaced 2026-05-20 and is NOT in the existing backlog; this CONTEXT doc is its source of truth.
- This document (`docs/PHASE-14-CONTEXT.md`) — resolved decisions.

### Inherited bubble / capture-UI code
- `docs/PHASE_8_HANDOFF.md` — bubble position log units (LOGICAL points), display-ID-keyed coords. The 14.1 fix preserves these conventions.
- `docs/PHASE_9_HANDOFF.md:50` — bubble-anchor-to-selected-region precedent in area mode. 14.1 generalizes this to display + window modes.
- `docs/PLAN.md` §Phase 3.5 — bubble lifecycle + makeCaptureInvisible utility.
- `docs/PLAN.md` §Phase 7 — identify overlays + DisplayLink limitation. The set_window_frame_cg precedent ships in this phase.
- `docs/DECISIONS.md` 2026-04-25 — bubble position log coordinate semantics. Unchanged by 14.1.
- `docs/DECISIONS.md` 2026-04-26 — DisplayLink limitation. 14.1 inherits this — bubble placement on a DisplayLink display has the same NSWindow.setFrame caveat as identify overlays do. No fix at the application layer; reuse the same "won't render reliably on DisplayLink screens" caveat.
- `docs/IPC-SPEC.md:162` — window-frame update IPC for window-mode bubble follow. 14.1's D-04 inherits this for window mode.

### Inherited audio / review code
- `docs/PHASE-12-CONTEXT.md` and `docs/PHASE-12-PLAN.md` — Phase 12 c3 added the arnndn pass at save time. Preview generation reuses the same pipeline shape.
- `docs/PHASE-13-CONTEXT.md` and `docs/PHASE-13-PLAN.md` — the audio-meta probe + waveform alignment fix. 14.2 leaves both unchanged (D-12).
- `docs/PLAN.md` §Phase 5.5 — scratch-and-commit save model. Preview file lives inside the scratch dir, swept by the existing lifecycle.

### Project guardrails
- `CLAUDE.md` §"Coding standards" — simplicity, no over-engineering, no defensive programming, no emojis.
- `CLAUDE.md` §"Known gotchas" — Continuity Camera drop, single-audio-source A/V sync rule, ffmpeg avfoundation NOT for screen capture, DisplayLink window-placement caveat.

### Files under edit
- `src/App.tsx` — `openBubble` placement plumbing + effect deps (14.1).
- `src/Review.tsx` — preview-file fetch + state + status pip surfaces (14.2).
- `src-tauri/src/edit.rs` — new preview-render command (14.2).
- `src-tauri/src/lib.rs` — register the new command (14.2).

### ADR slot

14.1 is a bug fix that extends an already-established pattern (set_window_frame_cg for non-primary displays); no new contract to record.

14.2 introduces the **preview-file artifact** as a new per-recording scratch sibling. If a future phase needs review-time previews for other transforms (e.g. a limiter A/B, a color-grade preview), the preview-file pattern becomes a contract worth an ADR entry. For now, single-use; revisit if it grows.

## Deferred Ideas

- **WASM RNNoise in browser** — rejected for bundle weight + drift from save-time output. Reconsider only if scratch-side preview generation proves too slow to be tolerable even in the lazy path.
- **On-demand A/B toggle (raw vs NR)** — rejected for UI complexity. Reconsider only if users repeatedly ask "did NR change this?" — the audible-comparison need is currently latent, not validated.
- **Full export-pipeline parity in preview** (trim + annotations applied to preview file) — out of scope. The backlog framing is *audible* verification of NR, not full WYSIWYG preview. If WYSIWYG preview becomes a separate goal, it's a different phase.
- **Settings persistence for bubble position-per-display** — out of scope. Settings persistence in general is on the backlog (`PLAN.md` line 230); when that lands, per-display bubble position is one of the candidate keys.
- **Auto-snap-to-recording-target on every picker change without override** — rejected (D-03 chose move-if-off-screen). Too disruptive when the user has deliberately dragged the bubble.
- **Persistent caching of the preview file across review-opens** — premature optimization. The arnndn pass is single-pass audio-only; a typical recording costs a few hundred ms. Persisting adds invalidation complexity (scratch source can't change, but the cache invalidation contract is still a maintenance cost).
- **Waveform regeneration against the preview file** — out of scope (D-12). The waveform's job is clipping detection on the unprocessed source; rendering against NR-processed audio would hide the clipping the user needs to see.
- **Bubble repositioning during recording when picker changes** — out of scope. Phase 14 re-anchor logic (D-03) fires only at idle / pre-record. Mid-record picker changes are already a no-op in the engine; bubble follows that.

---

*Phase: 14-final-polish*
*Context gathered: 2026-05-20*
