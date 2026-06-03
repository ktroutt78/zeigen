# Phase 15: Deferred composite — dual-stream review preview — Context

**Gathered:** 2026-06-02
**Status:** Ready for planning

## Phase boundary

Stop → Preview is the longest single wait in the app today. A 12-minute recording (real user take on 2026-06-02) takes ~2-3 minutes to land in the review window because `recording_finalize` blocks on a synchronous `ffmpeg -filter_complex` composite that re-encodes the entire screen track with `h264_videotoolbox` (`src-tauri/src/composite.rs:546-602`). The progress modal driven by ffmpeg's `out_time_us` makes the wait visible but doesn't shorten it.

Loom solves this by keeping the screen and webcam as separate files and compositing only at export. The preview is two `<video>` elements sized and positioned via CSS — instant to open regardless of recording length. The composite cost moves to the Export action, where users already expect to wait.

Phase 15 ports that pattern to Zeigen:

1. **Webcam segments concat to a single `webcam.mp4`** at finalize via ffmpeg stream-copy (sub-second even for 12 min).
2. **`recording_finalize` stops compositing.** It writes the sidecar and returns paths to `screen.mp4` + `webcam.mp4`.
3. **Review opens a dual-stream player.** Screen video is master; webcam plays as a CSS-positioned circle over it, sync'd via `timeupdate`. Bubble keyframes interpolated in TS from the sidecar `bubble_position_log`.
4. **NR audio preview repointed at `screen.mp4`.** Same pipeline as Phase 14 c2 (video copy + arnndn on audio), just operating on screen.mp4 instead of the composited file. Output renamed to `preview-screen.mp4`. Dual-stream player uses it as the screen video source. Webcam unchanged (no audio).
5. **Composite moves into `run_edit_pipeline`.** Every export (Save, Copy to Clipboard, LinkedIn) does composite + trim + annotations in a single ffmpeg invocation. No cache across exports.

Out of scope: composite caching across multiple exports (D-07); MediaSource API segment chaining (D-02 alt); cosmetic bubble in scrub thumbnails (D-10); Area-mode behavioral changes (Area is unchanged — its capture rect is already a single-display crop; the dual-stream pattern works identically); Phase 14 c1 bubble placement work (independent surface); audio_offset shift in preview (D-09 — preview tolerates the 0-70ms drift that the export pipeline still corrects); migration of existing scratch dirs (D-11 — Phase 5.5 lifecycle wipes scratch between sessions).

## Carried-forward decisions (PLAN.md, prior phase contexts, DECISIONS.md, CLAUDE.md)

- **Saved files unchanged on the byte level for the screen-only-no-edit case** (Phase 12 D-01, Phase 5.5 reversibility): the composite at export time produces the same filter graph as today's `composite::composite` — same `h264_videotoolbox -b:v 8M`, same overlay/alphamerge/tpad. Export-time NR pass already runs in `run_edit_pipeline`. Saved MP4s after Phase 15 should match Phase 14 outputs frame-for-frame for the same inputs and sidecar state.
- **Scratch dir owns all per-recording temp artifacts** (Phase 5.5 D-04, DECISIONS.md): `webcam.mp4`, `preview-screen.mp4`, and the existing `screen.mp4` / segments / sidecar all live in `~/Movies/Zeigen/.scratch/<id>/`. Existing lifecycle paths sweep them — discard removes the directory, save removes the directory, app-launch sweeps stale dirs older than 24h. No new cleanup code.
- **Single ffmpeg/ffprobe invocation per intent** (Phase 5 D-01, Phase 10 D-06, Phase 12, Phase 13, Phase 14): the per-export composite is a single ffmpeg invocation that does composite + trim + annotations together. No multi-pass pipeline. The webcam-concat step at finalize is a separate single invocation (different intent — file prep, not edit).
- **Coding standards** — simplicity, no over-engineering, no defensive programming, no emojis (CLAUDE.md).
- **Phase 14 c2 NR preview pipeline shape is reused, not replaced** (`edit.rs:268-310`): `render_preview_audio` already does video-copy + audio re-encode with arnndn. Phase 15 changes the source it reads from (composited → screen.mp4) and the output name (`preview.mp4` → `preview-screen.mp4`), but the ffmpeg invocation is identical. Status pip behavior (D-08 lazy state, D-10 fallback) carries over unchanged.
- **WEBCAM_LEAD_MS = 280ms calibrated camera-start latency** (`composite.rs:348`): the dual-stream player applies the same lead in CSS by offsetting `webcam.currentTime` relative to `screen.currentTime` (D-08). The export pipeline keeps the same `tpad` filter — preview and export apply the lead identically.
- **Display ID is the canonical screen identifier** (PHASE_8_HANDOFF.md): unchanged. The recording stores logical-points coords in the bubble position log; the dual-stream player projects them into CSS via the screen video's natural dimensions.

