use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};

use crate::composite::{FFMPEG_PATH, FFPROBE_PATH};

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct SidecarState {
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub trim: Option<Trim>,
    #[serde(default)]
    pub annotations: Vec<Annotation>,
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
    let stem = source.file_stem().unwrap_or_default();
    let mut name = stem.to_os_string();
    name.push(".annotations.json");
    source.with_file_name(name)
}

#[tauri::command]
pub fn read_sidecar(source_path: String) -> Result<Option<SidecarState>, String> {
    let p = sidecar_path(Path::new(&source_path));
    if !p.exists() {
        return Ok(None);
    }
    let data = std::fs::read_to_string(&p)
        .map_err(|e| format!("read sidecar {}: {e}", p.display()))?;
    let state: SidecarState = serde_json::from_str(&data)
        .map_err(|e| format!("parse sidecar {}: {e}", p.display()))?;
    Ok(Some(state))
}

#[tauri::command]
pub fn write_sidecar(source_path: String, state: SidecarState) -> Result<(), String> {
    let p = sidecar_path(Path::new(&source_path));
    let data = serde_json::to_string_pretty(&state)
        .map_err(|e| format!("serialize sidecar: {e}"))?;
    std::fs::write(&p, data).map_err(|e| format!("write sidecar {}: {e}", p.display()))?;
    Ok(())
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
const FONT_FILE: &str = "/System/Library/Fonts/SFNS.ttf";

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

    // Write per-annotation textfiles so we don't need to escape user content
    // inside the filter graph.
    let mut text_paths: Vec<(usize, PathBuf, &Annotation)> = Vec::new();
    for (idx, ann) in &text_anns {
        let p = temp_dir.join(format!("text-{idx}.txt"));
        std::fs::write(&p, &ann.content)
            .map_err(|e| format!("write text-{idx}: {e}"))?;
        text_paths.push((*idx, p, ann));
    }

    // Rasterize each arrow into source-sized transparent PNG.
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

    // Each arrow PNG is an additional input. Input indices: 0 = source,
    // 1..N = arrow PNGs. The overlay filter references them by index.
    for (_idx, path, _ann) in &arrow_paths {
        args.push("-i".into());
        args.push(path.to_string_lossy().into_owned());
    }

    let needs_filter = !text_paths.is_empty() || !arrow_paths.is_empty();
    if needs_filter {
        let mut filter = String::new();
        let mut prev_label = String::from("0:v");
        let mut step = 0usize;

        // Text annotations first (drawtext on the base video).
        for (i, (_idx, path, ann)) in text_paths.iter().enumerate() {
            let next_label = format!("v{step}");
            step += 1;
            // Annotation times are absolute (source timeline). After -ss
            // before -i, output `t` starts at 0 — shift by trim_in. Clamp.
            let start = (ann.start_time - trim_in).max(0.0);
            let end = (ann.end_time - trim_in).max(start).min(out_duration);
            let size = ann.size.unwrap_or(DEFAULT_TEXT_SIZE_PX);
            let x = ann.position.x.clamp(0.0, 1.0);
            let y = ann.position.y.clamp(0.0, 1.0);
            filter.push_str(&format!(
                "[{prev_label}]drawtext=textfile={textfile}:fontfile={font}:fontsize={size}:fontcolor=white:box=1:boxcolor=0x141416cc:boxborderw=8:x=iw*{x}:y=ih*{y}:enable=between(t\\,{start:.3}\\,{end:.3})[{next_label}]",
                prev_label = prev_label,
                textfile = path.to_string_lossy(),
                font = FONT_FILE,
                size = size as i64,
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
        }

        // Arrow overlays — each input arrow PNG (already source-sized) is
        // composited at (0,0) gated by `enable=between(...)`. Source-fraction
        // positioning is baked into the rasterized PNG.
        for (i, (_idx, _path, ann)) in arrow_paths.iter().enumerate() {
            let next_label = format!("v{step}");
            step += 1;
            let input_idx = i + 1; // 0 is source
            let start = (ann.start_time - trim_in).max(0.0);
            let end = (ann.end_time - trim_in).max(start).min(out_duration);
            filter.push_str(&format!(
                "[{prev_label}][{input_idx}:v]overlay=0:0:enable=between(t\\,{start:.3}\\,{end:.3})[{next_label}]",
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
