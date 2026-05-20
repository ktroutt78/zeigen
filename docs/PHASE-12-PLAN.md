# Phase 12 — Audio quality — Plan

**Drafted:** 2026-05-20
**Status:** Ready to execute
**Source of truth for decisions:** `docs/PHASE-12-CONTEXT.md`

Three independent audio-pipeline deliverables, ordered smallest-blast-radius first:

- **c1 — Clipping indicator** (12.2). Frontend-only, ~20 added lines in `src/Waveform.tsx`. No backend or build changes.
- **c2 — Capture-side soft-knee limiter** (12.3). Swift-only, inside `src-tauri/recording-engine/Sources/recording-engine/RecordingSession.swift`. No Rust changes, no frontend changes.
- **c3 — Export-side arnndn noise reduction** (12.1). Adds a bundled resource, touches `tauri.conf.json`, `src-tauri/src/edit.rs`, `src-tauri/src/lib.rs`. Includes the **noop hard-link removal** — a real Phase 11 save-speed regression flagged and accepted in CONTEXT D-07.

Each commit is independent and self-verifying. C1 surfaces clipping; c2 prevents future clipping at capture; c3 cleans existing noise on export.

## Save-path impact summary (c3 only)

Phase 11 introduced a zero-ffmpeg hard-link short-circuit for MP4-Source saves with no edits (`is_edit_pipeline_noop && resolution == Source`). Phase 12 c3 **removes** that short-circuit because always-on arnndn requires an audio re-encode on every MP4 export. This is a meaningful, intentional Phase 11 regression in noop-save speed (full discussion + measurement plan in c3 below and in the DECISIONS.md ADR written in c3).

| Sidecar | Format | Resolution | Phase 11 passes | Phase 12 passes |
|---|---|---|---|---|
| noop | MP4 | Source | 0 (hard-link) | **1 (arnndn + AAC + h264_videotoolbox)** |
| noop | MP4 | 480p / 720p / 1080p | 1 | 1 (now with arnndn) |
| any | GIF | any | 1 | 1 (unchanged — GIFs are silent) |
| with edits | MP4 | any | 1 | 1 (now with arnndn) |

GIF saves are unchanged at every level. Only MP4-Source-noop saves see a behavior shift, and only on save-time wall-clock (the resulting MP4 is functionally identical except for cleaner audio).

---

## c1 — Clipping indicator on waveform

`src/Waveform.tsx`. Frontend-only.

**State shape change**

The `ready` state grows a `clipped: Uint8Array` parallel to the existing `peaks: Float32Array`. Both arrays are `PEAK_CACHE_SIZE` long; `clipped[i] === 1` iff the i-th bucket contains at least one sample with absolute value `>= CLIPPING_THRESHOLD`.

```ts
const CLIPPING_THRESHOLD = 0.98;
const CLIP_COLOR = "..."; // --warning-tint, see below

type State =
  | { kind: "loading" }
  | { kind: "ready"; peaks: Float32Array; clipped: Uint8Array; maxPeak: number }
  | { kind: "empty" };
```

**Bucketing loop**

Inline the clip-detection into the existing inner loop (no second pass over the PCM):

```ts
const peaks = new Float32Array(PEAK_CACHE_SIZE);
const clipped = new Uint8Array(PEAK_CACHE_SIZE);
const samplesPerBucket = channel.length / PEAK_CACHE_SIZE;
let max = 0;
for (let i = 0; i < PEAK_CACHE_SIZE; i++) {
  const start = Math.floor(i * samplesPerBucket);
  const end = Math.floor((i + 1) * samplesPerBucket);
  let m = 0;
  for (let j = start; j < end; j++) {
    const v = channel[j];
    const a = v < 0 ? -v : v;
    if (a > m) m = a;
  }
  peaks[i] = m;
  if (m >= CLIPPING_THRESHOLD) clipped[i] = 1;
  if (m > max) max = m;
}
```

**Render loop**

Per-x bar render takes a second pass to OR the clipped flag across the source buckets that map to this pixel column:

