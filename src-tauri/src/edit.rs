use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::composite::{Watermark, FFMPEG_PATH, FFPROBE_PATH};

// Resolved at startup from AppHandle::path().resource_dir(). Read by
// run_edit_pipeline when building the MP4 audio filter.
static AUDIO_MODEL_PATH: OnceLock<PathBuf> = OnceLock::new();

pub fn set_audio_model_path(path: PathBuf) {
    let _ = AUDIO_MODEL_PATH.set(path);
}

fn audio_model_path() -> &'static Path {
    AUDIO_MODEL_PATH
        .get()
        .expect("audio model not initialized — call set_audio_model_path() in lib.rs::run setup")
        .as_path()
}

// RNNoise audio filter for the current noise-reduction setting, or None when
// the user turned it off. `mix` scales suppression strength (Low/Med/High).
fn audio_nr_filter() -> Option<String> {
    crate::settings::noise_reduction_mix()
        .map(|mix| format!("arnndn=m={}:mix={mix:.2}", audio_model_path().display()))
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct SidecarState {
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub trim: Option<Trim>,
    #[serde(default)]
    pub annotations: Vec<Annotation>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub bubble_position_log: Vec<BubblePositionEntry>,
    // Original-timeline timestamp for the poster frame the user picked in
    // review. None = use the export-time default (0.5s in) which kills the
    // black/half-rendered frame-0 problem on every export. Stored in
    // original-timeline coords like annotation.start_time — save_recording
    // maps it to output-timeline (post-trim) before extracting the poster.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thumbnail_time: Option<f64>,
    // Bubble corner roundness set in review: 0.0 (square) ..= 1.0 (circle).
    // None = circle via the legacy mask path — composite.rs keeps that branch
    // byte-identical to pre-E1, so untouched recordings render exactly as
    // before. Corner radius = roundness * diameter/2, mirrored by
    // Review.tsx's border-radius for preview parity.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bubble_roundness: Option<f64>,
    // V2 Step 2: the ONE constant zone the export bakes the webcam bubble at,
    // picked in Review. None = no explicit pick; the export migrates from the
    // position-log centroid (nearest corner) or falls back to the default
    // corner via composite::resolve_zone. Skipped when None so untouched and
    // pre-Step-2 sidecars stay byte-identical. bubble_position_log is now
    // preview/legacy data — export reads it only for the bubble diameter.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bubble_zone: Option<crate::composite::BubbleZone>,
    // Global color for all text/arrow annotations, "#RRGGBB". None = white
    // (the pre-feature hardcode) — the review only writes the field when
    // annotations exist and the color is non-white, so legacy sidecars and
    // untouched recordings rasterize byte-identically.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub annotation_color: Option<String>,
    // Zoom layer keyframes (ZOOM-LAYER-PLAN step 2). Empty = no zoom and
    // serializes to ABSENT — same Vec::is_empty convention as
    // bubble_position_log — so a no-zoom sidecar stays byte-identical to a
    // pre-zoom one. Nothing in the export pipeline reads this field yet
    // (rendering is step 4); a non-empty track is the thing that will pay
    // the re-encode, an empty one must never leave the -c:v copy path.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub zoom: Vec<ZoomKeyframe>,
}

// One point on the zoom curve (V3-PLAN C.2). Zoom state between keyframes
// is interpolated per `ease` into the later keyframe.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct ZoomKeyframe {
    // Seconds on the original timeline, same basis as Annotation.start_time.
    pub t: f64,
    // 1.0 = no zoom. Detection caps at 2.5 (V3-PLAN C.1 calm rules).
    pub scale: f64,
    // Zoom center in video pixel space (telemetry coordinates).
    pub center_x: f64,
    pub center_y: f64,
    #[serde(default)]
    pub ease: Ease,
    // true = written by suggestion detection (step 5). Regeneration may
    // replace only flagged keyframes; user-placed ones are never stomped.
    #[serde(default)]
    pub auto_generated: bool,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Ease {
    // V3-PLAN C.1: never linear for generated zoom — linear reads as
    // mechanical. Linear stays available for manual edits.
    #[default]
    InOutCubic,
    Linear,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct BubblePositionEntry {
    pub t: f64,
    pub x: f64,
    pub y: f64,
    // Bubble circle diameter as a FRACTION of the capture frame WIDTH (like x/y,
    // which are already frame fractions). Resolved to pixels at export as
    // frac * screen_width, so the bubble holds its relative size at any capture
    // resolution. Stored absolute (physical px) before 2026-07-17; that was
    // correct only while capture == the frontend's logical space (both 1512),
    // and rendered half-size once capture moved to the 2x backing store — the
    // whole reason this became a fraction. None -> the WebcamSize::frac() default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diameter_frac: Option<f64>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Trim {
    #[serde(rename = "in")]
    pub start: f64,
    pub out: f64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Annotation {
    #[serde(rename = "type")]
    pub kind: String,
    pub start_time: f64,
    pub end_time: f64,
    pub position: Position,
    pub content: String,
    // Text-only: font size in source pixels. Defaults to 36 when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<f64>,
    // Arrow-only (C5): end point in source-fraction coords.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub endpoint: Option<Position>,
    // Arrow-only (C5): stroke width in source pixels.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stroke: Option<f64>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Position {
    pub x: f64,
    pub y: f64,
}

pub fn sidecar_path(source: &Path) -> PathBuf {
    // Dotfile prefix so the JSON stays next to the source mp4 but is hidden
    // from Finder by default. Keeps ~/Movies/Zeigen tidy.
    let stem = source.file_stem().unwrap_or_default();
    let mut name = std::ffi::OsString::from(".");
    name.push(stem);
    name.push(".annotations.json");
    source.with_file_name(name)
}

pub fn read_sidecar_path(source: &Path) -> Result<Option<SidecarState>, String> {
    let p = sidecar_path(source);
    if !p.exists() {
        return Ok(None);
    }
    let data = std::fs::read_to_string(&p)
        .map_err(|e| format!("read sidecar {}: {e}", p.display()))?;
    let state: SidecarState = serde_json::from_str(&data)
        .map_err(|e| format!("parse sidecar {}: {e}", p.display()))?;
    Ok(Some(state))
}

pub fn write_sidecar_path(source: &Path, state: &SidecarState) -> Result<(), String> {
    let p = sidecar_path(source);
    let data = serde_json::to_string_pretty(state)
        .map_err(|e| format!("serialize sidecar: {e}"))?;
    std::fs::write(&p, data).map_err(|e| format!("write sidecar {}: {e}", p.display()))?;
    Ok(())
}

#[tauri::command]
pub fn read_sidecar(source_path: String) -> Result<Option<SidecarState>, String> {
    read_sidecar_path(Path::new(&source_path))
}

#[tauri::command]
pub fn write_sidecar(source_path: String, state: SidecarState) -> Result<(), String> {
    write_sidecar_path(Path::new(&source_path), &state)
}

#[tauri::command]
pub fn delete_sidecar(source_path: String) -> Result<(), String> {
    let p = sidecar_path(Path::new(&source_path));
    if p.exists() {
        std::fs::remove_file(&p)
            .map_err(|e| format!("delete sidecar {}: {e}", p.display()))?;
    }
    Ok(())
}

pub(crate) fn probe_duration_seconds(path: &Path) -> Result<f64, String> {
    let output = Command::new(FFPROBE_PATH)
        .args([
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
        ])
        .arg(path)
        .output()
        .map_err(|e| format!("ffprobe failed: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "ffprobe non-zero for {}: {}",
            path.display(),
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    let s = String::from_utf8_lossy(&output.stdout).trim().to_string();
    s.parse::<f64>().map_err(|e| format!("parse duration {s:?}: {e}"))
}

const TRIM_EPS: f64 = 0.05;

pub(crate) fn probe_dimensions(path: &Path) -> Result<(u32, u32), String> {
    let output = Command::new(FFPROBE_PATH)
        .args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=width,height",
            "-of",
            "csv=p=0:s=x",
        ])
        .arg(path)
        .output()
        .map_err(|e| format!("ffprobe dims failed: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "ffprobe dims non-zero for {}: {}",
            path.display(),
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    let s = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let mut parts = s.split('x');
    let w: u32 = parts
        .next()
        .ok_or_else(|| format!("ffprobe dims malformed: {s}"))?
        .parse()
        .map_err(|e| format!("parse width {s:?}: {e}"))?;
    let h: u32 = parts
        .next()
        .ok_or_else(|| format!("ffprobe dims malformed: {s}"))?
        .parse()
        .map_err(|e| format!("parse height {s:?}: {e}"))?;
    Ok((w, h))
}

#[derive(Serialize, Debug)]
pub struct AudioTrackMeta {
    // start_time of the audio stream in seconds. 0.0 when the recording has
    // no leading audio gap; typically 30-650ms on Zeigen recordings (mic
    // startup latency before the first CMSampleBuffer reaches AVAssetWriter).
    pub start: f64,
    // Duration of the audio stream in seconds. Strictly <= the video duration
    // because the last mic CMSampleBuffer reaches the writer before the last
    // video frame.
    pub duration: f64,
}

#[tauri::command]
pub fn probe_audio_track(source_path: String) -> Result<Option<AudioTrackMeta>, String> {
    probe_audio_track_path(Path::new(&source_path))
}

pub(crate) fn probe_audio_track_path(path: &Path) -> Result<Option<AudioTrackMeta>, String> {
    let output = Command::new(FFPROBE_PATH)
        .args([
            "-v",
            "error",
            "-select_streams",
            "a:0",
            "-show_entries",
            "stream=start_time,duration",
            "-of",
            "csv=p=0",
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
        // No audio stream in source.
        return Ok(None);
    }
    let mut parts = s.split(',');
    let start: f64 = parts
        .next()
        .ok_or_else(|| format!("ffprobe audio-track malformed: {s}"))?
        .parse()
        .map_err(|e| format!("parse start_time {s:?}: {e}"))?;
    let duration: f64 = parts
        .next()
        .ok_or_else(|| format!("ffprobe audio-track malformed: {s}"))?
        .parse()
        .map_err(|e| format!("parse duration {s:?}: {e}"))?;
    Ok(Some(AudioTrackMeta { start, duration }))
}

// Generate a NR-processed sibling MP4 next to the scratch source so the
// review window can play audio that matches what the save pipeline writes
// (Phase 14 c2). The pipeline is the narrowest slice of run_edit_pipeline:
// same arnndn filter (Phase 12 c3), same AAC re-encode, video bitstream
// copied. No trim, no overlay — preview is audio parity only (D-09).
#[tauri::command]
pub fn render_preview_audio(source_path: String) -> Result<String, String> {
    let source = Path::new(&source_path);
    if !source.is_file() {
        return Err(format!("source missing: {}", source.display()));
    }
    let preview = preview_path_for(source)
        .ok_or_else(|| "source has no parent directory".to_string())?;
    render_preview_audio_path(source, &preview)?;
    Ok(preview.to_string_lossy().into_owned())
}

pub(crate) fn preview_path_for(source: &Path) -> Option<PathBuf> {
    // Phase 15 c3: renamed to preview-screen.mp4 since the source the
    // preview now operates on is sources/screen.mp4 (not a composited
    // mp4). The file is the NR-processed equivalent of screen.mp4 that
    // the dual-stream player's screen <video> swaps to once arnndn runs.
    source.parent().map(|p| p.join("preview-screen.mp4"))
}

pub(crate) fn render_preview_audio_path(source: &Path, output: &Path) -> Result<(), String> {
    // Drop any stale preview from a prior open. Regenerated fresh each
    // open — D-07.
    let _ = std::fs::remove_file(output);

    let mut args: Vec<String> = vec![
        "-y".into(),
        "-i".into(),
        source.to_string_lossy().into_owned(),
    ];
    if let Some(af) = audio_nr_filter() {
        args.push("-af".into());
        args.push(af);
    }
    args.extend([
        "-map".into(),
        "0:v:0".into(),
        "-map".into(),
        "0:a:0?".into(),
        "-c:v".into(),
        "copy".into(),
        "-c:a".into(),
        "aac".into(),
        "-b:a".into(),
        "192k".into(),
        output.to_string_lossy().into_owned(),
    ]);

    let result = Command::new(FFMPEG_PATH)
        .args(&args)
        .output()
        .map_err(|e| format!("failed to spawn ffmpeg for preview: {e}"))?;

    if !result.status.success() {
        let stderr = String::from_utf8_lossy(&result.stderr);
        return Err(format!(
            "ffmpeg preview render failed (exit {:?}):\n{}",
            result.status.code(),
            stderr
                .lines()
                .rev()
                .take(40)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect::<Vec<_>>()
                .join("\n")
        ));
    }

    Ok(())
}

// Derive the raw-input paths the Phase 15 c2 composite-at-export
// pipeline needs from a scratch source path. For webcam recordings the
// scratch layout is:
//   <scratch_dir>/recording-<stamp>.mp4           (composited; ignored by c2)
//   <scratch_dir>/sources/screen.mp4              (raw screen)
//   <scratch_dir>/sources/webcam-NN.mp4           (raw webcam segments)
//   <scratch_dir>/sources/webcam.mp4              (c1 concat; ignored, segments preferred)
// For screen-only recordings sources/ doesn't exist and the source path
// IS the raw screen — return it with an empty segments vec.
pub(crate) fn export_inputs_from_source(source: &Path) -> (PathBuf, Vec<PathBuf>) {
    let sources_dir = match source.parent().map(|p| p.join("sources")) {
        Some(d) if d.is_dir() => d,
        _ => return (source.to_path_buf(), Vec::new()),
    };
    let screen = sources_dir.join("screen.mp4");
    if !screen.is_file() {
        return (source.to_path_buf(), Vec::new());
    }
    let mut segments: Vec<PathBuf> = std::fs::read_dir(&sources_dir)
        .ok()
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.starts_with("webcam-") && n.ends_with(".mp4"))
                .unwrap_or(false)
        })
        .collect();
    segments.sort();
    (screen, segments)
}

// Output resolution for GIF export. Source caps at 1080p per phase 10
// context D-01 to keep palette generation tractable.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum GifResolution {
    P480,
    P720,
    Source,
}

// Output resolution for MP4 export. `Source` skips the scale node and
// keeps the pipeline byte-identical to the pre-phase-11 behavior; the
// other variants append a lanczos scale after the overlay chain.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Mp4Resolution {
    P480,
    P720,
    P1080,
    Source,
}

// Selects which tail the edit pipeline emits. Same trim + overlay graph
// either way; Mp4 ends in h264_videotoolbox+aac, Gif ends in a
// palettegen/paletteuse chain feeding the GIF muxer.
#[derive(Clone, Copy, Debug)]
pub(crate) enum PipelineMode {
    Mp4 { resolution: Mp4Resolution },
    Gif { resolution: GifResolution, fps: u32 },
}

// ===========================================================================
// Export compositor. The GPU-native cicompositor (compositor-engine/main.swift)
// renders every zoom / webcam-bubble / watermark MP4 and GIF; the plain-MP4 tail
// (run_plain_mp4) and plain-GIF tail (run_plain_gif) go straight to ffmpeg. The
// V2 ffmpeg 4x-oversample path and its use_v3_compositor flag were removed in the
// teardown (2026-07-19); a V3 runtime failure now fails the export loudly (no
// fallback). History: DECISIONS.md 2026-07-16 (switchover) .. 2026-07-19.
// ===========================================================================

// Export outcome surfaced to the UI. `route_note` is Some only when a successful
// V3 export carries a caveat the owner asked to see (today: multi-segment webcam
// concat drift). None on the normal path (clean V3 export, plain -c:v copy, GIF).
pub(crate) struct PipelineReport {
    pub route_note: Option<String>,
}

impl PipelineReport {
    fn normal() -> Self {
        Self { route_note: None }
    }
    // A successful V3 export that carries a caveat (e.g. multi-segment webcam
    // concat drift). The note is self-describing.
    fn caveat(note: &str) -> Self {
        Self { route_note: Some(note.to_string()) }
    }
}

// Release: cicompositor is bundled next to the app exe (externalBin sidecar),
// mirroring engine_binary_path(). Debug: the committed compositor-engine binary.
fn cicompositor_binary_path() -> PathBuf {
    #[cfg(not(debug_assertions))]
    {
        std::env::current_exe()
            .ok()
            .and_then(|exe| exe.parent().map(|dir| dir.join("cicompositor")))
            .unwrap_or_else(|| PathBuf::from("cicompositor"))
    }
    #[cfg(debug_assertions)]
    {
        // build.rs compiles the compositor here on every build (the source
        // compositor-engine/cicompositor is gitignored, so don't depend on it).
        // Mirrors engine_binary_path's scratch-output resolution.
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/recording-engine-build/cicompositor")
    }
}

// Average frame rate (avg_frame_rate reflects VFR better than r_frame_rate), used
// only to size the webcam bubble lead. Falls back to 30 on any parse trouble.
fn probe_fps(path: &Path) -> f64 {
    let out = std::process::Command::new(FFPROBE_PATH)
        .args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=avg_frame_rate",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
        ])
        .arg(path)
        .output();
    let parsed = out.ok().and_then(|o| {
        let s = String::from_utf8_lossy(&o.stdout);
        let s = s.trim();
        let (n, d) = s.split_once('/')?;
        let n: f64 = n.trim().parse().ok()?;
        let d: f64 = d.trim().parse().ok()?;
        (d > 0.0).then_some(n / d)
    });
    parsed.filter(|f| *f > 0.0).unwrap_or(30.0)
}

