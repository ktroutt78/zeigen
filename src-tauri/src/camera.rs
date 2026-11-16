// The camera path: the ONE definition of zoom motion (ZOOM-POLISH-PLAN problem 1).
// Zoom segments in, a sampled path of (scale, centre) out. The preview and the
// export both only look this path up — neither contains any easing maths, so they
// cannot drift apart.
//
// Motion model: the scale and the focus each chase a step target with a critically
// damped spring (settles without bouncing). A segment sets the target at its start
// and releases it early enough to be back at wide by its end. Retargeting keeps the
// current speed, so interrupted and back-to-back moves need no special cases.
//
// Segments closer than JOIN_GAP_S are joined: the camera holds its zoom across the
// gap and pans to the next target instead of zooming out and back in.
//
// The focus is stored in "travel space": 0 = the crop window flush left/top, 1 =
// flush right/bottom. Any focus in 0..1 keeps the window inside the frame at every
// scale, so nothing is clamped after the fact (the old clamp made the centre stop
// dead mid-zoom). While the camera is at wide the focus is irrelevant, so it jumps
// straight to the next target there and a zoom-in heads for its target from the
// first frame.
//
// Re-aim (owner decision 2026-11-15): this is NOT continuous cursor follow. While
// zoomed the camera holds still until the cursor leaves a box inside the view,
// then glides ONCE to where the cursor is heading and holds again.

use serde::Serialize;

// One zoom window: full `scale` centred on (cx, cy) source px between start and end.
#[derive(Clone, Copy, Debug)]
pub struct Zoom {
    pub start: f64,
    pub end: f64,
    pub scale: f64,
    pub cx: f64,
    pub cy: f64,
}

// Path sample spacing. The springs are evaluated in closed form, so this only
// sets lookup resolution, not accuracy.
pub const STEP_S: f64 = 1.0 / 60.0;
// Spring speed (rad/s). Tuned to the measured Cap move: half done at ~0.2s, 90% at
// ~0.4s, no overshoot (docs/ZOOM-POLISH-PLAN.md, measurement table).
const OMEGA: f64 = 9.5;
// A segment releases its zoom this long before its end, so the camera is back at
// wide (within 1%) by the end and the timeline band keeps its meaning.
pub const SETTLE_S: f64 = 0.7;
// Segments closer than this are joined by a pan (owner decision 2026-11-15).
pub const JOIN_GAP_S: f64 = 2.5;
// At or below this scale the camera counts as wide and the focus may jump.
const WIDE_SCALE: f64 = 1.0005;
// Re-aim box: this fraction of the zoomed view, centred in it. The cursor may
// wander anywhere inside without moving the camera.
const REAIM_BOX: f64 = 0.7;
// The glide starts this long before the cursor crosses the box edge (the whole
// recording is known), so the cursor does not slip out of view while it catches up.
const REAIM_LEAD_S: f64 = 0.2;

// samples[i] = [scale, centre_x, centre_y] at t = i * step. Centre is the crop
// window's centre as a fraction of the frame, top-left origin; the window is
// 1/scale of the frame and always inside it.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct CameraPath {
    pub step: f64,
    pub samples: Vec<[f32; 3]>,
}

// Critically damped spring, closed form from the last retarget.
#[derive(Clone, Copy)]
struct Spring {
    x0: f64,
    v0: f64,
    target: f64,
    t0: f64,
}

impl Spring {
    fn at_rest(x: f64) -> Self {
        Spring { x0: x, v0: 0.0, target: x, t0: 0.0 }
    }
    fn at(&self, t: f64) -> (f64, f64) {
        let dt = t - self.t0;
        let a = self.x0 - self.target;
        let b = self.v0 + OMEGA * a;
        let e = (-OMEGA * dt).exp();
        (self.target + (a + b * dt) * e, (b - OMEGA * (a + b * dt)) * e)
    }
    fn retarget(&mut self, t: f64, target: f64) {
        let (x, v) = self.at(t);
        *self = Spring { x0: x, v0: v, target, t0: t };
    }
    fn jump(&mut self, t: f64, x: f64) {
        *self = Spring { x0: x, v0: 0.0, target: x, t0: t };
    }
}

// Travel-space focus that puts the full-scale window on (cx, cy), as near as the
// frame allows.
fn focus(z: &Zoom, w: f64, h: f64) -> (f64, f64) {
    let half = 1.0 / (2.0 * z.scale);
    let travel = 1.0 - 2.0 * half;
    let axis = |c: f64| {
        if travel <= 1e-9 {
            0.5
        } else {
            (c.clamp(half, 1.0 - half) - half) / travel
        }
    };
    (axis(z.cx / w), axis(z.cy / h))
}

