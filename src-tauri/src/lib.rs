mod composite;
mod devices;
mod engine;
mod hotkey;
mod tray;
mod webcam;

use std::path::PathBuf;
use std::sync::Mutex;

use chrono::Local;
use tauri::{AppHandle, Manager, State};

use composite::{Corner, WebcamSize};
use devices::DeviceList;
use engine::{EngineClient, EngineCommand};
use webcam::WebcamSegmenter;

type EngineState<'a> = State<'a, Mutex<EngineClient>>;
type RecordingState<'a> = State<'a, Mutex<Option<ActiveRecording>>>;

struct ActiveRecording {
    stamp: String,
    final_path: PathBuf,
    webcam: Option<WebcamSegmenter>,
    webcam_size: WebcamSize,
    webcam_corner: Corner,
}

#[tauri::command]
fn enumerate_devices() -> Result<DeviceList, String> {
    devices::enumerate()
}

#[tauri::command]
fn engine_enumerate(state: EngineState<'_>) -> Result<(), String> {
    state
        .lock()
        .map_err(|e| e.to_string())?
        .send(&EngineCommand::Enumerate)
}

#[tauri::command]
fn engine_start(
    engine: EngineState<'_>,
    recording: RecordingState<'_>,
    display_id: u32,
    microphone_uid: Option<String>,
    camera_index: Option<u32>,
    max_fps: Option<u32>,
    webcam_size: Option<String>,
    webcam_corner: Option<String>,
) -> Result<String, String> {
    let mut active = recording.lock().map_err(|e| e.to_string())?;
    if active.is_some() {
        return Err("recording already in progress".into());
    }

    let stamp = Local::now().format("%Y-%m-%d-%H%M%S").to_string();
    let movies_dir = movies_dir()?;
    std::fs::create_dir_all(&movies_dir)
        .map_err(|e| format!("create {}: {}", movies_dir.display(), e))?;
    let final_path = movies_dir.join(format!("recording-{stamp}.mp4"));

    let (screen_output, webcam) = if let Some(idx) = camera_index {
        let sources_dir = movies_dir
            .join(".sources")
            .join(format!("recording-{stamp}"));
        std::fs::create_dir_all(&sources_dir)
            .map_err(|e| format!("create {}: {}", sources_dir.display(), e))?;
        let mut segmenter = WebcamSegmenter::new(idx, sources_dir.clone());
        segmenter.start_segment()?;
        (sources_dir.join("screen.mp4"), Some(segmenter))
    } else {
        (final_path.clone(), None)
    };

    engine
        .lock()
        .map_err(|e| e.to_string())?
        .send(&EngineCommand::Start {
            display_id,
            microphone_uid,
            output_path: screen_output.to_string_lossy().into_owned(),
            max_fps,
        })?;

    *active = Some(ActiveRecording {
        stamp: stamp.clone(),
        final_path: final_path.clone(),
        webcam,
        webcam_size: parse_size(webcam_size.as_deref()),
        webcam_corner: parse_corner(webcam_corner.as_deref()),
    });

    Ok(final_path.to_string_lossy().into_owned())
}

fn parse_size(s: Option<&str>) -> WebcamSize {
    match s {
        Some("small") => WebcamSize::Small,
        Some("large") => WebcamSize::Large,
        _ => WebcamSize::Medium,
    }
}

fn parse_corner(s: Option<&str>) -> Corner {
    match s {
        Some("tl") => Corner::TopLeft,
        Some("tr") => Corner::TopRight,
        Some("bl") => Corner::BottomLeft,
        _ => Corner::BottomRight,
    }
}

#[tauri::command]
fn engine_pause(
    engine: EngineState<'_>,
    recording: RecordingState<'_>,
) -> Result<(), String> {
    engine
        .lock()
        .map_err(|e| e.to_string())?
        .send(&EngineCommand::Pause)?;
    if let Some(rec) = recording.lock().map_err(|e| e.to_string())?.as_mut() {
        if let Some(webcam) = rec.webcam.as_mut() {
            webcam.stop_segment()?;
        }
    }
    Ok(())
}

