# Phase 12: Audio quality — Context

**Gathered:** 2026-05-20
**Status:** Ready for planning

## Phase boundary

Three audio-pipeline deliverables that ship together:

1. **Export-side noise reduction (12.1)** — every MP4 save runs the audio through ffmpeg's `arnndn` filter with the bundled RNNoise model. Suppresses room noise / fan noise / HVAC heard in real recordings during Phase 11 testing.
2. **Clipping indicator (12.2)** — extend `src/Waveform.tsx` to mark buckets whose peak exceeds a clipping threshold with an amber tint. Read-only signal, post-record.
3. **Capture-side limiter (12.3)** — intercept SCK mic CMSampleBuffers in the Swift recording engine and apply a per-sample soft-knee limiter before they hit the AVAssetWriter audio input. Prevents the clipping that 12.2 surfaces.

Out of scope: GIF audio (GIFs are silent), noise-reduction on Copy-to-Clipboard temp file (Copy is ephemeral — hands off the raw committed file), waveform redraw on slider drag (sample threshold is fixed), per-recording NR/limiter toggle UI (settings don't persist anyway — kept inline with the always-on decision), LinkedIn export NR (covered by the unified "every MP4 export gets NR" rule — LinkedIn produces an MP4), capture-side noise reduction (export-side only — keeps raw scratch reversible), AVAudioEngine effect-chain rewrite, mic level meter UI, mic gain control, multi-channel handling (current pipeline is mono).

## Carried-forward decisions (PLAN.md, PHASE-5/10/11 contexts, DECISIONS.md, CLAUDE.md)

- **Single audio source** to avoid A/V sync drift (CLAUDE.md gotchas). SCK's `captureMicrophone = true` remains the only mic source. 12.3 transforms samples in place — it does not introduce a parallel AVAudioEngine session.
- **Single ffmpeg invocation per save** (Phase 5 D-01, Phase 10 D-06, Phase 11). The arnndn pass is folded into the existing `save_recording` ffmpeg call via `-af`, not run as a second process.
- **Raw scratch capture stays untouched after recording** (Phase 5.5). Noise reduction is export-side so re-saves can apply different settings later. The capture-side limiter is the one exception — it must touch the raw capture or it isn't a limiter — but it only prevents irreversible damage (clipping), it doesn't sculpt tone.
- **Auto-save to `~/Movies/Zeigen/`** with `recording-<stamp>.mp4` naming and per-format collision suffixes (Phase 11 D-11). Unchanged.
- **Sidecar JSON edit pipeline** (Phase 5 D-09/D-10): trim, text, arrows live in the sidecar. NR is not a sidecar setting — it's an always-on transform.
- **Settings reset on app restart** (PLAN.md Backlog — settings persistence deferred). No new persisted settings here.
- **Coding standards** — simplicity, no over-engineering, no defensive programming, no emojis (CLAUDE.md).

## Implementation decisions

### 12.1 — Export-side noise reduction (arnndn)

- **D-01:** **Always-on.** Every MP4 export runs the audio through `arnndn`. No UI toggle, no per-recording setting. Matches the just-works pattern and avoids ephemeral-setting confusion.
- **D-02:** **Bundled RNNoise model.** The `.rnnn` model ships as a Tauri resource via `bundle.resources` in `tauri.conf.json`. Path resolved at runtime via `tauri::AppHandle::path().resource_dir()`. No first-run download, no cache logic, no network failure mode. Total bundle bloat: ~100KB.
- **D-03:** **Stock RNNoise model.** Use a single model file from the well-known [GregorR/rnnoise-models](https://github.com/GregorR/rnnoise-models) set (the same source the ffmpeg arnndn docs reference). Exact file is planner-discretion — leading candidate is `cb.rnnn` (general-purpose speech) or `lq.rnnn` (low-quality / harder noise). A single file ships; the choice is locked in the plan after a quick A/B on a noisy capture.
- **D-04:** **Audio-side filter, independent of `-filter_complex`.** Apply via `-af "arnndn=m=<path>"` on the audio output. The existing video filter graph (`-filter_complex` with trim/text/arrow overlays) is unchanged. ffmpeg routes audio and video through independent filter chains.
- **D-05:** **Position: before AAC encode, after `-ss/-to` trim.** ffmpeg's `-af` on the output side automatically runs after the demuxer-level `-ss`/`-to` clips the input, and before the `-c:a aac` encoder. No explicit ordering needed — that's the default.
- **D-06:** **GIF saves unaffected.** GIFs are silent (`-map [v]` only, no audio mapping). The `-af arnndn=...` flag is conditionally added only for `PipelineMode::Mp4`.
- **D-07:** **No more Source-MP4 hard-link short-circuit.** The Phase 11 `is_edit_pipeline_noop` → `hard_link` path skipped ffmpeg entirely when no trim/annotation existed. With NR always-on, every MP4 save must re-encode audio. The short-circuit is removed; every MP4 save runs through `run_edit_pipeline`. Source-resolution MP4 with no edits still skips the video scale node and runs h264_videotoolbox at native dimensions.
- **D-08:** **No noise-reduction on the raw scratch file.** Scratch stays as captured. NR is applied only to the export output. A second save with different (future) NR settings remains possible.
- **D-09:** **Recordings with no microphone.** When the source MP4 has no audio stream, `-af` is a no-op (ffmpeg skips it cleanly because there's no audio to apply it to). No special-case handling needed; existing `0:a?` map syntax already tolerates missing audio.

### 12.2 — Clipping indicator on waveform

- **D-10:** **Threshold: `peak >= 0.98`.** Linear sample amplitude on the absolute-value scale (Waveform.tsx already computes this per bucket as `m`). Tighter than the limiter's threshold (D-13) so legitimate near-limits don't always paint amber — only actual or near-actual clipping does.
- **D-11:** **Visual: amber tint per bar.** Buckets whose peak crosses the threshold paint in `--warning-tint` (an existing or new CSS variable resolving to amber, planner picks the exact hex). The default `BAR_COLOR = "#6f6f74"` continues to apply elsewhere. No marker/dot/triangle overlay — full-bar tint reads at every zoom level.
- **D-12:** **Computed during the same bucketing pass.** No second iteration over the PCM data. The existing per-bucket loop already finds the peak; flag a `Uint8Array(PEAK_CACHE_SIZE)` clipped-mask in the same pass. ~10 added lines.

### 12.3 — Capture-side soft-knee limiter

- **D-13:** **Threshold: -1 dBFS (`~0.891` linear).** Below threshold, samples pass through unchanged. Between -1 dBFS and 0 dBFS, samples follow a soft-knee curve that asymptotically approaches 1.0. Above 0 dBFS (impossible from properly delivered Float32 PCM, but guarded), hard-clip at ±1.0.
- **D-14:** **Soft-knee curve.** Simple `tanh`-based or piecewise-polynomial soft-knee on the magnitude. Specific curve is planner-discretion — the constraint is "above threshold, smoothly compress toward ±1.0; never exceed ±1.0." Sample rate independent (per-sample operation).
- **D-15:** **Always-on, no UI control.** Same just-works rationale as 12.1. Mic-level UI / gain control is explicitly deferred.
- **D-16:** **In-place sample transform on the SCK mic CMSampleBuffer.** In `RecordingSession.append(_:to:isVideo:)` on the `.microphone` path: get the AudioBufferList, walk the Float32 samples (or Int16 if SCK ever delivers integer PCM — verify at planning time), apply the limiter, write back. No new CMSampleBuffer allocation if SCK delivers a mutable backing buffer; otherwise copy-on-write into a new buffer.
- **D-17:** **Single-audio-source rule preserved.** SCK still owns mic capture (`captureMicrophone = true`). No `AVAudioEngine`, no parallel `AVCaptureSession`. A/V sync semantics unchanged.
- **D-18:** **No effect on iPhone Continuity Camera.** The iPhone-camera-with-iPhone-mic combination is already known-broken at the SCK layer (`SCStreamErrorDomain Code=-3820`, CLAUDE.md gotchas). 12.3 does not change this. The limiter applies to whatever mic SCK actually delivers.

### Claude's Discretion

- Exact RNNoise model file from the GregorR set (`cb.rnnn` vs `lq.rnnn` vs `bd.rnnn`). Pick after a quick listen on a noisy test capture during 12.1 implementation.
- Amber tint hex / CSS variable name. Existing palette in `src/index.css` (or wherever the design tokens live) should already have a warning color; reuse if so.
- Whether to expose the `--warning-tint` color as a token in the existing tokens file or inline-const it inside Waveform.tsx.
- Soft-knee curve formula — `tanh(sample * gain) / gain` vs piecewise polynomial. Both are ~3 lines of Float32 math.
- Whether `tauri.conf.json` bundles the model under `resources/audio/` or just `resources/` (cosmetic).
- The path-resolution helper in Rust — direct `AppHandle::path().resource_dir()` at the call site vs a small `audio_model_path()` helper. Pick what reads cleanest.
- Test fixture: a known-clipped + known-noisy WAV/MP4 fixture committed under `docs/spike/` for manual smoke comparison.
- Whether `pre-faststart` placement of `-af` is documented in the args list to make the order explicit, or left to ffmpeg defaults.

## Code context

### Reusable assets

- `src-tauri/src/edit.rs` — `run_edit_pipeline()` and `save_recording()`. The arnndn flag and the noop short-circuit removal land here.
- `src/Waveform.tsx` — existing canvas-based waveform with per-bucket peak. The clipping mask piggybacks on the existing bucketing loop.
- `src-tauri/recording-engine/Sources/recording-engine/RecordingSession.swift` — `append(_:to:isVideo:)` at line 293. The `.microphone` branch around line 283 is where the limiter goes.
- `tauri.conf.json` — `bundle` section gets a `resources` array for the RNNoise model.
- `src-tauri/src/composite.rs:FFMPEG_PATH` — the hardcoded ffmpeg binary path stays as-is; arnndn is a core filter in the homebrew build (confirmed: `ffmpeg -filters | grep arnndn` returns `TS arnndn A->A`).

### Established patterns

- **Single ffmpeg invocation per save** (Phase 5 D-01, Phase 10 D-06): the NR pass is folded into the existing call via `-af`, not run as a second process.
- **Bundle resources via `tauri.conf.json` and resolve at runtime via AppHandle::path().resource_dir()**: this is the standard Tauri 2.x pattern. Zeigen has no prior bundled resources, so this is the first use.
- **Sample-rate-independent per-sample transform on AVAssetWriter input buffers**: no prior precedent in this codebase; the closest analog is the timing-adjust path in `RecordingSession.adjustTiming()` which already demonstrates `CMSampleBufferCreateCopyWithNewTiming` for buffer rewriting.

### Integration points

- `src-tauri/src/edit.rs::run_edit_pipeline` — add `-af arnndn=m=<path>` to the args vec for `PipelineMode::Mp4`. Pass `audio_model_path` in as a parameter or resolve via a module-level helper.
- `src-tauri/src/edit.rs::save_recording` — remove the `is_edit_pipeline_noop` hard-link branch (now always runs the pipeline for MP4).
- `src-tauri/src/lib.rs` — register the audio model path. May need to thread `AppHandle` into the edit module, or store the resolved path in a `OnceLock` on first call.
- `src-tauri/recording-engine/Sources/recording-engine/RecordingSession.swift` — limiter helper applied to the `.microphone` branch of `stream(_:didOutputSampleBuffer:of:)` or inside `append()`.
- `src/Waveform.tsx` — add `clipped: Uint8Array` to the `ready` state shape, populate in the bucketing loop, branch on it in the per-x render loop.
- `tauri.conf.json` — add `bundle.resources` array referencing the model file location in the repo.

## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase scope and intent
- `docs/PLAN.md` §"Phase 12 — Audio quality" — phase goal, three deliverables, open-questions list
- This document (`docs/PHASE-12-CONTEXT.md`) — resolved decisions

### Inherited pipeline
- `docs/PHASE-10-CONTEXT.md` and `docs/PHASE-10-PLAN.md` — `run_edit_pipeline` shape and filter graph extension precedent; Waveform.tsx component pattern
- `docs/PHASE-11-CONTEXT.md` and `docs/PHASE-11-PLAN.md` — unified `save_recording` command, per-format collision suffixes, noop hard-link short-circuit (the one being removed in 12.1)
- `docs/PHASE-5-CONTEXT.md` §"Save-edits pipeline" — filter_complex graph and trim semantics
- `docs/IPC-SPEC.md` — Swift helper protocol (no changes; 12.3 is internal to the helper)

### Project guardrails
- `CLAUDE.md` §"Coding standards" — simplicity, no over-engineering, no defensive programming, no emojis
- `CLAUDE.md` §"Known gotchas" — single audio source for A/V sync (12.3 preserves this); iPhone Continuity camera+mic conflict (unaffected by 12.3)
- `docs/PLAN.md` §"Backlog" — settings persistence deferred (always-on NR/limiter sidesteps this)
- `docs/DECISIONS.md` — relevant entries: 2026-04-26 (iPhone-screenshot model — every export commits; the NR always-on rule applies to that committed file)

### Files under edit
- `src-tauri/src/edit.rs` — arnndn flag, noop short-circuit removal
- `src-tauri/src/lib.rs` — resource path wiring
- `src-tauri/recording-engine/Sources/recording-engine/RecordingSession.swift` — limiter
- `src/Waveform.tsx` — clipping mask + amber tint
- `tauri.conf.json` — bundle resources
- New: `src-tauri/resources/audio/<model>.rnnn` (or wherever the model file lives in-repo)

### ADR slot
- `docs/DECISIONS.md` — the **noop hard-link removal (D-07)** is a meaningful behavior change for users with un-edited Source-MP4 saves (every save now re-encodes audio, costing a few seconds even on no-edit cases). Worth an ADR entry. The **always-on NR + limiter** decision (D-01, D-15) is also worth an ADR — captures the "every export is treated, no toggle" philosophy.

## Deferred Ideas

- **Per-recording NR toggle UI** — settings don't persist anyway; revisit only if a user wants to compare clean vs raw on a specific recording.
- **Mic-level meter UI during capture** — would surface the limiter's behavior live. Distinct UX surface (capture window, real-time), distinct phase.
- **Mic gain control** — depends on UI surface above. Out of scope.
- **Capture-side noise reduction** — would touch raw scratch, breaking reversibility. Export-side is the right boundary unless real recordings show that export-side can't catch what raw capture overwhelms.
- **AVAudioEngine effect chain rewrite** — would re-architect mic capture away from SCK's built-in mic mode. Big refactor, justified only if multi-effect chains become a need.
- **Multi-channel / stereo mic handling** — current pipeline is mono.
- **NR model A/B in-app** — picking between RNNoise variants at the UI layer. We ship one model; revisit if multiple are genuinely needed.
- **Real-time waveform during capture** — clipping warning live. Real-time audio meter is a different feature class.
- **Hard limiter vs soft compressor toggle** — soft-knee covers both cases adequately. Skip the toggle.
- **NR for Copy-to-Clipboard** — Copy is ephemeral and points at the raw committed source. Either NR is everywhere or it's only on saves; we picked saves.
- **Configurable clipping threshold** — 0.98 is the standard "this is clipping" line for normalized audio. Not user-tunable.

---

*Phase: 12-audio-quality*
*Context gathered: 2026-05-20*
