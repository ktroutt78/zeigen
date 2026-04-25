use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};

const FFMPEG_PATH: &str = "/opt/homebrew/bin/ffmpeg";

pub struct WebcamSegmenter {
    camera_index: u32,
    sources_dir: PathBuf,
    segments: Vec<PathBuf>,
    current: Option<Child>,
}

impl WebcamSegmenter {
    pub fn new(camera_index: u32, sources_dir: PathBuf) -> Self {
        Self {
            camera_index,
            sources_dir,
            segments: Vec::new(),
            current: None,
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

        self.current = Some(child);
        self.segments.push(segment_path);
        Ok(())
    }

    pub fn stop_segment(&mut self) -> Result<(), String> {
        let Some(mut child) = self.current.take() else {
            return Ok(());
        };
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(b"q\n");
            let _ = stdin.flush();
        }
        let _ = child.wait().map_err(|e| format!("webcam ffmpeg wait: {e}"))?;
        Ok(())
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
    }
}
