// Zoom suggestion detection (ZOOM-LAYER-PLAN step 5). Pure function from a
// .cursor.json telemetry track to auto_generated ZoomKeyframes implementing
// the V3-PLAN C.1 heuristic: dwell and click zoom in, travel separates,
// scroll holds, calm rules bound everything. Runs only from the review's
// "Suggest zooms" button — never at review-open — and only ever proposes;
// the UI replaces auto_generated segments and never touches manual ones.
//
// Emitted keyframes use the exact canonical run shape Review.tsx's
// zoomSegmentsToKeyframes writes (scale-1 edges, 600ms ramps, one shared
// center), so zoomKeyframesToSegments round-trips them into clean lane
// segments.

use std::path::{Path, PathBuf};

use serde::Deserialize;

use crate::edit::{Ease, ZoomKeyframe};

// ---- Tuning surface ----------------------------------------------------
// Every threshold the heuristic uses, in one place. The real-recording
// snapshot test below prints and pins detector output; retune by editing
// these and reading the new pin off the test failure.

// C.1 dwell: cursor stays within a small region for >800ms. Implemented as
// a maximal sample run whose bounding-box diagonal stays under the radius.
const DWELL_RADIUS_PX: f64 = 150.0;
const DWELL_MIN_S: f64 = 0.8;

// Parked-cursor guard. A dwell with no click whose bounding box is
// essentially a point is an abandoned mouse, not attention — no zoom. And
// after the last sign of life (click or >JITTER_STEP_PX movement) a zoom
// holds only PARK_TAIL_S before letting go, so a click followed by minutes
// of parked cursor doesn't pin the zoom forever.
const PARKED_BBOX_PX: f64 = 8.0;
const JITTER_STEP_PX: f64 = 5.0;
const PARK_TAIL_S: f64 = 2.0;

// C.1 click: strong zoom-in signal. Window opens before the click so the
// 600ms ramp is done by the moment of the click.
const CLICK_LEAD_S: f64 = 1.0;
const CLICK_TAIL_S: f64 = 2.0;

// C.1 calm rule: minimum 1.2s between zoom changes. Candidates closer than
// this either merge (centers near — one wider zoom) or the weaker one is
// dropped (centers far — stay wide when in doubt).
const MERGE_GAP_S: f64 = 1.2;
const CENTER_MERGE_PX: f64 = 300.0;

// C.1 scroll: reading — hold the current zoom, never pan with the scroll.
// A scroll run near a segment's end extends the hold.
const SCROLL_NEAR_S: f64 = 1.2;
const SCROLL_TAIL_S: f64 = 1.5;

// Shape of the output. Fixed 2.0x (under the 2.5x C.1 cap) with the same
// 600ms in_out_cubic ramps as manual zooms; segments shorter than
// MIN_ZOOM_S after trimming are too twitchy to keep.
const MIN_ZOOM_S: f64 = 2.0;
const SUGGESTED_SCALE: f64 = 2.0;
const RAMP_S: f64 = 0.6;

// ---- Telemetry parsing -------------------------------------------------

#[derive(Deserialize)]
pub struct CursorTrack {
    pub video_size: VideoSize,
    pub samples: Vec<CursorSample>,
    #[serde(default)]
    pub events: Vec<CursorEvent>,
}

#[derive(Deserialize)]
pub struct VideoSize {
    pub width: f64,
    pub height: f64,
}

#[derive(Deserialize)]
pub struct CursorSample {
    pub t: f64,
    pub x: f64,
    pub y: f64,
}

#[derive(Deserialize)]
pub struct CursorEvent {
    pub t: f64,
    pub kind: String,
    pub x: f64,
    pub y: f64,
}

// Telemetry sidecar location for a review source path. The engine writes
// `.<stem>.cursor.json` next to its output mp4 — which is sources/screen.mp4
// for webcam recordings and the source itself for screen-only ones — so
// reuse the exact raw-screen resolution the export pipeline uses.
pub fn cursor_track_path(source: &Path) -> PathBuf {
    let (screen, _) = crate::edit::export_inputs_from_source(source);
    let stem = screen.file_stem().unwrap_or_default();
    let mut name = std::ffi::OsString::from(".");
    name.push(stem);
    name.push(".cursor.json");
    screen.with_file_name(name)
}

// ---- Detection ---------------------------------------------------------

