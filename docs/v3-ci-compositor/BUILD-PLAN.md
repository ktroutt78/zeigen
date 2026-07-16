# V3 build plan — Core Image / AVFoundation compositor

Status: **in progress — Phases 0, 1, 2, 5 built and owner-judged; Phases 3-4 (overlays) NOT
started; owner deciding whether the remaining case justifies the overlay-porting rounds.**
See README.md for the corrected thesis (V3 is a perf/thermal rewrite with cleaner edges +
untouched non-zoomed frames, NOT a buttery-zoom upgrade).

## Build status (2026-07-15)

- **Phase 0 — validation harness: DONE.** `harness/` (spatial_diff, temporal_probe, ringing,
  drivers). Trusted as a regression tripwire + relative smoothness comparator, not a quality judge.
- **Phase 1 — identity re-encode: DONE, color proved.** 52.7 dB vs source (on par with ffmpeg);
  root-caused a CI transfer-curve color bug -> fix is color management OFF (`workingColorSpace =
  NSNull`). See `src-tauri/compositor-engine/README.md`.
- **Phase 2 — zoom (single-resample lanczos): DONE.** Sharpness parity with V2, but **less
  ringing** (cleaner hard edges). Velocity plumbing exposed for blur.
- **Phase 5 — motion blur: DONE and pulled forward; result = does NOT deliver at 0.6s/2x.**
  Blind owner test: favorite was no-blur. Out of the value case; code kept off-by-default.
- **Phases 3-4 — overlays: NOT started.** Gated on the owner's scope decision, since the
  zoom-glamour payoff did not materialize and the remaining case is perf + cleaner edges +
  non-zoomed frames.

Original companion: `gpuzoom.swift` (the proven perf spike).

The organizing principle: **V3 is a parallel export path selected by a flag, never a replacement,
until one final switchover commit.** V2 stays the default and the daily driver through the entire
build. Every layer is independently A/B-able against V2, and the flag is the bail-out — if V3 goes
sideways at any layer, the owner keeps exporting through V2 with zero disruption and V3 is shelved
at whatever layer it reached.

