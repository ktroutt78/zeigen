# V2 Elimination — Commit 6 (teardown) scope

Final commit of the V2-elimination arc. Commits 1-5 rebuilt every live consumer
(safety net, multi-seg webcam, LinkedIn, trim, GIF) on V3. Nothing routes to the
V2 ffmpeg machinery anymore except the plain-MP4 tail reached via
`decide_v3 -> V2Silent`. This commit deletes the machinery and re-homes that tail.

STOP-for-sign-off gate. No deletion until the owner signs off on GATE 1 + GATE 2
below.

## The reroute (load-bearing)

Today a plain MP4 save (no zoom / webcam / effective watermark) flows:

    run_edit_pipeline -> decide_v3 => V2Silent -> run_edit_pipeline_v2
      -> (webcam empty) run_edit_pipeline_single_input
      -> needs_filter=false -> mp4_video_can_copy => `-c:v copy` (+ audio NR + faststart)

The `V2Silent` arm also carries trim-only and downscale-only plain MP4s (they hit
`single_input` and re-encode via `-ss/-to` / lanczos scale). All of that dies with
`single_input`, so the reroute must re-home the WHOLE plain-MP4 tail, not just the
literal copy.

New shape:

    run_edit_pipeline:
      if GIF { run_v3_gif | run_plain_gif }            // unchanged (commit 5)
      else if has_zoom||has_webcam||has_watermark { run_v3_export }  // unchanged
      else { run_plain_mp4(...) }                       // NEW home for the plain tail

`run_plain_mp4` is `single_input` reduced to: MP4 only, no webcam, no zoom, no
annotations, no watermark. Keeps trim (`-ss/-to`), the `mp4_scale` downscale
(lanczos, identity-skip), the copy-vs-reencode decision (`mp4_video_can_copy`),
audio NR (`-af arnndn`), `-c:a aac -b:a 192k`, `+faststart`, and the progress
thread. Byte-for-byte the same ffmpeg command the plain tail builds today.

`decide_v3` + `V3Decision` collapse: flag param gone, annotation `FallbackVisible`
arm gone (dead-by-construction), `V2Silent` renamed to the plain-path arm. Likely
folds into a plain `has_zoom||has_webcam||has_watermark` predicate inside
`run_edit_pipeline`. `PipelineReport::fallback` + `route_note`'s fallback source
die; the multi-seg `caveat` note stays.

## Deletion inventory

edit.rs:
- `run_edit_pipeline_v2` (1607-1731)
- `run_edit_pipeline_single_input` (1907-2502) — reduced to `run_plain_mp4`
- V2 zoom exprs: `zoom_ease_expr`, `zoom_scale_expr`, `zoom_center_expr`,
  `zoom_filter_fragment`, `ZOOM_OVERSAMPLE`, `ZOOM_RENDER_RAMP_S` (1746-1906)
  — KEEP `ZoomSeg` + `zoom_keyframes_to_segments` (V3-shared)
- annotation rasterizers/branches: `rasterize_text`, `rasterize_arrow`,
  `blur_region_fragment`, `spotlight_region_fragment` (464-797)
- `decide_v3`/`V3Decision` collapse; `v3_tag`/`v3_decision_table` simplify
- V2 parity tests (their V3-vs-V2 oracle is gone; verdicts banked): the V2 arms
  of `empty_zoom_stays_on_video_copy_path`, `webcam_zoom_seam_produces_valid_mp4`,
  `c2_byte_stability`, `watermark_export_smoke`, `trim_gate`, the GIF byte tests'
  V2 reference, plus the rasterizer tests

composite.rs:
- `composite`, `build_composite_args`, `run_composite_ffmpeg` (799-1082)
- `webcam_overlay_filter`, `webcam_overlay_filter_trimmed`, `WebcamOverlay`+impl,
  `build_webcam_overlay` (563-760)
- `Watermark::filter_fragment` (255-~290) — V3 does watermark via env
- `legacy_args_pinned` test + `build_args_for_test` + `e1_roundness_gate` (call
  `composite`); the `filter_fragment` asserts in the watermark test