// One proposed zoom window before keyframe emission.
#[derive(Clone, Debug)]
struct Candidate {
    start: f64,
    end: f64,
    cx: f64,
    cy: f64,
    clicks: u32,
}

fn dist(ax: f64, ay: f64, bx: f64, by: f64) -> f64 {
    ((ax - bx).powi(2) + (ay - by).powi(2)).sqrt()
}

pub fn detect(track: &CursorTrack) -> Vec<ZoomKeyframe> {
    let samples = &track.samples;
    if samples.is_empty() {
        return Vec::new();
    }
    let track_end = samples.last().unwrap().t;
    let clicks: Vec<&CursorEvent> = track
        .events
        .iter()
        .filter(|e| e.kind == "left_down" || e.kind == "right_down")
        .collect();
    let scrolls: Vec<&CursorEvent> =
        track.events.iter().filter(|e| e.kind == "scroll").collect();

    let mut candidates: Vec<Candidate> = Vec::new();

    // Dwell runs: greedy maximal runs whose bbox diagonal stays under
    // DWELL_RADIUS_PX. Travel never dwells (bbox overflows immediately),
    // so travel separates candidates by construction.
    let mut i = 0;
    while i < samples.len() {
        let (mut minx, mut maxx) = (samples[i].x, samples[i].x);
        let (mut miny, mut maxy) = (samples[i].y, samples[i].y);
        let mut j = i;
        while j + 1 < samples.len() {
            let s = &samples[j + 1];
            let nminx = minx.min(s.x);
            let nmaxx = maxx.max(s.x);
            let nminy = miny.min(s.y);
            let nmaxy = maxy.max(s.y);
            if dist(nminx, nminy, nmaxx, nmaxy) > DWELL_RADIUS_PX {
                break;
            }
            (minx, maxx, miny, maxy) = (nminx, nmaxx, nminy, nmaxy);
            j += 1;
        }
        let (t0, t1) = (samples[i].t, samples[j].t);
        if t1 - t0 >= DWELL_MIN_S {
            let in_dwell: Vec<&&CursorEvent> =
                clicks.iter().filter(|c| c.t >= t0 && c.t <= t1).collect();
            let parked =
                in_dwell.is_empty() && dist(minx, miny, maxx, maxy) < PARKED_BBOX_PX;
            if !parked {
                // Signs of life inside the dwell: clicks, or movement
                // beyond jitter from the last resting position. The zoom
                // window hugs [first, last] activity — a cursor parked for
                // a stretch before or after doesn't drag the zoom with it.
                let mut first_act: Option<f64> = None;
                let mut last_act = t0;
                let (mut rx, mut ry) = (samples[i].x, samples[i].y);
                for s in &samples[i..=j] {
                    if dist(s.x, s.y, rx, ry) > JITTER_STEP_PX {
                        first_act.get_or_insert(s.t);
                        last_act = s.t;
                        (rx, ry) = (s.x, s.y);
                    }
                }
                for c in &in_dwell {
                    first_act = Some(first_act.unwrap_or(c.t).min(c.t));
                    last_act = last_act.max(c.t);
                }
                let start = t0.max(first_act.unwrap_or(t0) - CLICK_LEAD_S);
                let end = t1.min(last_act + PARK_TAIL_S);
                if end - start >= DWELL_MIN_S {
                    // Attention centers on the clicks when there are any,
                    // else on where the cursor actually sat. Median, not
                    // mean: the run's edges include the entry/exit travel
                    // tails that fit inside the bbox, and a mean drags the
                    // center toward them.
                    let (cx, cy) = if in_dwell.is_empty() {
                        let median = |mut v: Vec<f64>| {
                            v.sort_by(f64::total_cmp);
                            v[v.len() / 2]
                        };
                        let run = &samples[i..=j];
                        (
                            median(run.iter().map(|s| s.x).collect()),
                            median(run.iter().map(|s| s.y).collect()),
                        )
                    } else {
                        let n = in_dwell.len() as f64;
                        (
                            in_dwell.iter().map(|c| c.x).sum::<f64>() / n,
                            in_dwell.iter().map(|c| c.y).sum::<f64>() / n,
                        )
                    };
                    candidates.push(Candidate {
                        start,
                        end,
                        cx,
                        cy,
                        clicks: in_dwell.len() as u32,
                    });
                }
            }
        }
        i = j + 1;
    }

    // Click windows. Clicks inside dwells produce a second overlapping
    // candidate; the merge pass folds them together.
    for c in &clicks {
        candidates.push(Candidate {
            start: (c.t - CLICK_LEAD_S).max(0.0),
            end: (c.t + CLICK_TAIL_S).min(track_end),
            cx: c.x,
            cy: c.y,
            clicks: 1,
        });
    }

    candidates.sort_by(|a, b| a.start.total_cmp(&b.start));

    // Calm pass: anything closer than MERGE_GAP_S merges when the centers
    // are near enough to share one 2x window. Far-apart neighbors (a demo
    // hopping between click stops) instead shorten the earlier zoom to
    // restore the calm gap; only when nothing usable would remain does the
    // weaker candidate get dropped — a wrong zoom is worse than a missed
    // one.
    let mut merged: Vec<Candidate> = Vec::new();
    for c in candidates {
        let Some(last) = merged.last_mut() else {
            merged.push(c);
            continue;
        };
        if c.start >= last.end + MERGE_GAP_S {
            merged.push(c);
        } else if dist(last.cx, last.cy, c.cx, c.cy) <= CENTER_MERGE_PX {
            let (w1, w2) = ((1 + last.clicks) as f64, (1 + c.clicks) as f64);
            last.cx = (last.cx * w1 + c.cx * w2) / (w1 + w2);
            last.cy = (last.cy * w1 + c.cy * w2) / (w1 + w2);
            last.end = last.end.max(c.end);
            last.clicks += c.clicks;
        } else if c.start - MERGE_GAP_S - last.start >= MIN_ZOOM_S {
            last.end = last.end.min(c.start - MERGE_GAP_S);
            merged.push(c);
        } else if (c.clicks, c.end - c.start) > (last.clicks, last.end - last.start) {
            *last = c;
        }
    }

    // Scroll holds: a scroll run at a segment's edge means reading — keep
    // the zoom up through it (plus a tail), but never into the next
    // segment's calm gap.
    for k in 0..merged.len() {
        loop {
            let end = merged[k].end;
            let hit = scrolls
                .iter()
                .find(|s| s.t >= end - 0.2 && s.t <= end + SCROLL_NEAR_S);
            match hit {
                Some(s) => merged[k].end = end.max(s.t + SCROLL_TAIL_S),
                None => break,
            }
        }
        merged[k].end = merged[k].end.min(track_end);
        if k + 1 < merged.len() {
            merged[k].end = merged[k].end.min(merged[k + 1].start - MERGE_GAP_S);
        }
    }

    // Final shape: drop twitchy shorts, clamp centers so the 2x window
    // stays inside the frame, emit the canonical keyframe run.
    let (w, h) = (track.video_size.width, track.video_size.height);
    let (half_w, half_h) = (w / (2.0 * SUGGESTED_SCALE), h / (2.0 * SUGGESTED_SCALE));
    let mut kfs: Vec<ZoomKeyframe> = Vec::new();
    for c in merged {
        if c.end - c.start < MIN_ZOOM_S {
            continue;
        }
        let cx = c.cx.clamp(half_w, w - half_w);
        let cy = c.cy.clamp(half_h, h - half_h);
        let kf = |t: f64, scale: f64| ZoomKeyframe {
            t,
            scale,
            center_x: cx,
            center_y: cy,
            ease: Ease::InOutCubic,
            auto_generated: true,
        };
        let dur = c.end - c.start;
        let ramp = RAMP_S.min(dur / 2.0);
        kfs.push(kf(c.start, 1.0));
        if dur > 2.0 * ramp {
            kfs.push(kf(c.start + ramp, SUGGESTED_SCALE));
            kfs.push(kf(c.end - ramp, SUGGESTED_SCALE));
        } else {
            kfs.push(kf(c.start + dur / 2.0, SUGGESTED_SCALE));
        }
        kfs.push(kf(c.end, 1.0));
    }
    kfs
}

