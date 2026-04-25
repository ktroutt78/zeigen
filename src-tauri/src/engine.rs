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
        display_id: u32,
        microphone_uid: Option<String>,
        output_path: String,
        max_fps: Option<u32>,
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

impl Drop for EngineClient {
    fn drop(&mut self) {
        let _ = self.send(&EngineCommand::Quit);
        let _ = self.child.wait();
    }
}

pub fn engine_binary_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("target/recording-engine-build/debug/recording-engine")
}
