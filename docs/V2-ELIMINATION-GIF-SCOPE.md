# V2 elimination — GIF-with-edits port (SCOPE, awaiting sign-off)

Commit 5 of 6 in the V2-elimination arc. Same discipline as the trim port:
plan + gate here, **no code until owner sign-off**. Then teardown (commit 6).

## Why GIF has to move

A GIF of a **zoomed / webcam / watermarked** recording still renders on the V2
machinery (`zoom_filter_fragment` / `build_webcam_overlay` / `composite()`) and
then runs `palettegen`/`paletteuse` in the same graph. Those three renderers are
the last live consumers holding V2 alive besides trim (already ported). Until GIF
renders on V3, the teardown can't delete them.

The ENCODE (ffmpeg palettegen) was never V2's sin and stays. Only the RENDER
moves to cicompositor.

## The three GIF shapes (routing)

Split by whether the GIF needs the V2 render machinery at all — the exact
`has_zoom || has_webcam || has_watermark` predicate `decide_v3` already computes:

| Shape | Needs machinery? | New path |
|---|---|---|
| **Plain** (no zoom/webcam/watermark) — incl. trim-only, downscale-only | No | `run_plain_gif` — one ffmpeg pass, source → `[-ss/-to]` → `fps,scale,palettegen,paletteuse` |
| **Edited** (zoom and/or webcam and/or watermark) | Yes | `run_v3_gif` — cicompositor render (source-res, trim-aware) → **same** palettegen pass |

Plain GIF today already runs exactly `[0:v]fps={fps},scale={scale}:flags=lanczos,split[gA][gB];[gA]palettegen=stats_mode=diff[gP];[gB][gP]paletteuse=dither=bayer:bayer_scale=5[gout]`
with no overlays. `run_plain_gif` reproduces that command verbatim (+ `-ss/-to`
on trim). It's an extraction, not a rewrite.

## Mechanics

1. **Hoist a GIF branch to the top of `run_edit_pipeline`**, before `decide_v3`.
   GIF never enters `run_edit_pipeline_v2` again. `decide_v3` goes back to being
   purely the MP4 V2-vs-V3 question (drop its GIF arm).

2. **Factor `run_v3_export`'s render half into `v3_render(...) -> (video_only_mp4, Option<caveat>)`.**
   `run_v3_export` (MP4) = `v3_render` + audio mux (unchanged bytes).
   `run_v3_gif` = `v3_render` + palettegen pass. Both share the segment concat,
   zoom JSON, bubble assets, trim env, and the multi-segment **drift caveat** — so
   a Continuity-drop GIF surfaces the identical note an MP4 does. Minimal refactor
   of just-landed code: extract the render, leave the two tails as the two callers.

3. **`run_v3_gif` renders at SOURCE resolution** (no `OUTPUT_WIDTH/HEIGHT` — pass
   `resolution=Source` into `v3_render`). The `GifResolution` scale (`-2:480` /
   `-2:720` / `'min(iw,1920)':-2`) is done by the **palettegen pass's own lanczos
   scale**, exactly as V2's GIF tail does it. Scale stage stays identical to V2.

4. **`run_plain_gif`** builds `[-ss/-to] -i source -filter_complex "<the tail
   string above>" -loop 0 out.gif`. This is the surviving standalone GIF
   palettegen — the GIF analog of the plain `-c:v copy` MP4 fast path that must
   also survive teardown independently of the V2 body.

Net: after this lands, GIF touches `composite()` / `zoom_filter_fragment` /
`build_webcam_overlay` **zero** times. Teardown (commit 6) can then delete them.

## Palette path — is anything byte-identical, and what shifts?

The owner's explicit question. Answered honestly per shape:

**Plain / trim-only / downscale-only GIF (`run_plain_gif`): BYTE-IDENTICAL.**
Same input (source), same optional `-ss/-to`, same `fps,scale=lanczos,
palettegen=stats_mode=diff,paletteuse=dither=bayer:bayer_scale=5`, same single
ffmpeg pass. Extract-and-call = same argv = same bytes. Gated by md5 compare. No
risk.

**Edited GIF (`run_v3_gif`): NOT byte-identical. The palette FILTERS are
identical; the PIXELS they quantize shift.** Two things change at once vs V2, and
they differ by which edit:

- **Zoom GIF** — the sharp-risk case. V2 rendered zoom in the **same** ffmpeg pass
  (zoompan 4x-oversample) and fed palettegen those frames with **no intermediate
  re-encode**. V3 renders zoom in Core Image (sharper, less ringing — the same win
  as MP4) but writes an **H.264 intermediate** (cicompositor's 0.18 bits/px,
  yuv420p) that palettegen then decodes. So V3 adds **one full H.264 encode/decode
  hop with 4:2:0 chroma subsampling + DCT quantization** that V2's zoom-GIF never
  had, *before* the 256-color quantize + bayer dither. On flat gradients / chart
  fills, that hop can introduce blocking/banding the dither then amplifies or
  shifts. **This is the tradeoff no PSNR catches — cleaner zoom resample vs an
  added lossy hop. Must be eye-judged.** (The owner's chosen eye-check content —
  zoomed, bubble, gradient/chart — targets exactly this.)

