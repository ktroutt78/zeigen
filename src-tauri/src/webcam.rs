use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};

const FFMPEG_PATH: &str = "/opt/homebrew/bin/ffmpeg";

pub struct WebcamSegmenter {
    camera_index: u32,
    sources_dir: PathBuf,
    segments: Vec<PathBuf>,
    current: Option<Child>,
    watchdog: Option<Child>,
}

impl WebcamSegmenter {
    pub fn new(camera_index: u32, sources_dir: PathBuf) -> Self {
        Self {
            camera_index,
            sources_dir,
            segments: Vec::new(),
            current: None,
            watchdog: None,
        }
    }

    pub fn start_segment(&mut self) -> Result<(), String> {
        if self.current.is_some() {
            return Err("webcam segment already running".into());
        }
        let segment_index = self.segments.len();
        let segment_path = self
            .sources_dir
            .join(format!("webcam-{segment_index:02}.mp4"));

        // Pin video_size so the browser-side getUserMedia preview keeps the
        // same camera mode when ffmpeg attaches as a second consumer.
        // Without this, macOS renegotiates to a different default mode and
        // the preview visibly "zooms" mid-recording.
        let child = Command::new(FFMPEG_PATH)
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
                &self.camera_index.to_string(),
                "-c:v",
                "h264_videotoolbox",
                "-b:v",
                "4M",
                "-pix_fmt",
                "nv12",
                "-an",
            ])
            .arg(&segment_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("failed to spawn webcam ffmpeg: {e}"))?;

        // D-04: detached parent-death watchdog. The webcam ffmpeg is a direct
        // child of this Tauri process; Drop and stop_segment kill it on
        // graceful teardown but NOT on crash/force-quit/SIGKILL — macOS has no
        // PR_SET_PDEATHSIG, and a Rust supervisor thread dies with the process.
        // A sibling /bin/sh polls BOTH pids and kills ffmpeg if Tauri dies
        // first. Both pids are baked in as literals at spawn time: a watchdog
        // that resolved the parent pid after launch would, by the time the
        // parent is dead, watch nothing. On Tauri death the watchdog reparents
        // to launchd, fires the kill, then self-exits; on graceful stop it is
        // reaped directly (see stop_segment/Drop) before it can fire.
        let ff_pid = child.id();
        let tauri_pid = std::process::id();
        let watchdog = Command::new("/bin/sh")
            .arg("-c")
            .arg(format!(
                "while kill -0 {ff} 2>/dev/null && kill -0 {tauri} 2>/dev/null; \
                 do sleep 1; done; kill -9 {ff} 2>/dev/null",
                ff = ff_pid,
                tauri = tauri_pid,
            ))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .ok(); // best-effort; absence must not block recording

        self.current = Some(child);
        self.watchdog = watchdog;
        self.segments.push(segment_path);
        Ok(())
    }

    pub fn stop_segment(&mut self) -> Result<(), String> {
        let result = if let Some(mut child) = self.current.take() {
            if let Some(mut stdin) = child.stdin.take() {
                let _ = stdin.write_all(b"q\n");
                let _ = stdin.flush();
            }
            child
                .wait()
                .map(|_| ())
                .map_err(|e| format!("webcam ffmpeg wait: {e}"))
        } else {
            Ok(())
        };
        // Reap directly once ffmpeg is gone: avoids a zombie on the normal
        // path and preempts the watchdog's poll from firing kill -9 on a
        // pid the OS may already have reused.
        self.reap_watchdog();
        result
    }

    fn reap_watchdog(&mut self) {
        if let Some(mut wd) = self.watchdog.take() {
            let _ = wd.kill();
            let _ = wd.wait();
        }
    }

    pub fn segments(&self) -> &[PathBuf] {
        &self.segments
    }

    pub fn sources_dir(&self) -> &Path {
        &self.sources_dir
    }
}

impl Drop for WebcamSegmenter {
    fn drop(&mut self) {
        if let Some(mut child) = self.current.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        self.reap_watchdog();
    }
}
