# V3 — Cursor, Zoom, Redaction

Charter for the next major slice. Three features, one shared foundation.

- **Synthetic cursor** — replace the burned-in system cursor with a composited, smoothed one.
- **Auto-zoom** — cinematic zoom/pan driven by cursor activity.
- **Auto-redaction** — detect and blur sensitive on-screen data, fully on-device.

Read this alongside `CLAUDE.md` (working rules) and `DECISIONS.md` (settled decisions). Phase order is load-bearing: **B depends on A, C depends on A, D is independent but shares the compositor from B/C.**

---

## 0. The two findings that shape everything

### 0.1 The cursor is currently burned into the pixels

`RecordingSession.swift:238` sets `config.showsCursor = true`. ScreenCaptureKit composites the real cursor into every frame before we ever see it.

This blocks both headline features:

- **Smoothing is impossible.** The cursor is pixels. You cannot re-time pixels.
- **Zoom breaks the cursor.** Scaling the frame scales the cursor with it. At 2x zoom the pointer is a 2x, resampled, blurry blob. Every tool that does zoom well keeps the cursor at a constant apparent size, which is only possible if the cursor is drawn *after* the zoom transform.

**The fix is capture-side, not post-side.** Set `showsCursor = false`, log the cursor path separately, and composite a synthetic cursor at render time. This is Phase A and it is a hard prerequisite. There is no version of auto-zoom that ships without it.

### 0.2 The visual pipeline should move to AVFoundation, not grow in ffmpeg

Today `edit.rs` (2,452 lines) builds ffmpeg filter chains, and `DECISIONS.md` (2026-05-20) records the measured cost: a full video re-encode was **39s on a 5-minute recording**, against a stated "more than ~10s → flag" threshold. The current pipeline avoids this by using `-c:v copy` whenever there's no video work.

Zoom, synthetic cursor, and blur are all video work. Naively, every save with these features on becomes a full re-encode and we blow straight through the threshold — on the exact recordings people most want to make.

Worse, ffmpeg is the wrong tool for this specific job:

- `zoompan` operates on integer pixel offsets and stutters visibly on slow pans. Cinematic zoom needs subpixel precision.
- Compositing a cursor sprite along an interpolated path, with per-frame transforms, is awkward-to-hostile in `filter_complex`.
- Keyframe interpolation of arbitrary curves has no clean expression form.

**Decision: build a Swift compositor and keep ffmpeg for audio and final encode.**

Use `AVMutableVideoComposition` with a custom compositor (Core Image / Metal). One GPU pass applies, in order: zoom/pan transform → blur regions → synthetic cursor overlay → webcam overlay. Hardware-accelerated, subpixel-accurate, single pass. Then hand the result to ffmpeg for `arnndn` + AAC + `h264_videotoolbox` exactly as today.

This is not a rewrite. `composite.rs` (782 lines, webcam overlay) and the video half of `edit.rs` get replaced by one Swift compositor. The sidecar model, the trim logic, the audio chain, and every export path stay as they are.

**Verification gate for this decision:** a 5-minute recording with zoom + cursor + one blur region must save in **under 15s** on Apple silicon. If the Swift compositor can't hit that, stop and re-plan before building Phases C and D on top of it.

---

## 1. Phase A — Cursor telemetry (foundation)

Capture cursor motion and clicks as a timestamped track alongside the video. Nothing visible ships in this phase. It is the substrate for B and C.

### A.1 Capture

In `RecordingSession.swift`:

- Set `config.showsCursor = false`.
- Start a cursor sampler on recording start, stop it on stop.

Sample cursor position at a fixed rate — **120 Hz**, independent of and higher than video FPS. Oversampling matters: smoothing and dwell-detection quality both degrade badly if you only have one sample per frame, and 120 Hz costs nothing.

Use `CGEvent(source: nil)?.location` for position (global display coordinates, works without an event tap and therefore without extra permissions). Use an `NSEvent.addGlobalMonitorForEvents` monitor for `.leftMouseDown`, `.leftMouseUp`, `.rightMouseDown`, and `.scrollWheel`.

**Do not use a `CGEventTap`.** It requires Accessibility permission, which is a separate, scary, and unnecessary prompt. We already ask for Screen Recording, Camera, and Mic. Adding Accessibility to record a demo is a real onboarding cost for zero benefit here.

### A.2 The alignment problem — the crux of this phase

Cursor samples and video frames are produced by different clocks. If they drift, the synthetic cursor lags or leads the content, and the whole feature feels broken. Everything downstream depends on getting this exactly right.

