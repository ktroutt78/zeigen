mod clipboard;
mod composite;
mod devices;
mod edit;
mod engine;
mod exports;
mod hotkey;
mod library;
mod macos;
mod settings;
mod storage;
mod thumbs;
mod tray;
mod wallpapers;
mod webcam;
mod camera;
mod scene;
mod cursor;
mod zoom;

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Instant;

use chrono::Local;
use tauri::{AppHandle, Listener, Manager, State};

use composite::{Corner, WebcamSize};
use devices::DeviceList;
use edit::BubblePositionEntry;
use engine::{EngineClient, EngineCommand};
use webcam::WebcamRecorder;

type EngineState<'a> = State<'a, Mutex<EngineClient>>;
type RecordingState<'a> = State<'a, Mutex<Option<ActiveRecording>>>;

struct ActiveRecording {
    stamp: String,
    scratch_dir: PathBuf,
    scratch_mp4_path: PathBuf,
    webcam: Option<WebcamRecorder>,
    // Bubble size (S / M / L) at Start: the remembered setting unless the
    // caller passes one. Stamped into the sidecar at finalize (bubble_size).
    webcam_size: WebcamSize,
    // Phase 15 c3: webcam_corner isn't read by finalize anymore (composite
    // moved to export). Kept so engine_start keeps parsing the API contract.
    #[allow(dead_code)]
    webcam_corner: Corner,
    started_at: Instant,
    // Phase 15 #4 fix: wall-clock instant when SCK delivered its first
    // screen sample (engine emits first_frame; engine.rs captures this).
    // recording_finalize uses (first_frame_at - started_at) as the SCK
    // init lag and shifts bubble_position_log entries by that delta so
    // each entry's t corresponds to screen.mp4 PTS=0 instead of the
    // earlier engine_start invocation time. None means the engine
    // didn't emit (old binary / event lost) — finalize falls back to
    // no shift, preserving pre-fix behavior.
    first_frame_at: Option<Instant>,
    // Host-clock seconds of screen.mp4's time zero (engine first_frame
    // host_s). With the webcam's own first-frame host time it gives the
    // measured webcam lead at finalize.
    screen_host_s: Option<f64>,
    mode: CaptureMode,
    bubble_position_log: Vec<BubblePositionEntry>,
    // Bubble roundness preference captured at recording start (None =
    // circle). Stamped into the sidecar at finalize alongside the position
    // log so the recording keeps the shape it was made with even if the
    // preference changes later.
    bubble_roundness: Option<f64>,
    // What was recorded ("<app> - <title> (Window)" etc.), built by the main
    // window at Record. Stamped into the sidecar at finalize.
    name: Option<String>,
    // Some(chosen library) when the recording is staged in the default library
    // because the Save to folder is on another volume; finalize moves it there.
    move_to: Option<PathBuf>,
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
    camera_name: Option<String>,
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
    name: Option<String>,
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
    // Where the recording is made (storage.rs): the Save to folder's library,
    // or the default library when that folder is unavailable (the main window
    // has already warned) or on another volume (moved there at finalize).
    let plan = storage::record_plan(&storage::default_root()?, storage::chosen().as_deref(), &storage::home()?);
    let scratch_dir = plan.library.join(format!("recording-{stamp}"));
    std::fs::create_dir_all(&scratch_dir)
        .map_err(|e| format!("create {}: {}", scratch_dir.display(), e))?;
    if plan.move_to.is_some() {
        std::fs::write(scratch_dir.join(storage::PENDING_MOVE), b"")
            .map_err(|e| format!("mark {}: {e}", scratch_dir.display()))?;
    }
    let scratch_mp4_path = scratch_dir.join(format!("recording-{stamp}.mp4"));
    // Declared before the webcam recorder so that, on an early return, the
    // recorder is dropped (stopped) first and the folder removed after.
    let mut failed_start = DiscardTake(Some(scratch_dir.clone()));

