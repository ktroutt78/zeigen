# Phase 5.5 — Hardware-Accelerated Finalize + Progress Feedback

## Problem

Post-stop finalize originally did a full single-pass software h264 re-encode
(composite webcam overlay onto screen capture). Measured: ~4 min for a 10-min
recording (~0.4x realtime). Feedback during the wait was a bare spinner.

Target benchmark (Loom/CleanShot): <10s for 15 min.

## Workstream 1 — Encode speed [ENCODER DONE; TARGET NOT MET — redundant 2nd encode]

Goal was to cut finalize time 5-10x via Apple's hardware encoder without
regressing quality or the overlay composite. The hardware encoder is in place,
but the <45s/10min target is NOT met — and the reason is NOT the filter graph.

What's done:

- Both encode passes use `h264_videotoolbox -b:v 8M`. The composite filter graph
  is software but free (see measurement below); only the encode is the cost.
- Fast path: when there's no trim, no overlay, and no scale, video is
  stream-copied (`-c:v copy`, `edit.rs:977-979`) and only audio re-encodes
  (RNNoise/arnndn is always on).

### Measured 2026-06-26 (6m39s clip, screen 1470x956 @ 60fps + webcam overlay)

- Stop -> review window: **0.44s** (near-instant — Phase 15 c3 deferral works).
- Save/export: **~80s**, split across TWO full ~40s encodes:
  - Pass 1 `composite()` (screen+webcam -> composite.mp4): ~40s, NECESSARY.
  - Pass 2 `run_edit_pipeline_single_input()`: **40.15s**, WASTED here.

Filter-vs-encode split on the real source proves the filter is not the cost:

| Test | What | Elapsed |
|------|------|---------|
| A | Full composite filter (overlay + circular mask + scale) + videotoolbox | 39.71s |
| B | Encode-only, no overlay/filter, videotoolbox | 39.94s |
| C | Pass 2 as `-c:v copy` + AAC + faststart | 6.33s |

A ~= B: the overlay/mask/scale filter adds ~0s. The circular mask was already
optimized to a pre-rendered PNG + `alphamerge` (composite.rs:556-559), not a
per-frame `geq`. The ~40s/pass is purely decode+encode of 60fps 1470x956
(~10x realtime).

### Root cause of the wasted pass 2: no-op resolution scale

The review window's default save resolution is `1080p` (`Review.tsx:346`). On a
1470-wide source the `P1080` scale (`'min(iw,1920)':-2`) resolves to 1470 wide —
output is byte-for-byte the same dimensions — but `mp4_scale.is_some()` still
sets `needs_filter = true` (`edit.rs:843-847`), forcing pass 2 down the full
re-encode branch instead of the 6.33s copy path. With no annotations, no trim,
and no watermark, pass 2 did 40s of work to change nothing.

### Fix A — skip no-op resolution scale [SHIPPED]

NOT a filter optimization (the filter is free, proven above). When the requested
mp4 resolution would not actually shrink the source, `mp4_scale` is set to `None`
so `needs_filter` stays false and pass 2 collapses to the copy path. Compares
against the dimension each scale filter constrains (P480/P720 force height,
P1080 caps width at 1920) — general rule, no source-specific constants. A
`<=1080p` source under the default 1080p setting now lands on the copy path.

Proven 2026-06-27 with live instrumentation on a 181.2s clip (same clip, only
the watermark toggled):

| Pass 2 | Path | Elapsed |
|--------|------|---------|
| no-op scale, watermark ON  | re-encode | 18.27s |
| no-op scale, watermark OFF | `mp4 copy (fast remux)` | 3.02s |

~6x faster on pass 2. For the original 6m39s no-watermark case this is
~40s composite + ~6s copy = **~46s, down from ~80s** — target met.

### Watermark caveat — why Fix A is not enough for the real workflow

Fix A only removes the *resolution-scale* trigger for `needs_filter`. A
**watermark is an independent trigger**: `needs_filter = ... || watermark.is_some()`
(`edit.rs:868`). A logo overlay genuinely cannot be stream-copied, so any
watermarked export still re-encodes in pass 2 regardless of Fix A. Confirmed in
the instrumentation: with the watermark on, `mp4_scale_is_some=false` (Fix A
working) but `needs_filter=true (wm=true) -> can_copy=false`.

The real recording workflow watermarks its exports, so Fix A does not speed up
the common case in practice — that is the motivation for **Fix B** (planned as
the next workstream), which folds the watermark into the single composite pass.