- Timestamp each cursor sample with `mach_absolute_time()`, converted to seconds via `mach_timebase_info`.
- Record the `CMSampleBuffer` presentation timestamp (PTS) of the **first video frame** written by `AVAssetWriter`, alongside its `mach_absolute_time()` at the moment of receipt.
- That pair is the anchor. Every cursor sample's video-timeline position is `sample_mach_time - first_frame_mach_time + first_frame_pts`.
- Persist the anchor in the telemetry file. Do not recompute it later.

Coordinates: store in the **video's pixel space**, not screen points. Apply the same `sourceRect` offset and scale factor the session already computes for area and window capture (`RecordingSession.swift`, area-capture path). A cursor at screen (1200, 400) during a 400x300-offset area capture on a 2x display must be stored at the pixel it actually occupies in the mp4. Get this wrong and the cursor draws in the wrong place on every non-fullscreen recording.

### A.3 Format

Write `<recording>.cursor.json` next to the mp4, mirroring the existing `<recording>.annotations.json` convention in `edit.rs:sidecar_path()`.

```json
{
  "version": 1,
  "anchor": { "first_frame_pts": 0.0, "first_frame_mach": 128374651234 },
  "video_size": { "width": 3456, "height": 2160 },
  "sample_rate_hz": 120,
  "samples": [
    { "t": 0.0083, "x": 1720, "y": 1080 },
    { "t": 0.0166, "x": 1724, "y": 1081 }
  ],
  "events": [
    { "t": 1.245, "kind": "left_down", "x": 1810, "y": 990 },
    { "t": 1.310, "kind": "left_up",   "x": 1810, "y": 990 },
    { "t": 4.002, "kind": "scroll",    "x": 900,  "y": 500, "dy": -3 }
  ]
}
```

Keep it a separate file from the annotations sidecar. Different lifecycle: telemetry is written once at capture and is immutable; the sidecar is user-edited state. Do not entangle them.

### A.4 IPC

Extend `docs/IPC-SPEC.md`. Add to the `start` command:

- `capture_cursor` (bool, optional, default `true`) — when true, `showsCursor = false` and telemetry is written.

Add a new event:

- `cursor_track_written` — `{ "event": "cursor_track_written", "path": "...", "sample_count": 14203 }`, emitted after `stopped`.

Backward compatibility: `capture_cursor: false` reproduces exactly today's behavior (`showsCursor = true`, no telemetry file). Every existing recording, and every recording made with the flag off, must continue to save byte-identically. That is the regression gate for this phase.

### A.5 Done when

- A 60s recording produces a `.cursor.json` with ~7,200 samples and correct click events.
- **Alignment proof:** record a recording where you click a visible UI element at a known moment. Assert that the telemetry click timestamp lands within **one frame** (33ms at 30fps) of the frame where the UI visibly reacts. This is the gate. Do not proceed to B without it — every downstream feature inherits this error.
- Fullscreen, window, and area captures all produce correct pixel-space coordinates. Test all three on a 2x display; area capture on a Retina display is where this breaks.
- `capture_cursor: false` is byte-identical to pre-V3 output.

---

## 2. Phase B — Synthetic cursor

Draw the cursor ourselves, on a smoothed path. This is the "buttery" feel, and it ships as a visible quality win on its own — independent of zoom.

### B.1 Smoothing

Raw cursor motion is jittery: hand tremor, mouse sensor noise, 120 Hz sampling of a fundamentally noisy signal. Smoothing removes that without introducing lag.

Fit a **Catmull-Rom spline** through the sample points and resample at video frame times. Catmull-Rom passes *through* its control points (unlike a B-spline, which would cut corners and make clicks land visibly off-target) while producing C¹-continuous motion.

Then apply a small critically-damped spring (a one-euro filter is the pragmatic alternative) to kill residual high-frequency jitter.

**Invariant: at any click event, the rendered cursor must be within 2px of the true recorded position.** Smoothing that moves the cursor away from where the user actually clicked is worse than no smoothing — it makes the video lie. Pin the spline to exact positions in a small window around every click.

### B.2 Rendering

In the Swift compositor:

- Draw a cursor sprite at the smoothed position each frame.
- **Constant apparent size regardless of zoom.** When Phase C scales the frame 2x, the cursor sprite is drawn at 1x. This is the entire reason Phase A exists. Get it wrong and zoom looks amateur.
- Ship a single high-quality arrow asset (`@3x` PNG or vector). Do not try to reproduce every system cursor state (I-beam, resize handles, etc.) in v1 — it's a long tail with sharply diminishing returns.
- Click feedback: a subtle expanding ring on `left_down`. ~300ms, ease-out, low opacity. Resist the urge to make it flashy.

