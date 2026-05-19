# Phase 10: Review window — GIF export + timeline waveform — Context

**Gathered:** 2026-05-19
**Status:** Ready for planning

## Phase boundary

Two deliverables in `src/Review.tsx`:

1. **GIF quick export** — replace the "Coming Later" placeholder in the QUICK EXPORT row with a working GIF export that honors trim + text + arrow annotations.
2. **Audio waveform** — replace the decorative gradient Timeline track with a functional audio waveform.

Out of scope: GIF stickers/overlays, WebP output, waveform zoom, waveform-snapped trim handles, trim-handle snapping to peaks, picture-in-picture export, structural changes to the mp4 save pipeline beyond what's needed to plug GIF into it, persisted preset preferences across app restarts (lives with the broader Settings-persistence backlog item).

## Carried-forward decisions (PLAN.md, PHASE-5-CONTEXT.md, PHASE_9_HANDOFF.md, CLAUDE.md)

- Sidecar JSON edit pipeline (Phase 5 D-09, D-10): trim, text, and arrow annotations live in the sidecar. GIF reads the same sidecar — no new schema.
- Single ffmpeg `filter_complex` invocation per user action (Phase 5 D-01). GIF extends this graph; it does not run as a second ffmpeg call after the mp4 pipeline.
- Trim handled by `-ss`/`-to` on the input, not the `trim` filter (Phase 5 D-02). GIF inherits.
- Annotation rendering: `drawtext` for text annotations, pre-rasterized arrow PNGs composited via `overlay` with `enable='between(t,start,end)'` (Phase 5 D-01, D-03). GIF inherits.
- Save dialog + Reveal-in-Finder is the established post-export UX (Phase 6). GIF follows the same shape.
- Settings reset on app restart (PLAN.md Backlog — settings persistence deferred). GIF preset selections don't persist across restarts.
- Keep it simple; no over-engineering; no unnecessary defensive programming; no emojis (CLAUDE.md).

## Implementation decisions

### GIF export — size and length

- **D-01:** GIF output resolution is a **user-selectable preset** in the QUICK EXPORT row. Options: 480p, 720p, source resolution. Default 720p. Source resolution downscales only if greater than the chosen ceiling — exact ceiling is planner-discretion (1080p is a reasonable working assumption).
- **D-02:** GIF frame rate is a **user-selectable preset** alongside resolution. Options: 10, 15, 20 fps. Default 15.
- **D-03:** Only the trimmed range from the sidecar is exported. Never the full source.
- **D-04:** When the trimmed range exceeds 30s, show a confirm/warn before encoding. User can proceed. No hard cap.

### GIF export — encoding pipeline

- **D-05:** Two-pass `palettegen` + `paletteuse`. Single-pass is rejected — screen recordings have subtle UI grays that band severely without a custom palette.
- **D-06:** Extend the existing Phase 5 `filter_complex` graph rather than running ffmpeg twice. Single invocation: the existing trim + `drawtext` + arrow overlays already build the `[v]` node; GIF appends `[v]split[a][b];[a]palettegen[p];[b][p]paletteuse` and uses `-loop 0`. No intermediate file.
- **D-07:** `-loop 0` (infinite loop) is the GIF behavior; not exposed as a setting.

### GIF export — UX

- **D-08:** Progress UI shape, cancel affordance, save destination, and default filename are planner-discretion. The mp4 save flow from Phase 6 (Save dialog + Reveal-in-Finder) is the precedent.

### Waveform — extraction

- **D-09:** Rendered on `<canvas>`, not as an ffmpeg-generated still image. Canvas is required so the waveform can coordinate with the existing playhead and trim handles and theme cleanly without re-extracting.
- **D-10:** Audio decoded on the JS side via Web Audio API: `fetch(convertFileSrc(mp4Path)).arrayBuffer()` → `AudioContext.decodeAudioData()` → `getChannelData(0)` → bucket peaks in JS. No Rust changes, no extra process spawn. macOS webview decodes AAC-in-MP4 natively.
- **D-11:** No on-disk cache. Re-decode on every review-open. Web Audio decode of a ~1-min AAC takes ~200ms; bucketing is fast; lazy-render after first paint keeps the window responsive. Revisit only if re-decode latency ever becomes noticeable.

### Waveform — presentation

