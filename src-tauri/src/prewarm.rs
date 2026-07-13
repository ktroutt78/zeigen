// Per-recording pipeline pre-warm.
//
// macOS framework caches (avfoundation device-open, VTCompressionSession,
// SCK first-capture-call) all carry a first-call init penalty. A short
// throwaway capture cycle right before the real recording, hidden inside
// the countdown window, warms those caches so the real recording's first
// frame doesn't pay them.
//
// Two parallel tracks run from prewarm_capture:
//   Track A — throwaway webcam ffmpeg with the same args as the real
//     WebcamSegmenter, output discarded to mpegts→pipe→/dev/null. Killed
//     after ~500ms. stderr stays Stdio::null() — no diagnostic stderr
//     piping on the capture path.
//   Track B — engine Start with a .prewarm-prefixed scratch path, ~800ms
//     wait (covers cold SCK first-frame), engine Stop, ~400ms flush wait,
//     scratch deletion.
//
// Total wall time: ~1.2s. Fits inside the existing 3s/5s countdown for
// free. The frontend skips pre-warm entirely when countdown is Off.
//
// Best-effort by design: any failure inside either track is logged via
// eprintln and the command returns Ok. The real recording always
// proceeds — pre-warm can never block or fail the user's recording.
//
// Cancellation: prewarm_abort sets a shared flag, kills the parked
// webcam child if alive, and sends Stop to the engine if Start has been
// issued. Both tracks' wait loops check the flag every 50ms so a cancel
// short-circuits within ~50ms.

use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

use chrono::Local;
use tauri::{AppHandle, Manager};

use crate::engine::{EngineClient, EngineCommand};

const FFMPEG_PATH: &str = "/opt/homebrew/bin/ffmpeg";

const TRACK_A_DURATION_MS: u64 = 500;
const TRACK_B_START_WAIT_MS: u64 = 800;
const TRACK_B_STOP_WAIT_MS: u64 = 400;
const ABORT_POLL_MS: u64 = 50;

#[derive(Default)]
pub struct PrewarmHandle {
    // Parked here so prewarm_abort can kill it without waiting on
    // Track A's wait loop. Taken by whichever path reaches it first
    // (Track A's natural completion OR prewarm_abort) — child.kill()
    // is therefore called exactly once.
    webcam_child: Option<Child>,
    // True once EngineCommand::Start has been dispatched. Cleared
    // atomically by whichever path sends Stop, so Stop fires once.
    engine_started: bool,
    // Track B's scratch path. Removed on normal completion; abort
    // path leaves removal to the natural completion since the engine
    // is still draining when abort returns.
    scratch_dir: Option<PathBuf>,
    // Set by prewarm_abort; checked by both tracks' 50ms wait loops.
    aborted: bool,
}

fn movies_dir() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME not set".to_string())?;
    Ok(PathBuf::from(home).join("Movies/Zeigen"))
}

