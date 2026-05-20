# Phase 11: Review window UX overhaul — unified export + timeline scrubbing — Context

**Gathered:** 2026-05-19
**Status:** Ready for planning

## Phase boundary

Two coupled deliverables in the review window:

1. **Unified export flow** — collapse the footer Save action and the sidebar Quick Export section into one format-selector Save block in the sidebar. Saving in any format commits the scratch recording (moves it from `~/Movies/Zeigen/.scratch/<id>/` into `~/Movies/Zeigen/`) and produces the chosen output file in a single action. Eliminate the disabled MP4 / ProRes buttons that were the visible symptom of the doubly-split surface.
2. **Timeline scrubbing** — replace the static playhead (`pointerEvents: "none"` at `src/Review.tsx:1858`) with a draggable playhead via track-anywhere drag. Add a hover/drag frame preview backed by a pre-generated thumbnail sprite.

Out of scope: ProRes format (its own phase), waveform changes (Phase 10 already shipped), GIF pipeline changes (Phase 10), Save-As file-picker dialog (auto-save to `~/Movies/Zeigen/` preserved), settings persistence across restarts (existing backlog item), close-prompt redesign beyond what falls through from the unified Save model, trim-handle snap-to-peaks, waveform zoom, multi-save Reveal disambiguation logic beyond "most recently saved".

## Carried-forward decisions (PLAN.md, PHASE-5-CONTEXT.md, PHASE-10-CONTEXT.md, DECISIONS.md, CLAUDE.md)

- **iPhone-screenshot model** — explicit Save = keep, Discard = throw away (Phase 6, Phase 5.5).
- **Single ffmpeg invocation per save** — Phase 5 D-01, Phase 10 D-06. The unified save extends the existing graph; thumbnail extraction is a separate background pass and does not count toward this rule.
- **Sidecar JSON edit pipeline** — trim, text, arrows live in the sidecar (Phase 5 D-09, D-10). The unified save reads the same sidecar; format is the only new dimension.
- **Auto-save to `~/Movies/Zeigen/`** — no system Save dialog; filename follows the established `recording-<stamp>.<ext>` pattern (Phase 6, Phase 10).
- **24h app-launch cache sweep** — pattern from Phase 6 exports. The new thumbnail cache uses the same sweep.
- **Save/Discard/Cancel close-prompt default = Discard** — macOS convention (DECISIONS.md 2026-04-25). Unchanged here. Modal still fires when the red X is clicked pre-commit.
- **LinkedIn 10-minute confirm** — Phase 6. Unchanged.
- **GIF >30s confirm** — Phase 10 D-04. Unchanged.
- **Settings reset on app restart** — format / resolution / fps selections do not persist (PLAN.md Backlog).
- **Coding standards** — simplicity, no over-engineering, no defensive programming, no emojis (CLAUDE.md).

## Implementation decisions

### Sidebar layout (unified export)

- **D-01:** No footer. The review window's bottom button strip (`src/Review.tsx:~1939-2059`) is removed. The sidebar grows to hold everything.
- **D-02:** Sidebar order top-to-bottom: **SAVE** block → divider → **OR EXPORT TO…** (Copy, LinkedIn, Reveal post-commit) → divider → **lifecycle** (Record another, Discard).
- **D-03:** Discard stays scoped to scratch (pre-commit only). Post-commit, Discard greys to disabled — matches the current `scratchOpsEnabled = !busy && !committed` gating at `Review.tsx:1938`. Discard visual treatment: red tint (`var(--recording-tint)`), ghost background, de-emphasized, bottom of sidebar.
- **D-04:** Record another remains active in all states (pre-commit, mid-save, post-commit). Same iPhone-screenshot cleanup pattern as Phase 6.

### Save semantics

- **D-05:** **Save unifies commit + export.** Clicking Save in any format moves the scratch recording to `~/Movies/Zeigen/` AND produces the chosen output file in one pass. There is no separate "commit" action.
- **D-06:** Format selector chips: `[ MP4 | GIF ]`. **ProRes is excluded from Phase 11 entirely** — no disabled stub, no "Coming later" caption. ProRes lands when its own phase ships and the chooser grows then.
- **D-07:** **MP4 default 1080p. Presets `480p | 720p | 1080p | Source`.**
  - *Rationale (capture in DECISIONS.md):* large-display recordings produce source files (often >3840px wide) that are unwieldy to share — recipients struggle to download, open, or paste them into other tools. The primary save path needs first-class resolution scaling, not just GIF. 1080p is the widely-shareable sweet spot and the right default; Source remains available for max-quality cases.
