# Phase 13: Timeline regressions — Context

**Gathered:** 2026-05-20
**Status:** Ready for planning

## Phase boundary

Two review-window Timeline/Waveform regressions that ship together. Both are frontend-shaped with one supporting backend addition; no save-pipeline changes.

1. **Timeline visibility at large window sizes (13.1)** — at full-screen / tall window heights the timeline waveform is pushed off the viewport entirely; the video pane eats all available vertical space. Pure CSS layout regression from Phase 11 c4's footer removal + sidebar restructure (commit 65dc026). Workaround today: shrink the review window.
2. **Waveform alignment drift (13.2 + 13.3)** — review-window waveform peaks don't line up with the playhead position where the audio actually plays. Root cause: `Waveform.tsx` maps `audioBuffer.duration` (A) linearly across canvas width that actually represents `videoElement.duration` (V), but A < V on every recording (the last mic CMSampleBuffer reaches the writer before the last video frame). V−A spans ~30–650ms across observed recordings.

Out of scope: backend audio-pad on save (path (a) of the two fix directions, rejected — see D-04), MP4 atom parse in JS for reading `start_time`, assume-from-engine-knowledge approach, GIF timeline (silent — no waveform), real-time waveform during capture, mic-startup-gap engine-side fix, A/V sync drift end-to-end (separate Phase 5 follow-up).

## Carried-forward decisions (PLAN.md, prior phase contexts, DECISIONS.md, CLAUDE.md)

- **Saved files unchanged** (Phase 12 D-01, Phase 5.5 reversibility): noise reduction always re-encodes audio at save time, but the **content** of the audio track is not padded or otherwise modified for waveform-alignment purposes. The fix is frontend-side rendering only.
- **Single ffmpeg/ffprobe invocation per intent** (Phase 5 D-01, Phase 10 D-06, Phase 11, Phase 12): the new audio-meta probe runs **once per review-open** per recording. The result is cached in Review-component state for the session.
- **ffprobe binary path** is the existing `composite::FFPROBE_PATH` constant. Same pattern as the private `probe_duration_seconds` and `probe_dimensions` helpers in `edit.rs`.
- **Probe-once, cache-result pattern** (Phase 12 c3): the bundled RNNoise model path is resolved once via `OnceLock`; the audio-meta probe follows the same "fetch once, reuse for the session" shape, just at component-state granularity rather than process-global.
- **Coding standards** — simplicity, no over-engineering, no defensive programming, no emojis (CLAUDE.md).

## Implementation decisions

### 13.1 — Timeline visibility CSS fix

- **D-01:** **No design choices required.** Diagnose during planning. The likely fix is one of: missing `flex-shrink: 0` / `min-height` on the timeline row, or an unconstrained `flex: 1` on the video pane that lets it eat the timeline's space at tall heights. Investigation surface: the footer removal + sidebar restructure from Phase 11 c4 (commit 65dc026) is the suspected regression source.

### 13.2 — ffprobe audio-track command

- **D-02:** **New `#[tauri::command]` in `edit.rs`**, alongside the existing private ffprobe helpers. Public wrapper exposes audio-track metadata to the frontend.
- **D-03:** **Returns `start_time` and `duration`** for the audio stream (`a:0`) as `f64` seconds. Encoded as a small typed struct — `AudioTrackMeta { start: f64, duration: f64 }` or similar. Returns `None` (or zero-valued) for recordings with no audio stream.
- **D-04:** **Path (b) chosen over path (a).** Two directions were on the table — (a) pad the audio track with silence on save so A == V, or (b) thread V and S into the Waveform and remap. We chose (b): keeps saved files byte-stable, no pipeline changes, no file-size delta, surgical scope. Path (a) would have touched every MP4 export (Save, LinkedIn, Copy-to-Clipboard) and reopened the Phase 12 "audio always re-encodes" rule.
- **D-05:** **ffprobe args follow existing precedent.** `-select_streams a:0 -show_entries stream=start_time,duration -of csv=p=0`. Parsing matches the `probe_dimensions` pattern (CSV split, parse each field).

