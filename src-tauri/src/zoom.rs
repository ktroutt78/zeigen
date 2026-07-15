// Zoom suggestion detection (ZOOM-LAYER-PLAN step 5). Pure function from a
// .cursor.json telemetry track to auto_generated ZoomKeyframes.
//
// CONSERVATIVE TRIGGER POLICY (Thread A). Telemetry cannot read intent — a
// click for local detail and a click that cross-filters the whole screen are
// one identical left_down. So a bare click never starts a zoom: it can only
// CORROBORATE a dwell (shaping that dwell's center and window). The three
// confident, self-intending signals are the only triggers:
//   - right-click menus  (menu appears, selection follows)
//   - drags              (deliberate, and self-framing by their span)
//   - dwells             (cursor settled = sustained attention)
// A click stop where the user then reads still zooms — via the dwell it sits
// in. A drive-by click with no dwell and no gesture proposes nothing; those
// (the cross-filter-ambiguous cases) are dropped by design and added back by
// hand in the review lane. Runs only from the review's "Suggest zooms" button.
//
// POST-CLICK INTENT (rule 1). What the cursor does AFTER a click reveals
// intent the click alone can't. If the cursor goes STILL after a click, the
// user is watching a consequence that rendered elsewhere (a popup, a new
// window, a map animating) — attention moved to the screen, not the cursor —
// so that dwell is vetoed to wide, inverting the naive "settled = attention"
// read. If instead the cursor follows through with LOCAL motion (menu items,
// nudging in place) the dwell holds. A CLICKLESS dwell (arrived and settled =
// reading in place) is untouched and still zooms. Known accepted tradeoff: a
// click whose consequence is LOCAL (a tooltip/inline expand at the click
// point) also goes wide — a missed zoom the user adds by hand beats a wrong
// zoom that crops a screen-wide change.
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
// snapshot tests below print and pin detector output; retune by editing
// these and reading the new pin off the test failure.

// C.1 dwell: cursor stays within a small region for >800ms. Implemented as
// a maximal sample run whose bounding-box diagonal stays under the radius.
const DWELL_RADIUS_PX: f64 = 150.0;
const DWELL_MIN_S: f64 = 0.8;

// Parked-cursor guard. A clickless dwell whose bounding box is essentially a
// point is an abandoned mouse, not attention — no zoom. And after the last
// sign of life (click or >JITTER_STEP_PX movement) a zoom holds only
// PARK_TAIL_S before letting go, so a click followed by minutes of parked
// cursor doesn't pin the zoom forever.
const PARKED_BBOX_PX: f64 = 8.0;
const JITTER_STEP_PX: f64 = 5.0;
const PARK_TAIL_S: f64 = 2.0;

// The zoom-in ramp opens CLICK_LEAD_S before the first sign of activity so
// the 600ms ramp is done by the moment the user acts.
const CLICK_LEAD_S: f64 = 1.0;

// Rule 1 post-click stillness veto. After the last click inside a dwell, if
// the cursor's whole remaining stretch stays within a POST_CLICK_STILL_PX
// bounding box for at least POST_CLICK_WATCH_S, the user is watching a
// consequence elsewhere — suppress the zoom. Measured over the whole stretch,
// not the first instant, so a click-then-pause-then-local-move (menu) reads as
// motion (its box overflows the still threshold) and holds.
const POST_CLICK_STILL_PX: f64 = 60.0;
const POST_CLICK_WATCH_S: f64 = 0.6;

// C.1 calm rule: minimum gap between distinct zooms. Confident candidates
// closer than this either bridge (co-located — one hold) or, if distinct, get
// their padding clipped to restore the gap.
const MERGE_GAP_S: f64 = 1.2;
const CENTER_MERGE_PX: f64 = 300.0;

// C.1 scroll: reading — hold the current zoom, never pan with the scroll. A
// scroll run near a segment's end extends the hold; a scroll over a clickless
// dwell vetoes it (the wide view is the view the reader is using).
const SCROLL_NEAR_S: f64 = 1.2;
const SCROLL_TAIL_S: f64 = 1.5;
const SCROLL_VETO_PAD_S: f64 = 0.5;