Orthogonal lever (product decision, not a fix): screen is captured at 60fps;
each encode is ~10x realtime there. Compositing/exporting at 30fps would roughly
halve the encode floor (~40s -> ~20s).

## Workstream 1a — Output correctness + browser compat

### faststart [SHIPPED this commit]

AVAssetWriter writes the moov atom at the end (`shouldOptimizeForNetworkUse` is
unset in `RecordingSession.swift:155`, Apple's default), and ffmpeg's mp4 muxer
defaults to the same. Verified concretely: standard saved outputs
(`recording-2026-06-23-105847.mp4`, `VizIQ Demo.mp4`) parse as
`ftyp / free / mdat / moov` — moov-after-mdat, so the Cloudflare `/v/[id]`
viewer would stall on progressive playback until the full file downloaded.

Fix: `-movflags +faststart` on the mp4 output (`edit.rs`), applied on BOTH
branches. faststart is a post-mux relocation of the moov atom, so it works with
`-c:v copy` — no separate remux pass is needed (verified: a `-c:v copy` output
with `+faststart` parses as `ftyp / moov / free / mdat`). The copy path always
runs ffmpeg anyway because audio is re-encoded for noise reduction.

### Browser-compat flags [SHIPPED this commit]

VideoToolbox re-encode branch now also emits `-profile:v high -pix_fmt yuv420p
-tag:v avc1 -allow_sw 1`. High profile + yuv420p keep the stream decodable in
browser-native players, avc1 is the standard sample-entry tag, and allow_sw
falls back to the software encoder when the HW session is contended instead of
hard-failing the save. The copy path needs none of these — its source is
already h264/avc1/yuv420p from AVAssetWriter.

## Workstream 1b — Adaptive bitrate [GAP, not yet done]

`-b:v 8M` is flat regardless of resolution/fps. A 4K screencast and a 720p one
get the same budget: under-provisions 4K screen text (the "text stays legible"
criterion) and wastes bits at 720p. Fix: scale target bitrate by output
resolution, or switch to VideoToolbox's quality mode (`-q:v`) which adapts to
content. Deferred from the faststart commit on purpose.

## Workstream 1c — Fix B: single-pass watermark composite [PLAN, no code yet]

Goal: make a watermarked webcam export reach the copy path on pass 2 (like Fix A
already does for non-watermarked exports) by folding the watermark overlay into
the pass-1 composite, so it is no longer a `needs_filter` trigger in pass 2.

### Current vs proposed

- **Current:** `composite()` (composite.rs) overlays screen + webcam + shadow and
  encodes to `composite.mp4` (`-c:a copy`, no watermark). Then
  `run_edit_pipeline_single_input()` (edit.rs pass 2) adds the watermark as a
  filter node, applies audio RNNoise + faststart + browser-compat, and
  re-encodes. With a watermark, `needs_filter=true` (`edit.rs:868`) forces pass 2
  into a full second `h264_videotoolbox` re-encode (~40s on a 6.6-min clip).
- **Proposed:** apply the watermark inside `composite()`'s filter graph (one
  encode, alongside the webcam overlay). `run_edit_pipeline()` then passes
  `watermark: None` to pass 2 for the webcam path. With no watermark, no
  annotations, no trim, and Fix A skipping the no-op scale, pass 2's
  `needs_filter=false` -> video copy + audio NR + faststart (~6s, the test-C
  path). Screen-only exports (no `composite()` call) keep the watermark in pass 2
  unchanged — they are single-pass already, so no double-encode to remove.

### Single-pass composite graph with the watermark

The watermark is an independent overlay using the logo PNG's own alpha — it does
NOT touch the webcam `alphamerge`/circular-mask chain. Append it after the final
`[outv]` the existing graph builds:

```
... existing shadow + bubble overlays -> [outv_pre];
[<logo_idx>:v]scale=-2:<wm_h>[wm];
[outv_pre][wm]overlay=<wm_xy>[outv]
```

Reuse `Watermark::filter_fragment` / `metrics` / `overlay_xy` (already in
composite.rs) with the SCREEN dimensions as `(sw, sh)` — identical to what pass 2
feeds today, so placement and size are byte-for-byte the same. Plumbing:

- Add `watermark: Option<Watermark>` to `composite()`; add `-i <logo>` as the
  input after the mask + shadow inputs; bump `logo_idx` accordingly.
- The watermark overlay must attach to whichever label is the final composite
  output in ALL THREE position-log branches (empty-log static, inline-expr, and
  the dead split path) — rename their terminal `[outv]` to `[outv_pre]` and add
  the single watermark overlay once after the branch.
