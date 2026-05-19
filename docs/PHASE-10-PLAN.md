# Phase 10 — Review window: GIF export + timeline waveform — Plan

**Drafted:** 2026-05-19
**Status:** Ready to execute
**Source of truth for decisions:** `docs/PHASE-10-CONTEXT.md`

Two deliverables landing in `src/Review.tsx`, both extending existing Phase 5/6 infrastructure rather than adding new modules.

- **10.1 GIF quick export** — extends `run_edit_pipeline` (`src-tauri/src/edit.rs`) with a `PipelineMode` enum. Same trim + annotation graph, swapped tail.
- **10.2 Timeline waveform** — pure frontend. Web Audio decode + `<canvas>` peaks, drops behind the existing dim/pip/handle layers in `Timeline`.

No new Rust modules. No new JS dependencies.

## Backend — `src-tauri/src/edit.rs` + `lib.rs`

### c1: Parameterize `run_edit_pipeline`

Add to `edit.rs`:

```rust
pub enum GifResolution { P480, P720, Source }
pub enum PipelineMode {
    Mp4,
    Gif { resolution: GifResolution, fps: u32 },
}
```

Refactor `run_edit_pipeline` (`edit.rs:421`) to take `mode: PipelineMode`. Branch points:

1. **Force-build filter graph in Gif mode.** Today the `needs_filter` block at `edit.rs:513` is skipped when there are no annotations. GIF always needs the tail filter, so when `mode == Gif`, start the chain from `[0:v]` even with no overlays.
2. **Tail filter (Gif only).** After the overlay chain ends at `[prev_label]`, append:
   ```
   ;[prev_label]fps=<fps>,scale=<width>:-2:flags=lanczos,split[gA][gB];[gA]palettegen=stats_mode=diff[gP];[gB][gP]paletteuse=dither=bayer:bayer_scale=5[gout]
   ```
3. **Encoder args.** Replace the `h264_videotoolbox`/`aac` block at `edit.rs:575-582` with mode-aware tail:
   - `Mp4`: unchanged (`-c:v h264_videotoolbox -b:v 8M -c:a aac -b:a 192k`, audio mapped via `0:a?`).
   - `Gif`: `-map [gout] -loop 0` only. No `-c:v`, no `-b:v`, no audio map. ffmpeg picks GIF muxer from the `.gif` extension.

`is_edit_pipeline_noop` (`edit.rs:400`) stays MP4-only — GIF always re-encodes.

**Resolution → scale arg**
- `P480` → `scale=-2:480`
- `P720` → `scale=-2:720`
- `Source` → `scale='min(iw,1920)':-2` (1080p ceiling per CONTEXT D-01)

**Discretion picks** (CONTEXT "Claude's Discretion"):
- `palettegen=stats_mode=diff` — weights moving pixels; better than `full` for screen recordings where most of the frame is static.
- `paletteuse=dither=bayer:bayer_scale=5` — preserves UI gradients without `sierra2_4a`'s noise floor.

### c1 — Done-when (regression-proof refactor)

Frame-metadata equivalence on the MP4 path. Steps:

1. On `main` (before c1), select a representative recording from `~/Movies/Zeigen/` and stage a sidecar containing trim + at least one text annotation + at least one arrow. Run a Save edit through the review window. Capture `ffprobe -v error -select_streams v:0 -show_entries frame=pkt_pts_time,pict_type,pkt_size -of csv <output>` to a baseline CSV.
2. Land c1.
3. Repeat the same Save against the same source + same sidecar. Extract the same CSV. Diff against the baseline.

**Frame-metadata mismatch fails c1.** If the CSVs differ, the divergence is right there in the diff — locate which frame and whether PTS, picture type, or packet size drifted. `run_edit_pipeline` is a pure function of (source, sidecar, mode) and any frame-metadata change on MP4 means the refactor introduced a side effect.

**Why frame metadata and not SHA-256.** Originally this section asked for byte equivalence. That bar is unachievable on this hardware: `h264_videotoolbox` is not bit-deterministic. Five independent runs of the same source + same sidecar (two pre-c1, three post-c1) on the c1 verification produced five different SHA-256s, all the same file size, with the diff always a single byte deep in the H.264 NAL payload. Frame metadata was byte-identical across all five. The 1-byte drift is encoder-internal entropy; the functional output (PTS, picture type, packet size, audio stream params) is stable. Frame-metadata equivalence is therefore the right and only attainable functional bar for the MP4 path.

> **Footnote — when even frame metadata isn't.** The encoder is metadata-deterministic on a fixed OS/firmware build. Apple has shipped macOS updates that nudge VideoToolbox behavior (rare, but it happens). If frame metadata mismatches and the code diff looks clean, first check whether macOS or the system firmware updated between captures. Re-capture the baseline CSV on the same OS build as the c1 build and retry before chasing the diff.

### c2: New command `gif_export` (lives in `edit.rs`)

`gif_export` lives in `src-tauri/src/edit.rs` alongside `run_edit_pipeline` — it is a thin wrapper over the parameterized pipeline and does not warrant a separate module. (Compare `linkedin::linkedin_export`, which lives in its own file because it has its own encoding logic; GIF has none beyond what `run_edit_pipeline` provides.)