// Ok(None) = this recording has no telemetry (recorded before step 1) —
// the review shows a notice instead of an error.
#[tauri::command]
pub fn suggest_zooms(source_path: String) -> Result<Option<Vec<ZoomKeyframe>>, String> {
    let p = cursor_track_path(Path::new(&source_path));
    if !p.exists() {
        return Ok(None);
    }
    let data =
        std::fs::read_to_string(&p).map_err(|e| format!("read {}: {e}", p.display()))?;
    let track: CursorTrack =
        serde_json::from_str(&data).map_err(|e| format!("parse {}: {e}", p.display()))?;
    Ok(Some(detect(&track)))
}

#[cfg(test)]
mod tests {
    use super::*;

    // 120 Hz synthetic track builder for rule-level tests.
    struct TrackBuilder {
        track: CursorTrack,
        t: f64,
        x: f64,
        y: f64,
    }

    impl TrackBuilder {
        fn new() -> Self {
            TrackBuilder {
                track: CursorTrack {
                    video_size: VideoSize { width: 1470.0, height: 956.0 },
                    samples: Vec::new(),
                    events: Vec::new(),
                },
                t: 0.0,
                x: 700.0,
                y: 500.0,
            }
        }

        // Hold (exactly still) at the current position for `secs`.
        fn park(mut self, secs: f64) -> Self {
            let end = self.t + secs;
            while self.t < end {
                self.track.samples.push(CursorSample { t: self.t, x: self.x, y: self.y });
                self.t += 1.0 / 120.0;
            }
            self
        }

