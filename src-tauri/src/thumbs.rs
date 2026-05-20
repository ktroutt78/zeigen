use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, SystemTime};

use serde::Serialize;

use crate::composite::FFMPEG_PATH;
use crate::edit::{probe_dimensions, probe_duration_seconds};

// Phase 11 c3: pre-extract a thumbnail sprite for timeline scrubbing.
// Single ffmpeg pass writes a 20x10 tile PNG to
//   ~/Library/Caches/com.zeigen.app/thumbs/<stamp>.png
// which the frontend loads via convertFileSrc and indexes by hover time.

const STALE_THRESHOLD: Duration = Duration::from_secs(24 * 60 * 60);
const TILE_COLS: u32 = 20;
const TILE_ROWS: u32 = 10;
const MAX_THUMBS: u32 = TILE_COLS * TILE_ROWS;
const THUMB_W: u32 = 160;

#[derive(Serialize)]
pub struct ThumbSpriteInfo {
    pub sprite_path: String,
    pub cols: u32,
    pub rows: u32,
    pub thumb_w: u32,
    pub thumb_h: u32,
    pub count: u32,
}

fn thumbs_root() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME not set".to_string())?;
    let dir = PathBuf::from(home).join("Library/Caches/com.zeigen.app/thumbs");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    Ok(dir)
}

// scale=160:-2 keeps width=160 and rounds height to an even number while
// preserving aspect ratio. Mirror that arithmetic here so the frontend can
// position the sprite tiles without re-probing.
fn compute_thumb_h(src_w: u32, src_h: u32) -> u32 {
    if src_w == 0 {
        return 0;
    }
    let h = (THUMB_W as f64) * (src_h as f64) / (src_w as f64);
    let rounded = h.round() as u32;
    if rounded % 2 == 0 {
        rounded
    } else {
        rounded + 1
    }
}

#[tauri::command]
pub fn extract_thumb_sprite(
    source_path: String,
    recording_id: String,
) -> Result<ThumbSpriteInfo, String> {
    let source = PathBuf::from(&source_path);
    if !source.is_file() {
        return Err(format!("source missing: {}", source.display()));
    }

    let duration = probe_duration_seconds(&source)?;
    if duration <= 0.0 {
        return Err(format!("non-positive duration: {duration}"));
    }
    let (src_w, src_h) = probe_dimensions(&source)?;
    let thumb_h = compute_thumb_h(src_w, src_h);

    // Aim for ~200 thumbs across the clip; clamp so very short clips don't
    // demand thousands of fps and very long ones don't gap.
    let fps_n = (200.0_f64 / duration).clamp(0.2, 10.0);
    let count = ((duration * fps_n).ceil() as u32).min(MAX_THUMBS);

    let out_dir = thumbs_root()?;
    let out_path = out_dir.join(format!("{recording_id}.png"));

    let vf = format!(
        "fps={fps:.6},scale={w}:-2,tile={cols}x{rows}",
        fps = fps_n,
        w = THUMB_W,
        cols = TILE_COLS,
        rows = TILE_ROWS,
    );

    let output = Command::new(FFMPEG_PATH)
        .args(["-y", "-hide_banner", "-loglevel", "error", "-i"])
        .arg(&source)
        .args(["-vf", &vf, "-frames:v", "1"])
        .arg(&out_path)
        .output()
        .map_err(|e| format!("ffmpeg sprite failed: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "ffmpeg sprite non-zero: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    Ok(ThumbSpriteInfo {
        sprite_path: out_path.to_string_lossy().into_owned(),
        cols: TILE_COLS,
        rows: TILE_ROWS,
        thumb_w: THUMB_W,
        thumb_h,
        count,
    })
}

// App-launch safety net for sprites left over from sessions that didn't
// clean up. Best-effort; failures are silent.
pub fn sweep_stale_thumbs() {
    let root = match thumbs_root() {
        Ok(p) => p,
        Err(_) => return,
    };
    sweep_dir_older_than(&root, STALE_THRESHOLD);
}

pub(crate) fn sweep_dir_older_than(root: &Path, threshold: Duration) {
    let entries = match std::fs::read_dir(root) {
        Ok(e) => e,
        Err(_) => return,
    };
    let now = SystemTime::now();
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(meta) = entry.metadata() else { continue };
        let Ok(mtime) = meta.modified() else { continue };
        if let Ok(age) = now.duration_since(mtime) {
            if age > threshold {
                if path.is_dir() {
                    let _ = std::fs::remove_dir_all(&path);
                } else {
                    let _ = std::fs::remove_file(&path);
                }
            }
        }
    }
}
