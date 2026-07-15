# V3 validation harness (Phase 0)

The tripwire that replaces the dead byte-identity guards. V3 renders *differently on
purpose* (one resample not three, linear color not gamma), so `stream_md5` /
`legacy_args_pinned` can never guard it. This harness measures V2-vs-V3 (or any
pair) on the axes where a regression would actually hide, and leaves the aesthetic
call to the owner's eye — on a surface it has already cleared of silent breakage.

**It measures; it does not judge "better."** That boundary is the whole point of
Phase 0, and the demo below proves both halves: what it reliably catches, and the
one thing it provably cannot.

## Pieces

- `spatial_diff.py` — global SSIM + per-channel PSNR (ffmpeg's own filters),
  per-region SSIM/PSNR/CIEDE2000 (numpy) for overlay bounding boxes, and
  signalstats luma/chroma (a color range / matrix-tag break detector). Outputs raw
  JSON; no verdicts.
- `temporal_probe.py` — recovers the per-frame pan trajectory from the RENDERED
  pixels via FFT phase correlation, reports velocity, jerk, and `quant_fraction`
  (how integer-locked the motion is — the fingerprint of V2's s/4 stepping).
- `build_demo.py` — injects known faults into a real recording and runs both tools,
  so you can see catches and misses side by side.

## Run

```
python3 -m venv v3venv && ./v3venv/bin/pip install numpy pillow
./v3venv/bin/python build_demo.py \
    --recording ~/Movies/Zeigen/<a-recording>.mp4 \
    --workdir /tmp/harness_demo \
    --python ./v3venv/bin/python
```

(numpy+pillow live in a throwaway venv, not in the app. ffmpeg is the app's own
`/opt/homebrew/bin/ffmpeg`.)

## What it caught, on real footage (2026-07-14-201245.mp4, injected faults)

```
case          SSIM  PSNR-Y  PSNR-U  PSNR-V  dE mean  dE p95
floor       1.0000     inf     inf     inf    0.000   0.000
color       0.9768   23.04   63.84   64.08    1.755   5.643
geom        0.8623   19.99   37.35   38.02    2.490  10.635
soft        0.9899   35.45   49.24   49.67    0.475   2.411
sharp       0.9860   33.31   57.45   57.91    0.420   2.108

signalstats YAVG  ref=199.5  color-test=213.4  (YMAX 253->255)

overlay shift:  global SSIM 0.9960  |  box-region SSIM 0.9254 dE 3.19
                                    |  ctrl-region SSIM 1.0000 dE 0.00

temporal:  pan         vel_mean  jerk_rms  jerk_max  quant_frac
           quantized      0.492    0.8200    1.0000       1.000
           smooth         0.549    0.4896    0.8423       0.585
```

### Reliable catches (trust these)

- **Color / range / tag break** — the insidious one. `color` (luma range
  mishandled) keeps SSIM at 0.977 — a structure-only check nearly MISSES it — but
  PSNR-Y collapses to 23 dB, CIEDE2000 jumps to 1.76 (p95 5.6), and signalstats YAVG
  moves 199.5 -> 213.4. This is exactly the V3 fat-tail failure (linear/sRGB, 709
  tags, video-vs-full range), and the color metrics fire loudly while SSIM shrugs.
- **Geometry / registration** — `geom` (0.8% scale) drops SSIM to 0.862. Caught hard.
- **Per-overlay parity** — an 8x5 px overlay shift is INVISIBLE globally (SSIM
  0.9960, a naive global gate passes it) but the box region collapses to 0.925 /
  dE 3.19 while the untouched control region stays 1.0000 / dE 0.00. Per-region diff
  is mandatory, and it isolates the break cleanly. This is why Phase 3 diffs each
  overlay's bbox, not the whole frame.
- **Quantization stutter (the smoothness axis)** — the probe reads `quant_fraction`
  1.000 for the integer-stepped pan vs 0.585 for the 4x-oversampled one, and
  jerk_rms 0.82 vs 0.49. It objectively separates stuttery from smooth motion on the
  RENDERED pixels — the one part of "buttery" that is measurable.

### The provable blind spot (do NOT trust it here)

**It cannot rank aesthetic quality.** `soft` (blurred) and `sharp` (sharpened)
produce near-identical signatures — SSIM 0.990 vs 0.986, dE 0.48 vs 0.42 — because
both just measure *deviation from ref*, and ref is neither. Worse: the blur scores
*higher* SSIM than the sharpen, so a naive "higher = better" reading would call the
softer image better. If V3 is legitimately sharper than V2 (finding (a): one
resample beats three), this harness flags it as MORE different, not better. Sharpness
preference, "polished," motion-blur taste — all stay owner-eye-judged.

## Trust verdict

- **As a regression tripwire: trustworthy.** It fires on color, geometry, and
  overlay-parity breaks — the exact silent failures the dead guards used to catch —
  and it fires loudly, well clear of the ~0 noise floor. Industry-standard metric
  implementations (ffmpeg SSIM/PSNR; standard CIEDE2000), no version risk.
- **As a smoothness comparator: trustworthy, relative.** It measures V2-vs-V3 on the
  quantization axis objectively. It is a comparator against a reference, not an
  absolute butteriness oracle — even ideal motion reads nonzero jerk from measurement
  noise, so read it as "smoother than / same as / stuttier than V2," not a raw score.
- **As a quality judge: untrustworthy by design, and that is correct.** It clears the
  surface so the owner's eye judges only aesthetics, never hunts for silent breakage.

## Known limits (honest)

- The demo's noise floor came out at exactly 0 (VideoToolbox was deterministic on
  this clip). Real V2-vs-V3 will have a small nonzero floor; thresholds should be set
  as floor + margin, recalibrated per real A/B pair, not hardcoded.
- The temporal probe assumes near-translation between frames (true during a pan). It
  is not meaningful on hard cuts or heavy content change within the tracked crop.
- CIEDE2000 is computed in sRGB-decode space from the decoded RGB frames; it detects
  color-management breaks well but is not a substitute for checking the actual color
  atoms in the container (do that directly in Phase 1).