        // Dwell with hand-on-mouse jitter (~10px wander) for `secs`.
        fn dwell(mut self, secs: f64) -> Self {
            let end = self.t + secs;
            let mut k = 0u32;
            while self.t < end {
                let dx = ((k % 7) as f64 - 3.0) * 3.0;
                let dy = ((k % 5) as f64 - 2.0) * 3.0;
                self.track.samples.push(CursorSample {
                    t: self.t,
                    x: self.x + dx,
                    y: self.y + dy,
                });
                self.t += 1.0 / 120.0;
                k += 1;
            }
            self
        }

        // Straight-line travel to (x, y) over `secs`.
        fn travel(mut self, x: f64, y: f64, secs: f64) -> Self {
            let (x0, y0, t0) = (self.x, self.y, self.t);
            let end = t0 + secs;
            while self.t < end {
                let u = (self.t - t0) / secs;
                self.track.samples.push(CursorSample {
                    t: self.t,
                    x: x0 + (x - x0) * u,
                    y: y0 + (y - y0) * u,
                });
                self.t += 1.0 / 120.0;
            }
            (self.x, self.y) = (x, y);
            self
        }

        fn click(mut self) -> Self {
            self.track.events.push(CursorEvent {
                t: self.t,
                kind: "left_down".into(),
                x: self.x,
                y: self.y,
            });
            self
        }

        // Scroll events every 0.5s (cursor still) for `secs`.
        fn scroll_run(mut self, secs: f64) -> Self {
            let end = self.t + secs;
            while self.t < end {
                self.track.events.push(CursorEvent {
                    t: self.t,
                    kind: "scroll".into(),
                    x: self.x,
                    y: self.y,
                });
                self = self.park(0.5);
            }
            self
        }

        fn build(self) -> CursorTrack {
            self.track
        }
    }

    // Segments reconstructed from the canonical keyframe run — mirrors
    // Review.tsx zoomKeyframesToSegments for assertion readability.
    fn segments(kfs: &[ZoomKeyframe]) -> Vec<(f64, f64, f64, f64)> {
        let mut out = Vec::new();
        let mut i = 0;
        while i < kfs.len() {
            if kfs[i].scale <= 1.001 {
                i += 1;
                continue;
            }
            let mut j = i;
            while j < kfs.len() && kfs[j].scale > 1.001 {
                j += 1;
            }
            out.push((kfs[i - 1].t, kfs[j].t, kfs[i].center_x, kfs[i].center_y));
            i = j;
        }
        out
    }

    fn fmt_segments(kfs: &[ZoomKeyframe]) -> String {
        segments(kfs)
            .iter()
            .map(|(s, e, x, y)| format!("{s:.2}-{e:.2}s @({x:.0},{y:.0})"))
            .collect::<Vec<_>>()
            .join("; ")
    }