```ts
for (let x = 0; x < w; x++) {
  const startB = Math.floor((x / w) * PEAK_CACHE_SIZE);
  const endB = Math.max(startB + 1, Math.floor(((x + 1) / w) * PEAK_CACHE_SIZE));
  let amp = 0;
  let clip = 0;
  for (let b = startB; b < endB; b++) {
    const v = peaks[b];
    if (v > amp) amp = v;
    if (clipped[b]) clip = 1;
  }
  ctx.fillStyle = clip ? CLIP_COLOR : BAR_COLOR;
  const barH = Math.max(1, Math.round(amp * norm * half));
  ctx.fillRect(x, mid - barH, 1, barH * 2);
}
```

The `ctx.fillStyle` reassignment per-bar is cheap (4096 pixels worst-case at a typical sidebar width); no batching needed.

**Color token**

CONTEXT D-11 chose amber. The existing token `--warning-tint: oklch(0.82 0.14 70)` (DECISIONS.md 2026-04-25) is the right tint family-wise. Resolve at draw time:

```ts
const CLIP_COLOR = getComputedStyle(document.documentElement)
  .getPropertyValue("--warning-tint")
  .trim() || "#d4a76a"; // fallback if token missing
```

Compute once at effect-mount; cache in a ref or compute-on-first-draw. Don't re-resolve every animation frame.

**Done-when**