- KEEP (V3-shared): `resolve_diameter_px`, `resolve_padding_px`, `render_alpha_mask`,
  `render_shadow_source`, `resolve_zone`, `mask_file_name`, `build_v3_bubble_assets`,
  `Watermark::from_args`, `Corner::code`

settings.rs: `use_v3_compositor` field + serde default + Default init + getter +
`set_use_v3_compositor` command + `default_true` fn (only user).

lib.rs: `settings::set_use_v3_compositor` handler registration (829).

## GATE 1 — plain `-c:v copy` fast path byte-exact after reroute

Contract of the copy path: the output video stream is the SOURCE video stream
copied bit-for-bit (`-c:v copy`), audio re-encodes (arnndn+AAC). So the proof is
`md5(output 0:v) == md5(source 0:v)`, which is deterministic and reproducible from
a synth source (no frozen magic hash needed).

Proof steps (executed at build time, hashes shown to owner):
1. BEFORE (current HEAD): run a plain MP4 save on a fixture; record
   `md5(out 0:v)`, `md5(source 0:v)`, `md5(out 0:a)`, and the exact ffmpeg arg
   vector.
2. AFTER (rerouted): identical save through `run_plain_mp4`; record the same.
3. Assert `md5(out 0:v)` identical before==after AND == source (copy guarantee),
   and the ffmpeg arg vector identical before==after (so audio/faststart are
   bit-identical too, same ffmpeg + same args + same input).
- Ongoing guard: repoint `empty_zoom_stays_on_video_copy_path` at `run_plain_mp4`
  (video-md5==source), and add an arg-vector pin for `run_plain_mp4`'s plain +
  trim + downscale cases.

## GATE 2 — byte-pin coverage after `legacy_args_pinned` + composite pins come out

What each pin watched, and where its coverage goes:

- `legacy_args_pinned` watched TWO things: (a) the exact V2 `build_composite_args`
  ffmpeg string (tpad=0.105 lead, itsoffset -0.020 audio, overlay zone geometry
  `main_w-330:main_h-322` etc., `-c:v h264_videotoolbox -b:v 8M -c:a copy`), and
  (b) that `mask-240.png` rendered end-to-end == `mask-240-circle.png` fixture.
  - (a) is MOOT: the arg-builder is deleted, there is no V2 ffmpeg string to
    regress. The overlay geometry it encoded now lives in cicompositor (Swift,
    `BUBBLE_ZONE`); its placement + the webcam lead/seam are watched by V3's own
    banked gates (trim step-function delta 0.0, owner-verified bubble placement),
    not by an ffmpeg-string pin.
  - (b) is REDUNDANT with the surviving direct pin below.
- The mask/shadow SILHOUETTE BYTES — the visually load-bearing thing — stay watched
  byte-exact by `legacy_mask_and_shadow_byte_identical_to_pre_e1` (calls
  `render_alpha_mask` + `render_shadow_source` directly vs the SAME
  `mask-240-circle.png` / `mask-320-circle.png` / `shadow-240-pad60-circle.png`
  fixtures), plus `rounded_square_mask_geometry` and `styled_mask_gets_distinct_filename`.
  These renderers are V3-shared (KEPT), so nothing goes dark.
- `resolve_zone` migration stays watched by `resolve_zone_migration_and_defaults`
  (resolve_zone is V3-shared via `build_v3_bubble_assets`).
- The plain copy path stays watched by GATE 1's repointed md5 test + new arg pin.

Net: no coverage is lost. The only pin whose subject genuinely disappears is the
V2 ffmpeg arg string, which cannot regress once the code that built it is gone.

## Flag removal cleanliness

- Frontend: zero references to `use_v3_compositor` / `set_use_v3_compositor` (grep clean).
- Stale settings.json: `Settings` has no `#[serde(deny_unknown_fields)]`, so a
  leftover `"use_v3_compositor": true|false` key deserializes clean (ignored).
- `default_true` has no other user — removed with the field.
