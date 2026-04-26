use std::path::{Path, PathBuf};
use std::process::Command;

use crate::composite::{FFMPEG_PATH, FFPROBE_PATH};

// LinkedIn personal-feed video constraints we care about:
//   - max 10 minutes (we warn in JS pre-flight, don't enforce here)
//   - target file size <200 MB so the upload is brisk
//   - H.264 high profile + yuv420p + faststart for broad player compat
//   - audio: AAC 128 kbps stereo
//
// LinkedIn's actual upload limit is 5 GB; the 200 MB cap is a UX choice
// to keep uploads fast over typical home connections. The cap is soft:
// short videos use a fixed 8 Mbps ceiling and stay well under the cap.

const LINKEDIN_AUDIO_BPS: u64 = 128_000;
const LINKEDIN_MAX_VIDEO_BPS: u64 = 8_000_000;
const LINKEDIN_MIN_VIDEO_BPS: u64 = 1_500_000;
const LINKEDIN_MAX_BYTES: u64 = 200 * 1024 * 1024;

fn movies_dir() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME not set".to_string())?;
    Ok(PathBuf::from(home).join("Movies/Zeigen"))
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

// Solve for video bitrate that keeps total file under LINKEDIN_MAX_BYTES,
// then clamp to [MIN, MAX]. Short videos hit the MAX ceiling; videos
// approaching 10 minutes drop toward the MIN to stay under the cap.
fn video_bitrate_bps(duration_s: f64) -> u64 {
    let dur = duration_s.max(1.0);
    let max_total_bits = LINKEDIN_MAX_BYTES.saturating_mul(8);
    let audio_bits = LINKEDIN_AUDIO_BPS.saturating_mul(dur as u64);
    let video_budget_bits = max_total_bits.saturating_sub(audio_bits);
    let bitrate = video_budget_bits / dur as u64;
    bitrate.clamp(LINKEDIN_MIN_VIDEO_BPS, LINKEDIN_MAX_VIDEO_BPS)
}

#[tauri::command]
pub fn linkedin_export(stamp: String, source_path: String) -> Result<String, String> {
    let source = Path::new(&source_path);
    if !source.is_file() {
        return Err(format!("source missing: {}", source.display()));
    }

    let duration = probe_duration_seconds(source)?;
    let video_bps = video_bitrate_bps(duration);

    let movies = movies_dir()?;
    std::fs::create_dir_all(&movies)
        .map_err(|e| format!("create {}: {e}", movies.display()))?;
    let output = movies.join(format!("recording-{stamp}-linkedin.mp4"));

    let args: Vec<String> = vec![
        "-y".into(),
        "-hide_banner".into(),
        "-i".into(),
        source.to_string_lossy().into_owned(),
        "-vf".into(),
        // Cap to 1080p wide, even-aligned, then convert to yuv420p so
        // every player plays it back without surprises.
        "scale='min(1920,iw)':-2,format=yuv420p".into(),
        "-c:v".into(),
        "h264_videotoolbox".into(),
        "-profile:v".into(),
        "high".into(),
        "-b:v".into(),
        format!("{video_bps}"),
        "-c:a".into(),
        "aac".into(),
        "-b:a".into(),
        format!("{}", LINKEDIN_AUDIO_BPS),
        "-movflags".into(),
        "+faststart".into(),
        output.to_string_lossy().into_owned(),
    ];

    let result = Command::new(FFMPEG_PATH)
        .args(&args)
        .output()
        .map_err(|e| format!("failed to spawn ffmpeg: {e}"))?;

    if !result.status.success() {
        let stderr = String::from_utf8_lossy(&result.stderr);
        let tail: Vec<&str> = stderr.lines().rev().take(40).collect();
        return Err(format!(
            "linkedin export failed (exit {:?}):\n{}",
            result.status.code(),
            tail.into_iter().rev().collect::<Vec<_>>().join("\n")
        ));
    }

    Ok(output.to_string_lossy().into_owned())
}
