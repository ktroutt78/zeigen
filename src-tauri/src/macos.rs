use objc2::runtime::AnyObject;
use objc2::{class, msg_send, sel, Encode, Encoding, RefEncode};
use tauri::{AppHandle, Manager};

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