Priority order for this build, per owner: **buttery + high-quality imagery first, export time
second** (won't accept slow, will trade some speed for polish).

---

## Currency

Estimates are in **CC sessions** (one working session) and **judge rounds** (one A/B where the
owner looks at real output and rules pass/iterate/bail). Not human-engineer weeks.

| Phase | What | Sessions | Judge rounds | Fat tail? |
|---|---|---|---|---|
| 0 | Visual-tolerance validation harness | 1 | 1-2 (calibrate) | — |
| 1 | Identity re-encode through CI (color proof) | 1 | 1 (+2 if color) | **color** |
| 2 | Zoom, single-resample lanczos + smoothness | 1 | 1-2 | — |
| 3 | Content overlays (text, arrow, blur, spotlight) | 1-2 | 3-5 | **per-overlay** |
| 4 | Screen overlays (webcam bubble, watermark) | 1 | 1-2 | — |
| 5 | Motion blur on the ramp | 1 | 1-2 (taste) | — |
| 6 | Full-pipeline perf gate + real-export A/B + switchover | 1 | 1 | — |
| **Total** | | **~6-8** | **~10-16** | 1 (color), 3 (overlays) |

Higher than the README's original ~4-6 / ~8-14 because Phase 0 and the finer overlay sequencing
add rounds — that is the **price of the incremental-judging + bail-out property the owner asked
for**, and it front-loads the fat-tail spend where it's cheapest to absorb. Compressible: if a
layer's first A/B is clean, batch its remaining overlays and skip rounds.

---

## Phase 0 — Visual-tolerance validation harness (BEFORE any port)

The byte-identity guards (`stream_md5`, `legacy_args_pinned`) are **dead against a new renderer** —
V3 renders *differently on purpose* (one resample not three, linear color not gamma), so it will
never be byte- or even PSNR-identical to V2. Without a replacement tripwire the owner judges every
round by eye alone, which is exactly how the color/overlay fat tail bites silently. Phase 0 builds
that tripwire first.

### What it actually is

A standalone harness (Rust test-bin or a script; not shipped in the app) that takes the **same
source recording + same sidecar**, exports it through **V2 (ffmpeg)** and **V3 (CI)**, then runs
two diffs:

1. **Spatial correctness diff (still-frame).** Decode matched frames from both outputs (align by
   PTS), compute per-region **SSIM + CIEDE2000** (perceptual color-difference). Regions matter:
   split each frame into *screen content* vs *each overlay's bounding box*, so an overlay parity
   break shows up localized instead of averaged into a global number that hides it. Calibrate
   thresholds in this phase by diffing **V2-vs-V2** (the noise floor: encoder nondeterminism) and
   **V2-vs-a-deliberately-broken-V3** (a known-bad, to confirm the tripwire actually trips).

2. **Temporal smoothness probe (the butteriness proxy).** Extract the per-frame pan-center
   trajectory during ramps and compute its velocity + second derivative (jerk). V2's s/4
   quantization produces a measurable **sawtooth staircase** in the velocity curve; V3's continuous
   affine transform produces a smooth curve. This objectively confirms V3's smoothness win on the
   quantization-stutter axis — the one part of "buttery" that *can* be measured.

### Can it be trusted?

**Partially, and honestly:**

- **Trust it for regression tripwires** — the fat-tail failures: color-range/tag mistakes (CIEDE2000
  spikes), geometry/registration errors (SSIM collapse), missing or mispositioned overlays
  (localized region diff), gross sharpness direction. These are exactly the silent breakages the
  dead guards used to catch, and the harness catches them mechanically.
- **Trust the temporal probe for the quantization-stutter axis specifically** — sawtooth vs smooth
  is objective and is more reliable than eyeballing a slow pan.
- **Do NOT trust it as a "looks better" judge.** "Buttery," "polished," subjective sharpness
  preference, motion-blur taste — these live below the resolution of SSIM/CIEDE2000 (still-frame
  metrics) and below any single-frame metric for temporal feel. Those stay **owner-eye-judged**.

So the harness does not replace the owner's eye. It **shrinks the eye's job to pure aesthetic
judgment on a pre-cleared surface** — the eye never has to hunt for silent color/overlay breakage,
because the tripwire has already cleared it. That is the correct and only trustworthy role for it.

**Deliverable of Phase 0:** the harness + a calibrated threshold table + owner sign-off that the
tripwire agrees with their eye on one known-good and one known-bad. Nothing is ported until this
exists.

---

## Phases 1-6 — the sequenced port

Each phase is behind the V3 flag; V2 remains default. Each ends in an A/B the owner judges. Bail-out
= stop at the last good phase, V2 unaffected.

### Phase 1 — Identity re-encode through CI (prove color FIRST)

Decode -> CI passthrough (no zoom, no overlays) -> AVAssetWriter, 8M ABR, 709 tags. This is the
`ident` spike scenario, now judged for **quality not perf**. Purpose: **prove the color round-trip
dead on the simplest possible pipeline, before any overlay complexity can confound it.** The
harness's CIEDE2000 on non-zoomed frames must be ~0 vs both V2 and source; range and tags correct.

Why first: color-space surprises are the most insidious fat tail (§ below). Proving them on a bare
re-encode means any later color delta is attributable to a specific overlay, not the base pipeline.
Clean bail-out point — nothing else built.

### Phase 2 — Zoom, single-resample lanczos (prove the core thesis)

Add the sub-pixel affine + `CILanczosScaleTransform` (one resample at scale s). Judge: sharpness at
peak zoom >= V2, and the temporal probe shows a smooth trajectory (no sawtooth). **Expose the
per-frame pan-velocity vector here even though motion blur is off** — Phase 5 consumes it; plumbing
it now is what makes blur designed-in, not bolted-on.

This is the make-or-break: if V3's zoom doesn't beat V2's here, the whole case is in question. It's
early and it's a clean bail-out (only base + zoom built). Watch for **slow-pan shimmer** here (sharp
lanczos + sub-pixel phase pumping) — if it appears, it's handled by the Phase 5 blur floor, not by
softening the kernel; note it, don't fix it yet.

