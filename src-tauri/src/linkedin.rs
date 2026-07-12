use std::path::{Path, PathBuf};
use std::process::Command;

use crate::composite::{Watermark, FFMPEG_PATH, FFPROBE_PATH};

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
pub fn linkedin_export(
    stamp: String,
    source_path: String,
    watermark_logo: Option<String>,
    watermark_corner: Option<String>,
) -> Result<String, String> {
    let source = Path::new(&source_path);

    // Phase 15 c3: composite moved to export time. source is the scratch
    // logical key — no file at it for webcam recordings. Derive the raw
    // screen + segments via the same helper save/clipboard use; if a
    // webcam is present, composite to a temp file first, then transcode
    // the temp with the existing custom linkedin pipeline below. This
    // mirrors c2's two-pass shape and preserves linkedin's no-trim,
    // no-annotation, bubble-baked output behavior from Phase 14.
    let (screen_path, segments) = crate::edit::export_inputs_from_source(source);
    if !screen_path.is_file() {
        return Err(format!("screen capture missing: {}", screen_path.display()));
    }

    let sidecar = crate::edit::read_sidecar_path(source)?.unwrap_or_default();

    // composite_tmp populated only for webcam recordings. Lives in
    // .sources/ sibling of the scratch sources dir so Phase 5.5 sweeps
    // it via scratch-discard if anything strands it. Cleaned up after
    // the transcode below (success or failure).
    let composite_tmp: Option<PathBuf> = if !segments.is_empty() {
        let stem = screen_path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("source");
        let temp_dir = screen_path
            .parent()
            .and_then(|p| p.parent())
            .map(|p| p.join(".sources").join(format!("export-li-{stem}")))
            .ok_or_else(|| {
                format!("screen path has no grandparent: {}", screen_path.display())
            })?;
        std::fs::create_dir_all(&temp_dir)
            .map_err(|e| format!("create {}: {e}", temp_dir.display()))?;
        let tmp = temp_dir.join("composite.mp4");
        crate::composite::composite(
            &screen_path,
            &segments,
            &tmp,
            crate::composite::WebcamSize::Medium,
            crate::composite::Corner::BottomRight,
            &sidecar.bubble_position_log,
            sidecar.bubble_roundness,
            // None: the LinkedIn path applies its watermark in its own custom
            // transcode pass below (which always re-encodes to LinkedIn specs),
            // so Fix B's pass-1 watermark fold doesn't apply here.
            None,
            |_| {},
        )?;
        Some(tmp)
    } else {
        None
    };

    // From here down, transcode runs against `transcode_input` — the
    // composited temp for webcam recordings, screen.mp4 directly for
    // screen-only. The existing linkedin custom pipeline below stays
    // the source of truth for bitrate / profile / faststart / aac.
    let transcode_input: PathBuf = composite_tmp
        .clone()
        .unwrap_or_else(|| screen_path.to_path_buf());

    let duration = probe_duration_seconds(&transcode_input)?;
    let video_bps = video_bitrate_bps(duration);

    let movies = movies_dir()?;
    std::fs::create_dir_all(&movies)
        .map_err(|e| format!("create {}: {e}", movies.display()))?;
    let output = movies.join(format!("recording-{stamp}-linkedin.mp4"));

    // Skip a watermark whose logo file is gone — never fail the export.
    let watermark = Watermark::from_args(watermark_logo, watermark_corner).filter(|wm| {
        let ok = wm.logo_path.is_file();
        if !ok {
            eprintln!("[watermark] logo missing at {}, skipping", wm.logo_path.display());
        }
        ok
    });

    // Blur/redact regions from the sidecar. LinkedIn export never trims
    // (Phase 14 decision — no-trim, no-annotation, bubble-baked output), so
    // unlike edit.rs's pass-2 pipeline these use ann.start_time/end_time
    // directly with no trim_in offset. Redaction is the one sidecar concept
    // this path DOES honor — trim/text/arrow stay excluded per that
    // decision, but this export leaves the machine, so unredacted regions
    // silently shipping here would defeat the feature's purpose.
    let blur_anns: Vec<&crate::edit::Annotation> = sidecar
        .annotations
        .iter()
        .filter(|a| a.kind == "blur" && a.endpoint.is_some())
        .collect();

    // Spotlight regions from the sidecar. Same reasoning as blur above: this
    // export leaves the machine, so it honors the same redact/attention
    // sidecar concepts blur does (still no trim, no text/arrow — Phase 14
    // decision).
    let spotlight_anns: Vec<&crate::edit::Annotation> = sidecar
        .annotations
        .iter()
        .filter(|a| a.kind == "spotlight" && a.endpoint.is_some())
        .collect();

    let mut args: Vec<String> = vec![
        "-y".into(),
        "-hide_banner".into(),
        "-i".into(),
        transcode_input.to_string_lossy().into_owned(),
    ];

    // Cap to 1080p wide, even-aligned, then convert to yuv420p so every
    // player plays it back without surprises. Blur/spotlight and/or a
    // watermark force -filter_complex with an explicit output map; otherwise
    // the simple -vf scale path is unchanged.
    if watermark.is_some() || !blur_anns.is_empty() || !spotlight_anns.is_empty() {
        let (sw, sh) = crate::edit::probe_dimensions(&transcode_input)?;
        let mut filter = String::new();
        let mut prev_label = String::from("0:v");

        for (i, ann) in blur_anns.iter().enumerate() {
            let next_label = format!("v{i}");
            filter.push_str(&crate::edit::blur_region_fragment(
                i,
                &prev_label,
                &next_label,
                ann,
                (sw, sh),
                ann.start_time,
                ann.end_time,
            ));
            filter.push(';');
            prev_label = next_label;
        }

        // Spotlight runs after blur — same ordering as edit.rs's pass-2
        // chain, same reasoning (the two commute; this just avoids
        // reshuffling the already-shipped blur stage).
        for (i, ann) in spotlight_anns.iter().enumerate() {
            let next_label = format!("sv{i}");
            filter.push_str(&crate::edit::spotlight_region_fragment(
                i,
                &prev_label,
                &next_label,
                ann,
                (sw, sh),
                ann.start_time,
                ann.end_time,
            ));
            filter.push(';');
            prev_label = next_label;
        }

        if let Some(wm) = &watermark {
            args.push("-i".into());
            args.push(wm.logo_path.to_string_lossy().into_owned());
            let next_label = String::from("ov");
            filter.push_str(&wm.filter_fragment(1, &prev_label, &next_label, sw, sh));
            filter.push(';');
            prev_label = next_label;
        }

        filter.push_str(&format!(
            "[{prev_label}]scale='min(1920,iw)':-2,format=yuv420p[outv]"
        ));

        args.push("-filter_complex".into());
        args.push(filter);
        args.push("-map".into());
        args.push("[outv]".into());
        args.push("-map".into());
        args.push("0:a?".into());
    } else {
        args.push("-vf".into());
        args.push("scale='min(1920,iw)':-2,format=yuv420p".into());
    }

    args.extend([
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
    ]);

    let result = Command::new(FFMPEG_PATH)
        .args(&args)
        .output()
        .map_err(|e| format!("failed to spawn ffmpeg: {e}"))?;

    // Cleanup composite temp either way — failure-path inspection isn't
    // worth the disk cost, and the scratch lifecycle would sweep this
    // dir on session close anyway.
    if let Some(tmp) = composite_tmp {
        let _ = std::fs::remove_file(&tmp);
        if let Some(d) = tmp.parent() {
            let _ = std::fs::remove_dir(d);
        }
    }

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