- Open the review window on a recording with no clipping → all bars render in `BAR_COLOR` (#6f6f74). No visual change vs Phase 10.
- Open on a recording made shouting into the mic → buckets that hit the limit render in `--warning-tint` amber. The clipped regions are clearly distinguishable at a glance.
- No microphone → "No microphone" empty state unchanged.
- Loading state unchanged.
- Resize the review window → clipping highlights track the resize (the second-pass per-x render correctly ORs the clipped mask).

**Verification fixture**

Make a quick clipping recording during c1 verification: record yourself for ~3s with a couple of intentionally loud claps near the mic. Confirm amber bands appear at the clap timestamps.

---

## c2 — Capture-side soft-knee limiter

`src-tauri/recording-engine/Sources/recording-engine/RecordingSession.swift`. Swift-only.

### Audio format reconnaissance

Before implementing, confirm what SCK delivers on the `.microphone` SCStreamOutputType. The current `audioInput` is configured with:
- `AVFormatIDKey: kAudioFormatMPEG4AAC` (encoder target)
- `AVSampleRateKey: 48000`
- `AVNumberOfChannelsKey: 1`

But the **input** CMSampleBuffer from SCK is PCM — AAC is the writer's encode target, not the buffer format. SCK typically delivers `Float32` interleaved or non-interleaved PCM. Verify at planning entry: log `CMSampleBufferGetFormatDescription` once on the first mic sample to confirm format (mono Float32 at 48kHz is the working assumption). If SCK delivers Int16 or some other format, branch the implementation accordingly.

### Limiter helper

New file or inline private method on `RecordingSession`. Inline is fine for this scope (~30 lines).

```swift
// Per-sample soft-knee limiter at -1 dBFS.
// threshold = 10^(-1/20) ≈ 0.8913
// Above threshold, magnitude follows: y = threshold + (1 - threshold) * tanh((|x| - threshold) / (1 - threshold))
// Sign of x is preserved.
private static let limiterThreshold: Float = 0.8913
private static let limiterKnee: Float = 1.0 - limiterThreshold  // 0.1087

private func applyLimiter(_ samples: UnsafeMutablePointer<Float>, count: Int) {
    let t = Self.limiterThreshold
    let k = Self.limiterKnee
    for i in 0..<count {
        let x = samples[i]
        let mag = x < 0 ? -x : x
        if mag <= t { continue }
        let over = mag - t
        let limited = t + k * tanh(over / k)
        samples[i] = x < 0 ? -limited : limited
    }
}
```

`tanh` is `Foundation.tanh` — import Foundation already present. Per-sample cost is dominated by the `tanh` call; at 48kHz mono and ~480 samples per 10ms buffer, the cost is negligible relative to ScreenCaptureKit's video work.

### Buffer interception

The `.microphone` branch of `stream(_:didOutputSampleBuffer:of:)` (RecordingSession.swift:283) currently passes the buffer straight through to `append()`. Apply the limiter before append, in-place where possible.

**Approach**: get the `CMBlockBuffer` backing the sample buffer via `CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer`, walk its `AudioBufferList`, call `applyLimiter()` on each `mData` pointer.

```swift
case .microphone:
    guard let audioInput else { return }
    applyLimiterInPlace(sampleBuffer)  // <-- new
    append(sampleBuffer, to: audioInput, isVideo: false)
```

```swift
private func applyLimiterInPlace(_ buffer: CMSampleBuffer) {
    var ablSize = 0
    var blockBuffer: CMBlockBuffer?
    // Probe needed size first.
    var status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
        buffer,
        bufferListSizeNeededOut: &ablSize,
        bufferListOut: nil,
        bufferListSize: 0,
        blockBufferAllocator: nil,
        blockBufferMemoryAllocator: nil,
        flags: kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment,
        blockBufferOut: nil
    )
    guard status == noErr, ablSize > 0 else { return }
    let ablPtr = UnsafeMutableRawPointer.allocate(byteCount: ablSize, alignment: 16)
    defer { ablPtr.deallocate() }
    let abl = ablPtr.bindMemory(to: AudioBufferList.self, capacity: 1)
    status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
        buffer,
        bufferListSizeNeededOut: nil,
        bufferListOut: abl,
        bufferListSize: ablSize,
        blockBufferAllocator: nil,
        blockBufferMemoryAllocator: nil,
        flags: kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment,
        blockBufferOut: &blockBuffer
    )
    guard status == noErr else { return }
    let buffers = UnsafeMutableAudioBufferListPointer(abl)
    for ab in buffers {
        guard let data = ab.mData else { continue }
        let count = Int(ab.mDataByteSize) / MemoryLayout<Float>.size
        let p = data.bindMemory(to: Float.self, capacity: count)
        applyLimiter(p, count: count)
    }
}
```

The `kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment` flag retains the original CMBlockBuffer; mutations to `mData` propagate to the sample buffer because the audio buffer list points at the same backing memory. The `blockBuffer` out-param holds a retain so the data stays alive through `append()`.

**If SCK delivers Int16 instead of Float32** (verify during reconnaissance step): branch the limiter on `mFormatFlags` from `CMAudioFormatDescriptionGetStreamBasicDescription`. Int16 path scales to/from Float32 once per buffer or applies an integer-domain version of the same curve. Working assumption: Float32, single path.

### Single-audio-source rule

CONTEXT D-17 — SCK still owns mic capture (`captureMicrophone = true` at RecordingSession.swift:154). No `AVAudioEngine`, no `AVCaptureSession`. A/V sync semantics unchanged. The limiter is a pure transform on the sample bytes; PTS and buffer timing are not touched.

### Done-when

- Record a 5-second take while clapping near the mic. Open the review window. Waveform shows no bars at the absolute peak — capture-side limiter prevented clipping. Compare to a pre-c2 reference recording (same setup) where bars hit the ceiling.
- Normal-volume speech sounds visually and audibly identical to pre-c2. The limiter is inactive below the threshold; only the loudest peaks get curved.
- Recordings with no microphone selected complete successfully (the `.microphone` branch is never entered).
- iPhone Continuity Camera + iPhone-mic still fails with the documented SCK error (unaffected by c2).
- `audioAppended` / `audioDropped` counts unchanged vs pre-c2 (sample count is preserved).

### Verification fixture

Record three test takes during c2 verification:
1. Quiet speech (~conversational volume) — confirm no audible artifact, waveform matches pre-c2.
2. Loud speech / shouting — confirm waveform tops out below the ceiling instead of hitting it.
3. Hand claps next to mic — confirm clipping is prevented (waveform peaks below the limit).

Save both pre-c2 and post-c2 versions to `docs/spike/audio-limiter/` or similar for the duration of the phase. Discard after c3 closes.

---

## c3 — Export-side arnndn noise reduction + noop hard-link removal

`src-tauri/src/edit.rs`, `src-tauri/src/lib.rs`, `tauri.conf.json`, bundled resource. The biggest commit of the phase.

### Bundled model

1. Download a single RNNoise model from [GregorR/rnnoise-models](https://github.com/GregorR/rnnoise-models). Working candidate: `cb.rnnn` (general-purpose speech model). If a quick A/B during build favors a different model, pick that one — the choice is locked when the file ships.
2. Place at `src-tauri/resources/audio/rnnoise.rnnn`. Single file, ~100KB.
3. Add to `tauri.conf.json` under `bundle.resources`:
   ```json
   "bundle": {
     "active": true,
     "targets": "all",
     "resources": ["resources/audio/rnnoise.rnnn"],
     "icon": [...]
   }
   ```
   Resources are copied into the `.app` bundle at `Contents/Resources/` by Tauri at build time. In dev mode (`tauri dev`), the file is resolved relative to the project's `src-tauri/` directory.

### Model path resolver (Rust)

`AppHandle::path().resource_dir()` is the runtime resolver. To avoid threading `AppHandle` through `edit.rs`, initialize a module-level `OnceLock<PathBuf>` from `lib.rs::run` setup and read it from `edit.rs`:

```rust
// edit.rs
static AUDIO_MODEL_PATH: OnceLock<PathBuf> = OnceLock::new();

pub(crate) fn audio_model_path() -> &'static Path {
    AUDIO_MODEL_PATH
        .get()
        .expect("audio model not initialized — call set_audio_model_path() in lib.rs::run setup")
        .as_path()
}

pub fn set_audio_model_path(path: PathBuf) {
    let _ = AUDIO_MODEL_PATH.set(path);
}
```

```rust
// lib.rs::run setup block
let resource_dir = app.path().resource_dir().expect("resource_dir");
let model_path = resource_dir.join("resources/audio/rnnoise.rnnn");
if !model_path.exists() {
    log::error!("audio model missing at {}", model_path.display());
}
edit::set_audio_model_path(model_path);
```

The model is required at startup — if it's missing the bundle is broken. Log and continue; arnndn will fail at first save with a clear ffmpeg error rather than silently skipping.

(Exact path layout under `resource_dir` may need a tweak — Tauri sometimes flattens `resources/` prefix at bundle time. Verify the actual on-disk layout after first `tauri build` and adjust the `join()` accordingly. Working assumption: file lands at `resource_dir.join("resources/audio/rnnoise.rnnn")`.)

### Pipeline integration

In `run_edit_pipeline`, the audio-tail section currently looks like:

```rust
PipelineMode::Mp4 { .. } => {
    args.push("-c:v".into());
    args.push("h264_videotoolbox".into());
    ...
    args.push("-c:a".into());
    args.push("aac".into());
    args.push("-b:a".into());
    args.push("192k".into());
}
```

Add `-af arnndn=m=<path>` for MP4 mode only. ffmpeg's `-af` is positional — it applies to the next output's audio stream. Sequence it after the audio mapping in the existing args build:

```rust
PipelineMode::Mp4 { .. } => {
    // Noise reduction via RNNoise. Applied before AAC encode; trim is
    // already done at -ss/-to demux level so timing is unaffected.
    args.push("-af".into());
    args.push(format!("arnndn=m={}", audio_model_path().display()));
    args.push("-c:v".into());
    args.push("h264_videotoolbox".into());
    ...
}
```

ffmpeg's filter chain runs in order: demuxer trim (`-ss`/`-to`) → audio filter (`arnndn`) → audio encoder (`aac`). No ordering arg needed.

**GIF path unchanged.** `PipelineMode::Gif` doesn't emit audio (no `-map 0:a?` for GIF mode), so arnndn would be a dangling no-op flag — and adding it would arguably trip ffmpeg on streams it can't apply to. Keep the GIF branch as-is.

**Recordings with no audio.** When the source MP4 has no audio stream, the existing `-map 0:a?` (with `?` making the audio mapping optional) means ffmpeg simply emits no audio output. `-af` on a non-existent stream should be ignored cleanly. Verify during c3 testing with a screen-only-no-mic recording.

### Noop hard-link removal

`save_recording`'s MP4-Source-noop path currently does:

```rust
if res == Mp4Resolution::Source && is_edit_pipeline_noop(&sidecar, duration) {
    if std::fs::hard_link(source, &output).is_err() {
        std::fs::copy(source, &output)?;
    }
} else {
    run_edit_pipeline(...)?;
}
```

Replace with:

```rust
// Phase 12: every MP4 save runs the pipeline so always-on arnndn applies.
// The pre-Phase-12 hard-link short-circuit produced byte-identical
// copies but inherited the captured-raw audio noise; that's now
// considered the wrong default.
run_edit_pipeline(source, &output, &sidecar, PipelineMode::Mp4 { resolution: res })?;
```

`is_edit_pipeline_noop` and the early-exit branch become dead in the MP4 path. Keep the helper — it's only ~10 lines and could become useful again if a future "raw export" lane is added. Or delete; planner choice during build. Lean delete: YAGNI says keep the diff minimal.

### Test impacts

`save_recording_baseline` (edit.rs:910+) currently asserts that the noop MP4-Source path produces a hard-linked output with the same inode as the source. **This assertion no longer holds** — every MP4 save is now a fresh ffmpeg-produced file. Update the test:

- Remove the `ino()` comparison block (lines 956-961).
- Replace with: assert output exists, is a regular file with `metadata.len() > 0`, and is **not** the same inode as the source (sanity-check the inverse).
- Per-format collision still works — second call writes `-2.mp4`. That assertion stands.

The `mp4_save_baseline` test (lines 828+) does not assert hard-link semantics on the Source path — it asserts dimension equality, which still holds. No change needed.

Both tests are `#[ignore]` and require local baseline files; they're manually run, not CI.

### Done-when

- Record a take in a noisy room (HVAC running, fan, ambient hum). Save as MP4-Source. Play the result: background noise is audibly suppressed compared to the raw scratch. Save the raw scratch separately via a one-off ffmpeg command for an A/B reference.
- Save the same recording as MP4-1080p, MP4-720p, MP4-480p — arnndn applies in all four cases.
- Save as GIF (any resolution) — file produces normally, no audio, no ffmpeg error from a dangling `-af` flag.
- Save a screen-only recording (no mic selected) — completes successfully; arnndn is a clean no-op on the missing audio stream.
- The bundled `.app` (`tauri build`) ships with the model under `Contents/Resources/`. Launch from `/Applications/`, save a recording → noise reduction works against the bundled path.
- Updated `save_recording_baseline` test passes when run manually with the baseline fixture.

### Save-time measurement (required during c3 verification)

CONTEXT D-07 acknowledges the noop-save regression. Measure the actual impact on representative recordings to confirm it's small and document the number in the ADR:

1. Make three test recordings of varying length: ~30s, ~2min, ~5min. Each captures a representative dashboard demo (mostly static UI + occasional cursor + speech).
2. For each, time `save_recording` with MP4-Source / no edits:
   - **Pre-c3**: zero-ffmpeg hard-link (Phase 11 baseline). Time on existing main branch before this commit.
   - **Post-c3**: full pipeline pass with arnndn + AAC + h264_videotoolbox.
3. Record wall-clock seconds for each, both pre and post. Expected: post-c3 takes a few seconds even on a 5-min recording (h264_videotoolbox is hardware-accelerated, arnndn is real-time-ish, AAC encode is fast). If it takes more than ~10s on a 5-min recording on this machine, surface that — the trade-off case becomes weaker.
4. Document the numbers in the c3 ADR (below).

### DECISIONS.md ADR (written in c3)

Append a new entry at the top of `docs/DECISIONS.md`:

```markdown
## 2026-05-20 — Always-on arnndn on every MP4 export; noop hard-link removed

Phase 12 makes ffmpeg's `arnndn` noise reduction always-on for every MP4 save
(`-af arnndn=m=<bundled-rnnoise>.rnnn`, applied between demuxer trim and AAC
encode). The bundled RNNoise model ships under `Contents/Resources/audio/`
via `tauri.conf.json` bundle.resources.

**Trade-off**

Background noise (HVAC, fan, room hum) was clearly audible in Phase 11
recordings. Choices:

- Always-on, no UI: every MP4 export is treated. Wins on simplicity and
  consistency; loses the Phase 11 noop hard-link short-circuit for
  MP4-Source-no-edits saves, which previously cost zero ffmpeg passes.
- Per-recording toggle: preserves the noop fast path when off, but adds UI
  state that doesn't persist across restarts and surfaces a configuration
  decision users shouldn't have to make for every recording.
- Capture-side instead of export-side: would treat raw scratch, breaking
  the "scratch stays reversible" Phase 5.5/11 invariant.

We chose always-on export-side because the noise-reduction is a near-universal
improvement on real recordings, and the cost is a few wall-clock seconds per
save — not hot-path.

**Save-speed regression (measured during c3 verification)**

| Recording length | Phase 11 (hard-link) | Phase 12 (full pipeline) | Delta |
|---|---|---|---|
| ~30s | <FILL DURING c3> | <FILL DURING c3> | <FILL> |
| ~2min | <FILL DURING c3> | <FILL DURING c3> | <FILL> |
| ~5min | <FILL DURING c3> | <FILL DURING c3> | <FILL> |

Hardware: <user's machine, captured at measurement time>. h264_videotoolbox
is hardware-accelerated; arnndn and AAC are CPU. The regression is
intentional and accepted (PHASE-12-CONTEXT.md D-07).

**Scope**

- MP4 saves only — GIF is silent.
- LinkedIn export chains `save_recording(mp4, source)` (Phase 11 c4), so
  LinkedIn output inherits the noise reduction automatically.
- Copy-to-Clipboard runs the same pipeline (Phase 11 c2) — also inherits.

The `is_edit_pipeline_noop` helper survives but no longer gates the MP4 save
path; reserved for future "raw export" lanes if they materialize.
```

Capture the actual save-time numbers during c3 verification before committing the ADR. The ADR is written in the same commit as the code change; if measurement falsifies the "few seconds" claim (e.g., 5-min recordings take 30s+), flag and re-discuss before committing.

---

## Phase done-when

- A recording made in a noisy room exports with audible background noise suppressed (c3 verified).
- The review-window waveform marks clipped buckets with amber tint (c1 verified).
- A loud capture that would have clipped without the limiter exports clean — visible as no peaks hitting the ceiling in the waveform (c2 verified).
- All MP4 export paths (Save as MP4 at any resolution, LinkedIn, Copy-to-Clipboard) inherit the always-on noise reduction.
- GIF exports unaffected.
- Recordings with no microphone unaffected.
- Save-time delta on noop MP4-Source measured and documented in DECISIONS.md.

## Out of plan (deferred, captured here for traceability)

Items considered during planning that explicitly do not ship in Phase 12:

- Per-recording NR/limiter toggle UI.
- Mic-level meter during capture.
- Mic gain control.
- Capture-side noise reduction (would touch raw scratch — breaks reversibility).
- AVAudioEngine effect-chain rewrite.
- Multi-channel / stereo mic handling.
- NR model picker in UI.
- Real-time waveform during capture.
- Configurable clipping threshold.

All covered in PHASE-12-CONTEXT.md §"Deferred Ideas."

---

*Phase: 12-audio-quality*
*Plan drafted: 2026-05-20*