### B.3 Done when

- Cursor motion is visibly smoother than the raw recording, with no perceptible lag against the content it's interacting with.
- Clicks land on target, every time.
- Cursor is the same on-screen size at 1x and at 2.5x zoom.

---

## 3. Phase C — Auto-zoom

Derive zoom/pan keyframes from the telemetry. Store them in the sidecar. Let the user override.

### C.1 The heuristic

This is a *taste* problem, not an algorithm problem. The failure modes are all "it zoomed when I didn't want it to" and "it made me seasick." Bias toward calm.

Segment the timeline by cursor behavior:

- **Dwell** — cursor stays within a small radius (say 150px) for >800ms → the user is looking at something. Candidate zoom-in.
- **Click** — strong zoom-in signal. Clicks are where attention is.
- **Travel** — sustained fast motion across the screen → candidate zoom-out. The user is going somewhere; don't chase them.
- **Scroll** — reading. Hold the current zoom. Do not pan with the scroll.

Rules that matter more than the segmentation:

- **Minimum time between zoom changes: 1.2s.** Nothing makes a video more nauseating than a zoom that keeps re-deciding.
- **Maximum zoom: 2.5x.** Beyond that, screen-recorded text turns to mush.
- **Ease in and out over ~600ms**, ease-in-out cubic. Never linear — linear zoom reads as mechanical.
- **Never pan and zoom at maximum rate simultaneously.**
- When in doubt, stay wide. A missed zoom is invisible. A wrong zoom is the only thing the viewer notices.

### C.2 Storage

Extend `SidecarState` in `edit.rs` with a zoom track:

```rust
pub struct ZoomKeyframe {
    pub t: f64,          // seconds, original timeline (same basis as Annotation.start_time)
    pub scale: f64,      // 1.0 = no zoom
    pub center_x: f64,   // video pixel space
    pub center_y: f64,
    pub ease: Ease,      // InOutCubic default
}
```

Keyframes are **generated, then user-editable**. Auto-zoom proposes; the user disposes. Store an `auto_generated: bool` on the track so regenerating doesn't silently stomp manual edits.

This respects the existing "scratch stays reversible" invariant (`DECISIONS.md`, Phase 5.5/11): the source mp4 is never modified, and zoom lives in the sidecar exactly like annotations do.

### C.3 UI

In `Review.tsx`, a zoom track under the existing timeline:

- Auto-generated keyframes shown as draggable diamonds.
- One toggle: **Auto-zoom on/off**. Off is a real, respected setting — some recordings should not zoom.
- Drag to move, double-click to delete, click empty track to add.

Do not build a curve editor. If someone needs a curve editor, they should be using Final Cut.

### C.4 Done when

- A typical 2-minute demo recording produces zoom that a stranger would call "nice" and not "distracting." **This is a subjective gate and it is the right one.** Watch ten of your own recordings. If you'd rather have zoom off on more than three of them, the heuristic is wrong — retune before shipping.
- Manual keyframe edits survive a save/reload cycle.
- Auto-zoom off produces output identical to Phase B.

---

## 4. Phase D — Auto-redaction

Detect sensitive on-screen data and blur it. Independent of A/B/C; shares the compositor.

### D.1 Non-negotiable: 100% on-device

A tool whose purpose is protecting sensitive screen content must never transmit that content. No cloud OCR. No LLM vision API. No telemetry containing detected strings. Not as a default, not as an option.

This is a correctness requirement, not a preference — and it's also the marketing line: **your data never leaves your Mac.** The architecture and the pitch are the same sentence. Do not compromise it for detection quality.

Use Apple's Vision framework: `VNRecognizeTextRequest` with `.accurate`, on-device, free, no network, no permission prompt. Available in the Swift binary you already have.

### D.2 Detection

Two layers:

**Pattern layer** — regex over recognized text. High precision, near-zero false negatives on structured data:
- Email addresses
- Phone numbers
- Credit-card-shaped digit runs (with Luhn check)
- SSN-shaped strings
- Long digit runs (account numbers, IDs) — configurable threshold