// V3 output dimensions for a target resolution, mirroring V2's mp4_scale tail
// (`-2:480` / `-2:720` / `'min(iw,1920)':-2`): P480/P720 constrain height, P1080
// caps width at 1920, each keeping aspect and rounding to an even number (ffmpeg
// `-2`). Returns the source dims unchanged when the target wouldn't actually
// shrink it, so the compositor skips the downscale and stays the Source path.
fn v3_output_dims(w: u32, h: u32, resolution: Mp4Resolution) -> (u32, u32) {
    let even = |x: f64| ((x / 2.0).round() as u32).max(1) * 2;
    match resolution {
        Mp4Resolution::P480 if h > 480 => (even(w as f64 * 480.0 / h as f64), 480),
        Mp4Resolution::P720 if h > 720 => (even(w as f64 * 720.0 / h as f64), 720),
        Mp4Resolution::P1080 if w > 1920 => (1920, even(h as f64 * 1920.0 / w as f64)),
        _ => (w, h),
    }
}

// Product of the shared V3 render (cicompositor): the video-only mp4 the caller
// consumes (audio mux for MP4, palettegen for GIF), the temp dir the caller must
// clean up AFTER consuming video_only (it lives inside), the resolved trim window
// (so the MP4 caller can window the audio mux identically), and an optional caveat
// note (multi-segment webcam concat drift) surfaced the same on both tails.
struct V3Render {
    video_only: PathBuf,
    temp_dir: PathBuf,
    trim: Option<(f64, f64)>,
    caveat: Option<String>,
}

// Shared V3 render half: cicompositor renders zoom + bubble + watermark to a
// video-only mp4 (downscaled to `resolution` if below source). No audio, no GIF
// palette — the caller appends its own tail. Drives on_progress across [0.02,
// 0.85]; the caller drives the rest. Does NOT clean up temp_dir. `watermark` is
// pre-filtered to an existing logo. `webcam_segments` is 0 or 1 in the common
// case; 2+ (a Continuity drop mid-recording) are concatenated back-to-back into
// one bubble stream, and V3Render.caveat then describes the resulting drift.
fn v3_render(
    screen_path: &Path,
    webcam_segments: &[std::path::PathBuf],
    sidecar: &SidecarState,
    webcam_size: crate::composite::WebcamSize,
    watermark: Option<&Watermark>,
    resolution: Mp4Resolution,
    on_progress: &impl Fn(f64),
) -> Result<V3Render, String> {
    on_progress(0.02);
    let bin = cicompositor_binary_path();
    if !bin.is_file() {
        return Err(format!("cicompositor binary missing: {}", bin.display()));
    }
    let (w, h) = probe_dimensions(screen_path)?;
    let (out_w, out_h) = v3_output_dims(w, h, resolution);

    // Temp workspace for the zoom JSON, bubble PNGs, and the video-only render.
    let stem = screen_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("source");
    let temp_dir = screen_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(".sources")
        .join(format!("v3-{stem}"));
    std::fs::create_dir_all(&temp_dir)
        .map_err(|e| format!("create {}: {e}", temp_dir.display()))?;

    // Resolve the segments to the ONE bubble stream cicompositor consumes.
    // COMMON CASE (0 or 1 segment) is untouched: a single segment is fed
    // directly, byte-identical to before. 2+ segments (a Continuity drop spawned
    // webcam-01.mp4, ...) are concatenated back-to-back — the concat path only
    // exists when len > 1, so a clean single-segment recording never touches it.
    let webcam: Option<PathBuf> = match webcam_segments {
        [] => None,
        [only] => Some(only.clone()),
        many => Some(concat_webcam_segments(many, &temp_dir)?),
    };
    // Drift note: back-to-back concat removes the wall-clock gap(s) where the
    // camera was disconnected, so the concatenated bubble stream is shorter than
    // the screen by the total downtime. Computed only on the multi-segment path.
    let webcam_note = (webcam_segments.len() > 1).then(|| {
        let screen_dur = probe_duration_seconds(screen_path).unwrap_or(0.0);
        let webcam_dur: f64 = webcam_segments
            .iter()
            .filter_map(|s| probe_duration_seconds(s).ok())
            .sum();
        // downtime = screen span not covered by any webcam segment ≈ sum of the
        // Continuity gaps (start/stop offsets are sub-second vs a real drop).
        let downtime = (screen_dur - webcam_dur).max(0.0);
        format!(
            "Webcam recorded in {n} segments (Continuity camera dropped mid-recording). \
             Concatenated back-to-back, removing ~{d:.1}s of camera downtime — so after \
             the drop the bubble runs AHEAD of the audio by up to ~{d:.1}s (the face \
             mouths words before you hear them) and freezes on its last frame for the \
             final ~{d:.1}s. Re-record if that's visible.",
            n = webcam_segments.len(),
            d = downtime,
        )
    });

    // Trim window, normalized exactly as run_plain_mp4 does: a trim that
    // doesn't actually cut (start ~0 and out ~duration) is treated as untrimmed, so
    // the compositor gets no TRIM_* env and the path stays byte-identical. Otherwise
    // (trim_in, trim_out) in original-timeline seconds.
    let src_dur = probe_duration_seconds(screen_path).unwrap_or(0.0);
    let trim: Option<(f64, f64)> = match &sidecar.trim {
        Some(t) if t.start > TRIM_EPS || (src_dur > 0.0 && t.out < src_dur - TRIM_EPS) => {
            Some((t.start.max(0.0), if src_dur > 0.0 { t.out.min(src_dur) } else { t.out }))
        }
        _ => None,
    };

    // Zoom -> ZOOM_SEGMENTS JSON. cx/cy are source px (top-origin); cicompositor
    // wants top-origin fractions and applies ZOOM_RENDER_RAMP_S itself per edge.
    #[derive(serde::Serialize)]
    struct V3ZoomSeg {
        start: f64,
        end: f64,
        scale: f64,
        ramp: f64,
        cxf: f64,
        cyf: f64,
    }
    let segs = zoom_keyframes_to_segments(&sidecar.zoom);
    let zoom_json_path = if segs.is_empty() {
        None
    } else {
        let items: Vec<V3ZoomSeg> = segs
            .iter()
            .map(|s| V3ZoomSeg {
                start: s.start,
                end: s.end,
                scale: s.scale,
                ramp: ZOOM_RENDER_RAMP_S,
                cxf: s.cx / w as f64,
                cyf: s.cy / h as f64,
            })
            .collect();
        let json = serde_json::to_string(&items).map_err(|e| format!("zoom json: {e}"))?;
        let p = temp_dir.join("zoom.json");
        std::fs::write(&p, json).map_err(|e| format!("write zoom.json: {e}"))?;
        Some(p)
    };

    // Bubble mask + shadow PNGs (identical geometry to V2 build_webcam_overlay).
    let bubble = match &webcam {
        Some(_) => Some(crate::composite::build_v3_bubble_assets(
            &temp_dir,
            sidecar.bubble_zone,
            &sidecar.bubble_position_log,
            sidecar.bubble_roundness,
            webcam_size,
            w,
        )?),
        None => None,
    };

    let video_only = temp_dir.join("v3-video.mp4");
    let mut cmd = std::process::Command::new(&bin);
    cmd.arg(screen_path).arg(&video_only).arg("identity");
    // Below-source target -> compositor appends a terminal Lanczos downscale to
    // these even, aspect-matched dims. Equal to source -> not set, output == source.
    if (out_w, out_h) != (w, h) {
        cmd.env("OUTPUT_WIDTH", out_w.to_string())
            .env("OUTPUT_HEIGHT", out_h.to_string());
    }
    if let Some(zj) = &zoom_json_path {
        cmd.env("ZOOM_SEGMENTS", zj);
    }
    // Trim window (original-timeline seconds). Compositor renders only this span and
    // rebases output PTS to 0; the audio mux below trims the screen audio to match.
    if let Some((tin, tout)) = trim {
        cmd.env("TRIM_IN", format!("{tin:.6}"))
            .env("TRIM_OUT", format!("{tout:.6}"));
    }
    if let (Some(wc), Some(b)) = (webcam.as_deref(), &bubble) {
        // Webcam A/V lead, trim-aware — mirrors composite.rs build_webcam_overlay
        // (pad_lead / wc_skip) but in frames. Untrimmed: trim_in=0 -> pad_lead=lead,
        // wc_skip=0, so BUBBLE_LEAD_FRAMES=round(lead*fps) and no skip (byte-identical
        // to before). Trimmed: pad_lead=(lead-trim_in).max(0) freezes the residual
        // lead; wc_skip=(trim_in-lead).max(0) drops the webcam front, so at output
        // t=0 the bubble shows content from (trim_in-lead) — the same 105ms lead as
        // the untrimmed start. Shadow alpha/radius-k stay at cicompositor defaults.
        let fps = probe_fps(screen_path);
        let lead_secs = crate::composite::WEBCAM_LEAD_MS / 1000.0;
        let trim_in = trim.map(|(a, _)| a).unwrap_or(0.0);
        let lead_frames = ((lead_secs - trim_in).max(0.0) * fps).round().max(0.0) as i64;
        let skip_frames = ((trim_in - lead_secs).max(0.0) * fps).round().max(0.0) as i64;
        cmd.env("BUBBLE_WEBCAM", wc)
            .env("BUBBLE_MASK_PNG", &b.mask_path)
            .env("BUBBLE_SHADOW_PNG", &b.shadow_path)
            .env("BUBBLE_DIAMETER", b.diameter.to_string())
            .env("BUBBLE_ZONE", b.zone.code())
            // Padding scales with the compositing frame width so the bubble holds
            // its relative inset at backing resolution (default would stay 30px).
            .env("BUBBLE_PADDING", crate::composite::resolve_padding_px(w).to_string())
            .env("BUBBLE_LEAD_FRAMES", lead_frames.to_string());
        if skip_frames > 0 {
            cmd.env("BUBBLE_WEBCAM_SKIP_FRAMES", skip_frames.to_string());
        }
    }
    if let Some(wm) = watermark {
        cmd.env("WATERMARK_PNG", &wm.logo_path)
            .env("WATERMARK_CORNER", wm.corner.code())
            .env("WATERMARK_OPACITY", format!("{}", wm.opacity));
        if let Some(sf) = wm.scale_frac {
            cmd.env("WATERMARK_SCALE_FRAC", format!("{sf}"));
        }
    }
    let comp = cmd
        .output()
        .map_err(|e| format!("spawn cicompositor: {e}"))?;
    if !comp.status.success() {
        return Err(format!(
            "cicompositor {}: {}",
            comp.status,
            String::from_utf8_lossy(&comp.stderr).trim()
        ));
    }
    let has_output = std::fs::metadata(&video_only)
        .map(|m| m.len() > 0)
        .unwrap_or(false);
    if !has_output {
        return Err("cicompositor produced no output".into());
    }
    on_progress(0.85);
    Ok(V3Render { video_only, temp_dir, trim, caveat: webcam_note })
}