    let (screen_output, webcam) = if let Some(name) = camera_name {
        let sources_dir = scratch_dir.join("sources");
        std::fs::create_dir_all(&sources_dir)
            .map_err(|e| format!("create {}: {}", sources_dir.display(), e))?;
        let recorder = WebcamRecorder::start(&name, sources_dir.clone())?;
        (sources_dir.join("screen.mp4"), Some(recorder))
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
            // The engine leaves the cursor OUT of the video and writes a
            // hidden .cursor.json (position, clicks, shapes) next to the
            // scratch mp4; the export draws the cursor from it
            // (CURSOR-SMOOTHING-PLAN).
            capture_cursor: true,
        })?;

    failed_start.0 = None;
    *active = Some(ActiveRecording {
        stamp: stamp.clone(),
        scratch_dir: scratch_dir.clone(),
        scratch_mp4_path: scratch_mp4_path.clone(),
        webcam,
        webcam_size: webcam_size
            .as_deref()
            .map(|s| parse_size(Some(s)))
            .unwrap_or_else(settings::bubble_size),
        webcam_corner: parse_corner(webcam_corner.as_deref()),
        started_at: Instant::now(),
        first_frame_at: None,
        screen_host_s: None,
        mode,
        bubble_position_log: Vec::new(),
        bubble_roundness: settings::bubble_roundness(),
        name,
        move_to: plan.move_to,
        last_logged: None,
    });

    Ok(scratch_mp4_path.to_string_lossy().into_owned())
}

// Phase 15 #4 fix: called by engine.rs stdout reader when the Swift
// engine emits first_frame for the screen stream. Stamps the active
// recording's first_frame_at with the receipt instant — IPC latency
// over the line-buffered pipe is ~1-5ms, negligible vs the 225-360ms
// SCK init lag measured during verification. Idempotent: only writes
// the first time.
pub(crate) fn note_screen_first_frame(app: &AppHandle, host_s: Option<f64>) {
    let now = Instant::now();
    let state = app.state::<Mutex<Option<ActiveRecording>>>();
    let mutex = state.inner();
    if let Ok(mut guard) = mutex.lock() {
        if let Some(rec) = guard.as_mut() {
            if rec.first_frame_at.is_none() {
                rec.first_frame_at = Some(now);
                rec.screen_host_s = host_s;
            }
        }
    }
}

// Called by engine.rs when the engine emits `resumed`: the webcam recorder
// resumes with the engine's total paused time, so it cuts exactly what the
// screen file cut.
pub(crate) fn note_engine_resumed(app: &AppHandle, paused_total_s: f64) {
    let state = app.state::<Mutex<Option<ActiveRecording>>>();
    if let Ok(mut guard) = state.inner().lock() {
        if let Some(webcam) = guard.as_mut().and_then(|rec| rec.webcam.as_mut()) {
            if let Err(e) = webcam.resume(paused_total_s) {
                eprintln!("{e}");
            }
        }
    }
}

fn parse_size(s: Option<&str>) -> WebcamSize {
    match s {
        Some("small") => WebcamSize::Small,
        Some("large") => WebcamSize::Large,
        _ => WebcamSize::Medium,
    }
}

fn parse_corner(s: Option<&str>) -> Corner {
    s.map(Corner::from_code).unwrap_or(Corner::BottomRight)
}

#[tauri::command]
fn mic_monitor(engine: EngineState<'_>, microphone_uid: Option<String>) -> Result<(), String> {
    engine
        .lock()
        .map_err(|e| e.to_string())?
        .send(&EngineCommand::MicMonitor { microphone_uid })
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
            webcam.pause()?;
        }
    }
    Ok(())
}

