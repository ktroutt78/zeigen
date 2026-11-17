// The layout path: the ONE definition of where the screen recording and the webcam
// sit in the picture at every moment (TIMELINE-PLAN step 5). Scene segments in, a
// sampled path out, on the same grid as the camera path. The preview and the export
// both only look this path up, so they cannot drift apart.
//
// Scene decides where the two pictures sit; Zoom (the camera path) decides what part
// of the recording shows inside the screen picture. A zoom under a full-webcam scene
// simply keeps running out of sight.
//
// Motion: every number chases its target with the camera's critically damped spring.
// A scene sets the targets at its start and releases them early enough to be back at
// the default layout by its end, exactly as a zoom does. Scenes that touch are joined:
// the layout goes straight from one to the next.
//
// The path also carries "bubble shrinks during zooms": in the default layout the
// bubble is scaled by `shrink` in step with the camera's zoom, about its own corner.

use serde::{Deserialize, Serialize};

use crate::camera::{CameraPath, Spring, SETTLE_S, STEP_S};

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Layout {
    // Screen as usual, webcam faded out.
    NoBubble,
    // Screen on the left, webcam as a card of the same height on the right.
    Split,
    // Webcam fills the picture.
    FullWebcam,
    // Screen fills the picture: no webcam, no Frame padding.
    FullScreen,
}

#[derive(Clone, Copy, Debug)]
pub struct Scene {
    pub start: f64,
    pub end: f64,
    pub layout: Layout,
}

// A rectangle as fractions of the output picture, top-left origin.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

// The default layout, which the renderers already know how to draw.
#[derive(Clone, Copy, Debug)]
pub struct Geometry {
    // Output picture width / height.
    pub aspect: f64,
    // Where the recording sits by default: the Frame inset, or the whole picture.
    pub screen: Rect,
    // The webcam bubble by default.
    pub bubble: Rect,
    // Bubble corner radius as a fraction of its short side (0.5 = circle).
    pub bubble_radius: f64,
    // The point of the bubble that stays put when it shrinks, 0..1 across it
    // (its zone corner: bottom-right bubble = (1, 1)).
    pub anchor: (f64, f64),
    // Bubble size while the screen is zoomed, 1.0 = unchanged, above 1 grows it.
    pub shrink: f64,
}

// Split screen: the screen's share of the width, the gap around both pictures (a
// fraction of the width), and the card's corner radius (fraction of its short side).
const SPLIT_SCREEN_W: f64 = 0.62;
const SPLIT_MARGIN: f64 = 0.02;
const SPLIT_CARD_RADIUS: f64 = 0.08;
// The bubble is fully shrunk once the camera is zoomed in this far past 1.0.
const SHRINK_FULL_AT: f64 = 0.5;

// samples[i] at t = i * step:
// [screen x, y, w, h, frame, webcam x, y, w, h, radius, alpha]
// `frame` is how much of the Frame styling (rounded corners, shadow) the screen
// keeps, 1 = all, 0 = none. `radius` is a fraction of the webcam rect's short side.
// The webcam picture is cover-fitted into its rect.
pub const FIELDS: usize = 11;

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct ScenePath {
    pub step: f64,
    pub samples: Vec<[f32; FIELDS]>,
}

// The bubble moving to another rest spot at `t` (a recording that follows the
// floating bubble's moves): its default rect and shrink anchor from then on.
#[derive(Clone, Copy, Debug)]
pub struct Move {
    pub t: f64,
    pub bubble: Rect,
    pub anchor: (f64, f64),
}

// Targets for a layout: the first 11 are the sample fields before shrinking, the
// 12th is how much the zoom shrink applies (1 in bubble layouts, 0 otherwise),
// the 13th and 14th the shrink anchor (it glides with the bubble when it moves).
fn targets(layout: Option<Layout>, g: &Geometry) -> [f64; FIELDS + 3] {
    let (s, b) = (g.screen, g.bubble);
    let (ax, ay) = g.anchor;
    let bubble = |alpha: f64| [s.x, s.y, s.w, s.h, 1.0, b.x, b.y, b.w, b.h, g.bubble_radius, alpha, 1.0, ax, ay];
    match layout {
        None => bubble(1.0),
        Some(Layout::NoBubble) => bubble(0.0),
        Some(Layout::FullScreen) => [0.0, 0.0, 1.0, 1.0, 0.0, b.x, b.y, b.w, b.h, g.bubble_radius, 0.0, 1.0, ax, ay],
        Some(Layout::FullWebcam) => [s.x, s.y, s.w, s.h, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0, 1.0, 0.0, ax, ay],
        Some(Layout::Split) => {
            // The recording keeps its shape (same fraction of width and height),
            // centred in the left share; the card takes the right share, with the
            // same top and bottom edges as the recording.
            let m = SPLIT_MARGIN;
            let sw = SPLIT_SCREEN_W - 1.5 * m;
            let cx = SPLIT_SCREEN_W + 0.5 * m;
            let y = (1.0 - sw) / 2.0;
            [m, y, sw, sw, 1.0, cx, y, 1.0 - m - cx, sw, SPLIT_CARD_RADIUS, 1.0, 0.0, ax, ay]
        }
    }
}