### Phase 3 — Content-anchored overlays (the fat-tail zone)

Overlays that **zoom WITH content**: text, arrow, blur, spotlight. Sequence **one at a time**, each
gated by the harness's localized-region diff so a break is isolated:

- **Text, arrow** — LOW risk: already Rust-rasterized to PNGs (`rasterize_text`, arrow rasterizer).
  Reuse the exact PNGs as CI layers — pixel-identical source, only the composite math changes.
- **Blur** (`kind=="blur"`, region gblur, sigma off shorter side) — NEW CI rendering (`CIGaussianBlur`
  on a cropped region). CI's gaussian falloff != ffmpeg's `gblur` sigma exactly; expect to tune the
  CI radius to match, gated by the region diff. Budget the most rounds here.
- **Spotlight** (`kind=="spotlight"`, dim outside rect, `SPOTLIGHT_DIM_FACTOR=0.45`) — NEW CI
  rendering (darken-outside-rect composite). Simpler than blur but still new.

Nest these inside the zoom transform (they move with content), matching V2's `AnnotationLayer`
placement. Watermark and bubble are NOT here — they're screen-anchored (Phase 4).

### Phase 4 — Screen-anchored overlays (do NOT zoom)

Ride on top of the zoomed+content-overlaid frame, unaffected by zoom:

- **Webcam bubble** — zone-based (V2 already made position constant, so no `f(t)` animation to
  port). Circular mask + shadow is the main NEW CI rendering (CI radial mask + shadow layer to
  match composite.rs's mask+gblur shadow).
- **Watermark** — logo PNG overlay, reuse existing asset. LOW risk.

### Phase 5 — Motion blur on the ramp (the buttery ceiling-raiser)

See the dedicated section below. Landed here because you can't judge "does the blur help" until the
underlying zoom is already correct and smooth (Phases 2-4). The velocity plumbing from Phase 2 makes
this an add, not a re-architecture.

### Phase 6 — Full-pipeline perf gate + switchover

Measure the **FULL** pipeline (all overlays + blur) beats V2's full-pipeline number, not isolated
zoom. Run the owner's real-export A/B (quality). Only if both pass, flip the flag default to V3 in a
single commit. Everything before this commit left V2 as default.

---

## Where the fat tail lives, and what de-risks each

1. **Color-space surprises** (linear vs sRGB working space; 709 primaries/transfer/matrix tags;
   video-range vs full-range). Three distinct footguns: crushed/lifted blacks (range), washed
   everything (missing/wrong tags), or "looks different from V2" (CI's linear compositing thinning
   fine text). **De-risk:** prove it on **Phase 1** (bare re-encode) before any overlay — the
   simplest pipeline where a color bug is unambiguous — with the harness's CIEDE2000 as tripwire.
   This is *why* color is Phase 1, not discovered late.

2. **Per-overlay appearance parity** (each overlay must match ffmpeg's version: alpha compositing,
   blur sigma, shadow falloff, text pill). **De-risk:** (i) reuse the exact Rust PNGs for
   text/arrow so those are pixel-sourced identically — only composite math changes; (ii) sequence
   overlays one at a time with **localized-region** diffs so a break is isolated not averaged;
   (iii) blur/spotlight/bubble are the genuinely-new CI rendering — budget the most rounds there,
   expect to tune CI blur radius against ffmpeg gblur.

3. **Timing / ramp registration** (compositionTime vs trim offset; VFR->30fps conform). An
   off-by-one-frame shifts ramps vs the Review preview and breaks the Thread B WYSIWYG contract.
   **De-risk:** the spike already subtracts the trim offset (`gpuzoom.swift:57`); add a harness
   check that the pan-center trajectory aligns frame-for-frame with the preview's keyframe
   interpolation. A phase shift shows in the temporal probe.

4. **Rate control / banding** (ABR vs CQ). **De-risk:** ship AVAssetWriter ABR >= 8M first;
   escalate to `VTCompressionSession` CQ only if the Phase 6 A/B shows banding on busy zoomed
   frames. Do not pre-optimize (see README counterpoint).

---

## Motion blur — designed in, not bolted on

The owner wants this specifically; buttery is priority #1 and it is V3-only. Designed from Phase 2
(velocity plumbing), landed Phase 5.

### What it is

During the zoom **ramp only** (not the hold), apply **directional (linear) blur** oriented along
the per-frame pan-velocity vector, magnitude scaled by velocity. At the hold, velocity -> 0 ->
blur -> 0, so it appears only during motion — exactly like a real camera's motion blur / a high-end
product zoom. This is the "expensive" look.

### As a CI layer, and where it slots

- **Filter:** `CIMotionBlur` (built-in: angle + radius). Per frame, compute the pan-velocity vector
  from the transform derivative (already exposed in Phase 2); feed `angle = atan2(vy, vx)`,
  `radius = floor + k * |velocity|` (the floor term is load-bearing — see shimmer below).
- **Applies to the CONTENT plane only.** Order: source -> zoom transform -> **motion blur (content
  plane)** -> content overlays (text/arrow/blur/spotlight, which move with content) ->
  screen-anchored overlays (bubble, watermark — stay SHARP) -> encode. The bubble and watermark
  must never motion-blur; they're screen-anchored and static.
- **Cost:** `CIMotionBlur` is a cheap GPU convolution — rides under the encoder like the rest, no
  meaningful wall-time. The real cost is **tuning the k constant** (blur length per unit velocity),
  a taste knob: 1-2 judge rounds. Start conservative — too much reads smeary/laggy, too little
  still strobes.

### Interaction with the shimmer risk — the key question

The shimmer risk (flagged in the V2/V3 analysis): sharp lanczos + sub-pixel phase during **SLOW**
pans can pump sharpness/shimmer as edges cross pixel boundaries. Does motion blur help or compound?

**They are decoupled by velocity, and the design exploits that:**

- Shimmer is worst at **LOW** velocity (slow pan — edges dwell near pixel boundaries, phase pumping
  visible). Velocity-scaled motion blur is strongest at **HIGH** velocity and -> 0 at low velocity
  by design. So **naive** velocity-only blur does *nothing* for shimmer (blur is off exactly where
  shimmer happens) — it doesn't compound it, but it doesn't fix it either.
- **The fix and the strobe-fix share one layer:** `radius = floor + k * |velocity|`.
  - the **floor** term is a small always-on blur/anti-alias during motion -> kills slow-pan shimmer;
  - the **velocity** term -> kills fast-pan strobe.
  One CI motion-blur layer, two terms, both problems. This is precisely why blur is *designed in*
  rather than bolted on: the floor is the shimmer mitigation, and it only exists if you build the
  blur layer as `floor + k*v` from the start instead of pure `k*v`.

**Build implication:** if Phase 2's A/B surfaces slow-pan shimmer, do NOT soften the lanczos kernel
(that throws away the sharpness win). Note it, and let the Phase 5 floor term absorb it. If no
shimmer appears, keep the floor at zero or near-zero. Either way the layer's shape is `floor + k*v`.

---

## What stays untouched (V2 intact throughout)

- Audio (arnndn) stays in ffmpeg and muxes into the V3 video — no audio port.
- Capture (SCK + AVCaptureSession engine) unchanged.
- The non-zoomed `-c:v copy` fast path unchanged (plain saves never touch V3).
- V2's entire ffmpeg export path stays live and default until the Phase 6 switchover commit.