Mirrors the shape of `linkedin::linkedin_export` (`linkedin.rs:62`):

```rust
#[tauri::command]
pub fn gif_export(
    stamp: String,
    source_path: String,
    resolution: String,  // "480p" | "720p" | "source"
    fps: u32,
) -> Result<String, String>
```

- Reads sidecar via `read_sidecar_path`.
- Output: `~/Movies/Zeigen/recording-<stamp>.gif`. Persists across discard/cleanup (same as LinkedIn output).
- Parses `resolution` string to `GifResolution`. Unknown value → error.
- Calls `run_edit_pipeline(source, output, &sidecar, PipelineMode::Gif { resolution, fps })`.
- Returns the output path.

Register in `lib.rs:613` alongside `linkedin::linkedin_export`.

**Done-when:** Manually invoke from JS (temp button or devtools) — `.gif` appears at the expected path and opens in Preview. Trim from the sidecar is honored.

## Frontend — `src/Review.tsx` + `src/Waveform.tsx`

### c3: Wire GIF in `ExportPanel`

Current state: `Review.tsx:2402-2453` renders an inert "Coming later" block with three flat buttons (`MP4 | GIF | ProRes`).

Changes:

1. **Drop the inert wrapper** at `2402-2408` (`aria-hidden`, `opacity: 0.4`, `pointerEvents: none`).
2. **Drop the "Coming later" caption** at `2439` from the section header.
3. **Replace the three flat buttons** at `2443-2451` with a layout that surfaces GIF as the live control while keeping MP4/ProRes visible:
   - **Inline segmented controls** above the button row:
     - Resolution: `[480p | 720p | Source]`, default 720p (uses existing `.segmented` class).
     - FPS: `[10 | 15 | 20]`, default 15.
   - **Button row**: keep MP4 / GIF / ProRes shape. GIF is the active button (primary visual treatment). MP4 and ProRes are disabled with a small "Coming later" sub-caption beneath the row.
4. **Disabled styling for MP4/ProRes must read as "deferred," not "broken."** Concretely:
   - `cursor: default`, full text legibility (not greyed-illegible), no error-red affordances.
   - Small italic caption `Coming later` directly beneath the disabled buttons.
   - No tooltip implying failure. No spinner. No red border.

5. **`onGifExport` callback** mirrors `onLinkedinExport` (`Review.tsx:2264`):
   - Compute effective trim length from sidecar `trim` + `duration`.
   - **D-04 confirm.** If effective length > 30s: `window.confirm("This GIF will be ~Xs long and may be large. Continue?")`. Return on dismiss.
   - `invoke<string>("gif_export", { stamp, sourcePath: effectiveSource, resolution, fps })`.
   - On success: `revealItemInDir(outPath)`, transient "Exported" badge (1.5s, same shape as `linkedinExportedAt` at `Review.tsx:2256`).
   - On error: `setError(...)`.
6. **State** lives in `ExportPanel`: `gifResolution`, `gifFps`, `gifExporting`, `gifExportedAt`. Settings reset on app restart (matches PLAN.md Backlog).
7. **Disabled-while** condition: `!effectiveSource || busy || gifExporting`.
8. No cancel button this phase (CONTEXT "Deferred Ideas").

**Done-when:** Click GIF with a recording loaded → file appears at `~/Movies/Zeigen/recording-<stamp>.gif`, Finder reveals it, "Exported" badge flashes. Resolution + FPS presets affect output. >30s trim prompts a confirm. Disabled MP4/ProRes buttons read as "coming later," not broken.

### c4: Waveform replaces decorative gradient

**File:** new component at `src/Waveform.tsx`. Lives in its own file — `Review.tsx` is already 2,500+ lines, and a self-contained canvas component with its own decode/bucket/draw lifecycle does not belong inline.

Current Timeline state: `Review.tsx:1617` renders `repeating-linear-gradient` at `1731-1735` inside `<div ref={trackRef}>`. Dim rects, annotation pips, trim handles, playhead all layer on top via absolute positioning — those stay unchanged.

**Plan**

1. **Thread `assetUrl` down to `Timeline`.** The top-level Review component already computes `assetUrl = convertFileSrc(path)` for the video element; pass it through `MainPane` (`Review.tsx:778`) into `Timeline` props, and `Timeline` passes it to `<Waveform>`.
2. **`<Waveform>` mounts in place of the gradient div at `Review.tsx:1731-1735`.** The dim rect overlays at `1739-1762` remain on top, so trim-range dimming "just works."
3. **Lifecycle (inside `Waveform.tsx`):**
   - Mount → render flat 1px centerline placeholder.
   - After first paint, `requestIdleCallback` (fallback `setTimeout(0, ...)`) kicks off:
     ```
     fetch(assetUrl)
       → .arrayBuffer()
       → new AudioContext().decodeAudioData()
       → audioBuffer.getChannelData(0)
     ```
   - **Bucket once at fixed resolution (4096 peaks).** For each of 4096 buckets, compute `max(abs(sample))` across `samples.length / 4096` samples. Store in a `Float32Array(4096)` ref.
   - **Null the AudioBuffer ref immediately after bucketing.** The decoded PCM is the heavy allocation (~100MB for a 10-min recording); the 4096-peak cache is ~16KB. Releasing the ref allows GC during the lifetime of the review window.
   - **Re-bucketing on resize draws from the 4096 cache**, not the AudioBuffer. Display width is currently ~940px (well under 4096), so downsampling from the cache is sufficient. ResizeObserver on the canvas re-renders on width change.
