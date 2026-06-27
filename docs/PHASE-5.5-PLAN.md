# Phase 5.5 — Hardware-Accelerated Finalize + Progress Feedback

## Problem

Post-stop finalize originally did a full single-pass software h264 re-encode
(composite webcam overlay onto screen capture). Measured: ~4 min for a 10-min
recording (~0.4x realtime). Feedback during the wait was a bare spinner.

Target benchmark (Loom/CleanShot): <10s for 15 min.

## Workstream 1 — Encode speed [SHIPPED]

Goal was to cut finalize time 5-10x via Apple's hardware encoder without
regressing quality or the overlay composite. Done:

- Final encode uses `h264_videotoolbox -b:v 8M` (`edit.rs:982`). The composite
  filter graph is unchanged; only the encode is hardware-offloaded.
- Fast path: when there's no trim, no overlay, and no scale, video is
  stream-copied (`-c:v copy`, `edit.rs:977-979`) and only audio re-encodes
  (RNNoise/arnndn is always on). This is the near-instant remux the original
  plan deferred to "record-as-final," realized for the no-edit case.

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

## Workstream 2 — Progress feedback [GAP, not yet done]

Goal: replace the indefinite spinner with honest, duration-aware progress.

1. Parse ffmpeg's `-progress` stream (key `out_time_ms`). This is the actual
   remaining work — it is not yet wired into `edit.rs`, so this is the real
   remaining progress task. Drive a determinate bar from
   `out_time_ms / total_duration`.
2. Live ETA: derive remaining time from `out_time_ms` vs wall-clock elapsed
   after ~1-2s of encoding (`eta = elapsed * (total - done) / done`). This is
   self-correcting and resolution-independent — it needs no precomputed
   throughput constant and no benchmark, so it has no dependency on Workstream 1.
3. Skip the bar entirely for near-instant remuxes: the pipeline already
   distinguishes this case via the `mp4_video_can_copy` flag (`edit.rs`), so the
   progress UI can branch on it rather than flashing a bar that finishes
   immediately.

## Acceptance criteria

- 10-min recording finalizes in under ~45s (stretch: under 20s) [met by W1]
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
