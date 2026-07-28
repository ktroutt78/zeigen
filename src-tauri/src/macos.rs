use objc2::runtime::AnyObject;
use objc2::{class, msg_send, sel, Encode, Encoding, RefEncode};
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
// DIAGNOSTIC PROBES (activation / priming-click investigation, branch
// activation-priming-click). Read-only measurement of why the window picker
// overlay needs a physical click before hover works. NOT a fix — these log to
// stderr and change no behavior. Remove before merge.
// ---------------------------------------------------------------------------

// Diagnostic sink: append to a fixed file so the app can be launched NORMALLY
// (Finder/Dock) — where its own TCC grants apply and device enumeration works —
// while still capturing probe output. Launching from a shell makes Terminal the
// responsible process and breaks Screen Recording/Camera/Mic, so stderr capture
// isn't usable here. Delete /tmp/zeigen-focus-probe.log before a run for a clean
// file. Also echoes to stderr (harmless, useful if ever run from a shell).
const PROBE_LOG: &str = "/tmp/zeigen-focus-probe.log";
fn probe_log(line: &str) {
    use std::io::Write;
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let stamped = format!("{ts} {line}");
    eprintln!("{stamped}");
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(PROBE_LOG)
    {
        let _ = writeln!(f, "{stamped}");
    }
}

// Read the live activation/key state for one window and log it with a tag so
// the owner can correlate lines across the mount timeline (0ms / 100ms /
// first-move) and across per-display overlays. level + collectionBehavior are
// logged to close the door on window-level / all-spaces eligibility even though
// tao's canBecomeKeyWindow ignores them.
#[tauri::command]
pub fn focus_probe(app: AppHandle, label: String, tag: String) -> Result<(), String> {
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
        let ns_app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
        let is_active: bool = msg_send![ns_app, isActive];
        let is_key: bool = msg_send![ns_window, isKeyWindow];
        let level: isize = msg_send![ns_window, level];
        let behavior: usize = msg_send![ns_window, collectionBehavior];
        probe_log(&format!(
            "[focus-probe] {label} tag={tag} isActive={is_active} isKey={is_key} level={level} collectionBehavior=0x{behavior:x}"
        ));
    }
    Ok(())
}

// The honest test of item 3: does ANY activation path the OS still honors from
// the background make the overlay key? Logs before-state, calls the MODERN
// non-deprecated NSApplication.activate (falling back to activateIgnoringOtherApps
// only if the runtime lacks the selector), then makeKeyAndOrderFront, then logs
// the immediate after-state. Activation lands on the next runloop, so the JS
// side re-probes at +100ms for the settled value.
#[tauri::command]
pub fn try_activate_probe(app: AppHandle, label: String) -> Result<(), String> {
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
        let ns_app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
        let before_active: bool = msg_send![ns_app, isActive];
        let before_key: bool = msg_send![ns_window, isKeyWindow];

        let has_modern: bool = msg_send![ns_app, respondsToSelector: sel!(activate)];
        if has_modern {
            let _: () = msg_send![ns_app, activate];
        } else {
            let _: () = msg_send![ns_app, activateIgnoringOtherApps: true];
        }
        let nil: *mut AnyObject = std::ptr::null_mut();
        let _: () = msg_send![ns_window, makeKeyAndOrderFront: nil];

        let after_active: bool = msg_send![ns_app, isActive];
        let after_key: bool = msg_send![ns_window, isKeyWindow];
        probe_log(&format!(
            "[try-activate] {label} path={} before(isActive={before_active},isKey={before_key}) after(isActive={after_active},isKey={after_key})",
            if has_modern { "NSApplication.activate" } else { "activateIgnoringOtherApps" }
        ));
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

// Slice-1 verification sink (throttled positions + every click + start/stop).
// Removed with the probes in Slice 4.
const POLLER_LOG: &str = "/tmp/zeigen-picker-poller.log";
fn poller_log(line: &str) {
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(POLLER_LOG)
    {
        let _ = writeln!(f, "{line}");
    }
}

#[tauri::command]
pub fn picker_cursor_start(app: AppHandle) {
    // Idempotent: stop any prior thread first, so a re-open (or a missed stop)
    // can never leave two 60 Hz timers running.
    picker_cursor_stop();
    POLLER_RUN.store(true, Ordering::SeqCst);
    poller_log("[poller] start");
    let handle = std::thread::spawn(move || {
        let mut last_click =
            unsafe { CGEventSourceCounterForEventType(CG_COMBINED_SESSION_STATE, CG_EVENT_LEFT_MOUSE_DOWN) };
        let mut tick: u64 = 0;
        while POLLER_RUN.load(Ordering::SeqCst) {
            let loc = unsafe {
                let e = CGEventCreate(std::ptr::null_mut());
                let p = CGEventGetLocation(e);
                if !e.is_null() {
                    CFRelease(e as CFTypeRef); // CGEventCreate returns +1; release or leak at 60 Hz
                }
                p
            };
            let _ = app.emit("picker-cursor", (loc.x, loc.y));

            let c = unsafe {
                CGEventSourceCounterForEventType(CG_COMBINED_SESSION_STATE, CG_EVENT_LEFT_MOUSE_DOWN)
            };
            if c != last_click {
                last_click = c;
                let _ = app.emit("picker-click", (loc.x, loc.y));
                poller_log(&format!("[poller] click x={:.1} y={:.1}", loc.x, loc.y));
            }
            if tick % 15 == 0 {
                poller_log(&format!("[poller] pos x={:.1} y={:.1}", loc.x, loc.y));
            }
            tick += 1;
            std::thread::sleep(Duration::from_millis(16));
        }
        poller_log("[poller] loop exited");
    });
    *poller_slot().lock().unwrap() = Some(handle);
}

#[tauri::command]
pub fn picker_cursor_stop() {
    let was_running = POLLER_RUN.swap(false, Ordering::SeqCst);
    // take() drops the guard before join(), so start()'s re-lock can't deadlock.
    if let Some(h) = poller_slot().lock().unwrap().take() {
        let _ = h.join();
    }
    if was_running {
        poller_log("[poller] stop");
    }
}