// Re-aim targets for one zoom over [from, until): (time, x, y) in source px. The
// camera's aim starts at the zoom's own centre. When the cursor leaves the box
// around the current aim, the new aim is the average of where the cursor goes next
// (its positions from there on, for as long as they fit in one box), so one glide
// lands on the next place it settles. Cursor positions outside the frame are
// ignored: the camera never chases a cursor that left the recording.
fn reaims(z: &Zoom, from: f64, until: f64, cursor: &[(f64, f64, f64)], w: f64, h: f64) -> Vec<(f64, f64, f64)> {
    let (bw, bh) = (REAIM_BOX * w / z.scale, REAIM_BOX * h / z.scale);
    let (half_w, half_h) = (w / (2.0 * z.scale), h / (2.0 * z.scale));
    // The window centre the camera actually reaches for an aim (frame-clamped).
    let reach = |x: f64, y: f64| (x.clamp(half_w, w - half_w), y.clamp(half_h, h - half_h));
    let inside = |p: &(f64, f64, f64)| p.1 >= 0.0 && p.1 <= w && p.2 >= 0.0 && p.2 <= h;
    let pts: Vec<&(f64, f64, f64)> =
        cursor.iter().filter(|p| p.0 >= from && p.0 < until && inside(p)).collect();
    let mut aim = reach(z.cx, z.cy);
    let mut out = Vec::new();
    let mut last_t = from;
    let mut i = 0;
    while i < pts.len() {
        let p = pts[i];
        if (p.1 - aim.0).abs() <= bw / 2.0 && (p.2 - aim.1).abs() <= bh / 2.0 {
            i += 1;
            continue;
        }
        // Left the box: gather the run of positions from here that fit in one box.
        let (mut minx, mut maxx, mut miny, mut maxy) = (p.1, p.1, p.2, p.2);
        let mut j = i + 1;
        while j < pts.len() {
            let q = pts[j];
            let (nx0, nx1, ny0, ny1) = (minx.min(q.1), maxx.max(q.1), miny.min(q.2), maxy.max(q.2));
            if nx1 - nx0 > bw || ny1 - ny0 > bh {
                break;
            }
            (minx, maxx, miny, maxy) = (nx0, nx1, ny0, ny1);
            j += 1;
        }
        // Average over time, not the middle of the run: the run starts mid-travel,
        // and the camera should land where the cursor comes to rest.
        let n = (j - i) as f64;
        let next = reach(
            pts[i..j].iter().map(|q| q.1).sum::<f64>() / n,
            pts[i..j].iter().map(|q| q.2).sum::<f64>() / n,
        );
        // Pinned against the frame edge the camera cannot get closer: no move.
        if (next.0 - aim.0).abs() > 1.0 || (next.1 - aim.1).abs() > 1.0 {
            let t = (p.0 - REAIM_LEAD_S).max(last_t);
            out.push((t, next.0, next.1));
            last_t = t;
            aim = next;
        }
        i = j;
    }
    out
}

// `cursor` = (t, x, y) samples in source px, time-ordered; empty = no re-aiming.
pub fn path(zooms: &[Zoom], cursor: &[(f64, f64, f64)], w: f64, h: f64, duration: f64) -> CameraPath {
    let mut zooms: Vec<Zoom> = zooms.iter().copied().filter(|z| z.scale > 1.001).collect();
    zooms.sort_by(|a, b| a.start.total_cmp(&b.start));

    // Target changes in time order: Some(zoom) = go to it, None = back to wide.
    let mut events: Vec<(f64, Option<Zoom>)> = Vec::new();
    for (i, z) in zooms.iter().enumerate() {
        events.push((z.start, Some(*z)));
        let next = zooms.get(i + 1).filter(|n| n.start - z.end <= JOIN_GAP_S);
        let release = (z.end - SETTLE_S).max((z.start + z.end) / 2.0);
        // Zoomed until the release, or straight through to a joined next zoom.
        let until = next.map_or(release, |n| n.start);
        for (t, x, y) in reaims(z, z.start, until, cursor, w, h) {
            events.push((t, Some(Zoom { cx: x, cy: y, ..*z })));
        }
        if next.is_none() {
            events.push((release, None));
        }
    }

    let (mut s, mut ux, mut uy) = (Spring::at_rest(1.0), Spring::at_rest(0.5), Spring::at_rest(0.5));
    let mut next = 0;
    let count = (duration.max(0.0) / STEP_S).ceil() as usize + 1;
    let mut samples = Vec::with_capacity(count);
    for i in 0..count {
        let t = i as f64 * STEP_S;
        while next < events.len() && events[next].0 <= t {
            let (te, target) = events[next];
            next += 1;
            match target {
                Some(z) => {
                    let (fx, fy) = focus(&z, w, h);
                    if s.at(te).0 <= WIDE_SCALE {
                        ux.jump(te, fx);
                        uy.jump(te, fy);
                    } else {
                        ux.retarget(te, fx);
                        uy.retarget(te, fy);
                    }
                    s.retarget(te, z.scale);
                }
                // Zoom out anchored where it was: the focus keeps its target.
                None => s.retarget(te, 1.0),
            }
        }
        let scale = s.at(t).0.max(1.0);
        let half = 1.0 / (2.0 * scale);
        let centre = |u: f64| half + u.clamp(0.0, 1.0) * (1.0 - 2.0 * half);
        samples.push([scale as f32, centre(ux.at(t).0) as f32, centre(uy.at(t).0) as f32]);
    }
    CameraPath { step: STEP_S, samples }
}