// V3 MP4 export: shared render + ffmpeg mux of the SCREEN source's audio (arnndn,
// no itsoffset — the single-input path doesn't shift). Returns Err on any V3
// failure — no V2 fallback (the caller surfaces the reason and preserves the
// scratch source). Ok(None) is the clean path; Ok(Some(note)) carries a caveat.
fn run_v3_export(
    screen_path: &Path,
    webcam_segments: &[std::path::PathBuf],
    output: &Path,
    sidecar: &SidecarState,
    webcam_size: crate::composite::WebcamSize,
    watermark: Option<&Watermark>,
    resolution: Mp4Resolution,
    on_progress: impl Fn(f64),
) -> Result<Option<String>, String> {
    let render = v3_render(
        screen_path,
        webcam_segments,
        sidecar,
        webcam_size,
        watermark,
        resolution,
        &on_progress,
    )?;

    // Mux: V3 video + SCREEN audio (arnndn, no itsoffset). faststart for /v/.
    // On a trim, -ss/-to before the screen input windows the audio to [trim_in,
    // trim_out] and rebases it to 0 (input-seek semantics, matching V2's single_input
    // -ss/-to), so it stays locked to the already-trimmed compositor video.
    let mut mux = std::process::Command::new(FFMPEG_PATH);
    mux.arg("-y").arg("-i").arg(&render.video_only);
    if let Some((tin, tout)) = render.trim {
        mux.arg("-ss")
            .arg(format!("{tin:.3}"))
            .arg("-to")
            .arg(format!("{tout:.3}"));
    }
    mux.arg("-i")
        .arg(screen_path)
        .args(["-map", "0:v", "-map", "1:a?"]);
    if let Some(af) = audio_nr_filter() {
        mux.arg("-af").arg(af);
    }
    mux.args([
        "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart",
    ])
    .arg(output);
    let muxed = mux.output().map_err(|e| format!("spawn ffmpeg mux: {e}"))?;
    if !muxed.status.success() {
        return Err(format!(
            "ffmpeg mux {}: {}",
            muxed.status,
            String::from_utf8_lossy(&muxed.stderr).trim()
        ));
    }
    let _ = std::fs::remove_dir_all(&render.temp_dir);
    on_progress(1.0);
    Ok(render.caveat)
}

// The GIF palettegen/paletteuse tail, shared verbatim by run_plain_gif and
// run_v3_gif so the two can't drift — the IDENTICAL string V2's single_input GIF
// tail emits (only the frames feeding it differ). stats_mode=diff weights moving
// pixels (screencasts are mostly static); bayer dither preserves UI gradients
// without sierra2_4a's noise floor.
fn gif_palette_filter(prev_label: &str, resolution: GifResolution, fps: u32) -> String {
    let scale_arg = match resolution {
        GifResolution::P480 => "-2:480".to_string(),
        GifResolution::P720 => "-2:720".to_string(),
        GifResolution::Source => "'min(iw,1920)':-2".to_string(),
    };
    format!(
        "[{prev_label}]fps={fps},scale={scale_arg}:flags=lanczos,split[gA][gB];[gA]palettegen=stats_mode=diff[gP];[gB][gP]paletteuse=dither=bayer:bayer_scale=5[gout]"
    )
}

// V3 GIF export (zoom/webcam/watermark GIF): shared render at SOURCE resolution
// — the GifResolution scale is done by the palettegen pass's own lanczos scale,
// byte-identical to V2's tail, so the compositor must NOT also downscale — then a
// single ffmpeg pass runs the palette tail over the rendered frames. The palette
// filter args are identical to V2; only the pixels moved (through cicompositor +
// its H.264 intermediate). Ok(Some(note)) carries the multi-segment concat caveat.
fn run_v3_gif(
    screen_path: &Path,
    webcam_segments: &[std::path::PathBuf],
    output: &Path,
    sidecar: &SidecarState,
    webcam_size: crate::composite::WebcamSize,
    watermark: Option<&Watermark>,
    resolution: GifResolution,
    fps: u32,
    on_progress: impl Fn(f64),
) -> Result<Option<String>, String> {
    let render = v3_render(
        screen_path,
        webcam_segments,
        sidecar,
        webcam_size,
        watermark,
        Mp4Resolution::Source,
        &on_progress,
    )?;
    let filter = gif_palette_filter("0:v", resolution, fps);
    let out = std::process::Command::new(FFMPEG_PATH)
        .args(["-y", "-hide_banner", "-nostats"])
        .arg("-i")
        .arg(&render.video_only)
        .arg("-filter_complex")
        .arg(&filter)
        .args(["-map", "[gout]", "-loop", "0"])
        .arg(output)
        .output()
        .map_err(|e| format!("spawn ffmpeg gif: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "ffmpeg gif {}: {}",
            out.status,
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    let _ = std::fs::remove_dir_all(&render.temp_dir);
    on_progress(1.0);
    Ok(render.caveat)
}

// Plain GIF (no zoom/webcam/watermark — incl. trim-only, downscale-only): one
// ffmpeg pass, source -> optional -ss/-to -> the shared palette tail. This is the
// surviving standalone GIF palettegen — the GIF analog of the plain -c:v copy MP4
// fast path — and it is BYTE-IDENTICAL to V2's single_input plain-GIF output (same
// argv, same filter string). It never touches the V2 render machinery.
fn run_plain_gif(
    source: &Path,
    output: &Path,
    sidecar: &SidecarState,
    resolution: GifResolution,
    fps: u32,
    on_progress: impl Fn(f64) + Send + 'static,
) -> Result<(), String> {
    if !source.exists() {
        return Err(format!("source missing: {}", source.display()));
    }
    let duration = probe_duration_seconds(source)?;
    let trim: Option<&Trim> = match &sidecar.trim {
        Some(t) if t.start > TRIM_EPS || t.out < duration - TRIM_EPS => Some(t),
        _ => None,
    };
    let out_duration = trim.map(|t| (t.out - t.start).max(0.0)).unwrap_or(duration);

    let mut args: Vec<String> = vec![
        "-y".into(),
        "-hide_banner".into(),
        "-nostats".into(),
        "-progress".into(),
        "pipe:1".into(),
    ];
    if let Some(t) = trim {
        let start = t.start.max(0.0);
        let end = t.out.min(duration);
        if !(end > start) {
            return Err(format!("invalid trim: in={start} out={end}"));
        }
        args.push("-ss".into());
        args.push(format!("{start:.3}"));
        args.push("-to".into());
        args.push(format!("{end:.3}"));
    }
    args.push("-i".into());
    args.push(source.to_string_lossy().into_owned());
    args.push("-filter_complex".into());
    args.push(gif_palette_filter("0:v", resolution, fps));
    args.push("-map".into());
    args.push("[gout]".into());
    args.push("-loop".into());
    args.push("0".into());
    args.push(output.to_string_lossy().into_owned());

    let mut child = Command::new(FFMPEG_PATH)
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to spawn ffmpeg: {e}"))?;
    let stdout = child.stdout.take().ok_or("ffmpeg stdout missing")?;
    let stderr = child.stderr.take().ok_or("ffmpeg stderr missing")?;
    let total_us = (out_duration * 1_000_000.0).max(1.0) as u64;
    let progress_thread = std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines().map_while(Result::ok) {
            if let Some(rest) = line.strip_prefix("out_time_us=") {
                if let Ok(us) = rest.trim().parse::<u64>() {
                    let frac = (us as f64 / total_us as f64).clamp(0.0, 1.0);
                    on_progress(frac);
                }
            }
        }
    });
    let stderr_thread = std::thread::spawn(move || {
        let mut buf = String::new();
        let reader = BufReader::new(stderr);
        for line in reader.lines().map_while(Result::ok) {
            buf.push_str(&line);
            buf.push('\n');
        }
        buf
    });
    let status = child
        .wait()
        .map_err(|e| format!("failed to wait on ffmpeg: {e}"))?;
    let _ = progress_thread.join();
    let stderr_text = stderr_thread.join().unwrap_or_default();
    if !status.success() {
        return Err(format!(
            "ffmpeg plain gif failed (exit {:?}):\n{}",
            status.code(),
            stderr_text
                .lines()
                .rev()
                .take(40)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect::<Vec<_>>()
                .join("\n")
        ));
    }
    Ok(())
}

// Concatenate multiple webcam segments (a Continuity drop mid-recording spawns
// webcam-01.mp4, ...) into ONE stream for cicompositor's single BUBBLE_WEBCAM.
// Every segment shares webcam.rs's exact encode (h264_videotoolbox / nv12 / 30fps
// / 1280x720 / -an), so a stream-copy concat is valid — no re-encode. Back-to-
// back: the wall-clock gap where the camera was disconnected is REMOVED (the
// accepted drift, surfaced to the user in run_v3_export's caveat note).
fn concat_webcam_segments(segments: &[PathBuf], temp_dir: &Path) -> Result<PathBuf, String> {
    let list = temp_dir.join("webcam-concat.txt");
    let mut body = String::new();
    for seg in segments {
        // concat demuxer 'file' lines: single-quotes in the path are escaped per
        // ffmpeg's rule ('\'' closes, escapes a literal quote, reopens).
        let p = seg.to_string_lossy().replace('\'', "'\\''");
        body.push_str(&format!("file '{p}'\n"));
    }
    std::fs::write(&list, &body).map_err(|e| format!("write concat list: {e}"))?;
    let out = temp_dir.join("webcam-concat.mp4");
    let r = std::process::Command::new(FFMPEG_PATH)
        .args(["-y", "-hide_banner", "-v", "error", "-f", "concat", "-safe", "0", "-i"])
        .arg(&list)
        .args(["-c", "copy"])
        .arg(&out)
        .output()
        .map_err(|e| format!("spawn ffmpeg concat: {e}"))?;
    if !r.status.success() {
        return Err(format!(
            "webcam concat: {}",
            String::from_utf8_lossy(&r.stderr).trim()
        ));
    }
    Ok(out)
}

// The exact ffmpeg arg vector for a plain MP4 export (no zoom/webcam/watermark/
// annotations). Pure so a test can pin it byte-for-byte against the pre-teardown
// single-input args (GATE 1: trim-only + downscale-only prove "same command as
// V2"). `af` is the resolved audio-NR filter (impure, passed in). Three shapes:
//   - no trim, no scale -> `-c:v copy` (video bitstream preserved bit-for-bit)
//   - trim              -> `-ss/-to` demux trim + re-encode
//   - downscale         -> `-filter_complex [0:v]scale=...` + re-encode
fn build_plain_mp4_args(
    source: &Path,
    output: &Path,
    trim: Option<&Trim>,
    duration: f64,
    mp4_scale: Option<Mp4Resolution>,
    af: Option<String>,
) -> Result<Vec<String>, String> {
    let mut args: Vec<String> = vec![
        "-y".into(),
        "-hide_banner".into(),
        "-nostats".into(),
        "-progress".into(),
        "pipe:1".into(),
    ];
    if let Some(t) = trim {
        let start = t.start.max(0.0);
        let end = t.out.min(duration);
        if !(end > start) {
            return Err(format!("invalid trim: in={start} out={end}"));
        }
        args.push("-ss".into());
        args.push(format!("{start:.3}"));
        args.push("-to".into());
        args.push(format!("{end:.3}"));
    }
    args.push("-i".into());
    args.push(source.to_string_lossy().into_owned());

    // Downscale: a lanczos scale node whose target constrains the same dimension
    // V2's mp4_scale tail did (P480/P720 -> height, P1080 -> width). Identity /
    // upscale is skipped by the caller (mp4_scale = None), so this only appears
    // when the source actually shrinks.
    if let Some(res) = mp4_scale {
        let scale_arg = match res {
            Mp4Resolution::P480 => "-2:480",
            Mp4Resolution::P720 => "-2:720",
            Mp4Resolution::P1080 => "'min(iw,1920)':-2",
            Mp4Resolution::Source => unreachable!("mp4_scale is None on Source"),
        };
        args.push("-filter_complex".into());
        args.push(format!("[0:v]scale={scale_arg}:flags=lanczos[v0]"));
        args.push("-map".into());
        args.push("[v0]".into());
        args.push("-map".into());
        args.push("0:a?".into());
    }

    // Copy the video bitstream only when nothing changed for the viewer (no trim,
    // no scale); audio always re-encodes for noise reduction.
    let can_copy = trim.is_none() && mp4_scale.is_none();
    if let Some(af) = af {
        args.push("-af".into());
        args.push(af);
    }
    if can_copy {
        args.push("-c:v".into());
        args.push("copy".into());
    } else {
        args.push("-c:v".into());
        args.push("h264_videotoolbox".into());
        args.push("-b:v".into());
        args.push("8M".into());
        args.push("-profile:v".into());
        args.push("high".into());
        args.push("-pix_fmt".into());
        args.push("yuv420p".into());
        args.push("-tag:v".into());
        args.push("avc1".into());
        args.push("-allow_sw".into());
        args.push("1".into());
    }
    args.push("-c:a".into());
    args.push("aac".into());
    args.push("-b:a".into());
    args.push("192k".into());
    // Front-load the moov atom for progressive playback in the /v/[id] viewer.
    args.push("-movflags".into());
    args.push("+faststart".into());
    args.push(output.to_string_lossy().into_owned());
    Ok(args)
}

// The plain-MP4 tail: everything that has no zoom, webcam, or effective watermark
// (plain, trim-only, downscale-only). Formerly the no-edit branch of
// run_edit_pipeline_single_input; the V2 machinery around it is gone. Runs exactly
// one ffmpeg pass built by build_plain_mp4_args.
fn run_plain_mp4(
    source: &Path,
    output: &Path,
    sidecar: &SidecarState,
    resolution: Mp4Resolution,
    on_progress: impl Fn(f64) + Send + 'static,
) -> Result<(), String> {
    if !source.exists() {
        return Err(format!("source missing: {}", source.display()));
    }
    let duration = probe_duration_seconds(source)?;

    // Effective trim: only when it actually narrows [0, duration].
    let trim: Option<&Trim> = match &sidecar.trim {
        Some(t) if t.start > TRIM_EPS || t.out < duration - TRIM_EPS => Some(t),
        _ => None,
    };
    let out_duration = trim.map(|t| (t.out - t.start).max(0.0)).unwrap_or(duration);

    // Skip a scale that wouldn't actually shrink the source (identity/upscale
    // would force a pointless full re-encode). Compare against the dimension each
    // target constrains; a <=1080p source under the 1080p default lands on copy.
    let mp4_scale: Option<Mp4Resolution> = if resolution != Mp4Resolution::Source {
        let downscales = match probe_dimensions(source) {
            Ok((w, h)) => match resolution {
                Mp4Resolution::P480 => h > 480,
                Mp4Resolution::P720 => h > 720,
                Mp4Resolution::P1080 => w > 1920,
                Mp4Resolution::Source => false,
            },
            // Can't probe (missing source reported above) — keep the scale so
            // behavior is unchanged on the error path.
            Err(_) => true,
        };
        if downscales {
            Some(resolution)
        } else {
            None
        }
    } else {
        None
    };

    let args = build_plain_mp4_args(source, output, trim, duration, mp4_scale, audio_nr_filter())?;

    let mut child = Command::new(FFMPEG_PATH)
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to spawn ffmpeg: {e}"))?;

    let stdout = child.stdout.take().ok_or("ffmpeg stdout missing")?;
    let stderr = child.stderr.take().ok_or("ffmpeg stderr missing")?;
    let total_us = (out_duration * 1_000_000.0).max(1.0) as u64;
    let progress_thread = std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines().map_while(Result::ok) {
            if let Some(rest) = line.strip_prefix("out_time_us=") {
                if let Ok(us) = rest.trim().parse::<u64>() {
                    let frac = (us as f64 / total_us as f64).clamp(0.0, 1.0);
                    on_progress(frac);
                }
            }
        }
    });
    let stderr_thread = std::thread::spawn(move || {
        let mut buf = String::new();
        let reader = BufReader::new(stderr);
        for line in reader.lines().map_while(Result::ok) {
            buf.push_str(&line);
            buf.push('\n');
        }
        buf
    });

    let status = child
        .wait()
        .map_err(|e| format!("failed to wait on ffmpeg: {e}"))?;
    let _ = progress_thread.join();
    let stderr_text = stderr_thread.join().unwrap_or_default();

    if !status.success() {
        return Err(format!(
            "ffmpeg plain mp4 failed (exit {:?}):\n{}",
            status.code(),
            stderr_text
                .lines()
                .rev()
                .take(40)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect::<Vec<_>>()
                .join("\n")
        ));
    }
    Ok(())
}