#[tauri::command]
fn engine_resume(engine: EngineState<'_>) -> Result<(), String> {
    // The webcam resumes in note_engine_resumed, once the engine has said
    // how much time its pauses have cut.
    engine
        .lock()
        .map_err(|e| e.to_string())?
        .send(&EngineCommand::Resume)
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
            webcam.stop()?;
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
        .send(&EngineCommand::Cancel);
    if let Some(mut rec) = recording.lock().map_err(|e| e.to_string())?.take() {
        if let Some(webcam) = rec.webcam.as_mut() {
            let _ = webcam.stop();
        }
        // A cancelled countdown: the armed take never began, so its folder goes.
        drop(DiscardTake(Some(rec.scratch_dir.clone())));
    }
    Ok(())
}

// The countdown has ended: begin writing. engine_start armed the screen
// stream, the mic and the camera; nothing was written until now.
#[tauri::command]
fn engine_go(engine: EngineState<'_>, recording: RecordingState<'_>) -> Result<(), String> {
    engine
        .lock()
        .map_err(|e| e.to_string())?
        .send(&EngineCommand::Go)?;
    if let Some(rec) = recording.lock().map_err(|e| e.to_string())?.as_mut() {
        if let Some(webcam) = rec.webcam.as_mut() {
            webcam.go()?;
        }
    }
    Ok(())
}

// Like recording_reset but does NOT send Stop to the engine. Use when the
// engine has already reported an error (and so already self-reset to idle)
// — sending Stop to an idle engine produces a follow-on INVALID_STATE error
// that overwrites the original. This path only cleans up Rust-side state
// (the active recording handle, the webcam recorder child).
// A take that fails before it starts leaves nothing behind: the folder made
// for it (a webcam clip, the pending-move marker) is removed when this drops
// while still holding the path.
struct DiscardTake(Option<PathBuf>);

impl Drop for DiscardTake {
    fn drop(&mut self) {
        if let Some(dir) = self.0.take() {
            let _ = std::fs::remove_dir_all(dir);
        }
    }
}

#[tauri::command]
fn recording_cleanup_local(recording: RecordingState<'_>) -> Result<(), String> {
    if let Some(mut rec) = recording.lock().map_err(|e| e.to_string())?.take() {
        if let Some(webcam) = rec.webcam.as_mut() {
            let _ = webcam.stop();
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
        // Store as a fraction of frame width (like x/y), so it resolves to the
        // right pixel size against any capture resolution. diameter_physical and
        // fw are both logical points here — their ratio is the frame fraction.
        diameter_frac: diameter_physical.map(|d| d / fw as f64),
    });
    rec.last_logged = Some((now, x_frac, y_frac));
    Ok(())
}

