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
// Calibration progression 280 → 220 → 360 over the 2026-06 A/V sync
// investigation:
//
// - 280 (original, pre-investigation): empirically tuned by the v1
//   author. Worked on average on warm takes but consistently produced
//   a ~20-110ms video-lag on the four clean clap measurements
//   (stamps 191323 +20, 191514 +110, 191649 +105, 204006 +110).
//
// - 220 (mid-investigation, 2026-06-10): lowered to the midpoint of
//   the implied warm-take true-lead range (170-260ms). At this point
//   we incorrectly believed cold and warm takes needed different leads
//   — adaptive-lead was on the table — because cold first-of-session
//   recordings still drifted. We later isolated the actual cause:
//   cold ≠ warm wasn't a sliding-lag spectrum, it was a first-call
//   penalty on macOS framework caches (avfoundation device-open,
//   VTCompressionSession, SCK first-capture-call) that ONLY hits the
//   first recording per process lifetime / long-idle break.
//
// - 360 (2026-06-11): set after the pre-warm integration (commit
//   b906945) closed the cold/warm gap by warming those framework caches
//   before every real recording. With pre-warm active, cold and warm
//   pipelines hit the same warm-state webcam-vs-sck timing, and a single
//   constant works for both. Validated by clean sharp-clap measurement
//   at 360: cold ~30ms residual, warm ~10ms. Verified in production use
//   as late as 2026-06-24 (VizIQ Demo).
//
// - 105 (2026-07-12, this value): the environment's camera-open latency
//   dropped ~270ms sometime between 2026-06-24 and 2026-07-11 — same
//   boot session, no macOS update, and provably no app change (a rebuilt
//   June-era app measured the same new offset). 360 then made the bubble
//   LAG the voice by ~270ms on every export. Recalibrated via four
//   sharp-clap runs (2 cold + 2 warm, built-in mic + built-in camera,
//   Mic Mode Standard): true offsets +88/+113/+114/+119ms — a 31ms
//   spread, inside one 30fps frame, cold == warm. 105 is the midrange
//   (max residual 17ms). Full investigation: DECISIONS.md 2026-07-12.
//
// The real value being approximated is the per-recording wallclock
// offset between webcam ffmpeg's first encoded frame and SCK's first
// captured frame on the warm-cache pipeline state. Pre-warm makes
// this offset stable enough that a constant captures it — until the
// environment moves it, which has now happened once.
//
// WARNING — this constant is ENVIRONMENT- and DEVICE-DEPENDENT. It is
// calibrated for the BUILT-IN mic + BUILT-IN camera only, and silently
// bakes in both per-device audio-chain latency and per-device camera
// startup latency:
//   - a Bluetooth mic (AirPods SCO/HFP) adds ~150-300ms audio latency;
//   - a Continuity iPhone camera adds large, variable startup latency;
//   - engine startup-path changes and OS/daemon state shifts move the
//     SCK term (the 2026-07 drift was environmental camera-open speedup).
// If you change any of those, re-run the clap protocol (audio clap peak
// vs webcam motion-energy peak on the raw scratch, 2 cold + 2 warm; see
// DECISIONS.md 2026-07-12) rather than nudging by ear. Symptom key:
// bubble LEADS the voice -> raise; bubble LAGS -> lower. The structural
// fix stays: measure per recording (engine timestamps each pipeline's
// first real sample; both clocks are already mach-domain) instead of
// hoping a constant holds still.
pub(crate) const WEBCAM_LEAD_MS: f64 = 105.0;

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
// (Save MP4 / GIF / Copy) and linkedin.rs. By default the logo is scaled to
// 10% of the shorter source dimension (height, aspect preserved) and padded
// 2% off the chosen corner, with the PNG's own alpha respected. scale_frac
// overrides the size (logo WIDTH as a fraction of video width, so it looks
// consistent across export resolutions); opacity < 1 multiplies the PNG's
// alpha. None/1.0 keep the legacy filter string byte-identical.
#[derive(Clone)]
pub(crate) struct Watermark {
    pub logo_path: PathBuf,
    pub corner: Corner,
    pub scale_frac: Option<f64>,
    pub opacity: f64,
}