fn spawn_throwaway_webcam(camera_index: u32) -> Result<Child, String> {
    // Args mirror WebcamSegmenter::start_segment exactly so the
    // OS-level caches the real recording will hit are the same ones
    // this throwaway warms. Output goes to mpegts→pipe:1 with stdout
    // tied to Stdio::null so the encoder runs (warming VT) but the
    // bytes are discarded with no scratch file.
    Command::new(FFMPEG_PATH)
        .args([
            "-y",
            "-hide_banner",
            "-f",
            "avfoundation",
            "-framerate",
            "30",
            "-video_size",
            "1280x720",
            "-i",
            &camera_index.to_string(),
            "-c:v",
            "h264_videotoolbox",
            "-b:v",
            "4M",
            "-pix_fmt",
            "nv12",
            "-an",
            "-f",
            "mpegts",
            "pipe:1",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("spawn throwaway webcam ffmpeg: {e}"))
}

// Wait up to `total_ms`, in `ABORT_POLL_MS` increments, returning early
// if the shared aborted flag flips. Returns true if aborted during wait.
fn wait_with_abort_poll(app: &AppHandle, total_ms: u64) -> bool {
    let mut elapsed = 0u64;
    while elapsed < total_ms {
        std::thread::sleep(Duration::from_millis(ABORT_POLL_MS));
        elapsed += ABORT_POLL_MS;
        // Inline-chain to avoid an intermediate `let state` binding —
        // the if-let-on-lock pattern with a local State binding hits a
        // temporary-lifetime corner case in a loop body.
        let aborted = app
            .state::<Mutex<PrewarmHandle>>()
            .lock()
            .map(|g| g.aborted)
            .unwrap_or(false);
        if aborted {
            return true;
        }
    }
    false
}

fn run_track_a(app: AppHandle, camera_index: u32) -> Result<(), String> {
    let child = spawn_throwaway_webcam(camera_index)?;
    // Park the child for the abort path.
    {
        let state = app.state::<Mutex<PrewarmHandle>>();
        let mut guard = state.lock().map_err(|e| e.to_string())?;
        guard.webcam_child = Some(child);
    }
    wait_with_abort_poll(&app, TRACK_A_DURATION_MS);
    // Take the child back (or no-op if abort already took it) and kill.
    let child_opt = {
        let state = app.state::<Mutex<PrewarmHandle>>();
        let mut guard = state.lock().map_err(|e| e.to_string())?;
        guard.webcam_child.take()
    };
    if let Some(mut child) = child_opt {
        let _ = child.kill();
        let _ = child.wait();
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn run_track_b(
    app: AppHandle,
    display_id: Option<u32>,
    window_id: Option<u32>,
    microphone_uid: Option<String>,
    max_fps: Option<u32>,
    area_x: Option<f64>,
    area_y: Option<f64>,
    area_width: Option<f64>,
    area_height: Option<f64>,
) -> Result<(), String> {
    // Scratch dir with .prewarm prefix so the launch-time scratch
    // sweeper (lib.rs::sweep_stale_scratch) can recognize it as
    // disposable independently from real recording-* dirs.
    let stamp = Local::now().format("%Y-%m-%d-%H%M%S-%3f").to_string();
    let scratch_dir = movies_dir()?
        .join(".scratch")
        .join(format!(".prewarm-{stamp}"));
    std::fs::create_dir_all(&scratch_dir)
        .map_err(|e| format!("create prewarm scratch: {e}"))?;
    let output_path = scratch_dir.join("screen.mp4");

    {
        let state = app.state::<Mutex<PrewarmHandle>>();
        let mut guard = state.lock().map_err(|e| e.to_string())?;
        guard.scratch_dir = Some(scratch_dir.clone());
    }

    // Dispatch Start to the engine.
    {
        let engine_state = app.state::<Mutex<EngineClient>>();
        let engine = engine_state.lock().map_err(|e| e.to_string())?;
        engine.send(&EngineCommand::Start {
            display_id,
            window_id,
            microphone_uid,
            output_path: output_path.to_string_lossy().into_owned(),
            max_fps,
            area_x,
            area_y,
            area_width,
            area_height,
            // Off for the throwaway warm-up: telemetry has no first-call
            // cache to warm and its sidecar would be discarded with the
            // prewarm scratch anyway. The real recording sends true.
            capture_cursor: false,
        })?;
    }

    // Mark engine as started so abort knows it owes a Stop. Race-free:
    // if abort fires before this line, Stop won't be sent twice because
    // engine_started is still false at that point — the abort skips
    // Stop, and we fall through to send it ourselves below.
    {
        let state = app.state::<Mutex<PrewarmHandle>>();
        let mut guard = state.lock().map_err(|e| e.to_string())?;
        guard.engine_started = true;
    }

    wait_with_abort_poll(&app, TRACK_B_START_WAIT_MS);

    // Send Stop iff we're the one who owes it. Atomic check-and-clear
    // on engine_started, so prewarm_abort firing concurrently with this
    // block results in exactly one Stop dispatch.
    let should_stop = {
        let state = app.state::<Mutex<PrewarmHandle>>();
        let mut guard = state.lock().map_err(|e| e.to_string())?;
        let owed = guard.engine_started;
        guard.engine_started = false;
        owed
    };
    if should_stop {
        let _ = app
            .state::<Mutex<EngineClient>>()
            .lock()
            .map(|engine| engine.send(&EngineCommand::Stop));
    }

    // AVAssetWriter flush latency. Bounded — the recording is tiny.
    std::thread::sleep(Duration::from_millis(TRACK_B_STOP_WAIT_MS));

    // Best-effort scratch cleanup. Sweeper covers leftovers.
    let dir_opt = {
        let state = app.state::<Mutex<PrewarmHandle>>();
        let mut guard = state.lock().map_err(|e| e.to_string())?;
        guard.scratch_dir.take()
    };
    if let Some(dir) = dir_opt {
        let _ = std::fs::remove_dir_all(&dir);
    }
    Ok(())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn prewarm_capture(
    app: AppHandle,
    display_id: Option<u32>,
    window_id: Option<u32>,
    microphone_uid: Option<String>,
    camera_index: Option<u32>,
    max_fps: Option<u32>,
    area_x: Option<f64>,
    area_y: Option<f64>,
    area_width: Option<f64>,
    area_height: Option<f64>,
) -> Result<(), String> {
    // Guard against concurrent pre-warms — frontend should only ever
    // call this once per record-click, but a quick double-click could
    // otherwise spawn two pipelines.
    {
        let state = app.state::<Mutex<PrewarmHandle>>();
        let mut guard = state.lock().map_err(|e| e.to_string())?;
        if guard.webcam_child.is_some() || guard.engine_started {
            return Err("prewarm already in progress".into());
        }
        *guard = PrewarmHandle::default();
    }

    let app_a = app.clone();
    let app_b = app.clone();

    let track_a = std::thread::spawn(move || {
        if let Some(idx) = camera_index {
            if let Err(e) = run_track_a(app_a, idx) {
                eprintln!("[prewarm] Track A failed: {e}");
            }
        }
    });
    let track_b = std::thread::spawn(move || {
        if let Err(e) = run_track_b(
            app_b,
            display_id,
            window_id,
            microphone_uid,
            max_fps,
            area_x,
            area_y,
            area_width,
            area_height,
        ) {
            eprintln!("[prewarm] Track B failed: {e}");
        }
    });

    let _ = track_a.join();
    let _ = track_b.join();

    // Reset to fresh state for the next record click.
    if let Ok(mut guard) = app.state::<Mutex<PrewarmHandle>>().lock() {
        *guard = PrewarmHandle::default();
    }
    Ok(())
}

#[tauri::command]
pub fn prewarm_abort(app: AppHandle) -> Result<(), String> {
    // Take child + capture engine-started state under a single lock,
    // then perform potentially blocking work (kill+wait, engine.send)
    // outside the lock to avoid blocking the wait-loop polls.
    let (child_opt, should_stop) = {
        let state = app.state::<Mutex<PrewarmHandle>>();
        let mut guard = state.lock().map_err(|e| e.to_string())?;
        guard.aborted = true;
        let owed = guard.engine_started;
        guard.engine_started = false;
        (guard.webcam_child.take(), owed)
    };
    if let Some(mut child) = child_opt {
        let _ = child.kill();
        let _ = child.wait();
    }
    if should_stop {
        let _ = app
            .state::<Mutex<EngineClient>>()
            .lock()
            .map(|engine| engine.send(&EngineCommand::Stop));
    }
    Ok(())
}