// Async so the move to an external drive (a copy) runs off the main thread.
#[tauri::command]
async fn recording_finalize(
    // AppHandle retained for the IPC contract; composite-progress emits
    // happened here pre-Phase-15 c3, but the composite moved to export.
    _app: AppHandle,
    recording: RecordingState<'_>,
) -> Result<FinalizedRecording, String> {
    let rec = recording
        .lock()
        .map_err(|e| e.to_string())?
        .take()
        .ok_or("no active recording")?;
    let move_to = rec.move_to.clone();

    let stamp = rec.stamp;
    let scratch_dir = rec.scratch_dir;
    let scratch_mp4_path = rec.scratch_mp4_path;
    let webcam_opt = rec.webcam;
    let started_at = rec.started_at;
    let first_frame_at = rec.first_frame_at;
    let screen_host_s = rec.screen_host_s;
    let bubble_position_log = rec.bubble_position_log;
    let bubble_roundness = rec.bubble_roundness;
    let bubble_size = rec.webcam_size;
    let name = rec.name;
    // The export sizes the bubble from the logged diameter (the floating
    // bubble's real size), not from webcam_size; bubble_size is a label for
    // Review's S / M / L control.

    // c3 outputs: the dual-stream player needs screen_path + optional
    // webcam_path. Both None for screen-only recordings (in which case
    // scratch_mp4_path itself IS the screen capture). Populated below.
    let mut screen_for_dual: Option<PathBuf> = None;
    let mut webcam_for_dual: Option<PathBuf> = None;
    // Measured webcam lead (ms): how long after screen.mp4's time zero the
    // webcam file's frame 0 was captured. Negative = the webcam started first.
    // None when either side did not report its host time; the constant stands in.
    let mut measured_lead_ms: Option<f64> = None;

    let sources_dir = if let Some(mut webcam) = webcam_opt {
        // Idempotently finalize the live webcam segment before reading it.
        // On a normal stop, engine_stop already stopped it (take() -> None,
        // no-op). On the MIC_SESSION_FAILED salvage path the engine never
        // received Stop, so this is where the partial last segment's mp4 is
        // finalized — making recording_finalize self-sufficient either way.
        let _ = webcam.stop();
        if let (Some(w), Some(s)) = (webcam.first_host_s(), screen_host_s) {
            measured_lead_ms = Some((w - s) * 1000.0);
        }
        let sources_dir = webcam.sources_dir().to_path_buf();
        let screen_path = sources_dir.join("screen.mp4");

        // V2.3 c3.S1: bail if the engine never wrote screen capture.
        // AVAssetWriter only opens the output file when startWriting()
        // runs, which requires both first-audio + first-video samples
        // (RecordingSession.swift:677-687). When the AVCaptureSession
        // runtime-error observer fires in the pre-writer-start window
        // (iPhone Continuity device conflict, USB mic disconnect during
        // init), the engine emits MIC_SESSION_FAILED but screen.mp4 never
        // exists. Returning Ok with a non-existent screen_path opens a
        // dead review window — the friendly "saved up to that point"
        // banner is a lie. Bail BEFORE concat so we don't leave an orphan
        // webcam.mp4 in scratch; webcam recorder child is reaped via
        // WebcamRecorder::Drop when `rec` goes out of scope on Err
        // return, and the take's folder is removed here (DiscardTake).
        if !screen_path.is_file() {
            drop(DiscardTake(Some(scratch_dir)));
            return Err("RECORDING_FAILED_BEFORE_START".into());
        }

        // Phase 15 c3: finalize composite removed. The screen + concat'd
        // webcam.mp4 + sidecar (with bubble keyframes) are the dual-stream
        // player's inputs; composite now runs at export time per
        // run_edit_pipeline. Stop -> preview is near-instant regardless of
        // recording length — the long wait users saw on 10+ min clips was
        // this composite pass.
        screen_for_dual = Some(screen_path);
        let webcam_path = sources_dir.join("webcam.mp4");
        if webcam_path.is_file() {
            webcam_for_dual = Some(webcam_path);
        }
        Some(sources_dir)
    } else {
        // Screen-only: no sources/ dir. The "screen path" is
        // scratch_mp4_path itself (engine wrote screen capture directly
        // there per engine_start's screen_output branch). webcam absent.
        //
        // V2.3 c3.S1: same pre-writer-start bail as the webcam branch —
        // a mic-only recording (no camera) still has the AVAssetWriter
        // writing to scratch_mp4_path, so the same missing-file signal
        // means the engine never reached startWriting().
        if !scratch_mp4_path.is_file() {
            drop(DiscardTake(Some(scratch_dir)));
            return Err("RECORDING_FAILED_BEFORE_START".into());
        }
        None
    };

    // Phase 15 #4 fix: shift bubble_position_log entries by the SCK
    // init lag so each entry's t corresponds to screen.mp4 PTS=0 (the
    // first SCK frame) instead of started_at (the engine_start IPC
    // invocation, which precedes SCK by 225-360ms per measurement
    // 2026-06-07). Composite + preview both read the resulting sidecar
    // — single source of truth, no divergence (option B-unified).
    // Entries before time zero collapse to the bubble's position at zero.
    //
    // Fallback when first_frame_at is None (old engine binary, event
    // lost): no shift applied, log written as-is. Identical to pre-fix
    // behavior. No regression.
    let bubble_position_log: Vec<BubblePositionEntry> = if let Some(ff) = first_frame_at {
        let sck_lag = ff.duration_since(started_at).as_secs_f64();
        // The recording is armed for the whole countdown, so the bubble's
        // position at time zero is the last one logged before it.
        let mut at_zero: Option<BubblePositionEntry> = None;
        let mut shifted = Vec::new();
        for e in bubble_position_log {
            let t = e.t - sck_lag;
            if t < 0.0 {
                at_zero = Some(BubblePositionEntry { t: 0.0, ..e });
            } else {
                shifted.push(BubblePositionEntry { t, ..e });
            }
        }
        at_zero.into_iter().chain(shifted).collect()
    } else {
        bubble_position_log
    };

    // Sidecar lives adjacent to scratch_mp4_path regardless of whether
    // a file actually exists there (the path is the logical recording
    // identity — Phase 5.5 lifecycle key). Frontend's read_sidecar still
    // takes sourcePath = scratch_mp4_path; backend resolves the adjacent
    // .annotations.json without needing scratch_mp4_path itself on disk.
    if !bubble_position_log.is_empty() || measured_lead_ms.is_some() || name.is_some() {
        let mut state = edit::read_sidecar_path(&scratch_mp4_path)?.unwrap_or_default();
        state.bubble_position_log = bubble_position_log;
        state.webcam_lead_ms = measured_lead_ms;
        // Roundness captured at recording start (already normalized: None =
        // circle). Stamped here so the recording keeps the shape it was made
        // with; the export side reads only the sidecar, never the setting.
        state.bubble_roundness = bubble_roundness;
        // The S / M / L the bubble was recorded at, only with a bubble and
        // only when not Medium (absent = Medium, as for older recordings).
        state.bubble_size = Some(bubble_size)
            .filter(|s| *s != WebcamSize::Medium && !state.bubble_position_log.is_empty());
        state.name = name.clone();
        // New recordings replay the bubble's moves (composite::resolve_zones);
        // Review's Follow recording choice turns this back on after a pick.
        state.bubble_follow = (!state.bubble_position_log.is_empty()).then_some(true);
        edit::write_sidecar_path(&scratch_mp4_path, &state)?;
    }

    // Staged on this Mac because the Save to folder is on another volume: move
    // it there now that every file is closed, before Review sees any path. A
    // failed move keeps the recording here with its marker (retried later) and
    // never fails the recording.
    let mut move_note = None;
    let (mut scratch_dir, mut scratch_mp4_path) = (scratch_dir, scratch_mp4_path);
    let (mut screen_for_dual, mut webcam_for_dual, mut sources_dir) = (screen_for_dual, webcam_for_dual, sources_dir);
    if let Some(dest_lib) = move_to {
        let src = scratch_dir.clone();
        let dest_lib2 = dest_lib.clone();
        let moved = tauri::async_runtime::spawn_blocking(move || storage::move_recording(&src, &dest_lib2))
            .await
            .map_err(|e| e.to_string())
            .and_then(|r| r);
        match moved {
            Ok(new_dir) => {
                let rebase = |p: PathBuf| match p.strip_prefix(&scratch_dir) {
                    Ok(rest) => new_dir.join(rest),
                    Err(_) => p,
                };
                scratch_mp4_path = rebase(scratch_mp4_path);
                screen_for_dual = screen_for_dual.map(rebase);
                webcam_for_dual = webcam_for_dual.map(rebase);
                sources_dir = sources_dir.map(rebase);
                scratch_dir = new_dir;
            }
            Err(e) => {
                eprintln!("[storage] finalize move failed: {e}");
                move_note = Some(storage::move_failed_note(&dest_lib));
            }
        }
    }

    Ok(FinalizedRecording {
        stamp,
        scratch_dir: scratch_dir.to_string_lossy().into_owned(),
        scratch_mp4_path: scratch_mp4_path.to_string_lossy().into_owned(),
        // Phase 15 c3 dual-stream fields. screen_path is what the review's
        // <video> source uses (post-NR-preview swap below — see edit.rs
        // preview_path_for which now resolves preview-screen.mp4 sibling).
        // webcam_path is the c1 concat'd file. webcam_lead_ms is the
        // calibrated camera-start delay the CSS player applies via
        // currentTime offset to mirror composite's tpad behavior.
        screen_path: screen_for_dual
            .as_ref()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|| scratch_mp4_path.to_string_lossy().into_owned()),
        webcam_path: webcam_for_dual.map(|p| p.to_string_lossy().into_owned()),
        webcam_lead_ms: measured_lead_ms.unwrap_or(composite::WEBCAM_LEAD_MS),
        sources_dir: sources_dir.map(|p| p.to_string_lossy().into_owned()),
        name,
        move_note,
    })
}