## Implementation decisions

### D-01: Pipeline shape — composite moves from finalize to export, period.

`recording_finalize` no longer runs `composite::composite`. It writes the sidecar and returns paths. The composite function itself stays in `composite.rs` and gets called by `run_edit_pipeline` at export time. The single-pass shape (composite + trim + annotations in one ffmpeg invocation) keeps the existing performance characteristic for exports.

**Implication:** `FinalizedRecording.composited` becomes always-false (or the field is removed — see D-13). The review window never opens against a composited file in the new flow. Old already-composited files in `~/Movies/Zeigen/` are unaffected — they're saved outputs, not scratch.

### D-02: Webcam segments concatenated to a single `webcam.mp4` at finalize.

After `engine_stop` and before `recording_finalize` returns, run:
```
ffmpeg -f concat -safe 0 -i <list.txt> -c copy <scratch_dir>/sources/webcam.mp4
```
where `<list.txt>` is the standard ffmpeg concat demuxer manifest. Stream-copy (no re-encode), sub-second for any realistic recording length.

Player gets one `<video src>` for webcam. The segments stay on disk because `composite::composite` (now called at export time) still consumes the segments array — concat-output is purely for the player.

**Alternative considered:** MediaSource Extensions chaining. Rejected — more frontend complexity (buffer management, seek-across-segments, drift handling), no measurable backend benefit. The stream-copy concat is essentially free.

### D-03: Dual-stream player — screen as master, webcam slaved.

Two `<video>` elements in the review canvas. Screen video drives playback state (play/pause/seek/rate). Webcam video is slaved via:
- `screen.ontimeupdate` → if `|webcam.currentTime - (screen.currentTime - LEAD_S)| > 50ms`, set `webcam.currentTime = max(0, screen.currentTime - LEAD_S)`.
- `screen.onplay/onpause` → forward to webcam.
- `screen.onseeking` → pause both, store target time; `screen.onseeked` → snap webcam to target, resume both if was-playing.

50ms drift threshold is the loose-sync tolerance (one frame at 30fps is 33ms; one drift correction per second is acceptable). If `screen.playbackRate !== 1`, scale webcam's `playbackRate` to match.

**Alternative considered:** drive both off a shared timer that uses `requestAnimationFrame` and sets `currentTime` on both each frame. Rejected — Safari `<video>` doesn't like high-frequency seek calls; better to let the screen video play naturally and correct webcam drift periodically.

### D-04: Bubble CSS positioning interpolated in TS from the sidecar.