### 13.3 — Waveform rescale using S

- **D-06:** **New Waveform props.** `videoDuration: number | null` and `audioStart: number` (S, seconds). Both threaded from Review state through Timeline. Existing `assetUrl` prop unchanged.
- **D-07:** **Render mapping changes from `t = (x/W) × A` to `t = (x/W) × V − S`.** Equivalently: the waveform fills canvas pixel range `x ∈ [S/V × W, (S+A)/V × W]`. Outside that range, draw nothing (silence — the video has no corresponding audio there). The bucketing pass over PCM data is unchanged; only the per-pixel bucket-index computation in the render loop changes.
- **D-08:** **Playhead alignment unchanged.** The playhead is already positioned by video-time / V × W. That math is correct today — only the waveform-under-the-playhead was wrong. After 13.3, the waveform under playhead position `(t/V) × W` represents audio-time `t − S`, which is the audio sample actually playing.
- **D-09:** **Phase 12 c1 clipping highlight carried forward.** The amber `--warning-tint` per-bar tint applies under the new mapping; no logic change beyond using the corrected bucket indices.
- **D-10:** **Probe invocation lives in Review.** Fetched at review-open via the new `#[tauri::command]`, stashed in Review-component state, passed down to Timeline → Waveform as props. One subprocess per review-open per recording — same lifecycle window as the existing thumb-sprite extraction.
- **D-11:** **Recordings with no audio stream.** When `audioStart` and `audioDuration` are zero (or `null`), Waveform renders nothing (the existing `empty` state handles this — `audioBuffer` would decode to a silent buffer or fail; the empty state already covers it).
- **D-12:** **Trim-aware overlays unchanged.** Timeline's dimmed-region overlays for trim are based on `props.duration` and `props.trim`, both pre-existing. No change needed for the trim UX.

### Claude's Discretion

- Exact name for the new Rust command (`probe_audio_track`, `audio_track_meta`, etc.).
- Exact name for the typed struct (`AudioTrackMeta`, `AudioMeta`, etc.) and whether it lives in `edit.rs` or a small new module.
- Per-pixel mapping implementation choice — either skip the per-x bucket loop outside the in-range canvas region, or compute over the full width and short-circuit when out of `[S, S+A]`.
- Whether `videoDuration` is threaded as a separate prop or derived inside Waveform from a passed-in `videoRef`. Pass-as-prop is cleaner.
- Whether to refactor the bucketing or render math into a helper, or keep inline.
- 13.1 CSS fix specifics — chosen during planning based on layout inspection.
- Test approach for the new Rust command — likely a `#[ignore]` baseline test against the Phase 10 c1 scratch fixture.

## Code context

### Reusable assets

- `src-tauri/src/edit.rs` — `probe_duration_seconds` (line 130) and `probe_dimensions` (line 163) are the model for the new `probe_audio_track` command. Same ffprobe invocation shape, same parsing pattern.
- `src-tauri/src/composite.rs:FFPROBE_PATH` — the hardcoded binary path.
- `src/Waveform.tsx` — existing canvas-based waveform with the Phase 12 c1 clipping mask. The new mapping math piggybacks on the existing render loop; bucketing pass is unchanged.
- `src/Review.tsx` — `Timeline` component (line 1642) already takes `duration` and `videoRef`. Adding `audioStart` is one new prop on the same component plus a Waveform prop, plus the fetch at review-open.
- `src-tauri/src/thumbs.rs` — pattern precedent for "subprocess invoked once at review-open, result cached for the session" (sprite generation runs the same shape).

### Established patterns

- **Private ffprobe helpers wrapped in a `#[tauri::command]`** when frontend needs access (Phase 12 c3 wired `set_audio_model_path` similarly).
- **Probe at review-open, cache in component state** — the thumb sprite (`extract_thumb_sprite`) runs once per review-open and is read repeatedly. New audio-meta command follows the same lifecycle.
- **Pass video timing context as props through Timeline → Waveform** — the existing `duration` prop on Timeline establishes the pattern; `audioStart` follows.

