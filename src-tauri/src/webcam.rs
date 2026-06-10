use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Instant;

const FFMPEG_PATH: &str = "/opt/homebrew/bin/ffmpeg";

pub struct WebcamSegmenter {
    camera_index: u32,
    sources_dir: PathBuf,
    segments: Vec<PathBuf>,
    current: Option<Child>,
    watchdog: Option<Child>,
    // Phase B: thread that drains ffmpeg's stderr for the entire
    // child lifetime. Holds the stderr FD; never stops reading until
    // EOF (which arrives on ffmpeg process exit). Joined in
    // stop_segment / Drop after the child has been reaped, so the
    // join is microseconds — the OS has already closed stderr.
    stderr_reader: Option<JoinHandle<()>>,
    // Phase B: receipt instant of the first ffmpeg progress line
    // indicating a frame entered the encoding pipeline (frame=N,
    // N>=1). Set by the stderr reader on the first match; subsequent
    // matches no-op (single-set across segments — only segment 00's
    // first frame matters for the diagnostic, since that's webcam.mp4
    // PTS=0). None until set, None forever if marker never appears
    // (best-effort).
    first_frame_at: Arc<Mutex<Option<Instant>>>,
}

impl WebcamSegmenter {
    pub fn new(camera_index: u32, sources_dir: PathBuf) -> Self {
        Self {
            camera_index,
            sources_dir,
            segments: Vec::new(),
            current: None,
            watchdog: None,
            stderr_reader: None,
            first_frame_at: Arc::new(Mutex::new(None)),
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
        let mut child = Command::new(FFMPEG_PATH)
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
            // Phase B: capture stderr so we can detect ffmpeg's first
            // progress line. Must drain the pipe for the entire ffmpeg
            // lifetime — leaving stderr piped without a reader would
            // block ffmpeg once the pipe buffer (~64KB) fills.
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("failed to spawn webcam ffmpeg: {e}"))?;

        // Phase B: drain stderr for the entire ffmpeg lifetime.
        // First-frame detection happens inline; the loop continues
        // discarding bytes until EOF (ffmpeg exit closes stderr) or
        // an unrecoverable I/O error — at which point ffmpeg is
        // killed so it cannot outlive its drainer. The invariant
        // (ffmpeg never outlives the drainer) means no failure mode
        // here can produce a pipe-fill hang, even on 64-min recordings.
        //
        // read_until(b'\n', &mut Vec<u8>) is used instead of read_line
        // so a stray non-UTF8 byte in ffmpeg's stderr can't break the
        // reader. Lossy UTF-8 conversion is applied only when we
        // actually inspect a line.
        let first_frame_at_handle = Arc::clone(&self.first_frame_at);
        let ff_pid_for_reader = child.id();
        let stderr_reader = child.stderr.take().map(|stderr| {
            std::thread::spawn(move || {
                let mut reader = BufReader::new(stderr);
                let mut buf: Vec<u8> = Vec::with_capacity(256);
                let mut frame_seen = false;
                loop {
                    buf.clear();
                    match reader.read_until(b'\n', &mut buf) {
                        Ok(0) => break, // EOF — ffmpeg exited
                        Ok(_) => {}
                        Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                        Err(_) => {
                            // Unexpected I/O error mid-recording.
                            // ffmpeg may still be alive with stderr
                            // piped to nobody; on a long recording
                            // its pipe buffer (~64KB) would fill in
                            // ~1 min and FREEZE THE CAPTURE. Enforce
                            // the invariant that ffmpeg can never
                            // outlive its drainer — kill it before
                            // breaking. Best-effort; shells out via
                            // /bin/kill so no libc dep is needed.
                            let _ = Command::new("/bin/kill")
                                .arg("-KILL")
                                .arg(ff_pid_for_reader.to_string())
                                .stdin(Stdio::null())
                                .stdout(Stdio::null())
                                .stderr(Stdio::null())
                                .status();
                            break;
                        }
                    }
                    if !frame_seen {
                        let line = String::from_utf8_lossy(&buf);
                        if line_has_frame_count(&line) {
                            if let Ok(mut guard) = first_frame_at_handle.lock() {
                                if guard.is_none() {
                                    *guard = Some(Instant::now());
                                }
                            }
                            frame_seen = true;
                        }
                    }
                    // Line otherwise discarded — keep the pipe clear.
                }
            })
        });

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
        self.stderr_reader = stderr_reader;
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
        // Phase B: join the stderr reader. By the time child.wait()
        // returned above, ffmpeg has exited and the OS has closed its
        // stderr FD, so the reader's read_line returned Ok(0) and the
        // thread is exiting / already exited. join completes in
        // microseconds. Best-effort: swallow any join error.
        if let Some(handle) = self.stderr_reader.take() {
            let _ = handle.join();
        }
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

    // Phase B accessor: returns the receipt instant of the first
    // ffmpeg progress line indicating a frame entered the encoding
    // pipeline, or None if no frame was ever observed (marker missed
    // / recording too short / exotic ffmpeg build). Diagnostic-only.
    pub fn first_frame_at(&self) -> Option<Instant> {
        self.first_frame_at.lock().ok().and_then(|g| *g)
    }
}

impl Drop for WebcamSegmenter {
    fn drop(&mut self) {
        if let Some(mut child) = self.current.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        // Phase B: kill above closed stderr, so the reader is exiting.
        if let Some(handle) = self.stderr_reader.take() {
            let _ = handle.join();
        }
        self.reap_watchdog();
    }
}

// Phase B parser: matches ffmpeg's default progress lines like
// "frame=    1 fps=0.0 ...". Returns true iff the line contains
// "frame=" followed (after optional whitespace) by a digit run
// parsing as N >= 1. Rejects info lines (Stream #0:0, Input #0,
// etc.) and rejects "frame=0" if it ever appears during setup —
// we want the first reported frame to actually be a frame.
fn line_has_frame_count(line: &str) -> bool {
    let Some(idx) = line.find("frame=") else {
        return false;
    };
    let tail = line[idx + "frame=".len()..].trim_start();
    let digits: String = tail.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() {
        return false;
    }
    digits.parse::<u64>().map(|n| n >= 1).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::line_has_frame_count;

    #[test]
    fn matches_typical_progress_line() {
        assert!(line_has_frame_count(
            "frame=    1 fps=0.0 q=0.0 size=       0kB time=00:00:00.03 bitrate=   0.0kbits/s speed=0.0653x"
        ));
        assert!(line_has_frame_count(
            "frame=  150 fps= 30 q=24.0 size=     128kB time=00:00:05.00 bitrate=...",
        ));
        assert!(line_has_frame_count("frame=1"));
        assert!(line_has_frame_count("frame=22"));
    }

    #[test]
    fn rejects_zero_frame() {
        assert!(!line_has_frame_count("frame=    0 fps=0.0 ..."));
        assert!(!line_has_frame_count("frame=0"));
    }

    #[test]
    fn rejects_info_lines() {
        assert!(!line_has_frame_count("Input #0, avfoundation, from '0':"));
        assert!(!line_has_frame_count("Stream #0:0: Video: rawvideo, uyvy422, 1280x720"));
        assert!(!line_has_frame_count("Output #0, mp4, to 'webcam-00.mp4':"));
        assert!(!line_has_frame_count(""));
    }

    #[test]
    fn rejects_nondigit_tail() {
        assert!(!line_has_frame_count("frame=N/A"));
        assert!(!line_has_frame_count("frame="));
    }
}
