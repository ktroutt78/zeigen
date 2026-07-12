use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

pub struct EngineClient {
    child: Child,
    stdin: Mutex<ChildStdin>,
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "command", rename_all = "snake_case")]
pub enum EngineCommand {
    Enumerate,
    Start {
        #[serde(skip_serializing_if = "Option::is_none")]
        display_id: Option<u32>,
        #[serde(skip_serializing_if = "Option::is_none")]
        window_id: Option<u32>,
        microphone_uid: Option<String>,
        output_path: String,
        max_fps: Option<u32>,
        // Phase 9 area capture: all four must be present together
        // alongside display_id. Units are logical points relative to
        // the display's top-left origin.
        #[serde(skip_serializing_if = "Option::is_none")]
        area_x: Option<f64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        area_y: Option<f64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        area_width: Option<f64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        area_height: Option<f64>,
        // V3 Phase A. Engine default is true (cursor telemetry on, system
        // cursor NOT burned into pixels), but until the Phase B compositor
        // draws the synthetic cursor the app pins this to false so
        // recordings keep the visible cursor — byte-identical to pre-V3.
        capture_cursor: bool,
    },
    Pause,
    Resume,
    Stop,
    Quit,
}

impl EngineClient {
    pub fn spawn(app: &AppHandle, binary_path: PathBuf) -> Result<Self, String> {
        if !binary_path.exists() {
            return Err(format!(
                "recording-engine binary missing at {}; run `cargo build` to trigger the build script",
                binary_path.display()
            ));
        }

        let mut child = Command::new(&binary_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("failed to spawn recording-engine: {e}"))?;

        let stdin = child.stdin.take().ok_or("no stdin")?;
        let stdout = child.stdout.take().ok_or("no stdout")?;
        let stderr = child.stderr.take().ok_or("no stderr")?;

        let app_for_stdout = app.clone();
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines().map_while(Result::ok) {
                if line.is_empty() {
                    continue;
                }
                let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
                    continue;
                };
                // Phase 15 #4 fix: peek at first_frame for the screen
                // stream and timestamp on the ActiveRecording before
                // forwarding to the frontend. Rust uses this anchor at
                // finalize to shift bubble_position_log entries so their
                // t corresponds to screen.mp4 PTS=0 instead of the
                // earlier engine_start invocation time.
                if value.get("event").and_then(|v| v.as_str()) == Some("first_frame")
                    && value.get("stream").and_then(|v| v.as_str()) == Some("screen")
                {
                    crate::note_screen_first_frame(&app_for_stdout);
                }
                // The frontend maps most EngineError codes to a friendly,
                // detail-free toast string. eprintln! only reaches a
                // terminal when this app happens to be launched from one —
                // Dock/Spotlight launches have no attached stdio to see it,
                // which is the normal way this app runs. Log the raw event
                // to a file instead so a generic "INTERNAL"/"unexpected
                // error" report is diagnosable regardless of launch method.
                if value.get("event").and_then(|v| v.as_str()) == Some("error") {
                    log_engine_error(&value);
                }
                let _ = app_for_stdout.emit("engine-event", &value);
            }
        });

        std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                eprintln!("[engine] {line}");
            }
        });

        Ok(EngineClient {
            child,
            stdin: Mutex::new(stdin),
        })
    }

    pub fn send(&self, cmd: &EngineCommand) -> Result<(), String> {
        let mut line = serde_json::to_string(cmd).map_err(|e| e.to_string())?;
        line.push('\n');
        let mut stdin = self.stdin.lock().map_err(|e| e.to_string())?;
        stdin.write_all(line.as_bytes()).map_err(|e| e.to_string())?;
        stdin.flush().map_err(|e| e.to_string())?;
        Ok(())
    }
}

// Append a JSON engine "error" event to ~/Library/Logs/Zeigen/engine.log —
// standard macOS convention, works regardless of launch method (Dock and
// Spotlight launches have no attached stdio for eprintln! to reach, unlike
// a Terminal launch). Best-effort: a logging failure must never affect the
// app itself.
fn log_engine_error(value: &serde_json::Value) {
    let Ok(home) = std::env::var("HOME") else { return };
    let dir = PathBuf::from(home).join("Library/Logs/Zeigen");
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("engine.log"))
    else {
        return;
    };
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let _ = writeln!(f, "{now} {value}");
}

impl Drop for EngineClient {
    fn drop(&mut self) {
        let _ = self.send(&EngineCommand::Quit);
        let _ = self.child.wait();
    }
}

pub fn engine_binary_path() -> PathBuf {
    // Release: the engine is bundled as a sidecar next to the app binary
    // (Zeigen.app/Contents/MacOS/recording-engine) so the app is standalone.
    // Debug/dev: resolve the release-built engine from the dev source tree.
    #[cfg(not(debug_assertions))]
    {
        std::env::current_exe()
            .ok()
            .and_then(|exe| exe.parent().map(|dir| dir.join("recording-engine")))
            .unwrap_or_else(|| PathBuf::from("recording-engine"))
    }
    #[cfg(debug_assertions)]
    {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target/recording-engine-build/release/recording-engine")
    }
}
