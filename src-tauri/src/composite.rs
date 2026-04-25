use std::path::{Path, PathBuf};
use std::process::Command;

use crate::edit::BubblePositionEntry;

pub(crate) const FFMPEG_PATH: &str = "/opt/homebrew/bin/ffmpeg";
pub(crate) const FFPROBE_PATH: &str = "/opt/homebrew/bin/ffprobe";

// Above this many position-log entries, the inline `if(lt(t,...))` chain
// becomes long enough that the chained-split strategy is preferable.
const POSITION_LOG_MAX_INLINE: usize = 20;

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

#[derive(Clone, Copy)]
pub enum WebcamSize {
    Small,
    Medium,
    Large,
}

impl WebcamSize {
    fn px(self) -> u32 {
        match self {
            Self::Small => 180,
            Self::Medium => 240,
            Self::Large => 320,
        }
    }
}

#[derive(Clone, Copy)]
pub enum Corner {
    TopLeft,
    TopRight,
    BottomLeft,
    BottomRight,
}

impl Corner {
    fn overlay_xy(self, padding: u32) -> String {
        match self {
            Self::TopLeft => format!("{padding}:{padding}"),
            Self::TopRight => format!("main_w-overlay_w-{padding}:{padding}"),
            Self::BottomLeft => format!("{padding}:main_h-overlay_h-{padding}"),
            Self::BottomRight => format!("main_w-overlay_w-{padding}:main_h-overlay_h-{padding}"),
        }
    }
}

const PADDING_PX: u32 = 24;

fn build_inline_position_expr(log: &[BubblePositionEntry]) -> (String, String) {
    debug_assert!(!log.is_empty());
    let n = log.len();
    let last = &log[n - 1];
    let mut x_expr = format!("main_w*{:.4}-overlay_w/2", last.x);
    let mut y_expr = format!("main_h*{:.4}-overlay_h/2", last.y);
    for i in (0..n.saturating_sub(1)).rev() {
        let entry = &log[i];
        let next_t = log[i + 1].t;
        x_expr = format!(
            "if(lt(t\\,{:.3})\\,main_w*{:.4}-overlay_w/2\\,{})",
            next_t, entry.x, x_expr
        );
        y_expr = format!(
            "if(lt(t\\,{:.3})\\,main_h*{:.4}-overlay_h/2\\,{})",
            next_t, entry.y, y_expr
        );
    }
    (x_expr, y_expr)
}