pub(crate) fn run_edit_pipeline(
    screen_path: &Path,
    webcam_segments: &[std::path::PathBuf],
    output: &Path,
    sidecar: &SidecarState,
    mode: PipelineMode,
    webcam_size: crate::composite::WebcamSize,
    watermark: Option<Watermark>,
    on_progress: impl Fn(f64) + Send + Clone + 'static,
) -> Result<PipelineReport, String> {
    if !screen_path.is_file() {
        return Err(format!("screen capture missing: {}", screen_path.display()));
    }
    // GIF, handled first. An edited GIF (zoom/webcam/watermark) renders on
    // cicompositor then palettegen; a plain/trim/downscale-only GIF is a one-pass
    // palettegen. A V3 render failure fails the GIF loudly (no fallback), same as MP4.
    if let PipelineMode::Gif { resolution, fps } = mode {
        let has_zoom = !zoom_keyframes_to_segments(&sidecar.zoom).is_empty();
        let has_webcam = !webcam_segments.is_empty();
        let effective_wm = watermark.as_ref().filter(|w| w.logo_path.is_file());
        if has_zoom || has_webcam || effective_wm.is_some() {
            let note = run_v3_gif(
                screen_path,
                webcam_segments,
                output,
                sidecar,
                webcam_size,
                effective_wm,
                resolution,
                fps,
                on_progress,
            )?;
            return Ok(note
                .map(|n| PipelineReport::caveat(&n))
                .unwrap_or_else(PipelineReport::normal));
        }
        run_plain_gif(screen_path, output, sidecar, resolution, fps, on_progress)?;
        return Ok(PipelineReport::normal());
    }
    // MP4 (GIF returned above). V3 composites when there's an effective zoom,
    // webcam, or watermark; everything else — plain, trim-only, downscale-only —
    // is the plain-MP4 tail: copy the video bitstream when nothing changed for the
    // viewer, else a single re-encode. No V2 path remains (teardown 2026-07-19).
    let resolution = match mode {
        PipelineMode::Mp4 { resolution } => resolution,
        PipelineMode::Gif { .. } => unreachable!("GIF handled above"),
    };
    let effective_wm = watermark.as_ref().filter(|w| w.logo_path.is_file());
    let has_zoom = !zoom_keyframes_to_segments(&sidecar.zoom).is_empty();
    let has_webcam = !webcam_segments.is_empty();
    if has_zoom || has_webcam || effective_wm.is_some() {
        match run_v3_export(
            screen_path,
            webcam_segments,
            output,
            sidecar,
            webcam_size,
            effective_wm,
            resolution,
            on_progress,
        ) {
            // V3 success. Ok(None) is the clean path; Ok(Some(note)) is a success
            // carrying a caveat (multi-segment webcam concat drift).
            Ok(None) => Ok(PipelineReport::normal()),
            Ok(Some(note)) => Ok(PipelineReport::caveat(&note)),
            // No safety net (owner, 2026-07-17): a V3 failure fails the export
            // loudly. The scratch screen.mp4 is read-only input and untouched, so
            // the recording is preserved and re-exportable; the reason surfaces to
            // the review window's error banner (not swallowed into a note).
            Err(e) => {
                eprintln!("[v3] export failed: {e}");
                Err(format!("V3 export failed: {e}"))
            }
        }
    } else {
        run_plain_mp4(screen_path, output, sidecar, resolution, on_progress)?;
        Ok(PipelineReport::normal())
    }
}

#[derive(Clone, Copy, Debug)]
struct ZoomSeg {
    start: f64,
    end: f64,
    scale: f64,
    cx: f64,
    cy: f64,
}

// Mirror of Review.tsx zoomKeyframesToSegments: a segment runs from a scale~1
// keyframe through scale>1 interiors to the next scale~1 keyframe; the peak
// interior scale and its center define it. Non-canonical tracks parse
// best-effort (peak wins), same as the preview.
fn zoom_keyframes_to_segments(kfs: &[ZoomKeyframe]) -> Vec<ZoomSeg> {
    let mut sorted: Vec<&ZoomKeyframe> = kfs.iter().collect();
    sorted.sort_by(|a, b| a.t.partial_cmp(&b.t).unwrap_or(std::cmp::Ordering::Equal));
    let mut segs = Vec::new();
    let mut i = 0;
    while i < sorted.len() {
        if sorted[i].scale <= 1.001 {
            i += 1;
            continue;
        }
        let mut j = i;
        while j < sorted.len() && sorted[j].scale > 1.001 {
            j += 1;
        }
        let mut peak = sorted[i];
        for k in i..j {
            if sorted[k].scale > peak.scale {
                peak = sorted[k];
            }
        }
        let start = if i > 0 { sorted[i - 1].t } else { sorted[i].t };
        let end = if j < sorted.len() { sorted[j].t } else { sorted[j - 1].t };
        segs.push(ZoomSeg { start, end, scale: peak.scale, cx: peak.center_x, cy: peak.center_y });
        i = j;
    }
    segs
}

// Zoom ramp duration (s) at each segment edge — the in_out_cubic ease window.
// cicompositor applies it per edge; mirrors Review.tsx. (V3-shared.)
const ZOOM_RENDER_RAMP_S: f64 = 0.6;

// Resolve the next available per-format slot in ~/Movies/Zeigen for a
// given stamp + extension. First call returns `recording-<stamp>.<ext>`;
// subsequent calls with the same stamp+ext return `-2`, `-3`, ... per
// PHASE-11 D-11. Per-format scope: gif and mp4 don't collide because the
// extension differs.
fn next_per_format_slot(movies: &Path, stamp: &str, ext: &str) -> PathBuf {
    let first = movies.join(format!("recording-{stamp}.{ext}"));
    if !first.exists() {
        return first;
    }
    let mut n = 2u32;
    loop {
        let candidate = movies.join(format!("recording-{stamp}-{n}.{ext}"));
        if !candidate.exists() {
            return candidate;
        }
        n += 1;
    }
}

#[derive(Serialize, Debug)]
pub struct SaveResult {
    pub output_path: String,
    // true when the user picked a thumbnail timestamp that fell outside the
    // active trim range — the embedded poster + jpg used the clamped
    // fallback (start of trimmed output) instead of their pick. Frontend
    // surfaces a one-time toast in this case so the silent-fallback isn't
    // an opaque surprise.
    pub thumbnail_out_of_trim: bool,
    // Some when the export ran through V2 for a reason the owner asked to see
    // named ("rendered via V2 fallback: <trigger>"). None on the normal path
    // (V3 success, plain copy, or a GIF/flag choice). The frontend shows it so a
    // quiet fall-through to V2 is visible from the export itself, not guessed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub route_note: Option<String>,
}

// True when the user picked a thumbnail and trim is active and the picked
// time is outside [trim.start, trim.out]. Pure computation off the sidecar
// — used both to decide the toast flag and to drive the timeline tick's
// muted-color state on the frontend (same condition, separate code path).
fn thumbnail_out_of_trim(sidecar: &SidecarState) -> bool {
    let (Some(t), Some(trim)) = (sidecar.thumbnail_time, sidecar.trim.as_ref()) else {
        return false;
    };
    t < trim.start - TRIM_EPS || t > trim.out + TRIM_EPS
}

// Best-effort poster embed. Runs strictly after a successful run_edit_pipeline
// — the output file at output_path is the deliverable and is sacred from this
// point on. Any failure inside this function logs and cleans up; output_path
// is never modified except by an atomic rename at the very end after ffprobe-
// validating the tmp.
//
// MP4 path: extract a frame to a hidden sibling jpg (used as input to the
// mjpeg remux only — not a user-visible artifact), then mjpeg remux into
// output.tmp.mp4 with attached_pic disposition + ffprobe validate + atomic
// rename over output.mp4. The temp jpg is deleted whether the embed succeeds
// or fails.
//
// GIF path: no-op. GIF has no attached_pic concept and the previous
// .jpg-alongside behavior was dropped to keep ~/Movies/Zeigen tidy
// (the embed inside the mp4 is the only poster surface that ships).
//
// QuickTime Player.app caveat: QT Player shows frame 0 of the primary video
// stream as its before-play still, NOT the attached_pic. attached_pic IS
// honored by Finder/QuickLook, HTML5 `<video poster>`, iOS Photos, and most
// messenger preview surfaces. This is a Player.app design choice — there's
// no clean mp4-format-level fix without modifying the actual video stream.
//
// Default 0.5s applies when sidecar.thumbnail_time is None — eliminates the
// black/half-rendered frame-0 problem for every export, even ones where the
// user never opened the picker.
fn try_embed_poster(output_path: &Path, sidecar: &SidecarState, is_mp4: bool) {
    // GIF and other non-mp4 outputs: no poster surface to populate.
    if !is_mp4 {
        return;
    }

    let original_t = sidecar.thumbnail_time.unwrap_or(0.5);
    let trim_in = sidecar.trim.as_ref().map(|t| t.start).unwrap_or(0.0);

    // Probe the OUTPUT file's actual duration — accurate even if the trim
    // got clamped or the pipeline produced a slightly different length than
    // the math predicted.
    let out_duration = match probe_duration_seconds(output_path) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("[poster] probe output duration failed: {e}");
            return;
        }
    };
    let max_t = (out_duration - 0.1).max(0.0);
    let output_t = (original_t - trim_in).clamp(0.0, max_t);

    // Hidden sibling — dotfile so Finder ignores it during the brief window
    // it exists, and lives in the same dir as the output so we don't need a
    // cache-dir lifecycle. Deleted before this function returns regardless
    // of success/failure.
    let jpg_path = output_path.with_file_name(format!(
        ".{}.poster-src.jpg",
        output_path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("output")
    ));

    // Pass 1: extract frame at output_t to the temp jpg.
    let extract = Command::new(FFMPEG_PATH)
        .args(["-y", "-hide_banner", "-loglevel", "error"])
        .args(["-ss", &format!("{output_t:.3}")])
        .arg("-i")
        .arg(output_path)
        .args(["-frames:v", "1", "-qscale:v", "2"])
        .arg(&jpg_path)
        .output();
    let jpg_ok = match &extract {
        Ok(o) if o.status.success() => jpg_path
            .metadata()
            .map(|m| m.len() > 0)
            .unwrap_or(false),
        Ok(o) => {
            eprintln!(
                "[poster] frame extract non-zero exit at t={output_t:.3}s: {}",
                String::from_utf8_lossy(&o.stderr)
            );
            false
        }
        Err(e) => {
            eprintln!("[poster] frame extract spawn failed: {e}");
            false
        }
    };
    if !jpg_ok {
        let _ = std::fs::remove_file(&jpg_path);
        return;
    }

    // Pass 2 wrapped so the temp jpg cleanup at the end of this function
    // runs regardless of which exit path the remux/validate/rename takes.
    let remux_and_swap = || {
        // Tmp file is a sibling of output so the eventual rename is on the same
        // volume (atomic on macOS APFS).
        let tmp_path = output_path.with_file_name(format!(
            "{}.poster.tmp",
            output_path
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("output.mp4")
        ));
        let _ = std::fs::remove_file(&tmp_path);

        let remux = Command::new(FFMPEG_PATH)
            .args(["-y", "-hide_banner", "-loglevel", "error", "-i"])
            .arg(output_path)
            .arg("-i")
            .arg(&jpg_path)
            .args([
                "-map", "0",
                "-map", "1",
                "-c", "copy",
                "-c:v:1", "mjpeg",
                "-disposition:v:1", "attached_pic",
                // Explicit format — the `.poster.tmp` extension isn't a muxer
                // hint ffmpeg recognizes, so without -f the muxer probe fails
                // with "Unable to choose an output format". The tmp extension
                // stays as-is so it's obviously transient on disk.
                "-f", "mp4",
            ])
            .arg(&tmp_path)
            .output();
        let remux_ok = match &remux {
            Ok(o) if o.status.success() => true,
            Ok(o) => {
                eprintln!(
                    "[poster] mjpeg remux non-zero exit: {}",
                    String::from_utf8_lossy(&o.stderr)
                );
                false
            }
            Err(e) => {
                eprintln!("[poster] mjpeg remux spawn failed: {e}");
                false
            }
        };
        if !remux_ok {
            let _ = std::fs::remove_file(&tmp_path);
            return;
        }

        // Validate tmp: file exists, non-zero, stream 0 still a playable video
        // with attached_pic=0, stream 1 is attached_pic=1. Catches any silent
        // muxer corruption before we overwrite the sacred output.mp4.
        if !validate_poster_mp4(&tmp_path) {
            eprintln!("[poster] tmp validation failed for {}", tmp_path.display());
            let _ = std::fs::remove_file(&tmp_path);
            return;
        }

        // Atomic rename — last step, after every check has passed.
        if let Err(e) = std::fs::rename(&tmp_path, output_path) {
            eprintln!("[poster] atomic rename failed: {e}");
            let _ = std::fs::remove_file(&tmp_path);
        }
    };
    remux_and_swap();
    let _ = std::fs::remove_file(&jpg_path);
}

