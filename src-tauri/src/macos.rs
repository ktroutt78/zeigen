use objc2::msg_send;
use objc2::runtime::AnyObject;
use objc2::{Encode, Encoding, RefEncode};
use tauri::{AppHandle, LogicalSize, Manager};

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

    window
        .set_size(LogicalSize::new(width, height))
        .map_err(|e| format!("set_size: {e}"))?;

    let ns_window = window
        .ns_window()
        .map_err(|e| format!("ns_window: {e}"))? as *mut AnyObject;
    if ns_window.is_null() {
        return Err("ns_window is null".into());
    }

    let origin = NSPoint {
        x: cg_x,
        y: primary_cocoa_height - cg_y - height,
    };
    unsafe {
        let _: () = msg_send![ns_window, setFrameOrigin: origin];
    }
    Ok(())
}
