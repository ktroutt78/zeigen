# Zoom export rendering — Step 4 (NOT BUILT)

Status as of 2026-07-14. Captured before a context clear; this gap was not recorded anywhere.

## The gap

**Zooms currently exist ONLY in the Review preview and do NOT reach the exported mp4.** The
export path ignores the zoom track entirely. That is *why* the byte-identity / copy-path
invariant has held through all the zoom work (detection, suggestion, manual editing, the
Thread A conservative detector) — none of it touches export. **The whole zoom feature is
currently invisible outside the app.** A saved/exported recording has no zoom in it.

This is by design so far: detection and editing only write the sidecar `zoom` track, and
export reads it nowhere. Step 4 is where that changes and zoomed exports start paying a
re-encode.

## Prerequisites before Step 4 (already agreed — do these first)

1. **Restore the five dead stream-md5 guards.** They are `#[ignore]`d and cannot run because
   their May baseline recordings under `~/Movies/Zeigen/.scratch-baseline-c1/` are missing
   from this machine (dir confirmed absent 2026-07-14). A byte-identity guard that can't run
   isn't guarding — and Step 4 is exactly when real re-encoding starts, so these must be live
   before then. The five:
   - `save_recording_baseline` — `src-tauri/src/edit.rs`
   - `mp4_save_baseline` — `src-tauri/src/edit.rs`
   - `probe_audio_track_baseline` — `src-tauri/src/edit.rs`
   - `render_preview_audio_baseline` — `src-tauri/src/edit.rs`
   - `sprite_smoke` — `src-tauri/src/thumbs.rs`
   (See also DECISIONS.md 2026-07-13 "Known gap: five stream-md5 fixture guards are
   non-functional".)

2. **Flip the non-empty-zoom-track test to assert a RE-ENCODE, not a copy.** Today
   `empty_zoom_stays_on_video_copy_path` (`src-tauri/src/edit.rs:2045`) pins that *even a
   non-empty* zoom track still takes the `-c:v copy` fast path — correct only while export
   ignores zoom. Step 4 must flip that half to assert a re-encode. It is the deliberate
   tripwire: nobody reaches export rendering without consciously acknowledging that zoomed
   exports leave the fast path.

## The one real design decision (deferred): Swift compositor vs ffmpeg filter_complex

Pick how to render the zoom into the exported frames. Two known risks drive the choice:

- **Slow-pan stutter.** ffmpeg's `zoompan` works on integer pixel offsets and stutters on
  slow pans — and the 600ms ease ramps (`ZOOM_RAMP_S`) are exactly that case (a slow,
  sub-pixel-per-frame move). This is the same class of problem the B0 spike flagged.
- **Overlay ordering.** Content-anchored overlays (arrows, blur, spotlight) must zoom **WITH**
  the content; screen-anchored ones (webcam bubble, watermark) must **NOT** zoom. Getting
  both right in one graph is the constraint — and it may itself decide Swift-vs-ffmpeg (a
  Swift compositor has finer control over layer order and sub-pixel sampling than a
  `filter_complex` chain).

**Gate it the way B0 was gated:** pick an approach, **MEASURE it on a real slow-pan zoom**
(the 600ms ease ramp is the worst case), and only build on it if the pan is smooth. Do not
commit to an approach on paper.

## The encoder reality that makes this acceptable

Measured on this machine: **~500 MP/s** hardware encode. A 5-minute recording re-encodes in
**~29s at 1x**. Only *zoomed* recordings pay that cost — plain saves stay on `-c:v copy`
(the fast path the invariant protects). So the re-encode tax is opt-in per-recording, only
when a zoom is actually present, and fast enough to be acceptable.

## Where this sits in the plan

Step 4 is the export half of the zoom layer (`docs/ZOOM-LAYER-PLAN.md`). Detection (step 5)
was deliberately pulled ahead of it (DECISIONS.md 2026-07-13); the Thread A conservative
detector (`7e9e87c`) and Thread B manual-editing plan (`docs/ZOOM-MANUAL-EDITING-PLAN.md`)
both sit on the preview side. Step 4 is what finally makes zooms real in exported files.