// Validates a poster-embedded MP4 candidate before we atomically rename
// over the sacred output. Two ffprobe calls, both `-v error` so any warning
// from a broken container surfaces as a non-zero exit.
//
//   stream v:0 — codec_type=video, disposition.attached_pic=0  (primary plays)
//   stream v:1 — disposition.attached_pic=1                    (poster flag)
fn validate_poster_mp4(path: &Path) -> bool {
    let meta_ok = path
        .metadata()
        .map(|m| m.len() > 0)
        .unwrap_or(false);
    if !meta_ok {
        return false;
    }
    let probe = |args: &[&str]| -> Option<String> {
        let out = Command::new(FFPROBE_PATH)
            .args(["-v", "error"])
            .args(args)
            .arg(path)
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        Some(String::from_utf8_lossy(&out.stdout).into_owned())
    };
    let primary = match probe(&[
        "-select_streams", "v:0",
        "-show_entries", "stream=codec_type:stream_disposition=attached_pic",
        "-of", "default=noprint_wrappers=1",
    ]) {
        Some(s) => s,
        None => return false,
    };
    if !primary.contains("codec_type=video") || !primary.contains("attached_pic=0") {
        return false;
    }
    let poster = match probe(&[
        "-select_streams", "v:1",
        "-show_entries", "stream_disposition=attached_pic",
        "-of", "default=noprint_wrappers=1",
    ]) {
        Some(s) => s,
        None => return false,
    };
    poster.contains("attached_pic=1")
}

// Phase 11 unified save. Every save re-reads the raw scratch mp4 + current
// sidecar and produces a file in ~/Movies/Zeigen/. The scratch dir is not
// touched — it survives until the review window closes, so subsequent
// saves can re-read raw + live sidecar and write a new collision slot.
//
// noop MP4-Source short-circuits to hard_link (with copy fallback) and
// skips ffmpeg entirely. All other combinations are exactly one ffmpeg
// pass through run_edit_pipeline.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn save_recording(
    app: AppHandle,
    stamp: String,
    source_path: String,
    format: String,
    resolution: String,
    fps: Option<u32>,
    watermark_logo: Option<String>,
    watermark_corner: Option<String>,
    watermark_scale: Option<f64>,
    watermark_opacity: Option<f64>,
) -> Result<SaveResult, String> {
    // Fraction 0.0-1.0 out_time_us progress from the ffmpeg pass(es) run_edit_pipeline
    // drives — the review window's Save button listens for this to show a percent.
    let on_progress = move |frac: f64| {
        if let Err(e) = app.emit("save-progress", frac) {
            eprintln!("[save-progress] emit failed: {e}");
        }
    };
    save_recording_impl(
        stamp,
        source_path,
        format,
        resolution,
        fps,
        watermark_logo,
        watermark_corner,
        watermark_scale,
        watermark_opacity,
        on_progress,
    )
}

