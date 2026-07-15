# V2 zoom-export build state (handoff)

Single source of truth for where V2 is. V2 = zoom reaches exported mp4 via **ffmpeg
zoompan + 4x oversample**, shipping as the owner's daily driver. V3 (Core Image compositor)
is a decided-but-not-started branch — see `docs/v3-ci-compositor/README.md`. Rationale and
measured evidence: `docs/ZOOM-EXPORT-STEP4.md` and DECISIONS.md 2026-07-14 / 2026-07-15.

## Build order + status

1. **Prerequisites — DONE.**
   - Guards restored (synthesize + un-ignore), commit `42c9cae`. Four run in the default
     suite (`probe_audio_track_baseline`, `render_preview_audio_baseline`, `mp4_save_baseline`,
     `sprite_smoke`); `save_recording_baseline` stays `#[ignore]` (runnable on demand — it
     writes to `~/Movies/Zeigen` via `save_recording_impl`). Suite: 39 passed, 4 ignored.
   - Tripwire NOT flipped yet — by design. `empty_zoom_stays_on_video_copy_path`
     (`edit.rs`, the `assert_eq!(... "0:v" ... "zoom rendering is not wired until step 4 —
     video still copies")`) currently pins that a non-empty zoom track still copies. **Flip it
     to assert a re-encode as part of step 3** (it goes green exactly when zoom export lands;
     flipping earlier = red commit).

2. **Zone-based bubble — DONE.** Commit `5159a22`. Export bakes ONE constant zone
   (`composite::resolve_zone`); the PTS-keyed `f(t)` overlay + `simplify_position_log` /
   `build_inline_position_expr` / enable-gate / split-chain are deleted. `SidecarState.bubble_zone`
   carries the pick (skipped when `None` → untouched + pre-Step-2 sidecars byte-identical);
   `bubble_position_log` is now preview/legacy + the diameter source. Review has a 2x3 zone
   picker (webcam recordings only) and parks the preview bubble at the zone (preview == export).
   Four corners reproduce the pre-Step-2 filter string byte-for-byte; `legacy_args_pinned`
   re-baselined (non-empty log → migrated constant, was the `f(t)` string) + a TopCenter pin
   added. Live recording untouched. Verified in-app: pick parks the bubble and the exported mp4
   matches. `cargo test --lib`: 40 passed, 4 ignored.