// A left_down/left_up pair whose endpoints are more than DRAG_MIN_PX apart is
// a drag, not a click: one candidate spanning the whole gesture, and the drag
// motion is excluded from dwell detection so it never spawns a mid-drag dwell.
const DRAG_MIN_PX: f64 = 60.0;

// Gestures (drags and right-click menus) are framed by their span, not a
// point: the zoom centers on the midpoint and its scale is chosen so the span
// occupies at most GESTURE_FILL of the viewport (both ends stay in frame). A
// span so wide the fitted scale drops below GESTURE_FLOOR can't be framed
// usefully — stay wide. A right-click's span runs to the selection click that
// follows it within MENU_WINDOW_S (the menu item the cursor travels to).
const GESTURE_FILL: f64 = 0.85;
const GESTURE_FLOOR: f64 = 1.2;
const MENU_WINDOW_S: f64 = 4.0;

// Fresh merge/bridge policy (Thread A — designed under the demoted-clicks
// model, NOT ported). Two confident candidates bridge into one continuous
// hold only when they are genuinely co-located: their centers are within
// CENTER_MERGE_PX AND the union of their boxes still frames at a real zoom
// depth (>= MERGE_MIN_SCALE, not merely above the floor) AND they are within
// BRIDGE_GAP_S of each other in evidence time. A pair that would only fit by
// zooming out toward the floor is a pan across the screen, not a lingering
// hold — it stays two separate zooms. This answers the over-merge / corner-
// to-corner canary by construction: far-apart candidates never bridge.
const BRIDGE_GAP_S: f64 = 3.0;
const MERGE_MIN_SCALE: f64 = 1.7;

// Shape of the output. Interior-aware scale: unclamped mid-frame centers zoom
// shallower (INTERIOR_SCALE) since they show less surrounding context, while
// edge-clamped centers keep the deeper SUGGESTED_SCALE (clamping already
// reveals extra context for free). Same 600ms in_out_cubic ramps as manual
// zooms; segments shorter than MIN_ZOOM_S after trimming are too twitchy.
const MIN_ZOOM_S: f64 = 2.0;
const SUGGESTED_SCALE: f64 = 2.0;
const INTERIOR_SCALE: f64 = 1.7;
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

// One proposed zoom window before keyframe emission. The zoom must keep the
// evidence bounding box [minx,maxx]x[miny,maxy] in frame: the emitted center
// is that box's center and the scale is chosen so the box fits. A dwell is a
// point box (no scale constraint); a gesture's box spans its endpoints;
// bridging unions the boxes. `ev0`/`ev1` bracket the hard evidence the padded
// [start,end] window wraps — the merge pass may clip the padding but never
// cut inside the evidence.
#[derive(Clone, Debug)]
struct Candidate {
    start: f64,
    end: f64,
    minx: f64,
    maxx: f64,
    miny: f64,
    maxy: f64,
    clicks: u32,
    ev0: f64,
    ev1: f64,
}

impl Candidate {
    fn cx(&self) -> f64 {
        (self.minx + self.maxx) / 2.0
    }
    fn cy(&self) -> f64 {
        (self.miny + self.maxy) / 2.0
    }
    fn absorb(&mut self, o: &Candidate) {
        self.minx = self.minx.min(o.minx);
        self.maxx = self.maxx.max(o.maxx);
        self.miny = self.miny.min(o.miny);
        self.maxy = self.maxy.max(o.maxy);
    }
}

// Deepest scale that keeps a `span`-wide box inside `frame` at GESTURE_FILL of
// the viewport; INFINITY when the span is a point (no constraint).
fn fit_scale(span: f64, frame: f64) -> f64 {
    if span > 0.0 {
        GESTURE_FILL * frame / span
    } else {
        f64::INFINITY
    }
}

// A press-to-release drag or a right-click-to-selection menu: framed by its
// endpoints (x0,y0)->(x1,y1), not a single point.
struct Gesture {
    t0: f64,
    t1: f64,
    x0: f64,
    y0: f64,
    x1: f64,
    y1: f64,
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
    let (w, h) = (track.video_size.width, track.video_size.height);

