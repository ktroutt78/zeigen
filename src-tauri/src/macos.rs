use objc2::runtime::AnyObject;
use objc2::{class, msg_send, Encode, Encoding, RefEncode};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::sync::{Mutex, OnceLock};
use std::thread::JoinHandle;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

#[repr(C)]
#[derive(Copy, Clone)]
struct NSPoint {
    x: f64,
    y: f64,
}

unsafe impl Encode for NSPoint {
    const ENCODING: Encoding =
        Encoding::Struct("CGPoint", &[f64::ENCODING, f64::ENCODING]);
}
unsafe impl RefEncode for NSPoint {
    const ENCODING_REF: Encoding = Encoding::Pointer(&Self::ENCODING);
}

#[repr(C)]
#[derive(Copy, Clone)]
struct NSSize {
    width: f64,
    height: f64,
}

unsafe impl Encode for NSSize {
    const ENCODING: Encoding =
        Encoding::Struct("CGSize", &[f64::ENCODING, f64::ENCODING]);
}
unsafe impl RefEncode for NSSize {
    const ENCODING_REF: Encoding = Encoding::Pointer(&Self::ENCODING);
}

#[repr(C)]
#[derive(Copy, Clone)]
struct NSRect {
    origin: NSPoint,
    size: NSSize,
}

unsafe impl Encode for NSRect {
    const ENCODING: Encoding =
        Encoding::Struct("CGRect", &[NSPoint::ENCODING, NSSize::ENCODING]);
}
unsafe impl RefEncode for NSRect {
    const ENCODING_REF: Encoding = Encoding::Pointer(&Self::ENCODING);
}

// Plant a window with CG-coords frame, given the primary screen's Cocoa
// height (passed from TS via Tauri's monitors API). Tauri's own
// set_position drops negative x on macOS for screens left of primary, so
// we use the underlying NSWindow.setFrameOrigin: directly with the
// Cocoa-flipped Y. Size goes through Tauri's set_size which doesn't have
// the negative-coord problem.
#[tauri::command]
pub fn set_window_frame_cg(
    app: AppHandle,
    label: String,
    cg_x: f64,
    cg_y: f64,
    width: f64,
    height: f64,
    primary_cocoa_height: f64,
) -> Result<(), String> {
    let window = app
        .get_webview_window(&label)
        .ok_or_else(|| format!("window not found: {label}"))?;
    let ns_window = window
        .ns_window()
        .map_err(|e| format!("ns_window: {e}"))? as *mut AnyObject;
    if ns_window.is_null() {
        return Err("ns_window is null".into());
    }

    // setFrame:display: takes the full NSRect (Cocoa coords) and applies
    // origin + size atomically — no scale-factor confusion from two-step
    // setFrameOrigin + set_size where the resize runs on the wrong screen.
    let frame = NSRect {
        origin: NSPoint {
            x: cg_x,
            y: primary_cocoa_height - cg_y - height,
        },
        size: NSSize { width, height },
    };
    unsafe {
        let _: () = msg_send![ns_window, setFrame: frame display: true];
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// WINDOW-PICKER CURSOR POLLER (Slice 1, docs/WINDOW-PICKER-POLLER-PLAN.md)
//
// Drives picker hover/select WITHOUT any key window, so the per-display
// overlays never fight over key (the key-steal root cause, DECISIONS
// 2026-07-28). Permission-free: CGEventGetLocation(CGEventCreate(nil)) for the
// global cursor position and CGEventSourceCounterForEventType deltas for clicks
// -- the same session-state family CursorTracker uses (NOT a global monitor,
// which is silently dead on macOS 26 without Input Monitoring). Coordinates are
// global CG points (top-left origin), matching the display frames the overlays
// are positioned with; each overlay self-maps global -> local in Slice 2.
// ---------------------------------------------------------------------------

type CFTypeRef = *const std::os::raw::c_void;
type CGEventRef = *mut std::os::raw::c_void;
type CGEventSourceRef = *mut std::os::raw::c_void;

#[repr(C)]
struct CGPointFFI {
    x: f64,
    y: f64,
}

// kCGEventSourceStateCombinedSessionState = 0; kCGEventLeftMouseDown = 1.
const CG_COMBINED_SESSION_STATE: i32 = 0;
const CG_EVENT_LEFT_MOUSE_DOWN: u32 = 1;

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGEventCreate(source: CGEventSourceRef) -> CGEventRef;
    fn CGEventGetLocation(event: CGEventRef) -> CGPointFFI;
    fn CGEventSourceCounterForEventType(state_id: i32, event_type: u32) -> u32;
}
#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFRelease(cf: CFTypeRef);
}

