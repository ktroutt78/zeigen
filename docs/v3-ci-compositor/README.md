# V3 — Core Image / AVFoundation compositor (deferred branch)

Status: **decided, not started.** V2 ships first on the ffmpeg path (owner's daily driver);
V3 is the GPU-native rewrite that removes V2's CPU/thermal tax. Decision recorded 2026-07-14
(see DECISIONS.md and `docs/ZOOM-EXPORT-STEP4.md`).

## Why V3 exists (the measured case, not a hunch)

V2's zoom render is ffmpeg `zoompan` + **4x oversample**, which is **~100% CPU/bandwidth-bound**
— the hardware H.264 encoder is not the bottleneck at 4x. That degrades worst on exactly the
machines the owner cares about (M1, older Intel) and can thermal-throttle a fanless Air on
battery. A throwaway spike (`gpuzoom.swift`, preserved here) rendered the same zooms through a
GPU-native Core Image path (Metal-backed, sub-pixel sampled, **no oversample intermediate**) and
measured decisively better:

| Metric (owner's M5) | ffmpeg 4x | GPU / Core Image |
|---|---|---|
| Wall, 5-min zoomed export | ~79s | **~33s** (extrapolated from 91s clip) |
| CPU-seconds (per 91s clip) | 85.7s | **6.2s** |
| CPU/wall ratio | **3.6 (CPU-bound)** | **0.6 (encoder-bound)** |
| Zoom's marginal cost | the whole 4x tax | **~free** — GPU identity re-encode 34s ≈ GPU zoom 33s |
| Peak RSS | 223 MB | 113 MB |

The decisive structural fact: **encoder-bound, not CPU-bound.** The media engine varies far less
across Macs than CPU multicore + memory bandwidth, and there is no sustained CPU load to throttle.
So V3 is fast, smooth, AND hardware-uniform — the property V2 cannot have.

V2 ships with the tax anyway because the sole user is on an M5 and needs a working recorder now.

## The spike (`gpuzoom.swift`)

Proves GPU sub-pixel zoom + the cost structure. Not production code — the zoom transform mirrors
`Review.tsx` `zoomAt` exactly (in_out_cubic ramps, clamped off-center crop).

```
swiftc -O gpuzoom.swift -o gpuzoom
./gpuzoom <in.mp4> <out.mp4> <scenario> [trimStart trimDur]
# scenarios: slow (2.5s stress ramp) | multi (three 600ms zooms) | const | pass | ident
```

`ident` (identity re-encode through CI, no zoom) vs `const`/`multi` (with zoom) is how the
"zoom is free" split was measured — same wall time, so the Metal composite rides under the encode.

## What shipping V3 actually costs (do not underestimate)

The GPU zoom can't be bolted onto ffmpeg (double-encode + overlay ordering). V3 = re-home the
**video** compositing into Core Image / AVFoundation: zoom + annotations + webcam bubble +
watermark + spotlight/blur as one CI layer stack -> one AVAssetWriter encode. Audio (arnndn) stays
in ffmpeg and muxes; capture stays; the non-zoomed copy fast-path stays. Estimated ~4-6 CC
sessions / ~8-14 judge rounds, fat-tailed on per-overlay appearance parity, Core-Image-vs-ffmpeg
color-space surprises, and the dead byte-identity invariants (they can't guard a different
renderer — a new visual-tolerance validation is needed). Reuse the Rust text/arrow PNG
rasterization as CI layers to cut risk; only blur/spotlight/webcam need new CI rendering.

## V3's bar — it must NOT regress V2 on performance OR quality

1. **Full-pipeline, not isolated zoom.** The 33s-vs-79s win was zoom-only. V3 must beat V2 measured
   on the FULL pipeline (zoom + bubble + annotations + blur/spotlight + watermark), or it doesn't
   ship. Isolated-zoom numbers do not count.
2. **Quality parity.** The spike clips were ~8-11 Mbps + bilinear vs ffmpeg's 24 Mbps + lanczos —
   tunable (AVAssetWriter explicit bitrate; `CILanczosScaleTransform`) but they MUST get tuned.
   V3 must not ship softer video than V2.
3. **The reference is real exports.** Once V2 is the daily driver, the owner's actual demo exports
   become the A/B baseline and the gate — V3 is judged against those, not synthetic clips.

## Carries forward from V2
- **Zone-based bubble** (constant export position, chosen in Review) — simplifies both paths and
  is already the V2 design; V3 inherits it as a constant CI layer, no position animation to port.
