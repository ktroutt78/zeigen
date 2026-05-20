use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

use ab_glyph::{point, Font, FontRef, Glyph, PxScale, ScaleFont};
use serde::{Deserialize, Serialize};

use crate::composite::{FFMPEG_PATH, FFPROBE_PATH};

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct SidecarState {
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub trim: Option<Trim>,
    #[serde(default)]
    pub annotations: Vec<Annotation>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub bubble_position_log: Vec<BubblePositionEntry>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
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

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Trim {
    #[serde(rename = "in")]
    pub start: f64,
    pub out: f64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
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

#[derive(Serialize, Deserialize, Clone, Debug)]
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
fn rasterize_text(content: &str, size_src_px: f64, out_path: &Path) -> Result<(), String> {
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
    // (rgba 20,20,22,0xCC, ~86% opacity).
    {
        let rect = Rect::from_xywh(0.0, 0.0, total_w as f32, total_h as f32)
            .ok_or("invalid bg rect")?;
        let mut pb = PathBuilder::new();
        pb.push_rect(rect);
        let path = pb.finish().ok_or("empty bg path")?;
        let mut paint = Paint::default();
        paint.set_color_rgba8(20, 20, 22, 0xCC);
        paint.anti_alias = true;
        pixmap.fill_path(&path, &paint, FillRule::Winding, Transform::identity(), None);
    }

    // Glyph pass: draw white glyphs over the bg via per-pixel alpha
    // compositing. tiny-skia stores premultiplied RGBA; the compositing
    // formula for "white at alpha a, over premul dst" is:
    //   src_premul = (a, a, a, a)
    //   out = src + dst * (1 - a/255)
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
                let r = (a + cur.red() as u32 * inv / 255).min(255) as u8;
                let g = (a + cur.green() as u32 * inv / 255).min(255) as u8;
                let b = (a + cur.blue() as u32 * inv / 255).min(255) as u8;
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
    paint.set_color_rgba8(255, 255, 255, 255);
    paint.anti_alias = true;

    // Shaft
    if shaft_len > 0.5 {
        let mut pb = PathBuilder::new();
        pb.move_to(sx, sy);
        pb.line_to(shaft_ex, shaft_ey);
        let path = pb.finish().ok_or("empty shaft path")?;
        let mut s = Stroke::default();
        s.width = stroke_w;
        s.line_cap = LineCap::Round;
        s.line_join = LineJoin::Round;
        pixmap.stroke_path(&path, &paint, &s, Transform::identity(), None);
    }

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
    pixmap.fill_path(&head, &paint, FillRule::Winding, Transform::identity(), None);

    let png = pixmap
        .encode_png()
        .map_err(|e| format!("encode png: {e}"))?;
    std::fs::write(out_path, png).map_err(|e| format!("write {}: {e}", out_path.display()))?;
    Ok(())
}

fn temp_dir_for(source: &Path) -> PathBuf {
    let stem = source
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("unknown");
    let parent = source.parent().unwrap_or_else(|| Path::new(""));
    parent.join(".sources").join(format!("edit-{stem}"))
}

// True when the sidecar would produce a byte-identical re-encode: no real
// trim and no renderable annotations. Callers (e.g. commit_recording) can
// skip the ffmpeg pipeline entirely and rename the source file instead.
pub(crate) fn is_edit_pipeline_noop(sidecar: &SidecarState, duration: f64) -> bool {
    let trim_real = match &sidecar.trim {
        Some(t) => t.start > TRIM_EPS || t.out < duration - TRIM_EPS,
        None => false,
    };
    let any_text = sidecar
        .annotations
        .iter()
        .any(|a| a.kind == "text" && !a.content.is_empty());
    let any_arrow = sidecar
        .annotations
        .iter()
        .any(|a| a.kind == "arrow" && a.endpoint.is_some());
    !trim_real && !any_text && !any_arrow
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

// Single-pass edit pipeline. Trim via -ss/-to before -i; text and arrow
// annotations rasterized to PNGs and composited via overlay filters with
// `enable=between(t,start,end)`. Output via h264_videotoolbox (Mp4) or
// palettegen/paletteuse → GIF muxer (Gif). Caller supplies both source
// and output paths — `commit_recording` reads the scratch mp4 and writes
// directly to the final ~/Movies/Zeigen/ location.
pub(crate) fn run_edit_pipeline(
    source: &Path,
    output: &Path,
    sidecar: &SidecarState,
    mode: PipelineMode,
) -> Result<(), String> {
    let gif_params: Option<(GifResolution, u32)> = match mode {
        PipelineMode::Mp4 { .. } => None,
        PipelineMode::Gif { resolution, fps } => Some((resolution, fps)),
    };
    let gif_mode = gif_params.is_some();
    // None on Source (pipeline stays byte-identical to pre-phase-11); Some
    // on P480/P720/P1080 forces a scale node onto the tail of the overlay
    // chain and forces the filter graph to be built even with no overlays.
    let mp4_scale: Option<Mp4Resolution> = match mode {
        PipelineMode::Mp4 { resolution } if resolution != Mp4Resolution::Source => Some(resolution),
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
    let need_temp = !text_anns.is_empty() || !arrow_anns.is_empty();
    if need_temp {
        std::fs::create_dir_all(&temp_dir)
            .map_err(|e| format!("create {}: {}", temp_dir.display(), e))?;
    }

    // Rasterize each text annotation into a small PNG (sized to the styled
    // text box). The annotation's source-fraction position becomes the
    // overlay x/y.
    let mut text_paths: Vec<(usize, PathBuf, &Annotation)> = Vec::new();
    for (idx, ann) in &text_anns {
        let size = ann.size.unwrap_or(DEFAULT_TEXT_SIZE_PX);
        let p = temp_dir.join(format!("text-{idx}.png"));
        rasterize_text(&ann.content, size, &p)?;
        text_paths.push((*idx, p, ann));
    }

    // Rasterize each arrow into a source-sized transparent PNG. Arrow PNG
    // is source-sized so overlay sits at (0,0).
    let mut arrow_paths: Vec<(usize, PathBuf, &Annotation)> = Vec::new();
    if !arrow_anns.is_empty() {
        let (sw, sh) = probe_dimensions(source)?;
        for (idx, ann) in &arrow_anns {
            let endpoint = ann.endpoint.as_ref().expect("filtered above");
            let stroke = ann.stroke.unwrap_or(DEFAULT_ARROW_STROKE_PX);
            let p = temp_dir.join(format!("arrow-{idx}.png"));
            rasterize_arrow(sw, sh, &ann.position, endpoint, stroke, &p)?;
            arrow_paths.push((*idx, p, ann));
        }
    }

    let mut args: Vec<String> = vec!["-y".into(), "-hide_banner".into()];
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

    // Force-build the filter graph in Gif mode (so the palettegen/paletteuse
    // tail can chain off [0:v]) or whenever an MP4 scale is requested.
    let needs_filter =
        !text_paths.is_empty() || !arrow_paths.is_empty() || gif_mode || mp4_scale.is_some();
    if needs_filter {
        let mut filter = String::new();
        let mut prev_label = String::from("0:v");
        let mut step = 0usize;
        let mut input_idx = 1usize;

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
            if i + 1 < arrow_paths.len() || gif_mode || mp4_scale.is_some() {
                filter.push(';');
            }
            prev_label = next_label;
            input_idx += 1;
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

    match mode {
        PipelineMode::Mp4 { .. } => {
            args.push("-c:v".into());
            args.push("h264_videotoolbox".into());
            args.push("-b:v".into());
            args.push("8M".into());
            args.push("-c:a".into());
            args.push("aac".into());
            args.push("-b:a".into());
            args.push("192k".into());
        }
        PipelineMode::Gif { .. } => {
            args.push("-loop".into());
            args.push("0".into());
        }
    }

    args.push(output.to_string_lossy().into_owned());

    let result = Command::new(FFMPEG_PATH)
        .args(&args)
        .output()
        .map_err(|e| format!("failed to spawn ffmpeg: {e}"))?;

    if !result.status.success() {
        let stderr = String::from_utf8_lossy(&result.stderr);
        return Err(format!(
            "ffmpeg edit pipeline failed (exit {:?}):\n{}",
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
pub fn save_recording(
    stamp: String,
    source_path: String,
    format: String,
    resolution: String,
    fps: Option<u32>,
) -> Result<SaveResult, String> {
    let source = Path::new(&source_path);
    if !source.is_file() {
        return Err(format!("source missing: {}", source.display()));
    }

    let home = std::env::var("HOME").map_err(|_| "HOME not set".to_string())?;
    let movies = PathBuf::from(home).join("Movies/Zeigen");
    std::fs::create_dir_all(&movies)
        .map_err(|e| format!("create {}: {e}", movies.display()))?;

    let sidecar = read_sidecar_path(source)?.unwrap_or_default();

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
            let duration = probe_duration_seconds(source)?;
            if res == Mp4Resolution::Source && is_edit_pipeline_noop(&sidecar, duration) {
                if std::fs::hard_link(source, &output).is_err() {
                    std::fs::copy(source, &output).map_err(|e| {
                        format!("copy {} -> {}: {e}", source.display(), output.display())
                    })?;
                }
            } else {
                run_edit_pipeline(
                    source,
                    &output,
                    &sidecar,
                    PipelineMode::Mp4 { resolution: res },
                )?;
            }
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
                source,
                &output,
                &sidecar,
                PipelineMode::Gif { resolution: res, fps },
            )?;
            output
        }
        other => return Err(format!("unknown format: {other}")),
    };

    Ok(SaveResult {
        output_path: output.to_string_lossy().into_owned(),
    })
}

// Quick GIF export. Reuses the trim + annotation graph from
// run_edit_pipeline with a palettegen/paletteuse tail. Output lives in
// ~/Movies/Zeigen/recording-<stamp>.gif and persists across discard /
// cleanup (mirrors linkedin_export).
//
// Superseded by `save_recording` (Phase 11 c2). Kept alive until the
// frontend rewrite (Phase 11 c4) stops invoking it.
#[tauri::command]
pub fn gif_export(
    stamp: String,
    source_path: String,
    resolution: String,
    fps: u32,
) -> Result<String, String> {
    let source = Path::new(&source_path);
    if !source.is_file() {
        return Err(format!("source missing: {}", source.display()));
    }

    let res = match resolution.as_str() {
        "480p" => GifResolution::P480,
        "720p" => GifResolution::P720,
        "source" => GifResolution::Source,
        other => return Err(format!("unknown resolution: {other}")),
    };

    let home = std::env::var("HOME").map_err(|_| "HOME not set".to_string())?;
    let movies = PathBuf::from(home).join("Movies/Zeigen");
    std::fs::create_dir_all(&movies)
        .map_err(|e| format!("create {}: {e}", movies.display()))?;
    let output = movies.join(format!("recording-{stamp}.gif"));

    let sidecar = read_sidecar_path(source)?.unwrap_or_default();

    run_edit_pipeline(
        source,
        &output,
        &sidecar,
        PipelineMode::Gif { resolution: res, fps },
    )?;

    Ok(output.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    // End-to-end check against the c1 scratch baseline. Verifies that
    // gif_export wires source + sidecar through run_edit_pipeline and
    // emits a real GIF that honors the sidecar trim. Run explicitly:
    //   cargo test --lib gif_export_baseline -- --ignored --nocapture
    #[test]
    #[ignore]
    fn gif_export_baseline() {
        let home = std::env::var("HOME").unwrap();
        let stamp = "test-gif-c2".to_string();
        let source = format!(
            "{home}/Movies/Zeigen/.scratch-baseline-c1/recording-2026-05-19-114549/recording-2026-05-19-114549.mp4"
        );
        let expected_output = format!("{home}/Movies/Zeigen/recording-{stamp}.gif");
        // Make sure we're verifying a fresh write.
        let _ = std::fs::remove_file(&expected_output);

        // Copy the sidecar next to the source so read_sidecar_path finds
        // it (run_edit_pipeline looks adjacent to `source`).
        let baseline_sidecar = format!(
            "{home}/Movies/Zeigen/.scratch-baseline-c1/recording-2026-05-19-114549/.recording-2026-05-19-114549.annotations.json"
        );
        assert!(Path::new(&baseline_sidecar).exists(), "baseline sidecar missing");
        assert!(Path::new(&source).exists(), "baseline source missing");

        let out = gif_export(stamp, source.clone(), "720p".to_string(), 15)
            .expect("gif_export failed");
        assert_eq!(out, expected_output);

        // GIF magic: first 6 bytes are GIF87a or GIF89a.
        let bytes = std::fs::read(&out).expect("read output");
        assert!(bytes.len() > 100, "gif too small: {} bytes", bytes.len());
        let header = &bytes[..6];
        assert!(
            header == b"GIF89a" || header == b"GIF87a",
            "not a GIF: header={:?}",
            header
        );

        // Trim honored: sidecar trim is in=1.16, out=21.48 → ~20.3s.
        let probe = Command::new(FFPROBE_PATH)
            .args([
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
            ])
            .arg(&out)
            .output()
            .expect("ffprobe");
        let dur_s = String::from_utf8_lossy(&probe.stdout).trim().to_string();
        let dur: f64 = dur_s.parse().expect("parse dur");
        assert!(
            (dur - 20.3).abs() < 1.0,
            "gif duration {dur} not within 1.0s of expected ~20.3s"
        );

        println!("ok: {out} ({} bytes, {dur:.2}s)", bytes.len());
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
            Path::new(&src_out_str),
            &sidecar,
            PipelineMode::Mp4 { resolution: Mp4Resolution::Source },
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
            Path::new(&p720_out_str),
            &sidecar,
            PipelineMode::Mp4 { resolution: Mp4Resolution::P720 },
        )
        .expect("p720 pipeline");
        let (_, h720) = probe_dimensions(Path::new(&p720_out_str)).expect("probe p720 dims");
        assert_eq!(h720, 720, "P720 output height should be 720, got {h720}");
        println!("p720: {p720_out_str} ({h720} tall)");
    }

    // Phase 11 c2 smoke. Covers the four done-when bullets from the plan:
    //   - noop sidecar + MP4-Source → hard-link, 0 ffmpeg
    //   - sidecar w/ edits + MP4-P720 → 1 pass, 720 tall
    //   - sidecar w/ edits + GIF-P720@15 → 1 pass, valid GIF
    //   - per-format collision: second MP4-Source call lands at -2.mp4
    // Run explicitly:
    //   cargo test --lib save_recording_baseline -- --ignored --nocapture
    #[test]
    #[ignore]
    fn save_recording_baseline() {
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

        let result = save_recording(
            "test-noop-c2".to_string(),
            noop_src.to_string_lossy().into_owned(),
            "mp4".to_string(),
            "source".to_string(),
            None,
        )
        .expect("save_recording noop");
        assert_eq!(result.output_path, noop_out_first.to_string_lossy());
        assert!(noop_out_first.exists(), "noop output missing");
        // hard_link: same inode as source (verifies we didn't fall through
        // to the pipeline branch — copy fallback would also produce a real
        // file but with a different inode).
        let src_meta = std::fs::metadata(&noop_src).expect("stat noop src");
        let out_meta = std::fs::metadata(&noop_out_first).expect("stat noop out");
        use std::os::unix::fs::MetadataExt;
        assert_eq!(
            src_meta.ino(),
            out_meta.ino(),
            "noop save should hard-link (same inode)"
        );

        // --- per-format collision: second call lands at -2.mp4 ---
        let result2 = save_recording(
            "test-noop-c2".to_string(),
            noop_src.to_string_lossy().into_owned(),
            "mp4".to_string(),
            "source".to_string(),
            None,
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

        let result3 = save_recording(
            "test-edits-c2".to_string(),
            edited_src.to_string_lossy().into_owned(),
            "mp4".to_string(),
            "720p".to_string(),
            None,
        )
        .expect("save_recording p720");
        assert_eq!(result3.output_path, p720_out.to_string_lossy());
        let (_, h720) = probe_dimensions(&p720_out).expect("probe p720");
        assert_eq!(h720, 720, "edited mp4 should be 720 tall, got {h720}");

        // --- edits + GIF-720p@15: pipeline pass, valid GIF ---
        let gif_out = movies.join("recording-test-edits-c2.gif");
        let _ = std::fs::remove_file(&gif_out);

        let result4 = save_recording(
            "test-edits-c2".to_string(),
            edited_src.to_string_lossy().into_owned(),
            "gif".to_string(),
            "720p".to_string(),
            Some(15),
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
        let err = save_recording(
            "test-edits-c2".to_string(),
            edited_src.to_string_lossy().into_owned(),
            "gif".to_string(),
            "720p".to_string(),
            None,
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
}
