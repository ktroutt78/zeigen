use objc2::class;
use objc2::msg_send;
use objc2::runtime::AnyObject;
use std::ffi::CString;

// Write a single file URL to the macOS general pasteboard. Slack, Mail,
// Messages, and Finder all paste an NSURL fileURL as an attachment / file
// drop, which is what we want for the Phase 6 "Copy to Clipboard" row.
//
// Raw msg_send! to stay aligned with macos.rs and avoid pulling
// objc2-app-kit / objc2-foundation. NSURL conforms to NSPasteboardWriting
// since macOS 10.6, so writeObjects: accepts an NSArray<NSURL> directly.
#[tauri::command]
pub fn clipboard_copy_file(path: String) -> Result<(), String> {
    let c_path = CString::new(path.as_str()).map_err(|e| format!("path → CString: {e}"))?;

    unsafe {
        let ns_string_cls = class!(NSString);
        let ns_path: *mut AnyObject =
            msg_send![ns_string_cls, stringWithUTF8String: c_path.as_ptr()];
        if ns_path.is_null() {
            return Err("NSString stringWithUTF8String returned nil".into());
        }

        let ns_url_cls = class!(NSURL);
        let file_url: *mut AnyObject = msg_send![ns_url_cls, fileURLWithPath: ns_path];
        if file_url.is_null() {
            return Err(format!("NSURL fileURLWithPath nil for {path}"));
        }

        let ns_array_cls = class!(NSArray);
        let url_array: *mut AnyObject = msg_send![ns_array_cls, arrayWithObject: file_url];
        if url_array.is_null() {
            return Err("NSArray arrayWithObject returned nil".into());
        }

        let ns_pb_cls = class!(NSPasteboard);
        let pb: *mut AnyObject = msg_send![ns_pb_cls, generalPasteboard];
        if pb.is_null() {
            return Err("NSPasteboard generalPasteboard returned nil".into());
        }

        // clearContents returns the new change count (NSInteger). Discard.
        let _: i64 = msg_send![pb, clearContents];

        let ok: bool = msg_send![pb, writeObjects: url_array];
        if !ok {
            return Err("NSPasteboard writeObjects: returned NO".into());
        }
    }
    Ok(())
}