    // Pin of what detection produces on a real recording (the 16s
    // 2026-07-13-091633 demo-style capture: six click stops, no scrolls).
    // This is the tuning loop: change a threshold above, run
    // `cargo test real_recording -- --nocapture`, read the new output off
    // the assertion diff, judge it in the review lane, re-pin.
    #[test]
    fn real_recording_pinned_suggestions() {
        let track: CursorTrack = serde_json::from_str(include_str!(
            "../tests/fixtures/cursor-2026-07-13-091633.json"
        ))
        .unwrap();
        let kfs = detect(&track);
        let got = fmt_segments(&kfs);
        println!("real-recording suggestions: {got}");
        for w in segments(&kfs).windows(2) {
            assert!(
                w[1].0 - w[0].1 >= MERGE_GAP_S - 1e-9,
                "calm rule: {:.2}s gap between {:?} and {:?}",
                w[1].0 - w[0].1,
                w[0],
                w[1]
            );
        }
        assert_eq!(
            got,
            "1.05-3.28s @(368,435); 4.48-6.52s @(823,666); 7.72-9.87s @(368,717); 12.49-16.21s @(1102,717)"
        );
    }

    // Fixture #2: the ~162s demo recording from the 2026-07-13 owner
    // judging pass (DECISIONS.md tuning spec). Unlike fixture #1 it has
    // drags and 46 scroll events — the two behaviors the six-fix tuning
    // session changes most. Its 28 suggestions scored 24/28 keep-worthy;
    // the tuning session re-pins both fixtures and should show FEWER,
    // calmer segments here (the two narration/scroll dwells and the two
    // transient-click zooms gone, the drag triple bridged).
    #[test]
    fn real_recording_2_pinned_suggestions() {
        let track: CursorTrack = serde_json::from_str(include_str!(
            "../tests/fixtures/cursor-2026-07-13-105816.json"
        ))
        .unwrap();
        let kfs = detect(&track);
        let got = fmt_segments(&kfs);
        println!("real-recording-2 suggestions: {got}");
        for w in segments(&kfs).windows(2) {
            assert!(
                w[1].0 - w[0].1 >= MERGE_GAP_S - 1e-9,
                "calm rule: {:.2}s gap between {:?} and {:?}",
                w[1].0 - w[0].1,
                w[0],
                w[1]
            );
        }
        assert_eq!(
            got,
            "7.88-10.25s @(480,270); 11.45-13.81s @(1274,661); 15.01-21.46s @(933,663); 22.66-26.08s @(480,270); 29.26-32.63s @(480,270); 35.44-37.49s @(480,273); 40.32-43.85s @(480,335); 45.05-48.89s @(480,810); 50.09-59.64s @(558,351); 60.84-63.62s @(480,810); 64.82-68.06s @(480,281); 70.55-74.92s @(480,655); 76.12-78.47s @(1440,810); 79.67-82.85s @(480,270); 85.12-87.16s @(480,465); 88.36-94.24s @(901,703); 95.44-104.09s @(480,731); 106.04-108.29s @(480,345); 110.16-113.19s @(480,482); 114.97-120.60s @(1099,693); 121.80-123.96s @(480,304); 126.24-129.10s @(561,332); 130.30-132.46s @(480,270); 135.64-138.64s @(717,302); 140.30-142.72s @(611,412); 143.92-147.96s @(1356,432); 149.16-154.21s @(480,796); 155.41-161.81s @(1179,294)"
        );
    }

    #[test]
    fn canonical_keyframe_shape() {
        let track = TrackBuilder::new().travel(400.0, 400.0, 1.0).dwell(3.0).click().park(1.0).build();
        let kfs = detect(&track);
        assert!(!kfs.is_empty());
        assert!((kfs.first().unwrap().scale - 1.0).abs() < 1e-9);
        assert!((kfs.last().unwrap().scale - 1.0).abs() < 1e-9);
        for kf in &kfs {
            assert!(kf.auto_generated);
            assert_eq!(kf.ease, Ease::InOutCubic);
            assert!(kf.scale <= 2.5);
        }
    }

    #[test]
    fn parked_cursor_dwell_is_rejected() {
        let track = TrackBuilder::new().park(10.0).build();
        assert_eq!(detect(&track).len(), 0, "abandoned mouse must not zoom");
    }

    #[test]
    fn parked_cursor_with_click_zooms() {
        let track = TrackBuilder::new().park(5.0).click().park(5.0).build();
        let kfs = detect(&track);
        let segs = segments(&kfs);
        assert_eq!(segs.len(), 1, "a click is attention even when parked");
        // Zoom covers the click at t=5 and lets go PARK_TAIL_S after it,
        // not at track end.
        assert!(segs[0].0 <= 5.0 && segs[0].1 >= 5.0);
        assert!(segs[0].1 < 9.0, "trailing park must trim the hold, got {:?}", segs[0]);
    }

