use std::str::FromStr;
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

pub const DEFAULT_HOTKEY: &str = "CmdOrCtrl+Shift+P";

pub struct HotkeyState(pub Mutex<Option<Shortcut>>);

pub fn handler<R: Runtime>(app: &AppHandle<R>, shortcut: &Shortcut, event_state: ShortcutState) {
    if event_state != ShortcutState::Pressed {
        return;
    }
    let active = app
        .state::<crate::tray::TrayState>()
        .0
        .lock()
        .expect("tray state mutex")
        .recording_state
        .clone();
    let _ = app.emit(
        "hotkey-toggle",
        serde_json::json!({
            "shortcut": shortcut.into_string(),
            "state": active,
        }),
    );
}

pub fn register_default<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let shortcut = parse(DEFAULT_HOTKEY)?;
    app.global_shortcut()
        .register(shortcut.clone())
        .map_err(|e| e.to_string())?;
    app.manage(HotkeyState(Mutex::new(Some(shortcut))));
    Ok(())
}

// Swap the hotkey. If the new one can't be registered (taken by macOS or
// another app), the previous one is registered again and stays current.
pub fn rebind<R: Runtime>(app: &AppHandle<R>, combo: &str) -> Result<(), String> {
    let new_shortcut = parse(combo)?;
    let state = app.state::<HotkeyState>();
    let mut guard = state.0.lock().expect("hotkey state mutex");
    let shortcuts = app.global_shortcut();
    if let Some(prev) = guard.as_ref() {
        let _ = shortcuts.unregister(*prev);
    }
    if let Err(e) = shortcuts.register(new_shortcut) {
        if let Some(prev) = guard.as_ref() {
            let _ = shortcuts.register(*prev);
        }
        return Err(e.to_string());
    }
    *guard = Some(new_shortcut);
    Ok(())
}

// Settings' "press keys" recorder: the current hotkey must not start a
// recording while the user presses a new combination (and macOS would swallow
// that keypress before the webview saw it), so it is unregistered for the
// capture and registered again afterwards. Both are idempotent.
#[tauri::command]
pub fn hotkey_pause(app: AppHandle) {
    let state = app.state::<HotkeyState>();
    let guard = state.0.lock().expect("hotkey state mutex");
    if let Some(s) = guard.as_ref() {
        let _ = app.global_shortcut().unregister(*s);
    }
}

#[tauri::command]
pub fn hotkey_resume(app: AppHandle) -> Result<(), String> {
    let state = app.state::<HotkeyState>();
    let guard = state.0.lock().expect("hotkey state mutex");
    match guard.as_ref() {
        Some(s) if !app.global_shortcut().is_registered(*s) => {
            app.global_shortcut().register(*s).map_err(|e| e.to_string())
        }
        _ => Ok(()),
    }
}

fn parse(combo: &str) -> Result<Shortcut, String> {
    Shortcut::from_str(combo).map_err(|e| format!("invalid shortcut '{combo}': {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    // The formats the Settings recorder writes (src/hotkey.ts) must parse.
    #[test]
    fn recorder_combos_parse() {
        for c in [
            DEFAULT_HOTKEY,
            "Ctrl+Alt+F5",
            "F5",
            "Alt+Shift+5",
            "CmdOrCtrl+Space",
            "Ctrl+ArrowUp",
            "CmdOrCtrl+Shift+Minus",
            "Alt+BracketLeft",
            "Shift+CmdOrCtrl+P",
            "Ctrl+Alt+Shift+CmdOrCtrl+KeyZ",
        ] {
            assert!(parse(c).is_ok(), "{c}");
        }
    }
}
