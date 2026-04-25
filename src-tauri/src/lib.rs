mod composite;
mod devices;
mod edit;
mod engine;
mod hotkey;
mod macos;
mod tray;
mod webcam;

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Instant;

use chrono::Local;
use tauri::{AppHandle, Manager, State};

use composite::{Corner, WebcamSize};
use devices::DeviceList;
use edit::BubblePositionEntry;
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
    started_at: Instant,
    display_frame_physical: (i32, i32, u32, u32),
    bubble_position_log: Vec<BubblePositionEntry>,
    last_logged: Option<(Instant, f64, f64)>,
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
    recorded_display_x: i32,
    recorded_display_y: i32,
    recorded_display_w: u32,
    recorded_display_h: u32,
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
        started_at: Instant::now(),
        display_frame_physical: (
            recorded_display_x,
            recorded_display_y,
            recorded_display_w,
            recorded_display_h,
        ),
        bubble_position_log: Vec::new(),
        last_logged: None,
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
fn bubble_position_event(
    recording: RecordingState<'_>,
    x_physical: f64,
    y_physical: f64,
) -> Result<(), String> {
    let mut active = recording.lock().map_err(|e| e.to_string())?;
    let Some(rec) = active.as_mut() else { return Ok(()); };

    let (fx, fy, fw, fh) = rec.display_frame_physical;
    if fw == 0 || fh == 0 {
        return Ok(());
    }
    let x_frac = ((x_physical - fx as f64) / fw as f64).clamp(0.0, 1.0);
    let y_frac = ((y_physical - fy as f64) / fh as f64).clamp(0.0, 1.0);

    let now = Instant::now();
    if let Some((last_when, last_x, last_y)) = rec.last_logged {
        let dx = (x_frac - last_x).abs();
        let dy = (y_frac - last_y).abs();
        let pos_moved = dx > 0.02 || dy > 0.02;
        let elapsed_ms = now.duration_since(last_when).as_millis();
        if !pos_moved && elapsed_ms <= 250 {
            return Ok(());
        }
    }

    let t = now.duration_since(rec.started_at).as_secs_f64();
    rec.bubble_position_log
        .push(BubblePositionEntry { t, x: x_frac, y: y_frac });
    rec.last_logged = Some((now, x_frac, y_frac));
    Ok(())
}

#[tauri::command]
fn recording_finalize(recording: RecordingState<'_>) -> Result<FinalizedRecording, String> {
    let rec = recording
        .lock()
        .map_err(|e| e.to_string())?
        .take()
        .ok_or("no active recording")?;

    let stamp = rec.stamp;
    let final_path = rec.final_path;
    let webcam_size = rec.webcam_size;
    let webcam_corner = rec.webcam_corner;
    let webcam_opt = rec.webcam;
    let bubble_position_log = rec.bubble_position_log;

    let (sources_dir, segments) = if let Some(webcam) = webcam_opt {
        let segments = webcam.segments().to_vec();
        let sources_dir = webcam.sources_dir().to_path_buf();
        let screen_path = sources_dir.join("screen.mp4");

        composite::composite(
            &screen_path,
            &segments,
            &final_path,
            webcam_size,
            webcam_corner,
            &bubble_position_log,
        )?;
        (Some(sources_dir), segments)
    } else {
        (None, Vec::new())
    };

    if !bubble_position_log.is_empty() {
        let mut state = edit::read_sidecar_path(&final_path)?.unwrap_or_default();
        state.bubble_position_log = bubble_position_log;
        edit::write_sidecar_path(&final_path, &state)?;
    }

    Ok(FinalizedRecording {
        stamp,
        final_path: final_path.to_string_lossy().into_owned(),
        sources_dir: sources_dir.map(|p| p.to_string_lossy().into_owned()),
        webcam_segments: segments
            .into_iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect(),
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
fn update_tray_elapsed(app: AppHandle, elapsed_s: f64) -> Result<(), String> {
    tray::set_elapsed(&app, elapsed_s).map_err(|e| e.to_string())
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
            update_tray_elapsed,
            set_hotkey,
            quit_app,
            macos::make_capture_invisible,
            bubble_position_event,
            edit::read_sidecar,
            edit::write_sidecar,
            edit::delete_sidecar,
            edit::edit_save,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
