# Zoom Layer — click/zoom as an editable export-time layer

**Status (2026-07-13): steps 1-3 done (step 1 `66dc91f`; step 2 `8fb58ae`; step 3 `4de72c4`); step 5 v1 done (`5ab570f`) and judged same day — 24/28 keep-worthy on the first real demo recording, every miss "too eager" never "wrong place", fixed-hold confirmed (zero center-tracking requests). NEXT: detection tuning session — implement the six-fix spec in `DECISIONS.md` 2026-07-13 against both pinned telemetry fixtures, judge with a fresh-recording eyeball pass. Step 4 export rendering after that. REORDERED (owner, 2026-07-13): step 5 detection runs before step 4 export rendering — detection is the feature, manual zoom editing is cleanup and its UX stays intentionally basic. v1 detection ships behind an explicit "Suggest zooms" button — auto-run at review-open is decided only once the detector is trusted, because after step 4 an auto-written track would silently move saves off the copy path.**

Revives V3 Phase C (auto-zoom) in a shape that honors the 2026-07-11 encoder-floor pivot instead of fighting it. Read alongside `V3-PLAN.md` (Phase A telemetry spec §1, Phase C heuristic §3 — both reused here) and `DECISIONS.md` 2026-07-13.

## The model

Record normally — raw video untouched, saves stay on the video-copy path. The app SUGGESTS zoom moments from the cursor-telemetry interaction track. The user EDITS them on a timeline track (delete/adjust/add). Zoom is applied only at EXPORT.

**Governing invariant: wipe the zoom layer = today's app.** An empty zoom track serializes to *absent* in the sidecar (the E1 roundness `None`-normalizes-to-absent convention), so a no-zoom recording produces a sidecar indistinguishable from today's and rides the existing `mp4_video_can_copy` path and guards (`save_recording_baseline` stream-md5, pinned arg vectors). The layer can only add; it can never break the plain path. The first save that ever re-encodes video is the first save with a non-empty zoom track.

## Owner decisions (2026-07-13)

1. **Burned-in cursor scales with zoom at <=2.5x: ACCEPTED.** The synthetic cursor is deliberately traded away for the byte-identity and simplicity of the layer model. Eyeball a 2.5x zoom on a real recording during step 3/4 to confirm it reads acceptably; the trade stands regardless.
2. **Swift-vs-ffmpeg export rendering: DEFERRED to step 4, gated like B.0.** Pick an approach, MEASURE it on a real slow-pan zoom for stutter, and only build on it if it is smooth. Do not decide earlier. The overlay-ordering constraint — content-anchored annotations (arrow/blur/spotlight) zoom with the frame; screen-anchored bubble/watermark do not — is part of that step's design.
3. **GIF: MP4-only for v1.** Add GIF zoom later if missed.

## Foundations already in hand (scoped 2026-07-13)