static POLLER_RUN: AtomicBool = AtomicBool::new(false);
static POLLER_THREAD: OnceLock<Mutex<Option<JoinHandle<()>>>> = OnceLock::new();
fn poller_slot() -> &'static Mutex<Option<JoinHandle<()>>> {
    POLLER_THREAD.get_or_init(|| Mutex::new(None))
}

#[tauri::command]
pub fn picker_cursor_start(app: AppHandle) {
    // Idempotent: stop any prior thread first, so a re-open (or a missed stop)
    // can never leave two 60 Hz timers running.
    picker_cursor_stop();
    POLLER_RUN.store(true, Ordering::SeqCst);
    let handle = std::thread::spawn(move || {
        let mut last_click =
            unsafe { CGEventSourceCounterForEventType(CG_COMBINED_SESSION_STATE, CG_EVENT_LEFT_MOUSE_DOWN) };
        // On-change throttle: a stationary cursor emits nothing. At 60 Hz across
        // three overlays that would be ~180 no-op messages/sec. Clicks still
        // emit every time (they are events, not state).
        let mut last_pos: Option<(f64, f64)> = None;
        while POLLER_RUN.load(Ordering::SeqCst) {
            let loc = unsafe {
                let e = CGEventCreate(std::ptr::null_mut());
                let p = CGEventGetLocation(e);
                if !e.is_null() {
                    CFRelease(e as CFTypeRef); // CGEventCreate returns +1; release or leak at 60 Hz
                }
                p
            };
            let pos = (loc.x, loc.y);
            if last_pos != Some(pos) {
                last_pos = Some(pos);
                let _ = app.emit("picker-cursor", pos);
            }

            let c = unsafe {
                CGEventSourceCounterForEventType(CG_COMBINED_SESSION_STATE, CG_EVENT_LEFT_MOUSE_DOWN)
            };
            if c != last_click {
                last_click = c;
                let _ = app.emit("picker-click", pos);
            }
            std::thread::sleep(Duration::from_millis(16));
        }
    });
    *poller_slot().lock().unwrap() = Some(handle);
}

#[tauri::command]
pub fn picker_cursor_stop() {
    POLLER_RUN.store(false, Ordering::SeqCst);
    // take() drops the guard before join(), so start()'s re-lock can't deadlock.
    if let Some(h) = poller_slot().lock().unwrap().take() {
        let _ = h.join();
    }
}

// ---------------------------------------------------------------------------
// WEBCAM BUBBLE TOOLBAR
//
// The shape / size pill shown above the floating bubble before recording is a
// second small window (label bubble-toolbar), attached to the bubble as an
// NSWindow child so AppKit moves it with the bubble while it is dragged. The
// bubble window's own geometry, drag and position log are untouched.
//
// Hover comes from the global cursor position compared with the two window
// frames, not from DOM mouse events: macOS sends mouseMoved/entered only to
// the key window, and the bubble is almost never key (the app being recorded
// is). NSEvent.mouseLocation is permission-free and in the same Cocoa screen
// coordinates as NSWindow.frame, so no conversion is needed. The poller runs
// only while the toolbar window exists, which App.tsx limits to idle (closed
// at Start, during the countdown and while recording).
// ---------------------------------------------------------------------------

const BUBBLE_LABEL: &str = "webcam-bubble";
const TOOLBAR_LABEL: &str = "bubble-toolbar";
// Points between the bubble window's edge and the toolbar window's.
const TOOLBAR_GAP: f64 = 2.0;
// NSWindowOrderingMode NSWindowAbove.
const NS_WINDOW_ABOVE: isize = 1;

fn ns_window_of(app: &AppHandle, label: &str) -> Option<*mut AnyObject> {
    let w = app.get_webview_window(label)?;
    let p = w.ns_window().ok()? as *mut AnyObject;
    (!p.is_null()).then_some(p)
}

