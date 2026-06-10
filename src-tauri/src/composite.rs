use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use crate::edit::BubblePositionEntry;

pub(crate) const FFMPEG_PATH: &str = "/opt/homebrew/bin/ffmpeg";
pub(crate) const FFPROBE_PATH: &str = "/opt/homebrew/bin/ffprobe";

// Calibrated camera-start lead — tpad prepends this many ms of cloned
// first-frame to the webcam stream so its content lines up with the
// audio at output PTS = LEAD. Phase 15 c3's dual-stream preview applies
// the same lead in CSS by offsetting webcam.currentTime relative to
// screen.currentTime; the constant is surfaced via the FinalizedRecording
// payload so the frontend doesn't drift from this value.
//
// Empirically recalibrated from 280→220 on 2026-06-10. Four clean
// clap-based A/V offset measurements on built-in hardware showed the
// previous 280 over-corrected by 20-110ms (mean ~85ms): the bubble
// consistently LAGGED the audio. Stamps + measured lag (positive =
// video lags audio): 191323 +20, 191514 +110, 191649 +105, 204006
// +110. Implied true webcam-vs-sck on warm takes was 170-260ms; 220
// is the midpoint of that range. Cold-take behavior is still unmeasured
// — if cold recordings show different behavior at 220, a per-recording
// adaptive lead becomes the next step.
//
// Tunable: raise if the bubble still LEADS the audio (mouth moves
// before the sound), lower if the bubble LAGS. The proper auto-fix
// would have the engine timestamp each pipeline's first real sample.
pub(crate) const WEBCAM_LEAD_MS: f64 = 220.0;

// The inline `if(lt(t,...))` chain handles arbitrary log sizes — ffmpeg
// parses the expression once and walks it per-frame, which is cheap.
// The chained-split alternative was catastrophically slow: `split=N`
// forces N parallel buffer copies per frame and the chained overlay
// pipeline does N enable-checks per frame, so a 3-min clip with ~500
// samples could take longer than the recording itself. Set the threshold
// high enough that the split path is effectively dead while still serving
// as a safety net for absurd logs.
const POSITION_LOG_MAX_INLINE: usize = 100_000;

// ffmpeg's expression parser hits a hard recursion limit on nested `if()`
// calls — measured empirically at ~94 entries on the bundled ffmpeg.
// "Missing ')' or too many args" fires before evaluation. Cap simplified
// logs at 80 with margin. Most static recordings collapse below this via
// run-length encoding; only continuous-drag clips hit the thinning path
// and lose some intermediate-frame fidelity.
const POSITION_LOG_MAX_SIMPLIFIED: usize = 80;

