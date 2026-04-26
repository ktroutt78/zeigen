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

// NSRect on 64-bit macOS is a typedef for CGRect.
type NSRect = CGRect;

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

// Plant a window full-screen on a specific display by CGDirectDisplayID.
// Used by the identify-display overlay so each window lands on its target
// monitor regardless of macOS coordinate-system quirks (negative x for
// screens left of primary, mixed scale factors, etc.). Iterates
// NSScreen.screens, matches by NSScreenNumber, and applies the screen's
// frame via NSWindow.setFrame.
#[tauri::command]
pub fn position_window_on_display(
    app: AppHandle,
    label: String,
    display_id: u32,
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
            return Err("NSScreen.screens returned nil".into());
        }
        let count: usize = msg_send![screens, count];

        let key_cstr = b"NSScreenNumber\0";
        let key: *mut AnyObject =
            msg_send![class!(NSString), stringWithUTF8String: key_cstr.as_ptr() as *const i8];

        for i in 0..count {
            let screen: *mut AnyObject = msg_send![screens, objectAtIndex: i];
            if screen.is_null() {
                continue;
            }
            let device_desc: *mut AnyObject = msg_send![screen, deviceDescription];
            if device_desc.is_null() {
                continue;
            }
            let number: *mut AnyObject = msg_send![device_desc, objectForKey: key];
            if number.is_null() {
                continue;
            }
            let screen_id: u32 = msg_send![number, unsignedIntValue];
            if screen_id == display_id {
                let frame: NSRect = msg_send![screen, frame];
                let _: () = msg_send![ns_window, setFrame: frame display: true animate: false];
                return Ok(());
            }
        }
    }

    Err(format!("display id {display_id} not found in NSScreen.screens"))
}
