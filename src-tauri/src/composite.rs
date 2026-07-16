use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::{Deserialize, Serialize};

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

    // Inverse of from_code; feeds the V3 compositor's WATERMARK_CORNER env.
    pub(crate) fn code(self) -> &'static str {
        match self {
            Corner::TopLeft => "tl",
            Corner::TopRight => "tr",
            Corner::BottomLeft => "bl",
            Corner::BottomRight => "br",
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

// V2 Step 2: export bakes ONE constant bubble position (a zone) picked in
// Review. The old PTS-keyed f(t) position (build_inline_position_expr /
// simplify_position_log, plus the multi-monitor out-of-bounds `enable`
// suppression) is gone from the export path — a zone is always on the
// recorded display, so there is nothing to interpolate and nothing to
// suppress. bubble_position_log survives only as preview/legacy data (and
// as the diameter source); export ignores its positions. See
// docs/V2-BUILD-STATE.md.
//
// Six zones on a 2x3 grid: top/bottom row x left/center/right column.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BubbleZone {
    TopLeft,
    TopCenter,
    TopRight,
    BottomLeft,
    BottomCenter,
    BottomRight,
}

enum HAlign {
    Left,
    Center,
    Right,
}

enum VAlign {
    Top,
    Bottom,
}

impl BubbleZone {
    // Two-letter code the V3 compositor (main.swift BUBBLE_ZONE) parses.
    pub(crate) fn code(self) -> &'static str {
        match self {
            Self::TopLeft => "tl",
            Self::TopCenter => "tc",
            Self::TopRight => "tr",
            Self::BottomLeft => "bl",
            Self::BottomCenter => "bc",
            Self::BottomRight => "br",
        }
    }

    fn halign(self) -> HAlign {
        match self {
            Self::TopLeft | Self::BottomLeft => HAlign::Left,
            Self::TopCenter | Self::BottomCenter => HAlign::Center,
            Self::TopRight | Self::BottomRight => HAlign::Right,
        }
    }

    fn valign(self) -> VAlign {
        match self {
            Self::TopLeft | Self::TopCenter | Self::TopRight => VAlign::Top,
            Self::BottomLeft | Self::BottomCenter | Self::BottomRight => VAlign::Bottom,
        }
    }

    // Bubble overlay x:y, centered on the free axis with `padding` off the
    // pinned edges. Uses overlay_w/overlay_h (the bubble input's own size).
    // The four corners reproduce the pre-Step-2 `Corner::overlay_xy` strings
    // byte-for-byte — the legacy args pin depends on it.
    fn overlay_xy(self, padding: u32) -> String {
        let x = match self.halign() {
            HAlign::Left => format!("{padding}"),
            HAlign::Center => "(main_w-overlay_w)/2".to_string(),
            HAlign::Right => format!("main_w-overlay_w-{padding}"),
        };
        let y = match self.valign() {
            VAlign::Top => format!("{padding}"),
            VAlign::Bottom => format!("main_h-overlay_h-{padding}"),
        };
        format!("{x}:{y}")
    }

    // Shadow overlay x:y. The shadow canvas is (target + 2*shadow_padding);
    // its top-left = bubble_top_left + (-shadow_padding, offset_y -
    // shadow_padding). Literal `target` arithmetic (not overlay_w) because the
    // shadow input's own width differs from the bubble's. Corners reproduce
    // the pre-Step-2 `shadow_overlay_xy_for_corner` strings byte-for-byte.
    fn shadow_overlay_xy(
        self,
        padding: u32,
        target: u32,
        shadow_padding: u32,
        offset_y: u32,
    ) -> String {
        let p = padding as i32;
        let sp = shadow_padding as i32;
        let oy = offset_y as i32;
        let t = target as i32;
        let x = match self.halign() {
            HAlign::Left => format!("{}", p - sp),
            HAlign::Center => format!("(main_w-{t})/2-{sp}"),
            HAlign::Right => format!("main_w-{}", t + p + sp),
        };
        let y = match self.valign() {
            VAlign::Top => format!("{}", p + oy - sp),
            VAlign::Bottom => format!("main_h-{}", t + p - oy + sp),
        };
        format!("{x}:{y}")
    }
}

