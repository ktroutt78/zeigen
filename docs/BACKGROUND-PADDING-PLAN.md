# Background / Padding — scope + plan (feature #3)

Reference: https://screen.studio/guide/background. Padding shrinks the recording inside a
larger canvas; the background fills what's left. Padding 0 = no background visible = the natural
no-op. Applies to full-display recordings, not just windows.

Status: **scoped, not built.** Evidence-cited against current code below.

---

## The one architectural decision everything hinges on

The recording becomes an **inset layer** on a background canvas. There are two ways to wire that
into the Core Image pipeline, and the choice determines the cost of every scope question:

- **(A) Inset early** — after zoom, scale the content into a rect, composite over background,
  THEN run redaction / bubble / watermark against the padded canvas. This forces every downstream
  transform (redaction's `(src − winOrigin)·s`, bubble/watermark anchors) to learn about the inset.
  It reopens the pinned redaction transform. High cost, high risk.

- **(B) Inset last (RECOMMENDED)** — let the *entire existing pipeline* run untouched in source
  `W×H` space (zoom → redaction → bubble → watermark, exactly as today), producing a finished
  `W×H` "content frame." Then, as a new terminal stage **before downscale**, draw the background
  canvas, scale/round/shadow the whole content frame as one unit, and composite it in.

**Pick (B).** It is dramatically cheaper because every current transform keeps running in its
current coordinate space. The inset is a pure downstream affine on an already-finished frame.
This single choice is what makes questions 2, 3, and 4 collapse to "composes cleanly, no change."

Insertion seam: between watermark (`main.swift:721-723`) and terminal downscale
(`main.swift:728-736`). The running `var out` (`main.swift:580`) is a finished `W×H` image at that
point; the new stage consumes it.

---

## Scope questions answered

### Q1 — Cost in the Core Image compositor

With approach (B), and with **canvas = source dimensions** for v1 (see Q-dimensions below):

- **Writer / adaptor / bitrate dims are UNCHANGED.** They stay sized to `outW×outH`
  (`main.swift:342-368`, `274`, `755`), which stays source-derived. The inset stage draws into the
  same `W×H` buffer — background fills the margin, content shrinks inward. No decoupling of output
  space from source. This is the big cost-saver and it keeps the byte-identical no-op trivial.
- **New per-frame work:** one extra `CILanczosScaleTransform` on the content frame (scale factor
  `k` from padding) + one or two `sourceOver` composites (background under, content over). The
  background image, rounded-corner mask, and shadow silhouette are all **static** for our shipped
  set (solid / gradient / still image) and are **precomputed once before the frame loop** — same
  pattern as the bubble mask/shadow PNGs (`edit.rs:830-842`). Per-frame cost is comparable to
  adding a single overlay. Not expensive; no new decode per frame.
- **Redaction legibility is preserved or strengthened:** the blur is applied in content space, then
  the whole frame is scaled *down* by `k`. Downscaling a blurred region cannot recover detail, so
  the illegibility guarantee holds. No safety regression to the redaction gate.

### Q2 — Bubble & watermark placement: video edges or canvas edges?

**Anchor to the video's edges (they inset *with* the recording). Not a choice — this is correct,
and it is free.**

Both anchor to `Wd/Hd` today (bubble `main.swift:439-447`, watermark `main.swift:411-420`). Under
(B) they are composited into the content frame *before* the inset, so they ride along and stay
pinned to the recording's own corners, floating over the video inside the padded region. Rationale:
a watermark is on-content branding and the webcam bubble reads as pinned to the screen corner —
anchoring either to the outer canvas would let it drift out into the empty background gradient,
detached from the recording, which looks broken. Zero code change to bubble/watermark: they keep
computing against `W×H`.

Known minor: rounding the content corners (Q-styling) masks the finished frame, so a bubble placed
exactly in a rounded corner could lose a sub-pixel sliver. The bubble is a circle inset ~30px from
the edge; realistic corner radii (~20-40px) barely intersect it. Accept for v1; flag it. If it ever
bites, composite the bubble *after* the corner mask (a later refinement, not v1).

Future option (deferred, not v1): a "watermark in the padding margin" toggle that anchors the
watermark to the canvas instead. Separate feature.

### Q3 — Zoom interaction when the recording no longer fills the frame

**No interaction. Composes cleanly.** Zoom is a crop+scale within source `W×H` space
(`main.swift:573-591`) that always refills the content frame to `W×H`. The inset happens after, on
that refilled frame. "Zoom zooms the recording; the recording is then padded." Nothing in the zoom
math changes.

### Q4 — Redaction regions transformed through zoom — does padding break the transform?

**No. Composes cleanly, transform untouched.** Redaction rects are source-normalized `[0,1]` and
mapped into content space by `out = (src − winOrigin)·s` — mirrored pixel-for-pixel in TS
(`redaction.ts:60`) and Swift (`main.swift:619-630`) and pinned by the redaction-gate harness
(`compositor-engine/redaction-gate/`). Under (B) that mapping runs in the same `W×H` content space
as today; the inset is applied to the whole finished frame *afterward*. The pinned transform and its
gate stay green with no edit. This is the decisive reason to choose (B) over (A) — (A) would reopen
this pin.

### Q5 — Where gradient assets live; how the sidecar carries the choice

- **Gradient presets = procedural, zero bundled assets.** Render in Swift with `CILinearGradient` /
  `CIRadialGradient` (or `CISmoothLinearGradient`) from a small shared preset table of
  `{type, stops[], angle}`. No files to source, no licensing, crisp at any resolution, tiny code.
  This directly de-risks the "stall on asset sourcing" worry — there is nothing to source. The
  preset table is duplicated TS↔Swift and kept in sync, exactly like the frost constants today
  (`redaction.ts:26-37` ↔ `main.swift:181-210`).
- **Solid color** — a hex string in the sidecar.
- **User image** — absolute path in the sidecar (same mechanism as the watermark logo), read at
  render time, scaled to fill the canvas. `convertFileSrc` for the preview.
- **macOS wallpapers** — read at runtime by absolute path from `/System/Library/Desktop Pictures/`.
  No bundling (see licensing note). Deferred.

**Sidecar shape** — add two fields to `SidecarState` (`Review.tsx:301` / `edit.rs:33-90`),
**declared LAST, after `redactions`**, so existing sidecars keep byte-identical field order:

```
frame?: {                     // omitted entirely when padding == 0
  padding?: number;           // 0..~0.2 fraction of frame; 0 = no-op
  corner_radius?: number;     // px or fraction; 0 = square
  shadow?: number;            // 0..1 intensity; 0 = none
  inset?: number;             // thin border/stroke width; 0 = none
}
background?:                   // omitted entirely when no background chosen
  | { kind: "gradient"; preset: string }
  | { kind: "solid"; hex: string }
  | { kind: "image"; path: string }
```

**Byte-identical no-op invariant (must hold):**
- `sidecarWritePayload` (`Review.tsx:582`) drops `frame`/`background` to `undefined` when
  padding == 0 / no background → they vanish from JSON.
- Rust `#[serde(default, skip_serializing_if = ...)]` on both; declared after `redactions`
  (`edit.rs:86`) so field order is preserved for legacy sidecars.
- TS payload object appends the two keys last, matching Rust serialization order (the
  `JSON.stringify` equality compare at `Review.tsx:100`).
- **New gate term:** the V3 export predicate `has_zoom || has_webcam || effective_wm.is_some()`
  (`edit.rs:1388`, and the GIF gate `edit.rs:1358`) does NOT currently include a self-standing
  compositing effect. Add a `has_background` term so padding/background alone forces the compositor.
  When `frame`/`background` are absent, the term is false → plain/copy fast path
  (`edit.rs:1198-1207`) → byte-identical output.

### Q6 — Position in the filter chain

```
CFR select → zoom → motion-blur → redaction → bubble → watermark → [NEW: background+inset] → downscale → encode
main.swift  :544    :573   :593      :619        :693     :721        (:723→:728 seam)          :728        :743
```

The new stage sits **after watermark, before downscale**. Downscale then caps the *canvas*
(= source dims in v1), so `v3_output_dims` (`edit.rs:598-606`) is unchanged for v1.

---

## Canvas dimensions decision (v1 vs the one big lift)

- **v1: canvas = source dimensions.** Padding shrinks the content inward within the existing
  `W×H`; background fills the margin; output pixel dims are identical to today. Padding 0 → content
  fills canvas exactly → byte-identical. This keeps writer sizing untouched and the no-op trivial.
  Same-aspect recordings (full-display 16:9) get the Screen-Studio look immediately.
- **Deferred, genuinely bigger lift: user-chosen output aspect** (e.g. squarish recording → 16:9
  social canvas). This decouples writer/adaptor/bitrate/render dims from source
  (`main.swift:342-368`, `274`, `755`) and reworks `v3_output_dims` (`edit.rs:598-606`). It is the
  one part that is materially more expensive than the rest — call it out, ship without it.

---

## macOS wallpapers — permission + licensing (answered)

- **Permission:** `/System/Library/Desktop Pictures/` is world-readable and **not** TCC-protected
  (unlike `~/Pictures`, the Photos library, Desktop/Documents). Reading it triggers **no permission
  prompt**. Verified by direct read on macOS 26.5 (build 25F71).
- **Licensing:** Apple's wallpapers are copyrighted. Reading the copy already on the *user's own
  machine* at runtime and compositing it into the user's own recording is the user exercising their
  own license — fine, equivalent to them screenshotting their desktop. **Bundling/shipping Apple
  wallpaper files inside Zeigen would be redistribution of Apple IP — a licensing problem.** So:
  read-at-runtime = yes; bundle = no. This is exactly why wallpapers should be a runtime-enumeration
  feature, not a bundled asset.
- **Complication that makes it fuzzier than it looks:** on macOS 26 most entries are *dynamic* —
  `.madesktop` stubs pointing at `.mov` files or solar/day-night `.heic` under `.wallpapers/`.
  Only a subset are plain stills (e.g. `iMac Blue.heic`, `Mac Purple.heic`, `Radial Sky Blue.heic`,
  `Sonoma.heic` directly in the folder). A static-background feature must filter to stills (or
  extract a single frame from dynamic ones) and generate thumbnails. That filtering + thumbnailing
  is the real work, not the read. Defer.

---

## Slices + done-when bars

Ordered so the owner's preferred ship set (gradient + color + padding + corners + shadow) lands
first; wallpapers and aspect-change are deferred tails.

**Slice 0 — Sidecar plumbing + no-op invariant (skeleton, no visible effect)**
- Add `frame` + `background` to `SidecarState` (TS `Review.tsx:301` + Rust `edit.rs:33-90`),
  declared last; skip-if-default both sides; append last in `sidecarWritePayload`; add `has_background`
  to the V3/GIF gates (`edit.rs:1388`, `:1358`); Swift decode + `if padding>0 || background != nil`
  guard around the (empty) inset stage.
- **Done when:** field absent from JSON when unset; a copy-path export is md5-identical before/after
  the field exists (the redaction-style byte proof); an export with an unrelated edit (zoom) and
  padding=0/no-bg is byte-identical to pre-feature; existing redaction-gate + all byte-pins green.

**Slice 1 — Compositor inset stage: solid color + padding (no corners/shadow yet)**
- Swift terminal stage after `main.swift:723`: precompute solid background `W×H`; per frame scale
  content by `k`, center-composite over background.
- **Done when:** a solid-color padded export renders correctly; zoom / redaction / bubble / watermark
  all land correctly inside the inset (eye-check + redaction gate still green); a new byte-pin locks
  the inset frame.

**Slice 2 — Frame styling: rounded corners + shadow + inset border**
- Static precomputed rounded-rect mask + blurred shadow silhouette; optional thin inset stroke.
- **Done when:** corners/shadow render; shadow falls onto the background (not clipped by the canvas
  edge); bubble corner-clip assessed and accepted; byte-pins updated.
- Note: `inset` is the least-defined term in the reference; treating it as a thin border/stroke (or
  subtle inner shadow). Cheapest to build, easiest to drop if the owner doesn't want it.

**Slice 3 — Gradient presets (procedural)**
- Shared preset table TS↔Swift; `CILinearGradient`/`CIRadialGradient`; ~8 curated presets.
  Starting palette to tune: Violet Dusk `#7C3AED→#4C1D95` (on-brand w/ reskin), Ocean
  `#0EA5E9→#2563EB`, Sunset `#FB7185→#F59E0B`, Mint `#34D399→#059669`, Graphite `#334155→#0F172A`,
  Blush `#F9A8D4→#C026D3`, Cloud `#F1F5F9→#CBD5E1`, Ember `#F97316→#DC2626`, plus a radial Spotlight.
- **Done when:** each preset renders; TS preview matches export (eye-check, not a pinned <1px gate —
  background is cosmetic, unlike redaction); owner signs off that the presets look good.

**Slice 4 — Review UI**
- Background-type picker (gradient / solid / image) + padding / corner / shadow / inset controls +
  live WYSIWYG preview (CSS/canvas over the video, like the redaction preview).
- **Done when:** controls drive the sidecar; preview matches export; padding=0 fully clears the
  background and returns to the no-op.

**Slice 5 — User-uploaded image background**
- Absolute path in sidecar (watermark-logo pattern); scaled to fill canvas; `convertFileSrc` preview.
- **Done when:** an uploaded image renders scaled-to-fill; path persists across reopen.

**Slice 6 — macOS wallpapers (DEFERRED, fuzzy)**
- Enumerate `/System/Library/Desktop Pictures/`, filter to stills, thumbnail, read by path at
  runtime, no bundling.
- **Done when:** picker lists system stills; selection renders. Extra work: dynamic-wallpaper
  filtering + thumbnail generation.

**Slice 7 — User-chosen output aspect (DEFERRED, the one big lift)**
- Decouple writer/render dims from source; rework `v3_output_dims`.
- **Done when:** a non-source aspect canvas exports at the chosen dims with content centered.

---

## Relative cost

- Slice 0: small but exacting (the byte-identical proofs are the work, not the code).
- Slices 1–2: moderate Swift; the seam and static-precompute pattern already exist.
- Slice 3: small (procedural, no assets).
- Slice 4: moderate React (preview parity is the effort).
- Slice 5: small.
- Slice 6: moderate-and-fuzzy — the read is trivial, the dynamic-wallpaper filtering + thumbnails
  are the cost.
- Slice 7: **materially bigger than everything above** — the only piece that reopens output-dimension
  plumbing. Ship without it.

**Recommended ship set: Slices 0–4** (gradient + solid + padding + corners + shadow + UI). Add 5
(user image) opportunistically. Defer 6 (wallpapers) and 7 (aspect) — neither blocks a great v1.