Port `simplify_position_log` + the inline keyframe interpolation from `composite.rs:472-530` to TS. Single function: `bubblePositionAt(log, t) → { x, y, diameter } | null` where `x`/`y` are normalized [0..1] coords of the screen frame and `diameter` is physical pixels (from the first log entry, per the composite's `target` resolution at `composite.rs:324-328`).

Bubble rendered as:
```tsx
<video
  ref={webcamRef}
  src={webcamUrl}
  style={{
    position: 'absolute',
    left: `${x * 100}%`,
    top: `${y * 100}%`,
    width: `${diameterCss}px`,
    height: `${diameterCss}px`,
    transform: 'translate(-50%, -50%) scaleX(-1)',
    borderRadius: '50%',
    objectFit: 'cover',
    pointerEvents: 'none',
  }}
/>
```

`diameterCss` = `diameter / displayScale` where `displayScale` accounts for the screen video's rendered-vs-natural ratio in the review canvas. Same math used by `WebcamBubble.tsx` during recording for the live preview.

If `bubble_position_log` is empty (no drag during recording), fall back to the legacy static corner (`WebcamSize` + `Corner` from the recording's settings, mirrored from `composite.rs:474-477`).

### D-05: NR audio preview repointed at `screen.mp4`. Output renamed to `preview-screen.mp4`.

`render_preview_audio` and `render_preview_audio_path` keep their shape (video copy + arnndn on audio + AAC re-encode). Two surgical changes:
- `preview_path_for(source)` returns `parent/preview-screen.mp4` instead of `parent/preview.mp4`. The `source` parameter becomes `screen.mp4` (not the composited file, which no longer exists at review-open).
- The Review.tsx call site passes `screenPath` (from the finalize payload) instead of the legacy `sourcePath`.

Phase 14 c2's eager-vs-lazy decision, status pip surfaces (D-08, D-10), and lifecycle (D-07) all carry over unchanged. The dual-stream player uses `preview-screen.mp4` for the screen `<video>` source once ready, falling back to raw `screen.mp4` during render or on failure. Webcam stream is `webcam.mp4` either way (no audio to NR).

### D-06: Composite runs as part of `run_edit_pipeline` at export time.

`run_edit_pipeline` rewrites to take `screen_path` + `webcam_path` + `webcam_segments` + sidecar (currently takes a single composited path). It builds a single ffmpeg invocation that does composite + trim + annotations in one pass — same `filter_complex` shape as today's composite, with the trim's `-ss`/`-to` and annotation overlay filters appended to the existing graph.

The composite filter-builder in `composite.rs` is extracted into a shared helper so `run_edit_pipeline` can call it without duplicating the alphamerge/overlay/tpad logic. The existing `composite::composite` public function becomes a thin wrapper for callers that want composite-only (preserved for future use; no current caller after Phase 15 c2).

All four export paths flow through `run_edit_pipeline`:
- Save (`save_recording` in `edit.rs`)
- Copy to Clipboard (`clipboard_copy_recording` in `lib.rs`)
- Export for LinkedIn (`linkedin_export` in `lib.rs`)
- GIF export (Phase 10 — `palettegen` + `paletteuse` pipeline; composite filter precedes the palette pipeline)

### D-07: No composite cache across exports.

Every export runs the full pipeline. The user mostly exports once per recording (Save-and-done is the common path; clipboard/LinkedIn are separate flows). Cache invalidation on bubble keyframe edits, trim changes, format changes, resolution changes adds non-trivial state — not worth carrying for a personal tool until the friction is real.

**Tradeoff:** users who Save-then-LinkedIn pay the composite cost twice. Acceptable per CLAUDE.md "no over-engineering" — revisit only if a multi-export flow becomes common.

### D-08: WEBCAM_LEAD_MS = 280ms applied in CSS, not ffmpeg.

In the dual-stream preview, webcam playback starts 280ms after screen (`webcam.currentTime = max(0, screen.currentTime - 0.280)`). For `screen.currentTime < 0.280`, the webcam video shows its first frame (paused) — matches the composite's `tpad=start_duration=0.280:start_mode=clone` behavior of freezing the first frame to fill the pre-camera gap.

`LEAD_S` is exported from a single constant shared with composite.rs via a small Rust → TS bridge (probably a `#[tauri::command]` that returns the constant, or a constant baked into the finalize payload). Don't hardcode 0.280 in TS — the calibration value lives in composite.rs:348 with the explanatory comment and any tuning happens there.

### D-09: Audio shift (audio_offset) NOT applied in preview.

The composite pipeline applies an `-itsoffset` to drop the 0-70ms leading silence the SCK mic adds (`composite.rs:356-357`). The preview can't easily replicate this — it would require either re-encoding screen.mp4 audio with a head trim (defeats the "video copy" zero-cost guarantee of the NR preview) or fudging webcam offset (decouples preview from save behavior).

Preview accepts the 0-70ms drift. The user hears the recording as it would sound in QuickTime against the raw screen.mp4 — slightly looser A/V sync than the eventual export. Save pipeline still applies the shift, so exported files match Phase 14 behavior.

**Surface this in the plan's done-when:** the preview's audio is "raw mic-start latency"; the export's audio is "shift-corrected." Document the asymmetry explicitly so future bug reports against preview A/V sync don't chase the wrong root cause.

### D-10: Scrub thumbnail sprite extraction repoints to `screen.mp4`.

Today's `extract_thumb_sprite` (Phase 11 timeline scrub-preview) samples the composited file, so thumbnails include the webcam bubble. After Phase 15, the composited file doesn't exist at review-open. Repoint sprite extraction at `screen.mp4` — thumbnails show the screen content only, no bubble.

Cosmetic loss. Acceptable for a personal tool; arguably better since the bubble in a 60×34 scrub thumbnail is illegible anyway.

### D-11: Hard cutover — no migration path.

Phase 5.5 lifecycle wipes scratch dirs between sessions (Save deletes the dir, Discard deletes the dir, app-launch sweeps stale dirs > 24h). No in-flight scratch dirs persist across the version bump — the first launch after Phase 15 ships starts from a clean scratch state.

Existing files in `~/Movies/Zeigen/recording-*.mp4` are saved composited outputs and are never re-opened in review (Phase 5.5 routes review to scratch only). They continue to play in QuickTime / be re-shared identically. No legacy-path code in Review.tsx.

### D-12: Bubble visual fidelity matches composite via CSS.

Three CSS treatments mirror the composite's filter graph:
- `transform: scaleX(-1)` — matches `hflip` in composite (`composite.rs:457`).
- `object-fit: cover` on a square element — matches `crop='min(iw,ih)'` (centered square crop).
- `border-radius: 50%` — matches the alphamerge circular mask.

These are the same treatments `WebcamBubble.tsx` already uses for the live recording-time preview, so the look is consistent across recording → review → saved file.

**Subtle difference:** the composite's PNG mask is anti-aliased via `tiny_skia` (`composite.rs:render_alpha_mask`). CSS `border-radius: 50%` is also anti-aliased by the browser. Both produce smooth circles; pixel-level edge differences are below perception threshold.

### D-13: `FinalizedRecording` payload shape.

Add `webcam_path: Option<String>` (the concat'd `webcam.mp4`). Add `screen_path: String` (the existing screen.mp4 already at `<sources_dir>/screen.mp4` — surfaced explicitly so the frontend doesn't recompute it). Remove `composited: bool` — the field is meaningless post-Phase-15 (always false). Keep `scratch_mp4_path` for now as the "primary" path (points at `screen.mp4` if no webcam, or… **open question**: does scratch_mp4_path stay meaningful, or does it become redundant with screen_path? Pick one at planning time and remove the other).

Frontend's `openReview` (`App.tsx:659-685`) and `stopped` event handler (`App.tsx:867-896`) update to pass both paths through. Review window query params or window state carries both.

### D-14: Single-stream fallback for screen-only recordings.

When no webcam is selected, `webcam_opt = None`, so finalize today produces no webcam segments and skips composite entirely (`lib.rs:386` — the else branch). Phase 15 keeps this path: no webcam.mp4 produced, `FinalizedRecording.webcam_path = None`, review opens a single `<video>` against screen.mp4 (or preview-screen.mp4). No dual-stream code paths exercised. Zero behavior change for screen-only recordings.

### D-15: Area-mode unchanged.

Area mode captures a cropped rectangle of one display. The recorded screen.mp4 has the area's dimensions (no letterboxing). The webcam bubble overlays the area frame the same way it overlays a full-display frame — composite filter graph is identical (`composite.rs` doesn't special-case area mode). Dual-stream player works the same: screen.mp4 has area dimensions, bubble keyframes are still [0..1] normalized against that frame, CSS positions correctly.

### Claude's Discretion

- Exact naming for the new constants and helpers — `LEAD_S` vs `WEBCAM_LEAD_SEC`, `bubblePositionAt` vs `interpolateBubblePosition`, etc. Match the surrounding style in each file.
- Exact form of the screen-master / webcam-slave sync code (D-03) — listed pattern is a sketch; the implementation may need extra handling for `ratechange`, `ended`, scrub-during-drag. Lean on observation during UAT, not theorizing.
- Exact name and location of the composite-filter-builder extracted from `composite::composite` (D-06) — a free function in `composite.rs` that takes the existing args and returns the filter string + ffmpeg input args is the simplest cut. Alternatively a `CompositePipeline` struct; only worth it if `run_edit_pipeline` needs to extend the filter graph and the assembly logic gets tangled.
- Test approach — `#[ignore]` baseline tests against a real scratch fixture mirroring `render_preview_audio_baseline` (Phase 14 c2 precedent). Specifically: a "before/after" parity test that runs the new export pipeline against a fixture and `ffprobe`-diffs the output against a Phase 14 saved file to confirm bit-stable composite output (D-06 guarantee).
- Whether the c2 commit removes `composite::composite` entirely or keeps it as a thin wrapper. Lean toward keeping as a wrapper — small code, future-proof, no caller-deletion risk.
- Whether to expose `WEBCAM_LEAD_MS` via a `#[tauri::command]` or bake it into the `FinalizedRecording` payload (D-08). Payload is simpler; one fewer IPC round-trip.

## Code context

### Reusable assets

- `src-tauri/src/composite.rs:305-630` (`composite()`) — the filter-graph + ffmpeg invocation that becomes the export-time composite. The filter-builder portion (lines 407-543) extracts into a shared helper for `run_edit_pipeline` to call.
- `src-tauri/src/composite.rs:472-543` — bubble keyframe simplification + inline expression builder. Direct template for the TS port (D-04).
- `src-tauri/src/composite.rs:348` — `WEBCAM_LEAD_MS = 280.0` constant. Single source of truth for the camera-start lead; surfaced to frontend via D-08.
- `src-tauri/src/edit.rs:268-310` (`render_preview_audio`, `render_preview_audio_path`, `preview_path_for`) — Phase 14 c2's NR preview pipeline. Source path swap (composited → screen.mp4) and output rename (preview.mp4 → preview-screen.mp4) per D-05.
- `src-tauri/src/edit.rs:619-837` (`run_edit_pipeline`) — current edit pipeline that takes a single composited input. Rewrites to take screen + webcam + segments per D-06.
- `src-tauri/src/lib.rs:337-406` (`recording_finalize`) — the IPC handler where the composite call gets removed and the concat call gets added (D-01, D-02).
- `src-tauri/src/lib.rs:408-416` (`FinalizedRecording`) — payload shape change (D-13).
- `src/App.tsx:659-685` (`openReview`) — query/state payload extension for screen + webcam paths.
- `src/App.tsx:867-896` (stopped event handler) — consumes the updated payload, opens review with both paths.
- `src/Review.tsx:395-442` — Phase 14 c2's preview pipeline call site. Updates to pass screenPath, consume preview-screen.mp4 output.
- `src/Review.tsx:860-930` (video player render) — single `<video>` becomes dual `<video>` with screen-as-master sync layer per D-03.
- `src/WebcamBubble.tsx` — the live-recording bubble component. Same CSS treatment (hflip, square crop, border-radius) — direct visual reference for D-12.

### Established patterns

- **Single ffmpeg invocation per intent** (Phase 5 D-01, Phase 10 D-06, Phase 12, 13, 14): preserved. Composite at export is one invocation. Concat at finalize is one invocation. NR preview at review-open is one invocation.
- **Probe / generate at review-open, store in state, clean up on close** (Phase 12 c3, Phase 13 c3, Phase 14 c2): the NR preview pipeline carries this pattern unchanged through Phase 15.
- **Scratch lifecycle owns all per-recording temp artifacts** (Phase 5.5 D-04, DECISIONS.md): preserved. New `webcam.mp4` and `preview-screen.mp4` live in scratch; existing cleanup paths sweep them.
- **Source-of-truth constants live in Rust, surfaced to TS via payload or command** (Phase 8 display IDs, Phase 13 audio-meta probe): `WEBCAM_LEAD_MS` follows the same pattern per D-08.
- **Hard cutover for breaking sidecar / payload shape changes** (Phase 5.5 lifecycle, Phase 11 sidebar restructure): no migration code in Review.tsx for old single-file scratch state. Scratch lifecycle wipes between sessions.

### Integration points

- `src-tauri/src/lib.rs` — `recording_finalize` shape change (D-01, D-02, D-13); composite call removed; concat call added.
- `src-tauri/src/composite.rs` — filter-builder extraction (D-06); `WEBCAM_LEAD_MS` stays the source of truth.
- `src-tauri/src/edit.rs` — `run_edit_pipeline` rewrite (D-06); `render_preview_audio` source path swap (D-05).
- `src/App.tsx` — `openReview` payload extension (D-13); `stopped` event handler consumes new shape.
- `src/Review.tsx` — dual-stream player (D-03); bubble CSS positioning (D-04, D-12); NR preview call site update (D-05); scrub thumbnail repoint (D-10).
- New helper file (suggested): `src/lib/bubble.ts` — TS port of bubble keyframe interpolation. Keeps Review.tsx from growing.
- `src-tauri/src/thumbs.rs` (or wherever `extract_thumb_sprite` lives) — source path repoint (D-10). No invocation shape change.

## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase scope and intent
- This document (`docs/PHASE-15-CONTEXT.md`) — resolved decisions.
- `docs/PLAN.md` — phase ordering, prior-phase invariants. Phase 15 entry to be added during c2 (or end of phase).

### Composite pipeline
- `src-tauri/src/composite.rs` (full file) — the canonical composite. Filter-builder extraction in c2 must preserve every existing semantic: `hflip` matches WebcamBubble preview; `crop='min(iw,ih)'` centers; `scale` to `target` diameter; `alphamerge` with circle mask; `tpad start_mode=clone` for `WEBCAM_LEAD_MS`; `-itsoffset` for audio_shift; `eof_action=pass` so screen survives short webcam track.
- `docs/DECISIONS.md` 2026-04-25 — `hflip` + WebcamBubble preview-matches-recording invariant. D-12 inherits.

### Phase 14 c2 NR preview pipeline (reused)
- `src-tauri/src/edit.rs:268-310` — `render_preview_audio` / `render_preview_audio_path` / `preview_path_for`. D-05 swaps the source path and output name; pipeline shape unchanged.
- `src/Review.tsx:395-442` — call site that becomes the trigger for `preview-screen.mp4` generation. Status pip surfaces (D-08 lazy, D-10 fallback) carry over.
- `docs/PHASE-14-CONTEXT.md` D-08, D-10 — eager-vs-lazy decision pattern + fallback pip behavior.

### Sidecar and bubble keyframe semantics
- `src-tauri/src/edit.rs:33-52` — `SidecarState`, `BubblePositionEntry` shapes. Frontend consumes via new TS interp helper (D-04).
- `docs/PLAN.md` §Phase 3.5 — bubble position log coordinate semantics (x/y as fractions [0..1] of recorded display physical frame).
- `docs/PHASE_8_HANDOFF.md` — display-ID-keyed coords. Bubble position log uses normalized fractions so display-ID lookup is not needed for player rendering.

### Scratch lifecycle
- `docs/PLAN.md` §Phase 5.5 — scratch-and-commit save model. Discard/save/close-prompt paths handle `webcam.mp4` and `preview-screen.mp4` cleanup without code changes.
- `src-tauri/src/lib.rs::sweep_stale_scratch` — app-launch sweep covers truly orphaned dirs.

### Coordinate units (precedent)
- `docs/PHASE_8_HANDOFF.md` — LOGICAL points at JS↔Rust boundary, display-ID-keyed coords. The bubble position log already uses normalized fractions, so this precedent applies only to the diameter conversion in D-04 (`diameter` is physical pixels in the sidecar; CSS renders in logical points, so divide by `devicePixelRatio` or the equivalent screen scale).

## Deferred Ideas (out of plan, captured for traceability)

- Composite caching across multiple exports — D-07 (revisit if Save-then-LinkedIn becomes common).
- MediaSource Extensions for webcam segment chaining — D-02 alt (revisit if concat-copy becomes a measurable bottleneck, which it won't).
- Preview audio shift parity (apply `audio_offset` in preview) — D-09 (would require re-encoding screen.mp4 audio in the NR preview pass; not worth the 0-70ms drift).
- Bubble in scrub thumbnails — D-10 (Composite a tiny center-bubble strip if requested; punted).
- Background composite during review — i.e., start exporting the composite while user is on the preview page and silently swap source when ready. Loom does this server-side. Possible v1.5 win — would eliminate the export wait. Not in Phase 15 scope.
- Removing `composite::composite` entirely (only the filter-builder helper survives) — defer; keep the public wrapper through Phase 15 in case a future caller wants composite-only.
- Hot-reload bubble keyframes — i.e., let the user drag the bubble in the review window to fix placement. Would need the dual-stream player to mutate the sidecar live + the export pipeline to consume the updated keyframes. Real win for screen-only-with-bubble recordings. Defer.

---

*Phase: 15-deferred-composite*
*Context gathered: 2026-06-02*
