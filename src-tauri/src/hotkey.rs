use std::str::FromStr;
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

pub const DEFAULT_HOTKEY: &str = "CmdOrCtrl+Shift+R";

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

pub fn rebind<R: Runtime>(app: &AppHandle<R>, combo: &str) -> Result<(), String> {
    let new_shortcut = parse(combo)?;
    let state = app.state::<HotkeyState>();
    let mut guard = state.0.lock().expect("hotkey state mutex");
    if let Some(prev) = guard.take() {
        let _ = app.global_shortcut().unregister(prev);
    }
    app.global_shortcut()
        .register(new_shortcut.clone())
        .map_err(|e| e.to_string())?;
    *guard = Some(new_shortcut);
    Ok(())
}

fn parse(combo: &str) -> Result<Shortcut, String> {
    Shortcut::from_str(combo).map_err(|e| format!("invalid shortcut '{combo}': {e}"))
}