#[derive(serde::Serialize)]
struct FinalizedRecording {
    stamp: String,
    scratch_dir: String,
    scratch_mp4_path: String,
    // Phase 15 c3 dual-stream player inputs.
    screen_path: String,
    webcam_path: Option<String>,
    webcam_lead_ms: f64,
    sources_dir: Option<String>,
    name: Option<String>,
    // Some when the move to the Save to folder failed; Review shows it.
    move_note: Option<String>,
}

// App-launch safety net for scratch dirs orphaned by a crash or force-quit
// mid-session. Phase 11 keeps the scratch alive across saves until the
// review window closes, so a clean exit always sweeps its own dir — this
// just covers the unclean case. Best-effort; failures are silent.
fn sweep_stale_scratch() {
    let root = match storage::default_root().map(|d| d.join(".scratch")) {
        Ok(p) => p,
        Err(_) => return,
    };
    if !root.exists() {
        return;
    }
    thumbs::sweep_dir_older_than(&root, std::time::Duration::from_secs(24 * 60 * 60), "scratch-sweep");
}

// Defense against a malformed/spoofed scratch path. Any discard must work
// against a recording folder in the default library (or the old .scratch) or
// the Save to folder's library, never a root itself (storage.rs).
fn validate_scratch_path(p: &std::path::Path) -> Result<(), String> {
    storage::validate_recording_dir(p, &storage::recording_roots()?)
}

