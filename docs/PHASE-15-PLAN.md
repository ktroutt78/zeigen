# Phase 15 — Deferred composite — dual-stream review preview — Plan

**Drafted:** 2026-06-02
**Status:** Ready to execute
**Source of truth for decisions:** `docs/PHASE-15-CONTEXT.md`

Three commits, ordered smallest-blast-radius first (Phase 12 / Phase 13 / Phase 14 precedent):

- **c1 — Webcam segment concat at finalize.** Adds a single ffmpeg stream-copy invocation in `recording_finalize`. Produces `webcam.mp4` alongside the existing segments. Existing composite still runs unchanged. Zero observable behavior change for the user — pure setup for c2/c3. Tiny PR.
- **c2 — Composite extraction + export pipeline.** Factor the composite's filter-builder out of `composite::composite` so `run_edit_pipeline` can call it. Rewrite `run_edit_pipeline` to take screen + webcam paths + segments and run composite + trim + annotations as a single ffmpeg invocation. All four export paths (Save, Copy, LinkedIn, GIF) flow through it. Finalize composite STILL runs (the old composited file stays in scratch); review still opens against it. Half-step — exports now go through the new path even though the saved-file route hasn't yet eliminated the finalize composite. The byte-stability baseline test from D-06 lands here.
- **c3 — Cut over: defer composite to export, dual-stream review player.** Remove the composite call from `recording_finalize`. Update `FinalizedRecording` payload. Rewrite Review.tsx for dual-stream playback with screen-master / webcam-slave sync + CSS bubble positioning. Repoint NR preview at `screen.mp4` → `preview-screen.mp4`. Repoint scrub thumbnail extraction at `screen.mp4`. Where the user-visible win lands.

Each commit is independent and self-verifying. c1 sets up the file the player needs. c2 derisks the export path (any export-pipeline regression surfaces while the old composited file is still being produced as a sanity check). c3 makes the cut.

**Could collapse c2 + c3 into one commit if planning prefers a single atomic switchover.** Three-commit version is the safer cut.

---

## c1 — Webcam segment concat at finalize

`src-tauri/src/lib.rs` (primary). Possibly tiny helper in `composite.rs` or a new `src-tauri/src/concat.rs` — keep it inline in `lib.rs::recording_finalize` if the call site is the only consumer.

### File region

- `recording_finalize` at `src-tauri/src/lib.rs:337-406`. Specifically inside the `if let Some(mut webcam) = webcam_opt` branch (line 356-387), after `segments = webcam.segments().to_vec()` and BEFORE `composite::composite(...)` is called.

### Implementation

Add the concat call inside the webcam branch. Write the concat list to a temp file in `sources_dir`, invoke ffmpeg with `-f concat -safe 0 -i list.txt -c copy`, then clean up the list file.

```rust
// Concat webcam segments into a single playable webcam.mp4 in sources_dir.
// Stream-copy — sub-second even for 12 min recordings. The composited mp4
// (still produced below for now) doesn't consume webcam.mp4; this file is
// for the Phase 15 c3 dual-stream player.
let webcam_path = sources_dir.join("webcam.mp4");
{
    let list_path = sources_dir.join("webcam-segments.txt");
    let list_body: String = segments
        .iter()
        .map(|p| format!("file '{}'\n", p.to_string_lossy().replace('\'', "'\\''")))
        .collect();
    std::fs::write(&list_path, list_body)
        .map_err(|e| format!("write webcam concat list: {e}"))?;

    let out = std::process::Command::new(FFMPEG_PATH)
        .args([
            OsStr::new("-y"),
            OsStr::new("-hide_banner"),
            OsStr::new("-nostats"),
            OsStr::new("-f"), OsStr::new("concat"),
            OsStr::new("-safe"), OsStr::new("0"),
            OsStr::new("-i"), list_path.as_os_str(),
            OsStr::new("-c"), OsStr::new("copy"),
            webcam_path.as_os_str(),
        ])
        .output()
        .map_err(|e| format!("spawn webcam concat ffmpeg: {e}"))?;

    let _ = std::fs::remove_file(&list_path);

    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!(
            "webcam concat failed (exit {:?}):\n{}",
            out.status.code(),
            stderr.lines().rev().take(20).collect::<Vec<_>>()
                .into_iter().rev().collect::<Vec<_>>().join("\n")
        ));
    }
}
```

