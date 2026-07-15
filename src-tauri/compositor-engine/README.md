# compositor-engine (V3)

The GPU-native video compositor for V3. Decodes a video, routes frames through a
CIContext, and re-encodes via AVAssetWriter -> VideoToolbox H.264. All later V3
work (zoom transform, overlay layers, motion blur) plugs into the single render
seam in `main.swift`.

**Not wired into the app.** Nothing in the Rust export path invokes this yet — V2
(ffmpeg) stays the default export path. The flag/wiring into `edit.rs` lands at
Phase 2, where there is a real zoom re-encode to route. Until then this builds and
runs standalone.

Build / run:
```
swiftc -O main.swift -o cicompositor
./cicompositor <in.mp4> <out.mp4>
```

## Phase 1 — identity re-encode (DONE, color proved)

Goal: prove the color round-trip is correct on the simplest possible pipeline
(no zoom, no overlays) before any overlay can confound a color delta. Measured
against a clean 180-frame 1080p source, verified by the harness:

| metric | V2 (ffmpeg 8M) | V3 (Core Image) |
|---|---|---|
| PSNR-Y vs source | 52.07 dB | **52.70 dB** |
| color atoms | 709 / tv / yuv420p | **709 / tv / yuv420p** |
| dE vs V2 (mean / p95) | — | **0.251 / 1.556** |
| YAVG (luma mean) | 199.47 | **199.45** |

V3's identity re-encode is on par with ffmpeg and photometrically indistinguishable
from V2 (dE 0.25 is well below the ~1.0 JND).

### The color finding (why `workingColorSpace = NSNull`)

The first cut used CI's default color management (709 -> linear working space ->
709). The harness caught a **transfer-curve mismatch**: CI's managed round-trip
lifted luma ~2.75 levels uniformly, dropping PSNR-Y to 32.9 dB (err_mean -2.75).
It was invariant to bitrate, output pixel format, and working color space — only
**disabling color management** removed it, restoring 45+ dB (52.7 on a clean
source) with err_mean +0.01.

So V3 composites in the source's own (non-linear) space, matching V2's gamma-space
behavior, and never pays CI's transfer tax. This is the correct setting for
identity and for gamma-space resampling (what V2 does today).

**Carry-forward for later phases:** blur and motion blur are physically "more
correct" in linear light, which needs managed color. If a specific overlay looks
wrong under gamma-space compositing, revisit managed color with an explicit
input-space match (the mismatch above is what to avoid) — but identity and zoom do
not want it.

Also observed: VideoToolbox ABR caps well below the 8M target on easy content
(1.6-4.9 Mbps for a 50M target sweep) and PSNR-Y is flat across that range — the
quality ceiling here is the pipeline, not the bitrate. Relevant to the README's
rate-knob counterpoint (`../../docs/v3-ci-compositor/README.md`); revisit
VTCompressionSession only if a real A/B shows banding on busy zoomed frames.