**Heuristic layer** — for the unstructured stuff, mainly names:
- `NSLinguisticTagger` / `NLTagger` with `.nameType` gives on-device person-name recognition. Imperfect, but it's the right primitive.
- **Column mode:** in a dashboard or table, the user should be able to say "blur this whole column" once and have it hold. Detect the column's bounding region from the OCR layout, then blur the region for its entire lifetime. This is far more useful than per-string detection for the actual use case, and much more robust.

### D.3 Temporal stability — the part that will sink this if you get it wrong

Naive per-frame detection **flickers**, and a single unblurred frame is a total failure of the feature. Someone will find it, and it will be the frame with the customer's name in it.

- Run detection on **sampled** frames (4 Hz is plenty; OCR at 30 Hz is wasteful and no more accurate).
- Match boxes across samples by IoU (>0.5 = same region) into tracked **regions** with a start and end time.
- **Dilate every region in time.** Blur from 200ms before first detection to 200ms after last. Cheap insurance against a boundary frame leaking.
- **Dilate every region in space.** Pad the bounding box by ~8px. OCR boxes are tight; anti-aliased glyph edges leak outside them.
- On scroll or scene change, regions move. Detect large-scale frame change (simple frame-difference threshold) and **re-run detection immediately** rather than waiting for the next 4 Hz sample.

**The governing invariant: over-blur is cheap, under-blur is fatal.** Every ambiguous case resolves toward blurring more, for longer, over a wider area. A user who sees too much blur will adjust a box. A user who ships a video leaking a customer's account number will never use the tool again, and will tell people why.

### D.4 Blur

Gaussian blur at a radius that is genuinely irrecoverable — **not pixelation.** Pixelated text has been shown to be recoverable, and mosaic-style redaction has a bad reputation for exactly this reason. Blur radius should scale with detected text height, minimum 20px sigma. When in doubt, use a solid fill.

Applied in the Swift compositor, **before** the zoom transform, so that zooming into a blurred region does not reveal detail.

### D.5 UI

- Detection runs automatically after recording stops, showing progress.
- Detected regions appear as boxes in `Review.tsx` on a redaction track.
- User can: add a box, delete a box, extend a box's time range, and toggle "blur this region for the whole recording."
- **A prominent, unmissable count: "7 sensitive regions blurred."** The user must be able to see, at a glance, that the feature did something — and must be able to review it before export.

### D.6 Done when

- Record a dashboard with a table of names, emails, and account numbers. Every one is blurred, in every frame, including during scroll.
- Frame-by-frame scrub through the export finds **zero** leaked frames. Verify with an automated check: extract every frame, OCR each one, assert no pattern-layer match survives.
- Detection on a 2-minute recording completes in under 30s.
- No network request is made during detection. Verify with Little Snitch or `nettop`. This is a hard gate — it's the whole promise.

---

## 5. Sequencing and stop points

| Phase | Ships | Depends on | Stop-and-reassess if |
|---|---|---|---|
| A — Telemetry | Nothing visible | — | Click alignment > 1 frame |
| B — Synthetic cursor | Visible quality win | A | Cursor lag is perceptible |
| C — Auto-zoom | The headline feature | A, B | You'd turn it off on >3 of 10 of your own recordings |
| D — Redaction | The differentiator | Compositor from B | Any leaked frame, ever |

**Build the Swift compositor as part of B**, not as a separate phase. It's the vehicle for the cursor, and C and D bolt onto it. Prove the 15s/5-min save budget there before committing to C and D.

If you only ship one thing: **A + B.** A smooth cursor with no zoom is still better than what you have, and it de-risks everything else.

---

## 6. Open questions

1. **Cursor sprite.** Ship one arrow, or handle I-beam/pointer/resize states? Recommend one arrow for v1; revisit only if it looks wrong in practice.
2. **Zoom during webcam overlay.** Does the webcam bubble stay pinned to the frame (yes, probably) or to the zoomed content (almost certainly not)? Decide before building C.
3. **Redaction on the R2/Cloudflare share path.** The `/v/[id]` viewer serves the exported mp4, so redaction is already baked in by then — confirm there is no path where the *unredacted* scratch file can reach R2. Audit `exports.rs` and `linkedin.rs`. This is a real leak vector and worth an explicit check.
4. **Does `arnndn` still no-op on GIF?** Zoom and blur now mean GIF exports have video work too. Confirm the GIF path handles the compositor output.

---

## 7. What this does not include

- Windows/Linux. Still out of scope.
- Real-time zoom preview during recording. Post-only.
- Transcription, captions, filler-word removal. Tempting, and a plausible V4 — but each is its own project. Do not smuggle them in here.
- Team features, cloud accounts, collaboration.
