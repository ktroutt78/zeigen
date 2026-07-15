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

3. **Zoom export — NEXT.** Tripwire flips here. (scope below)

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
- Branch: `capture-engine-v2`.

## Step 3 starting point (zoom export)
The `f(t)` complication is now gone, so the constant webcam overlay is a trivial
`overlay=x:y` appended AFTER the zoom (see Step 3 scope). The zoom keyframes still
serialize but nothing in the export reads `SidecarState.zoom` yet — the tripwire
`empty_zoom_stays_on_video_copy_path` (edit.rs) still pins that a non-empty zoom track
copies the video; flip its non-empty half to a re-encode assertion when zoompan lands.