#[cfg(test)]
mod tests {
    use super::*;

    const W: f64 = 1920.0;
    const H: f64 = 1080.0;

    fn zoom(start: f64, end: f64, scale: f64, cx: f64, cy: f64) -> Zoom {
        Zoom { start, end, scale, cx, cy }
    }
    fn at(p: &CameraPath, t: f64) -> [f32; 3] {
        p.samples[(t / p.step).round() as usize]
    }
    fn in_frame(p: &CameraPath) {
        for s in &p.samples {
            let half = 0.5 / s[0];
            for c in [s[1], s[2]] {
                assert!(c - half >= -1e-4 && c + half <= 1.0 + 1e-4, "window left the frame: {s:?}");
            }
        }
    }

    #[test]
    fn no_zooms_is_wide_and_centred() {
        let p = path(&[], &[], W, H, 3.0);
        assert_eq!(p.samples.len(), 181);
        assert!(p.samples.iter().all(|s| *s == [1.0, 0.5, 0.5]));
    }

    // The measured Cap shape: fast start, long soft landing, no overshoot, and
    // back at wide by the segment's end.
    #[test]
    fn single_zoom_glides_and_settles() {
        let p = path(&[zoom(1.0, 6.0, 2.0, 600.0, 400.0)], &[], W, H, 8.0);
        in_frame(&p);
        assert_eq!(at(&p, 0.9), [1.0, 0.5, 0.5]);
        let progress = |t: f64| (at(&p, t)[0] as f64 - 1.0) / 1.0;
        assert!((progress(1.2) - 0.56).abs() < 0.04, "half-way at ~0.2s, got {}", progress(1.2));
        assert!(progress(1.4) > 0.86, "90%-ish at 0.4s, got {}", progress(1.4));
        let peak = p.samples.iter().map(|s| s[0]).fold(0.0f32, f32::max);
        assert!(peak <= 2.0 + 1e-4, "no overshoot, peak {peak}");
        assert!(progress(4.0) > 0.999);
        assert!(at(&p, 6.0)[0] < 1.02, "wide by the segment end, got {}", at(&p, 6.0)[0]);
        // Scale only rises on the way in.
        let rise: Vec<f32> = p.samples[60..180].iter().map(|s| s[0]).collect();
        assert!(rise.windows(2).all(|w| w[1] >= w[0] - 1e-6));
        // Settled on the target: window centred on (600, 400).
        let hold = at(&p, 4.0);
        assert!((hold[1] as f64 - 600.0 / W).abs() < 1e-3 && (hold[2] as f64 - 400.0 / H).abs() < 1e-3);
    }

    // The centre heads straight for its target: every step moves the same way and
    // there is no dead stop mid-zoom (the old frame clamp did 59px, 9px, 0).
    #[test]
    fn zoom_in_centre_moves_monotonically() {
        let p = path(&[zoom(1.0, 6.0, 2.0, 0.40 * W, 0.5 * H)], &[], W, H, 4.0);
        let xs: Vec<f32> = p.samples[60..120].iter().map(|s| s[1]).collect();
        assert!(xs.windows(2).all(|w| w[1] <= w[0] + 1e-6), "centre x must only move toward the target");
        assert!((xs[59] as f64 - 0.40).abs() < 0.01);
    }

    #[test]
    fn nearby_zooms_pan_instead_of_zooming_out() {
        let p = path(
            &[zoom(1.0, 4.0, 1.7, 700.0, 400.0), zoom(5.5, 9.0, 1.7, 1300.0, 700.0)],
            &[], W, H, 11.0,
        );
        in_frame(&p);
        let (a, b) = ((2.0 / STEP_S) as usize, (8.0 / STEP_S) as usize);
        let low = p.samples[a..b].iter().map(|s| s[0]).fold(f32::MAX, f32::min);
        assert!(low > 1.69, "must stay zoomed across a 1.5s gap, dipped to {low}");
        assert!((at(&p, 5.0)[1] as f64 - 700.0 / W).abs() < 1e-3, "holds A through the gap");
        assert!((at(&p, 8.0)[1] as f64 - 1300.0 / W).abs() < 1e-3, "pans to B");
        assert!(at(&p, 9.0)[0] < 1.02);
    }

