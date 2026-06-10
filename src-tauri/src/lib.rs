mod clipboard;
mod composite;
mod devices;
mod edit;
mod engine;
mod exports;
mod hotkey;
mod linkedin;
mod macos;
mod settings;
mod sync_harness;
mod thumbs;
mod tray;
mod webcam;

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Instant;

use chrono::Local;
use tauri::{AppHandle, Listener, Manager, State};

use composite::{Corner, WebcamSize, FFMPEG_PATH};
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
    // Phase 15 c3: webcam_size/corner aren't read by finalize anymore
    // (composite moved to export). Kept on the struct so engine_start
    // keeps parsing the API contract unchanged — a future settings UI
    // can read these. dead_code allowed pending that surface.
    #[allow(dead_code)]
    webcam_size: WebcamSize,
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
    mode: CaptureMode,
    bubble_position_log: Vec<BubblePositionEntry>,
    last_logged: Option<(Instant, f64, f64)>,
    // A/V sync harness (Phase A) — diagnostic-only, additive.
    // None if no webcam attached. Captured at WebcamSegmenter spawn
    // time so we can express the spawn instant as a signed delta from
    // started_at (will be slightly negative in current code since
    // spawn precedes started_at by a few lines).
    harness_webcam_spawn_at: Option<Instant>,
    harness_camera_index: Option<u32>,
    harness_microphone_uid: Option<String>,
    harness_display_id: Option<u32>,
    harness_window_id: Option<u32>,
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

    // Sync harness (Phase A): stamp the webcam-spawn instant
    // immediately before WebcamSegmenter::start_segment so the
    // recorded delta reflects the avfoundation invocation point.
    // None when there's no webcam.
    let mut harness_webcam_spawn_at: Option<Instant> = None;
    let (screen_output, webcam) = if let Some(idx) = camera_index {
        let sources_dir = scratch_dir.join("sources");
        std::fs::create_dir_all(&sources_dir)
            .map_err(|e| format!("create {}: {}", sources_dir.display(), e))?;
        let mut segmenter = WebcamSegmenter::new(idx, sources_dir.clone());
        harness_webcam_spawn_at = Some(Instant::now());
        segmenter.start_segment()?;
        (sources_dir.join("screen.mp4"), Some(segmenter))
    } else {
        (scratch_mp4_path.clone(), None)
    };

    let (area_x_send, area_y_send, area_w_send, area_h_send) = match area {
        Some((x, y, w, h)) => (Some(x), Some(y), Some(w), Some(h)),
        None => (None, None, None, None),
    };

    // Sync harness (Phase A): clone microphone_uid before the
    // EngineCommand::Start consumes it, so the diagnostic can echo it.
    let harness_microphone_uid: Option<String> = microphone_uid.clone();

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
        first_frame_at: None,
        mode,
        bubble_position_log: Vec::new(),
        last_logged: None,
        harness_webcam_spawn_at,
        harness_camera_index: camera_index,
        harness_microphone_uid,
        harness_display_id: display_id,
        harness_window_id: window_id,
    });

    Ok(scratch_mp4_path.to_string_lossy().into_owned())
}

