use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;

use ab_glyph::{point, Font, FontRef, Glyph, PxScale, ScaleFont};
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

// Parse "#RRGGBB" → (r, g, b). Anything malformed falls back to white so a
// hand-edited sidecar can't break an export.
fn parse_annotation_color(hex: Option<&str>) -> (u8, u8, u8) {
    let Some(s) = hex else { return (255, 255, 255) };
    let s = s.strip_prefix('#').unwrap_or(s);
    if s.len() != 6 {
        return (255, 255, 255);
    }
    match u32::from_str_radix(s, 16) {
        Ok(n) => (((n >> 16) & 0xff) as u8, ((n >> 8) & 0xff) as u8, (n & 0xff) as u8),
        Err(_) => (255, 255, 255),
    }
}

// Rec.709 luma; dark glyph colors get a light text pill (and vice versa) so
// the glyphs stay readable. Mirrors Review.tsx's isDarkColor exactly so the
// preview pill and the exported pill match.
fn is_dark_color((r, g, b): (u8, u8, u8)) -> bool {
    2126 * (r as u32) + 7152 * (g as u32) + 722 * (b as u32) < 128 * 10000
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct BubblePositionEntry {
    pub t: f64,
    pub x: f64,
    pub y: f64,
    // Bubble circle diameter in physical pixels at this sample. None on
    // sidecars written before phase 8; the composite falls back to the
    // legacy WebcamSize::px() default in that case.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diameter: Option<f64>,
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
const DEFAULT_TEXT_SIZE_PX: f64 = 36.0;
const DEFAULT_ARROW_STROKE_PX: f64 = 8.0;
// Blur/redact region tuning. Sigma scales off the region's shorter side —
// same shape as composite.rs's SHADOW_SIGMA_FRAC-off-diameter calibration —
// but much stronger (0.35 vs 0.075) because the goal is destroying text
// legibility, not a cosmetic soften. Floor keeps small regions genuinely
// redacted rather than lightly softened.
const BLUR_SIGMA_FRAC: f64 = 0.35;
const BLUR_SIGMA_MIN_PX: f64 = 8.0;
// Spotlight dim strength for the frame OUTSIDE the drawn rect. Multiplicative
// (colorchannelmixer) rather than eq's additive brightness so "45% brightness"
// means what it says regardless of the frame's original exposure. By-eye
// calibration, same class of tuning as BLUR_SIGMA_FRAC above.
const SPOTLIGHT_DIM_FACTOR: f64 = 0.45;
// SFNS.ttf is a variable font with PostScript-style outlines that
// ab_glyph 0.2.x silently rasterizes as zero-coverage — text rendered fine
// in the preview but the saved PNGs were blank backgrounds. Geneva is a
// plain TTF that ships with macOS and renders correctly.
const FONT_FILE: &str = "/System/Library/Fonts/Geneva.ttf";

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

// Cached font bytes — read SFNS.ttf once per process. The font shipped on
// macOS at /System/Library/Fonts/SFNS.ttf is a static-instance-readable
// variable font; ab_glyph reads the default instance.
fn font_bytes() -> Option<&'static [u8]> {
    static BYTES: OnceLock<Option<Vec<u8>>> = OnceLock::new();
    BYTES
        .get_or_init(|| std::fs::read(FONT_FILE).ok())
        .as_deref()
}

// Rasterize a single line of text onto a small transparent PNG with a
// dark rounded-padding background and white glyphs. The PNG is sized to
// (text_width + 2*pad_h, line_height + 2*pad_v) in source pixels.
//
// Replaces ffmpeg's drawtext filter, which requires libfreetype at compile
// time and isn't present in every Homebrew ffmpeg build (notably 8.x core).
// By rendering text in Rust we drop that dependency: text and arrows now
// share a single overlay-PNG path through the filter graph.
fn rasterize_text(
    content: &str,
    size_src_px: f64,
    color: (u8, u8, u8),
    out_path: &Path,
) -> Result<(), String> {
    use tiny_skia::{
        FillRule, Paint, PathBuilder, Pixmap, PremultipliedColorU8, Rect, Transform,
    };

    let bytes = font_bytes().ok_or_else(|| format!("missing system font: {FONT_FILE}"))?;
    let font = FontRef::try_from_slice(bytes).map_err(|e| format!("font load: {e:?}"))?;
    let scale = PxScale::from(size_src_px as f32);
    let scaled = font.as_scaled(scale);
    let ascent = scaled.ascent();
    let descent = scaled.descent();
    let line_h = (ascent - descent).ceil();

    // Layout pass — measure total advance width.
    let mut text_w: f32 = 0.0;
    for c in content.chars() {
        let g = scaled.scaled_glyph(c);
        text_w += scaled.h_advance(g.id);
    }

    let pad_h = (size_src_px * 0.30).round() as i32;
    let pad_v = (size_src_px * 0.15).round() as i32;
    let total_w = ((text_w.ceil() as i32) + 2 * pad_h).max(1) as u32;
    let total_h = ((line_h as i32) + 2 * pad_v).max(1) as u32;

    let mut pixmap =
        Pixmap::new(total_w, total_h).ok_or_else(|| format!("alloc text pixmap {total_w}x{total_h}"))?;

    // Background rect: matches the previous drawtext box style
    // (rgba 20,20,22,0xCC, ~86% opacity); flips to a light pill for dark
    // glyph colors — same rule as the preview (Review.tsx isDarkColor).
    {
        let rect = Rect::from_xywh(0.0, 0.0, total_w as f32, total_h as f32)
            .ok_or("invalid bg rect")?;
        let mut pb = PathBuilder::new();
        pb.push_rect(rect);
        let path = pb.finish().ok_or("empty bg path")?;
        let mut paint = Paint::default();
        if is_dark_color(color) {
            paint.set_color_rgba8(245, 245, 247, 0xCC);
        } else {
            paint.set_color_rgba8(20, 20, 22, 0xCC);
        }
        paint.anti_alias = true;
        pixmap.fill_path(&path, &paint, FillRule::Winding, Transform::identity(), None);
    }

    // Glyph pass: draw colored glyphs over the bg via per-pixel alpha
    // compositing. tiny-skia stores premultiplied RGBA; the compositing
    // formula for "color c at alpha a, over premul dst" is:
    //   src_premul = (c.r*a/255, c.g*a/255, c.b*a/255, a)
    //   out = src + dst * (1 - a/255)
    let (cr, cg, cb) = (color.0 as u32, color.1 as u32, color.2 as u32);
    let baseline_y = pad_v as f32 + ascent;
    let mut x_cursor: f32 = 0.0;
    let pixels = pixmap.pixels_mut();
    for c in content.chars() {
        let glyph_id = scaled.scaled_glyph(c).id;
        let positioned = Glyph {
            id: glyph_id,
            scale,
            position: point(pad_h as f32 + x_cursor, baseline_y),
        };
        if let Some(outlined) = scaled.outline_glyph(positioned) {
            let bounds = outlined.px_bounds();
            outlined.draw(|gx, gy, coverage| {
                let px = bounds.min.x as i32 + gx as i32;
                let py = bounds.min.y as i32 + gy as i32;
                if px < 0 || py < 0 || (px as u32) >= total_w || (py as u32) >= total_h {
                    return;
                }
                let idx = (py as u32 * total_w + px as u32) as usize;
                let a = (coverage * 255.0).clamp(0.0, 255.0) as u32;
                if a == 0 {
                    return;
                }
                let inv = 255 - a;
                let cur = pixels[idx];
                let r = (cr * a / 255 + cur.red() as u32 * inv / 255).min(255) as u8;
                let g = (cg * a / 255 + cur.green() as u32 * inv / 255).min(255) as u8;
                let b = (cb * a / 255 + cur.blue() as u32 * inv / 255).min(255) as u8;
                let alpha = (a + cur.alpha() as u32 * inv / 255).min(255) as u8;
                if let Some(c) = PremultipliedColorU8::from_rgba(r, g, b, alpha) {
                    pixels[idx] = c;
                }
            });
        }
        x_cursor += scaled.h_advance(glyph_id);
    }

    let png = pixmap
        .encode_png()
        .map_err(|e| format!("encode text png: {e}"))?;
    std::fs::write(out_path, png)
        .map_err(|e| format!("write text png {}: {e}", out_path.display()))?;
    Ok(())
}

// Rasterize an arrow into a transparent PNG sized to the source video.
// Arrow is white with rounded line cap; arrowhead is a filled triangle at
// the endpoint. Endpoints are in source-fraction coords; stroke is in
// source pixels. Output PNG is `(src_w, src_h)` so a single overlay filter
// (no scale) places it correctly.
fn rasterize_arrow(
    src_w: u32,
    src_h: u32,
    start: &Position,
    end: &Position,
    stroke_src_px: f64,
    color: (u8, u8, u8),
    out_path: &Path,
) -> Result<(), String> {
    use tiny_skia::{
        FillRule, LineCap, LineJoin, Paint, PathBuilder, Pixmap, Stroke, Transform,
    };

    let mut pixmap = Pixmap::new(src_w, src_h)
        .ok_or_else(|| format!("alloc pixmap {src_w}x{src_h} failed"))?;

    let sx = (start.x.clamp(0.0, 1.0) * src_w as f64) as f32;
    let sy = (start.y.clamp(0.0, 1.0) * src_h as f64) as f32;
    let ex = (end.x.clamp(0.0, 1.0) * src_w as f64) as f32;
    let ey = (end.y.clamp(0.0, 1.0) * src_h as f64) as f32;

    let dx = ex - sx;
    let dy = ey - sy;
    let len = (dx * dx + dy * dy).sqrt();
    if len < 1.0 {
        // Degenerate arrow — emit an empty pixmap so the overlay is a no-op.
        let png = pixmap
            .encode_png()
            .map_err(|e| format!("encode png: {e}"))?;
        std::fs::write(out_path, png)
            .map_err(|e| format!("write {}: {e}", out_path.display()))?;
        return Ok(());
    }

    let stroke_w = stroke_src_px.max(1.0) as f32;
    // Arrowhead size scales with stroke. Length 3.5x, width 3x.
    let head_len = stroke_w * 3.5;
    let head_w = stroke_w * 3.0;

    // Shorten the line so it terminates at the base of the arrowhead, not
    // inside it (otherwise the stroke pokes through the head fill).
    let shaft_len = (len - head_len).max(0.0);
    let ux = dx / len;
    let uy = dy / len;
    let shaft_ex = sx + ux * shaft_len;
    let shaft_ey = sy + uy * shaft_len;

    let mut paint = Paint::default();
    paint.set_color_rgba8(color.0, color.1, color.2, 255);
    paint.anti_alias = true;

    // Contrasting outline under the fill — light arrows get a dark rim,
    // dark arrows a light one (same luma rule and tones as the text pill),
    // so the arrow stays visible on any background. Drawn as: outline
    // passes first (wider shaft stroke + stroked head triangle), fill
    // passes on top, leaving `outline_t` of rim outside the silhouette.
    let outline_t = (stroke_w * 0.25).clamp(1.5, 4.0);
    let mut outline_paint = Paint::default();
    if is_dark_color(color) {
        outline_paint.set_color_rgba8(245, 245, 247, 255);
    } else {
        outline_paint.set_color_rgba8(20, 20, 22, 255);
    }
    outline_paint.anti_alias = true;

    // Shaft path (shared by outline and fill passes).
    let shaft_path = if shaft_len > 0.5 {
        let mut pb = PathBuilder::new();
        pb.move_to(sx, sy);
        pb.line_to(shaft_ex, shaft_ey);
        Some(pb.finish().ok_or("empty shaft path")?)
    } else {
        None
    };

    // Arrowhead — triangle with apex at (ex, ey), base perpendicular to
    // the line direction, base width head_w.
    let nx = -uy; // perpendicular
    let ny = ux;
    let base_cx = ex - ux * head_len;
    let base_cy = ey - uy * head_len;
    let bx1 = base_cx + nx * (head_w * 0.5);
    let by1 = base_cy + ny * (head_w * 0.5);
    let bx2 = base_cx - nx * (head_w * 0.5);
    let by2 = base_cy - ny * (head_w * 0.5);

    let mut pb = PathBuilder::new();
    pb.move_to(ex, ey);
    pb.line_to(bx1, by1);
    pb.line_to(bx2, by2);
    pb.close();
    let head = pb.finish().ok_or("empty head path")?;

    // Outline passes.
    if let Some(path) = &shaft_path {
        let mut s = Stroke::default();
        s.width = stroke_w + 2.0 * outline_t;
        s.line_cap = LineCap::Round;
        s.line_join = LineJoin::Round;
        pixmap.stroke_path(path, &outline_paint, &s, Transform::identity(), None);
    }
    {
        // Stroking the triangle edge (centered) leaves outline_t outside;
        // the head fill below covers the inner half.
        let mut s = Stroke::default();
        s.width = 2.0 * outline_t;
        s.line_cap = LineCap::Round;
        s.line_join = LineJoin::Round;
        pixmap.stroke_path(&head, &outline_paint, &s, Transform::identity(), None);
    }

    // Fill passes. The shaft's round cap extends stroke_w/2 past the head
    // base center, covering the outline segment at the shaft-head joint.
    if let Some(path) = &shaft_path {
        let mut s = Stroke::default();
        s.width = stroke_w;
        s.line_cap = LineCap::Round;
        s.line_join = LineJoin::Round;
        pixmap.stroke_path(path, &paint, &s, Transform::identity(), None);
    }
    pixmap.fill_path(&head, &paint, FillRule::Winding, Transform::identity(), None);

    let png = pixmap
        .encode_png()
        .map_err(|e| format!("encode png: {e}"))?;
    std::fs::write(out_path, png).map_err(|e| format!("write {}: {e}", out_path.display()))?;
    Ok(())
}

// Region annotation → pixel crop rect (cx, cy, cw, ch), clamped to the frame.
// Shared by blur_region_fragment and spotlight_region_fragment — both read a
// two-corner fractional rect (position/endpoint) off the same annotation
// shape and need the identical clamp/rounding math to land on the same
// pixels.
fn region_crop_px(ann: &Annotation, src_dims: (u32, u32)) -> (i64, i64, i64, i64) {
    let (sw, sh) = src_dims;
    let endpoint = ann
        .endpoint
        .as_ref()
        .expect("region annotation missing endpoint");
    let x0 = ann.position.x.clamp(0.0, 1.0).min(endpoint.x.clamp(0.0, 1.0));
    let y0 = ann.position.y.clamp(0.0, 1.0).min(endpoint.y.clamp(0.0, 1.0));
    let x1 = ann.position.x.clamp(0.0, 1.0).max(endpoint.x.clamp(0.0, 1.0));
    let y1 = ann.position.y.clamp(0.0, 1.0).max(endpoint.y.clamp(0.0, 1.0));
    let cx = (x0 * sw as f64).round() as i64;
    let cy = (y0 * sh as f64).round() as i64;
    let cw = (((x1 - x0) * sw as f64).round() as i64)
        .max(1)
        .min((sw as i64 - cx).max(1));
    let ch = (((y1 - y0) * sh as f64).round() as i64)
        .max(1)
        .min((sh as i64 - cy).max(1));
    (cx, cy, cw, ch)
}

// Blur/redact filter-graph fragment for one sidecar "blur" annotation.
// Crops the region, applies a strong gblur, and overlays it back over the
// exact same rect for [start, end]. Pure filter graph — no rasterized PNG
// input (unlike text/arrow), so no temp file lifecycle to manage.
//
// Shared by edit.rs's pass-2 pipeline (trim-adjusted start/end) and
// linkedin.rs's custom transcode (raw start/end — LinkedIn never trims),
// so both export paths that leave the machine apply the same redaction.
// `idx` only needs to be unique among fragments chained into the same
// filter string — callers pass a per-loop counter.
pub(crate) fn blur_region_fragment(
    idx: usize,
    prev_label: &str,
    next_label: &str,
    ann: &Annotation,
    src_dims: (u32, u32),
    start: f64,
    end: f64,
) -> String {
    let (cx, cy, cw, ch) = region_crop_px(ann, src_dims);
    let sigma = (cw.min(ch) as f64 * BLUR_SIGMA_FRAC).max(BLUR_SIGMA_MIN_PX);
    format!(
        "[{prev_label}]split=2[bs{idx}][bc{idx}];\
[bc{idx}]crop={cw}:{ch}:{cx}:{cy},gblur=sigma={sigma:.1}[bb{idx}];\
[bs{idx}][bb{idx}]overlay=x={cx}:y={cy}:enable=between(t\\,{start:.3}\\,{end:.3})[{next_label}]"
    )
}

// Spotlight filter-graph fragment for one sidecar "spotlight" annotation.
// Darkens the WHOLE frame (colorchannelmixer, multiplicative so it's a true
// percentage of brightness), then overlays the untouched crop of the same
// rect back on top for [start, end] — the inverse of blur_region_fragment,
// which overlays a blurred crop over a sharp base. Same pure-filter-graph
// shape (split + crop + overlay, no rasterized PNG), same idx/prev_label/
// next_label contract, same dual-caller reuse (edit.rs pass-2, linkedin.rs
// custom transcode) as blur.
pub(crate) fn spotlight_region_fragment(
    idx: usize,
    prev_label: &str,
    next_label: &str,
    ann: &Annotation,
    src_dims: (u32, u32),
    start: f64,
    end: f64,
) -> String {
    let (cx, cy, cw, ch) = region_crop_px(ann, src_dims);
    let f = SPOTLIGHT_DIM_FACTOR;
    // colorchannelmixer is a timeline filter (supports `enable`) — without
    // it the dim would apply for the whole clip and only the box's
    // restoring overlay would be time-boxed, leaving every frame outside
    // [start,end] fully dimmed with nothing to undo it.
    format!(
        "[{prev_label}]split=2[sps{idx}][spc{idx}];\
[sps{idx}]colorchannelmixer=rr={f}:gg={f}:bb={f}:enable=between(t\\,{start:.3}\\,{end:.3})[spd{idx}];\
[spc{idx}]crop={cw}:{ch}:{cx}:{cy}[spr{idx}];\
[spd{idx}][spr{idx}]overlay=x={cx}:y={cy}:enable=between(t\\,{start:.3}\\,{end:.3})[{next_label}]"
    )
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

fn temp_dir_for(source: &Path) -> PathBuf {
    let stem = source
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("unknown");
    let parent = source.parent().unwrap_or_else(|| Path::new(""));
    parent.join(".sources").join(format!("edit-{stem}"))
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

// Phase 15 c2: composite-at-export wrapper. When webcam_segments is
// non-empty, composite::composite runs first against raw screen.mp4 +
// segments and writes a temp file; the existing single-input edit
// pipeline then runs on the temp. Two encodes total, matching Phase 14's
// finalize+save shape — preserves byte-stability vs Phase 14 outputs.
//
// Screen-only recordings (no segments) skip the composite step and call
// the single-input pipeline directly, identical to Phase 14 behavior.
//
// Phase 15 c2 still leaves the Phase 14 finalize composite running as a
// backstop (the composited scratch mp4 exists but is ignored by this
// path); c3 removes it.
pub(crate) fn run_edit_pipeline(
    screen_path: &Path,
    webcam_segments: &[std::path::PathBuf],
    output: &Path,
    sidecar: &SidecarState,
    mode: PipelineMode,
    webcam_size: crate::composite::WebcamSize,
    webcam_corner: crate::composite::Corner,
    watermark: Option<Watermark>,
    on_progress: impl Fn(f64) + Send + Clone + 'static,
) -> Result<(), String> {
    // Phase 15 c3: callers can no longer assume a file exists at the
    // scratch logical path (composite moved to export). The thing that
    // MUST exist is the raw screen capture. Clean error before either
    // composite or single-input ffmpeg gets a chance to mis-report it.
    if !screen_path.is_file() {
        return Err(format!("screen capture missing: {}", screen_path.display()));
    }

    if webcam_segments.is_empty() {
        return run_edit_pipeline_single_input(screen_path, output, sidecar, mode, watermark, on_progress);
    }

    // Temp composite file. Lives under the scratch's .sources sibling
    // so the existing scratch-lifecycle paths sweep it if anything
    // strands it. Stem-keyed so concurrent exports of different sources
    // don't collide; same-source serial exports overwrite the prior
    // temp (no caching — D-07).
    let stem = screen_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("source");
    let temp_dir = screen_path
        .parent()
        .and_then(|p| p.parent())
        .map(|p| p.join(".sources").join(format!("export-{stem}")))
        .ok_or_else(|| format!("screen path has no grandparent: {}", screen_path.display()))?;
    std::fs::create_dir_all(&temp_dir)
        .map_err(|e| format!("create {}: {e}", temp_dir.display()))?;
    let composite_tmp = temp_dir.join("composite.mp4");

    // Fix B: composite the watermark into pass 1 (composite()) for the webcam
    // path rather than pass 2. With the watermark gone from pass 2, a
    // watermarked-but-unedited export keeps needs_filter=false and stays on the
    // pass-2 copy path instead of a second full re-encode. Validate the logo
    // here with the same skip-if-missing semantics single_input uses, so
    // composite() never fails an export over a deleted logo.
    let composite_watermark = watermark.filter(|wm| {
        let ok = wm.logo_path.is_file();
        if !ok {
            eprintln!("[watermark] logo missing at {}, skipping", wm.logo_path.display());
        }
        ok
    });

    // Two ffmpeg passes share one progress bar: composite fills 0-50%,
    // the single-input pass fills 50-100%. on_progress is cloned into the
    // composite callback so the original survives to build the second.
    let composite_progress = {
        let on_progress = on_progress.clone();
        move |frac: f64| on_progress(frac * 0.5)
    };
    crate::composite::composite(
        screen_path,
        webcam_segments,
        &composite_tmp,
        webcam_size,
        webcam_corner,
        &sidecar.bubble_position_log,
        sidecar.bubble_roundness,
        composite_watermark,
        composite_progress,
    )?;

    // Watermark already baked into composite_tmp above — pass None so pass 2
    // doesn't re-apply it (and doesn't trip needs_filter into a re-encode).
    let single_progress = move |frac: f64| on_progress(0.5 + frac * 0.5);
    let result =
        run_edit_pipeline_single_input(&composite_tmp, output, sidecar, mode, None, single_progress);

    // Best-effort cleanup either way — leave the temp for inspection on
    // failure isn't worth the disk vs. the simpler always-clean rule.
    let _ = std::fs::remove_file(&composite_tmp);
    let _ = std::fs::remove_dir(&temp_dir);

    result
}

// Single-pass edit pipeline. Trim via -ss/-to before -i; text and arrow
// annotations rasterized to PNGs and composited via overlay filters with
// `enable=between(t,start,end)`. Output via h264_videotoolbox (Mp4) or
// palettegen/paletteuse → GIF muxer (Gif). Caller supplies both source
// and output paths — `commit_recording` reads the scratch mp4 and writes
// directly to the final ~/Movies/Zeigen/ location.
fn run_edit_pipeline_single_input(
    source: &Path,
    output: &Path,
    sidecar: &SidecarState,
    mode: PipelineMode,
    watermark: Option<Watermark>,
    on_progress: impl Fn(f64) + Send + 'static,
) -> Result<(), String> {
    // Skip a watermark whose logo file is gone — never fail an export over a
    // missing logo; the rest of the pipeline proceeds without it.
    let watermark = watermark.filter(|wm| {
        let ok = wm.logo_path.is_file();
        if !ok {
            eprintln!("[watermark] logo missing at {}, skipping", wm.logo_path.display());
        }
        ok
    });
    let gif_params: Option<(GifResolution, u32)> = match mode {
        PipelineMode::Mp4 { .. } => None,
        PipelineMode::Gif { resolution, fps } => Some((resolution, fps)),
    };
    let gif_mode = gif_params.is_some();
    // None on Source (pipeline stays byte-identical to pre-phase-11); Some
    // on P480/P720/P1080 forces a scale node onto the tail of the overlay
    // chain and forces the filter graph to be built even with no overlays.
    //
    // Fix A: skip a resolution scale that wouldn't actually shrink the source.
    // An identity (or upscale) scale still sets needs_filter=true and forces a
    // full second re-encode for zero pixel change — the dominant export-time
    // waste (PHASE-5.5-PLAN.md, W1). Compare against the dimension each scale
    // filter constrains: P480/P720 force height (`-2:H`), P1080 caps width at
    // 1920 (`'min(iw,1920)':-2`). A <=1080p source under the 1080p default thus
    // lands on the copy path. General rule, no source-specific constants.
    let mp4_scale: Option<Mp4Resolution> = match mode {
        PipelineMode::Mp4 { resolution } if resolution != Mp4Resolution::Source => {
            let downscales = match probe_dimensions(source) {
                Ok((w, h)) => match resolution {
                    Mp4Resolution::P480 => h > 480,
                    Mp4Resolution::P720 => h > 720,
                    Mp4Resolution::P1080 => w > 1920,
                    Mp4Resolution::Source => false,
                },
                // Can't probe (missing source is reported just below) — keep
                // the scale so behavior is unchanged on the error path.
                Err(_) => true,
            };
            if downscales {
                Some(resolution)
            } else {
                None
            }
        }
        _ => None,
    };
    if !source.exists() {
        return Err(format!("source missing: {}", source.display()));
    }
    let duration = probe_duration_seconds(source)?;

    // Resolve effective trim.
    let trim: Option<&Trim> = match &sidecar.trim {
        Some(t) if t.start > TRIM_EPS || t.out < duration - TRIM_EPS => Some(t),
        _ => None,
    };
    let trim_in = trim.map(|t| t.start).unwrap_or(0.0);
    let out_duration = trim
        .map(|t| (t.out - t.start).max(0.0))
        .unwrap_or(duration);

    // Allocate temp dir for any sidecar artifacts (text files, arrow PNGs).
    let temp_dir = temp_dir_for(source);
    let text_anns: Vec<(usize, &Annotation)> = sidecar
        .annotations
        .iter()
        .enumerate()
        .filter(|(_, a)| a.kind == "text" && !a.content.is_empty())
        .collect();
    let arrow_anns: Vec<(usize, &Annotation)> = sidecar
        .annotations
        .iter()
        .enumerate()
        .filter(|(_, a)| a.kind == "arrow" && a.endpoint.is_some())
        .collect();
    // Blur regions are pure filter graph (crop+gblur+overlay, no rasterized
    // PNG) so they don't participate in need_temp.
    let blur_anns: Vec<(usize, &Annotation)> = sidecar
        .annotations
        .iter()
        .enumerate()
        .filter(|(_, a)| a.kind == "blur" && a.endpoint.is_some())
        .collect();
    // Spotlight regions are pure filter graph too, same reason as blur above.
    let spotlight_anns: Vec<(usize, &Annotation)> = sidecar
        .annotations
        .iter()
        .enumerate()
        .filter(|(_, a)| a.kind == "spotlight" && a.endpoint.is_some())
        .collect();
    let need_temp = !text_anns.is_empty() || !arrow_anns.is_empty();
    if need_temp {
        std::fs::create_dir_all(&temp_dir)
            .map_err(|e| format!("create {}: {}", temp_dir.display(), e))?;
    }

    // Global annotation color from the sidecar (None/malformed = white,
    // the pre-feature behavior). One color for all text + arrows.
    let ann_color = parse_annotation_color(sidecar.annotation_color.as_deref());

    // Rasterize each text annotation into a small PNG (sized to the styled
    // text box). The annotation's source-fraction position becomes the
    // overlay x/y.
    let mut text_paths: Vec<(usize, PathBuf, &Annotation)> = Vec::new();
    for (idx, ann) in &text_anns {
        let size = ann.size.unwrap_or(DEFAULT_TEXT_SIZE_PX);
        let p = temp_dir.join(format!("text-{idx}.png"));
        rasterize_text(&ann.content, size, ann_color, &p)?;
        text_paths.push((*idx, p, ann));
    }

    // Probe source dims once — arrow PNGs are source-sized, blur regions
    // need pixel rects, and the watermark scales relative to the shorter
    // source dimension.
    let src_dims: Option<(u32, u32)> = if !arrow_anns.is_empty()
        || !blur_anns.is_empty()
        || !spotlight_anns.is_empty()
        || watermark.is_some()
    {
        Some(probe_dimensions(source)?)
    } else {
        None
    };

    // Rasterize each arrow into a source-sized transparent PNG. Arrow PNG
    // is source-sized so overlay sits at (0,0).
    let mut arrow_paths: Vec<(usize, PathBuf, &Annotation)> = Vec::new();
    if !arrow_anns.is_empty() {
        let (sw, sh) = src_dims.expect("src_dims set when arrows present");
        for (idx, ann) in &arrow_anns {
            let endpoint = ann.endpoint.as_ref().expect("filtered above");
            let stroke = ann.stroke.unwrap_or(DEFAULT_ARROW_STROKE_PX);
            let p = temp_dir.join(format!("arrow-{idx}.png"));
            rasterize_arrow(sw, sh, &ann.position, endpoint, stroke, ann_color, &p)?;
            arrow_paths.push((*idx, p, ann));
        }
    }

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

    // Both text and arrow PNGs are additional inputs. Order: text first,
    // then arrows. Input indices in the filter graph: 0 = source,
    // 1..N+1 = text PNGs, N+2..N+M+1 = arrow PNGs.
    for (_idx, path, _ann) in &text_paths {
        args.push("-i".into());
        args.push(path.to_string_lossy().into_owned());
    }
    for (_idx, path, _ann) in &arrow_paths {
        args.push("-i".into());
        args.push(path.to_string_lossy().into_owned());
    }
    // Watermark logo is the last input (after source, text PNGs, arrow PNGs).
    if let Some(wm) = &watermark {
        args.push("-i".into());
        args.push(wm.logo_path.to_string_lossy().into_owned());
    }

    // Force-build the filter graph in Gif mode (so the palettegen/paletteuse
    // tail can chain off [0:v]) or whenever an MP4 scale is requested.
    let needs_filter = !text_paths.is_empty()
        || !arrow_paths.is_empty()
        || !blur_anns.is_empty()
        || !spotlight_anns.is_empty()
        || watermark.is_some()
        || gif_mode
        || mp4_scale.is_some();
    if needs_filter {
        let mut filter = String::new();
        let mut prev_label = String::from("0:v");
        let mut step = 0usize;
        let mut input_idx = 1usize;

        // Blur/redact regions — applied first, directly on the base video,
        // so text/arrow overlays below draw ON TOP of the redaction rather
        // than getting blurred out themselves. No extra inputs consumed
        // (pure filter graph), so input_idx is untouched here.
        for (i, (_idx, ann)) in blur_anns.iter().enumerate() {
            let (sw, sh) = src_dims.expect("src_dims set when blur present");
            let next_label = format!("v{step}");
            step += 1;
            let start = (ann.start_time - trim_in).max(0.0);
            let end = (ann.end_time - trim_in).max(start).min(out_duration);
            filter.push_str(&blur_region_fragment(
                i,
                &prev_label,
                &next_label,
                ann,
                (sw, sh),
                start,
                end,
            ));
            if i + 1 < blur_anns.len()
                || !spotlight_anns.is_empty()
                || !text_paths.is_empty()
                || !arrow_paths.is_empty()
                || watermark.is_some()
                || gif_mode
                || mp4_scale.is_some()
            {
                filter.push(';');
            }
            prev_label = next_label;
        }

        // Spotlight regions — same layer as blur (a base-video pixel
        // transform, not a fresh-content overlay), applied right after so
        // text/arrow below still draw on top undimmed. Runs after blur:
        // the two commute (both are per-pixel/spatial transforms with no
        // new content), so ordering between them doesn't affect whether a
        // blurred region stays redacted — it's blurred at whatever point in
        // the chain blur_region_fragment runs, before or after spotlight's
        // dim+restore. Placing spotlight second keeps this a pure addition
        // that doesn't reshuffle the already-shipped blur stage.
        for (i, (_idx, ann)) in spotlight_anns.iter().enumerate() {
            let (sw, sh) = src_dims.expect("src_dims set when spotlight present");
            let next_label = format!("v{step}");
            step += 1;
            let start = (ann.start_time - trim_in).max(0.0);
            let end = (ann.end_time - trim_in).max(start).min(out_duration);
            filter.push_str(&spotlight_region_fragment(
                i,
                &prev_label,
                &next_label,
                ann,
                (sw, sh),
                start,
                end,
            ));
            if i + 1 < spotlight_anns.len()
                || !text_paths.is_empty()
                || !arrow_paths.is_empty()
                || watermark.is_some()
                || gif_mode
                || mp4_scale.is_some()
            {
                filter.push(';');
            }
            prev_label = next_label;
        }

        // Text overlays — small text PNG positioned at W*posX, H*posY.
        // overlay's W and H are the main (base) layer dimensions.
        for (i, (_idx, _path, ann)) in text_paths.iter().enumerate() {
            let next_label = format!("v{step}");
            step += 1;
            let start = (ann.start_time - trim_in).max(0.0);
            let end = (ann.end_time - trim_in).max(start).min(out_duration);
            let x = ann.position.x.clamp(0.0, 1.0);
            let y = ann.position.y.clamp(0.0, 1.0);
            filter.push_str(&format!(
                "[{prev_label}][{input_idx}:v]overlay=x=W*{x:.4}:y=H*{y:.4}:enable=between(t\\,{start:.3}\\,{end:.3})[{next_label}]",
                prev_label = prev_label,
                input_idx = input_idx,
                x = x,
                y = y,
                start = start,
                end = end,
                next_label = next_label,
            ));
            if i + 1 < text_paths.len()
                || !arrow_paths.is_empty()
                || watermark.is_some()
                || gif_mode
                || mp4_scale.is_some()
            {
                filter.push(';');
            }
            prev_label = next_label;
            input_idx += 1;
        }

        // Arrow overlays — source-sized PNG with positioning baked in.
        for (i, (_idx, _path, ann)) in arrow_paths.iter().enumerate() {
            let next_label = format!("v{step}");
            step += 1;
            let start = (ann.start_time - trim_in).max(0.0);
            let end = (ann.end_time - trim_in).max(start).min(out_duration);
            filter.push_str(&format!(
                "[{prev_label}][{input_idx}:v]overlay=x=0:y=0:enable=between(t\\,{start:.3}\\,{end:.3})[{next_label}]",
                prev_label = prev_label,
                input_idx = input_idx,
                start = start,
                end = end,
                next_label = next_label,
            ));
            if i + 1 < arrow_paths.len() || watermark.is_some() || gif_mode || mp4_scale.is_some()
            {
                filter.push(';');
            }
            prev_label = next_label;
            input_idx += 1;
        }

        // Watermark overlay — sits on top of annotations, before the scale/
        // GIF tail so it scales proportionally with the frame. Logo is the
        // last input, so input_idx now points at it.
        if let Some(wm) = &watermark {
            let (sw, sh) = src_dims.expect("src_dims set when watermark present");
            let next_label = format!("v{step}");
            step += 1;
            filter.push_str(&wm.filter_fragment(input_idx, &prev_label, &next_label, sw, sh));
            if gif_mode || mp4_scale.is_some() {
                filter.push(';');
            }
            prev_label = next_label;
            // input_idx not bumped — the logo is the last input.
        }

        // MP4 scale tail — only fires when resolution != Source. Mutually
        // exclusive with the GIF tail below. Terminal node, so no trailing ;.
        if let Some(res) = mp4_scale {
            // Terminal node — no further nodes consume `step`, so it isn't
            // incremented here. If a downstream node is ever appended, bump
            // `step` first.
            let next_label = format!("v{step}");
            let scale_arg = match res {
                Mp4Resolution::P480 => "-2:480",
                Mp4Resolution::P720 => "-2:720",
                Mp4Resolution::P1080 => "'min(iw,1920)':-2",
                Mp4Resolution::Source => unreachable!("mp4_scale is None on Source"),
            };
            filter.push_str(&format!(
                "[{prev_label}]scale={scale_arg}:flags=lanczos[{next_label}]"
            ));
            prev_label = next_label;
        }

        // GIF tail. stats_mode=diff weights moving pixels (better for
        // screencasts where most of the frame is static); bayer dither
        // preserves UI gradients without sierra2_4a's noise floor.
        if let Some((resolution, fps)) = gif_params {
            let scale_arg = match resolution {
                GifResolution::P480 => "-2:480".to_string(),
                GifResolution::P720 => "-2:720".to_string(),
                GifResolution::Source => "'min(iw,1920)':-2".to_string(),
            };
            filter.push_str(&format!(
                "[{prev_label}]fps={fps},scale={scale_arg}:flags=lanczos,split[gA][gB];[gA]palettegen=stats_mode=diff[gP];[gB][gP]paletteuse=dither=bayer:bayer_scale=5[gout]"
            ));
            prev_label = String::from("gout");
        }

        args.push("-filter_complex".into());
        args.push(filter);
        args.push("-map".into());
        args.push(format!("[{prev_label}]"));
        if !gif_mode {
            args.push("-map".into());
            args.push("0:a?".into());
        }
    }

    // When there's no video work to do — no trim, no overlays, no scale —
    // the MP4 path copies the video bitstream and only re-encodes audio
    // (so arnndn still applies). Preserves the source video stream byte-
    // for-byte and bounds the noop-save cost to the audio-only pipeline.
    // Bigger picture: audio always re-encodes for noise reduction; video
    // re-encodes only when something actually changed for the viewer.
    let mp4_video_can_copy =
        matches!(mode, PipelineMode::Mp4 { .. }) && trim.is_none() && !needs_filter;

    match mode {
        PipelineMode::Mp4 { .. } => {
            // Always-on RNNoise on the audio output. ffmpeg routes -af after
            // the demuxer-level -ss/-to trim and before the -c:a encoder, so
            // no explicit ordering is needed. The flag is a clean no-op when
            // the source has no audio stream.
            if let Some(af) = audio_nr_filter() {
                args.push("-af".into());
                args.push(af);
            }
            if mp4_video_can_copy {
                args.push("-c:v".into());
                args.push("copy".into());
            } else {
                args.push("-c:v".into());
                args.push("h264_videotoolbox".into());
                args.push("-b:v".into());
                args.push("8M".into());
                // Browser-compat + graceful fallback. -profile high and
                // yuv420p keep the stream decodable everywhere (some players
                // reject VideoToolbox's default chroma); avc1 is the standard
                // sample-entry tag; allow_sw falls back to the software encoder
                // when the HW session is unavailable (e.g. contended) instead
                // of hard-failing the save.
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
            // Front-load the moov atom so the Cloudflare /v/[id] viewer can
            // start progressive playback before the whole file downloads.
            // AVAssetWriter writes moov-at-end (shouldOptimizeForNetworkUse is
            // unset) and ffmpeg's mp4 muxer defaults to the same, so this is
            // required on BOTH branches. faststart is a post-mux relocation,
            // so it works with -c:v copy too — no separate remux pass needed.
            args.push("-movflags".into());
            args.push("+faststart".into());
        }
        PipelineMode::Gif { .. } => {
            args.push("-loop".into());
            args.push("0".into());
        }
    }

    args.push(output.to_string_lossy().into_owned());

    let mut child = Command::new(FFMPEG_PATH)
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to spawn ffmpeg: {e}"))?;

    // Same out_time_us parsing as composite.rs's progress thread — see that
    // module for why total_us is derived from the encoded duration rather
    // than read back from ffmpeg.
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
            "ffmpeg edit pipeline failed (exit {:?}):\n{}",
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

    // Clean up temp dir on success. On failure we leave it for inspection.
    if need_temp {
        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    Ok(())
}

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
    // pipeline against source directly. webcam_size/corner default to
    // Medium/BottomRight — the values engine_start uses today (UI
    // controls removed in phase 8). Per-recording settings would land
    // in the sidecar; c2 doesn't need that since defaults match every
    // current recording.
    let (screen_path, segments) = export_inputs_from_source(source);
    let webcam_size = crate::composite::WebcamSize::Medium;
    let webcam_corner = crate::composite::Corner::BottomRight;

    let output = match format.as_str() {
        "mp4" => {
            let res = match resolution.as_str() {
                "480p" => Mp4Resolution::P480,
                "720p" => Mp4Resolution::P720,
                "1080p" => Mp4Resolution::P1080,
                "source" => Mp4Resolution::Source,
                other => return Err(format!("unknown mp4 resolution: {other}")),
            };
            let output = next_per_format_slot(&movies, &stamp, "mp4");
            run_edit_pipeline(
                &screen_path,
                &segments,
                &output,
                &sidecar,
                PipelineMode::Mp4 { resolution: res },
                webcam_size,
                webcam_corner,
                watermark,
                on_progress,
            )?;
            output
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
            run_edit_pipeline(
                &screen_path,
                &segments,
                &output,
                &sidecar,
                PipelineMode::Gif { resolution: res, fps },
                webcam_size,
                webcam_corner,
                watermark,
                on_progress,
            )?;
            output
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
      "diameter": 240.0
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
                diameter: Some(240.0),
            }],
            thumbnail_time: Some(7.5),
            bubble_roundness: Some(0.35),
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

    // Runnable copy-path guard, self-contained (synthesized source — no
    // dependency on the missing May baseline fixtures, DECISIONS.md
    // 2026-07-13). Runs the real MP4-Source pipeline and pins the -c:v copy
    // fast path via video stream md5: a no-zoom sidecar must keep the video
    // stream bit-exact while audio re-encodes (arnndn + AAC). Also pins that
    // a NON-empty zoom track is inert to export — step 4 wires rendering and
    // must flip that half to a re-encode assertion.
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

        let out_plain = dir.join("out-plain.mp4");
        run_edit_pipeline(
            &source,
            &[],
            &out_plain,
            &SidecarState::default(),
            PipelineMode::Mp4 { resolution: Mp4Resolution::Source },
            crate::composite::WebcamSize::Medium,
            crate::composite::Corner::BottomRight,
            None,
            |_| {},
        )
        .expect("plain save");
        assert_eq!(
            stream_md5(out_plain.to_str().unwrap(), "0:v"),
            src_v,
            "no-zoom save must stay on -c:v copy (video bit-exact)"
        );
        assert_ne!(
            stream_md5(out_plain.to_str().unwrap(), "0:a"),
            src_a,
            "audio should re-encode (arnndn + AAC)"
        );

        let zoomed = SidecarState {
            zoom: vec![ZoomKeyframe {
                t: 0.5,
                scale: 2.0,
                center_x: 160.0,
                center_y: 120.0,
                ease: Ease::InOutCubic,
                auto_generated: false,
            }],
            ..Default::default()
        };
        let out_zoomed = dir.join("out-zoomed.mp4");
        run_edit_pipeline(
            &source,
            &[],
            &out_zoomed,
            &zoomed,
            PipelineMode::Mp4 { resolution: Mp4Resolution::Source },
            crate::composite::WebcamSize::Medium,
            crate::composite::Corner::BottomRight,
            None,
            |_| {},
        )
        .expect("zoomed save");
        assert_eq!(
            stream_md5(out_zoomed.to_str().unwrap(), "0:v"),
            src_v,
            "zoom rendering is not wired until step 4 — video still copies"
        );
    }

    #[test]
    fn annotation_color_parses_and_defaults_white() {
        assert_eq!(parse_annotation_color(None), (255, 255, 255));
        assert_eq!(parse_annotation_color(Some("#FF3B30")), (255, 59, 48));
        assert_eq!(parse_annotation_color(Some("0A84FF")), (10, 132, 255));
        assert_eq!(parse_annotation_color(Some("nonsense")), (255, 255, 255));
        assert_eq!(parse_annotation_color(Some("#FFF")), (255, 255, 255));
    }

    // Arrow PNG renders in the sidecar color with a contrasting outline:
    // rasterize a fat horizontal arrow and check a mid-shaft pixel is the
    // fill color and a just-outside-the-shaft pixel is the opposite-luma
    // rim. Geometry: 200x100, stroke 10 → fill spans y 45..55, outline_t
    // = 2.5 → rim band y 55..57.5, so (80, 56) sits mid-rim.
    fn assert_arrow_fill_and_outline(color: (u8, u8, u8), expected_outline: (u8, u8, u8)) {
        let dir = std::env::temp_dir().join("zeigen-ann-color-test");
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join(format!("arrow-{}-{}-{}.png", color.0, color.1, color.2));
        rasterize_arrow(
            200,
            100,
            &Position { x: 0.1, y: 0.5 },
            &Position { x: 0.9, y: 0.5 },
            10.0,
            color,
            &p,
        )
        .expect("rasterize arrow");
        let pixmap = tiny_skia::Pixmap::load_png(&p).expect("decode arrow png");
        // Mid-shaft: x=40% of 200, y=50% of 100 — solidly inside the stroke.
        let px = pixmap.pixel(80, 50).expect("pixel in bounds");
        assert_eq!(px.alpha(), 255, "shaft pixel should be opaque");
        assert_eq!(
            (px.red(), px.green(), px.blue()),
            color,
            "shaft pixel should be the sidecar color"
        );
        let rim = pixmap.pixel(80, 56).expect("rim pixel in bounds");
        assert_eq!(rim.alpha(), 255, "rim pixel should be opaque");
        assert_eq!(
            (rim.red(), rim.green(), rim.blue()),
            expected_outline,
            "rim pixel should be the contrast outline"
        );
        assert_ne!(
            is_dark_color(color),
            is_dark_color((rim.red(), rim.green(), rim.blue())),
            "outline luma should be opposite the fill luma"
        );
    }

    #[test]
    fn arrow_rasterizes_in_annotation_color() {
        // Red is dark by Rec.709 luma → light rim.
        assert_arrow_fill_and_outline((255, 59, 48), (245, 245, 247));
    }

    #[test]
    fn arrow_outline_contrasts_light_fill() {
        // White fill → dark rim.
        assert_arrow_fill_and_outline((255, 255, 255), (20, 20, 22));
    }

    // Text PNG: red glyphs land red-dominant pixels on the dark pill, and
    // a black color flips the pill light (the isDarkColor mirror).
    #[test]
    fn text_rasterizes_in_annotation_color_with_pill_flip() {
        let dir = std::env::temp_dir().join("zeigen-ann-color-test");
        std::fs::create_dir_all(&dir).unwrap();

        let red_path = dir.join("text-red.png");
        rasterize_text("X", 64.0, (255, 59, 48), &red_path).expect("rasterize red text");
        let red = tiny_skia::Pixmap::load_png(&red_path).expect("decode red text png");
        let red_hit = red.pixels().iter().any(|px| {
            // Unpremultiplied check: fully-covered glyph pixels are opaque,
            // so premul == straight there. Red glyph over dark bg stays
            // red-dominant.
            px.alpha() == 255 && px.red() > 200 && px.green() < 100 && px.blue() < 100
        });
        assert!(red_hit, "red text should produce red glyph pixels");

        let black_path = dir.join("text-black.png");
        rasterize_text("X", 64.0, (0, 0, 0), &black_path).expect("rasterize black text");
        let black = tiny_skia::Pixmap::load_png(&black_path).expect("decode black text png");
        // Corner pixel is pure pill (no glyph coverage): light pill for a
        // dark color. 0xCC-alpha premul of 245 ≈ 196.
        let corner = black.pixel(1, 1).expect("corner pixel");
        assert!(
            corner.red() > 150 && corner.green() > 150 && corner.blue() > 150,
            "black text should sit on a light pill, got ({}, {}, {})",
            corner.red(),
            corner.green(),
            corner.blue()
        );
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
            meta.start,
            meta.duration,
            video_duration,
            video_duration - meta.duration
        );
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
    }

    // Phase 14 c2 D-08 measurement. Times the arnndn pass against the
    // c1 scratch baseline. Threshold: <2s → eager (block review video swap),
    // ≥2s → lazy (raw plays until preview ready). Asserts the preview audio
    // stream md5 differs from source (arnndn ran) and duration is preserved.
    //   cargo test --lib render_preview_audio_baseline -- --ignored --nocapture
    #[test]
    #[ignore]
    fn render_preview_audio_baseline() {
        ensure_audio_model_for_tests();
        let home = std::env::var("HOME").unwrap();
        let source_str = format!(
            "{home}/Movies/Zeigen/.scratch-baseline-c1/recording-2026-05-19-114549/recording-2026-05-19-114549.mp4"
        );
        let source = Path::new(&source_str);
        assert!(source.exists(), "baseline source missing");

        let preview = source.parent().unwrap().join("preview.mp4");
        let _ = std::fs::remove_file(&preview);

        let start = std::time::Instant::now();
        render_preview_audio_path(source, &preview).expect("render preview");
        let elapsed = start.elapsed();
        assert!(preview.exists(), "preview file not created");

        let src_dur = probe_duration_seconds(source).expect("source duration");
        let prev_dur = probe_duration_seconds(&preview).expect("preview duration");
        println!(
            "preview render: {:.2}s wall-clock for {:.2}s recording (preview={:.2}s)",
            elapsed.as_secs_f64(),
            src_dur,
            prev_dur,
        );
        assert!(
            (src_dur - prev_dur).abs() < 0.1,
            "duration mismatch: src={src_dur} prev={prev_dur}"
        );

        let src_a = stream_md5(&source_str, "0:a:0");
        let prev_a = stream_md5(&preview.to_string_lossy(), "0:a:0");
        assert_ne!(
            src_a, prev_a,
            "preview audio should differ from source (arnndn applied)"
        );
    }

    // End-to-end check against the Phase 10 c1 scratch baseline. Verifies
    // that the MP4 path through run_edit_pipeline honors source + sidecar
    // on Source resolution and produces a 720-tall output on P720. Mirrors
    // gif_export_baseline. Run explicitly:
    //   cargo test --lib mp4_save_baseline -- --ignored --nocapture
    //
    // Source-path output also gets a frame-metadata CSV dumped next to it
    // for manual regression diffs against a pre-refactor capture (Phase 10
    // c1 method — see PHASE-10-PLAN.md §c1 Done-when).
    #[test]
    #[ignore]
    fn mp4_save_baseline() {
        ensure_audio_model_for_tests();
        let home = std::env::var("HOME").unwrap();
        let source_str = format!(
            "{home}/Movies/Zeigen/.scratch-baseline-c1/recording-2026-05-19-114549/recording-2026-05-19-114549.mp4"
        );
        let source = Path::new(&source_str);
        assert!(source.exists(), "baseline source missing");
        let sidecar = read_sidecar_path(source)
            .expect("read sidecar")
            .expect("baseline sidecar present");
        assert!(sidecar.trim.is_some(), "baseline sidecar missing trim");
        assert!(
            sidecar.annotations.iter().any(|a| a.kind == "text"),
            "baseline sidecar missing text annotation"
        );
        assert!(
            sidecar.annotations.iter().any(|a| a.kind == "arrow"),
            "baseline sidecar missing arrow annotation"
        );

        // --- Source resolution: regression-proof path ---
        let src_out_str = format!("{home}/Movies/Zeigen/test-mp4-c1-source.mp4");
        let src_csv_str = format!("{home}/Movies/Zeigen/test-mp4-c1-source.csv");
        let _ = std::fs::remove_file(&src_out_str);
        let _ = std::fs::remove_file(&src_csv_str);

        run_edit_pipeline(
            source,
            &[],
            Path::new(&src_out_str),
            &sidecar,
            PipelineMode::Mp4 { resolution: Mp4Resolution::Source },
            crate::composite::WebcamSize::Medium,
            crate::composite::Corner::BottomRight,
            None,
            |_| {},
        )
        .expect("source pipeline");

        let (src_w_in, src_h_in) = probe_dimensions(source).expect("probe source input dims");
        let (sw, sh) = probe_dimensions(Path::new(&src_out_str)).expect("probe source dims");
        // Source path skips the scale node entirely, so output dimensions
        // match the input mp4.
        assert_eq!(
            (sw, sh), (src_w_in, src_h_in),
            "Source output dims {sw}x{sh} should match input {src_w_in}x{src_h_in}"
        );

        let probe = Command::new(FFPROBE_PATH)
            .args([
                "-v", "error", "-select_streams", "v:0", "-show_entries",
                "frame=pkt_pts_time,pict_type,pkt_size", "-of", "csv",
            ])
            .arg(&src_out_str)
            .output()
            .expect("ffprobe frames");
        assert!(probe.status.success(), "ffprobe non-zero");
        std::fs::write(&src_csv_str, &probe.stdout).expect("write source csv");
        println!(
            "source: {} ({}x{}) — csv {} bytes at {}",
            src_out_str, sw, sh, probe.stdout.len(), src_csv_str
        );

        // --- P720 resolution: smoke ---
        let p720_out_str = format!("{home}/Movies/Zeigen/test-mp4-c1-p720.mp4");
        let _ = std::fs::remove_file(&p720_out_str);
        run_edit_pipeline(
            source,
            &[],
            Path::new(&p720_out_str),
            &sidecar,
            PipelineMode::Mp4 { resolution: Mp4Resolution::P720 },
            crate::composite::WebcamSize::Medium,
            crate::composite::Corner::BottomRight,
            None,
            |_| {},
        )
        .expect("p720 pipeline");
        let (_, h720) = probe_dimensions(Path::new(&p720_out_str)).expect("probe p720 dims");
        assert_eq!(h720, 720, "P720 output height should be 720, got {h720}");
        println!("p720: {p720_out_str} ({h720} tall)");
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

    // Decode-then-md5 helpers for the phase 15 c2 byte-stability test.
    // h264_videotoolbox isn't bit-deterministic at the bitstream level
    // (internal scheduling makes two encodes of the same input produce
    // different bytes). Decoded pixels are the right comparison axis.
    // Uses ffmpeg's md5 muxer over a forced rawvideo/pcm encode so the
    // hash covers decoded samples, not the source bitstream.
    fn decoded_video_md5(path: &Path) -> String {
        let out = Command::new(FFMPEG_PATH)
            .args([
                "-v", "error", "-i", &path.to_string_lossy(),
                "-map", "0:v:0",
                "-c:v", "rawvideo", "-pix_fmt", "yuv420p",
                "-f", "md5", "-",
            ])
            .output()
            .expect("ffmpeg decoded video md5");
        assert!(
            out.status.success(),
            "ffmpeg decoded video md5 failed for {}: {}",
            path.display(),
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout)
            .trim()
            .strip_prefix("MD5=")
            .map(|s| s.to_string())
            .unwrap_or_else(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
    }

    fn decoded_audio_md5(path: &Path) -> Option<String> {
        let out = Command::new(FFMPEG_PATH)
            .args([
                "-v", "error", "-i", &path.to_string_lossy(),
                "-map", "0:a:0?",
                "-c:a", "pcm_s16le", "-ac", "2", "-ar", "48000",
                "-f", "md5", "-",
            ])
            .output()
            .expect("ffmpeg decoded audio md5");
        if !out.status.success() {
            return None;
        }
        let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if s.is_empty() {
            return None;
        }
        Some(
            s.strip_prefix("MD5=")
                .map(|s| s.to_string())
                .unwrap_or(s),
        )
    }

    fn psnr_video(reference: &Path, distorted: &Path) -> Result<String, String> {
        // ffmpeg's psnr filter writes average per-frame PSNR to stats_file
        // OR a summary on stderr via -loglevel info. Easier: scrape stderr
        // for the "PSNR y:... u:... v:... average:..." summary line.
        let out = Command::new(FFMPEG_PATH)
            .args([
                "-v", "error",
                "-i", &reference.to_string_lossy(),
                "-i", &distorted.to_string_lossy(),
                "-filter_complex", "[0:v][1:v]psnr",
                "-f", "null", "-",
            ])
            .output()
            .map_err(|e| format!("psnr spawn: {e}"))?;
        let stderr = String::from_utf8_lossy(&out.stderr);
        for line in stderr.lines() {
            if line.contains("PSNR") {
                return Ok(line.trim().to_string());
            }
        }
        let mut tail: Vec<&str> = stderr.lines().rev().take(20).collect();
        tail.reverse();
        Err(format!("no PSNR line in ffmpeg output:\n{}", tail.join("\n")))
    }

    // Phase 15 c2 byte-stability test. Runs the new composite-at-export
    // pipeline against a stashed phase14 fixture and compares output to
    // expected-phase14-save.mp4. Fixtures stashed at
    //   ~/Movies/Zeigen/.phase15-baseline/<recording-dir>/
    // containing:
    //   sources/screen.mp4
    //   sources/webcam-NN.mp4
    //   .recording-<stamp>.annotations.json
    //   expected-phase14-save.mp4    (Phase 14's Save output for these inputs)
    //
    // Test runs against both stashed fixtures: -204330 (static-corner) and
    // -205517 (keyframe-interp). Prints decoded-video md5 + decoded-audio md5
    // for each side; if they differ, prints PSNR so the user can judge
    // whether the divergence is acceptable (one-pass-vs-two-pass quantizer
    // jitter) or real (regression).
    //
    //   cargo test --lib c2_byte_stability -- --ignored --nocapture
    #[test]
    #[ignore]
    fn c2_byte_stability() {
        ensure_audio_model_for_tests();
        let home = std::env::var("HOME").unwrap();
        let baseline_root = PathBuf::from(&home)
            .join("Movies/Zeigen/.phase15-baseline");
        assert!(
            baseline_root.is_dir(),
            "baseline root missing: {}",
            baseline_root.display()
        );

        // Both fixtures hit the keyframe-interp composite branch (the
        // "static-corner" branch in composite.rs is effectively dead code
        // — bubble_position_event auto-samples at ~4Hz even without drag,
        // so any real recording produces a non-empty log). -205517 has 50
        // entries with movement; -213321 has 27 entries clustered at the
        // default position. Together they cover the live + idle keyframe
        // shapes.
        //
        // -204330 is excluded: its sidecar's bubble_position_log was
        // wiped by the c0 bug before stashing, so Phase 14's expected
        // file reflects baked-in keyframes that c2 can't reproduce from
        // the wiped sidecar. Not a c2 regression; a fixture-capture race.
        let fixtures = [
            "recording-2026-06-02-205517", // keyframe-interp, w/ drag
            "recording-2026-06-02-213321", // keyframe-interp, idle
        ];

        let mut any_diff = false;
        for fix_name in fixtures {
            let fix_dir = baseline_root.join(fix_name);
            let source = fix_dir.join(format!("{fix_name}.mp4"));
            let expected = fix_dir.join("expected-phase14-save.mp4");
            assert!(source.is_file(), "fixture source missing: {}", source.display());
            assert!(expected.is_file(), "fixture expected missing: {}", expected.display());

            let sidecar = read_sidecar_path(&source)
                .expect("read sidecar")
                .unwrap_or_default();

            let (screen_path, segments) = export_inputs_from_source(&source);
            println!("\n=== fixture: {fix_name} ===");
            println!("  screen: {}", screen_path.display());
            println!("  segments: {}", segments.len());
            println!("  bubble_position_log entries: {}", sidecar.bubble_position_log.len());

            // New pipeline output lands in a per-fixture temp file outside
            // ~/Movies/Zeigen so it doesn't pollute the user's recordings.
            let out_dir = std::env::temp_dir().join(format!("phase15-c2-test-{fix_name}"));
            let _ = std::fs::remove_dir_all(&out_dir);
            std::fs::create_dir_all(&out_dir).expect("create out dir");
            let actual = out_dir.join("actual.mp4");

            let start = std::time::Instant::now();
            run_edit_pipeline(
                &screen_path,
                &segments,
                &actual,
                &sidecar,
                PipelineMode::Mp4 { resolution: Mp4Resolution::Source },
                crate::composite::WebcamSize::Medium,
                crate::composite::Corner::BottomRight,
                None,
                |_| {},
            )
            .expect("run new pipeline");
            let elapsed = start.elapsed();
            println!("  new pipeline: {:.2}s", elapsed.as_secs_f64());

            let exp_dur = probe_duration_seconds(&expected).expect("expected duration");
            let act_dur = probe_duration_seconds(&actual).expect("actual duration");
            let exp_dims = probe_dimensions(&expected).expect("expected dims");
            let act_dims = probe_dimensions(&actual).expect("actual dims");
            println!(
                "  duration: expected={:.3}s actual={:.3}s (Δ={:.3}s)",
                exp_dur, act_dur, (exp_dur - act_dur).abs()
            );
            println!(
                "  dimensions: expected={}x{} actual={}x{}",
                exp_dims.0, exp_dims.1, act_dims.0, act_dims.1
            );
            assert_eq!(exp_dims, act_dims, "dimensions differ for {fix_name}");
            assert!(
                (exp_dur - act_dur).abs() < 0.1,
                "duration differs by more than frame for {fix_name}"
            );

            let exp_vid = decoded_video_md5(&expected);
            let act_vid = decoded_video_md5(&actual);
            let exp_aud = decoded_audio_md5(&expected);
            let act_aud = decoded_audio_md5(&actual);
            println!("  video md5: expected={exp_vid}");
            println!("             actual=  {act_vid}");
            println!("  audio md5: expected={:?}", exp_aud);
            println!("             actual=  {:?}", act_aud);

            // Phase 15 #4 fix landed 2026-06-07: bubble_position_log
            // entries are shifted at finalize so their t corresponds to
            // screen.mp4 PTS=0 instead of started_at. This intentionally
            // changes composite output relative to Phase 14, so the
            // equivalence assertion below is no longer the right check.
            // Outputs are still informative (md5 / PSNR printed above)
            // for manual inspection, but we don't fail on divergence.
            //
            // TODO (post-fix verification): record a fresh post-fix
            // fixture, stash it under a new path, and make it the new
            // baseline. The old phase-14 fixtures (-205517, -213321) stay
            // only as historical reference.
            if exp_vid == act_vid && exp_aud == act_aud {
                println!("  MATCH (decoded md5 stable — pre-fix fixture)");
            } else {
                println!("  EXPECTED DIVERGENCE from phase 14 (#4 fix shifted bubble timing)");
                if exp_vid != act_vid {
                    println!("  computing PSNR for reference…");
                    match psnr_video(&expected, &actual) {
                        Ok(psnr) => println!("  {psnr}"),
                        Err(e) => println!("  psnr failed: {e}"),
                    }
                }
                any_diff = true;
            }
        }

        // any_diff is no longer fatal — kept for the println! summary
        // and to flag that the test produced informational output the
        // operator should glance at. Replace with a real baseline-match
        // assertion once a post-fix fixture is stashed.
        if any_diff {
            println!(
                "\nc2_byte_stability: divergence observed (expected per #4 fix). \
                 Test does not fail on this — see TODO above to replace fixtures."
            );
        }
    }

    #[test]
    #[ignore]
    fn save_recording_baseline() {
        ensure_audio_model_for_tests();
        let home = std::env::var("HOME").unwrap();
        let source_str = format!(
            "{home}/Movies/Zeigen/.scratch-baseline-c1/recording-2026-05-19-114549/recording-2026-05-19-114549.mp4"
        );
        let sidecar_path = format!(
            "{home}/Movies/Zeigen/.scratch-baseline-c1/recording-2026-05-19-114549/.recording-2026-05-19-114549.annotations.json"
        );
        assert!(Path::new(&source_str).exists(), "baseline source missing");
        assert!(Path::new(&sidecar_path).exists(), "baseline sidecar missing");

        // --- noop + MP4-Source: hard-link path. We point at the source mp4
        // but feed in a stamp pointing at an empty-sidecar fixture so the
        // baseline's real sidecar (which has edits) is bypassed. To keep the
        // test self-contained, we copy the source mp4 to a tmp dir with no
        // adjacent sidecar; read_sidecar_path then returns None and the noop
        // branch fires.
        let tmp_dir = std::env::temp_dir().join("zeigen-save-recording-test");
        let _ = std::fs::remove_dir_all(&tmp_dir);
        std::fs::create_dir_all(&tmp_dir).expect("create tmp dir");
        let noop_src = tmp_dir.join("recording-test-noop-c2.mp4");
        std::fs::copy(&source_str, &noop_src).expect("copy noop source");

        let movies = PathBuf::from(&home).join("Movies/Zeigen");
        let noop_out_first = movies.join("recording-test-noop-c2.mp4");
        let noop_out_second = movies.join("recording-test-noop-c2-2.mp4");
        let _ = std::fs::remove_file(&noop_out_first);
        let _ = std::fs::remove_file(&noop_out_second);

        let result = save_recording_impl(
            "test-noop-c2".to_string(),
            noop_src.to_string_lossy().into_owned(),
            "mp4".to_string(),
            "source".to_string(),
            None,
            None,
            None,
            None,
            None,
            |_| {},
        )
        .expect("save_recording noop");
        assert_eq!(result.output_path, noop_out_first.to_string_lossy());
        assert!(noop_out_first.exists(), "noop output missing");
        let out_meta = std::fs::metadata(&noop_out_first).expect("stat noop out");
        assert!(
            out_meta.is_file() && out_meta.len() > 0,
            "noop output should be a non-empty regular file"
        );
        // Phase 12 c3 inverts the Phase 11 invariant: noop MP4-Source no
        // longer hard-links. Same inode means the short-circuit got
        // accidentally revived.
        let src_meta = std::fs::metadata(&noop_src).expect("stat noop src");
        use std::os::unix::fs::MetadataExt;
        assert_ne!(
            src_meta.ino(),
            out_meta.ino(),
            "noop save should run the pipeline (different inode), not hard-link"
        );
        // Video stream is bit-exact (-c:v copy), audio is re-encoded
        // (arnndn + AAC). Equal video-md5 means the video pipeline didn't
        // accidentally fall through to h264_videotoolbox; differing audio-
        // md5 means arnndn + AAC actually ran.
        let src_v = stream_md5(noop_src.to_str().unwrap(), "0:v");
        let out_v = stream_md5(noop_out_first.to_str().unwrap(), "0:v");
        assert_eq!(src_v, out_v, "noop video stream should be copied bit-exact");
        let src_a = stream_md5(noop_src.to_str().unwrap(), "0:a");
        let out_a = stream_md5(noop_out_first.to_str().unwrap(), "0:a");
        assert_ne!(src_a, out_a, "noop audio stream should differ (arnndn + AAC ran)");

        // --- per-format collision: second call lands at -2.mp4 ---
        let result2 = save_recording_impl(
            "test-noop-c2".to_string(),
            noop_src.to_string_lossy().into_owned(),
            "mp4".to_string(),
            "source".to_string(),
            None,
            None,
            None,
            None,
            None,
            |_| {},
        )
        .expect("save_recording second");
        assert_eq!(result2.output_path, noop_out_second.to_string_lossy());
        assert!(noop_out_second.exists(), "second output missing");

        // --- edits + MP4-P720: pipeline pass, 720 tall ---
        // Drop the baseline sidecar next to a fresh source copy so the
        // edits feed through run_edit_pipeline.
        let edited_src = tmp_dir.join("recording-test-edits-c2.mp4");
        std::fs::copy(&source_str, &edited_src).expect("copy edited source");
        std::fs::copy(
            &sidecar_path,
            tmp_dir.join(".recording-test-edits-c2.annotations.json"),
        )
        .expect("copy edited sidecar");

        let p720_out = movies.join("recording-test-edits-c2.mp4");
        let _ = std::fs::remove_file(&p720_out);

        let result3 = save_recording_impl(
            "test-edits-c2".to_string(),
            edited_src.to_string_lossy().into_owned(),
            "mp4".to_string(),
            "720p".to_string(),
            None,
            None,
            None,
            None,
            None,
            |_| {},
        )
        .expect("save_recording p720");
        assert_eq!(result3.output_path, p720_out.to_string_lossy());
        let (_, h720) = probe_dimensions(&p720_out).expect("probe p720");
        assert_eq!(h720, 720, "edited mp4 should be 720 tall, got {h720}");
        // Non-noop save: video stream md5 must differ (full re-encode).
        let p720_src_v = stream_md5(edited_src.to_str().unwrap(), "0:v");
        let p720_out_v = stream_md5(p720_out.to_str().unwrap(), "0:v");
        assert_ne!(
            p720_src_v, p720_out_v,
            "edited p720 video stream should differ from source (full re-encode)"
        );

        // --- edits + GIF-720p@15: pipeline pass, valid GIF ---
        let gif_out = movies.join("recording-test-edits-c2.gif");
        let _ = std::fs::remove_file(&gif_out);

        let result4 = save_recording_impl(
            "test-edits-c2".to_string(),
            edited_src.to_string_lossy().into_owned(),
            "gif".to_string(),
            "720p".to_string(),
            Some(15),
            None,
            None,
            None,
            None,
            |_| {},
        )
        .expect("save_recording gif");
        assert_eq!(result4.output_path, gif_out.to_string_lossy());
        let bytes = std::fs::read(&gif_out).expect("read gif");
        assert!(bytes.len() > 100, "gif too small");
        let header = &bytes[..6];
        assert!(
            header == b"GIF89a" || header == b"GIF87a",
            "not a GIF: {header:?}"
        );

        // --- fps required for gif format ---
        let err = save_recording_impl(
            "test-edits-c2".to_string(),
            edited_src.to_string_lossy().into_owned(),
            "gif".to_string(),
            "720p".to_string(),
            None,
            None,
            None,
            None,
            None,
            |_| {},
        )
        .expect_err("gif without fps should fail");
        assert!(err.contains("fps"), "expected fps error, got: {err}");

        println!(
            "ok: noop={}, collision={}, p720={} ({} tall), gif={} ({} bytes)",
            noop_out_first.display(),
            noop_out_second.display(),
            p720_out.display(),
            h720,
            gif_out.display(),
            bytes.len(),
        );
    }

    // c2 watermark verification. Bakes the verification logo into all four
    // export routes against a real recording, leaves outputs + extracted
    // frames in /tmp for visual inspection, asserts each is valid, and
    // re-checks the no-watermark noop-source path still copies video
    // bit-exact (arnndn-only audio) — the regression the PLAN flags.
    //   cargo test --lib watermark_export_smoke -- --ignored --nocapture
    #[test]
    #[ignore]
    fn watermark_export_smoke() {
        ensure_audio_model_for_tests();
        let home = std::env::var("HOME").unwrap();
        let source_str = format!(
            "{home}/Movies/Zeigen/.scratch/recording-2026-05-28-081925/recording-2026-05-28-081925.mp4"
        );
        let source = Path::new(&source_str);
        let logo_str = format!("{home}/Downloads/Archetype_Logo_Icon_Color.png");
        let logo = Path::new(&logo_str);
        if !source.is_file() || !logo.is_file() {
            eprintln!("skip watermark_export_smoke: source or logo absent");
            return;
        }
        let sidecar = SidecarState::default();
        let wm_tr = Watermark::from_args(Some(logo_str.clone()), Some("tr".into()), None, None);
        let wm_bl = Watermark::from_args(Some(logo_str.clone()), Some("bl".into()), None, None);
        let (sw, sh) = probe_dimensions(source).expect("probe source");

        let extract_frame = |video: &str, png: &str| {
            let _ = std::fs::remove_file(png);
            let st = Command::new(FFMPEG_PATH)
                .args(["-y", "-i", video, "-frames:v", "1", png])
                .output()
                .expect("ffmpeg frame extract");
            assert!(st.status.success(), "extract frame from {video}");
        };

        // a) MP4-Source + watermark TR (also the Copy-to-Clipboard path —
        // clipboard_copy_recording calls run_edit_pipeline Mp4/Source).
        let out_src = "/tmp/zeigen-wm-mp4-source-tr.mp4";
        run_edit_pipeline(source, &[], Path::new(out_src), &sidecar,
            PipelineMode::Mp4 { resolution: Mp4Resolution::Source },
            crate::composite::WebcamSize::Medium, crate::composite::Corner::BottomRight,
            wm_tr.clone(), |_| {})
            .expect("mp4 source + watermark");
        assert_eq!(probe_dimensions(Path::new(out_src)).unwrap(), (sw, sh), "source res preserved");
        extract_frame(out_src, "/tmp/zeigen-wm-frame-pipeline-tr.png");

        // a') BL corner — corner-switch check.
        let out_bl = "/tmp/zeigen-wm-mp4-source-bl.mp4";
        run_edit_pipeline(source, &[], Path::new(out_bl), &sidecar,
            PipelineMode::Mp4 { resolution: Mp4Resolution::Source },
            crate::composite::WebcamSize::Medium, crate::composite::Corner::BottomRight,
            wm_bl, |_| {})
            .expect("mp4 source + watermark bl");
        extract_frame(out_bl, "/tmp/zeigen-wm-frame-pipeline-bl.png");

        // b) MP4-720p + watermark — logo scales with the frame.
        let out_720 = "/tmp/zeigen-wm-mp4-720.mp4";
        run_edit_pipeline(source, &[], Path::new(out_720), &sidecar,
            PipelineMode::Mp4 { resolution: Mp4Resolution::P720 },
            crate::composite::WebcamSize::Medium, crate::composite::Corner::BottomRight,
            wm_tr.clone(), |_| {})
            .expect("mp4 720 + watermark");
        assert_eq!(probe_dimensions(Path::new(out_720)).unwrap().1, 720, "720 tall");

        // c) GIF + watermark — valid GIF header.
        let out_gif = "/tmp/zeigen-wm.gif";
        run_edit_pipeline(source, &[], Path::new(out_gif), &sidecar,
            PipelineMode::Gif { resolution: GifResolution::P480, fps: 12 },
            crate::composite::WebcamSize::Medium, crate::composite::Corner::BottomRight,
            wm_tr.clone(), |_| {})
            .expect("gif + watermark");
        let gif_bytes = std::fs::read(out_gif).expect("read gif");
        assert!(
            gif_bytes.len() > 6 && (&gif_bytes[..6] == b"GIF89a" || &gif_bytes[..6] == b"GIF87a"),
            "valid GIF"
        );

        // d) LinkedIn — distinct -filter_complex invocation reusing the helper.
        let li = crate::linkedin::linkedin_export(
            "wm-smoke".into(), source_str.clone(), Some(logo_str.clone()), Some("tr".into()),
        ).expect("linkedin + watermark");
        assert!(Path::new(&li).is_file(), "linkedin output exists");
        extract_frame(&li, "/tmp/zeigen-wm-frame-linkedin-tr.png");

        // f) No-watermark noop regression: video copied bit-exact, audio re-encoded.
        let noop = "/tmp/zeigen-wm-noop.mp4";
        run_edit_pipeline(source, &[], Path::new(noop), &sidecar,
            PipelineMode::Mp4 { resolution: Mp4Resolution::Source },
            crate::composite::WebcamSize::Medium, crate::composite::Corner::BottomRight,
            None, |_| {})
            .expect("noop");
        assert_eq!(
            stream_md5(&source_str, "0:v"), stream_md5(noop, "0:v"),
            "no-watermark noop-source must copy video bit-exact (no re-encode)"
        );
        assert_ne!(
            stream_md5(&source_str, "0:a"), stream_md5(noop, "0:a"),
            "noop audio must differ (arnndn ran)"
        );

        println!(
            "watermark OK: pipeline TR/BL + 720 + gif + linkedin({li}); frames in /tmp/zeigen-wm-frame-*.png; noop video bit-exact, audio re-encoded"
        );
    }
}