    #[test]
    fn distant_zooms_return_to_wide_between() {
        let p = path(
            &[zoom(1.0, 4.0, 2.0, 500.0, 300.0), zoom(8.0, 11.0, 2.0, 1400.0, 700.0)],
            &[], W, H, 12.0,
        );
        assert!(at(&p, 6.0)[0] < 1.001);
        assert!(at(&p, 9.5)[0] > 1.99);
    }

    // 120 Hz cursor: holds at (x0, y0) until t1, travels to (x1, y1) by t2, holds.
    fn cursor_move(x0: f64, y0: f64, x1: f64, y1: f64, t1: f64, t2: f64, end: f64) -> Vec<(f64, f64, f64)> {
        (0..=(end * 120.0) as usize)
            .map(|i| {
                let t = i as f64 / 120.0;
                let u = ((t - t1) / (t2 - t1)).clamp(0.0, 1.0);
                (t, x0 + (x1 - x0) * u, y0 + (y1 - y0) * u)
            })
            .collect()
    }

    // The cursor leaves the zoomed view: the camera glides once to where it
    // settles, stays zoomed throughout, and the cursor is never out of view.
    #[test]
    fn reaims_once_when_cursor_leaves_the_box() {
        let cursor = cursor_move(600.0, 400.0, 1400.0, 700.0, 4.0, 4.6, 12.0);
        let p = path(&[zoom(1.0, 10.0, 2.0, 600.0, 400.0)], &cursor, W, H, 12.0);
        in_frame(&p);
        let hold = at(&p, 3.5);
        assert!((hold[1] as f64 - 600.0 / W).abs() < 1e-3, "holds on the zoom's target first");
        let after = at(&p, 7.0);
        assert!((after[1] as f64 - 1400.0 / W).abs() < 0.02 && (after[2] as f64 - 700.0 / H).abs() < 0.02,
            "settles on where the cursor went, got {after:?}");
        let low = p.samples[120..540].iter().map(|s| s[0]).fold(f32::MAX, f32::min);
        assert!(low > 1.999, "stays zoomed while re-aiming, dipped to {low}");
        // Cursor inside the visible window at every sample while zoomed.
        for (t, x, y) in cursor.iter().filter(|c| c.0 > 1.6 && c.0 < 9.0) {
            let s = at(&p, *t);
            let half = 0.5 / s[0] as f64;
            assert!((x / W - s[1] as f64).abs() <= half + 1e-3 && (y / H - s[2] as f64).abs() <= half + 1e-3,
                "cursor out of view at {t}");
        }
    }

    // Wandering inside the box moves nothing (this is not continuous follow), and
    // a cursor that leaves the recording is not chased.
    #[test]
    fn small_moves_and_off_frame_cursor_do_not_move_the_camera() {
        let inside = cursor_move(600.0, 400.0, 800.0, 480.0, 4.0, 4.5, 12.0);
        let gone = cursor_move(600.0, 400.0, 2600.0, 400.0, 4.0, 4.5, 12.0);
        let still = path(&[zoom(1.0, 10.0, 2.0, 600.0, 400.0)], &[], W, H, 12.0);
        assert_eq!(path(&[zoom(1.0, 10.0, 2.0, 600.0, 400.0)], &inside, W, H, 12.0), still);
        let p = path(&[zoom(1.0, 10.0, 2.0, 600.0, 400.0)], &gone, W, H, 12.0);
        // It may follow the cursor to the frame edge, but no further, and settles.
        let end = at(&p, 8.0);
        assert!(end[1] <= 0.75 + 1e-4 && (end[2] as f64 - 400.0 / H).abs() < 1e-3, "{end:?}");
        in_frame(&p);
    }

    // Edge targets stay in frame, and a segment too short to settle never overshoots.
    #[test]
    fn corner_target_and_short_segment_stay_in_frame() {
        let p = path(
            &[zoom(0.0, 0.8, 2.5, 5.0, 5.0), zoom(1.0, 1.6, 2.5, 1915.0, 1075.0)],
            &[], W, H, 4.0,
        );
        in_frame(&p);
        assert!(p.samples.iter().all(|s| s[0] >= 1.0 && s[0] <= 2.5 + 1e-4));
        assert!(p.samples.last().unwrap()[0] < 1.001);
    }
}