// Phase 15 #4 fix: called by engine.rs stdout reader when the Swift
// engine emits first_frame for the screen stream. Stamps the active
// recording's first_frame_at with the receipt instant — IPC latency
// over the line-buffered pipe is ~1-5ms, negligible vs the 225-360ms
// SCK init lag measured during verification. Idempotent: only writes
// the first time.
pub(crate) fn note_screen_first_frame(app: &AppHandle) {
    let now = Instant::now();
    let state = app.state::<Mutex<Option<ActiveRecording>>>();
    let mutex = state.inner();
    if let Ok(mut guard) = mutex.lock() {
        if let Some(rec) = guard.as_mut() {
            if rec.first_frame_at.is_none() {
                rec.first_frame_at = Some(now);
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

    let stamp = rec.stamp;
    let scratch_dir = rec.scratch_dir;
    let scratch_mp4_path = rec.scratch_mp4_path;
    let webcam_opt = rec.webcam;
    let started_at = rec.started_at;
    let first_frame_at = rec.first_frame_at;
    let bubble_position_log = rec.bubble_position_log;
    // Sync harness (Phase A) — drained out of rec before partial moves
    // below would block field access. Diagnostic-only; never gates
    // anything in finalize.
    let harness_webcam_spawn_at = rec.harness_webcam_spawn_at;
    let harness_camera_index = rec.harness_camera_index;
    let harness_microphone_uid = rec.harness_microphone_uid;
    let harness_display_id = rec.harness_display_id;
    let harness_window_id = rec.harness_window_id;
    let harness_mode_label: &str = match rec.mode {
        CaptureMode::Display { .. } => "display",
        CaptureMode::Window { .. } => "window",
        CaptureMode::Area { .. } => "area",
    };
    // webcam_size / webcam_corner used to feed composite at finalize.
    // Phase 15 c3 defers composite to export; export defaults to Medium/
    // BottomRight (engine_start parses these from None → defaults today,
    // so dropping them at finalize is a no-op for current recordings).

    // c3 outputs: the dual-stream player needs screen_path + optional
    // webcam_path. Both None for screen-only recordings (in which case
    // scratch_mp4_path itself IS the screen capture). Populated below.
    let mut screen_for_dual: Option<PathBuf> = None;
    let mut webcam_for_dual: Option<PathBuf> = None;

    // Phase B: drained out of the segmenter before `webcam` falls out
    // of scope and Drop runs. None for screen-only recordings, for
    // recordings that ended before ffmpeg emitted a frame= line, and
    // for exotic ffmpeg builds whose progress format we don't match.
    let mut webcam_first_frame_at: Option<Instant> = None;

    let (sources_dir, segments) = if let Some(mut webcam) = webcam_opt {
        // Idempotently finalize the live webcam segment before reading it.
        // On a normal stop, engine_stop already stopped it (take() -> None,
        // no-op). On the MIC_SESSION_FAILED salvage path the engine never
        // received Stop, so this is where the partial last segment's mp4 is
        // finalized — making recording_finalize self-sufficient either way.
        let _ = webcam.stop_segment();
        let segments = webcam.segments().to_vec();
        let sources_dir = webcam.sources_dir().to_path_buf();
        webcam_first_frame_at = webcam.first_frame_at();
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
        // webcam.mp4 in scratch; webcam ffmpeg child is reaped via
        // WebcamSegmenter::Drop when `rec` goes out of scope on Err
        // return, scratch dir collected by the 24h launch sweeper.
        if !screen_path.is_file() {
            return Err("RECORDING_FAILED_BEFORE_START".into());
        }

        // Concat the segments into a single playable webcam.mp4 alongside
        // them. Stream-copy via ffmpeg's concat demuxer — sub-second even
        // for long recordings and a no-op transcode for the N=1 case.
        // Phase 15 c3's dual-stream player consumes this; composite still
        // consumes the per-segment array below, so the concat output is
        // additive (no behavior change for the existing finalize path).
        let webcam_concat_path = sources_dir.join("webcam.mp4");
        {
            let list_path = sources_dir.join("webcam-segments.txt");
            let list_body: String = segments
                .iter()
                .map(|p| format!("file '{}'\n", p.to_string_lossy().replace('\'', "'\\''")))
                .collect();
            std::fs::write(&list_path, list_body)
                .map_err(|e| format!("write webcam concat list: {e}"))?;
            let out = std::process::Command::new(FFMPEG_PATH)
                .args([
                    "-y",
                    "-hide_banner",
                    "-nostats",
                    "-f", "concat",
                    "-safe", "0",
                    "-i", &list_path.to_string_lossy(),
                    "-c", "copy",
                    &webcam_concat_path.to_string_lossy(),
                ])
                .output()
                .map_err(|e| format!("spawn webcam concat ffmpeg: {e}"))?;
            let _ = std::fs::remove_file(&list_path);
            if !out.status.success() {
                let stderr = String::from_utf8_lossy(&out.stderr);
                let tail: Vec<&str> = stderr.lines().rev().take(20).collect();
                let tail_text = tail.into_iter().rev().collect::<Vec<_>>().join("\n");
                return Err(format!(
                    "webcam concat failed (exit {:?}):\n{tail_text}",
                    out.status.code(),
                ));
            }
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
        (Some(sources_dir), segments)
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
            return Err("RECORDING_FAILED_BEFORE_START".into());
        }
        (None, Vec::new())
    };

    // Phase 15 #4 fix: shift bubble_position_log entries by the SCK
    // init lag so each entry's t corresponds to screen.mp4 PTS=0 (the
    // first SCK frame) instead of started_at (the engine_start IPC
    // invocation, which precedes SCK by 225-360ms per measurement
    // 2026-06-07). Composite + preview both read the resulting sidecar
    // — single source of truth, no divergence (option B-unified).
    // Entries with shifted t<0 are dropped: they correspond to bubble
    // drags before SCK started capturing, so there's no screen content
    // to overlay them onto.
    //
    // Fallback when first_frame_at is None (old engine binary, event
    // lost): no shift applied, log written as-is. Identical to pre-fix
    // behavior. No regression.
    let bubble_position_log: Vec<BubblePositionEntry> = if let Some(ff) = first_frame_at {
        let sck_lag = ff.duration_since(started_at).as_secs_f64();
        bubble_position_log
            .into_iter()
            .filter_map(|e| {
                let t = e.t - sck_lag;
                if t < 0.0 {
                    None
                } else {
                    Some(BubblePositionEntry { t, ..e })
                }
            })
            .collect()
    } else {
        bubble_position_log
    };

    // Sidecar lives adjacent to scratch_mp4_path regardless of whether
    // a file actually exists there (the path is the logical recording
    // identity — Phase 5.5 lifecycle key). Frontend's read_sidecar still
    // takes sourcePath = scratch_mp4_path; backend resolves the adjacent
    // .annotations.json without needing scratch_mp4_path itself on disk.
    if !bubble_position_log.is_empty() {
        let mut state = edit::read_sidecar_path(&scratch_mp4_path)?.unwrap_or_default();
        state.bubble_position_log = bubble_position_log;
        edit::write_sidecar_path(&scratch_mp4_path, &state)?;
    }

    // Sync harness (Phase A) — emit one JSONL record per finalize.
    // Best-effort: the logger swallows all errors. Movies dir derived
    // via the existing movies_dir() helper; failure to resolve HOME
    // also routes through the swallowed error path (we just skip).
    if let Ok(dir) = movies_dir() {
        let log_path = dir.join(".sync-measurements.jsonl");
        let webcam_spawn_delta_ms = harness_webcam_spawn_at
            .map(|w| sync_harness::signed_delta_ms(w, started_at));
        let sck_first_frame_delta_ms = first_frame_at
            .map(|f| sync_harness::signed_delta_ms(f, started_at));
        let webcam_first_frame_delta_ms = webcam_first_frame_at
            .map(|f| sync_harness::signed_delta_ms(f, started_at));
        let record = sync_harness::SyncMeasurement {
            stamp: &stamp,
            mode: harness_mode_label,
            display_id: harness_display_id,
            window_id: harness_window_id,
            camera_index: harness_camera_index,
            microphone_uid: harness_microphone_uid.as_deref(),
            webcam_lead_ms_applied: composite::WEBCAM_LEAD_MS,
            webcam_spawn_delta_ms,
            sck_first_frame_delta_ms,
            webcam_first_frame_delta_ms,
        };
        sync_harness::log_finalize_best_effort(&log_path, &record);
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
        webcam_lead_ms: composite::WEBCAM_LEAD_MS,
        sources_dir: sources_dir.map(|p| p.to_string_lossy().into_owned()),
        webcam_segments: segments
            .into_iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect(),
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
    webcam_segments: Vec<String>,
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
    thumbs::sweep_dir_older_than(&root, std::time::Duration::from_secs(24 * 60 * 60), "scratch-sweep");
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
            settings::get_settings,
            settings::set_watermark_logo,
            settings::set_watermark_corner,
            settings::clear_watermark_logo,
            settings::set_noise_reduction,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
