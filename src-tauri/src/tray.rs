use std::sync::Mutex;

use serde::Deserialize;
use tauri::{
    image::Image,
    menu::{CheckMenuItemBuilder, Menu, MenuBuilder, MenuItemBuilder, SubmenuBuilder},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, Runtime,
};

const TRAY_ID: &str = "main-tray";
const ICON_BYTES: &[u8] = include_bytes!("../icons/32x32.png");

#[derive(Debug, Clone, Default, Deserialize)]
pub struct UiState {
    pub recording_state: String,
    #[serde(default)]
    pub displays: Vec<DisplayItem>,
    #[serde(default)]
    pub mics: Vec<MicItem>,
    #[serde(default)]
    pub cameras: Vec<CameraItem>,
    pub selected_display: Option<u32>,
    pub selected_mic: Option<String>,
    pub selected_camera: Option<u32>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct DisplayItem {
    pub id: u32,
    pub name: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct MicItem {
    pub uid: String,
    pub name: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CameraItem {
    pub index: u32,
    pub name: String,
}

pub struct TrayState(pub Mutex<UiState>);

pub fn setup<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    app.manage(TrayState(Mutex::new(UiState::default())));

    let menu = build_menu(app, &UiState::default())?;
    let icon = Image::from_bytes(ICON_BYTES)?;

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .icon_as_template(true)
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| {
            handle_menu_click(app, event.id.as_ref());
        })
        .build(app)?;

    Ok(())
}

pub fn rebuild<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let state = app
        .state::<TrayState>()
        .0
        .lock()
        .expect("tray state mutex")
        .clone();
    let menu = build_menu(app, &state)?;
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        tray.set_menu(Some(menu))?;
        let title: Option<&str> = match state.recording_state.as_str() {
            "recording" => Some("● Rec"),
            "paused" => Some("⏸"),
            _ => None,
        };
        tray.set_title(title)?;
    }
    Ok(())
}

fn handle_menu_click<R: Runtime>(app: &AppHandle<R>, id: &str) {
    match id {
        "settings" => {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
                let _ = win.set_focus();
            }
            let _ = app.emit("tray-action", serde_json::json!({ "action": "settings" }));
        }
        "quit" => {
            app.exit(0);
        }
        other => {
            let _ = app.emit("tray-action", serde_json::json!({ "id": other }));
        }
    }
}

fn build_menu<R: Runtime>(app: &AppHandle<R>, state: &UiState) -> tauri::Result<Menu<R>> {
    let recording = state.recording_state == "recording";
    let paused = state.recording_state == "paused";
    let active = recording || paused;

    let start = MenuItemBuilder::with_id("start", "Start Recording")
        .accelerator("CmdOrCtrl+Shift+R")
        .enabled(!active && state.selected_display.is_some())
        .build(app)?;
    let stop = MenuItemBuilder::with_id("stop", "Stop Recording")
        .accelerator("CmdOrCtrl+Shift+R")
        .enabled(active)
        .build(app)?;
    let pause = MenuItemBuilder::with_id("pause", "Pause")
        .enabled(recording)
        .build(app)?;
    let resume = MenuItemBuilder::with_id("resume", "Resume")
        .enabled(paused)
        .build(app)?;

    let mut cam_sub = SubmenuBuilder::new(app, "Camera");
    let cam_none = CheckMenuItemBuilder::with_id("cam:none", "No webcam")
        .checked(state.selected_camera.is_none())
        .enabled(!active)
        .build(app)?;
    cam_sub = cam_sub.item(&cam_none);
    for cam in &state.cameras {
        let id = format!("cam:{}", cam.index);
        let item = CheckMenuItemBuilder::with_id(&id, &cam.name)
            .checked(state.selected_camera == Some(cam.index))
            .enabled(!active)
            .build(app)?;
        cam_sub = cam_sub.item(&item);
    }
    let cam_sub = cam_sub.build()?;

    let mut mic_sub = SubmenuBuilder::new(app, "Microphone");
    let mic_none = CheckMenuItemBuilder::with_id("mic:none", "No microphone")
        .checked(state.selected_mic.is_none())
        .enabled(!active)
        .build(app)?;
    mic_sub = mic_sub.item(&mic_none);
    for mic in &state.mics {
        let id = format!("mic:{}", mic.uid);
        let item = CheckMenuItemBuilder::with_id(&id, &mic.name)
            .checked(state.selected_mic.as_deref() == Some(&mic.uid))
            .enabled(!active)
            .build(app)?;
        mic_sub = mic_sub.item(&item);
    }
    let mic_sub = mic_sub.build()?;

    let mut screen_sub = SubmenuBuilder::new(app, "Screen");
    for disp in &state.displays {
        let id = format!("disp:{}", disp.id);
        let item = CheckMenuItemBuilder::with_id(&id, &disp.name)
            .checked(state.selected_display == Some(disp.id))
            .enabled(!active)
            .build(app)?;
        screen_sub = screen_sub.item(&item);
    }
    let screen_sub = screen_sub.build()?;

    let settings = MenuItemBuilder::with_id("settings", "Settings…")
        .accelerator("CmdOrCtrl+,")
        .build(app)?;
    let quit = MenuItemBuilder::with_id("quit", "Quit Zeigen")
        .accelerator("CmdOrCtrl+Q")
        .build(app)?;

    MenuBuilder::new(app)
        .item(&start)
        .item(&stop)
        .item(&pause)
        .item(&resume)
        .separator()
        .item(&cam_sub)
        .item(&mic_sub)
        .item(&screen_sub)
        .separator()
        .item(&settings)
        .separator()
        .item(&quit)
        .build()
}