// A recording folder that must not be moved now: being recorded, or open in
// Review (window review-<stamp>).
pub(crate) fn recording_in_use(app: &AppHandle, dir: &std::path::Path) -> bool {
    let Some(stamp) = stamp_from_scratch_dir_name(dir) else { return true };
    if app.get_webview_window(&format!("review-{stamp}")).is_some() {
        return true;
    }
    let state = app.state::<Mutex<Option<ActiveRecording>>>();
    let active = state.lock().map(|g| g.as_ref().map(|r| r.stamp == stamp).unwrap_or(false));
    active.unwrap_or(true)
}

// Lets the webview load video and thumbnails from the Save to folder. The
// static scope in tauri.conf.json covers only ~/Movies/Zeigen. `**` does not
// match a leading dot, so the library (.recordings) is allowed on its own.
fn allow_save_dir<R: tauri::Runtime>(app: &AppHandle<R>, root: &std::path::Path) {
    let scope = app.asset_protocol_scope();
    for dir in [root.to_path_buf(), storage::library(root)] {
        if let Err(e) = scope.allow_directory(&dir, true) {
            eprintln!("[storage] asset scope {}: {e}", dir.display());
        }
    }
}

#[derive(serde::Serialize)]
struct StorageStatus {
    // Where recordings and exports go now, home shown as ~.
    destination: String,
    // The Save to setting, None for the default.
    chosen: Option<String>,
    chosen_available: bool,
    // Set when the chosen folder is unavailable.
    warning: Option<String>,
}

#[tauri::command]
fn storage_status() -> Result<StorageStatus, String> {
    let a = storage::active()?;
    let chosen = storage::chosen();
    Ok(StorageStatus {
        destination: storage::show(&a.root),
        chosen: chosen.as_deref().map(storage::show),
        chosen_available: a.fallback_from.is_none(),
        warning: a.fallback_from.as_deref().map(|c| storage::unavailable_note(c, false)),
    })
}