- **Phase A telemetry (commit `ac4cfb5`, dormant)** is the interaction track. 120 Hz cursor positions in video pixel space; click events with position and timestamp on the gapless output timeline (same basis as `annotation.start_time`); scroll presence (no dy — sufficient, the heuristic only needs "scrolling -> hold zoom"); pause-aware; alignment proven <=8 ms offset, ~2.6 ms/min drift. Nothing detection needs is missing. **One gap:** `capture_cursor: true` currently also sets `showsCursor = false`. Step 1 decouples them — telemetry on, cursor stays burned in, video byte-identity holds by construction; the only new artifact is the hidden `.cursor.json` sidecar. Recordings made before the flip have no track (manual zoom still works; suggestions just won't appear).
- **B.0 compositor spike:** proved the physics — Core Image transform/blur stages are free (+-0.1s); the 106s failure was 100% VideoToolbox encode. A zoom is exactly the placeholder transform it rendered, driven by interpolated keyframes. **The code is gone (discarded, never committed)** — rendering is a rebuild from its durable measurements, not a resurrection. The recorded quality argument stands: ffmpeg `zoompan` uses integer pixel offsets and stutters on slow pans; hence the step-4 measured gate.
- **Cost model (holds):** plain saves = video `-c:v copy` + always-on audio arnndn pass (0.85s at 30s -> 5.7s at 5 min); byte-identity is video-stream identity — both already true today. Zoomed exports pay the measured encoder floor: ~29s per 5 min at 1x full res (all recordings are 1x per the `SCDisplay` points finding), ~12s for a 2-min demo, ~16s at a 720p downscale. Linear in output pixels; quality settings don't move it.
- **Review.tsx annotation pips (`Review.tsx` ~3911)** already implement time-bounded segments on the timeline: dot drags the whole window preserving duration; selection shows a band with two edge handles for independent start/end resize; persists through the debounced sidecar save. The queued annotation-duration timeline is largely shipped — step 3 is extraction and generalization, not new construction.

## Build order — each step its own session

### Step 1 — Decouple telemetry from cursor-hiding; flip it on

Engine/IPC change so telemetry can run with `showsCursor` untouched (today `capture_cursor: true` forces the cursor out of the pixels — the layer model wants the opposite). App flips telemetry on for every recording. Provably inert to saves: video path untouched, new `.cursor.json` sidecar only. Do this first so real recordings accumulate tracks for step-5 tuning.

**Done when:** a recording writes `.cursor.json` with the cursor still visible in the pixels, and the plain save path is unchanged (existing guards green).

### Step 2 — Sidecar zoom track + byte-identity guards

`SidecarState` zoom track per the V3-PLAN C.2 sketch (`ZoomKeyframe { t, scale, center_x, center_y, ease }`, `t` on the original timeline like `annotation.start_time`, `auto_generated` flag so regeneration never stomps manual edits). Empty track serializes to absent. Extend the baseline guards so absent-track saves are pinned identical.

**Done when:** a sidecar round-trips the track; an empty/wiped track produces a byte-identical sidecar and the video-copy path, asserted by tests.

### Step 3 — Overlay-timeline extraction + manual zoom editing + live preview

Extract the annotation pip/band/handle machinery into a generic track component (segments of `{start, end, payload}`; drag, resize, delete, add). Render zoom as a second track row. Zoom-specific UI: scale control + center picker on the video stage. Live preview via CSS transform on the `<video>` (scale+translate interpolated from keyframes at the playhead — near-free, exact by the same arithmetic-parity argument E1 used). Migrate annotation pips onto the shared component — **this delivers the queued annotation-duration timeline feature as a side effect.** Build the overlay-timeline system once, not twice.

**Done when:** manual zoom segments can be added/adjusted/deleted on the timeline, preview matches the keyframe math, annotations ride the same component with no behavior change, and edits survive save/reload.

### Step 4 — Export rendering, behind a measured gate

**Prerequisite:** restore the five non-functional stream-md5 fixture guards first (`DECISIONS.md` 2026-07-13 known-gap entry) — step 4 introduces real video re-encoding, and `save_recording_baseline` is the guard that catches the copy path accidentally falling through to a re-encode.

The one open design. Candidates: rebuild the Swift pass (quality proven by B.0, code must be rebuilt; must solve where it slots against the existing ffmpeg pass without double-encoding) vs express zoom inside the existing `filter_complex` single pass (no new stack; known integer-offset stutter risk on the 600ms ease ramps). **Gate (B.0-style): render a real slow-pan zoom, measure/eyeball for stutter, build only on a smooth result.** Design must also cover: overlay ordering (content-anchored zooms with the frame, screen-anchored bubble/watermark do not — this constraint may itself decide the approach); trim interplay (`ann.start_time - trim_in` pattern at `edit.rs:1123`); a preview-vs-export parity check so the watermark-opacity gap (DECISIONS.md 2026-07-13) is not repeated. MP4-only (decision 3).

**Done when:** the gate passes and a zoomed export matches the step-3 preview; a no-zoom export remains on the copy path.

### Step 5 — Suggestion detection, last

Pure function from `.cursor.json` to a suggested segment list, run at review-open, written with `auto_generated: true`. The heuristic is V3-PLAN §3 C.1, unchanged: dwell (>800ms within ~150px), click (strong zoom-in), travel (zoom out), scroll (hold); calm rules — 1.2s minimum between changes, 2.5x cap, 600ms ease-in-out cubic, stay wide when in doubt. Tune against the telemetry accumulated since step 1.

**Done when:** the C.4 subjective gate — watch ten real recordings; if zoom should be off on more than three, retune before shipping.

## Out of scope

- GIF zoom (decision 3 — later if missed).
- Synthetic cursor (decision 1 — traded away).
- Real-time zoom preview during recording. Post-only, as ever.
- Curve editor. Drag, resize, delete, add — nothing more.
