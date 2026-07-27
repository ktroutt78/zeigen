# Redaction Plan — frosted-glass static regions at export

Cover sensitive on-screen content (the motivating case: a home address typed into a
co-pilot demo) with a frosted-glass panel, authored in the Review window and rendered
by the Core Image compositor at export. Capture path stays byte-for-byte untouched.

## Locked scope

- Redaction happens at **export**, in the `cicompositor` (`src-tauri/compositor-engine/main.swift`)
  render seam. The capture path (SCStream → AVAssetWriter zero-copy) is not touched. The
  prewarm / heartbeat / first-frame timing is out of bounds.
- **Static rects only.** Fixed box, active over a `[start, end]` time range. No motion, no
  cursor-following, no per-frame position tweening. Region motion is explicitly out of scope.
- The sidecar carries the regions, mirroring the zoom-segment pattern exactly: own struct,
  `#[serde(skip_serializing_if = "Vec::is_empty")]` so no-op sidecars stay byte-identical,
  TS mirror, json/env round-trip to the compositor.

## Design decisions

### 1. Geometry — fractional, source-space, top-left origin, `{x, y, w, h}`

Each rect is four `f64` fractions of the **source** frame, top-left origin. Fractional
source-space is the robust choice against every stage that runs around redaction:

- **Downscale** changes output pixel dimensions (default export is 1080p supersample; native
  differs). Fractional coords are invariant; pixel coords are ambiguous (source px vs output
  px) and break the day the default output resolution changes.
- **Backing scale** is 2x Retina. Fractional sidesteps the coordinate-space bug class already
  hit on this project (cursor scale, LinkedIn source, bubble diameter) — there is no space to
  get wrong.
- **Trim** only shifts time, not geometry. The region's *time range* is original-timeline
  seconds, matching `ZoomKeyframe.t` and `Annotation.start_time`, because the compositor gates
  on `tSrc = trimIn + frames/fps` (`main.swift:436`), which is original-timeline. Reusing that
  basis means trim rebasing already works.
- **Zoom** magnifies — handled by the ordering + transform in §2, not by the coordinate type.

Matches the existing fractional conventions (`Annotation.Position` is 0..1; zoom `cxf/cyf`
are top-left fractions), so the top-left → CI-bottom-left conversion reuses the pattern at
`main.swift:467`.

### 2. Chain position — after zoom + motion-blur, before bubble / watermark / downscale

Current per-frame chain (`main.swift:461-552`):

```
source -> zoom (crop+upscale) -> motion-blur -> webcam bubble -> watermark -> downscale
```

Redaction goes here:

```
source -> zoom -> motion-blur -> REDACTION -> bubble -> watermark -> downscale
```

**After zoom, not before.** The failure mode "zoom magnifies past the cover and exposes
content" is real and has two distinct causes: (a) a soft-edged cover whose falloff boundary,
when magnified, leaks edge detail — mitigated by calibrating the blur to output pixels; and
(b) storing the box in output/screen space so a zoom span slides the content out from under a
fixed box — the genuinely unsafe combination, avoided by storing in **source** coords and
transforming the rect through the same `zoomAt` / `centerAt` transform the zoom stage already
computes for that frame. The rect stays glued to its content. This is not motion tweening: the
rect is static in source space and only appears to track because the content it is pinned to
is what zoom moves. A region outside the active zoom window transforms off-screen and clips to
nothing (the sensitive content is not in-frame that moment, so there is nothing to cover).

**Before bubble and watermark** because the sensitive content lives in the screen layer, and a
redaction panel must never swallow our own webcam bubble or watermark. Before downscale so the
panel is crisp at working resolution and the terminal Lanczos antialiases its edge for free.

### 3. Cover style — frosted glass (composite treatment), no solid boxes

Per region, applied after zoom + motion-blur in working/output space:

```
regionRect = source-frac rect -> transformed through active zoom -> working px
base    = frame.clampedToExtent().cropped(to: regionRect)
blurred = base.applyingFilter(CIGaussianBlur, radius: r).cropped(to: regionRect)
desat   = blurred.applyingFilter(CIColorControls, saturation: 0.5)
tint    = CIConstantColorGenerator(CIColor(tintRGB, alpha: a)).cropped(to: regionRect)
frosted = tint.composited(over: desat)
out     = frosted.composited(over: frame)
```

**Blur radius `r` scales with region size.** A fixed radius on a large box looks under-treated,
and a small radius does not erase enough residual to be safe. Formula:
`r = clamp(0.08 * min(regionW, regionH), 16, 90)` in output px. The `0.08 * min` term keeps
large boxes proportionally treated; the cap bounds cost.

**The floor is a safety parameter, not an aesthetic one.** It may go UP during tuning. It does
not come DOWN without a reason recorded in `DECISIONS.md`.

**Overlay alpha `a` = 0.6 default** (range 0.55-0.70). This is the frosted-vs-flat dial: below
~0.5 it reads as a faint tint and both the look and the residual attenuation weaken; above
~0.75 it reads as a solid panel. 0.6 is a translucent frost that still shrinks the recoverable
residual.

**Desaturation** (`CIColorControls` saturation ~0.5) ships in v1 — mutes color bleeding through
the frost so it reads as neutral glass rather than a tinted smear.

**Corner radius / edge feather** is deferred polish.

**Light vs dark overlay — configurable per region, default light.** A single fixed tint cannot
read well on both light and dark content, and both are recorded. Per-region author choice is
the pragmatic answer:

- **Light frost** (white, `a ~ 0.6`) — default; classic frosted glass, reads best over dark and
  mid content.
- **Dark frost** (near-black ~0.1 gray, `a ~ 0.6`) — smoked glass, for light-heavy content where
  a white frost would blend in.

Auto luminance-based tint (sample `CIAreaAverage`, pick the contrasting frost) is **deferred**:
the static region can sit over changing content, so a sampled choice risks flicker. Manual
per-region choice is simpler and predictable.

### Security posture — stated honestly, not overclaimed

The blur is the safety lever; the overlay is aesthetics plus residual attenuation.

Core Image source-over compositing of a constant color `C` at alpha `a` over an opaque
background `B` is `out = a*C + (1-a)*B` — a **linear, invertible** operation. In floating point,
an attacker who knows `a` and `C` (both constant, both guessable) recovers `B` exactly:
`B = (out - a*C) / (1-a)`. Only `a = 1` (a solid fill) makes the `B` term vanish. So a
translucent overlay does **not**, by itself, destroy the underlying pixels.

The real destruction comes from elsewhere:

1. **Heavy gaussian blur** spreads the secret's high-frequency energy wide and attenuates it
   hard; at 8-bit output, a large-radius blur pushes most of that residual below the 1/255
   quantization floor — that content is gone, not merely smeared. This is why the radius must be
   heavy and why its floor is a safety parameter.
2. **The overlay** scales the surviving residual by `(1-a)` before it is quantized to 8-bit and
   H.264-encoded. Recovery must divide by `(1-a)`, amplifying quantization + codec noise by
   `1/(1-a)` and swamping the residual. It also defeats casual sharpen/unblur tools.

Net: blur (heavy) + translucent overlay + 8-bit render + H.264 is practically unrecoverable
against the real threat — a viewer reading the address, or someone running "enhance." It is
**not** the information-theoretic zero-recovery guarantee that an opaque fill provides. A
forensic adversary with the exact `a`, `C`, and kernel could attempt recovery, and success then
hinges entirely on how much the blur + quantization already erased. Given opaque black boxes are
ruled out by design (the frosted look is the point), this is the correct tradeoff — and a heavy
radius is what makes it hold.

### 4. Review-window UI — draw + time + tint

No existing annotation-drawing tool to extend (the `Annotation` text/arrow schema is dormant and
absent from the frontend), so the drawing interaction is built fresh; the time-range editing
mirrors the proven zoom-span UI (`ZoomEditor`, start/end spans).

- Redact tool: click-drag on the video frame to draw a box; convert the drawn screen rect to
  source fractions via the frame's current display transform.
