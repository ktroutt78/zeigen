mod clipboard;
mod composite;
mod devices;
mod edit;
mod engine;
mod exports;
mod hotkey;
mod linkedin;
mod macos;
mod thumbs;
mod tray;
mod webcam;

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Instant;

use chrono::Local;
use tauri::{AppHandle, Emitter, Listener, Manager, State};

use composite::{Corner, WebcamSize};
use devices::DeviceList;
use edit::BubblePositionEntry;
use engine::{EngineClient, EngineCommand};
use webcam::WebcamSegmenter;

type EngineState<'a> = State<'a, Mutex<EngineClient>>;
type RecordingState<'a> = State<'a, Mutex<Option<ActiveRecording>>>;

struct ActiveRecording {
    stamp: String,
    scratch_dir: PathBuf,
    scratch_mp4_path: PathBuf,
    webcam: Option<WebcamSegmenter>,
    webcam_size: WebcamSize,
    webcam_corner: Corner,
    started_at: Instant,
    mode: CaptureMode,
    bubble_position_log: Vec<BubblePositionEntry>,
    last_logged: Option<(Instant, f64, f64)>,
}

// Display mode pins the capture frame at recording start (the chosen display
// can't move). Window mode tracks the captured window's live bounds via the
// engine's 5Hz window_frame events; frame is None until the first event
// arrives, so the very first bubble samples may no-op while we wait for the
// initial frame. Area mode pins the captured region's screen-space rect
// (display origin + area offset, area size) at recording start. All three
// frames are in logical points in screen space (Phase 8 standardized this
// at the JS->Rust boundary).
enum CaptureMode {
    Display { frame: (i32, i32, u32, u32) },
    // `id` consumed by c8 edge cases (e.g. correlate window-closed errors
    // with the captured window).
    Window { #[allow(dead_code)] id: u32, frame: Option<(i32, i32, u32, u32)> },
    Area { #[allow(dead_code)] display_id: u32, frame: (i32, i32, u32, u32) },
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
#[allow(clippy::too_many_arguments)]
fn engine_start(
    engine: EngineState<'_>,
    recording: RecordingState<'_>,
    display_id: Option<u32>,
    window_id: Option<u32>,
    microphone_uid: Option<String>,
    camera_index: Option<u32>,
    max_fps: Option<u32>,
    webcam_size: Option<String>,
    webcam_corner: Option<String>,
    recorded_display_x: Option<i32>,
    recorded_display_y: Option<i32>,
    recorded_display_w: Option<u32>,
    recorded_display_h: Option<u32>,
    // Phase 9 area capture: display-relative points for the engine.
    // recorded_display_* must hold the SCREEN-SPACE rect of the selected
    // region (display origin + area offset, area size) so the existing
    // bubble_position_event math works unchanged.
    area_x: Option<f64>,
    area_y: Option<f64>,
    area_width: Option<f64>,
    area_height: Option<f64>,
) -> Result<String, String> {
    let area = match (area_x, area_y, area_width, area_height) {
        (Some(x), Some(y), Some(w), Some(h)) => Some((x, y, w, h)),
        (None, None, None, None) => None,
        _ => return Err("area params must all be present or all absent".into()),
    };

    let mode = match (display_id, window_id, area.is_some()) {
        (Some(id), None, true) => CaptureMode::Area {
            display_id: id,
            frame: (
                recorded_display_x.ok_or("recorded_display_x required for area capture")?,
                recorded_display_y.ok_or("recorded_display_y required for area capture")?,
                recorded_display_w.ok_or("recorded_display_w required for area capture")?,
                recorded_display_h.ok_or("recorded_display_h required for area capture")?,
            ),
        },
        (Some(_), None, false) => CaptureMode::Display {
            frame: (
                recorded_display_x.ok_or("recorded_display_x required for display capture")?,
                recorded_display_y.ok_or("recorded_display_y required for display capture")?,
                recorded_display_w.ok_or("recorded_display_w required for display capture")?,
                recorded_display_h.ok_or("recorded_display_h required for display capture")?,
            ),
        },
        (None, Some(id), false) => CaptureMode::Window { id, frame: None },
        (None, None, _) => return Err("must provide display_id or window_id".into()),
        (Some(_), Some(_), _) => {
            return Err("provide exactly one of display_id or window_id".into())
        }
        (None, Some(_), true) => return Err("area capture requires display_id, not window_id".into()),
    };

    let mut active = recording.lock().map_err(|e| e.to_string())?;
    if active.is_some() {
        return Err("recording already in progress".into());
    }

    let stamp = Local::now().format("%Y-%m-%d-%H%M%S").to_string();
    let scratch_root = scratch_root_dir()?;
    let scratch_dir = scratch_root.join(format!("recording-{stamp}"));
    std::fs::create_dir_all(&scratch_dir)
        .map_err(|e| format!("create {}: {}", scratch_dir.display(), e))?;
    let scratch_mp4_path = scratch_dir.join(format!("recording-{stamp}.mp4"));

    let (screen_output, webcam) = if let Some(idx) = camera_index {
        let sources_dir = scratch_dir.join("sources");
        std::fs::create_dir_all(&sources_dir)
            .map_err(|e| format!("create {}: {}", sources_dir.display(), e))?;
        let mut segmenter = WebcamSegmenter::new(idx, sources_dir.clone());
        segmenter.start_segment()?;
        (sources_dir.join("screen.mp4"), Some(segmenter))
    } else {
        (scratch_mp4_path.clone(), None)
    };

    let (area_x_send, area_y_send, area_w_send, area_h_send) = match area {
        Some((x, y, w, h)) => (Some(x), Some(y), Some(w), Some(h)),
        None => (None, None, None, None),
    };

    engine
        .lock()
        .map_err(|e| e.to_string())?
        .send(&EngineCommand::Start {
            display_id,
            window_id,
            microphone_uid,
            output_path: screen_output.to_string_lossy().into_owned(),
            max_fps,
            area_x: area_x_send,
            area_y: area_y_send,
            area_width: area_w_send,
            area_height: area_h_send,
        })?;

    *active = Some(ActiveRecording {
        stamp: stamp.clone(),
        scratch_dir: scratch_dir.clone(),
        scratch_mp4_path: scratch_mp4_path.clone(),
        webcam,
        webcam_size: parse_size(webcam_size.as_deref()),
        webcam_corner: parse_corner(webcam_corner.as_deref()),
        started_at: Instant::now(),
        mode,
        bubble_position_log: Vec::new(),
        last_logged: None,
    });

    Ok(scratch_mp4_path.to_string_lossy().into_owned())
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

// Like recording_reset but does NOT send Stop to the engine. Use when the
// engine has already reported an error (and so already self-reset to idle)
// — sending Stop to an idle engine produces a follow-on INVALID_STATE error
// that overwrites the original. This path only cleans up Rust-side state
// (the active recording handle, the webcam ffmpeg child).
#[tauri::command]
fn recording_cleanup_local(recording: RecordingState<'_>) -> Result<(), String> {
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
    diameter_physical: Option<f64>,
) -> Result<(), String> {
    let mut active = recording.lock().map_err(|e| e.to_string())?;
    let Some(rec) = active.as_mut() else { return Ok(()); };

    // Display: pinned frame from engine_start. Window: latest frame from the
    // engine's 5Hz window_frame stream. The Window None case happens only in
    // the brief window between recording-start and the first window_frame
    // event arriving (~200ms).
    let frame = match &rec.mode {
        CaptureMode::Display { frame } => Some(*frame),
        CaptureMode::Window { frame, .. } => *frame,
        CaptureMode::Area { frame, .. } => Some(*frame),
    };
    let Some((fx, fy, fw, fh)) = frame else { return Ok(()); };
    if fw == 0 || fh == 0 {
        return Ok(());
    }
    // Don't clamp to [0,1]. The composite suppresses out-of-bounds segments
    // entirely (Bug 1 fix); clamping would leak the bubble onto an edge of
    // the recorded display when it's actually on a different monitor — and
    // for window mode, dragging the bubble off the captured window simply
    // shouldn't render in the recording.
    let x_frac = (x_physical - fx as f64) / fw as f64;
    let y_frac = (y_physical - fy as f64) / fh as f64;

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
    rec.bubble_position_log.push(BubblePositionEntry {
        t,
        x: x_frac,
        y: y_frac,
        diameter: diameter_physical,
    });
    rec.last_logged = Some((now, x_frac, y_frac));
    Ok(())
}

#[tauri::command]
fn recording_finalize(
    app: AppHandle,
    recording: RecordingState<'_>,
) -> Result<FinalizedRecording, String> {
    let rec = recording
        .lock()
        .map_err(|e| e.to_string())?
        .take()
        .ok_or("no active recording")?;

    let stamp = rec.stamp;
    let scratch_dir = rec.scratch_dir;
    let scratch_mp4_path = rec.scratch_mp4_path;
    let webcam_size = rec.webcam_size;
    let webcam_corner = rec.webcam_corner;
    let webcam_opt = rec.webcam;
    let bubble_position_log = rec.bubble_position_log;

    let (sources_dir, segments) = if let Some(webcam) = webcam_opt {
        let segments = webcam.segments().to_vec();
        let sources_dir = webcam.sources_dir().to_path_buf();
        let screen_path = sources_dir.join("screen.mp4");

        // Don't bookend with explicit 0.0/1.0 emits — Tauri IPC delivers
        // events out-of-order with command returns, and a 1.0 arriving after
        // the frontend's .finally cleared state would resurrect the modal.
        // The frontend seeds compositeProgress=0 on the `stopped` event and
        // clears it in .finally; ffmpeg's streamed progress fills the middle.
        let progress_app = app.clone();
        composite::composite(
            &screen_path,
            &segments,
            &scratch_mp4_path,
            webcam_size,
            webcam_corner,
            &bubble_position_log,
            move |frac| {
                let _ = progress_app.emit("composite-progress", frac);
            },
        )?;
        (Some(sources_dir), segments)
    } else {
        (None, Vec::new())
    };

    if !bubble_position_log.is_empty() {
        let mut state = edit::read_sidecar_path(&scratch_mp4_path)?.unwrap_or_default();
        state.bubble_position_log = bubble_position_log;
        edit::write_sidecar_path(&scratch_mp4_path, &state)?;
    }

    Ok(FinalizedRecording {
        stamp,
        scratch_dir: scratch_dir.to_string_lossy().into_owned(),
        scratch_mp4_path: scratch_mp4_path.to_string_lossy().into_owned(),
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
    scratch_dir: String,
    scratch_mp4_path: String,
    sources_dir: Option<String>,
    webcam_segments: Vec<String>,
    composited: bool,
}

fn movies_dir() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME not set".to_string())?;
    Ok(PathBuf::from(home).join("Movies/Zeigen"))
}

// App-launch safety net for scratch dirs orphaned by a crash or force-quit
// mid-session. Phase 11 keeps the scratch alive across saves until the
// review window closes, so a clean exit always sweeps its own dir — this
// just covers the unclean case. Best-effort; failures are silent.
fn sweep_stale_scratch() {
    let root = match movies_dir().map(|d| d.join(".scratch")) {
        Ok(p) => p,
        Err(_) => return,
    };
    if !root.exists() {
        return;
    }
    thumbs::sweep_dir_older_than(&root, std::time::Duration::from_secs(24 * 60 * 60));
}

// Scratch root: ~/Movies/Zeigen/.scratch. Each recording gets its own
// subdirectory containing the composited mp4, sidecar, and raw source
// files. Discard removes the whole subdirectory; commit moves the mp4 out
// and removes the subdirectory.
fn scratch_root_dir() -> Result<PathBuf, String> {
    let dir = movies_dir()?.join(".scratch");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("create {}: {}", dir.display(), e))?;
    Ok(dir)
}

// Defense against a malformed/spoofed scratch path. Any commit/discard
// operation must work against a real subtree of ~/Movies/Zeigen/.scratch
// — canonicalize both sides so symlinks and `..` segments can't escape.
fn validate_scratch_path(p: &std::path::Path) -> Result<(), String> {
    let canon = p
        .canonicalize()
        .map_err(|e| format!("canonicalize {}: {e}", p.display()))?;
    let root = scratch_root_dir()?
        .canonicalize()
        .map_err(|e| format!("canonicalize scratch root: {e}"))?;
    if !canon.starts_with(&root) {
        return Err(format!("path not under scratch root: {}", p.display()));
    }
    Ok(())
}

// Destructive: removes the entire scratch directory (mp4 + sidecar + raw
// sources) plus the matching exports temp dir under ~/Library/Caches.
// Idempotent: callable repeatedly while the scratch is gone (e.g. after the
// review window already closed). Phase 6's iPhone-screenshot semantics route
// every "this recording is going away" event through here — Discard, close
// window, "Record another."
#[tauri::command]
fn discard_recording(scratch_mp4_path: String) -> Result<(), String> {
    let scratch_mp4 = PathBuf::from(&scratch_mp4_path);
    let scratch_dir = scratch_mp4
        .parent()
        .ok_or_else(|| format!("scratch mp4 has no parent: {}", scratch_mp4.display()))?
        .to_path_buf();

    // Stamp is parsed from the dir name string — no filesystem access
    // required, so we can clean exports even after the scratch dir was
    // removed by a prior commit_recording.
    let stamp = stamp_from_scratch_dir_name(&scratch_dir);

    if scratch_dir.exists() {
        validate_scratch_path(&scratch_dir)?;
        std::fs::remove_dir_all(&scratch_dir)
            .map_err(|e| format!("remove scratch {}: {e}", scratch_dir.display()))?;
    }

    if let Some(s) = stamp {
        let _ = exports::cleanup_recording_exports_internal(&s);
    }
    Ok(())
}

fn stamp_from_scratch_dir_name(dir: &std::path::Path) -> Option<String> {
    let name = dir.file_name()?.to_str()?;
    name.strip_prefix("recording-").map(String::from)
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
        .plugin(tauri_plugin_dialog::init())
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

            // Resolve the bundled RNNoise model and hand its path to the
            // edit module. arnndn fires on every MP4 save; missing model
            // surfaces as a clear ffmpeg error rather than silent skip.
            match handle.path().resource_dir() {
                Ok(resource_dir) => {
                    let model_path = resource_dir.join("resources/audio/rnnoise.rnnn");
                    if !model_path.exists() {
                        eprintln!(
                            "audio model missing at {} — MP4 saves will fail",
                            model_path.display()
                        );
                    }
                    edit::set_audio_model_path(model_path);
                }
                Err(e) => eprintln!("resource_dir lookup failed: {e}"),
            }
            if let Err(e) = hotkey::register_default(&handle) {
                eprintln!("hotkey register failed: {e}");
            }
            // Sweep stale per-recording exports left over from prior runs
            // that crashed or force-quit before per-session cleanup ran.
            exports::sweep_stale_exports();
            thumbs::sweep_stale_thumbs();
            sweep_stale_scratch();

            // Tap engine-event window_frame messages into the active
            // recording's CaptureMode so bubble_position_event can convert
            // physical coords into fractions of the window's *current*
            // bounds (5Hz from the engine).
            let handle_for_wf = handle.clone();
            handle.listen("engine-event", move |event| {
                let Ok(value) = serde_json::from_str::<serde_json::Value>(event.payload())
                else {
                    return;
                };
                if value.get("event").and_then(|v| v.as_str()) != Some("window_frame") {
                    return;
                }
                let Some(x) = value.get("x").and_then(|v| v.as_i64()) else { return };
                let Some(y) = value.get("y").and_then(|v| v.as_i64()) else { return };
                let Some(w) = value.get("width").and_then(|v| v.as_i64()) else { return };
                let Some(h) = value.get("height").and_then(|v| v.as_i64()) else { return };
                if w <= 0 || h <= 0 {
                    return;
                }
                let state = handle_for_wf.state::<Mutex<Option<ActiveRecording>>>();
                // Bind the lock guard in the same scope as `state` so its
                // drop order is well-defined (the if-let expression form
                // produces a temporary with a too-long lifetime here).
                let Ok(mut active) = state.lock() else { return };
                if let Some(rec) = active.as_mut() {
                    if let CaptureMode::Window { frame, .. } = &mut rec.mode {
                        *frame = Some((x as i32, y as i32, w as u32, h as u32));
                    }
                }
            });
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
            recording_cleanup_local,
            recording_finalize,
            update_tray_state,
            update_tray_elapsed,
            set_hotkey,
            quit_app,
            macos::make_capture_invisible,
            macos::set_window_frame_cg,
            bubble_position_event,
            edit::read_sidecar,
            edit::write_sidecar,
            edit::delete_sidecar,
            edit::save_recording,
            edit::probe_audio_track,
            edit::render_preview_audio,
            thumbs::extract_thumb_sprite,
            discard_recording,
            clipboard::clipboard_copy_recording,
            clipboard::clipboard_copy_text,
            exports::cleanup_recording_exports,
            linkedin::linkedin_export,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