    #[test]
    fn active_dwell_zooms_without_clicks() {
        let track = TrackBuilder::new()
            .travel(500.0, 400.0, 1.0)
            .dwell(4.0)
            .travel(1200.0, 800.0, 1.0)
            .park(0.5)
            .build();
        let segs = segments(&detect(&track));
        assert_eq!(segs.len(), 1, "{segs:?}");
        assert!(dist(segs[0].2, segs[0].3, 500.0, 400.0) < 60.0, "{segs:?}");
    }

    #[test]
    fn trailing_park_trims_dwell_hold() {
        let track = TrackBuilder::new()
            .travel(300.0, 300.0, 1.0)
            .dwell(3.0)
            .park(20.0)
            .build();
        let segs = segments(&detect(&track));
        assert_eq!(segs.len(), 1);
        assert!(
            segs[0].1 < 8.0,
            "hold must end ~PARK_TAIL_S after activity stops, got {:?}",
            segs[0]
        );
    }

    #[test]
    fn nearby_quick_candidates_merge() {
        let track = TrackBuilder::new()
            .travel(400.0, 400.0, 1.0)
            .click()
            .park(0.8)
            .travel(480.0, 430.0, 0.3)
            .click()
            .park(2.0)
            .build();
        let segs = segments(&detect(&track));
        assert_eq!(segs.len(), 1, "two close clicks inside the calm gap = one zoom");
    }

    #[test]
    fn distant_quick_candidates_do_not_merge_centers() {
        let track = TrackBuilder::new()
            .travel(200.0, 200.0, 1.0)
            .click()
            .park(0.4)
            .travel(1300.0, 850.0, 0.3)
            .click()
            .park(2.0)
            .build();
        let segs = segments(&detect(&track));
        // Under the calm gap with far-apart centers one candidate is
        // dropped — never a smeared midpoint center.
        assert_eq!(segs.len(), 1);
        let near_a = dist(segs[0].2, segs[0].3, 200.0, 200.0) < CENTER_MERGE_PX;
        let near_b = dist(segs[0].2, segs[0].3, 1300.0, 850.0) < CENTER_MERGE_PX;
        assert!(near_a || near_b, "center must stay on one target, got {:?}", segs[0]);
    }

    #[test]
    fn scroll_extends_hold() {
        let with_scroll = TrackBuilder::new()
            .travel(700.0, 480.0, 1.0)
            .click()
            .park(1.5)
            .scroll_run(3.0)
            .park(4.0)
            .build();
        let without = TrackBuilder::new()
            .travel(700.0, 480.0, 1.0)
            .click()
            .park(1.5)
            .park(3.0)
            .park(4.0)
            .build();
        let end_with = segments(&detect(&with_scroll))[0].1;
        let end_without = segments(&detect(&without))[0].1;
        assert!(
            end_with > end_without + 1.0,
            "scroll run must hold the zoom: {end_with:.2} vs {end_without:.2}"
        );
    }

    #[test]
    fn centers_clamp_to_frame_at_scale() {
        let track = TrackBuilder::new()
            .travel(20.0, 20.0, 1.0)
            .click()
            .park(3.0)
            .build();
        let kfs = detect(&track);
        assert!(!kfs.is_empty());
        // 2x window on 1470x956: cx in [367.5, 1102.5], cy in [239, 717].
        for kf in &kfs {
            assert!(kf.center_x >= 367.5 - 1e-9 && kf.center_y >= 239.0 - 1e-9);
        }
    }

    #[test]
    fn cursor_track_path_resolves_both_layouts() {
        let dir = std::env::temp_dir().join(format!("zeigen-zoom-path-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        // Screen-only: no sources/, track sits next to the source itself.
        std::fs::create_dir_all(&dir).unwrap();
        let source = dir.join("recording-x.mp4");
        std::fs::write(&source, b"").unwrap();
        assert_eq!(cursor_track_path(&source), dir.join(".recording-x.cursor.json"));
        // Webcam: engine output is sources/screen.mp4.
        std::fs::create_dir_all(dir.join("sources")).unwrap();
        std::fs::write(dir.join("sources/screen.mp4"), b"").unwrap();
        assert_eq!(
            cursor_track_path(&source),
            dir.join("sources/.screen.cursor.json")
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