#[derive(serde::Serialize)]
struct MoveOffer {
    // The library the recordings are in now.
    from: String,
    count: usize,
    bytes: u64,
}

// Sets the Save to folder (None = back to ~/Movies/Zeigen). Refused while a
// recording runs and for a folder Zeigen cannot write to. Returns what the old
// library holds, so the window can offer to move it.
#[tauri::command]
fn set_save_dir(
    app: AppHandle,
    recording: RecordingState<'_>,
    path: Option<String>,
) -> Result<Option<MoveOffer>, String> {
    if recording.lock().map_err(|e| e.to_string())?.is_some() {
        return Err("The folder can't be changed while recording.".into());
    }
    let default = storage::default_root()?;
    let new_root = path.map(PathBuf::from).filter(|p| *p != default);
    if let Some(p) = &new_root {
        if !storage::is_available(p) {
            return Err(format!("Zeigen can't save to {}.", storage::show(p)));
        }
    }
    let old_lib = storage::library(&storage::active()?.root);
    settings::write_save_dir(&app, new_root.as_ref().map(|p| p.to_string_lossy().into_owned()))?;
    if let Some(p) = &new_root {
        allow_save_dir(&app, p);
    }
    let new_lib = storage::library(&storage::active()?.root);
    if old_lib == new_lib {
        return Ok(None);
    }
    let recordings = library::scan(&old_lib);
    if recordings.is_empty() {
        return Ok(None);
    }
    Ok(Some(MoveOffer {
        from: old_lib.to_string_lossy().into_owned(),
        count: recordings.len(),
        bytes: recordings.iter().map(|r| r.size_bytes).sum(),
    }))
}

