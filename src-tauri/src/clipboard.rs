use objc2::class;
use objc2::msg_send;
use objc2::runtime::AnyObject;
use std::ffi::CString;
use std::path::Path;

use crate::composite::Watermark;
use crate::edit;
use crate::exports;

// Write a single fileURL to the macOS general pasteboard. NSURL conforms
// to NSPasteboardWriting since macOS 10.6, so writeObjects: accepts an
// NSArray<NSURL> directly. Slack, Mail, Messages, and Finder all paste
// it as a file attachment / drop — same UX as drag-from-Finder.
//
// Raw msg_send! to stay aligned with macos.rs and avoid pulling
// objc2-app-kit / objc2-foundation.
fn write_url_to_pasteboard(path: &Path) -> Result<(), String> {
    let s = path.to_string_lossy();
    let c_path = CString::new(s.as_ref()).map_err(|e| format!("path → CString: {e}"))?;

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
            return Err(format!("NSURL fileURLWithPath nil for {}", path.display()));
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

        let _: i64 = msg_send![pb, clearContents];
        let ok: bool = msg_send![pb, writeObjects: url_array];
        if !ok {
            return Err("NSPasteboard writeObjects: returned NO".into());
        }
    }
    Ok(())
}

// Phase 6 architecture: Copy to Clipboard does NOT commit the source
// recording. It copies the source mp4 (scratch or final, whichever is
// current) to a stable temp path under the user's Caches dir and points
// the clipboard at that copy. The original recording stays in scratch
// and the user can still Save or Discard it independently.
//
// Source path selection happens in JS (committedPath || sourcePath).
// Stamp is parsed from the path on the JS side and passed in explicitly
// so this command works for both pre-save and post-save sources.
// Plain-text variant — used by the LinkedIn export flow to drop a caption
// template on the pasteboard for paste-into-LinkedIn-post. NSPasteboard
// holds one item that supplies multiple representations; setString:forType:
// with NSPasteboardTypeString (UTI public.utf8-plain-text) is the
// canonical write for plaintext.
#[tauri::command]
pub fn clipboard_copy_text(text: String) -> Result<(), String> {
    let c_text = CString::new(text).map_err(|e| format!("text → CString: {e}"))?;
    let c_type =
        CString::new("public.utf8-plain-text").map_err(|e| format!("type → CString: {e}"))?;

    unsafe {
        let ns_string_cls = class!(NSString);
        let ns_text: *mut AnyObject =
            msg_send![ns_string_cls, stringWithUTF8String: c_text.as_ptr()];
        if ns_text.is_null() {
            return Err("NSString stringWithUTF8String returned nil for text".into());
        }
        let ns_type: *mut AnyObject =
            msg_send![ns_string_cls, stringWithUTF8String: c_type.as_ptr()];
        if ns_type.is_null() {
            return Err("NSString stringWithUTF8String returned nil for type".into());
        }

        let ns_pb_cls = class!(NSPasteboard);
        let pb: *mut AnyObject = msg_send![ns_pb_cls, generalPasteboard];
        if pb.is_null() {
            return Err("NSPasteboard generalPasteboard returned nil".into());
        }

        let _: i64 = msg_send![pb, clearContents];
        let ok: bool = msg_send![pb, setString: ns_text forType: ns_type];
        if !ok {
            return Err("NSPasteboard setString:forType: returned NO".into());
        }
    }
    Ok(())
}

// Phase 11 c2: runs the edit pipeline so the copied mp4 reflects the
// current sidecar (trim + annotations). Source resolution, no GIF tail
// — Copy stays ephemeral (D-15) and doesn't touch ~/Movies/Zeigen.
#[tauri::command]
pub fn clipboard_copy_recording(
    stamp: String,
    source_path: String,
    watermark_logo: Option<String>,
    watermark_corner: Option<String>,
    watermark_scale: Option<f64>,
    watermark_opacity: Option<f64>,
) -> Result<(), String> {
    let source = Path::new(&source_path);
    // Phase 15 c3: see save_recording. The scratch logical key has no
    // file at it for webcam recordings; run_edit_pipeline checks
    // screen_path.is_file() itself and returns a clean error if the
    // raw screen capture is genuinely missing.
    let temp_dir = exports::recording_exports_dir(&stamp)?;
    let file_name = source
        .file_name()
        .ok_or_else(|| format!("source has no filename: {}", source.display()))?;
    let temp_file = temp_dir.join(file_name);
    let sidecar = edit::read_sidecar_path(source)?.unwrap_or_default();
    // Phase 15 c2: composite-at-export. See edit::run_edit_pipeline
    // header for the screen-only vs webcam branching; defaults mirror
    // save_recording (engine_start uses Medium/BottomRight).
    let (screen_path, segments) = edit::export_inputs_from_source(source);
    edit::run_edit_pipeline(
        &screen_path,
        &segments,
        &temp_file,
        &sidecar,
        edit::PipelineMode::Mp4 {
            resolution: edit::Mp4Resolution::Source,
        },
        crate::composite::WebcamSize::Medium,
        crate::composite::Corner::BottomRight,
        Watermark::from_args(watermark_logo, watermark_corner, watermark_scale, watermark_opacity),
        |_| {},
    )?;
    write_url_to_pasteboard(&temp_file)
}