- **D-08:** **GIF default 720p. Presets `480p | 720p | Source`.** Carried from Phase 10 D-01.
- **D-09:** **GIF FPS default 15. Presets `10 | 15 | 20`.** Carried from Phase 10 D-02. The FPS row is visible only when GIF is the selected format; it hides (snap, no animation) when MP4 is selected.
- **D-10:** Save button label is descriptive: `Save as MP4`, `Save as GIF`. Changes on format switch.
- **D-11:** **Same-format re-save suffixes the file.** Second click of `Save as MP4` writes `recording-<stamp>-2.mp4`, third writes `-3.mp4`, etc. Suffix scope is per-format — saving GIF after MP4 writes `recording-<stamp>.gif` (no collision because the extension differs).

### Post-commit behavior

- **D-12:** Save block **remains usable post-commit**. Each subsequent Save click produces an additional file. Transient `Saved ✓` indicator flashes inline ~1.5s after each save, then the button returns to `Save as <format>`. The format selector and preset chips stay interactive throughout.
- **D-13:** **Reveal becomes a new row** in the OR EXPORT TO… destinations area (4th row, after Copy and LinkedIn). Hidden until first commit; always visible after. Points to the **most recently saved file** (chronological, not format-prioritized).
- **D-14:** Close-window red X behavior unchanged from Phase 6 — silent if any save has happened, Save/Discard/Cancel modal if no save yet (Discard default per DECISIONS.md 2026-04-25). "Any save" in the new model means "any format clicked Save at least once."

### Copy / LinkedIn semantics

- **D-15:** **Copy to Clipboard remains ephemeral** — does not commit. The action hands an MP4 to NSPasteboard from a temp cache; nothing persists at `~/Movies/Zeigen/`. The user's mental model already treats clipboard as transient.
- **D-16:** **Export for LinkedIn commits.** The action produces a persistent `recording-<stamp>-linkedin.mp4` at `~/Movies/Zeigen/`, so the scratch source should also commit. After clicking LinkedIn, the recording is saved and Reveal appears.

### Timeline scrub interaction

- **D-17:** **Track-anywhere drag-to-scrub.** Pointerdown anywhere on the track + pointermove begins a continuous scrub. Pointerdown + pointerup with no movement above a small threshold = a click (preserves the existing seek-on-click behavior at `Review.tsx:1664`). Click-vs-drag threshold is planner-discretion (a few pixels of cursor movement is typical).
- **D-18:** **Playhead retains a stronger cursor affordance.** When the cursor hovers the playhead element specifically (the white circle + line at `Review.tsx:1847-1873`), cursor changes to `ew-resize` (or `grab` — planner picks). Communicates "this is the live position; grab here to scrub from here" without breaking the track-anywhere-drag model.
- **D-19:** **Pause-on-grab, resume-on-release.** If the video was playing when the drag began, pause it for the duration of the drag. On pointerup, resume playback from the new position. If the video was already paused, stay paused. Same behavior whether the drag started on the playhead or elsewhere on the track.

### Frame preview

- **D-20:** **Pre-generated thumbnail sprite.** On review-window open, kick off a background ffmpeg pass that extracts ~200 thumbnails (planner-discretion on exact count and dimensions; ~160×90 is the working assumption) into a single sprite PNG cached at `~/Library/Caches/com.zeigen.app/thumbs/<id>.png`. Hover/scrub paints a region of the sprite into a small floating element near the cursor — instant once the sprite is ready.
- **D-21:** **Off-screen `<video>` fallback while extracting.** A hidden second `<video>` element seeks to the hover position and draws the current frame to a canvas. Used until the sprite finishes extracting; bridge-only, not the permanent path.
- **D-22:** **Preview visible both on hover AND during drag-to-scrub** (YouTube convention). The thumbnail anchors near the cursor as a small floating preview; the main video element updates in real time during the drag. Coexistence is intentional — the small thumb is a tight reference at the cursor while the main video carries the full visual context.
- **D-23:** **24h app-launch sweep** removes stale thumbnail caches. Mirrors the existing Phase 6 sweep for `~/Library/Caches/com.zeigen.app/exports/`.

### Claude's Discretion

