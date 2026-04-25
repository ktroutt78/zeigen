use objc2::msg_send;
use objc2::runtime::AnyObject;
use tauri::{AppHandle, Manager};

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
