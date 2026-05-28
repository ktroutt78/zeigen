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
    sweep_dir_older_than(&root, STALE_THRESHOLD, "thumb-sweep");
}

pub(crate) fn sweep_dir_older_than(root: &Path, threshold: Duration, label: &str) {
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
                eprintln!(
                    "[{label}] removing stale {} (age {}h)",
                    path.display(),
                    age.as_secs() / 3600
                );
                if path.is_dir() {
                    let _ = std::fs::remove_dir_all(&path);
                } else {
                    let _ = std::fs::remove_file(&path);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command as StdCommand;

    // Smoke against a live scratch recording. Run explicitly:
    //   cargo test --lib sprite_smoke -- --ignored --nocapture
    #[test]
    #[ignore]
    fn sprite_smoke() {
        let home = std::env::var("HOME").unwrap();
        let stamp = "smoke-c3";
        let source = format!(
            "{home}/Movies/Zeigen/.scratch/recording-2026-05-19-225852/recording-2026-05-19-225852.mp4"
        );
        assert!(Path::new(&source).exists(), "scratch source missing");

        let expected_out = format!("{home}/Library/Caches/com.zeigen.app/thumbs/{stamp}.png");
        let _ = std::fs::remove_file(&expected_out);

        let info = extract_thumb_sprite(source, stamp.to_string()).expect("sprite extract");

        assert_eq!(info.sprite_path, expected_out);
        assert_eq!(info.cols, 20);
        assert_eq!(info.rows, 10);
        assert_eq!(info.thumb_w, 160);
        assert!(info.thumb_h > 0, "thumb_h must be positive");
        assert!(info.count > 0, "count must be positive");
        assert!(info.count <= 200, "count must fit grid");
        assert!(Path::new(&info.sprite_path).exists(), "sprite PNG missing");

        // ffprobe the PNG to confirm dimensions match the grid math.
        let probe = StdCommand::new(crate::composite::FFPROBE_PATH)
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
            .arg(&info.sprite_path)
            .output()
            .expect("ffprobe sprite");
        let dims = String::from_utf8_lossy(&probe.stdout).trim().to_string();
        let expected_w = info.thumb_w * info.cols;
        let expected_h = info.thumb_h * info.rows;
        assert_eq!(
            dims,
            format!("{expected_w}x{expected_h}"),
            "sprite dims mismatch"
        );

        println!(
            "ok: {} ({}x{} grid of {}x{}, count={})",
            info.sprite_path, info.cols, info.rows, info.thumb_w, info.thumb_h, info.count
        );
    }

    // Verifies the shared sweep helper actually removes old entries and
    // leaves fresh ones alone. Uses a temp dir so we don't touch live caches.
    #[test]
    fn sweep_helper_removes_old_keeps_new() {
        let tmp = std::env::temp_dir().join(format!(
            "zeigen-thumbs-sweep-test-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();

        let old_file = tmp.join("old.png");
        let new_file = tmp.join("new.png");
        let old_dir = tmp.join("old-dir");
        let new_dir = tmp.join("new-dir");
        std::fs::write(&old_file, b"x").unwrap();
        std::fs::write(&new_file, b"x").unwrap();
        std::fs::create_dir(&old_dir).unwrap();
        std::fs::create_dir(&new_dir).unwrap();

        // Backdate old entries to 48h ago via `touch -t` (macOS-friendly).
        StdCommand::new("touch")
            .args(["-t", "202401010000"])
            .arg(&old_file)
            .status()
            .unwrap();
        StdCommand::new("touch")
            .args(["-t", "202401010000"])
            .arg(&old_dir)
            .status()
            .unwrap();

        sweep_dir_older_than(&tmp, Duration::from_secs(24 * 60 * 60), "test-sweep");

        assert!(!old_file.exists(), "old file should be swept");
        assert!(!old_dir.exists(), "old dir should be swept");
        assert!(new_file.exists(), "new file should remain");
        assert!(new_dir.exists(), "new dir should remain");

        let _ = std::fs::remove_dir_all(&tmp);
    }
}