- Exact thumbnail count and pixel dimensions (~200 × 160×90 working assumption; planner picks based on sidebar width and recording-length distribution)
- Whether the floating preview thumbnail includes a timestamp overlay label (mm:ss). Leaning yes — Loom and YouTube both do, and it's cheap.
- Snap vs animated reveal for the FPS row on format change (snap is fine; no animation needed)
- Specific cursor token on playhead hover (`ew-resize` vs `grab` vs `col-resize`)
- Pixel/ms threshold for click-vs-drag detection on the track
- ffmpeg extraction strategy for the sprite — single pass with `-vf fps=N,scale=W:H,tile=COLSxROWS` vs per-thumb invocations
- ⌘S Save keyboard shortcut (probably yes; mirrors the existing ⌘C for Copy)
- Whether "OR EXPORT TO…" header text changes after first commit (e.g., to "Also export to…")
- Floating preview position relative to cursor (above the track, offset from cursor) and bounds-clamping at the edges of the timeline
- Section header text: `SAVE` / `OR EXPORT TO…` are working assumptions
- File location for new components (`src/ThumbStrip.tsx`, `src/ScrubPreview.tsx`, or inline) — `Review.tsx` is already 2,679 lines, so extraction is welcome
- Whether the SAVE block visually compresses (collapses headers, smaller padding) post-commit to give visual primacy to Reveal

## Code context

### Reusable assets

- `src/Review.tsx` — review window. Key sections:
  - `ExportPanel` (2209+) — gets the full restructure
  - `Timeline` (1622+) — gets the scrub + preview overlays
  - Footer button strip (~1930-2059) — removed
  - Trim handle pointermove pattern (1634-1662) — the closest analog for the new track-anywhere drag
  - Annotation pip drag pattern (1773-1803) — second analog
- `src-tauri/src/edit.rs` — `run_edit_pipeline` + `PipelineMode` from Phase 10. The unified save extends this — either by adding commit semantics to the existing entrypoint or by wrapping it in a new `unified_save` command. (Planner picks.)
- `src-tauri/src/linkedin.rs` — `linkedin_export` pattern for "produce a persistent file at `~/Movies/Zeigen/`". The unified save needs the same destination resolution + filename logic, generalized over format.
- Phase 6 cache-sweep code (Rust side) — pattern for the new thumbs cache.
- Tauri `convertFileSrc` — already used to load mp4 into `<video>`; same for the sprite PNG.
- `Waveform.tsx` (Phase 10) — pattern for a self-contained canvas component with its own lifecycle. The hover-preview component should mirror this shape.

### Established patterns

- Pointermove drag pattern from trim handles (`Review.tsx:1634-1662`) — track-anywhere drag for the playhead should follow this shape: window-level pointermove + pointerup, ref to the track's bounding rect, clamp to bounds.
- Single ffmpeg invocation per user save action (Phase 5 D-01, Phase 10 D-06) — unified save extends the existing graph; the thumbnail-extraction pass is a separate background spawn and does not count.
- Sidecar JSON read on review-open (Phase 5) — the thumbnail extraction can hang off the same review-open hook.
- 24h cache sweep at app launch (Phase 6) — same pattern for the new `~/Library/Caches/com.zeigen.app/thumbs/` directory.
- Transient "Exported ✓" badge pattern (`linkedinExportedAt`, `gifExportedAt` at `Review.tsx:2260, 2315`) — the unified Save's post-save flash uses the same 1500ms timer + state-flag shape.
- Per-format suffix on filename collision — new pattern; closest existing analog is the LinkedIn output's `-linkedin` suffix in `linkedin.rs:62+`.

### Integration points