impl Watermark {
    // Build from export-command args. None unless a logo path is given;
    // corner defaults to top-right, scale/opacity to legacy behavior.
    pub(crate) fn from_args(
        logo: Option<String>,
        corner: Option<String>,
        scale: Option<f64>,
        opacity: Option<f64>,
    ) -> Option<Watermark> {
        let logo = logo?;
        Some(Watermark {
            logo_path: PathBuf::from(logo),
            corner: corner.as_deref().map(Corner::from_code).unwrap_or(Corner::TopRight),
            scale_frac: scale.filter(|s| s.is_finite() && *s > 0.0 && *s <= 1.0),
            opacity: opacity
                .filter(|o| o.is_finite())
                .map(|o| o.clamp(0.0, 1.0))
                .unwrap_or(1.0),
        })
    }

    fn metrics(sw: u32, sh: u32) -> (u32, u32) {
        let short = sw.min(sh) as f64;
        let height = (short * 0.10).round().max(1.0) as u32;
        let padding = (short * 0.02).round() as u32;
        (height, padding)
    }

    // "[{idx}:v]scale=...[wm];[{prev}][wm]overlay={xy}[{next}]"
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
        // Width-based scale when set (mirrors WatermarkPreviewLayer's
        // cw * scale), legacy shorter-dim height scale otherwise.
        let scale = match self.scale_frac {
            Some(frac) => {
                let w = ((sw as f64 * frac).round() as u32).max(1);
                format!("scale={w}:-2")
            }
            None => format!("scale=-2:{height}"),
        };
        // Alpha multiply only when non-default so legacy exports keep the
        // exact pre-feature filter string.
        let fade = if self.opacity < 0.999 {
            format!(",format=rgba,colorchannelmixer=aa={:.3}", self.opacity)
        } else {
            String::new()
        };
        let xy = self.corner.overlay_xy(padding);
        format!("[{logo_idx}:v]{scale}{fade}[wm];[{prev_label}][wm]overlay={xy}[{next_label}]")
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

// Rounded-square path: side `size`, corner radius `radius`, top-left at
// (offset, offset). Four cubic arcs with the standard circle kappa — at
// radius = size/2 this is the usual 4-arc circle approximation (max radial
// deviation ~0.02%, invisible at bubble sizes).
fn rounded_square_path(size: f32, radius: f32, offset: f32) -> Option<tiny_skia::Path> {
    use tiny_skia::PathBuilder;
    let r = radius.clamp(0.0, size / 2.0);
    let k = 0.552_284_75_f32;
    let c = r * k;
    let (x0, y0) = (offset, offset);
    let (x1, y1) = (offset + size, offset + size);
    let mut pb = PathBuilder::new();
    pb.move_to(x0 + r, y0);
    pb.line_to(x1 - r, y0);
    pb.cubic_to(x1 - r + c, y0, x1, y0 + r - c, x1, y0 + r);
    pb.line_to(x1, y1 - r);
    pb.cubic_to(x1, y1 - r + c, x1 - r + c, y1, x1 - r, y1);
    pb.line_to(x0 + r, y1);
    pb.cubic_to(x0 + r - c, y1, x0, y1 - r + c, x0, y1 - r);
    pb.line_to(x0, y0 + r);
    pb.cubic_to(x0, y0 + r - c, x0 + r - c, y0, x0 + r, y0);
    pb.close();
    pb.finish()
}

// Bubble silhouette at the given roundness (0.0 square -> 1.0 circle; corner
// radius = roundness * diameter/2, mirrored by Review.tsx's border-radius so
// preview and export agree by construction). None = the pre-E1 from_circle
// path, kept as its own branch so roundness-less sidecars produce
// byte-identical mask/shadow PNGs — that is the E1 regression guard; don't
// collapse it into rounded_square_path even though roundness 1.0 looks the
// same.
fn bubble_path(diameter: u32, roundness: Option<f64>, offset: f32) -> Option<tiny_skia::Path> {
    use tiny_skia::PathBuilder;
    match roundness {
        None => {
            let r = diameter as f32 / 2.0;
            PathBuilder::from_circle(offset + r, offset + r, r)
        }
        Some(rd) => {
            let radius = (rd.clamp(0.0, 1.0) * diameter as f64 / 2.0) as f32;
            rounded_square_path(diameter as f32, radius, offset)
        }
    }
}

// "mask-240.png" for the legacy circle (None) — the exact pre-E1 name, part
// of the pinned arg vector — and "mask-240-r035.png" for roundness 0.35, so
// styled and legacy masks can't collide in the same scratch dir.
fn mask_file_name(prefix: &str, target: u32, roundness: Option<f64>) -> String {
    match roundness {
        None => format!("{prefix}-{target}.png"),
        Some(r) => format!(
            "{prefix}-{target}-r{:03}.png",
            (r.clamp(0.0, 1.0) * 100.0).round() as u32
        ),
    }
}

// Render the bubble alpha mask to disk for use as an ffmpeg input. The PNG
// has a white opaque silhouette on a transparent background; ffmpeg's
// `format=gray` filter then yields a luma-only stream where 255 = inside,
// 0 = outside. Doing this once per recording costs ~1ms vs the
// per-pixel-per-frame cost of the previous inline `geq` expression, which
// dominated composite time on multi-minute clips.
fn render_alpha_mask(
    diameter: u32,
    roundness: Option<f64>,
    out_path: &Path,
) -> Result<(), String> {
    use tiny_skia::{FillRule, Paint, Pixmap, Transform};
    let mut pixmap = Pixmap::new(diameter, diameter)
        .ok_or_else(|| format!("alloc mask pixmap {diameter}x{diameter}"))?;
    let path = bubble_path(diameter, roundness, 0.0).ok_or("invalid mask path")?;
    let mut paint = Paint::default();
    paint.set_color_rgba8(255, 255, 255, 255);
    paint.anti_alias = true;
    pixmap.fill_path(&path, &paint, FillRule::Winding, Transform::identity(), None);
    let png = pixmap.encode_png().map_err(|e| format!("encode mask png: {e}"))?;
    std::fs::write(out_path, png).map_err(|e| format!("write mask png: {e}"))?;
    Ok(())
}

// Shadow source PNG: an opaque black bubble silhouette of `diameter` on a
// transparent canvas of size `diameter + 2 * padding`. ffmpeg's `gblur` then
// softens its edge into the padding, and `colorchannelmixer aa=SHADOW_ALPHA`
// dims the whole thing — producing the soft drop shadow overlaid behind the
// bubble. Matches Review.tsx's `box-shadow: 0 8px 24px rgba(0,0,0,0.22)`
// by-eye; see SHADOW_* constants below for the gblur→CSS-blur calibration.
// CSS box-shadow follows border-radius automatically, so the rounded-rect
// silhouette keeps preview parity with no recalibration.
fn render_shadow_source(
    diameter: u32,
    padding: u32,
    roundness: Option<f64>,
    out_path: &Path,
) -> Result<(), String> {
    use tiny_skia::{FillRule, Paint, Pixmap, Transform};
    let size = diameter + 2 * padding;
    let mut pixmap = Pixmap::new(size, size)
        .ok_or_else(|| format!("alloc shadow pixmap {size}x{size}"))?;
    let path = bubble_path(diameter, roundness, padding as f32).ok_or("invalid shadow path")?;
    let mut paint = Paint::default();
    paint.set_color_rgba8(0, 0, 0, 255);
    paint.anti_alias = true;
    pixmap.fill_path(&path, &paint, FillRule::Winding, Transform::identity(), None);
    let png = pixmap.encode_png().map_err(|e| format!("encode shadow png: {e}"))?;
    std::fs::write(out_path, png).map_err(|e| format!("write shadow png: {e}"))?;
    Ok(())
}

// Shadow calibration vs Review.tsx's `box-shadow: 0 8px 24px rgba(0,0,0,0.22)`.
// All three pixel params scale with `target` (bubble diameter) so a resized
// bubble keeps the same visual shadow proportions. Values picked at
// target=240 to match CSS by-eye on a mid-gray background (CSS blur and
// ffmpeg gblur have different falloff curves, so the conversion isn't the
// spec's blur≈2σ — see the shadow tuning notes in commit history).
//   - PADDING:  diameter/4   — buffer around the circle so gblur has room
//                              to fade alpha into transparent pixels
//   - SIGMA:    diameter*0.075 (≈18 at target=240) — gblur stddev
//   - OFFSET_Y: diameter/30   (≈8 at target=240) — vertical drop
const SHADOW_PADDING_FRAC: f64 = 0.25;
const SHADOW_SIGMA_FRAC: f64 = 0.075;
const SHADOW_OFFSET_FRAC: f64 = 1.0 / 30.0;
const SHADOW_ALPHA: f64 = 0.22;

// Where the shadow's top-left lands when the bubble is statically placed at
// a corner (no position log). Shadow canvas is (target + 2*shadow_padding),
// centered on the bubble's center then shifted down by offset_y — so its
// top-left is bubble_top_left + (-shadow_padding, offset_y - shadow_padding).
// Literal arithmetic (not `overlay_w`) because the bubble's corner formula
// uses its own overlay_w which differs from the shadow's.
fn shadow_overlay_xy_for_corner(
    corner: Corner,
    padding: u32,
    target: u32,
    shadow_padding: u32,
    offset_y: u32,
) -> String {
    let p = padding as i32;
    let sp = shadow_padding as i32;
    let oy = offset_y as i32;
    let t = target as i32;
    match corner {
        Corner::TopLeft => format!("{}:{}", p - sp, p + oy - sp),
        Corner::TopRight => format!("main_w-{}:{}", t + p + sp, p + oy - sp),
        Corner::BottomLeft => format!("{}:main_h-{}", p - sp, t + p - oy + sp),
        Corner::BottomRight => format!("main_w-{}:main_h-{}", t + p + sp, t + p - oy + sp),
    }
}

pub fn composite(
    screen_path: &Path,
    webcam_segments: &[PathBuf],
    output_path: &Path,
    size: WebcamSize,
    corner: Corner,
    bubble_position_log: &[BubblePositionEntry],
    bubble_roundness: Option<f64>,
    watermark: Option<Watermark>,
    on_progress: impl Fn(f64) + Send + 'static,
) -> Result<(), String> {
    if webcam_segments.is_empty() {
        return Err("no webcam segments to composite".into());
    }

    // Webcam-vs-audio alignment via tpad on the webcam stream — see
    // module-level WEBCAM_LEAD_MS for the rationale. Fixed calibrated
    // value, not derived from the screen/webcam duration delta (which
    // is dominated by stop-timing jitter, not start latency).
    let screen_dur = probe_duration_seconds(screen_path)?;

    // Drop the screen.mp4 audio's own leading gap (SCK mic-init latency — the
    // audio stream's start_time, typically 0-70ms) via `-itsoffset` on the
    // audio-only input copy, so the audio and screen video share t=0. The mp4
    // muxer normalizes the resulting negative PTS to zero.
    let audio_shift = probe_audio_start_time(screen_path).unwrap_or(0.0);

    let args = build_composite_args(
        screen_path,
        webcam_segments,
        output_path,
        size,
        corner,
        bubble_position_log,
        bubble_roundness,
        watermark,
        screen_dur,
        audio_shift,
    )?;
    run_composite_ffmpeg(args, screen_dur, bubble_position_log.len(), on_progress)
}

// Everything deterministic about a composite: mask/shadow PNG rendering and
// the full ffmpeg argument vector. Split from the ffmpeg run so tests can pin
// the exact args (and mask bytes) a roundness-less sidecar produces.
#[allow(clippy::too_many_arguments)]
fn build_composite_args(
    screen_path: &Path,
    webcam_segments: &[PathBuf],
    output_path: &Path,
    size: WebcamSize,
    corner: Corner,
    bubble_position_log: &[BubblePositionEntry],
    bubble_roundness: Option<f64>,
    watermark: Option<Watermark>,
    screen_dur: f64,
    audio_shift: f64,
) -> Result<Vec<String>, String> {
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

    let lead_in = WEBCAM_LEAD_MS / 1000.0;

    // Pre-render the alpha mask alongside the output so it lives in the same
    // scratch dir and gets cleaned up with the recording.
    let out_dir = output_path.parent().ok_or("output path has no parent")?;
    let mask_path = out_dir.join(mask_file_name("mask", target, bubble_roundness));
    render_alpha_mask(target, bubble_roundness, &mask_path)?;

    // Shadow pixel params scale with the bubble's `target` diameter so the
    // shadow's visual proportions stay consistent across bubble sizes — same
    // intent as CSS `box-shadow` with fixed px, applied to a fixed bubble.
    let shadow_padding = ((target as f64) * SHADOW_PADDING_FRAC).round() as u32;
    let shadow_sigma = ((target as f64) * SHADOW_SIGMA_FRAC).round();
    let shadow_offset_y = ((target as f64) * SHADOW_OFFSET_FRAC).round() as u32;
    let shadow_path = out_dir.join(mask_file_name("shadow", target, bubble_roundness));
    render_shadow_source(target, shadow_padding, bubble_roundness, &shadow_path)?;

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
    // Shadow source PNG, same looping treatment as the mask.
    args.push("-loop".into());
    args.push("1".into());
    args.push("-framerate".into());
    args.push("30".into());
    args.push("-t".into());
    args.push(format!("{:.3}", screen_dur));
    args.push("-i".into());
    args.push(shadow_path.to_string_lossy().into_owned());
    // Fix B: watermark logo input (single still — overlay's default
    // eof_action=repeat holds it across the clip, so no -loop, matching the
    // pass-2 watermark path). Sits one input past the shadow.
    if let Some(wm) = &watermark {
        args.push("-i".into());
        args.push(wm.logo_path.to_string_lossy().into_owned());
    }
    // Webcam segments occupy inputs 2..(2+N). Mask is the input after the
    // last segment; shadow PNG sits one past the mask; watermark logo (if any)
    // one past the shadow.
    let wc_input_base = 2usize;
    let mask_idx = wc_input_base + webcam_segments.len();
    let shadow_idx = mask_idx + 1;
    let wm_logo_idx = shadow_idx + 1;

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
[wc_rgba][mask_g]alphamerge[wc];\
[{shadow_idx}:v]format=rgba,gblur=sigma={shadow_sigma},colorchannelmixer=aa={SHADOW_ALPHA}[shadow];"
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
        let shadow_xy = shadow_overlay_xy_for_corner(
            corner,
            PADDING_PX,
            target,
            shadow_padding,
            shadow_offset_y,
        );
        filter.push_str(&format!(
            "[0:v][shadow]overlay={shadow_xy}:eof_action=pass[shadowed];\
[shadowed][wc]overlay={overlay_xy}:eof_action=pass[outv_pre]"
        ));
    } else if log_n <= POSITION_LOG_MAX_INLINE {
        let (x_expr, y_expr) = build_inline_position_expr(&simplified_log);
        let enable_expr = build_inline_enable_expr(&simplified_log);
        // Shadow shares the bubble's x/y expressions because both expressions
        // use `overlay_w/2`-style centering — applied to each overlay's own
        // size, the centers land on the same bubble position. The shadow's y
        // gets `+shadow_offset_y` for the downward drop.
        filter.push_str(&format!(
            "[0:v][shadow]overlay=x={x_expr}:y=({y_expr})+{shadow_offset_y}:enable={enable_expr}:eof_action=pass[shadowed];\
[shadowed][wc]overlay=x={x_expr}:y={y_expr}:enable={enable_expr}:eof_action=pass[outv_pre]"
        ));
    } else {
        // Dead path in practice — `simplify_position_log` caps at
        // POSITION_LOG_MAX_SIMPLIFIED (80) before this branch's threshold
        // (100_000) is ever crossed. Skip shadow here rather than thread it
        // through the per-segment chain.
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
                "outv_pre".to_string()
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

    // Fix B: bake the watermark as one final overlay over the composited frame.
    // All three position-log branches above terminate in [outv_pre]; this is the
    // single shared overlay that consumes it and produces the mapped [outv]. The
    // logo uses its own PNG alpha and never enters the webcam circular-mask
    // chain. Screen dims drive metrics/placement — identical to what the pass-2
    // watermark fed (composite output == screen dims), so position is unchanged.
    let map_label = match &watermark {
        Some(wm) => {
            let (sw, sh) = crate::edit::probe_dimensions(screen_path)?;
            filter.push(';');
            filter.push_str(&wm.filter_fragment(wm_logo_idx, "outv_pre", "outv", sw, sh));
            "[outv]"
        }
        None => "[outv_pre]",
    };

    args.push("-filter_complex".into());
    args.push(filter);

    args.push("-map".into());
    args.push(map_label.into());
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

    Ok(args)
}

fn run_composite_ffmpeg(
    args: Vec<String>,
    screen_dur: f64,
    position_log_len: usize,
    on_progress: impl Fn(f64) + Send + 'static,
) -> Result<(), String> {
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
            position_log_len,
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

#[cfg(test)]
mod tests {
    use super::*;

    // Pins the watermark filter strings: untouched sliders (scale None,
    // opacity 1) must produce the exact pre-feature fragment; styled
    // watermarks size by width fraction and multiply alpha.
    #[test]
    fn watermark_fragment_legacy_and_styled() {
        let legacy = Watermark {
            logo_path: std::path::PathBuf::from("/tmp/logo.png"),
            corner: Corner::TopRight,
            scale_frac: None,
            opacity: 1.0,
        };
        // 1920x1080: height = 108, padding = 22 — the pre-feature string.
        assert_eq!(
            legacy.filter_fragment(3, "a", "b", 1920, 1080),
            "[3:v]scale=-2:108[wm];[a][wm]overlay=main_w-overlay_w-22:22[b]"
        );

        let styled = Watermark {
            logo_path: std::path::PathBuf::from("/tmp/logo.png"),
            corner: Corner::TopRight,
            scale_frac: Some(0.25),
            opacity: 0.5,
        };
        // Width-based: 1920 * 0.25 = 480; alpha multiply appended.
        assert_eq!(
            styled.filter_fragment(3, "a", "b", 1920, 1080),
            "[3:v]scale=480:-2,format=rgba,colorchannelmixer=aa=0.500[wm];[a][wm]overlay=main_w-overlay_w-22:22[b]"
        );

        // from_args defaults keep legacy semantics; out-of-range values
        // fall back rather than break an export.
        let wm = Watermark::from_args(Some("/x.png".into()), Some("tr".into()), None, None)
            .expect("logo set");
        assert!(wm.scale_frac.is_none());
        assert_eq!(wm.opacity, 1.0);
        let clamped =
            Watermark::from_args(Some("/x.png".into()), None, Some(7.0), Some(3.0)).expect("logo");
        assert!(clamped.scale_frac.is_none(), "scale > 1 rejected");
        assert_eq!(clamped.opacity, 1.0, "opacity clamped to 1");
    }

    fn fixture_bytes(name: &str) -> Vec<u8> {
        let p = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures")
            .join(name);
        std::fs::read(&p).unwrap_or_else(|e| panic!("read fixture {}: {e}", p.display()))
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("zeigen-e1-{tag}-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn log_2_entries() -> Vec<BubblePositionEntry> {
        vec![
            BubblePositionEntry { t: 0.0, x: 0.9, y: 0.85, diameter: Some(240.0) },
            BubblePositionEntry { t: 2.0, x: 0.5, y: 0.5, diameter: Some(240.0) },
        ]
    }

    fn build_args_for_test(
        dir: &Path,
        log: &[BubblePositionEntry],
        roundness: Option<f64>,
    ) -> Vec<String> {
        build_composite_args(
            &dir.join("screen.mp4"),
            &[dir.join("webcam-0.mp4")],
            &dir.join("composite.mp4"),
            WebcamSize::Medium,
            Corner::BottomRight,
            log,
            roundness,
            None,
            10.0,
            0.02,
        )
        .unwrap()
    }

    // E1 visual gate renderer: full composites of the stashed phase-15
    // baseline recording at three roundness values, for eyeball comparison
    // against the Review preview. Ignored — needs the out-of-repo fixture.
    //
    //   cargo test --lib e1_roundness_gate -- --ignored --nocapture
    #[test]
    #[ignore]
    fn e1_roundness_gate() {
        let home = std::env::var("HOME").unwrap();
        let fix_dir = PathBuf::from(&home)
            .join("Movies/Zeigen/.phase15-baseline/recording-2026-06-02-205517");
        let screen = fix_dir.join("sources/screen.mp4");
        let webcam = fix_dir.join("sources/webcam-00.mp4");
        assert!(screen.is_file(), "fixture missing: {}", screen.display());
        assert!(webcam.is_file(), "fixture missing: {}", webcam.display());
        let sidecar = crate::edit::read_sidecar_path(
            &fix_dir.join("recording-2026-06-02-205517.mp4"),
        )
        .expect("read sidecar")
        .expect("fixture sidecar present");

        let out_dir = temp_dir("gate");
        for (name, roundness) in [
            ("circle", None),
            ("squircle", Some(0.35)),
            ("nearsquare", Some(0.08)),
        ] {
            let out = out_dir.join(format!("gate-{name}.mp4"));
            composite(
                &screen,
                std::slice::from_ref(&webcam),
                &out,
                WebcamSize::Medium,
                Corner::BottomRight,
                &sidecar.bubble_position_log,
                roundness,
                None,
                |_| {},
            )
            .unwrap();
            println!("rendered {}", out.display());
        }
    }

    // E1 regression guard: the full ffmpeg argument vector for a
    // roundness-less sidecar is pinned (pre-E1 behavior, both live filter
    // branches). Paths are normalized to <TMP>. If this fails because you
    // intentionally changed the composite graph, re-pin — but a failure
    // during styling work means the legacy path regressed.
    #[test]
    fn legacy_args_pinned() {
        let expected_static = "-y\u{1}-hide_banner\u{1}-nostats\u{1}-progress\u{1}pipe:1\u{1}-i\u{1}<TMP>/screen.mp4\u{1}-itsoffset\u{1}-0.020\u{1}-i\u{1}<TMP>/screen.mp4\u{1}-i\u{1}<TMP>/webcam-0.mp4\u{1}-loop\u{1}1\u{1}-framerate\u{1}30\u{1}-t\u{1}10.000\u{1}-i\u{1}<TMP>/mask-240.png\u{1}-loop\u{1}1\u{1}-framerate\u{1}30\u{1}-t\u{1}10.000\u{1}-i\u{1}<TMP>/shadow-240.png\u{1}-filter_complex\u{1}[2:v]tpad=start_duration=0.105:start_mode=clone[wc_full];[wc_full]hflip,crop='min(iw\\,ih)':'min(iw\\,ih)',scale=240:240,format=yuva420p[wc_rgba];[3:v]format=gray[mask_g];[wc_rgba][mask_g]alphamerge[wc];[4:v]format=rgba,gblur=sigma=18,colorchannelmixer=aa=0.22[shadow];[0:v][shadow]overlay=main_w-324:main_h-316:eof_action=pass[shadowed];[shadowed][wc]overlay=main_w-overlay_w-24:main_h-overlay_h-24:eof_action=pass[outv_pre]\u{1}-map\u{1}[outv_pre]\u{1}-map\u{1}1:a?\u{1}-c:v\u{1}h264_videotoolbox\u{1}-b:v\u{1}8M\u{1}-c:a\u{1}copy\u{1}<TMP>/composite.mp4";
        let expected_keyframe = "-y\u{1}-hide_banner\u{1}-nostats\u{1}-progress\u{1}pipe:1\u{1}-i\u{1}<TMP>/screen.mp4\u{1}-itsoffset\u{1}-0.020\u{1}-i\u{1}<TMP>/screen.mp4\u{1}-i\u{1}<TMP>/webcam-0.mp4\u{1}-loop\u{1}1\u{1}-framerate\u{1}30\u{1}-t\u{1}10.000\u{1}-i\u{1}<TMP>/mask-240.png\u{1}-loop\u{1}1\u{1}-framerate\u{1}30\u{1}-t\u{1}10.000\u{1}-i\u{1}<TMP>/shadow-240.png\u{1}-filter_complex\u{1}[2:v]tpad=start_duration=0.105:start_mode=clone[wc_full];[wc_full]hflip,crop='min(iw\\,ih)':'min(iw\\,ih)',scale=240:240,format=yuva420p[wc_rgba];[3:v]format=gray[mask_g];[wc_rgba][mask_g]alphamerge[wc];[4:v]format=rgba,gblur=sigma=18,colorchannelmixer=aa=0.22[shadow];[0:v][shadow]overlay=x=if(lt(t\\,2.000)\\,main_w*(0.9000+(-0.4000)*max(0\\,(t-0.000)/2.000))-overlay_w/2\\,main_w*0.5000-overlay_w/2):y=(if(lt(t\\,2.000)\\,main_h*(0.8500+(-0.3500)*max(0\\,(t-0.000)/2.000))-overlay_h/2\\,main_h*0.5000-overlay_h/2))+8:enable=if(lt(t\\,2.000)\\,1\\,1):eof_action=pass[shadowed];[shadowed][wc]overlay=x=if(lt(t\\,2.000)\\,main_w*(0.9000+(-0.4000)*max(0\\,(t-0.000)/2.000))-overlay_w/2\\,main_w*0.5000-overlay_w/2):y=if(lt(t\\,2.000)\\,main_h*(0.8500+(-0.3500)*max(0\\,(t-0.000)/2.000))-overlay_h/2\\,main_h*0.5000-overlay_h/2):enable=if(lt(t\\,2.000)\\,1\\,1):eof_action=pass[outv_pre]\u{1}-map\u{1}[outv_pre]\u{1}-map\u{1}1:a?\u{1}-c:v\u{1}h264_videotoolbox\u{1}-b:v\u{1}8M\u{1}-c:a\u{1}copy\u{1}<TMP>/composite.mp4";
        for (expected, log) in [
            (expected_static, vec![]),
            (expected_keyframe, log_2_entries()),
        ] {
            let dir = temp_dir("pin");
            let args = build_args_for_test(&dir, &log, None);
            let joined = args
                .join("\u{1}")
                .replace(&dir.to_string_lossy().into_owned(), "<TMP>");
            assert_eq!(joined, expected);
        }

        // And the roundness-less callpath produced the pre-E1 mask bytes,
        // under the pre-E1 filename, end to end.
        let dir = temp_dir("pin");
        assert_eq!(
            std::fs::read(dir.join("mask-240.png")).unwrap(),
            fixture_bytes("mask-240-circle.png")
        );
    }

    // E1 regression guard: roundness-less renders are byte-identical to the
    // pre-E1 circle output (fixtures captured from the pre-E1 code).
    #[test]
    fn legacy_mask_and_shadow_byte_identical_to_pre_e1() {
        let dir = temp_dir("legacy");
        let mask240 = dir.join("mask-240.png");
        let mask320 = dir.join("mask-320.png");
        let shadow240 = dir.join("shadow-240.png");
        render_alpha_mask(240, None, &mask240).unwrap();
        render_alpha_mask(320, None, &mask320).unwrap();
        render_shadow_source(240, 60, None, &shadow240).unwrap();
        assert_eq!(std::fs::read(&mask240).unwrap(), fixture_bytes("mask-240-circle.png"));
        assert_eq!(std::fs::read(&mask320).unwrap(), fixture_bytes("mask-320-circle.png"));
        assert_eq!(
            std::fs::read(&shadow240).unwrap(),
            fixture_bytes("shadow-240-pad60-circle.png")
        );
    }

    // Rounded-square geometry sanity: low roundness leaves the corner region
    // transparent and fills edge midpoints; full roundness matches a circle's
    // occupancy (corner transparent, center opaque).
    #[test]
    fn rounded_square_mask_geometry() {
        let dir = temp_dir("geom");
        let d = 240u32;

        let near_square = dir.join("mask-square.png");
        render_alpha_mask(d, Some(0.08), &near_square).unwrap();
        let px = tiny_skia::Pixmap::decode_png(&std::fs::read(&near_square).unwrap()).unwrap();
        // Corner radius is 0.08 * 120 ≈ 10px. (12,2) is past the corner arc
        // on the top edge run — filled on a near-square, far outside a
        // circle. (0,0) is clearly inside the corner cut ((2,2) is too close
        // to the arc — anti-aliasing leaves it faintly covered).
        assert!(px.pixel(12, 2).unwrap().alpha() > 200, "near-square top edge filled");
        assert_eq!(px.pixel(0, 0).unwrap().alpha(), 0, "near-square corner cut transparent");
        assert!(px.pixel(120, 120).unwrap().alpha() > 200, "center filled");

        let circle = dir.join("mask-round.png");
        render_alpha_mask(d, Some(1.0), &circle).unwrap();
        let px = tiny_skia::Pixmap::decode_png(&std::fs::read(&circle).unwrap()).unwrap();
        assert_eq!(px.pixel(12, 2).unwrap().alpha(), 0, "circle: (12,2) outside");
        assert!(px.pixel(120, 120).unwrap().alpha() > 200, "circle center filled");
        assert!(px.pixel(120, 2).unwrap().alpha() > 200, "circle top midpoint filled");
    }

    // Styled masks must not collide with the legacy mask file in the same
    // scratch dir.
    #[test]
    fn styled_mask_gets_distinct_filename() {
        assert_eq!(mask_file_name("mask", 240, None), "mask-240.png");
        assert_eq!(mask_file_name("mask", 240, Some(0.35)), "mask-240-r035.png");
        assert_eq!(mask_file_name("shadow", 240, Some(1.0)), "shadow-240-r100.png");
    }
}