    let mut events: Vec<&CursorEvent> = track.events.iter().collect();
    events.sort_by(|a, b| a.t.total_cmp(&b.t));
    let scrolls: Vec<&CursorEvent> =
        events.iter().copied().filter(|e| e.kind == "scroll").collect();
    let ups: Vec<&CursorEvent> =
        events.iter().copied().filter(|e| e.kind == "left_up").collect();

    // ---- Confident triggers: gestures first ----------------------------
    // Right-click menus: a right_down whose span runs to the selection click
    // that follows it within MENU_WINDOW_S is a gesture. That selection click
    // is consumed so it spawns no bare-click of its own; a right_down with no
    // follow-up is just a bare click. Then left_downs: a large-displacement
    // press/release is a drag gesture, a small one is a bare click.
    //
    // `clicks` here is the BARE-CLICK set — clicks that are not a gesture.
    // Under the conservative policy they never trigger; they only corroborate
    // a dwell they fall inside (shaping its center and window below).
    let mut gestures: Vec<Gesture> = Vec::new();
    let mut clicks: Vec<&CursorEvent> = Vec::new();
    let mut consumed: Vec<f64> = Vec::new();
    for e in events.iter().copied().filter(|e| e.kind == "right_down") {
        match events
            .iter()
            .copied()
            .find(|o| o.kind == "left_down" && o.t > e.t && o.t - e.t <= MENU_WINDOW_S)
        {
            Some(sel) => {
                gestures.push(Gesture { t0: e.t, t1: sel.t, x0: e.x, y0: e.y, x1: sel.x, y1: sel.y });
                consumed.push(sel.t);
            }
            None => clicks.push(e),
        }
    }
    for e in events.iter().copied().filter(|e| e.kind == "left_down") {
        if consumed.contains(&e.t) {
            continue;
        }
        match ups.iter().find(|u| u.t >= e.t) {
            Some(u) if dist(e.x, e.y, u.x, u.y) > DRAG_MIN_PX => {
                gestures.push(Gesture { t0: e.t, t1: u.t, x0: e.x, y0: e.y, x1: u.x, y1: u.y });
            }
            _ => clicks.push(e),
        }
    }

    let mut candidates: Vec<Candidate> = Vec::new();

