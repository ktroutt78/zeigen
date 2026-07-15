# Zoom export rendering — Step 4 (NOT BUILT)

Status as of 2026-07-14. Captured before a context clear; this gap was not recorded anywhere.

## The gap

**Zooms currently exist ONLY in the Review preview and do NOT reach the exported mp4.** The
export path ignores the zoom track entirely. That is *why* the byte-identity / copy-path
invariant has held through all the zoom work (detection, suggestion, manual editing, the
Thread A conservative detector) — none of it touches export. **The whole zoom feature is
currently invisible outside the app.** A saved/exported recording has no zoom in it.

This is by design so far: detection and editing only write the sidecar `zoom` track, and
export reads it nowhere. Step 4 is where that changes and zoomed exports start paying a
re-encode.

## Prerequisites before Step 4 (already agreed — do these first)

1. **Restore the five dead stream-md5 guards.** They are `#[ignore]`d and cannot run because
   their May baseline recordings under `~/Movies/Zeigen/.scratch-baseline-c1/` are missing
   from this machine (dir confirmed absent 2026-07-14). A byte-identity guard that can't run
   isn't guarding — and Step 4 is exactly when real re-encoding starts, so these must be live
   before then. The five:
   - `save_recording_baseline` — `src-tauri/src/edit.rs`
   - `mp4_save_baseline` — `src-tauri/src/edit.rs`
   - `probe_audio_track_baseline` — `src-tauri/src/edit.rs`
   - `render_preview_audio_baseline` — `src-tauri/src/edit.rs`
   - `sprite_smoke` — `src-tauri/src/thumbs.rs`
   (See also DECISIONS.md 2026-07-13 "Known gap: five stream-md5 fixture guards are
   non-functional".)

2. **Flip the non-empty-zoom-track test to assert a RE-ENCODE, not a copy.** Today
   `empty_zoom_stays_on_video_copy_path` (`src-tauri/src/edit.rs:2045`) pins that *even a
   non-empty* zoom track still takes the `-c:v copy` fast path — correct only while export
   ignores zoom. Step 4 must flip that half to assert a re-encode. It is the deliberate
   tripwire: nobody reaches export rendering without consciously acknowledging that zoomed
   exports leave the fast path.

## Design decision RESOLVED (2026-07-14): ffmpeg zoompan + 4x oversample

Spiked risky-measurement-first (like B0) and owner-judged on real footage; the spike was
throwaway (scratchpad only, nothing in the tree). See DECISIONS.md 2026-07-14. Outcome:

- **Naive ffmpeg `zoompan` stutters** on slow pans (it truncates crop x/y to integer pixels),
  confirmed visually on a deliberately-slow 2.5s ramp. Rejected — the bar is buttery-smooth.
- **Oversampling fixes it and is mandatory, not optional.** Pre-scale the frame Nx (lanczos),
  run `zoompan` on the upscaled frame so its integer offsets are 1/N source px, downscale to
  the 1080p output.
- **4x is the committed default** — buttery on both the 2.5s stress ramp and the real 600ms
  default (`ZOOM_RAMP_S`), isolated and in a multi-zoom sequence. 2x and 3x still showed slight
  stutter on the stress ramp; 3x looked good at the real 600ms speed but was not committed on
  15s of synthetic footage.
- **3x is a validated-later optimization, NOT a blocker.** The oversample factor is a single
  constant in the render path; once real zoomed exports exist, A/B 3x vs 4x on real varied
  footage and flip the constant if 3x holds (nearly halves the tax: ~44s vs ~79s per 5-min).
- **Swift compositor is OFF the table for smoothness.** The "if oversampling blows up,
  reconsider Swift" branch never triggered — see the measured cost.

**Measured cost** (300s / 1080p / `h264_videotoolbox`, this machine; whole-timeline oversampled
= pessimistic ceiling; real exports oversample only zoomed spans so run under this):

| Path | Wall (5 min) | vs baseline | Peak RSS |
|---|---|---|---|
| Baseline re-encode (no zoom) | 34.5s | 1.0x | 188 MB |
| 2x oversample (3840x2160) | 33.9s | 1.0x (free) | 209 MB |
| 3x oversample (5760x3240) | 44.3s | 1.3x | 188 MB |
| 4x oversample (7680x4320) | 78.7s | 2.3x | 223 MB |

No memory or thermal blowup at the 8x intermediate (peak RSS flat; `pmset -g therm` clean after
all runs). 2x is free because videotoolbox encode is the bottleneck and the 2x CPU scale hides
under it; 4x is where CPU lanczos on 8K frames becomes the bottleneck. The 34.5s baseline
validates the ~29s figure below.

**Still OPEN (not settled by this spike): overlay ordering.** Content-anchored overlays (arrows,
blur, spotlight) must zoom **WITH** the content; screen-anchored ones (webcam bubble, watermark)
must **NOT**. This is a Step 4 build question the smoothness spike did not touch. It no longer
bears on Swift-vs-ffmpeg (ffmpeg won on smoothness + cost); it's now purely "get the
`filter_complex` layer order right."

## The encoder reality that makes this acceptable

Measured on this machine: **~500 MP/s** hardware encode. A 5-minute recording re-encodes in
**~29s at 1x**. Only *zoomed* recordings pay that cost — plain saves stay on `-c:v copy`
(the fast path the invariant protects). So the re-encode tax is opt-in per-recording, only
when a zoom is actually present, and fast enough to be acceptable.

## Where this sits in the plan

Step 4 is the export half of the zoom layer (`docs/ZOOM-LAYER-PLAN.md`). Detection (step 5)
was deliberately pulled ahead of it (DECISIONS.md 2026-07-13); the Thread A conservative
detector (`7e9e87c`) and Thread B manual-editing plan (`docs/ZOOM-MANUAL-EDITING-PLAN.md`)
both sit on the preview side. Step 4 is what finally makes zooms real in exported files.