- `src/Review.tsx` — ExportPanel rewrite, Footer removal, Timeline scrub handlers, new preview overlay.
- `src/ScrubPreview.tsx` (new file, naming planner-discretion) — floating thumbnail component, sprite-painted, with off-screen `<video>` fallback while sprite is extracting.
- `src-tauri/src/edit.rs` or new wrapper — unified `save_recording` command that takes `(stamp, source_path, format, resolution, fps?)` and commits + exports atomically.
- `src-tauri/src/thumbs.rs` (new file, naming planner-discretion) — `extract_thumb_sprite(source_path, out_path)` command; called from JS on review-open.
- `src-tauri/src/lib.rs` — register the new commands.
- `src-tauri/src/cache.rs` (or wherever Phase 6's sweep lives) — extend the 24h sweep to include `~/Library/Caches/com.zeigen.app/thumbs/`.

## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase scope and intent
- `docs/PLAN.md` §"Backlog → Phase 11 (proposed): Review window UX overhaul" — phase scope as captured pre-discussion
- This document (`docs/PHASE-11-CONTEXT.md`) — resolved decisions

### Inherited pipeline
- `docs/PHASE-10-CONTEXT.md` and `docs/PHASE-10-PLAN.md` — format precedent for context + plan structure, GIF pipeline, waveform component patterns
- `docs/PHASE-5-CONTEXT.md` §"Save-edits pipeline" — filter_complex graph, trim semantics, arrow rasterization (D-01..D-04)
- `docs/PHASE-5-CONTEXT.md` §"Annotation editing UX" + §"Sidecar JSON persistence" — annotation timing model and persistence
- `docs/PLAN.md` §"Phase 5: Post-record review + trim + annotate" — review window structure
- `docs/PLAN.md` §"Phase 5.5: Scratch-and-commit save model" — scratch lifecycle and the commit concept that Phase 11 is unifying
- `docs/PLAN.md` §"Phase 6: Export destinations" — Copy, LinkedIn, auto-save model, cache sweep
- `docs/PLAN.md` §"Phase 10: Review window — GIF export + timeline waveform" — GIF presets and filter graph

### Project guardrails
- `CLAUDE.md` §"Coding standards" — simplicity, no over-engineering, no defensive programming, no emojis
- `CLAUDE.md` §"Known gotchas" — A/V sync (single audio source), avfoundation device-index instability
- `docs/PLAN.md` §"Backlog" — settings persistence is deferred (format/preset selections do not persist across restarts)
- `docs/DECISIONS.md` 2026-04-25 — close-prompt Discard default
- `docs/DECISIONS.md` 2026-04-26 — Phase 6 hosted-sharing drop, iPhone-screenshot model adoption

### Files under edit
- `src/Review.tsx` — primary frontend surface (ExportPanel restructure, Footer removal, Timeline scrub + preview)
- `src/ScrubPreview.tsx` (or similar) — new floating preview component
- `src-tauri/src/edit.rs` — extension or wrapper for unified `save_recording`
- `src-tauri/src/thumbs.rs` (or similar) — new thumbnail-extraction command
- `src-tauri/src/lib.rs` — command registration
- Wherever the Phase 6 cache sweep lives — extend for thumbs

### ADR slot
- `docs/DECISIONS.md` — the "any save commits" unification (D-05) is the biggest architectural shift in Phase 11 and warrants an ADR entry during planning. The MP4 1080p default rationale (D-07) also belongs there.

## Sidebar layout — reference mockup

For planner orientation. State shown is pre-commit, GIF selected (FPS row visible).

```
+-- EXPORT ----------------------------+
|                                      |
|  SAVE                                |
|    Format     [ MP4 | GIF ]          |
|    Resolution [480p|720p|Source]     |
|    FPS        [ 10 | 15 | 20 ]       |
|                                      |
|           [  Save as GIF  ]          |
|         (post-save: Saved v 1.5s)    |
|                                      |
+--- OR EXPORT TO... ------------------+
|    Copy to Clipboard          ^C     |
|    Export for LinkedIn               |
|    Reveal in Finder    (post-commit) |
|                                      |
+--------------------------------------+
|    [ Record another ]                |
|    Discard recording   (red, ghost)  |
+--------------------------------------+
```

When MP4 is selected, the FPS row is hidden and the Resolution row shows `[480p|720p|1080p|Src]`. When ProRes ships in a later phase, the format chip set grows to `[ MP4 | GIF | ProRes ]`.

## Deferred Ideas

- **ProRes format** — its own phase. Resolution presets, audio handling, ProRes profile (422 / 422 HQ / 4444) all need their own decisions.
- **System Save dialog (file picker)** — auto-save to `~/Movies/Zeigen/` is the established pattern (Phase 6). Revisit only if multi-destination-disk friction surfaces.
- **⌘S keyboard shortcut for Save** — likely lands in Phase 11 as Claude's discretion. If skipped, lives here as a follow-up.
- **Settings persistence across app restarts** — bundles with the existing backlog item. Format / resolution / FPS selections reset on launch in Phase 11.
- **Timestamp overlay on preview thumbnail** — Claude's discretion in Phase 11. If skipped, follow-up.
- **Multi-save Reveal disambiguation** — Phase 11 ships "most recently saved file" as the Reveal target. A UI for picking *which* saved file to reveal (when multiple coexist) is deferred until it becomes annoying.
- **Per-thumbnail-sprite resolution tuning beyond ~160×90** — revisit only if the floating preview looks soft on large displays.
- **Save-block visual compression post-commit** — possible polish pass to make Reveal feel more prominent than "save another format" after the first commit.
- **Trim-handle snap-to-peaks** — distinct interaction model (Phase 10 deferred).
- **Waveform zoom** — distinct capability (Phase 10 deferred).
- **WebP / animated WebP output** — distinct format (Phase 10 deferred).

---

*Phase: 11-review-window-ux-overhaul*
*Context gathered: 2026-05-19*