- **D-12:** Mirrored peaks around the horizontal centerline (SoundCloud style). Reads as "audio" at a glance and works at thin timeline heights.
- **D-13:** Neutral grey fill. Brand red is reserved for the Phase 9 area indicator and recording-state UI.
- **D-14:** When the recording had no microphone selected, render a small grey **"No microphone"** label centered in the waveform track. A flat line is ambiguous between silence, no-mic, and failure; the explicit label disambiguates and matches dataviz convention for empty states.

### Claude's Discretion

- Bucket count / resolution of the canvas waveform render (responsive to canvas width vs. fixed sample count)
- `palettegen` flags — e.g., `stats_mode`, `reserve_transparent` — pick defaults that work on screen-recording content
- `paletteuse` dither algorithm (`bayer`, `sierra2_4a`, none) — pick what looks best on UI gradients and anti-aliased text
- GIF output filename pattern and default save destination
- Save flow shape for GIF — Save dialog vs save-then-reveal, modeled on mp4
- Progress UI specifics (inline status, modal, status strip) and whether a cancel button ships in this phase
- Whether the waveform visually dims outside the trim range (not pinned — planner picks)
- Whether the GIF preset picker renders inline in the QUICK EXPORT row (always visible) or as a popover on GIF-button click

## Code context

### Reusable assets
- `src/Review.tsx` — review window, contains the QUICK EXPORT row and the Timeline gradient (search `TIMELINE`)
- Phase 5 `filter_complex` builder (Rust side) — extends to emit the GIF tail
- Phase 6 save dialog + Reveal-in-Finder helpers — pattern for GIF save
- Web Audio API (built into webview) — no dependency needed
- Tauri `convertFileSrc` — already used to load mp4 into `<video>`

### Established patterns
- Sidecar JSON read on review-open (Phase 5) — both GIF and waveform read from it
- Single ffmpeg invocation per user action (Phase 5 D-01) — GIF extends the graph, never adds a second call
- Settings reset on app restart (PLAN.md Backlog) — GIF preset selections follow the same pattern

### Integration points
- QUICK EXPORT row in `src/Review.tsx` — GIF button + preset selectors land here
- Timeline track in `src/Review.tsx` — waveform `<canvas>` replaces the gradient div
- ffmpeg invocation utility (Rust side) — accepts a graph variant for GIF mode

## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase scope and intent
- `docs/PLAN.md` §"Phase 10: Review window — GIF export + timeline waveform" — phase goal and done-when
- `docs/PHASE_9_HANDOFF.md` §"Next session — Phase 10 candidate" — original scope notes and the implementation-question landscape

### Inherited pipeline
- `docs/PHASE-5-CONTEXT.md` §"Save-edits pipeline" — filter_complex graph, trim semantics, arrow rasterization (D-01..D-04)
- `docs/PHASE-5-CONTEXT.md` §"Annotation editing UX" + §"Sidecar JSON persistence" — annotation timing model and persistence
- `docs/PLAN.md` §"Phase 5: Post-record review + trim + annotate" — review window structure
- `docs/PLAN.md` §"Phase 5.5: Scratch-and-commit save model" — review-window file lifecycle
- `docs/PLAN.md` §"Phase 6: Export destinations" — save dialog + Reveal-in-Finder UX precedent

### Project guardrails
- `docs/PLAN.md` §"Backlog" — settings persistence is deferred (preset picker does not persist)
- `CLAUDE.md` §"Coding standards" — simplicity, no over-engineering, no defensive programming, no emojis
- `CLAUDE.md` §"Known gotchas" — A/V sync (single audio source), avfoundation device-index instability

### Files under edit
- `src/Review.tsx` — primary frontend surface (search `TIMELINE` for the decorative track)
- `src-tauri/` — Rust side that owns the ffmpeg invocation; extends for GIF mode

### ADR slot
- `docs/DECISIONS.md` — if any of the above need ADR-level treatment during planning, append there

## Deferred Ideas

- **Cancel button + cancellable progress UI for GIF** — follow-up if longer exports become annoying
- **Waveform caching as a sidecar JSON** — revisit only if re-decode latency becomes noticeable on real recordings
- **Waveform dimming outside the trim range** — possible polish pass
- **Waveform zoom** — distinct capability; would be its own phase
- **WebP / animated WebP output** — distinct format option
- **Trim-handle snap-to-peaks** — distinct interaction model
- **Persisted GIF preset preferences across app restarts** — bundles with the existing "Settings persistence" backlog item

---

*Phase: 10-review-gif-and-waveform*
*Context gathered: 2026-05-19*