pub fn composite(
    screen_path: &Path,
    webcam_segments: &[PathBuf],
    output_path: &Path,
    size: WebcamSize,
    corner: Corner,
    bubble_position_log: &[BubblePositionEntry],
) -> Result<(), String> {
    if webcam_segments.is_empty() {
        return Err("no webcam segments to composite".into());
    }

    let target = size.px();

    // Compensate for webcam start lag relative to screen. ffmpeg's AVCaptureSession
    // takes longer to deliver its first frame than SCK does, so the webcam file is
    // typically a few hundred milliseconds shorter than screen.mp4. Without this offset,
    // composite playback shows the webcam ~Nms ahead of the audio.
    // Multi-segment recordings (pause/resume) get the offset applied to the first segment
    // only — pause/resume sync drift is a separate concern handled later.
    let screen_dur = probe_duration_seconds(screen_path)?;
    let webcam_total: f64 = webcam_segments
        .iter()
        .map(|p| probe_duration_seconds(p))
        .sum::<Result<f64, _>>()?;
    let lead_in = (screen_dur - webcam_total).max(0.0);

    let mut args: Vec<String> = vec![
        "-y".into(),
        "-hide_banner".into(),
        "-i".into(),
        screen_path.to_string_lossy().into_owned(),
    ];
    for (i, seg) in webcam_segments.iter().enumerate() {
        if i == 0 && lead_in > 0.001 {
            args.push("-itsoffset".into());
            args.push(format!("{lead_in:.3}"));
        }
        args.push("-i".into());
        args.push(seg.to_string_lossy().into_owned());
    }

    // Build filter_complex.
    // Input 0 is screen (video + audio). Inputs 1..N are webcam segments (video-only).
    // - Concat webcam segments into [wc_full] (if N>1; otherwise rename input 1's video).
    // - Crop to centered square (smaller dimension), scale to target, convert to yuva420p.
    // - Build a circular alpha mask via geq (255 inside the inscribed circle, 0 outside).
    // - Overlay onto screen with eof_action=pass so the screen continues uncovered after
    //   the webcam track ends (Continuity drop / shorter webcam case).
    let n = webcam_segments.len();
    let mut filter = String::new();
    if n > 1 {
        for i in 0..n {
            filter.push_str(&format!("[{}:v]", i + 1));
        }
        filter.push_str(&format!("concat=n={n}:v=1:a=0[wc_full];"));
    } else {
        filter.push_str("[1:v]copy[wc_full];");
    }
    filter.push_str(&format!(
        "[wc_full]crop='min(iw\\,ih)':'min(iw\\,ih)',\
scale={target}:{target},\
format=yuva420p,\
geq='lum=p(X\\,Y):a=255*lt(hypot(X-W/2\\,Y-H/2)\\,W/2)'[wc];\
[0:v]fps=30[screen30];"
    ));

    // Position the overlay. Three strategies:
    //  - empty log → static corner (existing behavior).
    //  - 1..=20 entries → single overlay with nested if(lt(t,...)) x/y expressions.
    //  - >20 entries → split [wc] N ways and chain N overlays, each with `enable=between(t,...)`.
    let log_n = bubble_position_log.len();
    if log_n == 0 {
        let overlay_xy = corner.overlay_xy(PADDING_PX);
        filter.push_str(&format!(
            "[screen30][wc]overlay={overlay_xy}:eof_action=pass[outv]"
        ));
    } else if log_n <= POSITION_LOG_MAX_INLINE {
        let (x_expr, y_expr) = build_inline_position_expr(bubble_position_log);
        filter.push_str(&format!(
            "[screen30][wc]overlay=x={x_expr}:y={y_expr}:eof_action=pass[outv]"
        ));
    } else {
        filter.push_str(&format!("[wc]split={log_n}"));
        for i in 0..log_n {
            filter.push_str(&format!("[wc_{i}]"));
        }
        filter.push(';');
        for i in 0..log_n {
            let entry = &bubble_position_log[i];
            let prev = if i == 0 {
                "screen30".to_string()
            } else {
                format!("v_{}", i - 1)
            };
            let enable = if i + 1 < log_n {
                let next_t = bubble_position_log[i + 1].t;
                format!("between(t\\,{:.3}\\,{:.3})", entry.t, next_t)
            } else {
                format!("gte(t\\,{:.3})", entry.t)
            };
            let next_label = if i + 1 == log_n {
                "outv".to_string()
            } else {
                format!("v_{i}")
            };
            filter.push_str(&format!(
                "[{prev}][wc_{i}]overlay=x=main_w*{:.4}-overlay_w/2:y=main_h*{:.4}-overlay_h/2:enable={enable}:eof_action=pass[{next_label}]",
                entry.x, entry.y
            ));
            if i + 1 < log_n {
                filter.push(';');
            }
        }
    }

    args.push("-filter_complex".into());
    args.push(filter);

    args.push("-map".into());
    args.push("[outv]".into());
    args.push("-map".into());
    args.push("0:a?".into());

    args.push("-c:v".into());
    args.push("h264_videotoolbox".into());
    args.push("-b:v".into());
    args.push("8M".into());
    args.push("-c:a".into());
    args.push("copy".into());

    args.push(output_path.to_string_lossy().into_owned());

    let output = Command::new(FFMPEG_PATH)
        .args(&args)
        .output()
        .map_err(|e| format!("failed to spawn ffmpeg composite: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "ffmpeg composite failed (exit {:?}):\n{}",
            output.status.code(),
            stderr.lines().rev().take(40).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n")
        ));
    }

    Ok(())
}
