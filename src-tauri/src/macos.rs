use objc2::runtime::AnyObject;
use objc2::{msg_send, Encode, Encoding, RefEncode};
use std::sync::atomic::{AtomicBool, Ordering};
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

#[tauri::command]
pub fn make_capture_invisible(app: AppHandle, label: String) -> Result<(), String> {
    let window = app
        .get_webview_window(&label)
        .ok_or_else(|| format!("window not found: {label}"))?;
    let ns_window = window
        .ns_window()
        .map_err(|e| format!("ns_window: {e}"))? as *mut AnyObject;
    if ns_window.is_null() {
        return Err("ns_window is null".into());
    }
    unsafe {
        let _: () = msg_send![ns_window, setSharingType: 0usize];
    }
    Ok(())
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