### Integration points

- `src-tauri/src/edit.rs` — new public function + `#[tauri::command]` wrapper alongside the existing private helpers.
- `src-tauri/src/lib.rs` — register the new command in `invoke_handler![…]` (line ~583).
- `src/Review.tsx` — fetch audio-track meta at review-open (similar to where the existing sprite/sidecar fetches happen), store in component state, pass into `Timeline` props.
- `src/Review.tsx::Timeline` — accept `audioStart` prop, forward to Waveform along with the existing `duration`.
- `src/Waveform.tsx` — accept `videoDuration` and `audioStart` props; update the render loop's pixel→bucket mapping.

## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase scope and intent
- `docs/PLAN.md` §"Backlog" — full descriptions of items 4 (Timeline visibility) and 5 (Waveform alignment drift) including diagnostic numbers
- This document (`docs/PHASE-13-CONTEXT.md`) — resolved decisions

### Inherited Timeline / Waveform code
- `docs/PHASE-10-CONTEXT.md` and `docs/PHASE-10-PLAN.md` — Waveform.tsx introduction and the canvas-bucketing pattern
- `docs/PHASE-12-CONTEXT.md` and `docs/PHASE-12-PLAN.md` — Phase 12 c1 added the clipping mask to Waveform; new mapping must preserve that overlay behavior
- `docs/PHASE-11-CONTEXT.md` and `docs/PHASE-11-PLAN.md` — review-window unification + footer removal + sidebar restructure (commit 65dc026 is the suspected 13.1 regression source)

### Project guardrails
- `CLAUDE.md` §"Coding standards" — simplicity, no over-engineering, no defensive programming, no emojis
- `CLAUDE.md` §"Known gotchas" — A/V sync drift mention (Phase 5 backlog)
- `docs/PLAN.md` §"Deferred / out of scope" — A/V sync drift end-to-end is a separate pass

### Files under edit
- `src-tauri/src/edit.rs` — new ffprobe audio-track command
- `src-tauri/src/lib.rs` — register the command
- `src/Review.tsx` — fetch + thread props; also the 13.1 CSS fix surface
- `src/Waveform.tsx` — render mapping update

### ADR slot

Neither 13.1 nor 13.2/13.3 are major behavior changes worth an ADR entry on their own. If the path (b) vs (a) choice for 13.2 turns out to need re-litigation later (e.g. if a future phase needs A == V at the file level), revisit then. Path (b) preserves the Phase 12 D-01 / Phase 5.5 saved-file-stability invariant — no new contract to record.

## Deferred Ideas

- **Audio-pad on save (path a)** — would eliminate the V/S logic in Waveform entirely. Rejected because it changes save-time file size and pipeline behavior across every MP4 export, reopening the Phase 12 audio-pipeline shape decision. Revisit only if a non-display use case needs A == V.
- **MP4 atom parse in JS** — alternative to the Rust ffprobe command. Adds a JS dependency or a hand-rolled parser. Rejected; the Rust command is ~20 lines and matches existing precedent.
- **Assume-from-engine-knowledge (V−A and known leading-gap)** — derive S without probing. Rejected: V−A doesn't tell us where the gap is (could be leading, trailing, or split), and the engine's actual gap depends on mic startup latency which varies per device.
- **Real-time waveform during capture** — different feature class. Not relevant to alignment fix.
- **Engine-side fix for mic startup gap** — would address the root cause (A < V) by making mic capture start earlier. Likely impossible without dropped samples; out of scope for a frontend regression fix.
- **Persistent caching of audio-track meta across review-opens** — premature optimization. One ffprobe at review-open is cheap; persistence adds invalidation complexity.

---

*Phase: 13-timeline-regressions*
*Context gathered: 2026-05-20*