4. **Render:**
   - Canvas sized to the existing 44px track height. Backing store scales by `devicePixelRatio`.
   - For each canvas-pixel column, sample the 4096-peak cache, draw a vertical bar from the centerline upward by `amp * halfHeight` and downward by `amp * halfHeight`.
   - Fill color: neutral grey (CONTEXT D-13). Concrete token pick during build — leaning `var(--fg-quaternary)` or a comparable muted-foreground token.

5. **Empty-state — three layers of detection.** Codebase audit (`RecordingSession.swift:128-142, 167-168`) confirms Zeigen omits the audio track entirely from the mp4 when no microphone is selected — it does not record a silent track. But mic-selected-but-effectively-silent cases happen in the wild (OS muting, dead mic, permission revoked mid-record), and the user-facing label should be the same. Detection order:

   a. `decodeAudioData` throws → render "No microphone" label. (Most likely path for no-mic-selected recordings.)
   b. Decode succeeds but `audioBuffer.numberOfChannels === 0` → render "No microphone" label. (Defensive — unlikely given Apple's decoder, but cheap to check.)
   c. Decode succeeds, peaks bucketed, but `max(peaks) < 0.001` across all 4096 buckets → render "No microphone" label. (Catches dead-mic / muted-mic / no-input cases.)

   Label is centered grey text in the track. CONTEXT D-14 prescribes the wording "No microphone" — keep that wording for all three cases even though (c) is technically "no audio detected." The user-visible outcome (a flat track with explanatory label) is what matters, and "No microphone" is the more common-sense root cause for a screen recorder.

**Memory release — explicit checklist**
- AudioBuffer ref is set, used to compute peaks, then set to `null` in the same `await` chain.
- The `ArrayBuffer` from `fetch().arrayBuffer()` is consumed by `decodeAudioData` and is not retained.
- Only the 4096-element `Float32Array` peaks cache survives the decode chain.

**Done-when:** Recording with audio shows mirrored peaks across the timeline; no-mic recording shows "No microphone"; muted-mic recording (manual test: select mic, mute system input, record) shows "No microphone"; trim dim rects darken the waveform outside the trim range; resize re-buckets cleanly; memory inspection in Safari Web Inspector confirms the AudioBuffer is collected after first paint.

## Build order

| # | Change | Done-when |
|---|---|---|
| c1 | `edit.rs` — `PipelineMode` param, force-graph + GIF tail wired. MP4 path byte-identical. | Hash check: shasum of MP4 output for a representative trim + text + arrow recording matches before/after. Footnote: confirm no macOS update between captures before chasing a phantom regression. |
| c2 | `gif_export` command (in `edit.rs`) + `lib.rs` registration. | Manual invoke produces a `.gif` at `~/Movies/Zeigen/recording-<stamp>.gif` that opens in Preview. Sidecar trim honored. |
| c3 | `ExportPanel` GIF row + inline preset controls + opacity lift. MP4/ProRes disabled-as-coming-later. | Click GIF → file appears, Finder reveals, "Exported" badge flashes. Presets work. >30s prompts confirm. MP4/ProRes read as deferred, not broken. |
| c4 | `src/Waveform.tsx` new component + thread `assetUrl` through `Timeline`. 4096-peak cache, AudioBuffer released post-bucket. Three-layer empty-state detection. | Visible waveform; mic-less and muted-mic both show "No microphone"; resize re-buckets; memory check confirms AudioBuffer GC. |

## Files touched

- `src-tauri/src/edit.rs` — `PipelineMode`, `GifResolution`, refactor of `run_edit_pipeline`, new `gif_export` command.
- `src-tauri/src/lib.rs` — register `gif_export`.
- `src/Review.tsx` — `ExportPanel` GIF row, preset state, `onGifExport`; thread `assetUrl` through `MainPane` → `Timeline` → `Waveform`; swap gradient div for `<Waveform>`.
- `src/Waveform.tsx` — new file. Canvas-based waveform component with decode/bucket/draw lifecycle and three-layer empty-state.

## Deferred (per CONTEXT)

- Cancel button + cancellable progress UI for GIF.
- Waveform sidecar JSON cache.
- Waveform-specific dimming/styling beyond what the existing trim dim rects provide.
- Waveform zoom.
- WebP / animated WebP.
- Trim-handle snap-to-peaks.
- Persisted GIF preset preferences (bundles with Settings persistence backlog).

---

*Phase: 10-review-gif-and-waveform*
*Plan drafted: 2026-05-19*