// The zone export bakes: an explicit zone from the sidecar wins; otherwise
// migrate an old recording to the nearest corner of its position-log
// centroid; an empty log (screen-only or pre-bubble) falls back to the
// legacy default corner. Review mirrors this rule for its picker default;
// keep the two in sync.
pub(crate) fn resolve_zone(zone: Option<BubbleZone>, log: &[BubblePositionEntry]) -> BubbleZone {
    if let Some(z) = zone {
        return z;
    }
    if log.is_empty() {
        return BubbleZone::BottomRight;
    }
    let n = log.len() as f64;
    let cx: f64 = log.iter().map(|e| e.x).sum::<f64>() / n;
    let cy: f64 = log.iter().map(|e| e.y).sum::<f64>() / n;
    // Nearest of the four corners only (mid-edges are user-pick-only). Ties at
    // exactly 0.5 resolve toward right/bottom, matching the BottomRight default.
    match (cx >= 0.5, cy >= 0.5) {
        (false, false) => BubbleZone::TopLeft,
        (true, false) => BubbleZone::TopRight,
        (false, true) => BubbleZone::BottomLeft,
        (true, true) => BubbleZone::BottomRight,
    }
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

// The webcam prep + masked/shadowed overlay filter, from `base_label` (the
// screen video to draw onto) to `out_label`. Shared by `composite()` (draws
// onto the raw screen [0:v]) and the V2 Step 3 zoom+webcam path (draws onto the
// zoomed screen). The `legacy_args_pinned` test pins composite's exact string,
// so this must reproduce it byte-for-byte for the identity case
// (pad_lead=WEBCAM_LEAD_MS/1000, wc_skip=0).
//
// Webcam-vs-screen alignment on the merged (trimmed) path: `pad_lead` frozen
// first-frame is prepended (tpad) and `wc_skip` seconds of the webcam are
// dropped, so at output t=0 the webcam shows content (trim_in - LEAD). For an
// untrimmed export that reduces to composite's plain tpad=LEAD.
#[allow(clippy::too_many_arguments)]
pub(crate) fn webcam_overlay_filter(
    base_label: &str,
    out_label: &str,
    n: usize,
    wc0: usize,
    mask_idx: usize,
    shadow_idx: usize,
    target: u32,
    pad_lead: f64,
    shadow_sigma: f64,
    shadow_padding: u32,
    shadow_offset_y: u32,
    zone: BubbleZone,
) -> String {
    webcam_overlay_filter_trimmed(
        base_label, out_label, n, wc0, mask_idx, shadow_idx, target, pad_lead, 0.0, shadow_sigma,
        shadow_padding, shadow_offset_y, zone,
    )
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn webcam_overlay_filter_trimmed(
    base_label: &str,
    out_label: &str,
    n: usize,
    wc0: usize,
    mask_idx: usize,
    shadow_idx: usize,
    target: u32,
    pad_lead: f64,
    wc_skip: f64,
    shadow_sigma: f64,
    shadow_padding: u32,
    shadow_offset_y: u32,
    zone: BubbleZone,
) -> String {
    // start_mode=clone freezes the first webcam frame across the LEAD (bubble
    // visible from t=0 despite AVCaptureSession lagging SCK); the trim drops
    // wc_skip on the merged trimmed path (nothing on the untrimmed identity).
    let head_pad = if pad_lead > 0.001 {
        format!(",tpad=start_duration={pad_lead:.3}:start_mode=clone")
    } else {
        String::new()
    };
    let skip = if wc_skip > 0.001 {
        format!(",trim=start={wc_skip:.3},setpts=PTS-STARTPTS")
    } else {
        String::new()
    };
    let extra = format!("{head_pad}{skip}");
    let mut filter = String::new();
    if n > 1 {
        for i in 0..n {
            filter.push_str(&format!("[{}:v]", wc0 + i));
        }
        filter.push_str(&format!("concat=n={n}:v=1:a=0{extra}[wc_full];"));
    } else if extra.is_empty() {
        filter.push_str(&format!("[{wc0}:v]copy[wc_full];"));
    } else {
        // Strip the leading ',' — these filters lead the chain for a single seg.
        let inline = extra.strip_prefix(',').unwrap_or(&extra);
        filter.push_str(&format!("[{wc0}:v]{inline}[wc_full];"));
    }
    // hflip mirrors the preview's CSS scaleX(-1); alphamerge applies the
    // pre-rendered mask PNG; the shadow PNG is blurred + alpha-scaled. See the
    // composite module notes for the A/V-sync rationale (no fps conform here).
    filter.push_str(&format!(
        "[wc_full]hflip,crop='min(iw\\,ih)':'min(iw\\,ih)',\
scale={target}:{target},\
format=yuva420p[wc_rgba];\
[{mask_idx}:v]format=gray[mask_g];\
[wc_rgba][mask_g]alphamerge[wc];\
[{shadow_idx}:v]format=rgba,gblur=sigma={shadow_sigma},colorchannelmixer=aa={SHADOW_ALPHA}[shadow];"
    ));
    let overlay_xy = zone.overlay_xy(PADDING_PX);
    let shadow_xy = zone.shadow_overlay_xy(PADDING_PX, target, shadow_padding, shadow_offset_y);
    filter.push_str(&format!(
        "[{base_label}][shadow]overlay={shadow_xy}:eof_action=pass[shadowed];\
[shadowed][wc]overlay={overlay_xy}:eof_action=pass[{out_label}]"
    ));
    filter
}

// V2 Step 3 webcam seam. The full webcam overlay bundle for the single-input
// zoom+webcam path: renders the mask/shadow PNGs into `out_dir`, builds the
// `-i` args for the webcam segments + looped mask + looped shadow (at
// `input_base`..), and packages the filter call. The caller appends
// `input_args` to its command and, once it knows the label of the (zoomed)
// screen to draw onto, calls `.filter(base, out)`. Reuses the exact renderers,
// diameter/shadow math, and overlay filter that `composite()` uses.
pub(crate) struct WebcamOverlay {
    pub input_args: Vec<String>,
    n: usize,
    input_base: usize,
    mask_idx: usize,
    shadow_idx: usize,
    target: u32,
    pad_lead: f64,
    wc_skip: f64,
    shadow_sigma: f64,
    shadow_padding: u32,
    shadow_offset_y: u32,
    zone: BubbleZone,
}

impl WebcamOverlay {
    pub(crate) fn filter(&self, base_label: &str, out_label: &str) -> String {
        webcam_overlay_filter_trimmed(
            base_label,
            out_label,
            self.n,
            self.input_base,
            self.mask_idx,
            self.shadow_idx,
            self.target,
            self.pad_lead,
            self.wc_skip,
            self.shadow_sigma,
            self.shadow_padding,
            self.shadow_offset_y,
            self.zone,
        )
    }
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn build_webcam_overlay(
    out_dir: &Path,
    webcam_segments: &[PathBuf],
    bubble_zone: Option<BubbleZone>,
    bubble_position_log: &[BubblePositionEntry],
    bubble_roundness: Option<f64>,
    size: WebcamSize,
    loop_dur: f64,
    input_base: usize,
    trim_in: f64,
) -> Result<WebcamOverlay, String> {
    // Same diameter source + shadow math as build_composite_args.
    let target = bubble_position_log
        .first()
        .and_then(|e| e.diameter)
        .map(|d| d.round().max(1.0) as u32)
        .unwrap_or_else(|| size.px());
    let mask_path = out_dir.join(mask_file_name("mask", target, bubble_roundness));
    render_alpha_mask(target, bubble_roundness, &mask_path)?;
    let shadow_padding = ((target as f64) * SHADOW_PADDING_FRAC).round() as u32;
    let shadow_sigma = ((target as f64) * SHADOW_SIGMA_FRAC).round();
    let shadow_offset_y = ((target as f64) * SHADOW_OFFSET_FRAC).round() as u32;
    let shadow_path = out_dir.join(mask_file_name("shadow", target, bubble_roundness));
    render_shadow_source(target, shadow_padding, bubble_roundness, &shadow_path)?;

    let n = webcam_segments.len();
    let mut input_args: Vec<String> = Vec::new();
    for seg in webcam_segments {
        input_args.push("-i".into());
        input_args.push(seg.to_string_lossy().into_owned());
    }
    // Mask + shadow looped stills, same treatment composite gives them.
    for p in [&mask_path, &shadow_path] {
        input_args.push("-loop".into());
        input_args.push("1".into());
        input_args.push("-framerate".into());
        input_args.push("30".into());
        input_args.push("-t".into());
        input_args.push(format!("{loop_dur:.3}"));
        input_args.push("-i".into());
        input_args.push(p.to_string_lossy().into_owned());
    }
    let mask_idx = input_base + n;
    let shadow_idx = mask_idx + 1;

    // Webcam-vs-screen alignment on a -ss-trimmed screen: prepend max(0,
    // LEAD - trim_in) frozen first-frame and drop max(0, trim_in - LEAD) of
    // webcam, so at output t=0 the webcam shows content (trim_in - LEAD).
    // Untrimmed -> plain tpad=LEAD (composite's identity case).
    let lead = WEBCAM_LEAD_MS / 1000.0;
    let pad_lead = (lead - trim_in).max(0.0);
    let wc_skip = (trim_in - lead).max(0.0);
    let zone = resolve_zone(bubble_zone, bubble_position_log);

    Ok(WebcamOverlay {
        input_args,
        n,
        input_base,
        mask_idx,
        shadow_idx,
        target,
        pad_lead,
        wc_skip,
        shadow_sigma,
        shadow_padding,
        shadow_offset_y,
        zone,
    })
}

// V3 (Core Image compositor) bubble assets. Renders the SAME mask + shadow
// silhouette PNGs as build_webcam_overlay's head (diameter, roundness, shadow
// padding all identical) and returns their paths plus the resolved diameter and
// zone, for main.swift to consume via BUBBLE_MASK_PNG / BUBBLE_SHADOW_PNG /
// BUBBLE_DIAMETER / BUBBLE_ZONE. cicompositor recomputes shadow sigma/offset from
// the diameter itself, so only these four values cross the boundary.
pub(crate) struct V3BubbleAssets {
    pub mask_path: PathBuf,
    pub shadow_path: PathBuf,
    pub diameter: u32,
    pub zone: BubbleZone,
}

pub(crate) fn build_v3_bubble_assets(
    out_dir: &Path,
    bubble_zone: Option<BubbleZone>,
    bubble_position_log: &[BubblePositionEntry],
    bubble_roundness: Option<f64>,
    size: WebcamSize,
) -> Result<V3BubbleAssets, String> {
    // Diameter source mirrors build_webcam_overlay exactly.
    let diameter = bubble_position_log
        .first()
        .and_then(|e| e.diameter)
        .map(|d| d.round().max(1.0) as u32)
        .unwrap_or_else(|| size.px());
    let mask_path = out_dir.join(mask_file_name("v3mask", diameter, bubble_roundness));
    render_alpha_mask(diameter, bubble_roundness, &mask_path)?;
    let shadow_padding = ((diameter as f64) * SHADOW_PADDING_FRAC).round() as u32;
    let shadow_path = out_dir.join(mask_file_name("v3shadow", diameter, bubble_roundness));
    render_shadow_source(diameter, shadow_padding, bubble_roundness, &shadow_path)?;
    let zone = resolve_zone(bubble_zone, bubble_position_log);
    Ok(V3BubbleAssets {
        mask_path,
        shadow_path,
        diameter,
        zone,
    })
}

pub fn composite(
    screen_path: &Path,
    webcam_segments: &[PathBuf],
    output_path: &Path,
    size: WebcamSize,
    bubble_zone: Option<BubbleZone>,
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
        bubble_zone,
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
    bubble_zone: Option<BubbleZone>,
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
    // Webcam prep + masked/shadowed overlay at the constant zone, onto the raw
    // screen [0:v]. Shared with the V2 Step 3 zoom+webcam path (which overlays
    // onto the zoomed screen instead) via webcam_overlay_filter — the legacy
    // args pin guarantees this stays byte-identical.
    let zone = resolve_zone(bubble_zone, bubble_position_log);
    let mut filter = webcam_overlay_filter(
        "0:v",
        "outv_pre",
        webcam_segments.len(),
        wc_input_base,
        mask_idx,
        shadow_idx,
        target,
        lead_in,
        shadow_sigma,
        shadow_padding,
        shadow_offset_y,
        zone,
    );

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
        zone: Option<BubbleZone>,
        log: &[BubblePositionEntry],
        roundness: Option<f64>,
    ) -> Vec<String> {
        build_composite_args(
            &dir.join("screen.mp4"),
            &[dir.join("webcam-0.mp4")],
            &dir.join("composite.mp4"),
            WebcamSize::Medium,
            zone,
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
                sidecar.bubble_zone,
                &sidecar.bubble_position_log,
                roundness,
                None,
                |_| {},
            )
            .unwrap();
            println!("rendered {}", out.display());
        }
    }

    // Args pin. The four corners keep the pre-Step-2 CONSTANT-overlay string
    // byte-for-byte, so this pins three things at once:
    //   1. the legacy empty-log default (BottomRight),
    //   2. the V2 Step 2 migration — a non-empty position log no longer bakes
    //      a time-keyed f(t) overlay; it collapses to the nearest-corner zone
    //      (log_2_entries centroid (0.7, 0.675) -> BottomRight), yielding the
    //      SAME string as the empty-log default. (Pre-Step-2 this second case
    //      pinned the now-deleted nested if(lt(t,...)) expression + enable
    //      gate — that was re-baselined here when zoom-export Step 2 landed.)
    //   3. an explicit centered zone (TopCenter), which has no pre-Step-2
    //      analog — pins the new `(main_w-overlay_w)/2` centering geometry.
    // Paths normalized to <TMP>. A failure during styling work means the
    // legacy path regressed; an intentional graph change means re-pin.
    #[test]
    fn legacy_args_pinned() {
        let expected_br = "-y\u{1}-hide_banner\u{1}-nostats\u{1}-progress\u{1}pipe:1\u{1}-i\u{1}<TMP>/screen.mp4\u{1}-itsoffset\u{1}-0.020\u{1}-i\u{1}<TMP>/screen.mp4\u{1}-i\u{1}<TMP>/webcam-0.mp4\u{1}-loop\u{1}1\u{1}-framerate\u{1}30\u{1}-t\u{1}10.000\u{1}-i\u{1}<TMP>/mask-240.png\u{1}-loop\u{1}1\u{1}-framerate\u{1}30\u{1}-t\u{1}10.000\u{1}-i\u{1}<TMP>/shadow-240.png\u{1}-filter_complex\u{1}[2:v]tpad=start_duration=0.105:start_mode=clone[wc_full];[wc_full]hflip,crop='min(iw\\,ih)':'min(iw\\,ih)',scale=240:240,format=yuva420p[wc_rgba];[3:v]format=gray[mask_g];[wc_rgba][mask_g]alphamerge[wc];[4:v]format=rgba,gblur=sigma=18,colorchannelmixer=aa=0.22[shadow];[0:v][shadow]overlay=main_w-324:main_h-316:eof_action=pass[shadowed];[shadowed][wc]overlay=main_w-overlay_w-24:main_h-overlay_h-24:eof_action=pass[outv_pre]\u{1}-map\u{1}[outv_pre]\u{1}-map\u{1}1:a?\u{1}-c:v\u{1}h264_videotoolbox\u{1}-b:v\u{1}8M\u{1}-c:a\u{1}copy\u{1}<TMP>/composite.mp4";
        let expected_tc = "-y\u{1}-hide_banner\u{1}-nostats\u{1}-progress\u{1}pipe:1\u{1}-i\u{1}<TMP>/screen.mp4\u{1}-itsoffset\u{1}-0.020\u{1}-i\u{1}<TMP>/screen.mp4\u{1}-i\u{1}<TMP>/webcam-0.mp4\u{1}-loop\u{1}1\u{1}-framerate\u{1}30\u{1}-t\u{1}10.000\u{1}-i\u{1}<TMP>/mask-240.png\u{1}-loop\u{1}1\u{1}-framerate\u{1}30\u{1}-t\u{1}10.000\u{1}-i\u{1}<TMP>/shadow-240.png\u{1}-filter_complex\u{1}[2:v]tpad=start_duration=0.105:start_mode=clone[wc_full];[wc_full]hflip,crop='min(iw\\,ih)':'min(iw\\,ih)',scale=240:240,format=yuva420p[wc_rgba];[3:v]format=gray[mask_g];[wc_rgba][mask_g]alphamerge[wc];[4:v]format=rgba,gblur=sigma=18,colorchannelmixer=aa=0.22[shadow];[0:v][shadow]overlay=(main_w-240)/2-60:-28:eof_action=pass[shadowed];[shadowed][wc]overlay=(main_w-overlay_w)/2:24:eof_action=pass[outv_pre]\u{1}-map\u{1}[outv_pre]\u{1}-map\u{1}1:a?\u{1}-c:v\u{1}h264_videotoolbox\u{1}-b:v\u{1}8M\u{1}-c:a\u{1}copy\u{1}<TMP>/composite.mp4";
        for (expected, zone, log) in [
            (expected_br, None, vec![]),
            (expected_br, None, log_2_entries()),
            (expected_tc, Some(BubbleZone::TopCenter), vec![]),
        ] {
            let dir = temp_dir("pin");
            let args = build_args_for_test(&dir, zone, &log, None);
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

    // V2 Step 2 migration rule. Review mirrors this in TS (nearestCornerZone);
    // keep the two in sync.
    #[test]
    fn resolve_zone_migration_and_defaults() {
        fn e(x: f64, y: f64) -> BubblePositionEntry {
            BubblePositionEntry { t: 0.0, x, y, diameter: Some(240.0) }
        }
        // Explicit zone always wins, log ignored (mid-edges included).
        assert_eq!(
            resolve_zone(Some(BubbleZone::TopCenter), &[e(0.9, 0.9)]),
            BubbleZone::TopCenter
        );
        // Empty log -> legacy default corner.
        assert_eq!(resolve_zone(None, &[]), BubbleZone::BottomRight);
        // Centroid migrates to the nearest of the FOUR corners only.
        assert_eq!(resolve_zone(None, &[e(0.1, 0.1)]), BubbleZone::TopLeft);
        assert_eq!(resolve_zone(None, &[e(0.9, 0.1)]), BubbleZone::TopRight);
        assert_eq!(resolve_zone(None, &[e(0.1, 0.9)]), BubbleZone::BottomLeft);
        assert_eq!(resolve_zone(None, &[e(0.9, 0.9)]), BubbleZone::BottomRight);
        // Centroid is the mean; the pin's log_2_entries -> (0.7, 0.675) -> BR.
        assert_eq!(
            resolve_zone(None, &[e(0.9, 0.85), e(0.5, 0.5)]),
            BubbleZone::BottomRight
        );
        // Exact-0.5 ties resolve toward right/bottom (BottomRight flavor).
        assert_eq!(resolve_zone(None, &[e(0.5, 0.5)]), BubbleZone::BottomRight);
    }
}