unsafe fn frame_of(w: *mut AnyObject) -> NSRect {
    msg_send![w, frame]
}

// The visible part (no menu bar / Dock) of the screen the window is on.
unsafe fn visible_frame_of(w: *mut AnyObject) -> Option<NSRect> {
    let screen: *mut AnyObject = msg_send![w, screen];
    if screen.is_null() {
        return None;
    }
    Some(msg_send![screen, visibleFrame])
}

fn contains(r: NSRect, p: NSPoint) -> bool {
    p.x >= r.origin.x
        && p.x < r.origin.x + r.size.width
        && p.y >= r.origin.y
        && p.y < r.origin.y + r.size.height
}

// Where the toolbar goes for a bubble frame: centred above it, or below it
// when the screen has no room above; kept inside the screen sideways. Cocoa
// coordinates (y up). Pure, so it is unit-tested.
fn toolbar_origin(bubble: NSRect, toolbar: NSSize, visible: NSRect) -> NSPoint {
    let max_x = (visible.origin.x + visible.size.width - toolbar.width).max(visible.origin.x);
    let x = (bubble.origin.x + bubble.size.width / 2.0 - toolbar.width / 2.0).clamp(visible.origin.x, max_x);
    let above = bubble.origin.y + bubble.size.height + TOOLBAR_GAP;
    let y = if above + toolbar.height <= visible.origin.y + visible.size.height {
        above
    } else {
        bubble.origin.y - TOOLBAR_GAP - toolbar.height
    };
    NSPoint { x, y }
}

// New bubble window frame for a new size. The bubble's circle sits at the top
// of its window and is as wide as the window. The circle keeps the corner
// nearest the screen's corner fixed (bottom-right stays bottom-right), so a
// bubble parked in a corner stays parked there. Pure, unit-tested.
fn resized_bubble(old: NSRect, width: f64, height: f64, visible: NSRect) -> NSRect {
    let top = old.origin.y + old.size.height;
    let cx = old.origin.x + old.size.width / 2.0;
    let cy = top - old.size.width / 2.0;
    let keep_right = cx > visible.origin.x + visible.size.width / 2.0;
    let keep_bottom = cy < visible.origin.y + visible.size.height / 2.0;
    let x = if keep_right { old.origin.x + old.size.width - width } else { old.origin.x };
    let new_top = if keep_bottom { top - old.size.width + width } else { top };
    NSRect { origin: NSPoint { x, y: new_top - height }, size: NSSize { width, height } }
}

#[tauri::command]
pub fn place_bubble_toolbar(app: AppHandle) {
    let (Some(b), Some(t)) = (ns_window_of(&app, BUBBLE_LABEL), ns_window_of(&app, TOOLBAR_LABEL)) else {
        return;
    };
    unsafe {
        let bf = frame_of(b);
        let tf = frame_of(t);
        let vis = visible_frame_of(b).unwrap_or(bf);
        let origin = toolbar_origin(bf, tf.size, vis);
        let _: () = msg_send![t, setFrameOrigin: origin];
    }
}

// Called by the toolbar window once it is up: make it the bubble's child (so
// it follows drags) and put it in place.
#[tauri::command]
pub fn attach_bubble_toolbar(app: AppHandle) {
    let (Some(b), Some(t)) = (ns_window_of(&app, BUBBLE_LABEL), ns_window_of(&app, TOOLBAR_LABEL)) else {
        return;
    };
    unsafe {
        let _: () = msg_send![b, addChildWindow: t, ordered: NS_WINDOW_ABOVE];
    }
    place_bubble_toolbar(app);
}

// Resize the floating bubble to an S / M / L size (width = circle diameter,
// height adds the pill strip; both from the frontend's constants).
#[tauri::command]
pub fn resize_bubble(app: AppHandle, width: f64, height: f64) -> Result<(), String> {
    let b = ns_window_of(&app, BUBBLE_LABEL).ok_or("bubble window not found")?;
    unsafe {
        let old = frame_of(b);
        let vis = visible_frame_of(b).unwrap_or(old);
        let frame = resized_bubble(old, width, height, vis);
        let _: () = msg_send![b, setFrame: frame display: true];
    }
    place_bubble_toolbar(app);
    Ok(())
}

