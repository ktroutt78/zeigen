use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};

// The webcam is recorded by our own helper (webcam-recorder/main.swift), not
// ffmpeg: ffmpeg's avfoundation input always picks the camera's highest-rate
// 1280x720 mode, and an iPhone camera restarts its stream (losing its zoom)
// when a second client asks for a different mode than the preview's.
pub fn recorder_binary_path() -> PathBuf {
    // Release: bundled next to the app binary (Contents/MacOS/webcam-recorder).
    // Debug/dev: the copy build.rs compiles into target/.
    #[cfg(not(debug_assertions))]
    {
        std::env::current_exe()
            .ok()
            .and_then(|exe| exe.parent().map(|dir| dir.join("webcam-recorder")))
            .unwrap_or_else(|| PathBuf::from("webcam-recorder"))
    }
    #[cfg(debug_assertions)]
    {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target/recording-engine-build/webcam-recorder")
    }
}

// Starts the helper writing `out`. It stops on "q" or on stdin EOF, so it
// also finishes its file and exits when this process dies.
pub fn spawn_recorder(camera_name: &str, out: &Path) -> Result<Child, String> {
    Command::new(recorder_binary_path())
        .arg(camera_name)
        .arg(out)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| format!("failed to spawn webcam-recorder: {e}"))
}

// One recording's webcam: a single helper process writing sources/webcam.mp4
// from Record to Stop (pauses are cut inside the helper, see pause/resume).
pub struct WebcamRecorder {
    sources_dir: PathBuf,
    current: Option<Child>,
    // Host-clock seconds of the file's frame 0, from the helper's first_frame line.
    first_host_s: Arc<Mutex<Option<f64>>>,
}

impl WebcamRecorder {
    pub fn start(camera_name: &str, sources_dir: PathBuf) -> Result<Self, String> {
        let mut child = spawn_recorder(camera_name, &sources_dir.join("webcam.mp4"))?;
        let stdout = child.stdout.take().ok_or("webcam-recorder: no stdout")?;
        let first_host_s = Arc::new(Mutex::new(None));
        let slot = first_host_s.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
                if v.get("event").and_then(|e| e.as_str()) == Some("first_frame") {
                    if let (Some(h), Ok(mut g)) = (v.get("host_s").and_then(|h| h.as_f64()), slot.lock()) {
                        *g = Some(h);
                    }
                }
            }
        });
        Ok(Self { sources_dir, current: Some(child), first_host_s })
    }

    // Finishes the file. A second call is a no-op.
    pub fn stop(&mut self) -> Result<(), String> {
        let Some(mut child) = self.current.take() else { return Ok(()) };
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(b"q\n");
            let _ = stdin.flush();
        }
        child
            .wait()
            .map(|_| ())
            .map_err(|e| format!("webcam-recorder wait: {e}"))
    }

    // Pause and resume keep the one helper running: it stops writing on
    // "pause" and, on resume, cuts the same total paused time the screen
    // engine reports, so the two files stay in step across pauses.
    pub fn pause(&mut self) -> Result<(), String> {
        self.send("pause\n")
    }

    pub fn resume(&mut self, paused_total_s: f64) -> Result<(), String> {
        self.send(&format!("resume {paused_total_s:.6}\n"))
    }

    fn send(&mut self, line: &str) -> Result<(), String> {
        let Some(stdin) = self.current.as_mut().and_then(|c| c.stdin.as_mut()) else { return Ok(()) };
        stdin
            .write_all(line.as_bytes())
            .and_then(|_| stdin.flush())
            .map_err(|e| format!("webcam-recorder stdin: {e}"))
    }

    pub fn first_host_s(&self) -> Option<f64> {
        self.first_host_s.lock().ok().and_then(|g| *g)
    }

    pub fn sources_dir(&self) -> &Path {
        &self.sources_dir
    }
}

impl Drop for WebcamRecorder {
    fn drop(&mut self) {
        if let Some(mut child) = self.current.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}
