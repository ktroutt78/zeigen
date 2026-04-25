# Phase 5: Post-record review + trim + annotate — Context

**Gathered:** 2026-04-25
**Status:** Ready for planning

## Phase boundary

A separate Tauri `review` window (940px wide, per mockup) opens automatically when a recording stops. The user can scrub, set trim in/out, place text labels and arrows as overlay annotations, and run "Save edits" to produce `<original>-edited.mp4`. "Discard edits" is non-destructive — resets the in-memory edit state but keeps the source recording. The Phase 6 export panel is rendered at full visual fidelity but inert.

Out of scope: re-opening an existing recording, destructive delete of the source, exporting to anywhere except the local edited mp4.

## Carried-forward decisions (DECISIONS.md + PLAN.md)

- Review is a separate Tauri window labeled `review`; main window stays hidden through review.
- Trim always re-encodes via `h264_videotoolbox` — no stream-copy / keyframe-snap fast path.
- Annotation schema is fixed: `type` (`text` | `arrow`), `start_time`, `end_time`, `position` (`x`, `y` as fractions of source-video dimensions), `content`. New annotations default to `[playhead, playhead+3s]`.
- Text rendered via ffmpeg `drawtext`. Arrows are pre-rasterized to transparent PNGs and composited via `overlay` with `enable='between(t,start,end)'`.
- "Save edits" → `<original>-edited.mp4` next to the source. "Discard edits" wording (not "Discard recording").
- Export panel scaffolded at full fidelity, opacity 0.4, `pointer-events: none`, "Coming in Phase 6" caption. Phase 6 only removes the disable.

## Implementation decisions

### Save-edits pipeline

- **D-01:** Single ffmpeg invocation. One `filter_complex` graph: input mp4 + N arrow PNGs as inputs; trim via `-ss`/`-to` on the input; `drawtext` for each text annotation; `overlay …:enable='between(t,start',end)'` for each arrow PNG; encode `h264_videotoolbox`. One re-encode per save.
- **D-02:** Trim handled by seeking the input with `-ss`/`-to` (not the `trim` filter). Annotation `start_time`/`end_time` get `-trimIn` applied in-filter so the saved file starts at `0:00` with annotations re-aligned.
- **D-03:** Arrow PNGs rasterized in Rust on Save (via the `image` crate or similar), sized to source-video dimensions. Written to a per-save temp dir, removed after ffmpeg succeeds.
- **D-04:** Temp/intermediate dir for a save: `~/Movies/Zeigen/.sources/edit-<basename>/`. Same hidden sources area used by Phase 3 webcam segments. Cleaned up on success; left in place on failure for debugging.

### Annotation editing UX

- **D-05:** Two-step placement. Click toolbar tool (or keyboard: `T` text, `A` text, `R` arrow — match mockup) → cursor enters placement mode. Text: single click on video places an empty text annotation at the click point, focused for typing. Arrow: click-drag on video defines start→end. Tool deactivates after a placement.
- **D-06:** Selection model: click an annotation to select it (selection ring per mockup). Drag the body to move. Drag corner handles to resize a text box / drag endpoints of an arrow. `Backspace` or `Delete` removes the selected annotation. `Esc` deselects.
- **D-07:** Text content is edited inline. Selected annotation body is `contentEditable`. Click to select; double-click (or start typing immediately on a fresh annotation) to edit; `Enter` or click-elsewhere commits.
- **D-08:** Annotation timing edited via the timeline pip. Drag the pip horizontally to shift; drag pip edges to change duration. New annotations default to `[playhead, playhead+3s]`. No numeric mm:ss inputs in Phase 5.

### Sidecar JSON persistence

- **D-09:** Sidecar is written debounced (~300–500ms) after every edit. State source of truth is in-memory React; the file is its persistent mirror. Crash mid-session loses at most ~half a second.
- **D-10:** "Discard edits" restores the snapshot taken when the review window opened, both in-memory and on disk. If the recording had no prior edits when review opened, the sidecar is deleted entirely on discard (no empty-state file left behind).
- **D-11:** Trim and annotations live in the same sidecar JSON: `{ trim: { in, out }, annotations: [...] }`. One file per recording. Trim is treated as another edit type.
- **D-12:** Re-opening review later is out of scope for Phase 5. Review opens only on stop. Sidecar is still written so a future "open recording" phase can land without schema migration.

### Review window lifecycle + playback

- **D-13:** Closing the review window with unsaved/unapplied changes shows a Save / Discard / Cancel modal. Default button: **Discard** (matches macOS convention — Pages, Numbers, TextEdit all default to "Don't Save"; the common close-with-edits case is "I changed my mind", and Enter should do the expected thing). Save stays explicit. `Esc` = Cancel. "Dirty" includes any difference from the snapshot taken on review open — covers both trim changes and annotation changes. Closing with no changes closes silently.
- **D-14:** On review close (whether via Save, Discard, or no-changes path), the main capture window is reshown.
- **D-15:** Starting a new recording while a review window is open is allowed. Tray Start works; the existing review window stays open in the background. When the new recording stops, a second review window opens with a unique label (e.g. `review-<stamp>`). Future-proofs the multi-recording flow.
- **D-16:** Player respects trim bounds during preview. Play starts at `trimIn`, stops at `trimOut`, and auto-loops within the trimmed range. The user can still scrub the playhead into the dimmed (out-of-trim) regions; entering the trimmed range from a scrub resumes loop semantics on next play.
- **D-17:** "Save edits" overwrites `<original>-edited.mp4` without prompt. The sidecar JSON is the canonical edit state; the mp4 is just its current render.