static HOVER_GEN: AtomicU64 = AtomicU64::new(0);

// Emits "bubble-hover" [over_bubble, over_toolbar] to the toolbar window when
// either changes, ~30 times a second. Stops on bubble_hover_stop, on the next
// start, or by itself once the toolbar window is gone.
#[tauri::command]
pub fn bubble_hover_start(app: AppHandle) {
    let gen = HOVER_GEN.fetch_add(1, Ordering::SeqCst) + 1;
    std::thread::spawn(move || {
        let last = std::sync::Arc::new(AtomicU8::new(u8::MAX));
        while HOVER_GEN.load(Ordering::SeqCst) == gen && app.get_webview_window(TOOLBAR_LABEL).is_some() {
            let (a, last) = (app.clone(), last.clone());
            // AppKit window state is read on the main thread.
            let _ = app.run_on_main_thread(move || {
                let (Some(b), Some(t)) = (ns_window_of(&a, BUBBLE_LABEL), ns_window_of(&a, TOOLBAR_LABEL)) else {
                    return;
                };
                let (over_b, over_t) = unsafe {
                    let p: NSPoint = msg_send![class!(NSEvent), mouseLocation];
                    (contains(frame_of(b), p), contains(frame_of(t), p))
                };
                let code = over_b as u8 | (over_t as u8) << 1;
                if last.swap(code, Ordering::SeqCst) != code {
                    let _ = a.emit_to(TOOLBAR_LABEL, "bubble-hover", (over_b, over_t));
                }
            });
            std::thread::sleep(Duration::from_millis(33));
        }
    });
}

#[tauri::command]
pub fn bubble_hover_stop() {
    HOVER_GEN.fetch_add(1, Ordering::SeqCst);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x: f64, y: f64, w: f64, h: f64) -> NSRect {
        NSRect { origin: NSPoint { x, y }, size: NSSize { width: w, height: h } }
    }
    const SCREEN: NSRect = NSRect {
        origin: NSPoint { x: 0.0, y: 0.0 },
        size: NSSize { width: 1512.0, height: 945.0 },
    };

    #[test]
    fn toolbar_sits_centred_above_the_bubble() {
        let o = toolbar_origin(rect(1000.0, 100.0, 240.0, 290.0), NSSize { width: 220.0, height: 44.0 }, SCREEN);
        assert_eq!((o.x, o.y), (1010.0, 100.0 + 290.0 + TOOLBAR_GAP));
    }

    #[test]
    fn toolbar_goes_below_when_no_room_above() {
        let o = toolbar_origin(rect(1000.0, 640.0, 240.0, 290.0), NSSize { width: 220.0, height: 44.0 }, SCREEN);
        assert_eq!(o.y, 640.0 - TOOLBAR_GAP - 44.0);
    }

    #[test]
    fn toolbar_stays_on_screen_sideways() {
        let o = toolbar_origin(rect(1400.0, 100.0, 180.0, 230.0), NSSize { width: 220.0, height: 44.0 }, SCREEN);
        assert_eq!(o.x, 1512.0 - 220.0);
    }

    #[test]
    fn resize_keeps_the_bottom_right_corner_of_the_circle() {
        // Medium (240 + 50 strip) parked bottom-right -> Large (320 + 50).
        let old = rect(1248.0, -26.0, 240.0, 290.0); // circle bottom at y = 24
        let new = resized_bubble(old, 320.0, 370.0, SCREEN);
        assert_eq!(new.origin.x + new.size.width, 1488.0); // right edge kept
        assert_eq!(new.origin.y + new.size.height - 320.0, 24.0); // circle bottom kept
    }

    #[test]
    fn resize_keeps_the_top_left_corner_of_the_circle() {
        let old = rect(24.0, 945.0 - 24.0 - 290.0, 240.0, 290.0);
        let new = resized_bubble(old, 180.0, 230.0, SCREEN);
        assert_eq!(new.origin.x, 24.0);
        assert_eq!(new.origin.y + new.size.height, 945.0 - 24.0);
    }
}