- Time binding: a span control mirroring zoom spans, editable start/end.
- Per-region light/dark tint toggle.
- **Preview renders the actual frosted treatment under any active zoom** (same transform as
  export) so the author sees the real result and sizes the box with margin. This is the concrete
  mitigation for the "magnify past the edge" risk — the author sees exactly what the viewer will.
- Delete: removing all boxes must return the sidecar to a byte-identical no-op.

### 5. Baseline invariant — verified, not asserted

*A recording with zero redaction regions produces a byte-identical export to today.* Enforced
and proven at three layers:

- **Sidecar:** `redactions` carries `#[serde(skip_serializing_if = "Vec::is_empty")]`, so an
  empty list emits no key and the JSON is byte-for-byte unchanged. Proven by a round-trip test
  asserting the serialized bytes of a no-redaction sidecar are identical before/after the change.
- **Rust -> compositor wiring:** an empty list emits no new env/json. Proven by an arg-vector +
  env pin test (the technique that gated V2 elimination).
- **Compositor:** the redaction stage is gated behind the redaction env being present; absent, the
  render loop takes the identical code path. Proven by an **md5 A/B**: export a zoom + bubble +
  watermark fixture with no redactions using the current binary, hash the mp4; apply the change;
  export again; hashes must match. This is the copy-md5 gate from the V2 teardown.

## Commits (done-when bars)

**Commit 1 — Sidecar schema + TS mirror.** Add `RedactionRegion { x, y, w, h, start, end, tint }`
and skip-if-empty `redactions: Vec<RedactionRegion>` to `SidecarState` in `edit.rs`; mirror in
`Review.tsx`.
*Done when:* a no-redaction sidecar serializes to byte-identical JSON vs today (test); a
populated region round-trips through serde and the TS type; `cargo test` green.

**Commit 2 — Compositor frosted stage.** In `main.swift`, after zoom + motion-blur and before the
bubble: read regions from env, gate each by `tSrc in [start,end]`, transform its source-frac rect
through `zoomAt` / `centerAt`, clip to frame, render the blur + desat + tint composite with the
size-scaled radius.
*Done when:*
- redaction env **unset** -> exported zoom + bubble + watermark fixture is **md5-identical** to the
  pre-change binary;
- a region set -> the region is frosted and illegible, and **stays covered across an overlapping
  zoom span** (pixel check on sampled frames);
- radius visibly scales with box size; a region outside the active zoom window renders nothing;
- **small-box / small-text case:** a 6-8 word address at normal UI font size, in a small box, is
  **illegible at 1x in the exported mp4** (not in preview). This is the hardest case for the floor
  and the one where an under-treated radius would bite; if the floor must rise to pass it, raise it
  and note it in `DECISIONS.md`.

**Commit 3 — Rust V3 wiring.** `V3Render` serializes non-empty `redactions` to the json/env the
compositor consumes (mirroring the `zoom.json` / `ZOOM_SEGMENTS` round-trip); empty list emits
nothing.
*Done when:* arg-vector + env pin test shows an empty list produces byte-identical args/env to
today; a populated list adds exactly the expected env/json and the end-to-end export shows the
frost.

**Commit 4 — Review UI: draw + time + tint.** Redact tool (drag -> source fractions), zoom-span-style
start/end control, light/dark tint toggle, live frosted preview honoring zoom, delete.
*Done when:* a user can draw a box, set its time range and tint, see the real frosted treatment in
the preview under zoom, and it persists to the sidecar; deleting all boxes restores a
byte-identical no-op sidecar; export reflects the authored box.

## Starting parameters (tune by eye in commit 2)

- `alpha = 0.6` — aesthetic + residual attenuation; not locked.
- `radius = clamp(0.08 * min(w,h), 16, 90)` output px — the `0.08` and cap are aesthetic; the
  **floor (16) is a safety parameter**: it may rise during tuning, it does not fall without a
  stated reason in `DECISIONS.md`.
- `saturation = 0.5` — desaturation, ships in v1.