- **No-zoom webcam GIF** — **neutral, not a new hazard.** V2 already ran this as
  TWO passes: `composite()` baked the bubble to an H.264 8Mbit temp, *then*
  palettegen. So V2 already roundtripped H.264 before the palette here. V3 does the
  same class of roundtrip (cicompositor H.264), just a different renderer producing
  the intermediate. Comparable banding profile.

- **Watermark-only GIF** — same class as zoom (V2 overlaid in-pass, no intermediate;
  V3 adds the hop), but lower stakes: the logo is small and mostly opaque, little
  gradient area to band.

**Reserve lever if the eye-check shows banding:** the V3 GIF intermediate is a
**throwaway temp**, deleted right after palettegen — its only consumer. So its
bitrate can be pushed far above the 0.18 bits/px MP4 setting (or switched to a
near-lossless intermediate) at only transient-disk cost, feeding palettegen much
cleaner gradients. **Recommendation: ship the simplest first** — reuse the existing
0.18 bits/px render, gate the eye-check. If gradients band, bump the GIF
intermediate bitrate (a compositor env knob, cheap, no architecture change) and
re-gate. Measure before adding the knob — don't pre-optimize.

## Gate

Same shape as trim: automated regression + perf + the owner eye-check that decides.

**Automated (must pass before the eye-check is worth doing):**
1. **Byte-identical plain path** — no-edit GIF, trim-only GIF, 720p + 480p
   downscale GIF: `run_plain_gif` output md5 == current V2 output. Proves the
   extraction changed nothing on the untouched path.
2. **Valid + correct edited GIFs** — zoom / webcam / zoom+webcam / watermark /
   multi-segment-webcam GIFs via `run_v3_gif`: header `GIF89a`, correct dims for
   each `GifResolution`, non-trivial size.
3. **Frame-count parity** — V3-GIF frame count == V2-GIF frame count for the same
   edit + fps + trim window (`fps` filter + trim must land the same frame count).
4. **Multi-segment drift caveat** surfaces on a 2-segment webcam GIF (same note an
   MP4 gets).
5. Suite stays green.

**Perf (measured, median of 3, real V3-GIF vs V2-GIF on a zoomed recording):**
report wall + CPU. Expect a win (GPU zoom replaces 4x-oversample zoompan) but
**smaller than trim's 47%** — V3 adds an intermediate H.264 encode and the
palettegen pass cost is unchanged. Not a blocker unless it regresses.

**OWNER EYE-CHECK — the go/no-go, STOP for sign-off:**
- **Chosen asset (owner: "I locate one"):** screen = `~/Movies/Zeigen/rebalance.mp4`
  (1468x770 — dark gradient map + "NET FLOW BY HOUR" bar chart + colored route/
  ranking gradients: worst-case banding content). Bubble = a real baseline webcam
  `~/Movies/Zeigen/.phase15-baseline/recording-2026-06-02-204330/sources/webcam-00.mp4`
  (1280x720 h264, matches the recorder encode). Streams are from different sessions
  — fine for a *rendering-quality* test; the banding-critical variable is the
  chart/gradient under zoom, not bubble provenance. Zoom targets the bar-chart region.
- Render **V3-GIF and V2-GIF side by side**, same resolution + fps.
- Also extract a **still PNG from each** at a matched timestamp for pixel-peeping.
- Owner inspects **banding, color shift, dither pattern** — the things PSNR misses.
- Pass → land commit 5. Banding on V3 → pull the bitrate lever, re-render, re-gate.

## Locked (not re-litigated here)
- GIF stays on ffmpeg palettegen (Swift ImageIO port is someday-not-now).
- Palettegen/paletteuse arg string is unchanged from V2 (`stats_mode=diff`,
  `dither=bayer:bayer_scale=5`). Only the frames feeding it move.

## After this: teardown (commit 6)
Nothing reaches the V2 machinery. Delete `run_edit_pipeline_v2`, `composite()`
family, `zoom_filter_fragment` + `ZOOM_OVERSAMPLE`, dead annotation branches,
`legacy_args_pinned` + byte-pins, the flat `-b:v 8M` V2 sites, the
`use_v3_compositor` flag. Keep V3-shared renderers (`build_v3_bubble_assets`,
`resolve_diameter_px`, etc.) and reroute the plain `-c:v copy` MP4 fast path +
`run_plain_gif` to survive independently — both BYTE-EXACT.