// None when there is nothing to do: no scenes, no shrink and no bubble moves. The
// renderers then take their existing path untouched.
//
// `g` holds the bubble's spot at t = 0; each move changes it from its time on. A
// move retargets every number to the layout in force with the new spot, so in a
// bubble layout the bubble glides there on the same springs as a scene change,
// and in any other layout only the layout it returns to changes.
pub fn path(
    scenes: &[Scene],
    moves: &[Move],
    camera: Option<&CameraPath>,
    g: &Geometry,
    duration: f64,
) -> Option<ScenePath> {
    let mut scenes: Vec<Scene> = scenes.iter().copied().filter(|s| s.end > s.start).collect();
    if scenes.is_empty() && g.shrink == 1.0 && moves.is_empty() {
        return None;
    }
    scenes.sort_by(|a, b| a.start.total_cmp(&b.start));

    enum Event {
        Layout(Option<Layout>),
        Move(Rect, (f64, f64)),
    }
    let mut events: Vec<(f64, Event)> = Vec::new();
    for (i, s) in scenes.iter().enumerate() {
        events.push((s.start, Event::Layout(Some(s.layout))));
        let joined = scenes.get(i + 1).is_some_and(|n| n.start - s.end <= SETTLE_S);
        if !joined {
            events.push(((s.end - SETTLE_S).max((s.start + s.end) / 2.0), Event::Layout(None)));
        }
    }
    // Each move goes in before the first scene event after it, leaving the scene
    // events in their own order.
    for m in moves {
        let at = events.iter().position(|e| e.0 > m.t).unwrap_or(events.len());
        events.insert(at, (m.t, Event::Move(m.bubble, m.anchor)));
    }

    let mut g = *g;
    let mut layout: Option<Layout> = None;
    let mut springs = targets(None, &g).map(Spring::at_rest);
    let mut next = 0;
    let count = (duration.max(0.0) / STEP_S).ceil() as usize + 1;
    let mut samples = Vec::with_capacity(count);
    for i in 0..count {
        let t = i as f64 * STEP_S;
        while next < events.len() && events[next].0 <= t {
            let te = events[next].0;
            match events[next].1 {
                Event::Layout(l) => layout = l,
                Event::Move(bubble, anchor) => {
                    g.bubble = bubble;
                    g.anchor = anchor;
                }
            }
            next += 1;
            for (spring, target) in springs.iter_mut().zip(targets(layout, &g)) {
                spring.retarget(te, target);
            }
        }
        let v = springs.map(|s| s.at(t).0);
        let zoom = camera.and_then(|c| c.samples.get(i)).map_or(1.0, |s| s[0] as f64);
        let zoomed = ((zoom - 1.0) / SHRINK_FULL_AT).clamp(0.0, 1.0);
        let k = 1.0 - (1.0 - g.shrink) * v[11].clamp(0.0, 1.0) * zoomed;
        let (w, h) = (v[7] * k, v[8] * k);
        let mut out = [0f32; FIELDS];
        let fields = [
            v[0], v[1], v[2], v[3], v[4].clamp(0.0, 1.0),
            v[5] + (v[7] - w) * v[12], v[6] + (v[8] - h) * v[13], w, h,
            v[9].clamp(0.0, 0.5), v[10].clamp(0.0, 1.0),
        ];
        for (o, f) in out.iter_mut().zip(fields) {
            *o = f as f32;
        }
        samples.push(out);
    }
    Some(ScenePath { step: STEP_S, samples })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn geo(shrink: f64) -> Geometry {
        Geometry {
            aspect: 16.0 / 9.0,
            screen: Rect { x: 0.06, y: 0.06, w: 0.88, h: 0.88 },
            bubble: Rect { x: 0.80, y: 0.70, w: 0.12, h: 0.12 * 16.0 / 9.0 },
            bubble_radius: 0.5,
            anchor: (1.0, 1.0),
            shrink,
        }
    }
    fn at(p: &ScenePath, t: f64) -> [f32; FIELDS] {
        p.samples[(t / p.step).round() as usize]
    }
    fn close(a: &[f32], b: &[f64], tol: f64) -> bool {
        a.iter().zip(b).all(|(x, y)| (*x as f64 - y).abs() <= tol)
    }

    #[test]
    fn nothing_to_do_is_no_path() {
        assert!(path(&[], &[], None, &geo(1.0), 10.0).is_none());
        assert!(path(&[], &[], None, &geo(0.7), 10.0).is_some());
    }

    #[test]
    fn full_webcam_fills_the_picture_and_returns_by_the_end() {
        let g = geo(1.0);
        let p = path(&[Scene { start: 2.0, end: 6.0, layout: Layout::FullWebcam }], &[], None, &g, 10.0).unwrap();
        let default = targets(None, &g);
        assert!(close(&at(&p, 1.9), &default[..FIELDS], 1e-6), "default before the scene");
        // About half a second in, the webcam is nearly full picture and square-cornered.
        let mid = at(&p, 3.0);
        assert!(close(&mid[5..10], &[0.0, 0.0, 1.0, 1.0, 0.0], 0.01), "{mid:?}");
        assert!(mid[10] > 0.99);
        // Half done at about 0.2s, like the zoom.
        let early = at(&p, 2.2);
        assert!(early[7] > 0.4 && early[7] < 0.8, "{early:?}");
        assert!(close(&at(&p, 6.0), &default[..FIELDS], 0.01), "back to default by the end");
    }

    #[test]
    fn layouts_reach_their_targets() {
        let g = geo(1.0);
        for layout in [Layout::NoBubble, Layout::Split, Layout::FullScreen] {
            let p = path(&[Scene { start: 1.0, end: 8.0, layout }], &[], None, &g, 10.0).unwrap();
            let want = targets(Some(layout), &g);
            assert!(close(&at(&p, 5.0), &want[..FIELDS], 1e-3), "{layout:?}");
        }
        // Split: both pictures inside the canvas, side by side, recording shape kept.
        let s = targets(Some(Layout::Split), &g);
        assert!((s[2] - s[3]).abs() < 1e-12);
        assert!(s[0] + s[2] < s[5] && s[5] + s[7] < 1.0);
        // The card has the recording's top and bottom edges.
        assert!(s[6] == s[1] && s[8] == s[3]);
    }

    #[test]
    fn touching_scenes_go_straight_from_one_to_the_next() {
        let g = geo(1.0);
        let p = path(
            &[
                Scene { start: 1.0, end: 4.0, layout: Layout::FullWebcam },
                Scene { start: 4.0, end: 8.0, layout: Layout::NoBubble },
            ],
            &[],
            None,
            &g,
            10.0,
        )
        .unwrap();
        // Just before the handover the webcam is still full picture (no release).
        assert!(at(&p, 3.9)[7] > 0.99);
        assert!(at(&p, 6.0)[10] < 0.01);
    }

    #[test]
    fn bubble_shrinks_with_the_zoom_about_its_corner() {
        let g = geo(0.7);
        let cam = CameraPath {
            step: STEP_S,
            samples: (0..601).map(|i| [if (120..360).contains(&i) { 1.6 } else { 1.0 }, 0.5, 0.5]).collect(),
        };
        let p = path(&[], &[], Some(&cam), &g, 10.0).unwrap();
        let (wide, zoomed) = (at(&p, 1.0), at(&p, 4.0));
        assert!((wide[7] as f64 - g.bubble.w).abs() < 1e-6);
        assert!((zoomed[7] as f64 - g.bubble.w * 0.7).abs() < 1e-6);
        // Bottom-right corner stays put.
        assert!(((zoomed[5] + zoomed[7]) - (wide[5] + wide[7])).abs() < 1e-6);
        assert!(((zoomed[6] + zoomed[8]) - (wide[6] + wide[8])).abs() < 1e-6);
        // Above 100% the bubble grows instead, still about its corner.
        let big = at(&path(&[], &[], Some(&cam), &geo(1.2), 10.0).unwrap(), 4.0);
        assert!((big[7] as f64 - g.bubble.w * 1.2).abs() < 1e-6);
        assert!(((big[5] + big[7]) - (wide[5] + wide[7])).abs() < 1e-6);
        // No shrink while the webcam is full picture.
        let p = path(&[Scene { start: 3.0, end: 5.5, layout: Layout::FullWebcam }], &[], Some(&cam), &g, 10.0).unwrap();
        assert!(at(&p, 4.0)[7] > 0.99);
    }
}