- `run_edit_pipeline()`: pass the (existence-checked) watermark to `composite()`
  on the webcam path and `None` to `single_input`; leave the screen-only path
  passing watermark to `single_input` as today.
- Preserve the "skip a missing logo with a warning" guard (move/duplicate it so
  composite() never fails an export over a deleted logo).

### Expected time

Watermark overlay adds ~0s to the encode (same as the webcam overlay — proven by
the A==B split). So a watermarked 6.6-min export: ~40s composite (now incl.
watermark) + ~6s pass-2 copy = **~46s, down from ~80s** — matching Fix A's
non-watermarked numbers. Bonus: the watermark is now encoded once instead of
drawn onto an already-encoded composite, removing one generation of re-encode
loss (slight quality improvement).

### Risks

- **Positioning/size drift:** must use the screen `(sw, sh)` for
  `Watermark::metrics`/`overlay_xy`, exactly as pass 2 does, or the logo moves or
  resizes. Mitigation: same dims + a before/after pixel diff on one clip.
- **Filter-label wiring:** composite.rs has three position-log branches; the new
  overlay must hang off the final node in each. A missed branch = a broken graph
  or a dropped watermark. Mitigation: rename to `[outv_pre]` in each branch and
  add the watermark overlay in one shared place.
- **eof_action:** the logo is a single still; rely on overlay's default
  `eof_action=repeat` to hold it for the clip (as the current pass-2 fragment
  does) — no `-loop` needed.
- **alphamerge interaction:** none expected — the watermark uses the logo's PNG
  alpha and is a separate overlay after the bubble; it never enters the
  webcam mask chain. Call out as a thing to verify, not a known problem.
- **GIF path:** `composite()` runs for GIF too (then single_input transcodes);
  moving the watermark there keeps GIF watermarking working — verify a GIF export
  still shows the logo.

### Out of scope for Fix B

Audio RNNoise + faststart stay in pass 2 (the copy path handles them in ~6s, per
test C). Eliminating pass 2 entirely (folding audio NR + faststart into
composite) is a larger follow-up, not needed to hit the ~46s target.

## Workstream 2 — Progress feedback [GAP, not yet done]

Goal: replace the indefinite spinner with honest, duration-aware progress.

1. Parse ffmpeg's `-progress` stream (key `out_time_us`). The composite pass
   already streams `-progress pipe:1` and parses `out_time_us` into an
   `on_progress` callback (`composite.rs:469,699-715`); the gap is the
   `edit.rs` single-input pass, which has no `-progress`. Wire the same parsing
   there and drive a determinate bar from `out_time / total_duration` across
   both passes.
2. Live ETA: derive remaining time from `out_time_ms` vs wall-clock elapsed
   after ~1-2s of encoding (`eta = elapsed * (total - done) / done`). This is
   self-correcting and resolution-independent — it needs no precomputed
   throughput constant and no benchmark, so it has no dependency on Workstream 1.
3. Skip the bar entirely for near-instant remuxes: the pipeline already
   distinguishes this case via the `mp4_video_can_copy` flag (`edit.rs`), so the
   progress UI can branch on it rather than flashing a bar that finishes
   immediately.

## Follow-up — redundant preview-audio render [GAP, separate from export]

Opening a review window renders the noise-reduced preview audio twice: the log
shows two `[preview-audio] start` lines per single open (one finished at 6.43s,
a second kicked off immediately). That's ~6s of duplicate work per open on a
6-min clip. Likely a double-invoke of `render_preview_audio` on review mount.
Investigate and de-dupe; track separately from the export-speed work.

## Acceptance criteria

- 10-min recording finalizes in under ~45s (stretch: under 20s) [NOT met —
  measured ~80s for a 6m39s clip (~120s/10min projected) because the export runs
  two full encodes; see W1 "eliminate the redundant second encode"]
- Output mp4 is faststart and plays in browser-native players and the Cloudflare
  viewer page [met by W1a]
- Screen text stays legible; webcam overlay composite still renders correctly
  [adaptive bitrate, W1b, will further protect 4K legibility]
- Progress bar reflects genuine ffmpeg `-progress`, not a fake animation [W2]
- Live ETA within a reasonable margin on a 10-min recording [W2]

## Risk / fallback

If VideoToolbox quality is ever unacceptable, fall back to libx264 with
`-preset veryfast` — smaller win, safe lever. Two-pass isn't available for
VideoToolbox, so bitrate/quality tuning (W1b) is the only encode-side lever.
Workstream 2 is fully independent and lands regardless of encoder choice.