#[tauri::command]
fn engine_resume(
    engine: EngineState<'_>,
    recording: RecordingState<'_>,
) -> Result<(), String> {
    engine
        .lock()
        .map_err(|e| e.to_string())?
        .send(&EngineCommand::Resume)?;
    if let Some(rec) = recording.lock().map_err(|e| e.to_string())?.as_mut() {
        if let Some(webcam) = rec.webcam.as_mut() {
            webcam.start_segment()?;
        }
    }
    Ok(())
}

#[tauri::command]
fn engine_stop(
    engine: EngineState<'_>,
    recording: RecordingState<'_>,
) -> Result<(), String> {
    engine
        .lock()
        .map_err(|e| e.to_string())?
        .send(&EngineCommand::Stop)?;
    if let Some(rec) = recording.lock().map_err(|e| e.to_string())?.as_mut() {
        if let Some(webcam) = rec.webcam.as_mut() {
            webcam.stop_segment()?;
        }
    }
    Ok(())
}

#[tauri::command]
fn recording_reset(
    engine: EngineState<'_>,
    recording: RecordingState<'_>,
) -> Result<(), String> {
    let _ = engine
        .lock()
        .map_err(|e| e.to_string())?
        .send(&EngineCommand::Stop);
    if let Some(mut rec) = recording.lock().map_err(|e| e.to_string())?.take() {
        if let Some(webcam) = rec.webcam.as_mut() {
            let _ = webcam.stop_segment();
        }
    }
    Ok(())
}

#[tauri::command]
fn recording_finalize(recording: RecordingState<'_>) -> Result<FinalizedRecording, String> {
    let rec = recording
        .lock()
        .map_err(|e| e.to_string())?
        .take()
        .ok_or("no active recording")?;

    if let Some(webcam) = rec.webcam {
        let segments = webcam.segments().to_vec();
        let sources_dir = webcam.sources_dir().to_path_buf();
        let screen_path = sources_dir.join("screen.mp4");

        composite::composite(
            &screen_path,
            &segments,
            &rec.final_path,
            rec.webcam_size,
            rec.webcam_corner,
        )?;

        return Ok(FinalizedRecording {
            stamp: rec.stamp,
            final_path: rec.final_path.to_string_lossy().into_owned(),
            sources_dir: Some(sources_dir.to_string_lossy().into_owned()),
            webcam_segments: segments
                .into_iter()
                .map(|p| p.to_string_lossy().into_owned())
                .collect(),
            composited: true,
        });
    }

    Ok(FinalizedRecording {
        stamp: rec.stamp,
        final_path: rec.final_path.to_string_lossy().into_owned(),
        sources_dir: None,
        webcam_segments: Vec::new(),
        composited: true,
    })
}

#[derive(serde::Serialize)]
struct FinalizedRecording {
    stamp: String,
    final_path: String,
    sources_dir: Option<String>,
    webcam_segments: Vec<String>,
    composited: bool,
}

fn movies_dir() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME not set".to_string())?;
    Ok(PathBuf::from(home).join("Movies/Zeigen"))
}

#[tauri::command]
fn update_tray_state(app: AppHandle, state: tray::UiState) -> Result<(), String> {
    *app.state::<tray::TrayState>()
        .0
        .lock()
        .expect("tray state mutex") = state;
    tray::rebuild(&app).map_err(|e| e.to_string())
}

#[tauri::command]
fn set_hotkey(app: AppHandle, combo: String) -> Result<(), String> {
    hotkey::rebind(&app, &combo)
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    hotkey::handler(app, shortcut, event.state());
                })
                .build(),
        )
        .setup(|app: &mut tauri::App| {
            let handle: AppHandle = app.handle().clone();
            let client = EngineClient::spawn(&handle, engine::engine_binary_path())?;
            app.manage(Mutex::new(client));
            app.manage(Mutex::new(None::<ActiveRecording>));
            tray::setup(&handle)?;
            if let Err(e) = hotkey::register_default(&handle) {
                eprintln!("hotkey register failed: {e}");
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            enumerate_devices,
            engine_enumerate,
            engine_start,
            engine_pause,
            engine_resume,
            engine_stop,
            recording_reset,
            recording_finalize,
            update_tray_state,
            set_hotkey,
            quit_app,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
