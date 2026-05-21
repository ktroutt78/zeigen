# Phase 13 — Timeline regressions — Plan

**Drafted:** 2026-05-20
**Status:** Ready to execute
**Source of truth for decisions:** `docs/PHASE-13-CONTEXT.md`

Three independent commits, ordered smallest-blast-radius first (Phase 12 precedent):

- **c1 — Timeline visibility CSS fix** (13.1). `src/Review.tsx` layout only. No backend, no component-API changes, no math. Smallest commit; independent of c2/c3.
- **c2 — ffprobe audio-track command** (13.2). New `#[tauri::command]` in `src-tauri/src/edit.rs` + registration in `src-tauri/src/lib.rs`. Pure Rust addition; no UI changes. Testable in isolation.
- **c3 — Waveform rescale using S** (13.3). `src/Review.tsx` fetch + thread props, `src/Waveform.tsx` mapping math. Consumes c2's command. Biggest commit of the phase.

Each commit is independent and self-verifying. c1 makes the timeline visible at all window heights; c2 exposes audio-track meta to the frontend; c3 uses that meta to align waveform peaks with the playhead.

---

## c1 — Timeline visibility CSS fix

`src/Review.tsx`. Layout only.

### Diagnosis (do this first)

Open the dev app, expand the review window to full-screen height with a recording loaded. Confirm the timeline row is below the viewport. Then in DevTools:

1. Walk up the DOM from the Timeline row to the Review root. Identify the flex container chain.
2. For each container in the chain, note its `flex`, `min-height`, `flex-shrink`, `overflow` properties.
3. Compare to the pre-Phase-11-c4 layout (commit `65dc026^`) — the regression diff is the source of truth for what changed.

The plan-doc placeholder for the actual fix follows; replace with the chosen approach during execution.

### Expected shape of the fix

Most likely: the video-pane container has an unconstrained `flex: 1` (or equivalent) that consumes all available vertical space at tall window heights, with no `min-height` on the timeline row to claim its share. Fix is one of:

- Add `flex-shrink: 0` + a fixed `min-height` (or `height`) on the Timeline container row.
- Cap the video pane with `max-height: calc(100% - <timeline-height>px)` so the timeline row reserves its space.
- Restructure the flex parent to make the timeline a fixed-size row and the video pane the flexible one (it's probably the inverse today).

Diagnosis output drives the exact change. The fix should be CSS-only — no React structure changes if possible.

### Done-when

- Open the review window at default size with a recording loaded → timeline visible, no change vs Phase 12.
- Expand the review window to full screen (or maximum tall height) → timeline still visible, with the video pane shrinking to make room rather than the timeline disappearing.
- Resize down again → timeline remains visible, layout stays stable.
- Smaller window heights work as before — workaround "shrink the window" is no longer necessary.

### Verification fixture

Manual: resize the review window across the height range during c1 verification. Confirm the timeline row never disappears.

---

## c2 — ffprobe audio-track command

`src-tauri/src/edit.rs` + `src-tauri/src/lib.rs`. Rust-only.

### Command shape

New public function + `#[tauri::command]` wrapper, alongside the existing private `probe_duration_seconds` and `probe_dimensions` helpers.

```rust
#[derive(Serialize, Debug)]
pub struct AudioTrackMeta {
    // start_time of the audio stream in seconds. 0.0 when the recording
    // has no leading audio gap; typically 30-650ms on Zeigen recordings
    // (mic startup latency).
    pub start: f64,
    // Duration of the audio stream in seconds. Strictly <= the video
    // duration because the last mic CMSampleBuffer reaches the writer
    // before the last video frame.
    pub duration: f64,
}

#[tauri::command]
pub fn probe_audio_track(source_path: String) -> Result<Option<AudioTrackMeta>, String> {
    let p = Path::new(&source_path);
    probe_audio_track_path(p)
}

pub(crate) fn probe_audio_track_path(path: &Path) -> Result<Option<AudioTrackMeta>, String> {
    let output = Command::new(FFPROBE_PATH)
        .args([
            "-v", "error",
            "-select_streams", "a:0",
            "-show_entries", "stream=start_time,duration",
            "-of", "csv=p=0",
        ])
        .arg(path)
        .output()
        .map_err(|e| format!("ffprobe audio-track failed: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "ffprobe audio-track non-zero for {}: {}",
            path.display(),
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    let s = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if s.is_empty() {
        // No audio stream in source — return None.
        return Ok(None);
    }
    // Output is "start_time,duration" e.g. "0.068000,8.832000".
    let mut parts = s.split(',');
    let start: f64 = parts.next()
        .ok_or_else(|| format!("ffprobe audio-track malformed: {s}"))?
        .parse()
        .map_err(|e| format!("parse start_time {s:?}: {e}"))?;
    let duration: f64 = parts.next()
        .ok_or_else(|| format!("ffprobe audio-track malformed: {s}"))?
        .parse()
        .map_err(|e| format!("parse duration {s:?}: {e}"))?;
    Ok(Some(AudioTrackMeta { start, duration }))
}
```

### Registration

In `src-tauri/src/lib.rs::invoke_handler![…]` (line ~583), add `edit::probe_audio_track` alongside the existing `edit::*` entries.

### Test

`#[ignore]` baseline test against the Phase 10 c1 scratch fixture, mirroring the `mp4_save_baseline` pattern. Verify:

- Returns `Some(meta)` with `start > 0` and `duration > 0` for the baseline (a recording known to have mic-startup gap).
- `duration` is strictly less than the video duration (use `probe_duration_seconds` for the V reference).
- `start` is within a sane range (0–1s).

```rust
#[test]
#[ignore]
fn probe_audio_track_baseline() {
    let home = std::env::var("HOME").unwrap();
    let source_str = format!(
        "{home}/Movies/Zeigen/.scratch-baseline-c1/recording-2026-05-19-114549/recording-2026-05-19-114549.mp4"
    );
    let source = Path::new(&source_str);
    assert!(source.exists(), "baseline source missing");

    let meta = probe_audio_track_path(source)
        .expect("probe")
        .expect("audio track present");
    let video_duration = probe_duration_seconds(source).expect("video duration");

    println!(
        "baseline: start={:.3}s duration={:.3}s (video={:.3}s, V-A={:.3}s)",
        meta.start, meta.duration, video_duration, video_duration - meta.duration
    );
    assert!(meta.start >= 0.0 && meta.start < 1.0, "start out of range: {}", meta.start);
    assert!(meta.duration > 0.0, "duration must be > 0");
    assert!(
        meta.duration < video_duration,
        "audio duration {} should be < video {}",
        meta.duration, video_duration
    );
}
```

### Done-when

- `cargo check` clean.
- `cargo test --lib probe_audio_track_baseline -- --ignored --nocapture` passes; printed numbers match what ffprobe-on-the-command-line reports for the same file.
- `tauri::invoke('probe_audio_track', { sourcePath: '/path/to/recording.mp4' })` from a quick DevTools console call (or a temporary frontend probe) returns `{ start, duration }` matching the same numbers.
- No-audio source (e.g. a screen-only-no-mic recording) returns `null`.

### Verification fixture

The Phase 10 c1 scratch baseline (`.scratch-baseline-c1/recording-2026-05-19-114549/`) is the canonical fixture for audio-meta tests. It's known to have a small mic-startup gap and audio shorter than video.

---

## c3 — Waveform rescale using S

`src/Review.tsx` + `src/Waveform.tsx`. Frontend only; consumes c2's command.

### Audio-meta fetch in Review

At review-open (the same effect that today loads sidecar / sprite / video metadata), add a call to the new command. Store `audioStart` in Review state. Reset to `null` on recording change.

```tsx
const [audioStart, setAudioStart] = useState<number | null>(null);
// ... in the effect that fires on sourcePath change:
useEffect(() => {
  if (!props.sourcePath) {
    setAudioStart(null);
    return;
  }
  let cancelled = false;
  invoke<{ start: number; duration: number } | null>("probe_audio_track", {
    sourcePath: props.sourcePath,
  })
    .then((meta) => {
      if (cancelled) return;
      setAudioStart(meta?.start ?? 0);
    })
    .catch(() => {
      if (!cancelled) setAudioStart(0);
    });
  return () => {
    cancelled = true;
  };
}, [props.sourcePath]);
```

Failures fall back to `audioStart = 0`, which gives the same broken behavior as today — acceptable as a fallback since the probe is best-effort.

### Prop threading

Timeline gains an `audioStart: number | null` prop forwarded from Review state. Waveform gains both `videoDuration: number | null` and `audioStart: number | null`. Existing `assetUrl` prop unchanged on Waveform; existing `duration` prop already exists on Timeline (rename references at call sites if needed for clarity).

### Render mapping change in Waveform

The bucketing pass over the decoded PCM is unchanged — it still produces `peaks: Float32Array(PEAK_CACHE_SIZE)` and `clipped: Uint8Array(PEAK_CACHE_SIZE)` representing the full audio content (audio-times `[0, A]`).

The per-pixel render loop changes. Today:

```ts
for (let x = 0; x < w; x++) {
  const startB = Math.floor((x / w) * PEAK_CACHE_SIZE);
  const endB = Math.max(startB + 1, Math.floor(((x + 1) / w) * PEAK_CACHE_SIZE));
  // ... draw bucket ...
}
```

After c3:

```ts
// videoDuration is V, audioStart is S, audioBuffer.duration is A.
// Pixel x represents video-time vt = (x/w) * V.
// Audio-time at vt is at = vt - S.
// Bucket index for at is floor((at / A) * PEAK_CACHE_SIZE).
// Pixels where at < 0 or at > A have no audio — skip them.

const xStart = Math.ceil((audioStart / videoDuration) * w);
const xEnd   = Math.floor(((audioStart + audioDuration) / videoDuration) * w);

for (let x = xStart; x < xEnd; x++) {
  const at = (x / w) * videoDuration - audioStart;
  const atNext = ((x + 1) / w) * videoDuration - audioStart;
  const startB = Math.floor((at / audioDuration) * PEAK_CACHE_SIZE);
  const endB = Math.max(startB + 1, Math.floor((atNext / audioDuration) * PEAK_CACHE_SIZE));
  // ... draw bucket (same fill logic as today) ...
}
```

`audioDuration` (A) is `audioBuffer.duration`, already available at render time. `videoDuration` (V) is the new prop. `audioStart` (S) is the new prop.

Edge cases:

- **`videoDuration == null` or `audioStart == null`**: render with today's mapping (`t = (x/w) * A`). This is the loading state — props arrive asynchronously, and the bug-equivalent fallback is preferred over a flicker.
- **`audioStart == 0` and `audioBuffer.duration == videoDuration`**: the new mapping degenerates to the old one. No visible difference. Verify with a synthetic test recording if one exists, otherwise trust the math.
- **`audioStart > videoDuration`**: shouldn't happen (would mean audio starts after the video ends). If observed, treat as `audioStart = 0` fallback.

### Playhead alignment

Unchanged — already correct. The playhead's `(t/V) × W` math is right. After c3, the waveform under the playhead represents audio-time `t − S`, which is the audio sample actually playing at video-time `t`. That's the fix.

### Clipping mask (Phase 12 c1) preservation

The per-pixel `clip` flag is computed by ORing `clipped[b]` for every bucket `b` the pixel covers — same code as today, just with the new bucket-index math. No special-case logic needed.

### Done-when

- Open the review window on a recording with a known mic-startup gap (e.g. the Phase 10 c1 scratch baseline). Confirm: waveform peaks line up with the playhead while the audio plays. Specifically — at any video-time `t > S` (audio playing), the bar under the playhead's pixel-x corresponds to the sound currently audible.
- Open a recording with `S ≈ 0` (no leading gap, if you can produce one). Waveform fills the canvas almost fully; old vs new mapping look near-identical.
- Open a recording with the worst-case `V−A` observed (644ms on the May 19 22:58 scratch, if still on disk). Waveform peaks visibly shifted from where they would have been under the old mapping; alignment with playhead now correct.
- Open a screen-only-no-mic recording. Waveform renders empty (no `assetUrl`-resolved audio); existing empty-state handles this.
- Clipping highlight (amber bars) still appears at the correct positions, now under the corrected mapping.
- Trim handles + dimmed regions unchanged.
- Resize the review window during playback. Waveform redraws correctly at every width (the new mapping is width-relative, not pixel-absolute).

### Verification fixture

Three test recordings during c3 verification:

1. The Phase 10 c1 scratch baseline (`recording-2026-05-19-114549`) — a known case where alignment used to drift.
2. A fresh short recording made today — typical mic-startup gap (~50-200ms).
3. Optionally: a recording with intentionally long mic startup if you can produce one (e.g. plug in a USB mic mid-recording, or pick a slow-to-init device).

In each, play through the recording with the timeline visible and confirm the bar under the playhead corresponds to the sound at that moment (test by clipping or shouting at a specific point and watching the amber bar pass through the playhead).

---

## Phase done-when

- Review window timeline is visible at every window height (c1 verified).
- Audio-track meta is fetchable from the frontend via `probe_audio_track` (c2 verified).
- Waveform peaks align with the playhead during playback, across recordings spanning the V−A range observed (c3 verified).
- No regression in clipping highlight, trim overlays, or any other Waveform behavior carried in from Phase 10 / 12.
- Saved MP4 files are unchanged byte-for-byte (Phase 12 invariants preserved).

## Out of plan (deferred, captured here for traceability)

- Backend audio-pad on save (path a) — eliminates V/S logic entirely but changes file size and pipeline shape. See CONTEXT D-04.
- MP4 atom parse in JS — alternative to the Rust ffprobe command. Rejected for added JS-side complexity.
- Engine-side fix for mic startup gap — would address V−A at the source. Out of scope for a frontend regression fix; likely impossible without sample loss.
- Real-time waveform during capture — different feature class.
- Persistent caching of audio-track meta across review-opens — premature optimization.

All covered in PHASE-13-CONTEXT.md §"Deferred Ideas."

---

*Phase: 13-timeline-regressions*
*Plan drafted: 2026-05-20*