### Claude's discretion

- Modal styling for the close-prompt — match existing tokens, no new components.
- Exact debounce interval (300–500ms range).
- Selection ring exact thickness/offset (mockup is approximate).
- Empty-state visuals when no annotations exist.
- Keyboard repeat behavior for `Backspace` while focused on a text annotation in edit mode (default browser behavior is fine).
- Internal Rust module layout for the save-edits pipeline (likely `src-tauri/src/edit.rs` mirroring `composite.rs`).

## Canonical references

Downstream agents must read these before planning or implementing.

### Phase scope and decisions
- `docs/PLAN.md` §"Phase 5: Post-record review + trim + annotate" — full deliverable list and acceptance criteria.
- `docs/DECISIONS.md` (entries dated 2026-04-25) — review-window architecture, trim policy, scaffold strategy, "Discard edits" semantics.
- `CLAUDE.md` — project-wide coding standards (simplicity, no over-engineering, root-cause fixes, no emojis).

### Design system
- `docs/DESIGN.md` — index into the design system.
- `docs/design/surfaces/review.jsx` — canonical mockup for the review window. Layout, toolbar, video stage, timeline, action footer, and disabled export panel are all in here.
- `docs/design/tokens.css` (already copied to `src/styles/tokens.css`) — color, motion, spacing tokens.
- `docs/design/icons.jsx` (already at `src/components/icons.tsx`) — icon set used by the mockup.

### Engine + IPC
- `docs/IPC-SPEC.md` — Swift helper protocol. Phase 5 doesn't talk to the helper, but the `stopped` event payload (`output_path`, `duration_s`, etc.) is what triggers review window open.

## Existing code insights

### Reusable assets
- `src/components/icons.tsx` — `I.scissors`, `I.trash`, plus the inline arrow/text/checkmark `Icon` paths used in the review mockup.
- `src/styles/tokens.css` + `src/styles/global.css` — `mac-window`, `mac-titlebar`, `mac-traffic`, `btn-primary`, `btn-secondary`, `btn-ghost`, `hairline`, `kbd`, `select`, `segmented` classes from the capture window are reused as-is in the review window.
- `src-tauri/src/composite.rs` — pattern reference for the save-edits Rust module: build args vector, run `Command::new(FFMPEG_PATH)`, parse stderr on failure. Reuse `FFMPEG_PATH`/`FFPROBE_PATH` constants.
- `src/App.tsx` `recording_finalize` flow already returns `FinalizedRecording { final_path, … }` after `stopped`. Phase 5 hooks the review-window open onto that.

### Established patterns
- React inline styles + design tokens (no CSS-in-JS lib, no Tailwind-on-components in the existing TSX). Continue this in the review window.
- Tauri webview windows opened via `WebviewWindow` from `@tauri-apps/api/webviewWindow` (see `openBubble` in `App.tsx` for the canonical pattern). Same approach for the `review` window.
- Long-running native work in Rust commands; React side dispatches via `invoke` and listens via `listen`. Save-edits will follow this with progress events if it grows long enough to warrant them.
- Video file paths in `~/Movies/Zeigen/`. Sidecar JSON next to the source mp4 keeps that convention intact.

### Integration points
- `App.tsx` `recording_finalize` resolves with the final path. Add a step to spawn the review window (`new WebviewWindow("review", { url: "/#review?path=…", width: 940, height: 640 })`) when finalize resolves.
- Main-window hide-on-record logic (`useEffect` on `state`) already handles main visibility. The review-window-close handler will explicitly call `mainWin.show()` since `state` is back to `idle` by then.
- Tray Start / hotkey behavior is unchanged — review-window open does not gate them.

## Specific ideas

- "It should feel like CleanShot's review screen" — the mockup already pulls from that aesthetic.
- Save edits is a "render the current sidecar" operation, not a "freeze the preview" operation — the sidecar is the source of truth.

## Deferred ideas

- Re-opening an existing recording in review (no UI for this in Phase 5; sidecar schema supports it).
- Destructive delete of the source recording from the review screen (deferred to a future phase with a confirmation dialog — already noted in DECISIONS.md).
- Drag-an-mp4-onto-app to open in review (belongs in a later "recordings library" phase).
- Numeric mm:ss inputs for annotation timing.
- Multiple-segment trim (cut middle out, etc.) — single in/out only for Phase 5.
- Preset annotation styles, color picker, font size — single style for Phase 5.

---

*Phase: docs/PHASE-5-CONTEXT.md*
*Context gathered: 2026-04-25*