// Split from save_recording so tests can call this directly without needing
// an AppHandle — mock_app() plumbing isn't worth it for one progress event.
#[allow(clippy::too_many_arguments)]
fn save_recording_impl(
    stamp: String,
    source_path: String,
    format: String,
    resolution: String,
    fps: Option<u32>,
    watermark_logo: Option<String>,
    watermark_corner: Option<String>,
    watermark_scale: Option<f64>,
    watermark_opacity: Option<f64>,
    on_progress: impl Fn(f64) + Send + Clone + 'static,
) -> Result<SaveResult, String> {
    let source = Path::new(&source_path);
    // Phase 15 c3: don't is_file-check source. It's the scratch logical
    // key (matches Phase 5.5 lifecycle); for webcam recordings no file
    // exists at this path because composite moved to export-time. The
    // check that matters — does the raw screen capture exist? — runs
    // inside run_edit_pipeline against screen_path, where a genuinely
    // missing screen.mp4 returns "screen capture missing: <path>".
    let watermark =
        Watermark::from_args(watermark_logo, watermark_corner, watermark_scale, watermark_opacity);

    let home = std::env::var("HOME").map_err(|_| "HOME not set".to_string())?;
    let movies = PathBuf::from(home).join("Movies/Zeigen");
    std::fs::create_dir_all(&movies)
        .map_err(|e| format!("create {}: {e}", movies.display()))?;

    let sidecar = read_sidecar_path(source)?.unwrap_or_default();

    // Phase 15 c2: route through the composite-at-export wrapper. For
    // webcam recordings this composites screen+segments fresh; for
    // screen-only recordings the wrapper delegates to the single-input
    // pipeline against source directly. webcam_size defaults to Medium — the
    // value engine_start uses today (UI controls removed in phase 8) and the
    // diameter fallback for sidecars with no logged diameter. The bubble
    // position is no longer a corner here: composite resolves the zone from
    // sidecar.bubble_zone (V2 Step 2).
    let (screen_path, segments) = export_inputs_from_source(source);
    let webcam_size = crate::composite::WebcamSize::Medium;

    let (output, route_note) = match format.as_str() {
        "mp4" => {
            let res = match resolution.as_str() {
                "480p" => Mp4Resolution::P480,
                "720p" => Mp4Resolution::P720,
                "1080p" => Mp4Resolution::P1080,
                "source" => Mp4Resolution::Source,
                other => return Err(format!("unknown mp4 resolution: {other}")),
            };
            let output = next_per_format_slot(&movies, &stamp, "mp4");
            let report = run_edit_pipeline(
                &screen_path,
                &segments,
                &output,
                &sidecar,
                PipelineMode::Mp4 { resolution: res },
                webcam_size,
                watermark,
                on_progress,
            )?;
            (output, report.route_note)
        }
        "gif" => {
            let res = match resolution.as_str() {
                "480p" => GifResolution::P480,
                "720p" => GifResolution::P720,
                "source" => GifResolution::Source,
                other => return Err(format!("unknown gif resolution: {other}")),
            };
            let fps = fps.ok_or_else(|| "fps required for gif format".to_string())?;
            let output = next_per_format_slot(&movies, &stamp, "gif");
            let report = run_edit_pipeline(
                &screen_path,
                &segments,
                &output,
                &sidecar,
                PipelineMode::Gif { resolution: res, fps },
                webcam_size,
                watermark,
                on_progress,
            )?;
            (output, report.route_note)
        }
        other => return Err(format!("unknown format: {other}")),
    };

    // Poster pass — best-effort, never propagates Err. output is sacred
    // from here; the helper writes the .jpg sidecar and, for MP4 only,
    // attempts the attached_pic remux via tmp + ffprobe validate + atomic
    // rename. Any failure leaves output intact, the toast flag still
    // reflects whether the user's pick was within the trim range.
    let is_mp4 = format.as_str() == "mp4";
    try_embed_poster(&output, &sidecar, is_mp4);

    Ok(SaveResult {
        output_path: output.to_string_lossy().into_owned(),
        thumbnail_out_of_trim: thumbnail_out_of_trim(&sidecar),
        route_note,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // The exact bytes write_sidecar_path produced BEFORE the zoom field
    // existed (captured from serde_json::to_string_pretty at e29d638) for a
    // sidecar exercising every pre-zoom field. Byte-equality against this pin
    // is the step-2 governing invariant: a no-zoom recording's sidecar must
    // be textually indistinguishable from a pre-zoom one, so it rides the
    // existing copy path and guards unchanged.
    const PRE_ZOOM_SIDECAR_PIN: &str = r##"{
  "trim": {
    "in": 1.25,
    "out": 42.5
  },
  "annotations": [
    {
      "type": "text",
      "start_time": 2.0,
      "end_time": 5.0,
      "position": {
        "x": 0.25,
        "y": 0.4
      },
      "content": "Look here",
      "size": 48.0
    },
    {
      "type": "arrow",
      "start_time": 3.0,
      "end_time": 6.0,
      "position": {
        "x": 0.1,
        "y": 0.2
      },
      "content": "",
      "endpoint": {
        "x": 0.6,
        "y": 0.7
      },
      "stroke": 12.0
    }
  ],
  "bubble_position_log": [
    {
      "t": 0.0,
      "x": 0.9,
      "y": 0.85,
      "diameter_frac": 0.15873015873015872
    }
  ],
  "thumbnail_time": 7.5,
  "bubble_roundness": 0.35,
  "annotation_color": "#FF3B30"
}"##;

    fn pre_zoom_populated_state() -> SidecarState {
        SidecarState {
            trim: Some(Trim { start: 1.25, out: 42.5 }),
            annotations: vec![
                Annotation {
                    kind: "text".into(),
                    start_time: 2.0,
                    end_time: 5.0,
                    position: Position { x: 0.25, y: 0.4 },
                    content: "Look here".into(),
                    size: Some(48.0),
                    endpoint: None,
                    stroke: None,
                },
                Annotation {
                    kind: "arrow".into(),
                    start_time: 3.0,
                    end_time: 6.0,
                    position: Position { x: 0.1, y: 0.2 },
                    content: String::new(),
                    size: None,
                    endpoint: Some(Position { x: 0.6, y: 0.7 }),
                    stroke: Some(12.0),
                },
            ],
            bubble_position_log: vec![BubblePositionEntry {
                t: 0.0,
                x: 0.9,
                y: 0.85,
                diameter_frac: Some(240.0 / 1512.0),
            }],
            thumbnail_time: Some(7.5),
            bubble_roundness: Some(0.35),
            bubble_zone: None,
            annotation_color: Some("#FF3B30".into()),
            zoom: vec![],
        }
    }

    // Structural half of the invariant: an empty zoom track cannot
    // serialize. In memory and through write_sidecar_path, a no-zoom state
    // produces the pinned pre-zoom bytes exactly.
    #[test]
    fn empty_zoom_serializes_absent_byte_identical_to_pre_zoom() {
        let state = pre_zoom_populated_state();
        assert_eq!(
            serde_json::to_string_pretty(&state).unwrap(),
            PRE_ZOOM_SIDECAR_PIN
        );
        // Untouched-recording shape (no sidecar fields at all).
        assert_eq!(
            serde_json::to_string_pretty(&SidecarState::default()).unwrap(),
            "{\n  \"annotations\": []\n}"
        );
        // Same through the disk path the app actually uses.
        let dir = std::env::temp_dir().join(format!("zeigen-zoom-pin-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let source = dir.join("recording-pin.mp4");
        write_sidecar_path(&source, &state).unwrap();
        assert_eq!(
            std::fs::read_to_string(sidecar_path(&source)).unwrap(),
            PRE_ZOOM_SIDECAR_PIN
        );
    }

    // A wiped track written as "zoom": [] (hand edit, sloppy writer) parses
    // and re-serializes with the key gone — not as [] and not as null.
    #[test]
    fn zoom_empty_array_input_normalizes_to_absent() {
        let mut with_empty: serde_json::Value =
            serde_json::from_str(PRE_ZOOM_SIDECAR_PIN).unwrap();
        with_empty["zoom"] = serde_json::json!([]);
        let state: SidecarState = serde_json::from_value(with_empty).unwrap();
        assert_eq!(state, pre_zoom_populated_state());
        assert_eq!(
            serde_json::to_string_pretty(&state).unwrap(),
            PRE_ZOOM_SIDECAR_PIN
        );
    }

    // A non-empty track survives serialize -> parse -> serialize with no
    // loss, in memory and through the disk path. Omitted per-keyframe
    // fields default sanely (ease in_out_cubic, auto_generated false).
    #[test]
    fn zoom_track_round_trips_losslessly() {
        let mut state = pre_zoom_populated_state();
        state.zoom = vec![
            ZoomKeyframe {
                t: 4.0,
                scale: 1.0,
                center_x: 960.0,
                center_y: 540.0,
                ease: Ease::InOutCubic,
                auto_generated: true,
            },
            ZoomKeyframe {
                t: 4.6,
                scale: 2.5,
                center_x: 800.0,
                center_y: 450.0,
                ease: Ease::Linear,
                auto_generated: false,
            },
        ];
        let json = serde_json::to_string_pretty(&state).unwrap();
        let reparsed: SidecarState = serde_json::from_str(&json).unwrap();
        assert_eq!(reparsed, state);

        let dir = std::env::temp_dir().join(format!("zeigen-zoom-rt-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let source = dir.join("recording-rt.mp4");
        write_sidecar_path(&source, &state).unwrap();
        assert_eq!(read_sidecar_path(&source).unwrap().unwrap(), state);

        let sparse: ZoomKeyframe = serde_json::from_str(
            r#"{"t": 1.0, "scale": 1.8, "center_x": 100.0, "center_y": 200.0}"#,
        )
        .unwrap();
        assert_eq!(sparse.ease, Ease::InOutCubic);
        assert!(!sparse.auto_generated);
    }

    // GATE 1 (teardown) — the plain-MP4 tail (run_plain_mp4) survives the removal
    // of the V2 body byte-for-byte. Two guards:
    //   (a) runtime: a plain no-edit save keeps the video stream bit-exact (-c:v
    //       copy) while audio re-encodes (arnndn + AAC). md5, not "it runs".
    //   (b) arg pin: build_plain_mp4_args produces the SAME ffmpeg command the
    //       pre-teardown single_input built for copy / trim-only / downscale-only
    //       (captured before deletion). Copy is bit-exact by the copy contract;
    //       trim + downscale re-encode, so "same command" IS the proof they match.
    #[test]
    fn empty_zoom_stays_on_video_copy_path() {
        ensure_audio_model_for_tests();
        let dir =
            std::env::temp_dir().join(format!("zeigen-zoom-copypath-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let source = dir.join("source.mp4");
        let synth = Command::new(FFMPEG_PATH)
            .args([
                "-y", "-v", "error",
                "-f", "lavfi", "-i", "testsrc2=duration=2:size=320x240:rate=30",
                "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
                "-c:v", "libx264", "-pix_fmt", "yuv420p",
                "-c:a", "aac", "-shortest",
            ])
            .arg(&source)
            .output()
            .expect("spawn ffmpeg synth");
        assert!(
            synth.status.success(),
            "synth source failed: {}",
            String::from_utf8_lossy(&synth.stderr)
        );
        let src_v = stream_md5(source.to_str().unwrap(), "0:v");
        let src_a = stream_md5(source.to_str().unwrap(), "0:a");

        // (a) Runtime copy-path guard through the real dispatch (routes plain ->
        // run_plain_mp4). Video bit-exact to source; audio changed.
        let out_plain = dir.join("out-plain.mp4");
        run_edit_pipeline(
            &source,
            &[],
            &out_plain,
            &SidecarState::default(),
            PipelineMode::Mp4 { resolution: Mp4Resolution::Source },
            crate::composite::WebcamSize::Medium,
            None,
            |_| {},
        )
        .expect("plain save");
        assert_eq!(
            stream_md5(out_plain.to_str().unwrap(), "0:v"),
            src_v,
            "plain save must stay on -c:v copy (video bit-exact)"
        );
        assert_ne!(
            stream_md5(out_plain.to_str().unwrap(), "0:a"),
            src_a,
            "audio should re-encode (arnndn + AAC)"
        );

        // (b) Arg-vector pin vs the pre-teardown single_input command. af=None
        // (test env has no NR model, matching the before-capture). Fixed paths so
        // no normalization is needed. These strings ARE the before-capture.
        let src = Path::new("/S/in.mp4");
        let out = Path::new("/S/out.mp4");
        let copy = build_plain_mp4_args(src, out, None, 2.0, None, None).unwrap();
        assert_eq!(
            copy.join(" "),
            "-y -hide_banner -nostats -progress pipe:1 -i /S/in.mp4 \
-c:v copy -c:a aac -b:a 192k -movflags +faststart /S/out.mp4",
            "copy fast path command must be byte-identical to pre-teardown"
        );
        let trim = Trim { start: 0.5, out: 1.5 };
        let trimmed = build_plain_mp4_args(src, out, Some(&trim), 2.0, None, None).unwrap();
        assert_eq!(
            trimmed.join(" "),
            "-y -hide_banner -nostats -progress pipe:1 -ss 0.500 -to 1.500 -i /S/in.mp4 \
-c:v h264_videotoolbox -b:v 8M -profile:v high -pix_fmt yuv420p -tag:v avc1 -allow_sw 1 \
-c:a aac -b:a 192k -movflags +faststart /S/out.mp4",
            "trim-only command must be byte-identical to pre-teardown"
        );
        let ds = build_plain_mp4_args(src, out, None, 2.0, Some(Mp4Resolution::P480), None).unwrap();
        assert_eq!(
            ds.join(" "),
            "-y -hide_banner -nostats -progress pipe:1 -i /S/in.mp4 \
-filter_complex [0:v]scale=-2:480:flags=lanczos[v0] -map [v0] -map 0:a? \
-c:v h264_videotoolbox -b:v 8M -profile:v high -pix_fmt yuv420p -tag:v avc1 -allow_sw 1 \
-c:a aac -b:a 192k -movflags +faststart /S/out.mp4",
            "downscale-only command must be byte-identical to pre-teardown"
        );
    }

    // Segment reconstruction must mirror Review.tsx zoomKeyframesToSegments so
    // the exported curve matches the preview. Keep in sync with the TS side.
    #[test]
    fn zoom_segments_mirror_preview() {
        let kf = |t: f64, scale: f64, cx: f64| ZoomKeyframe {
            t,
            scale,
            center_x: cx,
            center_y: 50.0,
            ease: Ease::InOutCubic,
            auto_generated: false,
        };
        // Canonical single window: span is edge-scale-1 keyframe to the next;
        // peak interior scale + its center define it.
        let segs = zoom_keyframes_to_segments(&[
            kf(0.3, 1.0, 100.0),
            kf(0.9, 2.0, 160.0),
            kf(1.1, 2.0, 160.0),
            kf(1.7, 1.0, 100.0),
        ]);
        assert_eq!(segs.len(), 1);
        assert!((segs[0].start - 0.3).abs() < 1e-9 && (segs[0].end - 1.7).abs() < 1e-9);
        assert!((segs[0].scale - 2.0).abs() < 1e-9 && (segs[0].cx - 160.0).abs() < 1e-9);

        // Two windows stay separate.
        let two = zoom_keyframes_to_segments(&[
            kf(0.0, 1.0, 0.0),
            kf(0.5, 1.5, 20.0),
            kf(1.0, 1.0, 0.0),
            kf(2.0, 1.0, 0.0),
            kf(2.5, 2.5, 90.0),
            kf(3.0, 1.0, 0.0),
        ]);
        assert_eq!(two.len(), 2);
        assert!((two[0].scale - 1.5).abs() < 1e-9 && (two[1].scale - 2.5).abs() < 1e-9);

        // No effective zoom -> no segments (stays on the copy path).
        assert!(zoom_keyframes_to_segments(&[]).is_empty());
        assert!(zoom_keyframes_to_segments(&[kf(0.0, 1.0, 0.0), kf(1.0, 1.0, 0.0)]).is_empty());
    }

    // The OnceLock set in lib.rs::run setup doesn't fire under cargo test,
    // so any test that hits the MP4 branch (where arnndn is wired) must
    // initialize the model path itself. Idempotent — OnceLock::set is a
    // no-op after the first call.
    fn ensure_audio_model_for_tests() {
        let p = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources/audio/rnnoise.rnnn");
        assert!(p.exists(), "test fixture missing: {}", p.display());
        set_audio_model_path(p);
    }

    // Verifies the ffprobe audio-track probe returns a valid start_time +
    // duration for a known recording with a mic-startup gap, and that the
    // audio duration is strictly less than the video duration (the V−A
    // bug premise). Run explicitly:
    //   cargo test --lib probe_audio_track_baseline -- --ignored --nocapture
    // Synthesize a self-contained test source: h264 video + a sine AAC track
    // that can be made shorter than the video (adur < vdur) to mirror the real
    // SCK capture artifact. Replaces the vanished May baseline fixtures — the
    // guards below are relational (copy holds / arnndn ran / dims / audio<video),
    // so any conforming input works and they no longer depend on out-of-repo
    // recordings. Note: this pins TODAY's behavior, not the original May
    // reference (DECISIONS.md 2026-07-14) — its job is to catch a plain-export
    // regression while zoom export is added, not to reproduce the historical net.
    fn synth_source(dir: &Path, name: &str, vdur: f64, adur: f64, w: u32, h: u32) -> PathBuf {
        let source = dir.join(name);
        let out = Command::new(FFMPEG_PATH)
            .args([
                "-y", "-v", "error",
                "-f", "lavfi", "-i", &format!("testsrc2=duration={vdur}:size={w}x{h}:rate=30"),
                "-f", "lavfi", "-i", &format!("sine=frequency=440:duration={adur}"),
                "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
            ])
            .arg(&source)
            .output()
            .expect("spawn ffmpeg synth");
        assert!(out.status.success(), "synth source: {}", String::from_utf8_lossy(&out.stderr));
        source
    }

    #[test]
    fn probe_audio_track_baseline() {
        let dir = std::env::temp_dir().join(format!("zeigen-probe-audio-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // Audio deliberately shorter than video (2.5 < 3.0), the property this
        // guard exists to pin (SCK audio ends before video).
        let source = synth_source(&dir, "source.mp4", 3.0, 2.5, 640, 480);

        let meta = probe_audio_track_path(&source)
            .expect("probe")
            .expect("audio track present");
        let video_duration = probe_duration_seconds(&source).expect("video duration");
        assert!(
            meta.start >= 0.0 && meta.start < 1.0,
            "start out of range: {}",
            meta.start
        );
        assert!(meta.duration > 0.0, "duration must be > 0");
        assert!(
            meta.duration < video_duration,
            "audio duration {} should be < video {}",
            meta.duration,
            video_duration
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    // Phase 14 c2 D-08 measurement. Times the arnndn pass against the
    // c1 scratch baseline. Threshold: <2s → eager (block review video swap),
    // ≥2s → lazy (raw plays until preview ready). Asserts the preview audio
    // stream md5 differs from source (arnndn ran) and duration is preserved.
    //   cargo test --lib render_preview_audio_baseline -- --ignored --nocapture
    #[test]
    fn render_preview_audio_baseline() {
        ensure_audio_model_for_tests();
        let dir = std::env::temp_dir().join(format!("zeigen-preview-audio-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let source = synth_source(&dir, "source.mp4", 3.0, 3.0, 640, 480);
        let preview = dir.join("preview.mp4");

        render_preview_audio_path(&source, &preview).expect("render preview");
        assert!(preview.exists(), "preview file not created");

        let src_dur = probe_duration_seconds(&source).expect("source duration");
        let prev_dur = probe_duration_seconds(&preview).expect("preview duration");
        assert!(
            (src_dur - prev_dur).abs() < 0.15,
            "duration mismatch: src={src_dur} prev={prev_dur}"
        );
        assert_ne!(
            stream_md5(&source.to_string_lossy(), "0:a:0"),
            stream_md5(&preview.to_string_lossy(), "0:a:0"),
            "preview audio should differ from source (arnndn applied)"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    // End-to-end check that the MP4 path through run_edit_pipeline honors a
    // source + sidecar (trim + text + arrow) on Source resolution (output dims
    // match input) and downscales to 720 on P720. Self-contained synth source;
    // sidecar built in-code (the May fixture that carried these edits is gone).
    #[test]
    fn mp4_save_baseline() {
        ensure_audio_model_for_tests();
        let dir = std::env::temp_dir().join(format!("zeigen-mp4-save-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // 1080-tall so P720 actually downscales (Fix A skips a non-shrinking scale).
        let source = synth_source(&dir, "source.mp4", 3.0, 2.8, 1920, 1080);
        // Sidecar carrying the edits this guard exercises: trim + text + arrow
        // annotations -> rasterization + trim + resolution paths.
        let sidecar = SidecarState {
            trim: Some(Trim { start: 0.2, out: 2.5 }),
            annotations: vec![
                Annotation {
                    kind: "text".into(), start_time: 0.0, end_time: 2.0,
                    position: Position { x: 0.3, y: 0.3 }, content: "guard".into(),
                    size: Some(36.0), endpoint: None, stroke: None,
                },
                Annotation {
                    kind: "arrow".into(), start_time: 0.0, end_time: 2.0,
                    position: Position { x: 0.2, y: 0.2 }, content: String::new(),
                    size: None, endpoint: Some(Position { x: 0.6, y: 0.6 }), stroke: Some(6.0),
                },
            ],
            ..Default::default()
        };

        // --- Source resolution: output dims match input (no scale node) ---
        let src_out = dir.join("out-source.mp4");
        run_edit_pipeline(
            &source, &[], &src_out, &sidecar,
            PipelineMode::Mp4 { resolution: Mp4Resolution::Source },
            crate::composite::WebcamSize::Medium,
            None, |_| {},
        )
        .expect("source pipeline");
        let (iw, ih) = probe_dimensions(&source).expect("probe input dims");
        let (sw, sh) = probe_dimensions(&src_out).expect("probe source-out dims");
        assert_eq!(
            (sw, sh), (iw, ih),
            "Source output dims {sw}x{sh} should match input {iw}x{ih}"
        );

        // --- P720 resolution: 1080 -> 720 tall ---
        let p720_out = dir.join("out-p720.mp4");
        run_edit_pipeline(
            &source, &[], &p720_out, &sidecar,
            PipelineMode::Mp4 { resolution: Mp4Resolution::P720 },
            crate::composite::WebcamSize::Medium,
            None, |_| {},
        )
        .expect("p720 pipeline");
        let (_, h720) = probe_dimensions(&p720_out).expect("probe p720 dims");
        assert_eq!(h720, 720, "P720 output height should be 720, got {h720}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    // Phase 11 c2 smoke (updated in Phase 12 c3). Covers:
    //   - noop sidecar + MP4-Source → audio-only re-encode (arnndn + AAC)
    //     with -c:v copy. Output is a fresh file (not a hard-link); the
    //     video stream md5 matches the source's video stream; the audio
    //     stream md5 differs (arnndn applied).
    //   - sidecar w/ edits + MP4-P720 → full pipeline, 720 tall, video
    //     stream md5 differs from source.
    //   - sidecar w/ edits + GIF-P720@15 → 1 pass, valid GIF
    //   - per-format collision: second MP4-Source call lands at -2.mp4
    // Run explicitly:
    //   cargo test --lib save_recording_baseline -- --ignored --nocapture
    fn stream_md5(path: &str, stream: &str) -> String {
        let out = Command::new(FFMPEG_PATH)
            .args([
                "-v", "error", "-i", path, "-map", stream, "-c", "copy",
                "-f", "md5", "-",
            ])
            .output()
            .expect("ffmpeg md5");
        assert!(out.status.success(), "ffmpeg md5 failed for {path} {stream}");
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    // ---- V3 switchover verification ----

    fn ffprobe_field(path: &Path, entries: &str, stream: &str) -> String {
        let out = Command::new(FFPROBE_PATH)
            .args(["-v", "error", "-select_streams", stream, "-show_entries", entries,
                   "-of", "default=noprint_wrappers=1:nokey=1"])
            .arg(path)
            .output()
            .expect("ffprobe");
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    // Direction 1 end-to-end: run_v3_export actually spawns cicompositor, muxes the
    // screen audio, and writes a playable mp4 at source dims with the 709 color tags
    // V3 sets correctly (the discriminator vs V2's dropped transfer/primaries). Runs
    // the real Rust wiring on a synthetic recording (screen+audio, webcam, zoom,
    // bubble, watermark), independent of the settings flag.
    #[test]
    fn v3_export_produces_tagged_mp4_with_audio() {
        ensure_audio_model_for_tests();
        let dir = std::env::temp_dir().join(format!("zeigen-v3-export-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let screen = synth_source(&dir, "screen.mp4", 2.0, 2.0, 320, 240);
        // Webcam segment: video-only, distinct pattern.
        let webcam = dir.join("webcam-00.mp4");
        let wc = Command::new(FFMPEG_PATH)
            .args(["-y", "-v", "error", "-f", "lavfi", "-i",
                   "testsrc=duration=2:size=160x160:rate=30", "-c:v", "libx264",
                   "-pix_fmt", "yuv420p"])
            .arg(&webcam).output().expect("webcam synth");
        assert!(wc.status.success(), "webcam synth: {}", String::from_utf8_lossy(&wc.stderr));
        // Watermark logo PNG.
        let logo = dir.join("logo.png");
        let lg = Command::new(FFMPEG_PATH)
            .args(["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=red:s=48x48",
                   "-frames:v", "1"])
            .arg(&logo).output().expect("logo synth");
        assert!(lg.status.success(), "logo synth: {}", String::from_utf8_lossy(&lg.stderr));

        let kf = |t: f64, scale: f64| ZoomKeyframe {
            t, scale, center_x: 160.0, center_y: 120.0, ease: Ease::InOutCubic,
            auto_generated: false,
        };
        let sidecar = SidecarState {
            zoom: vec![kf(0.3, 1.0), kf(0.9, 2.0), kf(1.1, 2.0), kf(1.7, 1.0)],
            bubble_position_log: vec![BubblePositionEntry {
                t: 0.0, x: 0.9, y: 0.85, diameter_frac: Some(120.0 / 1512.0),
            }],
            bubble_zone: Some(crate::composite::BubbleZone::BottomRight),
            ..Default::default()
        };
        let wm = Watermark::from_args(
            Some(logo.to_string_lossy().into_owned()), Some("tr".into()), None, None,
        );
        let out = dir.join("out.mp4");
        run_v3_export(
            &screen,
            std::slice::from_ref(&webcam),
            &out,
            &sidecar,
            crate::composite::WebcamSize::Medium,
            wm.as_ref(),
            Mp4Resolution::Source,
            |_| {},
        )
        .expect("v3 export");

        assert!(out.is_file() && std::fs::metadata(&out).unwrap().len() > 0, "output written");
        assert_eq!(probe_dimensions(&out).unwrap(), (320, 240), "source res preserved");
        // Audio muxed from the screen source.
        assert_eq!(ffprobe_field(&out, "stream=codec_type", "a:0"), "audio", "audio present");
        // V3 tags the transfer/primaries (V2's known bug drops them).
        assert_eq!(ffprobe_field(&out, "stream=color_transfer", "v:0"), "bt709",
            "V3 output carries the 709 transfer tag");

        let _ = std::fs::remove_dir_all(&dir);
    }

    // Downscale and webcam-without-zoom are V3 paths now (reclaimed from V2).
    // Downscale: run_v3_export renders at source res then Lanczos-downscales to the
    // target dims — assert the output lands at the requested height with an even,
    // aspect-preserved width matching V2's mp4_scale `-2:480` (1280x720 -> 854x480),
    // still 709-tagged with audio. Webcam-no-zoom: a static frame + bubble renders
    // and muxes cleanly at source res (empty zoom segments are a no-op, not a fail).
    #[test]
    fn v3_downscale_and_webcam_no_zoom_exports() {
        ensure_audio_model_for_tests();
        let dir = std::env::temp_dir().join(format!("zeigen-v3-reclaim-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let screen = synth_source(&dir, "screen.mp4", 2.0, 2.0, 1280, 720);
        let webcam = dir.join("webcam-00.mp4");
        let wc = Command::new(FFMPEG_PATH)
            .args(["-y", "-v", "error", "-f", "lavfi", "-i",
                   "testsrc=duration=2:size=160x160:rate=30", "-c:v", "libx264",
                   "-pix_fmt", "yuv420p"])
            .arg(&webcam).output().expect("webcam synth");
        assert!(wc.status.success(), "webcam synth: {}", String::from_utf8_lossy(&wc.stderr));

        let kf = |t: f64, scale: f64| ZoomKeyframe {
            t, scale, center_x: 640.0, center_y: 360.0, ease: Ease::InOutCubic,
            auto_generated: false,
        };
        let zoomed = SidecarState {
            zoom: vec![kf(0.3, 1.0), kf(0.9, 2.0), kf(1.1, 2.0), kf(1.7, 1.0)],
            ..Default::default()
        };

        // (a) Downscale to 480p with zoom (formerly "fb:480p downscale").
        let out480 = dir.join("out-480.mp4");
        run_v3_export(&screen, &[], &out480, &zoomed,
            crate::composite::WebcamSize::Medium, None, Mp4Resolution::P480, |_| {})
            .expect("v3 480p export");
        let (dw, dh) = probe_dimensions(&out480).unwrap();
        assert_eq!(dh, 480, "480p downscale height");
        assert_eq!(dw, 854, "aspect-preserved even width (1280*480/720 -> 854), matches V2 -2:480");
        assert_eq!(ffprobe_field(&out480, "stream=color_transfer", "v:0"), "bt709",
            "downscaled V3 still tags 709");
        assert_eq!(ffprobe_field(&out480, "stream=codec_type", "a:0"), "audio",
            "downscaled export keeps audio");

        // (b) Webcam WITHOUT zoom at Source res (formerly "fb:webcam without zoom").
        let no_zoom = SidecarState {
            bubble_zone: Some(crate::composite::BubbleZone::BottomRight),
            ..Default::default()
        };
        let outwc = dir.join("out-wc.mp4");
        run_v3_export(&screen, std::slice::from_ref(&webcam), &outwc, &no_zoom,
            crate::composite::WebcamSize::Medium, None, Mp4Resolution::Source, |_| {})
            .expect("v3 webcam-no-zoom export");
        assert_eq!(probe_dimensions(&outwc).unwrap(), (1280, 720), "source res preserved");
        assert_eq!(ffprobe_field(&outwc, "stream=codec_type", "a:0"), "audio",
            "webcam-no-zoom export keeps audio");

        let _ = std::fs::remove_dir_all(&dir);
    }

    // Multi-segment webcam (Continuity drop) -> V3 concatenates the segments
    // back-to-back into one bubble stream and returns a drift caveat note. Also
    // proves the COMMON case (a single clean segment) returns Ok(None) — no note,
    // no concat — so the concat path only exists when it must.
    #[test]
    fn v3_multi_segment_webcam_concats_and_notes_drift() {
        ensure_audio_model_for_tests();
        let dir = std::env::temp_dir().join(format!("zeigen-v3-multiseg-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // Screen spans 3s; webcam covers 1.5 + 1.0 = 2.5s -> ~0.5s of downtime.
        let screen = synth_source(&dir, "screen.mp4", 3.0, 3.0, 1280, 720);
        let synth_wc = |name: &str, dur: f64| {
            let p = dir.join(name);
            let r = Command::new(FFMPEG_PATH)
                .args(["-y", "-v", "error", "-f", "lavfi", "-i",
                       &format!("testsrc=duration={dur}:size=160x160:rate=30"),
                       "-c:v", "libx264", "-pix_fmt", "yuv420p"])
                .arg(&p).output().expect("webcam synth");
            assert!(r.status.success(), "webcam synth: {}", String::from_utf8_lossy(&r.stderr));
            p
        };
        let seg0 = synth_wc("webcam-00.mp4", 1.5);
        let seg1 = synth_wc("webcam-01.mp4", 1.0);
        let sidecar = SidecarState {
            bubble_zone: Some(crate::composite::BubbleZone::BottomRight),
            ..Default::default()
        };

        // --- Common case: single clean segment -> no concat, no note. ---
        let out_one = dir.join("out-one.mp4");
        let note_one = run_v3_export(&screen, std::slice::from_ref(&seg0), &out_one, &sidecar,
            crate::composite::WebcamSize::Medium, None, Mp4Resolution::Source, |_| {})
            .expect("v3 single-segment export");
        assert!(note_one.is_none(), "single segment carries no caveat note");
        assert_eq!(ffprobe_field(&out_one, "stream=codec_type", "a:0"), "audio");

        // --- Multi-segment: concat + drift note. ---
        let out_multi = dir.join("out-multi.mp4");
        let note = run_v3_export(&screen, &[seg0.clone(), seg1.clone()], &out_multi, &sidecar,
            crate::composite::WebcamSize::Medium, None, Mp4Resolution::Source, |_| {})
            .expect("v3 multi-segment export")
            .expect("multi-segment export carries a caveat note");
        // The note is specific about direction and magnitude (owner's ask).
        assert!(note.contains("2 segments"), "note names the segment count: {note}");
        assert!(note.contains("AHEAD of the audio"), "note gives drift direction: {note}");
        assert!(note.contains("freezes on its last frame"), "note describes the tail: {note}");
        // ~0.5s downtime, formatted to one decimal.
        assert!(note.contains("0.5s"), "note quantifies the downtime (~0.5s): {note}");
        // Output is a valid, playable mp4 at source res with the screen audio.
        assert_eq!(probe_dimensions(&out_multi).unwrap(), (1280, 720), "source res preserved");
        assert_eq!(ffprobe_field(&out_multi, "stream=codec_type", "a:0"), "audio",
            "multi-segment export keeps audio");

        let _ = std::fs::remove_dir_all(&dir);
    }

    // ---- GIF port gate (commit 5) ----------------------------------------------
    // Decoded frame count of a video/GIF.
    fn frame_count(path: &Path) -> u64 {
        let out = Command::new(FFPROBE_PATH)
            .args(["-v", "error", "-select_streams", "v:0", "-count_frames",
                   "-show_entries", "stream=nb_read_frames",
                   "-of", "default=noprint_wrappers=1:nokey=1"])
            .arg(path).output().expect("ffprobe frames");
        String::from_utf8_lossy(&out.stdout).trim().parse().unwrap_or(0)
    }

    // Plain / trim-only / downscale-only GIF stays on run_plain_gif. Byte-parity
    // with V2's single_input GIF was proven md5-identical at the port (banked, V2
    // now deleted); the ongoing guard is (a) the palettegen filter string is
    // pinned exactly — the graph that determines the GIF's bytes — and (b) each
    // case produces a valid GIF89a end to end.
    #[test]
    fn gif_plain_path_byte_identical() {
        // (a) Filter-string pin: the plain path's one-pass palettegen graph. A
        // byte change here is what would move the output GIF's bytes.
        assert_eq!(
            gif_palette_filter("0:v", GifResolution::Source, 15),
            "[0:v]fps=15,scale='min(iw,1920)':-2:flags=lanczos,split[gA][gB];\
[gA]palettegen=stats_mode=diff[gP];[gB][gP]paletteuse=dither=bayer:bayer_scale=5[gout]"
        );
        assert_eq!(
            gif_palette_filter("0:v", GifResolution::P720, 15),
            "[0:v]fps=15,scale=-2:720:flags=lanczos,split[gA][gB];\
[gA]palettegen=stats_mode=diff[gP];[gB][gP]paletteuse=dither=bayer:bayer_scale=5[gout]"
        );
        assert_eq!(
            gif_palette_filter("0:v", GifResolution::P480, 12),
            "[0:v]fps=12,scale=-2:480:flags=lanczos,split[gA][gB];\
[gA]palettegen=stats_mode=diff[gP];[gB][gP]paletteuse=dither=bayer:bayer_scale=5[gout]"
        );

        // (b) End-to-end validity across plain / downscale / trim-only.
        let dir = std::env::temp_dir().join(format!("zeigen-gif-plain-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let source = synth_source(&dir, "screen.mp4", 2.0, 2.0, 1280, 720);
        let cases: [(&str, SidecarState, GifResolution, u32); 4] = [
            ("plain-source", SidecarState::default(), GifResolution::Source, 15),
            ("plain-720", SidecarState::default(), GifResolution::P720, 15),
            ("plain-480", SidecarState::default(), GifResolution::P480, 12),
            ("trim-only",
                SidecarState { trim: Some(Trim { start: 0.4, out: 1.6 }), ..Default::default() },
                GifResolution::P480, 15),
        ];
        for (name, sidecar, res, fps) in cases {
            let plain = dir.join(format!("{name}-plain.gif"));
            run_plain_gif(&source, &plain, &sidecar, res, fps, |_| {})
                .expect("run_plain_gif");
            let b = std::fs::read(&plain).expect("read plain");
            assert_eq!(&b[..6], b"GIF89a", "{name}: valid GIF header");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    // Edited GIF (zoom/webcam/watermark) renders on cicompositor then palettegen via
    // run_v3_gif: valid GIF at the requested height (GifResolution scale done by the
    // palette pass, not the compositor), and frame-count parity with V2 for a zoomed
    // GIF (the shared fps filter + duration set the count identically on both paths).
    #[test]
    fn gif_v3_edited_valid_and_frame_parity() {
        let dir = std::env::temp_dir().join(format!("zeigen-gif-v3-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let screen = synth_source(&dir, "screen.mp4", 2.0, 2.0, 1280, 720);
        let webcam = dir.join("webcam-00.mp4");
        let wc = Command::new(FFMPEG_PATH)
            .args(["-y", "-v", "error", "-f", "lavfi", "-i",
                   "testsrc=duration=2:size=160x160:rate=30", "-c:v", "libx264",
                   "-pix_fmt", "yuv420p"])
            .arg(&webcam).output().expect("webcam synth");
        assert!(wc.status.success(), "webcam synth: {}", String::from_utf8_lossy(&wc.stderr));
        let logo = dir.join("logo.png");
        let lg = Command::new(FFMPEG_PATH)
            .args(["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=red:s=48x48",
                   "-frames:v", "1"])
            .arg(&logo).output().expect("logo synth");
        assert!(lg.status.success(), "logo synth: {}", String::from_utf8_lossy(&lg.stderr));

        let kf = |t: f64, scale: f64| ZoomKeyframe {
            t, scale, center_x: 640.0, center_y: 360.0, ease: Ease::InOutCubic,
            auto_generated: false,
        };
        let zoomed = SidecarState {
            zoom: vec![kf(0.3, 1.0), kf(0.9, 2.0), kf(1.1, 2.0), kf(1.7, 1.0)],
            ..Default::default()
        };
        let wm = Watermark::from_args(
            Some(logo.to_string_lossy().into_owned()), Some("tr".into()), None, None,
        );
        let is_gif = |p: &Path| &std::fs::read(p).expect("read gif")[..6] == b"GIF89a";

        // (a) zoom GIF at 720p -> valid, height 720.
        let gz = dir.join("zoom.gif");
        run_v3_gif(&screen, &[], &gz, &zoomed,
            crate::composite::WebcamSize::Medium, None, GifResolution::P720, 15, |_| {})
            .expect("v3 zoom gif");
        assert!(is_gif(&gz), "zoom gif valid");
        assert_eq!(probe_dimensions(&gz).unwrap().1, 720, "720p gif height");

        // (b) zoom+webcam GIF at 480p -> valid, 854x480 (aspect-preserved, matches -2:480).
        let gzw = dir.join("zoomwc.gif");
        run_v3_gif(&screen, std::slice::from_ref(&webcam), &gzw, &zoomed,
            crate::composite::WebcamSize::Medium, None, GifResolution::P480, 12, |_| {})
            .expect("v3 zoom+wc gif");
        assert!(is_gif(&gzw), "zoom+wc gif valid");
        assert_eq!(probe_dimensions(&gzw).unwrap(), (854, 480), "480p gif dims");

        // (c) watermark-only GIF -> valid.
        let gwm = dir.join("wm.gif");
        run_v3_gif(&screen, &[], &gwm, &SidecarState::default(),
            crate::composite::WebcamSize::Medium, wm.as_ref(), GifResolution::Source, 15, |_| {})
            .expect("v3 wm gif");
        assert!(is_gif(&gwm), "watermark gif valid");

        // Absolute frame count: the whole 2.0s clip at fps=15 -> ~30 frames (the
        // shared fps filter + source duration set the count; V2 parity banked).
        let c3 = frame_count(&gz);
        assert!((c3 as i64 - 30).abs() <= 1,
            "zoom gif frame count {c3} ~= 2.0s * 15fps");

        let _ = std::fs::remove_dir_all(&dir);
    }

    // Multi-segment webcam (Continuity drop) GIF surfaces the SAME drift caveat an
    // MP4 does (run_v3_gif shares v3_render's concat), and the single clean segment
    // returns Ok(None).
    #[test]
    fn gif_v3_multiseg_drift_caveat() {
        let dir = std::env::temp_dir().join(format!("zeigen-gif-multiseg-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let screen = synth_source(&dir, "screen.mp4", 3.0, 3.0, 1280, 720);
        let synth_wc = |name: &str, dur: f64| {
            let p = dir.join(name);
            let r = Command::new(FFMPEG_PATH)
                .args(["-y", "-v", "error", "-f", "lavfi", "-i",
                       &format!("testsrc=duration={dur}:size=160x160:rate=30"),
                       "-c:v", "libx264", "-pix_fmt", "yuv420p"])
                .arg(&p).output().expect("webcam synth");
            assert!(r.status.success(), "webcam synth: {}", String::from_utf8_lossy(&r.stderr));
            p
        };
        let seg0 = synth_wc("webcam-00.mp4", 1.5);
        let seg1 = synth_wc("webcam-01.mp4", 1.0);
        let sidecar = SidecarState {
            bubble_zone: Some(crate::composite::BubbleZone::BottomRight),
            ..Default::default()
        };

        let one = dir.join("one.gif");
        let note_one = run_v3_gif(&screen, std::slice::from_ref(&seg0), &one, &sidecar,
            crate::composite::WebcamSize::Medium, None, GifResolution::Source, 12, |_| {})
            .expect("single-segment gif");
        assert!(note_one.is_none(), "single segment carries no caveat note");
        assert_eq!(&std::fs::read(&one).unwrap()[..6], b"GIF89a", "single-seg gif valid");

        let multi = dir.join("multi.gif");
        let note = run_v3_gif(&screen, &[seg0.clone(), seg1.clone()], &multi, &sidecar,
            crate::composite::WebcamSize::Medium, None, GifResolution::Source, 12, |_| {})
            .expect("multi-segment gif")
            .expect("multi-segment gif carries a caveat note");
        assert!(note.contains("2 segments"), "note names the segment count: {note}");
        assert!(note.contains("AHEAD of the audio"), "note gives drift direction: {note}");
        assert_eq!(&std::fs::read(&multi).unwrap()[..6], b"GIF89a", "multi-seg gif valid");

        let _ = std::fs::remove_dir_all(&dir);
    }

    // The dispatcher branch itself: run_edit_pipeline routes a plain GIF to
    // run_plain_gif (no note, and byte-identical to the direct call — proving it
    // took the plain path, not the V3 render) and an edited GIF to run_v3_gif
    // (valid, clean note). GIF is routed before the MP4 predicate.
    #[test]
    fn gif_dispatch_routing() {
        let dir = std::env::temp_dir().join(format!("zeigen-gif-dispatch-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let screen = synth_source(&dir, "screen.mp4", 2.0, 2.0, 1280, 720);

        // Plain GIF via the dispatcher == via run_plain_gif direct (took the plain path).
        let plain_sc = SidecarState::default();
        let via = dir.join("via.gif");
        let rep = run_edit_pipeline(&screen, &[], &via, &plain_sc,
            PipelineMode::Gif { resolution: GifResolution::P480, fps: 12 },
            crate::composite::WebcamSize::Medium, None, |_| {})
            .expect("dispatch plain gif");
        assert!(rep.route_note.is_none(), "plain gif carries no note");
        let direct = dir.join("direct.gif");
        run_plain_gif(&screen, &direct, &plain_sc, GifResolution::P480, 12, |_| {})
            .expect("direct plain gif");
        assert_eq!(std::fs::read(&via).unwrap(), std::fs::read(&direct).unwrap(),
            "dispatcher plain GIF == run_plain_gif (took the plain path)");

        // Edited (zoom) GIF via the dispatcher -> valid, clean (V3 render path).
        let kf = |t: f64, scale: f64| ZoomKeyframe {
            t, scale, center_x: 640.0, center_y: 360.0, ease: Ease::InOutCubic,
            auto_generated: false,
        };
        let zoomed = SidecarState {
            zoom: vec![kf(0.3, 1.0), kf(0.9, 2.0), kf(1.1, 2.0), kf(1.7, 1.0)],
            ..Default::default()
        };
        let ez = dir.join("edit.gif");
        let rep2 = run_edit_pipeline(&screen, &[], &ez, &zoomed,
            PipelineMode::Gif { resolution: GifResolution::P720, fps: 15 },
            crate::composite::WebcamSize::Medium, None, |_| {})
            .expect("dispatch zoom gif");
        assert!(rep2.route_note.is_none(), "clean v3 gif carries no note");
        assert_eq!(&std::fs::read(&ez).unwrap()[..6], b"GIF89a", "dispatched zoom gif valid");

        let _ = std::fs::remove_dir_all(&dir);
    }

    // ---- Trim gate (V3) --------------------------------------------------------
    // Drives the REAL V3 trim path (run_v3_export, trim env) through trimmed
    // sidecars and asserts absolute correctness: the webcam step-function across
    // the cut lands on the frame derived from the webcam's own flip + LEAD/trim
    // math (the concentrated risk), for both trim_in > 105ms and < 105ms; and
    // frame 0 is the source frame at trim_in. V2 parity is banked (delta 0.0 both
    // branches, DECISIONS.md 2026-07-18). Prints a report (run with --nocapture).

    // Per-frame mean luma of a wxh crop at (x,y). One value per output frame.
    fn crop_luma_series(video: &Path, x: u32, y: u32, w: u32, h: u32) -> Vec<f64> {
        let out = Command::new(FFMPEG_PATH)
            .args(["-v", "error", "-i"])
            .arg(video)
            .args(["-vf", &format!("crop={w}:{h}:{x}:{y},format=gray"), "-f", "rawvideo", "-"])
            .output()
            .expect("crop luma series");
        let fsz = (w * h) as usize;
        out.stdout
            .chunks(fsz)
            .filter(|c| c.len() == fsz)
            .map(|c| c.iter().map(|&b| b as f64).sum::<f64>() / fsz as f64)
            .collect()
    }
    // First frame whose bubble-center luma crosses to white (black->white flip).
    fn flip_frame(series: &[f64]) -> Option<usize> {
        series.iter().position(|&v| v > 127.0)
    }
    // PSNR (dB) between EXACT frame `an` of a and frame `bn` of b. Extract by frame
    // index (select=eq(n,..)) not -ss time-seek — a fractional -ss rounds to the next
    // frame and would compare the wrong one (the bug this helper originally had).
    fn frame_psnr(a: &Path, an: i64, b: &Path, bn: i64, dir: &Path) -> f64 {
        let pa = dir.join("fa.png");
        let pb = dir.join("fb.png");
        for (v, n, p) in [(a, an, &pa), (b, bn, &pb)] {
            let r = Command::new(FFMPEG_PATH)
                .args(["-y", "-v", "error", "-i"])
                .arg(v)
                .args(["-vf", &format!("select=eq(n\\,{n})"), "-vsync", "0", "-frames:v", "1"])
                .arg(p)
                .output()
                .expect("extract frame");
            assert!(r.status.success(), "extract: {}", String::from_utf8_lossy(&r.stderr));
        }
        let r = Command::new(FFMPEG_PATH)
            .args(["-i"]).arg(&pa).args(["-i"]).arg(&pb)
            .args(["-lavfi", "psnr", "-f", "null", "-"])
            .output()
            .expect("psnr");
        let txt = String::from_utf8_lossy(&r.stderr);
        // ...average:inf ... (identical) or average:NN.NN
        txt.rsplit("average:")
            .next()
            .and_then(|s| s.split_whitespace().next())
            .map(|s| if s.starts_with("inf") { 99.0 } else { s.parse().unwrap_or(0.0) })
            .unwrap_or(0.0)
    }

    #[test]
    fn trim_gate() {
        ensure_audio_model_for_tests();
        let dir = std::env::temp_dir().join(format!("zeigen-trim-gate-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let (sw, sh) = (640u32, 480u32);
        let fps = 30.0;

        // --- Bubble step-function sources: solid-gray screen (so only the bubble
        // changes in its region) + a webcam that is BLACK for 20 frames then WHITE. ---
        let gray = dir.join("gray.mp4");
        let g = Command::new(FFMPEG_PATH)
            .args(["-y", "-v", "error",
                   "-f", "lavfi", "-i", &format!("color=c=gray:s={sw}x{sh}:r=30:d=3"),
                   "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
                   "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac"])
            .arg(&gray).output().expect("gray synth");
        assert!(g.status.success(), "gray: {}", String::from_utf8_lossy(&g.stderr));
        // Webcam: black 20 frames (0.667s), white to 3s. Flip at webcam frame 20.
        let webcam = dir.join("webcam-00.mp4");
        let wc = Command::new(FFMPEG_PATH)
            .args(["-y", "-v", "error",
                   "-f", "lavfi", "-i", "color=c=black:s=480x480:r=30:d=0.6667",
                   "-f", "lavfi", "-i", "color=c=white:s=480x480:r=30:d=2.3333",
                   "-filter_complex", "[0][1]concat=n=2:v=1:a=0",
                   "-c:v", "libx264", "-pix_fmt", "yuv420p"])
            .arg(&webcam).output().expect("webcam synth");
        assert!(wc.status.success(), "webcam: {}", String::from_utf8_lossy(&wc.stderr));
        // Measure the webcam's OWN flip frame (concat rounding can shift it a frame
        // off the nominal 20), so the `expect` column below is exact, not a guess.
        let flip_wc = flip_frame(&crop_luma_series(&webcam, 238, 238, 4, 4))
            .map(|v| v as i64).expect("webcam has a black->white flip");

        // Bubble geometry (bottom-right): center = (W - pad - D/2, H - pad - D/2).
        let dia_frac = 0.16;
        let d = (dia_frac * sw as f64).round() as u32;
        let pad = crate::composite::resolve_padding_px(sw);
        let cx = sw - pad - d / 2;
        let cy = sh - pad - d / 2;
        let (bx, by, bw, bh) = (cx - 2, cy - 2, 4, 4);
        let bubble_log = vec![BubblePositionEntry { t: 0.0, x: 0.9, y: 0.85, diameter_frac: Some(dia_frac) }];
        let lead = crate::composite::WEBCAM_LEAD_MS / 1000.0;

        eprintln!("\n===== TRIM GATE =====");
        eprintln!("webcam flips black->white at webcam frame {flip_wc}; lead={:.0}ms\n", lead * 1000.0);
        eprintln!("branch          trim_in   expect  V3flip  delta   delta(ms)");

        let branches = [("A: trim_in>lead", 0.5f64, 2.5f64), ("B: trim_in<lead", 0.05, 2.0)];
        for (name, tin, tout) in branches {
            let sc = SidecarState {
                bubble_zone: Some(crate::composite::BubbleZone::BottomRight),
                bubble_position_log: bubble_log.clone(),
                trim: Some(Trim { start: tin, out: tout }),
                ..Default::default()
            };
            let v3 = dir.join(format!("v3-{}.mp4", if tin < lead { "b" } else { "a" }));
            run_v3_export(&gray, std::slice::from_ref(&webcam), &v3, &sc,
                crate::composite::WebcamSize::Medium, None, Mp4Resolution::Source, |_| {})
                .expect("v3 trim export");

            let f3 = flip_frame(&crop_luma_series(&v3, bx, by, bw, bh)).map(|v| v as i64).unwrap_or(-1);
            // Expected output flip frame, derived from the webcam's own measured
            // flip + the LEAD/trim math (independent of any V2 reference — V2
            // parity is banked, delta 0.0 both branches, DECISIONS.md 2026-07-18).
            let expect = if tin >= lead {
                flip_wc - ((tin - lead) * fps).round() as i64
            } else {
                flip_wc + ((lead - tin) * fps).round() as i64
            };
            let dframes = f3 - expect;
            eprintln!("{name:<15} {tin:>6.3}s  {expect:>6}  {f3:>6}  {dframes:>5}   {:>7.1}",
                dframes as f64 * 1000.0 / fps);
            assert!((f3 - expect).abs() <= 1,
                "{name}: V3 bubble flip {f3} diverges from expected {expect} by >1 frame");
        }

        // --- Frame accuracy + duration + audio: testsrc2 (distinguishable frames),
        // no webcam, trim [0.5, 2.5]. V3 frame 0 must equal the SOURCE frame at
        // trim_in and V2 frame 0. ---
        let ts = dir.join("counter.mp4");
        let c = Command::new(FFMPEG_PATH)
            .args(["-y", "-v", "error",
                   "-f", "lavfi", "-i", "testsrc2=s=640x480:r=30:d=3",
                   "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
                   "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac"])
            .arg(&ts).output().expect("counter synth");
        assert!(c.status.success(), "counter: {}", String::from_utf8_lossy(&c.stderr));
        let (tin, tout) = (0.5f64, 2.5f64);
        let sc = SidecarState { trim: Some(Trim { start: tin, out: tout }), ..Default::default() };
        let v3 = dir.join("v3-frame.mp4");
        run_v3_export(&ts, &[], &v3, &sc, crate::composite::WebcamSize::Medium, None,
            Mp4Resolution::Source, |_| {}).expect("v3 frame export");

        // Frame accuracy by argmax-margin: V3 frame 0 must match the SOURCE frame at
        // trim_in far better than either neighbor (robust to the double/triple-encode
        // PSNR floor — the peak's identity is the proof, not its absolute dB). Frame
        // count = round((out-in)*fps); V2 duration parity is banked.
        let tf = (tin * fps).round() as i64;
        let p_prev = frame_psnr(&v3, 0, &ts, tf - 1, &dir);
        let p_at = frame_psnr(&v3, 0, &ts, tf, &dir);
        let p_next = frame_psnr(&v3, 0, &ts, tf + 1, &dir);
        let dur3 = probe_duration_seconds(&v3).unwrap();
        let adur3 = ffprobe_field(&v3, "stream=duration", "a:0").parse::<f64>().unwrap_or(0.0);
        eprintln!("\nframe0 vs source frame {}/{}/{}: {p_prev:.1}/{p_at:.1}/{p_next:.1} dB \
                   (peak must be the middle = trim_in)", tf - 1, tf, tf + 1);
        eprintln!("duration V3 {dur3:.3}s  window {:.3}s   audio {adur3:.3}s\n", tout - tin);

        assert!(p_at > p_prev + 4.0 && p_at > p_next + 4.0,
            "V3 frame 0 must match the source frame at trim_in, not a neighbor \
             (prev {p_prev:.1}, at {p_at:.1}, next {p_next:.1})");
        assert!((dur3 - (tout - tin)).abs() < 0.5 / fps, "V3 duration matches the window exactly");
        assert!((adur3 - dur3).abs() < 0.05, "audio length locked to trimmed video");

        let _ = std::fs::remove_dir_all(&dir);
    }

}