    // Dwell candidates: greedy maximal sample runs whose bbox diagonal stays
    // under DWELL_RADIUS_PX. Travel never dwells (bbox overflows immediately),
    // so travel separates candidates by construction. A run overlapping a
    // gesture spawns no dwell (the gesture provides one). A clickless dwell is
    // vetoed by an overlapping scroll (reading) or rejected as parked.
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
        let over_gesture = gestures.iter().any(|g| g.t0 <= t1 && g.t1 >= t0);
        if t1 - t0 >= DWELL_MIN_S && !over_gesture {
            let in_dwell: Vec<&&CursorEvent> =
                clicks.iter().filter(|c| c.t >= t0 && c.t <= t1).collect();
            let scroll_vetoed = in_dwell.is_empty()
                && scrolls.iter().any(|s| {
                    s.t >= t0 - SCROLL_VETO_PAD_S && s.t <= t1 + SCROLL_VETO_PAD_S
                });
            let parked =
                in_dwell.is_empty() && dist(minx, miny, maxx, maxy) < PARKED_BBOX_PX;
            // Rule 1: a clicked dwell whose whole post-click stretch stays
            // still is watching a consequence elsewhere — veto to wide. Third
            // sibling of the parked/scroll vetoes; scoped to clicked dwells so
            // clickless reading-in-place is untouched.
            let post_click_still = match in_dwell
                .iter()
                .map(|c| c.t)
                .max_by(|a, b| a.total_cmp(b))
            {
                Some(last_click) if t1 - last_click >= POST_CLICK_WATCH_S => {
                    let post = samples[i..=j].iter().filter(|s| s.t >= last_click);
                    let (mut nx, mut xx, mut ny, mut xy) =
                        (f64::MAX, f64::MIN, f64::MAX, f64::MIN);
                    for s in post {
                        nx = nx.min(s.x);
                        xx = xx.max(s.x);
                        ny = ny.min(s.y);
                        xy = xy.max(s.y);
                    }
                    xx >= nx && dist(nx, ny, xx, xy) < POST_CLICK_STILL_PX
                }
                _ => false,
            };
            if !parked && !scroll_vetoed && !post_click_still {
                // Signs of life inside the dwell: clicks, or movement beyond
                // jitter from the last resting position. The zoom window hugs
                // [first, last] activity — a cursor parked for a stretch
                // before or after doesn't drag the zoom with it.
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
                    // Attention centers on the corroborating clicks when there
                    // are any, else on where the cursor actually sat. Median,
                    // not mean: the run's edges include entry/exit travel tails
                    // that fit inside the bbox, and a mean drags toward them.
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
                        minx: cx,
                        maxx: cx,
                        miny: cy,
                        maxy: cy,
                        clicks: in_dwell.len() as u32,
                        ev0: first_act.unwrap_or(start),
                        ev1: last_act,
                    });
                }
            }
        }
        i = j + 1;
    }

    // Gesture candidates: one candidate whose evidence box spans the drag or
    // menu endpoints, so framing keeps both in view. A gesture whose own span
    // is too wide to frame above GESTURE_FLOOR earns no candidate — stay wide.
    // The gesture's motion already suppressed overlapping dwells above.
    for g in &gestures {
        let (dx, dy) = ((g.x1 - g.x0).abs(), (g.y1 - g.y0).abs());
        if fit_scale(dx, w).min(fit_scale(dy, h)).min(SUGGESTED_SCALE) < GESTURE_FLOOR {
            continue;
        }
        candidates.push(Candidate {
            start: (g.t0 - CLICK_LEAD_S).max(0.0),
            end: (g.t1 + RAMP_S).min(track_end),
            minx: g.x0.min(g.x1),
            maxx: g.x0.max(g.x1),
            miny: g.y0.min(g.y1),
            maxy: g.y0.max(g.y1),
            clicks: 1,
            ev0: g.t0,
            ev1: g.t1,
        });
    }

    // NOTE: no bare-click candidates. The conservative policy demotes a lone
    // click to a corroborator only; it shaped the dwell it sits in above, and
    // a click in no dwell and no gesture proposes nothing.

    candidates.sort_by(|a, b| a.start.total_cmp(&b.start));

    // ---- Fresh merge/bridge pass (designed, not ported) ----------------
    // Index-based so a co-located bridge (mutate last) and a distinct split
    // (mutate last, then push) never fight the borrow checker.
    let mut merged: Vec<Candidate> = Vec::new();
    for c in candidates {
        if merged.is_empty() {
            merged.push(c);
            continue;
        }
        let li = merged.len() - 1;
        let centers_near =
            dist(merged[li].cx(), merged[li].cy(), c.cx(), c.cy()) <= CENTER_MERGE_PX;
        let union_w = merged[li].maxx.max(c.maxx) - merged[li].minx.min(c.minx);
        let union_h = merged[li].maxy.max(c.maxy) - merged[li].miny.min(c.miny);
        let union_scale =
            fit_scale(union_w, w).min(fit_scale(union_h, h)).min(SUGGESTED_SCALE);
        let colocated = centers_near && union_scale >= MERGE_MIN_SCALE;
        let ev_gap = c.ev0 - merged[li].ev1;
        if colocated && ev_gap <= BRIDGE_GAP_S {
            // Same region, close in time — one continuous hold.
            merged[li].absorb(&c);
            merged[li].end = merged[li].end.max(c.end);
            merged[li].ev1 = merged[li].ev1.max(c.ev1);
            merged[li].clicks += c.clicks;
        } else if c.start >= merged[li].end + MERGE_GAP_S {
            // Already calm-separated — keep both as-is.
            merged.push(c);
        } else if ev_gap >= MERGE_GAP_S {
            // Distinct actions crowded only by padding: split the padding at
            // the evidence-gap midpoint, never cutting either evidence, so
            // both survive as separate zooms a calm gap apart. (This is what
            // keeps two far-apart back-to-back drags from fusing into one
            // corner-to-corner pan.)
            let midpoint = (merged[li].ev1 + c.ev0) / 2.0;
            merged[li].end = merged[li].end.min((midpoint - MERGE_GAP_S / 2.0).max(merged[li].ev1));
            let mut c = c;
            c.start = c.start.max((midpoint + MERGE_GAP_S / 2.0).min(c.ev0));
            merged.push(c);
        } else if (c.clicks, c.ev1 - c.ev0) > (merged[li].clicks, merged[li].ev1 - merged[li].ev0) {
            // Evidence itself conflicts (near-overlapping) and they are not
            // co-located — can't show both. Keep the stronger; a wrong zoom is
            // worse than a missed one.
            merged[li] = c;
        }
        // else: drop c (weaker of a conflicting pair).
    }

    // Scroll holds: a scroll run at a segment's edge means reading — keep the
    // zoom up through it (plus a tail), but never into the next segment's calm
    // gap. Also the final guarantor of the MERGE_GAP between neighbors.
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

    // Final shape: drop twitchy shorts, center on the evidence box, pick the
    // scale — shallower for boxes that sit inside the frame at full depth,
    // deeper for edge-clamped ones, but never deeper than keeps the whole box
    // in frame. A box too wide to frame above the floor stays wide. Clamp the
    // center to the chosen scale's window, emit the canonical run.
    let (edge_w, edge_h) = (w / (2.0 * SUGGESTED_SCALE), h / (2.0 * SUGGESTED_SCALE));
    let mut kfs: Vec<ZoomKeyframe> = Vec::new();
    for c in merged {
        if c.end - c.start < MIN_ZOOM_S {
            continue;
        }
        let (cx0, cy0) = (c.cx(), c.cy());
        let interior = cx0 >= edge_w && cx0 <= w - edge_w && cy0 >= edge_h && cy0 <= h - edge_h;
        let base = if interior { INTERIOR_SCALE } else { SUGGESTED_SCALE };
        let scale = base
            .min(fit_scale(c.maxx - c.minx, w))
            .min(fit_scale(c.maxy - c.miny, h));
        if scale < GESTURE_FLOOR {
            continue;
        }
        let (half_w, half_h) = (w / (2.0 * scale), h / (2.0 * scale));
        let cx = cx0.clamp(half_w, w - half_w);
        let cy = cy0.clamp(half_h, h - half_h);
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
            kfs.push(kf(c.start + ramp, scale));
            kfs.push(kf(c.end - ramp, scale));
        } else {
            kfs.push(kf(c.start + dur / 2.0, scale));
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

        // A bare left-click at the current position.
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
    // (start, end, center_x, center_y, peak_scale).
    fn segments(kfs: &[ZoomKeyframe]) -> Vec<(f64, f64, f64, f64, f64)> {
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
            out.push((kfs[i - 1].t, kfs[j].t, kfs[i].center_x, kfs[i].center_y, kfs[i].scale));
            i = j;
        }
        out
    }

    fn fmt_segments(kfs: &[ZoomKeyframe]) -> String {
        segments(kfs)
            .iter()
            .map(|(s, e, x, y, sc)| format!("{s:.2}-{e:.2}s @({x:.0},{y:.0}) {sc:.1}x"))
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
        // Rule 1 vetoes the 1.30-4.26 post-click-still dwell; only the drag
        // survives (down from 2 pre-rule-1, 4 at the committed baseline).
        assert_eq!(got, "13.67-15.73s @(1102,717) 2.0x");
    }

    // Fixture #2: the ~162s demo recording from the 2026-07-13 owner judging
    // pass (drags + 46 scroll events). Conservative policy: menus/drags/dwells
    // trigger, bare clicks only corroborate; the fresh merge keeps far-apart
    // back-to-back gestures separate (the corner-to-corner canary).
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
            "7.88-10.55s @(480,270) 2.0x; 15.01-20.91s @(869,638) 1.7x; 22.66-26.08s @(480,270) 2.0x; 30.38-42.17s @(497,314) 1.9x; 47.67-51.36s @(664,590) 1.4x; 61.52-65.49s @(684,604) 1.4x; 70.55-75.39s @(480,621) 2.0x; 80.34-83.64s @(480,413) 2.0x; 85.42-88.12s @(480,528) 2.0x; 89.32-93.52s @(952,686) 1.7x; 95.44-98.67s @(480,729) 2.0x; 108.86-113.74s @(480,644) 2.0x; 117.85-120.96s @(1146,662) 1.7x; 132.19-135.96s @(480,298) 2.0x; 143.92-148.76s @(1355,430) 1.7x; 149.96-152.22s @(565,530) 1.7x; 153.68-156.94s @(643,534) 1.5x; 158.14-161.14s @(1131,318) 1.7x"
        );
    }

    // Fixture #3: the 2026-07-13-220817 clip with right-click menus + drags
    // wider than the viewport. Right-click gestures center on the menu-
    // selection midpoint; drags fit their scale to the span; spans too wide to
    // frame stay wide. Every emitted zoom stays within [GESTURE_FLOOR,
    // SUGGESTED_SCALE].
    #[test]
    fn real_recording_3_pinned_suggestions() {
        let track: CursorTrack = serde_json::from_str(include_str!(
            "../tests/fixtures/cursor-2026-07-13-220817.json"
        ))
        .unwrap();
        let kfs = detect(&track);
        let got = fmt_segments(&kfs);
        println!("real-recording-3 suggestions: {got}");
        for w in segments(&kfs).windows(2) {
            assert!(
                w[1].0 - w[0].1 >= MERGE_GAP_S - 1e-9,
                "calm rule: {:.2}s gap between {:?} and {:?}",
                w[1].0 - w[0].1,
                w[0],
                w[1]
            );
        }
        for (_, _, _, _, sc) in segments(&kfs) {
            assert!(sc >= GESTURE_FLOOR - 1e-9 && sc <= SUGGESTED_SCALE + 1e-9, "scale {sc}");
        }
        assert_eq!(
            got,
            "6.72-11.26s @(434,246) 2.0x; 14.39-20.65s @(378,303) 2.0x; 23.72-27.25s @(472,315) 1.6x; 30.41-33.85s @(378,477) 2.0x; 36.00-39.36s @(506,554) 1.7x; 40.56-43.43s @(797,693) 1.7x; 47.35-49.40s @(1134,662) 2.0x; 51.37-55.20s @(1134,707) 2.0x; 56.94-62.02s @(378,619) 2.0x; 67.56-72.29s @(489,542) 1.5x; 90.81-99.60s @(378,246) 2.0x; 103.11-105.30s @(1134,736) 2.0x"
        );
    }

    #[test]
    fn canonical_keyframe_shape() {
        // Clickless dwell (unaffected by rule 1) — this test is about the
        // emitted keyframe shape, not the trigger policy.
        let track = TrackBuilder::new().travel(400.0, 400.0, 1.0).dwell(3.0).travel(600.0, 500.0, 1.0).park(0.5).build();
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
    fn bare_click_alone_does_not_zoom() {
        // Conservative policy: a lone click the cursor arrives at and leaves,
        // with no sustained dwell, is the ambiguous cross-filter case — no
        // zoom. (Travel in, single click, travel out; nowhere still >800ms.)
        let track = TrackBuilder::new()
            .travel(400.0, 400.0, 0.5)
            .click()
            .travel(1000.0, 700.0, 0.5)
            .build();
        assert_eq!(detect(&track).len(), 0, "a bare click with no dwell must not zoom");
    }

    #[test]
    fn post_click_stillness_goes_wide() {
        // Rule 1 inversion: a click followed by sustained stillness is the
        // user watching a consequence that rendered elsewhere (popup, new
        // window, map animating) — attention moved to the screen, not the
        // cursor. It must go WIDE, not zoom into the click point. (Pre-rule-1
        // this same track zoomed; the inversion is the whole point.)
        let track = TrackBuilder::new().park(5.0).click().park(5.0).build();
        assert_eq!(detect(&track).len(), 0, "post-click stillness must go wide");
    }

    #[test]
    fn post_click_local_motion_holds() {
        // Rule 2: a click followed by LOCAL follow-through motion (menu items,
        // nudging in place) is genuine navigation — the dwell holds. The
        // post-click box overflows the stillness threshold, so rule 1 leaves
        // it alone.
        let track = TrackBuilder::new()
            .travel(500.0, 400.0, 1.0)
            .click()
            .travel(590.0, 460.0, 1.5) // ~108px local follow-through, inside the dwell region
            .park(0.5)
            .build();
        let segs = segments(&detect(&track));
        assert_eq!(segs.len(), 1, "click + local follow-through holds the zoom, got {segs:?}");
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
    fn nearby_dwells_bridge() {
        // Two close, co-located dwell stops fold into one continuous hold.
        let track = TrackBuilder::new()
            .travel(400.0, 400.0, 1.0)
            .dwell(1.2)
            .click()
            .travel(470.0, 430.0, 0.3)
            .dwell(2.0)
            .click()
            .park(0.5)
            .build();
        let segs = segments(&detect(&track));
        assert_eq!(segs.len(), 1, "two close co-located dwells = one zoom, got {segs:?}");
    }

    #[test]
    fn distant_dwells_do_not_merge_centers() {
        // Two far-apart dwell stops crowded in time never smear to a midpoint
        // center — one stays, on one real target.
        let track = TrackBuilder::new()
            .travel(200.0, 200.0, 1.0)
            .dwell(2.5)
            .travel(1300.0, 850.0, 0.3)
            .dwell(2.5)
            .park(1.0)
            .build();
        let segs = segments(&detect(&track));
        assert_eq!(segs.len(), 1, "{segs:?}");
        let near_a = dist(segs[0].2, segs[0].3, 200.0, 200.0) < CENTER_MERGE_PX;
        let near_b = dist(segs[0].2, segs[0].3, 1300.0, 850.0) < CENTER_MERGE_PX;
        assert!(near_a || near_b, "center must stay on one target, got {:?}", segs[0]);
    }

    #[test]
    fn distant_back_to_back_gestures_stay_separate() {
        // The canary in miniature: two wide drags to opposite corners, 1.3s
        // apart, must stay TWO zooms — never one corner-to-corner pan.
        let mut tb = TrackBuilder::new().travel(200.0, 200.0, 0.5);
        // drag 1: (200,200) -> (500,300)
        tb.track.events.push(CursorEvent { t: tb.t, kind: "left_down".into(), x: 200.0, y: 200.0 });
        tb = tb.travel(500.0, 300.0, 1.5);
        tb.track.events.push(CursorEvent { t: tb.t, kind: "left_up".into(), x: 500.0, y: 300.0 });
        tb = tb.park(1.5).travel(1200.0, 800.0, 0.3);
        // drag 2: (1200,800) -> (1400,900)
        tb.track.events.push(CursorEvent { t: tb.t, kind: "left_down".into(), x: 1200.0, y: 800.0 });
        tb = tb.travel(1400.0, 900.0, 1.5);
        tb.track.events.push(CursorEvent { t: tb.t, kind: "left_up".into(), x: 1400.0, y: 900.0 });
        tb = tb.park(0.5);
        let segs = segments(&detect(&tb.build()));
        assert_eq!(segs.len(), 2, "far back-to-back drags must not fuse, got {segs:?}");
    }

    #[test]
    fn scroll_extends_hold() {
        // Click + local follow-through (so rule 1 holds it, not vetoes it),
        // then a scroll run at the edge that should extend the hold.
        let with_scroll = TrackBuilder::new()
            .travel(700.0, 480.0, 1.0)
            .click()
            .travel(780.0, 520.0, 1.2)
            .scroll_run(3.0)
            .park(4.0)
            .build();
        let without = TrackBuilder::new()
            .travel(700.0, 480.0, 1.0)
            .click()
            .travel(780.0, 520.0, 1.2)
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
    fn scroll_vetoes_clickless_dwell() {
        // A clickless dwell with a scroll over it is reading — the wide view
        // is the view in use, so no zoom.
        let track = TrackBuilder::new()
            .travel(700.0, 480.0, 1.0)
            .dwell(0.4)
            .scroll_run(3.0)
            .dwell(0.4)
            .build();
        assert_eq!(detect(&track).len(), 0, "scroll over a clickless dwell vetoes it");
    }

    #[test]
    fn centers_clamp_to_frame_at_scale() {
        // Clickless corner dwell (unaffected by rule 1) so it zooms and we can
        // check the center clamps inside the 2x window.
        let track = TrackBuilder::new()
            .travel(20.0, 20.0, 1.0)
            .dwell(3.0)
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
