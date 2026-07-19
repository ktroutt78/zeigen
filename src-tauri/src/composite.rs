use std::path::{Path, PathBuf};

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
    // Fallback diameter as a fraction of frame width, when the sidecar logged no
    // diameter_frac. The px() values were tuned at the 1512-wide built-in, so
    // frac = px / 1512 reproduces them there and scales elsewhere.
    fn frac(self) -> f64 {
        self.px() as f64 / BUBBLE_REF_WIDTH
    }
}

// Reference frame width the bubble diameter/padding constants were tuned at
// (the built-in's logical width). frac = px / this; px = frac * screen_width.
const BUBBLE_REF_WIDTH: f64 = 1512.0;

// Resolve a logged diameter fraction (or the WebcamSize fallback) to pixels for a
// given capture frame width. Shared by the V2 and V3 bubble builders.
fn resolve_diameter_px(
    bubble_position_log: &[BubblePositionEntry],
    size: WebcamSize,
    frame_width: u32,
) -> u32 {
    let frac = bubble_position_log
        .first()
        .and_then(|e| e.diameter_frac)
        .unwrap_or_else(|| size.frac());
    (frac * frame_width as f64).round().max(1.0) as u32
}

#[derive(Clone, Copy)]
pub enum Corner {
    TopLeft,
    TopRight,
    BottomLeft,
    BottomRight,
}

impl Corner {
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
// (Save MP4 / GIF / Copy). By default the logo is scaled to
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
}

// Bubble inset from the frame edge, as a fraction of frame width (was a fixed
// 30px, which shrank to a half-relative inset once capture doubled to backing
// res). 30/1512 reproduces the old inset at the built-in and scales with res.
const PADDING_FRAC: f64 = 30.0 / BUBBLE_REF_WIDTH;

pub(crate) fn resolve_padding_px(frame_width: u32) -> u32 {
    (PADDING_FRAC * frame_width as f64).round() as u32
}

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

// Shadow silhouette padding as a fraction of the bubble diameter (buffer around
// the circle so the downstream gblur has room to fade alpha into transparent
// pixels). cicompositor recomputes sigma/offset/alpha from the diameter itself,
// so only the padding crosses the Rust->Swift boundary now.
const SHADOW_PADDING_FRAC: f64 = 0.25;

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
    frame_width: u32,
) -> Result<V3BubbleAssets, String> {
    // Diameter source mirrors build_webcam_overlay exactly.
    let diameter = resolve_diameter_px(bubble_position_log, size, frame_width);
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

#[cfg(test)]
mod tests {
    use super::*;

    // Watermark::from_args (the surface V3 consumes via WATERMARK_* env):
    // defaults keep legacy semantics; out-of-range values fall back rather than
    // break an export.
    #[test]
    fn watermark_from_args_defaults_and_clamps() {
        let wm = Watermark::from_args(Some("/x.png".into()), Some("tr".into()), None, None)
            .expect("logo set");
        assert!(wm.scale_frac.is_none());
        assert_eq!(wm.opacity, 1.0);
        assert_eq!(wm.corner.code(), "tr");
        let clamped =
            Watermark::from_args(Some("/x.png".into()), None, Some(7.0), Some(3.0)).expect("logo");
        assert!(clamped.scale_frac.is_none(), "scale > 1 rejected");
        assert_eq!(clamped.opacity, 1.0, "opacity clamped to 1");
        // No logo -> no watermark.
        assert!(Watermark::from_args(None, None, None, None).is_none());
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
            BubblePositionEntry { t: 0.0, x, y, diameter_frac: Some(240.0 / 1512.0) }
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