3. **Zoom export — DONE.** Commit `f728fa2`. Zooms reach the exported mp4 (were preview-only).
   Shipped as two increments:
   - **Screen-only + preview.** Shared zoom builder in `edit.rs` (`zoom_filter_fragment`):
     keyframes→segments mirroring `zoomKeyframesToSegments`, eased `s(t)` (in_out_cubic,
     `ramp=min(0.6,dur/2)`), crop window `W/s × H/s` on the clamped pixel center, on a 4x
     lanczos oversample. **As-built deviation:** uses `zoompan` driven by `it` (input time),
     NOT `crop` — ffmpeg 8.1 `crop` has no `eval` and can't vary crop *size* per frame; zoompan
     is PTS-accurate on the VFR source. Validated **PSNR 50 dB** vs a reference center-crop.
     Wired AFTER content annotations, BEFORE the watermark; keyframe times shifted by `−trim_in`.
     Gates re-encode (non-zoom keeps `-c:v copy`); **tripwire flipped**. **Preview fixed** to
     match parity: `AnnotationLayer` nested in the zoom transform so content annotations zoom
     WITH content (the scope's "annotations before zoom" — the old preview was the bug);
     `BubbleLayer` stays a sibling (webcam fixed).
   - **Webcam seam.** composite's webcam-overlay filter extracted into a shared helper;
     `composite()` refactored to use it (`legacy_args_pinned` byte-identity holds), so webcam+zoom
     reuses the exact proven bubble prep. `run_edit_pipeline` routes webcam+zoom to a single pass
     (annotations → zoom → bubble → watermark); webcam+no-zoom keeps the untouched two-pass.
     Trim-start webcam alignment via `pad_lead`/`wc_skip` (untrimmed = composite-identical).
   - **Owner-verified** on a real 6-min/30-zoom recording: zoom matches preview, A/V in sync
     through front+end trims, softening below perception; ~2.5min export (whole-timeline
     oversample), accepted for V2. **UNTESTED combo:** watermark + webcam + zoom together.
   - `cargo test --lib`: 42 passed, 4 ignored (byte-identity pin + flipped tripwire +
     webcam+zoom smoke test).

## Step 2 scope — zone-based bubble

Export bakes ONE **constant** bubble position (a zone) chosen in Review. This deletes the
PTS-keyed `f(t)` position from the export path and collapses the trim/reorder cascade (the
webcam's `f(t)`-on-untrimmed-timeline was the unique forcing function — see DECISIONS.md
2026-07-14 zone-bubble analysis).

- **Live recording unchanged:** the floating bubble stays fully draggable during recording —
  ephemeral operator convenience (move it to see what's under it). Not baked as animation.
- **Export = one zone**, picked in Review. `bubble_position_log` becomes preview/legacy data
  that **export ignores**.
- **Zone picker UI** in Review: 4 corners, maybe 2 mid-edges. Small.
- **Migration:** old recordings default to the **nearest corner to the log's centroid**; user
  can change it.
- Mask + shadow geometry (constant, not time-keyed) stay as-is; only position stops animating.
- Carries forward to V3 unchanged (constant CI layer, no animation to port).

Code anchors: webcam position interpolation is `build_inline_position_expr` /
`simplify_position_log` in `composite.rs` (this is what goes away at export); `composite()`
signature ~`composite.rs:532`.

## Step 3 scope — zoom export (ffmpeg)

Reuse `run_edit_pipeline_single_input`'s annotation + trim graph (`edit.rs:953`), and:
- Insert **oversample + zoompan** (pre-scale Nx lanczos → zoompan on the upscaled frame →
  downscale to output). **4x default** (3x = validated-later optimization; single constant).
- Append the **constant** webcam overlay + watermark **AFTER** the zoom (screen-anchored,
  must not zoom). Constant position (step 2) makes this a trivial `overlay=x:y`, not a reorder.
- Content-anchored annotations (arrow/blur/spotlight/text) go **BEFORE** the zoom so they zoom
  with content.
- **Shift zoom keyframe times by −trim.in** (trim stays as input `-ss`, so filter `t` is
  trim-relative — same pattern annotation `enable=between(t,…)` already uses).
- Mirror `zoomAt` exactly (in_out_cubic ramps, `ZOOM_RAMP_S=0.6`, clamped off-center crop).
  Reference: `zoomAt`/`easeInOutCubic` in `Review.tsx`; the same math in Swift in
  `docs/v3-ci-compositor/gpuzoom.swift`. Crop window = `W/s × H/s` centered on the clamped
  center, scaled to fill — the spike proved the zoompan expression is faithful and smooth at 4x.
- **Copy-path stays safe by gating:** only zoom-present (re-encode) exports take the new path;
  non-zoomed exports keep the existing untouched two-pass + `-c:v copy`. Flip the tripwire here.
- Then flip `empty_zoom_stays_on_video_copy_path`'s non-empty-zoom half to assert re-encode.

Two variants: screen-only-zoom (simpler) and webcam-zoom (the full seam). Estimated the whole
step at ~2 sessions / 2–4 rounds once the zone bubble removes the `f(t)` complication.

## Durable, already committed
- V2/V3 decision + `gpuzoom.swift` + measured cost structure: commit `03607f6`
  (`docs/v3-ci-compositor/`, `docs/ZOOM-EXPORT-STEP4.md`, DECISIONS.md).
- Guards: `42c9cae`.
- Zone-based bubble (Step 2): `5159a22`.
- Zoom export (Step 3): `f728fa2`.
- Branch: `capture-engine-v2`.

## V2 core complete. Next optimization: per-zoomed-span oversample
Zoom now reaches exports; V2's core is done. The whole timeline is currently oversampled
(the measured pessimistic ceiling) whenever any zoom is present — so a zoomed recording
pays the 4x cost end-to-end AND its non-zoomed spans are re-encoded (oversample roundtrip
softens them ~40.7 dB PSNR / 0.995 SSIM — slight, below perception in motion, but real).

**Per-zoomed-span oversample** is the next optimization (owner-prioritized): oversample +
re-encode ONLY the spans that contain a zoom, and keep non-zoomed spans on `-c:v copy`.
This fixes three things at once — export cost (only zoomed spans pay), the softening, and
non-zoomed spans stay pristine (byte-identical copy). Requires splitting the timeline at
zoom-span boundaries, processing spans separately, and concatenating. `3x oversample`
(single-constant change, `ZOOM_OVERSAMPLE`) remains a separate validated-later A/B.

Other open items: watermark + webcam + zoom together is UNTESTED (marked, not verified).
V3 (Core Image compositor) stays a decided-but-not-started branch — `docs/v3-ci-compositor/`.
