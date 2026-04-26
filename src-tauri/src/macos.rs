use objc2::msg_send;
use objc2::runtime::AnyObject;
use objc2::{class, Encode, Encoding, RefEncode};
use tauri::{AppHandle, Manager};

#[repr(C)]
#[derive(Copy, Clone, Debug)]
struct CGPoint {
    x: f64,
    y: f64,
}

unsafe impl Encode for CGPoint {
    const ENCODING: Encoding =
        Encoding::Struct("CGPoint", &[f64::ENCODING, f64::ENCODING]);
}
unsafe impl RefEncode for CGPoint {
    const ENCODING_REF: Encoding = Encoding::Pointer(&Self::ENCODING);
}

#[repr(C)]
#[derive(Copy, Clone, Debug)]
struct CGSize {
    width: f64,
    height: f64,
}

unsafe impl Encode for CGSize {
    const ENCODING: Encoding =
        Encoding::Struct("CGSize", &[f64::ENCODING, f64::ENCODING]);
}
unsafe impl RefEncode for CGSize {
    const ENCODING_REF: Encoding = Encoding::Pointer(&Self::ENCODING);
}

#[repr(C)]
#[derive(Copy, Clone, Debug)]
struct CGRect {
    origin: CGPoint,
    size: CGSize,
}

unsafe impl Encode for CGRect {
    const ENCODING: Encoding =
        Encoding::Struct("CGRect", &[CGPoint::ENCODING, CGSize::ENCODING]);
}
unsafe impl RefEncode for CGRect {
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

// Plant a window with a specific Cocoa-points frame.
// The TS caller passes CG (top-left origin, Y down) coordinates from the
// engine's SCDisplay frame; we convert to Cocoa (bottom-left origin, Y up)
// using the primary screen's height and call NSWindow.setFrame.
// Bypasses Tauri's TS WebviewWindow constructor x/y, which silently drops
// negative coords on macOS (breaks identify overlays for screens left of
// the primary).
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
    let ns_window = window
        .ns_window()
        .map_err(|e| format!("ns_window: {e}"))? as *mut AnyObject;
    if ns_window.is_null() {
        return Err("ns_window is null".into());
    }

    unsafe {
        let screens: *mut AnyObject = msg_send![class!(NSScreen), screens];
        if screens.is_null() {
            return Err("NSScreen.screens nil".into());
        }
        let count: usize = msg_send![screens, count];
        if count == 0 {
            return Err("no screens".into());
        }
        let primary: *mut AnyObject = msg_send![screens, objectAtIndex: 0usize];
        if primary.is_null() {
            return Err("primary screen nil".into());
        }
        let primary_frame: CGRect = msg_send![primary, frame];

        let frame = CGRect {
            origin: CGPoint {
                x: cg_x,
                y: primary_frame.size.height - cg_y - height,
            },
            size: CGSize { width, height },
        };
        let display_views: bool = true;
        let _: () = msg_send![ns_window, setFrame: frame display: display_views];
    }
    Ok(())
}