`FFMPEG_PATH` is whatever symbol the file already uses (check `composite.rs` for the exact identifier and import shape). The `replace('\'', "'\\''")` guards the rare case where a scratch path has a single-quote — defensive against pathological filenames, costless.

**Don't add to `FinalizedRecording` payload yet** — c3 does the payload change. c1 produces the file on disk; no frontend reads it.

### Test

Test happens via real recording. No new `#[ignore]` baseline test for c1 — the concat is a single stream-copy with a deterministic shape; if it ever breaks, c3's player will surface it immediately.

### Done-when

- Make a recording with a webcam selected. After Stop, `~/Movies/Zeigen/.scratch/recording-<stamp>/sources/webcam.mp4` exists alongside the per-segment `webcam-NN.mp4` files.
- Open `webcam.mp4` in QuickTime — plays cleanly across all segment boundaries, no glitches at segment joins, duration matches the sum of segment durations.
- `ls` the sources dir — no leftover `webcam-segments.txt` file (cleaned up post-concat).
- Composite still runs and produces the scratch mp4 as before. Review window opens normally. No user-visible change.
- For a single-segment recording (short take, just one segment), concat produces a valid `webcam.mp4` (concat demuxer with N=1 is a no-op stream copy — verify the output isn't malformed).
- For a screen-only recording (no webcam), no `webcam.mp4` is produced and no error fires (the concat branch is inside the webcam-present branch).

### Verification fixture

A 30-second test recording with the built-in webcam selected, plus a 30-second screen-only recording. Both verify the branch logic.

---

## c2 — Composite extraction + export pipeline

`src-tauri/src/composite.rs` + `src-tauri/src/edit.rs` (rewrite `run_edit_pipeline`). Tests touch `src-tauri/src/edit.rs::tests`.

### File region

- `src-tauri/src/composite.rs:305-630` (`composite()`) — extract the filter-builder portion (lines ~407-543) into a public helper. Keep the existing `composite()` function as a thin wrapper that uses the helper.
- `src-tauri/src/edit.rs:619-837` (`run_edit_pipeline`) — rewrite to take screen + webcam + segments and call the composite filter-builder helper.
- `src-tauri/src/edit.rs::save_recording`, `clipboard_copy_recording`, `linkedin_export`, GIF export entry — call sites that pass the new args through.

### Composite filter-builder extraction (D-06)

Extract a public helper from `composite::composite`. Suggested shape:

```rust
pub struct CompositeFilter {
    /// ffmpeg input args (the `-i …` sequence and any `-itsoffset` /
    /// `-loop` flags) for screen + webcam segments + mask.
    pub input_args: Vec<String>,
    /// The complete -filter_complex value, ending in `[outv]` for video
    /// and assuming `1:a?` is the audio map (audio_shift'd screen).
    pub filter: String,
    /// PNG mask path that must be written before ffmpeg runs.
    pub mask_path: PathBuf,
    /// Target diameter used in the scale filter (for callers that need
    /// to know what was picked).
    pub target_diameter: u32,
    /// Audio offset applied via -itsoffset on input 1 (informational).
    pub audio_shift: f64,
}

pub fn build_composite_filter(
    screen_path: &Path,
    webcam_segments: &[PathBuf],
    output_dir: &Path,
    size: WebcamSize,
    corner: Corner,
    bubble_position_log: &[BubblePositionEntry],
) -> Result<CompositeFilter, String> {
    // … existing logic from composite.rs:317-543 …
}
```

`composite::composite` becomes:

```rust
pub fn composite(/* unchanged args */) -> Result<(), String> {
    let cf = build_composite_filter(
        screen_path, webcam_segments,
        output_path.parent().ok_or("output path has no parent")?,
        size, corner, bubble_position_log,
    )?;
    render_alpha_mask(cf.target_diameter, &cf.mask_path)?;

    let mut args = cf.input_args;
    args.extend([
        "-filter_complex".into(), cf.filter,
        "-map".into(), "[outv]".into(),
        "-map".into(), "1:a?".into(),
        "-c:v".into(), "h264_videotoolbox".into(),
        "-b:v".into(), "8M".into(),
        "-c:a".into(), "copy".into(),
        output_path.to_string_lossy().into_owned(),
    ]);
    args.insert(0, "-progress".into());
    args.insert(1, "pipe:1".into());
    // … existing spawn / progress / wait logic from composite.rs:565-630 …
}
```

The mask-render call lifts to the caller (both `composite()` and `run_edit_pipeline` call it after `build_composite_filter`). Or fold it into `build_composite_filter` itself — Claude's discretion at implementation time.

### run_edit_pipeline rewrite (D-06)

New signature:

```rust
pub fn run_edit_pipeline(
    screen_path: &Path,
    webcam_path: Option<&Path>,
    webcam_segments: &[PathBuf],
    sidecar: &SidecarState,
    size: WebcamSize,
    corner: Corner,
    bubble_position_log: &[BubblePositionEntry],
    spec: &ExportSpec,
    output_path: &Path,
) -> Result<(), String> {
    // 1. If webcam_segments is empty, this is a screen-only recording —
    //    build the filter graph WITHOUT composite (just trim + annotations
    //    on screen_path's video). Path matches current behavior.
    // 2. Otherwise, call build_composite_filter, then APPEND trim and
    //    annotation filters to cf.filter (chaining off the composite's
    //    [outv] tag). The final output label after trim/annotation chain
    //    becomes the new -map target.
    // 3. Single ffmpeg invocation. Same h264_videotoolbox encoder, same
    //    bitrate (or spec-driven for LinkedIn / format-driven for GIF).
}
```

Filter graph chaining for trim + annotations:

```
… composite filter producing [outv_composite] …
[outv_composite] trim=start=…:end=…, setpts=PTS-STARTPTS [outv_trim];
[outv_trim] drawtext=text=…:enable='between(t,…,…)' [outv_text];
[outv_text] [overlay_in_a] overlay=…:enable='between(t,…,…)' [outv]
```

(Existing annotation filter logic from `run_edit_pipeline` lifts intact — only the input label changes from the raw input to the composite's output label.)

Audio: the composite already maps `1:a?` (audio-shift'd screen). Trim on audio uses `atrim=start=…:end=…,asetpts=PTS-STARTPTS`. Annotations don't touch audio.

GIF export is a special-case at the end of the filter chain (palette pipeline) — keep that path's existing shape and feed it the post-composite `[outv]` instead of the raw input.

### All four export callers updated

**`save_recording`** (`edit.rs`) — was taking `source_path: String` (the composited scratch path). Now takes `screen_path` + `webcam_path` + `segments` from the sidecar dir context. The function already locates the sidecar; extend it to locate the webcam paths from the same scratch dir.

**`clipboard_copy_recording`** (`lib.rs`) — same payload extension. The temp copy in `~/Library/Caches/com.zeigen.app/exports/` becomes the composite output, not a copy of the source.

**`linkedin_export`** (`lib.rs`) — same. Already runs the transcode; now runs composite + transcode in one pass.

**GIF export** (review-window Quick Export, `Review.tsx`) — same. Calls `run_edit_pipeline` with GIF spec.

### Test — composite output byte-stability baseline (D-06)

Critical. Phase 15 must NOT change saved-file bytes for the same inputs and sidecar state. Test:

```rust
#[test]
#[ignore]
fn run_edit_pipeline_byte_stable_vs_phase_14() {
    // Fixture: a known scratch dir from Phase 14 baseline with screen.mp4,
    // webcam segments, sidecar, and the saved final.mp4 produced by Phase
    // 14's pipeline.
    let fixture = Path::new(/* baseline path */);
    let screen = fixture.join("sources/screen.mp4");
    let segments: Vec<PathBuf> = /* enumerate webcam-NN.mp4 from sources/ */;
    let sidecar = edit::read_sidecar_path(&fixture.join("recording.mp4"))
        .expect("sidecar").expect("sidecar present");

    let out = std::env::temp_dir().join("phase15-bytestable-test.mp4");
    let _ = std::fs::remove_file(&out);

    edit::run_edit_pipeline(
        &screen,
        Some(&fixture.join("sources/webcam.mp4")),
        &segments,
        &sidecar,
        /* size */ WebcamSize::Large,
        /* corner */ Corner::BottomRight,
        &sidecar.bubble_position_log,
        &ExportSpec::default_mp4(),
        &out,
    ).expect("run edit pipeline");

    let baseline = fixture.join("expected-phase14-save.mp4");
    // h264_videotoolbox isn't bit-deterministic across hardware, so use a
    // looser equivalence: same duration + same video stream md5 of decoded
    // frames + same audio stream md5.
    let dur_a = probe_duration_seconds(&out).expect("dur out");
    let dur_b = probe_duration_seconds(&baseline).expect("dur baseline");
    assert!((dur_a - dur_b).abs() < 0.05, "duration mismatch");
    // … md5 comparison via ffmpeg's `-f md5` or framehash demuxer …
}
```

Decoded-frame md5 is the strict-but-realistic guarantee (hardware encoders can produce non-bit-identical bitstreams from the same input due to internal scheduling; decoded pixels are stable).

### Done-when

- `composite::composite` still produces the same scratch composited file at finalize as Phase 14 did (unchanged behavior).
- A Save export of a recording produces a file with the same duration, decoded-video md5, and decoded-audio md5 as the same recording would have produced under Phase 14. (The byte-stability baseline test passes.)
- Copy to Clipboard produces a temp file in the exports cache with the same parity guarantee.
- LinkedIn Export produces `~/Movies/Zeigen/recording-<stamp>-linkedin.mp4` with the same parity guarantee.
- GIF export produces a GIF with the same visual content as Phase 14 produced (visual diff, not md5 — palette quantization is non-deterministic).
- For a recording with no webcam, all four exports skip the composite path and produce identical output to Phase 14 (no regression in the no-bubble case).
- Annotation render at export still works (text + arrow overlays appear at the right times). Verify with a recording carrying both an annotation and a bubble.
- Trim works (in/out clamped to the trimmed range). Verify with a recording trimmed to a sub-segment.

### Verification fixture

One scratch dir saved aside before Phase 15 starts as the byte-stability baseline. Suggest: make a 30-second recording with the bubble dragged mid-take + one text annotation + a trim. Save it via Phase 14 to produce `expected-phase14-save.mp4`. Stash the full scratch dir (sources + sidecar) somewhere outside `.scratch/` (which gets swept) — e.g., `~/Movies/Zeigen/.phase15-baseline/`. The c2 test runs against this fixture.

---

## c3 — Cut over: defer composite + dual-stream review player

`src-tauri/src/lib.rs` + `src-tauri/src/edit.rs` (one-line preview source change) + `src/App.tsx` + `src/Review.tsx` + new `src/lib/bubble.ts`.

### Backend cut

**`src-tauri/src/lib.rs:337-406` (`recording_finalize`)** — remove the `composite::composite(...)` call (line 373-383). Keep the concat call (c1). Keep the sidecar write.

`FinalizedRecording` payload extension (`lib.rs:408-416`):

```rust
#[derive(serde::Serialize)]
struct FinalizedRecording {
    stamp: String,
    scratch_dir: String,
    /// Path to screen.mp4 in sources_dir. Always present.
    screen_path: String,
    /// Path to webcam.mp4 (concat'd at finalize, c1). None for
    /// screen-only recordings.
    webcam_path: Option<String>,
    sources_dir: Option<String>,
    webcam_segments: Vec<String>,
    /// Constant from composite::WEBCAM_LEAD_MS, surfaced so the
    /// dual-stream player can offset webcam.currentTime to match.
    webcam_lead_ms: f64,
    // `scratch_mp4_path` and `composited` REMOVED — no composited file
    // exists at finalize anymore. Review opens against screen_path
    // (or preview-screen.mp4 once render_preview_audio completes).
}
```

Construction in `recording_finalize` updates accordingly. The return-payload diff is small but load-bearing — the frontend uses `screen_path` and `webcam_path` to open review.

### NR preview repoint (D-05)

**`src-tauri/src/edit.rs:268-310`** — `render_preview_audio` and `preview_path_for`:

- `preview_path_for(source)` returns `source.parent().map(|p| p.join("preview-screen.mp4"))` (was `preview.mp4`).
- The function body is unchanged — same `arnndn` + AAC + video copy invocation. It operates on whatever path the caller passes, which becomes `screen.mp4`.

**`src/Review.tsx:413`** — change `invoke<string>("render_preview_audio", { sourcePath })` to pass `screenPath` (the new prop from the finalize payload). The `previewState.url` then points at `preview-screen.mp4`, which becomes the `<video src>` for the SCREEN element (not the only video).

### Scrub thumbnail repoint (D-10)

`extract_thumb_sprite` is called from `src/ScrubPreview.tsx:50` with the source path. Change the caller to pass `screenPath` (not the composited path that no longer exists). Backend function shape is unchanged.

### Frontend cut — payload propagation

**`src/App.tsx:867-896`** — stopped event handler. The finalize result shape changes. Adapter:

```ts
const result = await invoke<FinalizedRecording>("recording_finalize");
// ... existing trim handling …
await openReview({
  screenPath: result.screen_path,
  webcamPath: result.webcam_path,
  webcamLeadMs: result.webcam_lead_ms,
  stamp: result.stamp,
  scratchDir: result.scratch_dir,
});
```

**`src/App.tsx:659-685` (`openReview`)** — pass the new fields through the review window's query/state. The review window receives them on mount.

### Dual-stream player (D-03)

**`src/Review.tsx`** — top-level video region (current single-video at ~860-930) becomes:

```tsx
const screenRef = useRef<HTMLVideoElement>(null);
const webcamRef = useRef<HTMLVideoElement>(null);
const swapRestoreTimeRef = useRef<number | null>(null);
const LEAD_S = props.webcamLeadMs / 1000;

// Screen-master / webcam-slave sync. Webcam is offset by LEAD_S so the
// bubble's first frame freezes during the camera-start lag (matches
// composite's tpad=start_mode=clone behavior).
function syncWebcamToScreen() {
  const s = screenRef.current;
  const w = webcamRef.current;
  if (!s || !w) return;
  const target = Math.max(0, s.currentTime - LEAD_S);
  if (Math.abs(w.currentTime - target) > 0.05) {
    w.currentTime = target;
  }
}

useEffect(() => {
  const s = screenRef.current;
  const w = webcamRef.current;
  if (!s || !w) return;

  const onTimeUpdate = () => syncWebcamToScreen();
  const onPlay = () => { w.play().catch(() => {}); };
  const onPause = () => { w.pause(); };
  const onSeeking = () => { w.pause(); };
  const onSeeked = () => {
    syncWebcamToScreen();
    if (!s.paused) w.play().catch(() => {});
  };
  const onRateChange = () => { w.playbackRate = s.playbackRate; };

  s.addEventListener("timeupdate", onTimeUpdate);
  s.addEventListener("play", onPlay);
  s.addEventListener("pause", onPause);
  s.addEventListener("seeking", onSeeking);
  s.addEventListener("seeked", onSeeked);
  s.addEventListener("ratechange", onRateChange);
  return () => {
    s.removeEventListener("timeupdate", onTimeUpdate);
    s.removeEventListener("play", onPlay);
    s.removeEventListener("pause", onPause);
    s.removeEventListener("seeking", onSeeking);
    s.removeEventListener("seeked", onSeeked);
    s.removeEventListener("ratechange", onRateChange);
  };
}, [LEAD_S]);

// Bubble CSS position interpolated each render from the position log
// (D-04). At ~60fps this is cheap; if it costs anything visible, throttle
// to timeupdate (every ~250ms) instead.
const [currentTime, setCurrentTime] = useState(0);
useEffect(() => {
  const s = screenRef.current;
  if (!s) return;
  let raf = 0;
  const tick = () => {
    setCurrentTime(s.currentTime);
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(raf);
}, []);

const bubble = useMemo(
  () => bubblePositionAt(bubblePositionLog, currentTime),
  [bubblePositionLog, currentTime],
);
```

Render:

```tsx
<div className="canvas" style={{ position: "relative" }}>
  <video
    ref={screenRef}
    src={screenPlaybackUrl /* preview-screen.mp4 once ready, else screen.mp4 */}
    style={{ width: "100%", height: "100%", display: "block" }}
    onLoadedMetadata={() => { /* existing duration capture */ }}
  />
  {webcamUrl && bubble && (
    <video
      ref={webcamRef}
      src={webcamUrl}
      muted
      style={{
        position: "absolute",
        left: `${bubble.x * 100}%`,
        top: `${bubble.y * 100}%`,
        width: `${bubble.diameterCssPx}px`,
        height: `${bubble.diameterCssPx}px`,
        transform: "translate(-50%, -50%) scaleX(-1)",
        borderRadius: "50%",
        objectFit: "cover",
        pointerEvents: "none",
      }}
    />
  )}
</div>
```

`screenPlaybackUrl` is the existing `playbackUrl` memo (lines 439-442) — preview-screen.mp4 when ready, raw screen.mp4 otherwise. `webcamUrl` is `convertFileSrc(props.webcamPath)` if `props.webcamPath` exists, else `null`. `webcam` element is muted (audio lives on the screen track).

### Bubble interpolation helper (D-04)

New file `src/lib/bubble.ts`:

```ts
// Mirror of composite.rs::simplify_position_log + inline expression
// builder. x/y in [0..1] normalized coords of the screen frame; diameter
// in physical pixels (sidecar units).

export type BubbleEntry = {
  t: number;
  x: number;
  y: number;
  diameter?: number | null;
};

export type BubbleSample = {
  x: number;
  y: number;
  diameterPhysical: number;
  diameterCssPx: number;
};

const SIMPLIFY_EPS = 0.005; // matches composite.rs simplify_position_log

export function simplifyLog(log: BubbleEntry[]): BubbleEntry[] {
  // Drop entries whose x/y differ from the prior by < SIMPLIFY_EPS.
  // Preserve first and last. Match composite.rs exactly.
  // …
}

export function bubblePositionAt(
  log: BubbleEntry[],
  t: number,
  screenScalePx: number, // physical-px-per-css-px ratio of the screen video
): BubbleSample | null {
  if (log.length === 0) return null;
  const simplified = simplifyLog(log);
  // Walk simplified to find the segment containing t. Linear interpolate
  // x/y. Use first-entry diameter for the whole recording (matches
  // composite.rs:324-328).
  // …
  const diameterPhysical = simplified[0].diameter ?? DEFAULT_DIAMETER_PX;
  return {
    x, // normalized [0..1]
    y, // normalized [0..1]
    diameterPhysical,
    diameterCssPx: diameterPhysical / screenScalePx,
  };
}
```

`screenScalePx` = `screenRef.current.videoWidth / screenRef.current.clientWidth` (or equivalent — verify the screen video element's natural-vs-rendered ratio). `DEFAULT_DIAMETER_PX` mirrors the legacy `WebcamSize` default if `bubble_position_log[0].diameter` is missing (old sidecars).

Port `simplifyLog` line-for-line from `composite.rs::simplify_position_log` (which the Read step hasn't fetched — pull during implementation). The simplification matters for keyframe-dense recordings where consecutive samples are within the noise floor.

### Done-when

**Latency (the win):**
- Stop a 12-min recording. Review window opens within 2 seconds. (Was: ~2-3 min in Phase 14.)
- Stop a 30-second recording. Review opens within 1 second.
- Stop a screen-only-no-webcam recording. Review opens within 1 second — single-stream path, no dual-video setup overhead.

**Dual-stream parity:**
- Bubble appears in the review preview at the same position it appears in the saved file (verify by saving and comparing). Subpixel differences acceptable; obvious offset bugs not.
- Bubble follows its keyframe path during playback — drag the bubble mid-recording, the review preview shows the same drag path the saved file does.
- For the camera-start lag (first ~280ms), the bubble shows its first frame frozen in the preview, matching the composite's `tpad start_mode=clone` behavior.
- Webcam audio is silent in preview (`muted` attribute) — all audio comes from the screen track.
- Screen-only recording shows no bubble element (the conditional render gates on `webcamUrl && bubble`).

**Sync stability:**
- Play a 5-minute recording all the way through. No visible drift between screen and bubble at the end.
- Seek to 0:30, 1:45, 3:20, 4:50 in rapid succession. Bubble snaps to the right position at each seek target.
- Toggle play/pause rapidly. Webcam pauses with screen, resumes with screen. No "webcam keeps playing while screen is paused" bug.
- Set `playbackRate` to 0.5 / 2.0 (if review UI exposes this). Webcam follows.

**NR preview parity (Phase 14 c2 invariant preserved):**
- Open a recording with audible noise. The NR-preview pip appears, then disappears when `preview-screen.mp4` is ready.
- Audio plays back NR-processed (compare against raw screen.mp4 in QuickTime).
- Save the recording. Saved MP4's audio matches the preview's audio (A/B test from Phase 14 c2 done-when).
- For a screen-only recording with no audio: preview-screen.mp4 still generates (arnndn is a no-op without an audio stream), screen video plays as expected.

**Export parity (c2 byte-stability invariant preserved):**
- All four exports continue to produce files that pass the c2 byte-stability baseline test. (c2 already shipped the test; c3 must not regress it — same `run_edit_pipeline`, just no longer fed by a finalize-side composite.)

**Edge cases:**
- Stop right at the camera-start moment (record for <500ms). Webcam.mp4 may be empty or trivial. Review opens cleanly; if webcam has no frames, the `<video>` element shows nothing (or shows the poster frame) and the bubble interp uses the single-keyframe fall-through.
- Webcam segments with a Continuity drop mid-recording (existing scenario from Phase 3 PLAN.md). Concat at finalize handles this; player handles via natural shorter-than-screen webcam track (webcam ends before screen; player sees `webcam.ended`, freezes on last frame).
- Discard the recording. `webcam.mp4` and `preview-screen.mp4` go with the scratch dir.
- Open the recording, then close review without saving. Same — scratch dir + all preview/concat artifacts removed via existing close-prompt path.

**Regressions checked:**
- Trim works (in/out markers, save honors them).
- Annotations work (text + arrow appear at right times in exports).
- Waveform renders correctly (still reads from screen.mp4 — D-12 from Phase 14 carries over).
- Clipping highlight shows on the waveform (unchanged from Phase 12 c1).
- Scrub thumbnails appear on hover (now from screen.mp4; bubble missing from thumbnails — cosmetic, expected per D-10).
- Phase 14 c1 bubble placement on the right display still works (this phase doesn't touch capture-time bubble code).
- Phase 14 c2 NR pip surfaces (loading, ready, failed) still appear in the same places, with `preview-screen.mp4` instead of `preview.mp4`.

### Verification fixture

Three test recordings during c3 verification:

1. **12-minute recording** — the Phase 15 motivating case. Stop and time the review-open. Must be sub-2-second.
2. **5-minute recording with bubble drag and one annotation** — exercises dual-stream sync over a meaningful duration, bubble keyframe interp, and annotation overlay at export.
3. **30-second screen-only recording** — exercises the no-webcam fall-through path. Must NOT exercise the dual-stream sync code (single `<video>` only).

---

## Phase done-when

- Stop → preview latency for a 12-minute recording is < 2 seconds (c3 verified).
- Saved MP4s remain byte-stable (decoded-frame md5) vs Phase 14 outputs for the same input scratch + sidecar (c2 verified).
- NR audio preview still plays in review, audibly cleaner than raw screen.mp4 (D-05 verified).
- Bubble position, animation, hflip, circular mask, and visual fidelity in preview match the saved file (D-04, D-12 verified).
- All four export paths (Save, Copy, LinkedIn, GIF) work and produce files matching Phase 14 behavior (c2 verified across paths).
- No regression in trim, annotation, waveform, clipping highlight, scratch lifecycle, Phase 14 c1 bubble placement, or Phase 14 c2 NR pip behavior.

## Out of plan (deferred, captured here for traceability)

- Composite caching across multiple exports — D-07.
- MediaSource Extensions for webcam segments — D-02 alt.
- Audio-shift parity in preview (subsecond drift) — D-09.
- Bubble in scrub thumbnails — D-10.
- Background composite during review (Loom server-side parallel) — out of scope; v1.5 opportunity if user does multi-export flows.
- Hot-reload bubble position editing in review window — out of scope; real win for screen-only-with-bubble corrections but bigger surface than Phase 15.
- Removing `composite::composite` (only the filter-builder survives) — defer; thin wrapper has zero cost.

All covered in `docs/PHASE-15-CONTEXT.md` §"Deferred Ideas."

---

*Phase: 15-deferred-composite*
*Plan drafted: 2026-06-02*
