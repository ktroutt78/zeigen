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

fn edited_output_path(source: &Path) -> PathBuf {
    let parent = source.parent().unwrap_or_else(|| Path::new(""));
    let stem = source.file_stem().unwrap_or_default();
    let ext = source
        .extension()
        .map(|e| e.to_owned())
        .unwrap_or_else(|| std::ffi::OsString::from("mp4"));
    let mut name = stem.to_os_string();
    name.push("-edited.");
    name.push(&ext);
    parent.join(name)
}

fn probe_duration_seconds(path: &Path) -> Result<f64, String> {
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

fn probe_dimensions(path: &Path) -> Result<(u32, u32), String> {
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

// Single-pass save pipeline. Trim via -ss/-to before -i; text annotations
// rendered with drawtext (textfile=… to avoid escape headaches); arrows
// composited as transparent PNGs in C5. Output via h264_videotoolbox.
#[tauri::command]
pub fn edit_save(source_path: String, sidecar: SidecarState) -> Result<String, String> {
    let source = PathBuf::from(&source_path);
    if !source.exists() {
        return Err(format!("source missing: {}", source.display()));
    }
    let output = edited_output_path(&source);
    let duration = probe_duration_seconds(&source)?;

    // Resolve effective trim.
    let trim = match sidecar.trim {
        Some(t) if t.start > TRIM_EPS || t.out < duration - TRIM_EPS => Some(t),
        _ => None,
    };
    let trim_in = trim.as_ref().map(|t| t.start).unwrap_or(0.0);
    let out_duration = trim
        .as_ref()
        .map(|t| (t.out - t.start).max(0.0))
        .unwrap_or(duration);

    // Allocate temp dir for any sidecar artifacts (text files, arrow PNGs).
    let temp_dir = temp_dir_for(&source);
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
        let (sw, sh) = probe_dimensions(&source)?;
        for (idx, ann) in &arrow_anns {
            let endpoint = ann.endpoint.as_ref().expect("filtered above");
            let stroke = ann.stroke.unwrap_or(DEFAULT_ARROW_STROKE_PX);
            let p = temp_dir.join(format!("arrow-{idx}.png"));
            rasterize_arrow(sw, sh, &ann.position, endpoint, stroke, &p)?;
            arrow_paths.push((*idx, p, ann));
        }
    }

    let mut args: Vec<String> = vec!["-y".into(), "-hide_banner".into()];
    if let Some(t) = &trim {
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

    let needs_filter = !text_paths.is_empty() || !arrow_paths.is_empty();
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
            if i + 1 < text_paths.len() || !arrow_paths.is_empty() {
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
            if i + 1 < arrow_paths.len() {
                filter.push(';');
            }
            prev_label = next_label;
            input_idx += 1;
        }

        args.push("-filter_complex".into());
        args.push(filter);
        args.push("-map".into());
        args.push(format!("[{prev_label}]"));
        args.push("-map".into());
        args.push("0:a?".into());
    }

    args.push("-c:v".into());
    args.push("h264_videotoolbox".into());
    args.push("-b:v".into());
    args.push("8M".into());
    args.push("-c:a".into());
    args.push("aac".into());
    args.push("-b:a".into());
    args.push("192k".into());

    args.push(output.to_string_lossy().into_owned());

    let result = Command::new(FFMPEG_PATH)
        .args(&args)
        .output()
        .map_err(|e| format!("failed to spawn ffmpeg: {e}"))?;

    if !result.status.success() {
        let stderr = String::from_utf8_lossy(&result.stderr);
        return Err(format!(
            "ffmpeg edit_save failed (exit {:?}):\n{}",
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

    Ok(output.to_string_lossy().into_owned())
}