// Moves every recording in the library `from` into the current library, in the
// background, skipping those being recorded or open in Review. Exported files
// are never moved. Returns a plain summary.
#[tauri::command]
async fn move_recordings(app: AppHandle, from: String) -> Result<String, String> {
    let from = PathBuf::from(from);
    if from.file_name().and_then(|n| n.to_str()) != Some(storage::LIBRARY) {
        return Err(format!("not a recordings library: {}", from.display()));
    }
    let a = storage::active()?;
    if let Some(c) = a.fallback_from {
        return Err(storage::unavailable_note(&c, false));
    }
    let to = storage::library(&a.root);
    if from == to {
        return Ok(storage::move_summary(0, &[]));
    }
    tauri::async_runtime::spawn_blocking(move || {
        let label = |d: &std::path::Path| {
            library::read_folder(d)
                .and_then(|r| r.name)
                .unwrap_or_else(|| d.file_name().unwrap_or_default().to_string_lossy().into_owned())
        };
        let (moved, failed) = storage::move_library(&from, &to, &|d| recording_in_use(&app, d), &label);
        storage::move_summary(moved, &failed)
    })
    .await
    .map_err(|e| e.to_string())
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

// Brings a window to the front. False when no window has that label.
#[tauri::command]
fn focus_window(app: AppHandle, label: String) -> bool {
    let Some(w) = app.get_webview_window(&label) else { return false };
    let _ = w.unminimize();
    let _ = w.show();
    let _ = w.set_focus();
    true
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
        // Must be registered first — Tauri's single-instance guard needs to
        // intercept a second launch before the rest of setup runs. Without
        // this, every launch (double-click, Spotlight, hotkey) spawned a
        // brand-new process with its own recording-engine child, tray icon,
        // and global-shortcut registration; concurrent instances fighting
        // over the same ScreenCaptureKit/mic resources meant one instance's
        // engine child would die, and the next command sent to it hit a
        // dead stdin pipe (EngineClient::send's "Broken pipe" error).
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            tray::raise_main_window(app);
        }))
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
            // The keep-time clean-up runs on the current library only.
            library::sweep_current_library();
            if let Some(chosen) = storage::chosen() {
                allow_save_dir(&handle, &chosen);
            }
            // Recordings that could not reach the Save to folder earlier.
            let handle_for_moves = handle.clone();
            std::thread::spawn(move || {
                library::retry_pending_moves(&handle_for_moves);
            });

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
            mic_monitor,
            engine_go,
            engine_pause,
            engine_resume,
            engine_stop,
            recording_reset,
            recording_cleanup_local,
            recording_finalize,
            update_tray_state,
            update_tray_elapsed,
            set_hotkey,
            hotkey::hotkey_pause,
            hotkey::hotkey_resume,
            quit_app,
            macos::set_window_frame_cg,
            macos::picker_cursor_start,
            macos::picker_cursor_stop,
            macos::place_bubble_toolbar,
            macos::attach_bubble_toolbar,
            macos::resize_bubble,
            macos::bubble_hover_start,
            macos::bubble_hover_stop,
            bubble_position_event,
            edit::read_sidecar,
            edit::write_sidecar,
            edit::delete_sidecar,
            edit::camera_path,
            edit::scene_path,
            edit::bubble_start_zone,
            edit::cursor_preview,
            edit::window_corner,
            edit::rename_recording,
            edit::save_recording,
            zoom::suggest_zooms,
            edit::probe_audio_track,
            edit::video_start_time,
            edit::render_preview_audio,
            wallpapers::list_wallpapers,
            wallpapers::wallpaper_thumb,
            discard_recording,
            library::list_recordings,
            library::release_recording,
            storage_status,
            set_save_dir,
            move_recordings,
            focus_window,
            clipboard::clipboard_copy_recording,
            exports::cleanup_recording_exports,
            settings::get_settings,
            settings::set_watermark_logo,
            settings::set_watermark_corner,
            settings::set_watermark_style,
            settings::clear_watermark_logo,
            settings::set_noise_reduction,
            settings::set_bubble_roundness,
            settings::set_bubble_size,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_take_that_fails_before_it_starts_leaves_nothing_behind() {
        let lib = std::env::temp_dir().join(format!("zeigen-discard-{}", std::process::id()));
        let take = lib.join("recording-2026-11-17-121050");
        std::fs::create_dir_all(take.join("sources")).unwrap();
        std::fs::write(take.join(".pending-move"), b"").unwrap();
        std::fs::write(take.join("sources/webcam.mp4"), b"x").unwrap();

        let mut started = super::DiscardTake(Some(take.clone()));
        started.0 = None;
        drop(started);
        assert!(take.is_dir(), "a take that started is kept");

        drop(super::DiscardTake(Some(take.clone())));
        assert!(!take.exists());
        assert!(lib.is_dir(), "only the take's own folder goes");
        std::fs::remove_dir_all(lib).unwrap();
    }

    use super::*;

    // The runtime grant reaches files in the chosen folder's dot-named library,
    // which a plain allow_directory(root, true) does not (`**` skips a leading
    // dot), and nothing outside it.
    #[test]
    fn asset_scope_allows_the_chosen_library() {
        let t = std::env::temp_dir().join(format!("zeigen-scope-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&t);
        let root = t.join("LaCie/Zeigen");
        let file = storage::library(&root).join("recording-2026-11-17-100000/sources/screen.mp4");
        let thumb = storage::library(&root).join("recording-2026-11-17-100000/thumb-1000.jpg");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, b"x").unwrap();
        std::fs::write(&thumb, b"x").unwrap();
        std::fs::write(root.join("Demo.mp4"), b"x").unwrap();

        let app = tauri::test::mock_app();
        let scope = app.asset_protocol_scope();
        scope.allow_directory(&root, true).unwrap();
        assert!(scope.is_allowed(root.join("Demo.mp4")));
        assert!(!scope.is_allowed(&file), "root/** alone does not reach .recordings");

        allow_save_dir(app.handle(), &root);
        assert!(scope.is_allowed(&file));
        assert!(scope.is_allowed(&thumb));
        assert!(!scope.is_allowed(t.join("LaCie/other.mp4")));
        let _ = std::fs::remove_dir_all(&t);
    }
}
