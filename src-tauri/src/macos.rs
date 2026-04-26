use objc2::msg_send;
use objc2::runtime::AnyObject;
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager};

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

// Position + resize a window in CG logical coords (origin top-left of
// primary, Y down — matches the engine's SCDisplay frame). Routes through
// Tauri's Rust set_position/set_size which on macOS handle negative x for
// screens left of the primary, where the TS WebviewWindow constructor
// silently drops them.
#[tauri::command]
pub fn set_window_frame_cg(
    app: AppHandle,
    label: String,
    cg_x: f64,
    cg_y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let window = app
        .get_webview_window(&label)
        .ok_or_else(|| format!("window not found: {label}"))?;
    window
        .set_position(LogicalPosition::new(cg_x, cg_y))
        .map_err(|e| format!("set_position: {e}"))?;
    window
        .set_size(LogicalSize::new(width, height))
        .map_err(|e| format!("set_size: {e}"))?;
    Ok(())
}
