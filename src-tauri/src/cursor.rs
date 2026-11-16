// The smoothed cursor path: the ONE definition of where the drawn cursor is
// (CURSOR-SMOOTHING-PLAN). Raw 120 Hz telemetry in, a sampled path out; the preview
// and the export both only look it up, exactly like the camera path.
//
// Smoothing is centred in time: each point is a Gaussian-weighted average of where
// the cursor was just before AND just after. A recording is finished before it is
// smoothed, so the future is known and there is no lag to compensate for.
//
// Clicks and drags are pinned: smoothing fades to zero as a click approaches and
// stays zero while the button is held, so the cursor is exactly where the click
// landed and a dragged object stays under it.

use serde::Serialize;

use crate::zoom::CursorTrack;

pub const STEP_S: f64 = 1.0 / 60.0;
// Smoothing fades in over this long either side of a click or drag.
const PIN_RAMP_S: f64 = 0.25;

// samples[i] = [x, y] at t = i * step, as fractions of the frame (top-left
// origin). Values outside 0..1 mean the cursor is outside the recorded area.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct CursorPath {
    pub step: f64,
    pub samples: Vec<[f32; 2]>,
}

// `sigma` is the smoothing width in seconds; 0 = the raw path.
pub fn path(track: &CursorTrack, sigma: f64, duration: f64) -> CursorPath {
    let s = &track.samples;
    let (w, h) = (track.video_size.width, track.video_size.height);
    let count = (duration.max(0.0) / STEP_S).ceil() as usize + 1;
    if s.is_empty() {
        return CursorPath { step: STEP_S, samples: vec![[0.5, 0.5]; count] };
    }

    // Stretches where the cursor must be exact: each press through its release,
    // and each right-click instant.
    let ups: Vec<f64> = track.events.iter().filter(|e| e.kind == "left_up").map(|e| e.t).collect();
    let pins: Vec<(f64, f64)> = track
        .events
        .iter()
        .filter_map(|e| match e.kind.as_str() {
            "left_down" => {
                let up = ups.iter().copied().filter(|u| *u >= e.t).fold(f64::INFINITY, f64::min);
                Some((e.t, if up.is_finite() { up } else { e.t }))
            }
            "right_down" => Some((e.t, e.t)),
            _ => None,
        })
        .collect();

    let raw = |t: f64| -> (f64, f64) {
        let j = s.partition_point(|p| p.t <= t);
        if j == 0 {
            return (s[0].x, s[0].y);
        }
        if j == s.len() {
            return (s[j - 1].x, s[j - 1].y);
        }
        let (a, b) = (&s[j - 1], &s[j]);
        let u = (t - a.t) / (b.t - a.t);
        (a.x + (b.x - a.x) * u, a.y + (b.y - a.y) * u)
    };

    let samples = (0..count)
        .map(|i| {
            let t = i as f64 * STEP_S;
            let to_pin = pins
                .iter()
                .map(|&(a, b)| if t < a { a - t } else if t > b { t - b } else { 0.0 })
                .fold(f64::INFINITY, f64::min);
            let sig = sigma * (to_pin / PIN_RAMP_S).min(1.0);
            let (x, y) = if sig < 1e-4 {
                raw(t)
            } else {
                let lo = s.partition_point(|p| p.t < t - 3.0 * sig);
                let hi = s.partition_point(|p| p.t <= t + 3.0 * sig);
                let (mut sx, mut sy, mut sw) = (0.0, 0.0, 0.0);
                for p in &s[lo..hi] {
                    let wgt = (-0.5 * ((p.t - t) / sig).powi(2)).exp();
                    sx += p.x * wgt;
                    sy += p.y * wgt;
                    sw += wgt;
                }
                if sw > 0.0 { (sx / sw, sy / sw) } else { raw(t) }
            };
            [(x / w) as f32, (y / h) as f32]
        })
        .collect();
    CursorPath { step: STEP_S, samples }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::zoom::{CursorEvent, CursorSample, VideoSize};

    const W: f64 = 1920.0;
    const H: f64 = 1080.0;

    // 120 Hz track: x = f(t), y = g(t) for `secs` seconds.
    fn track(secs: f64, f: impl Fn(f64, usize) -> f64, g: impl Fn(f64, usize) -> f64) -> CursorTrack {
        let n = (secs * 120.0) as usize;
        CursorTrack {
            video_size: VideoSize { width: W, height: H },
            samples: (0..=n)
                .map(|i| {
                    let t = i as f64 / 120.0;
                    CursorSample { t, x: f(t, i), y: g(t, i) }
                })
                .collect(),
            events: Vec::new(),
            cursor_in_video: true,
            points_to_pixels: 1.0,
            shapes: Vec::new(),
            shape_events: Vec::new(),
        }
    }
    fn at(p: &CursorPath, t: f64) -> (f64, f64) {
        let s = p.samples[(t / p.step).round() as usize];
        (s[0] as f64 * W, s[1] as f64 * H)
    }
    fn event(t: f64, kind: &str) -> CursorEvent {
        CursorEvent { t, kind: kind.into(), x: 0.0, y: 0.0 }
    }
    // A hand tremor: +-4px alternating every sample on top of a steady move.
    fn shaky(t: f64, i: usize) -> f64 {
        200.0 + 300.0 * t + if i % 2 == 0 { 4.0 } else { -4.0 }
    }

    #[test]
    fn zero_strength_is_the_raw_path() {
        let tr = track(2.0, shaky, |_, _| 500.0);
        let p = path(&tr, 0.0, 2.0);
        let (x, y) = at(&p, 1.0);
        assert!((x - shaky(1.0, 120)).abs() < 0.01 && (y - 500.0).abs() < 0.01);
    }

    // No lag: a steady move comes out exactly where it went in.
    #[test]
    fn steady_move_is_not_delayed() {
        let tr = track(3.0, |t, _| 200.0 + 400.0 * t, |t, _| 300.0 + 100.0 * t);
        let p = path(&tr, 0.1, 3.0);
        for t in [1.0, 1.5, 2.0] {
            let (x, y) = at(&p, t);
            assert!((x - (200.0 + 400.0 * t)).abs() < 0.05, "x lagged at {t}: {x}");
            assert!((y - (300.0 + 100.0 * t)).abs() < 0.05);
        }
    }

    #[test]
    fn tremor_is_removed() {
        let tr = track(3.0, shaky, |_, _| 500.0);
        let p = path(&tr, 0.1, 3.0);
        for i in 60..120 {
            let t = i as f64 * STEP_S;
            let x = p.samples[i][0] as f64 * W;
            assert!((x - (200.0 + 300.0 * t)).abs() < 0.3, "tremor left at {t}: {x}");
        }
    }

    #[test]
    fn click_lands_exactly_where_it_happened() {
        let mut tr = track(3.0, shaky, |_, _| 500.0);
        tr.events.push(event(1.5, "left_down"));
        tr.events.push(event(1.55, "left_up"));
        let p = path(&tr, 0.1, 3.0);
        let (x, _) = at(&p, 1.5);
        assert!((x - shaky(1.5, 180)).abs() < 0.01, "click must be pinned, got {x}");
        // Smoothing is back to full strength well away from the click.
        let (far, _) = at(&p, 2.5);
        assert!((far - (200.0 + 300.0 * 2.5)).abs() < 0.3);
    }

    #[test]
    fn drag_is_exact_for_its_whole_length() {
        let mut tr = track(3.0, shaky, |_, _| 500.0);
        tr.events.push(event(1.0, "left_down"));
        tr.events.push(event(2.0, "left_up"));
        let p = path(&tr, 0.1, 3.0);
        for i in 60..=120 {
            let t = i as f64 * STEP_S;
            let x = p.samples[i][0] as f64 * W;
            // The raw path between two 120 Hz samples: within the +-4px tremor band.
            assert!((x - (200.0 + 300.0 * t)).abs() <= 4.01 && (x - (200.0 + 300.0 * t)).abs() > 3.9,
                "drag must keep the raw position at {t}: {x}");
        }
    }

    #[test]
    fn empty_track_is_centred() {
        let tr = CursorTrack { video_size: VideoSize { width: W, height: H }, samples: vec![], events: vec![],
            cursor_in_video: true, points_to_pixels: 1.0, shapes: vec![], shape_events: vec![] };
        assert_eq!(path(&tr, 0.1, 1.0).samples.len(), 61);
    }
}
