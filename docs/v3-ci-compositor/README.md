# V3 — Core Image / AVFoundation compositor (deferred branch)

Status: **in progress.** Phases 0-2 + 5 built and owner-judged; overlays (Phase 3-4) not
started. V2 stays the default export path throughout (flag-selected; V3 not wired into the app).
Build state and the honest thesis below.

## What V3 actually is (thesis corrected 2026-07-15 — read this first)

V3 was framed as a "buttery, expensive-looking zoom" upgrade. **It is not that.** Owner-judged
measurement through Phase 2 + 5 corrected the thesis:

- **Zoom quality is at PARITY with V2 on sharpness** (Laplacian equal across V3, V2, and an ideal
  single-lanczos), and **motion blur does NOT deliver at the owner's zoom speeds** (0.6s ramp to
  2x) — see findings below. The glamour case is gone.
- **V3 is fundamentally a performance / thermal rewrite** (encoder-bound not CPU-bound;
  hardware-uniform; no fanless-Air throttle) that ALSO gives two modest real quality wins:
  **cleaner hard edges** (less ringing than V2) and **untouched non-zoomed frames** (V2 softens
  the whole timeline; V3 leaves identity frames alone).

So the honest one-line thesis a future session should inherit: **V3 = a faster, cooler,
hardware-uniform export that looks equal-or-slightly-cleaner, NOT a dramatically better-looking
zoom.** Decide scope on the perf + cleaner-edges + non-zoomed case, not on zoom glamour.

## Findings from the built phases (2026-07-15)

**Ringing win (real, modest).** Static-zoom sharpness is equal by Laplacian, but that metric can't
separate ringing from sharpness (ringing ADDS edge energy). Measuring over/undershoot adjacent to
hard edges (`harness/ringing.py`): **V2 rings 7% more at step>40, 13% at step>70, 14% at step>100**,
and registers ~36% more "hard edges" (many are ringing spikes). V3 rings less than even the ideal
ffmpeg single-lanczos, because Core Image's lanczos kernel has **gentler negative lobes**. Same
sharpness, cleaner edges — a genuine V3 win the parity metric hid.

**Motion blur does NOT deliver at 0.6s / 2x (blind test).** The entire "V3 zoom looks better" case
had narrowed to motion blur. A blinded ladder below "subtle" (half / quarter / eighth + two
no-blur, shuffled, key withheld) was owner-judged: the owner's **favorite was a no-blur clip**,
they **imagined a difference between two byte-identical no-blur clips**, and they **rejected every
strength they could actually perceive**. Conclusion: at a 0.6s ramp to 2x there is no strobe worth
fixing. Motion blur is **out of the value case**. The code stays (`main.swift`, `BLUR=on`, radial
CIZoomBlur, `radius = floor + k*|v|`) as **off-by-default insurance** for faster/bigger zooms where
strobe would actually appear — not a default, not a justification.

## Why V3 exists (the measured PERF case — this is the real reason, not a hunch)

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
in ffmpeg and muxes; capture stays; the non-zoomed copy fast-path stays. Estimated **~6-8 CC
sessions / ~10-16 judge rounds** (see `BUILD-PLAN.md` for the sequenced breakdown), fat-tailed on
per-overlay appearance parity and Core-Image-vs-ffmpeg color-space surprises. The dead byte-identity
invariants can't guard a different renderer, so V3 opens with a new visual-tolerance validation
harness (BUILD-PLAN Phase 0) built BEFORE any port. Reuse the Rust text/arrow PNG rasterization as
CI layers to cut risk; only blur/spotlight/webcam need new CI rendering.

## V3's bar — stated positively (what "done, and better" means)

Corrected 2026-07-15. Earlier drafts framed this as "must not regress V2" and cited a **24 Mbps**
ffmpeg parity target — both wrong-footed. The shipping V2 encoder is **8M ABR** (`edit.rs:1654`,
`composite.rs:911`), NOT 24 Mbps (that figure was a no-`-b:v` scratch test, not the export path — do
not chase it). The bar, as concrete gates, each independently checkable:

1. **Full-pipeline win, not isolated zoom.** The 33s-vs-79s spike win was zoom-only. V3 must beat V2
   measured on the FULL pipeline (zoom + bubble + annotations + blur/spotlight + watermark), or it
   doesn't ship. Isolated-zoom numbers do not count.
2. **Single-resample lanczos.** Every zoomed frame goes through exactly ONE lanczos magnification at
   scale s (`CILanczosScaleTransform` or a custom CIKernel), not the spike's bilinear. This is a
   structural quality win over V2 — see finding (a). Must survive into shipping code, not just the plan.
3. **Verified BT.709 color round-trip.** The AVAssetWriter output carries correct 709
   primaries/transfer/matrix tags, and video-vs-full range matches V2 — verified by tolerance diff
   (BUILD-PLAN Phase 0), NOT by eye. CI composites in linear space; a wrong range or missing tag is
   the most insidious way V3 ships washed/crushed video.
4. **Explicit bitrate >= V2's 8M.** Set `AVVideoAverageBitRateKey` >= 8_000_000 explicitly;
   AVAssetWriter's defaults differ from ffmpeg's silently.
5. **A/B against real V2 exports before switchover.** The owner's actual demo exports are the gate,
   not synthetic clips. V3 does not become the default until it wins that A/B on quality AND the
   full-pipeline perf number.

## Findings that sharpen the V3 case (2026-07-15 analysis)

(a) **V2 does THREE resamples per zoomed frame; V3 does one.** V2's chain (`edit.rs:1148-1150`) is
    lanczos up 4x -> zoompan's internal swscale crop-and-scale (bicubic, a kernel we never chose)
    -> lanczos down 4x: three generations of kernel loss (softening + lanczos ringing on fine UI
    text) on every zoomed frame. V3's single lanczos magnification at scale s is a structural
    fidelity win V2 cannot reach by tuning.

(b) **The 4x oversample is a damped approximation, not a solved problem.** zoompan truncates the
    crop origin to integer pixels on the 4x frame, so pan position steps by **s/4 OUTPUT pixels**.
    At 4x that is only just past the visibility threshold on the content we tested (3x, steps of
    s/3, showed slight stutter). The error grows with zoom scale (bigger s = bigger step) and with
    slower ramps. V3's float-continuous affine transform has effectively zero quantization at any
    scale — so V2 is "damped below visibility on what we tested," V3 is smooth by construction.

(c) **Motion blur on the ramp is a V3-only ceiling-raiser.** At 30fps even mathematically-perfect
    sub-pixel pans strobe during fast zooms; velocity-scaled directional blur on the ramp is the
    "expensive product" look (Screen Studio does this). Trivial-ish as a CI layer, essentially
    impossible in the ffmpeg expression pipeline. The owner wants this specifically; it is designed
    in from the start and landed after core parity — see BUILD-PLAN.

**Counterpoint — V2 has the better rate knob TODAY.** ffmpeg's `h264_videotoolbox` exposes
constant-quality mode (`-q:v`, Apple Silicon only), the right rate mode for "quality first, size
second." AVAssetWriter exposes only average-bitrate for H.264, so true CQ in V3 means dropping from
AVAssetWriter to `VTCompressionSession` (`kVTCompressionPropertyKey_Quality`). V3 plan: ship
AVAssetWriter ABR >= 8M first; escalate to VTCompressionSession only if the A/B shows ABR banding on
busy zoomed frames. Do not pre-optimize.

**Per-zoomed-span oversample: SKIPPED in V2 (owner, 2026-07-15).** V2 oversamples the whole timeline
whenever any zoom is present, so non-zoomed spans get re-encoded and softened (~40.7 dB PSNR /
0.995 SSIM — slight, real). Not fixed: V2 is a temporary daily driver, cycles go to V3. V3 gets this
for free (identity frames pass through un-resampled). See DECISIONS.md 2026-07-15.

## Carries forward from V2
- **Zone-based bubble** (constant export position, chosen in Review) — simplifies both paths and
  is already the V2 design; V3 inherits it as a constant CI layer, no position animation to port.