// Drop interior samples in static runs (positions that match both neighbors)
// then thin uniformly to fit ffmpeg's expression-depth budget. Preserves
// motion fidelity since boundary samples of every static run are kept.
fn simplify_position_log(log: &[BubblePositionEntry]) -> Vec<BubblePositionEntry> {
    if log.len() <= 2 {
        return log.to_vec();
    }
    let eps = 0.001;
    let mut compacted: Vec<BubblePositionEntry> = Vec::with_capacity(log.len());
    compacted.push(log[0].clone());
    for i in 1..log.len() - 1 {
        let prev = &log[i - 1];
        let curr = &log[i];
        let next = &log[i + 1];
        let same_as_prev = (curr.x - prev.x).abs() < eps && (curr.y - prev.y).abs() < eps;
        let same_as_next = (curr.x - next.x).abs() < eps && (curr.y - next.y).abs() < eps;
        if !(same_as_prev && same_as_next) {
            compacted.push(curr.clone());
        }
    }
    compacted.push(log[log.len() - 1].clone());

    if compacted.len() > POSITION_LOG_MAX_SIMPLIFIED {
        // Stride keeps endpoints and roughly-evenly samples between them.
        let stride =
            (compacted.len() as f64 / POSITION_LOG_MAX_SIMPLIFIED as f64).ceil() as usize;
        let mut thinned: Vec<BubblePositionEntry> = compacted
            .iter()
            .step_by(stride.max(1))
            .cloned()
            .collect();
        // Always keep the final sample so the post-end static segment lines
        // up with where the bubble actually was at end-of-recording.
        if thinned.last().map(|e| e.t) != compacted.last().map(|e| e.t) {
            thinned.push(compacted.last().unwrap().clone());
        }
        thinned
    } else {
        compacted
    }
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

// Audio stream start_time from the engine's screen.mp4. SCK's microphone
// pipeline takes ~50-70ms to deliver its first sample after the session
// starts, so the audio track in the source mp4 begins at a positive offset
// relative to video. Composite needs this to compensate for A/V drift.
fn probe_audio_start_time(path: &Path) -> Result<f64, String> {
    let output = Command::new(FFPROBE_PATH)
        .args([
            "-v",
            "error",
            "-select_streams",
            "a:0",
            "-show_entries",
            "stream=start_time",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
        ])
        .arg(path)
        .output()
        .map_err(|e| format!("ffprobe failed: {e}"))?;
    let s = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if s.is_empty() || s == "N/A" {
        return Ok(0.0);
    }
    s.parse::<f64>()
        .map_err(|e| format!("parse audio start_time {s:?}: {e}"))
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

    pub(crate) fn from_code(s: &str) -> Corner {
        match s {
            "tl" => Corner::TopLeft,
            "tr" => Corner::TopRight,
            "bl" => Corner::BottomLeft,
            _ => Corner::BottomRight,
        }
    }
}

// Watermark overlay shared by every export path: edit.rs run_edit_pipeline
// (Save MP4 / GIF / Copy) and linkedin.rs. The logo is scaled to 10% of the
// shorter source dimension (height, aspect preserved) and padded 2% off the
// chosen corner. The PNG's own alpha is respected — no extra dimming.
#[derive(Clone)]
pub(crate) struct Watermark {
    pub logo_path: PathBuf,
    pub corner: Corner,
}

impl Watermark {
    // Build from export-command args. None unless a logo path is given;
    // corner defaults to top-right.
    pub(crate) fn from_args(logo: Option<String>, corner: Option<String>) -> Option<Watermark> {
        let logo = logo?;
        Some(Watermark {
            logo_path: PathBuf::from(logo),
            corner: corner.as_deref().map(Corner::from_code).unwrap_or(Corner::TopRight),
        })
    }

    fn metrics(sw: u32, sh: u32) -> (u32, u32) {
        let short = sw.min(sh) as f64;
        let height = (short * 0.10).round().max(1.0) as u32;
        let padding = (short * 0.02).round() as u32;
        (height, padding)
    }

    // "[{idx}:v]scale=-2:{h}[wm];[{prev}][wm]overlay={xy}[{next}]"
    // The caller must have already added `-i logo_path` at input `logo_idx`
    // and wires `next_label` into its own tail. overlay's default
    // eof_action=repeat holds the single PNG frame across the whole clip.
    pub(crate) fn filter_fragment(
        &self,
        logo_idx: usize,
        prev_label: &str,
        next_label: &str,
        sw: u32,
        sh: u32,
    ) -> String {
        let (height, padding) = Self::metrics(sw, sh);
        let xy = self.corner.overlay_xy(padding);
        format!("[{logo_idx}:v]scale=-2:{height}[wm];[{prev_label}][wm]overlay={xy}[{next_label}]")
    }
}

const PADDING_PX: u32 = 24;

fn entry_in_bounds(e: &BubblePositionEntry) -> bool {
    e.x >= 0.0 && e.x <= 1.0 && e.y >= 0.0 && e.y <= 1.0
}

fn segment_in_bounds(log: &[BubblePositionEntry], i: usize) -> bool {
    let a_ok = entry_in_bounds(&log[i]);
    if i + 1 < log.len() {
        a_ok && entry_in_bounds(&log[i + 1])
    } else {
        a_ok
    }
}

// Per-segment 0/1 enable expression mirroring `build_inline_position_expr`.
// Suppresses overlay rendering for any segment whose endpoints fall outside
// the recorded display's [0,1] frame — bubble drawn on a different monitor
// must not leak into the recording.
fn build_inline_enable_expr(log: &[BubblePositionEntry]) -> String {
    let n = log.len();
    if n == 1 {
        return if segment_in_bounds(log, 0) { "1".into() } else { "0".into() };
    }
    let mut expr = if segment_in_bounds(log, n - 1) { "1".to_string() } else { "0".to_string() };
    for i in (0..n - 1).rev() {
        let next_t = log[i + 1].t;
        let val = if segment_in_bounds(log, i) { "1" } else { "0" };
        expr = format!("if(lt(t\\,{:.3})\\,{}\\,{})", next_t, val, expr);
    }
    expr
}

// Linear-interpolated overlay position between samples.
// For samples 0..N-1 (N >= 2):
//   t < t_1                → segment 0: interpolate from (X_0, Y_0) toward (X_1, Y_1)
//   t in [t_i, t_{i+1})    → segment i: interpolate from sample i to sample i+1
//   t >= t_{N-1}           → static at (X_{N-1}, Y_{N-1})
// max(0, ...) on the ratio prevents extrapolation in the implicit
// pre-first-sample window if t_0 > 0.
fn build_inline_position_expr(log: &[BubblePositionEntry]) -> (String, String) {
    debug_assert!(!log.is_empty());
    let n = log.len();
    let last = &log[n - 1];
    let mut x_expr = format!("main_w*{:.4}-overlay_w/2", last.x);
    let mut y_expr = format!("main_h*{:.4}-overlay_h/2", last.y);
    for i in (0..n.saturating_sub(1)).rev() {
        let a = &log[i];
        let b = &log[i + 1];
        let dt = (b.t - a.t).max(0.001);
        x_expr = format!(
            "if(lt(t\\,{next_t:.3})\\,main_w*({x0:.4}+({dx:.4})*max(0\\,(t-{t0:.3})/{dt:.3}))-overlay_w/2\\,{rest})",
            next_t = b.t,
            x0 = a.x,
            dx = b.x - a.x,
            t0 = a.t,
            dt = dt,
            rest = x_expr,
        );
        y_expr = format!(
            "if(lt(t\\,{next_t:.3})\\,main_h*({y0:.4}+({dy:.4})*max(0\\,(t-{t0:.3})/{dt:.3}))-overlay_h/2\\,{rest})",
            next_t = b.t,
            y0 = a.y,
            dy = b.y - a.y,
            t0 = a.t,
            dt = dt,
            rest = y_expr,
        );
    }
    (x_expr, y_expr)
}

// Render a circular alpha mask to disk for use as an ffmpeg input. The PNG
// has a white opaque circle on a transparent background; ffmpeg's `format=gray`
// filter then yields a luma-only stream where 255 = inside circle, 0 = outside.
// Doing this once per recording costs ~1ms vs the per-pixel-per-frame cost of
// the previous inline `geq` expression, which dominated composite time on
// multi-minute clips.
fn render_alpha_mask(diameter: u32, out_path: &Path) -> Result<(), String> {
    use tiny_skia::{FillRule, Paint, PathBuilder, Pixmap, Transform};
    let mut pixmap = Pixmap::new(diameter, diameter)
        .ok_or_else(|| format!("alloc mask pixmap {diameter}x{diameter}"))?;
    let r = diameter as f32 / 2.0;
    let path = PathBuilder::from_circle(r, r, r).ok_or("invalid mask radius")?;
    let mut paint = Paint::default();
    paint.set_color_rgba8(255, 255, 255, 255);
    paint.anti_alias = true;
    pixmap.fill_path(&path, &paint, FillRule::Winding, Transform::identity(), None);
    let png = pixmap.encode_png().map_err(|e| format!("encode mask png: {e}"))?;
    std::fs::write(out_path, png).map_err(|e| format!("write mask png: {e}"))?;
    Ok(())
}

pub fn composite(
    screen_path: &Path,
    webcam_segments: &[PathBuf],
    output_path: &Path,
    size: WebcamSize,
    corner: Corner,
    bubble_position_log: &[BubblePositionEntry],
    on_progress: impl Fn(f64) + Send + 'static,
) -> Result<(), String> {
    if webcam_segments.is_empty() {
        return Err("no webcam segments to composite".into());
    }

    // Prefer the live bubble diameter (sampled in physical pixels at record
    // time) over the legacy WebcamSize default. The Size/Corner UI controls
    // were removed in phase 8; the bubble is now drag-resizable and the
    // composite has to honor whatever the user shipped. First-entry only —
    // resizing mid-recording is rare and a single source-of-truth keeps the
    // ffmpeg `scale` filter constant. None means an old sidecar; fall back.
    let target = bubble_position_log
        .first()
        .and_then(|e| e.diameter)
        .map(|d| d.round().max(1.0) as u32)
        .unwrap_or_else(|| size.px());

    // Webcam-vs-audio alignment via tpad on the webcam stream — see
    // module-level WEBCAM_LEAD_MS for the rationale. Fixed calibrated
    // value, not derived from the screen/webcam duration delta (which
    // is dominated by stop-timing jitter, not start latency).
    let screen_dur = probe_duration_seconds(screen_path)?;
    let lead_in = WEBCAM_LEAD_MS / 1000.0;

    // Drop the screen.mp4 audio's own leading gap (SCK mic-init latency — the
    // audio stream's start_time, typically 0-70ms) via `-itsoffset` on the
    // audio-only input copy, so the audio and screen video share t=0. The mp4
    // muxer normalizes the resulting negative PTS to zero.
    let audio_offset = probe_audio_start_time(screen_path).unwrap_or(0.0);
    let audio_shift = audio_offset;

    // Pre-render the circular alpha mask alongside the output so it lives in
    // the same scratch dir and gets cleaned up with the recording.
    let mask_path = output_path
        .parent()
        .ok_or("output path has no parent")?
        .join(format!("mask-{target}.png"));
    render_alpha_mask(target, &mask_path)?;

    let mut args: Vec<String> = vec![
        "-y".into(),
        "-hide_banner".into(),
        "-nostats".into(),
        "-progress".into(),
        "pipe:1".into(),
        // Input 0: screen.mp4 — used for video only.
        "-i".into(),
        screen_path.to_string_lossy().into_owned(),
        // Input 1: screen.mp4 again, shifted earlier by audio_shift — used
        // for audio only. The duplicate decode is cheap relative to the
        // composite's video encode.
        "-itsoffset".into(),
        format!("-{audio_shift:.3}"),
        "-i".into(),
        screen_path.to_string_lossy().into_owned(),
    ];
    for seg in webcam_segments.iter() {
        args.push("-i".into());
        args.push(seg.to_string_lossy().into_owned());
    }
    // Mask input: loop a single PNG frame at 30fps so alphamerge has matching
    // PTS for the duration of the webcam stream. `-t` bounds the loop —
    // without it the demuxer pumps frames indefinitely and ffmpeg never
    // shuts down cleanly even after the screen track ends. The mask is only
    // consumed by alphamerge with the (already-padded) webcam stream, so
    // capping at screen_dur is always >= the longest mapped output.
    args.push("-loop".into());
    args.push("1".into());
    args.push("-framerate".into());
    args.push("30".into());
    args.push("-t".into());
    args.push(format!("{:.3}", screen_dur));
    args.push("-i".into());
    args.push(mask_path.to_string_lossy().into_owned());
    // Webcam segments occupy inputs 2..(2+N). Mask is the input after the
    // last segment.
    let wc_input_base = 2usize;
    let mask_idx = wc_input_base + webcam_segments.len();

    // Build filter_complex.
    // Input 0 is screen (video — audio dropped). Input 1 is screen with the
    // audio-shift `-itsoffset` applied; we map its audio stream. Inputs 2..2+N
    // are webcam segments. Last input is the mask PNG.
    // - Concat webcam segments into [wc_full] (if N>1; otherwise rename the
    //   single segment).
    // - Crop to centered square (smaller dimension), scale to target, convert
    //   to yuva420p; alphamerge with the pre-rendered circle mask.
    // - Overlay onto screen with eof_action=pass so the screen continues
    //   uncovered after the webcam track ends.
    let n = webcam_segments.len();
    let mut filter = String::new();
    // Pad the head of the webcam track so the bubble is visible from t=0
    // even when ffmpeg's AVCaptureSession lagged behind SCK. start_mode=clone
    // duplicates the first decoded frame; threshold matches the previous
    // -itsoffset gate so we don't insert a 0s tpad on aligned recordings.
    let head_pad = if lead_in > 0.001 {
        format!(",tpad=start_duration={lead_in:.3}:start_mode=clone")
    } else {
        String::new()
    };
    let wc0 = wc_input_base; // first webcam segment input index
    if n > 1 {
        for i in 0..n {
            filter.push_str(&format!("[{}:v]", wc0 + i));
        }
        filter.push_str(&format!("concat=n={n}:v=1:a=0{head_pad}[wc_full];"));
    } else if head_pad.is_empty() {
        filter.push_str(&format!("[{wc0}:v]copy[wc_full];"));
    } else {
        // tpad sits inline on the segment input — copy is unnecessary when
        // we're applying any filter at all.
        filter.push_str(&format!(
            "[{wc0}:v]tpad=start_duration={lead_in:.3}:start_mode=clone[wc_full];"
        ));
    }
    // hflip matches the preview's CSS `transform: scaleX(-1)` (WebcamBubble.tsx).
    // The invariant is preview-matches-recording; absolute orientation then
    // depends on whether the camera pre-mirrors (Continuity does, FaceTime HD
    // does not). See DECISIONS.md 2026-04-25.
    //
    // alphamerge replaces the previous inline `geq` circular-mask expression.
    // geq evaluates per-pixel-per-frame in software and was the dominant cost
    // in composite — for a 5-min clip it added tens of seconds. The mask PNG
    // is rendered once via tiny_skia and pulled in as a looping still input.
    // Note: fps=30 was previously applied here to conform the VFR screen
    // video to CFR before overlay. Dropped per A/B testing — user perception
    // of A/V sync was consistently better without it. The overlay filter
    // copes with VFR main input fine; bubble position expressions interpolate
    // off `t` (PTS) which is correct either way.
    filter.push_str(&format!(
        "[wc_full]hflip,crop='min(iw\\,ih)':'min(iw\\,ih)',\
scale={target}:{target},\
format=yuva420p[wc_rgba];\
[{mask_idx}:v]format=gray[mask_g];\
[wc_rgba][mask_g]alphamerge[wc];"
    ));

    // Position the overlay. Empty log → static corner. Otherwise a single
    // overlay with nested if(lt(t,...)) x/y expressions; the split-and-chain
    // path is retained only as a safety net (see POSITION_LOG_MAX_INLINE).
    //
    // Simplified log feeds the expression builders so ffmpeg's expression
    // parser doesn't blow its recursion limit. The original log still goes
    // to the sidecar via lib.rs for re-composite during edit.
    let simplified_log = simplify_position_log(bubble_position_log);
    let log_n = simplified_log.len();
    if log_n == 0 {
        let overlay_xy = corner.overlay_xy(PADDING_PX);
        filter.push_str(&format!(
            "[0:v][wc]overlay={overlay_xy}:eof_action=pass[outv]"
        ));
    } else if log_n <= POSITION_LOG_MAX_INLINE {
        let (x_expr, y_expr) = build_inline_position_expr(&simplified_log);
        let enable_expr = build_inline_enable_expr(&simplified_log);
        filter.push_str(&format!(
            "[0:v][wc]overlay=x={x_expr}:y={y_expr}:enable={enable_expr}:eof_action=pass[outv]"
        ));
    } else {
        filter.push_str(&format!("[wc]split={log_n}"));
        for i in 0..log_n {
            filter.push_str(&format!("[wc_{i}]"));
        }
        filter.push(';');
        for i in 0..log_n {
            let entry = &simplified_log[i];
            let prev = if i == 0 {
                "0:v".to_string()
            } else {
                format!("v_{}", i - 1)
            };
            let in_bounds = segment_in_bounds(&simplified_log, i);
            let (enable, x_expr, y_expr) = if i + 1 < log_n {
                let b = &simplified_log[i + 1];
                let dt = (b.t - entry.t).max(0.001);
                let enable = if in_bounds {
                    format!("between(t\\,{:.3}\\,{:.3})", entry.t, b.t)
                } else {
                    "0".to_string()
                };
                let x = format!(
                    "main_w*({:.4}+({:.4})*(t-{:.3})/{:.3})-overlay_w/2",
                    entry.x,
                    b.x - entry.x,
                    entry.t,
                    dt
                );
                let y = format!(
                    "main_h*({:.4}+({:.4})*(t-{:.3})/{:.3})-overlay_h/2",
                    entry.y,
                    b.y - entry.y,
                    entry.t,
                    dt
                );
                (enable, x, y)
            } else {
                let enable = if in_bounds {
                    format!("gte(t\\,{:.3})", entry.t)
                } else {
                    "0".to_string()
                };
                let x = format!("main_w*{:.4}-overlay_w/2", entry.x);
                let y = format!("main_h*{:.4}-overlay_h/2", entry.y);
                (enable, x, y)
            };
            let next_label = if i + 1 == log_n {
                "outv".to_string()
            } else {
                format!("v_{i}")
            };
            filter.push_str(&format!(
                "[{prev}][wc_{i}]overlay=x={x_expr}:y={y_expr}:enable={enable}:eof_action=pass[{next_label}]"
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
    // Audio comes from input 1 (screen.mp4 with `-itsoffset` applied), not
    // input 0 — input 0 is the un-shifted copy used only for video.
    args.push("-map".into());
    args.push("1:a?".into());

    args.push("-c:v".into());
    args.push("h264_videotoolbox".into());
    args.push("-b:v".into());
    args.push("8M".into());
    args.push("-c:a".into());
    args.push("copy".into());

    args.push(output_path.to_string_lossy().into_owned());

    let mut child = Command::new(FFMPEG_PATH)
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to spawn ffmpeg composite: {e}"))?;

    // ffmpeg `-progress pipe:1` writes blocks of `key=value` lines roughly
    // every second. Parse out_time_us so the UI can show actual progress
    // instead of a frozen-looking idle screen.
    let stdout = child.stdout.take().ok_or("ffmpeg stdout missing")?;
    let stderr = child.stderr.take().ok_or("ffmpeg stderr missing")?;
    let total_us = (screen_dur * 1_000_000.0).max(1.0) as u64;
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
        .map_err(|e| format!("failed to wait on ffmpeg composite: {e}"))?;
    let _ = progress_thread.join();
    let stderr_text = stderr_thread.join().unwrap_or_default();

    if !status.success() {
        let tail = stderr_text
            .lines()
            .rev()
            .take(40)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<Vec<_>>()
            .join("\n");
        eprintln!(
            "[composite] ffmpeg failed (exit {:?}); position_log entries={}\n{}",
            status.code(),
            bubble_position_log.len(),
            tail
        );
        return Err(format!(
            "ffmpeg composite failed (exit {:?}):\n{}",
            status.code(),
            tail
        ));
    }

    Ok(())
}
