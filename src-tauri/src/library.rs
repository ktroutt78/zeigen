// The recordings library: kept recordings under ~/Movies/Zeigen/.recordings,
// one folder per recording in the same layout the scratch dir uses, so Review
// can reopen one with the exact arguments recording_finalize would give it.
//
// Two folder shapes:
//   with webcam:  sources/screen.mp4 + sources/webcam.mp4 (+ cursor log)
//   screen only:  recording-<stamp>.mp4 (the screen capture itself)
// Both keep the edit-state sidecar .recording-<stamp>.annotations.json in the
// folder root. <folder>/recording-<stamp>.mp4 is the logical key the sidecar
// resolves from even when no file exists there (webcam shape).
//
// The Recordings window's cache, also in the folder root and rebuilt from the
// recording when missing:
//   .probe.json         the screen file's duration and the length it was probed at
//   thumb-<ms>.jpg      the card's thumbnail, a frame <ms> into the screen file

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;

use tauri::{AppHandle, Emitter};

use crate::composite::{FFMPEG_PATH, WEBCAM_LEAD_MS};
use crate::edit::{self, SidecarState};

#[derive(Debug, Clone, serde::Serialize)]
pub struct LibraryRecording {
    pub stamp: String,
    pub scratch_mp4_path: String,
    pub screen_path: String,
    pub webcam_path: Option<String>,
    pub webcam_lead_ms: f64,
    pub source_kind: String,
    // What was recorded; None for recordings made before names existed.
    pub name: Option<String>,
    // None until the screen file has been probed, or when ffprobe cannot read it.
    pub duration_s: Option<f64>,
    pub size_bytes: u64,
    // None until the thumbnail for the current Mark has been made, or when
    // ffmpeg could not make it; the card shows a placeholder.
    pub thumb_path: Option<String>,
}

#[derive(Debug, serde::Serialize)]
pub struct Library {
    pub keep_days: i64,
    pub recordings: Vec<LibraryRecording>,
}

pub(crate) fn recordings_root() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME not set".to_string())?;
    Ok(PathBuf::from(home).join("Movies/Zeigen/.recordings"))
}

// Fill-ins run one at a time: a second list (the window regaining focus) waits
// for the first, then finds nothing left to do.
static REFRESH: Mutex<()> = Mutex::new(());

// Answers from what is on disk, without running ffprobe or ffmpeg. Missing
// durations and thumbnails are then made on a background thread, and each
// recording that changed is sent again as a `library-recording` event.
#[tauri::command]
pub async fn list_recordings(app: AppHandle) -> Result<Library, String> {
    let recordings = scan(&recordings_root()?);
    let dirs: Vec<PathBuf> = recordings
        .iter()
        .filter_map(|r| Path::new(&r.scratch_mp4_path).parent().map(Path::to_path_buf))
        .collect();
    std::thread::spawn(move || {
        let _one_at_a_time = REFRESH.lock();
        for dir in dirs {
            if refresh_folder(&dir, &edit::probe_duration_seconds, &extract_frame) {
                if let Some(r) = read_folder(&dir) {
                    let _ = app.emit("library-recording", r);
                }
            }
        }
    });
    Ok(Library { keep_days: KEEP_DAYS, recordings })
}

// Newest first. Folders without a sidecar or a screen file, or whose sidecar
// does not parse, are skipped rather than failing the whole list.
pub(crate) fn scan(root: &Path) -> Vec<LibraryRecording> {
    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    let mut out: Vec<LibraryRecording> = entries
        .flatten()
        .filter_map(|e| read_folder(&e.path()))
        .collect();
    // Stamps are YYYY-MM-DD-HHMMSS, so string order is time order.
    out.sort_by(|a, b| b.stamp.cmp(&a.stamp));
    out
}

struct Folder {
    stamp: String,
    scratch_mp4: PathBuf,
    screen: PathBuf,
    webcam: Option<PathBuf>,
    sidecar: SidecarState,
}

fn folder(dir: &Path) -> Option<Folder> {
    if !dir.is_dir() {
        return None;
    }
    let stamp = dir.file_name()?.to_str()?.strip_prefix("recording-")?.to_string();
    let scratch_mp4 = dir.join(format!("recording-{stamp}.mp4"));
    let sidecar = edit::read_sidecar_path(&scratch_mp4).ok()??;

    // Same choice recording_finalize and export_inputs_from_source make: a
    // sources/screen.mp4 means the webcam shape; otherwise the logical mp4 is
    // the screen capture.
    let sources_screen = dir.join("sources/screen.mp4");
    let (screen, webcam) = if sources_screen.is_file() {
        let webcam = dir.join("sources/webcam.mp4");
        (sources_screen, webcam.is_file().then_some(webcam))
    } else if scratch_mp4.is_file() {
        (scratch_mp4.clone(), None)
    } else {
        return None;
    };
    Some(Folder { stamp, scratch_mp4, screen, webcam, sidecar })
}

fn read_folder(dir: &Path) -> Option<LibraryRecording> {
    let f = folder(dir)?;
    let duration_s = cached_duration(dir, &f.screen).flatten();
    let thumb = thumb_time(f.sidecar.thumbnail_time, duration_s)
        .map(|t| thumb_path(dir, t))
        .filter(|p| p.is_file());
    Some(LibraryRecording {
        stamp: f.stamp,
        scratch_mp4_path: f.scratch_mp4.to_string_lossy().into_owned(),
        duration_s,
        screen_path: f.screen.to_string_lossy().into_owned(),
        webcam_path: f.webcam.map(|p| p.to_string_lossy().into_owned()),
        webcam_lead_ms: f.sidecar.webcam_lead_ms.unwrap_or(WEBCAM_LEAD_MS),
        source_kind: f.sidecar.source_kind.unwrap_or_else(|| "display".into()),
        name: f.sidecar.name,
        size_bytes: dir_size(dir),
        thumb_path: thumb.map(|p| p.to_string_lossy().into_owned()),
    })
}

// The thumbnail's frame: the Mark (poster frame) when one is set, otherwise
// about a second in, past the first frame, which is often black. Recordings
// shorter than two seconds use their midpoint. None while the duration is
// unknown.
fn thumb_time(mark: Option<f64>, duration_s: Option<f64>) -> Option<f64> {
    mark.or_else(|| duration_s.map(|d| if d < 2.0 { d / 2.0 } else { 1.0 }))
}

// The time is in the name, so a thumbnail made for an older Mark is simply not
// found, and the webview never shows a cached copy of the old picture.
fn thumb_path(dir: &Path, t: f64) -> PathBuf {
    dir.join(format!("thumb-{}.jpg", (t * 1000.0).round() as i64))
}

#[derive(serde::Serialize, serde::Deserialize)]
struct ProbeCache {
    screen_len: u64,
    duration_s: Option<f64>,
}

const PROBE_CACHE: &str = ".probe.json";

// Some(duration) when the cache was made for the screen file as it is now
// (same length); None when it must be probed. A failed probe is cached too,
// as Some(None), so an unreadable file is not probed again on every focus.
fn cached_duration(dir: &Path, screen: &Path) -> Option<Option<f64>> {
    let len = std::fs::metadata(screen).ok()?.len();
    let c: ProbeCache = serde_json::from_slice(&std::fs::read(dir.join(PROBE_CACHE)).ok()?).ok()?;
    (c.screen_len == len).then_some(c.duration_s)
}

type Probe<'a> = &'a dyn Fn(&Path) -> Result<f64, String>;
type Extract<'a> = &'a dyn Fn(&Path, f64, &Path) -> Result<(), String>;

// Makes whatever of the folder's cache is missing or stale: the duration, then
// the thumbnail for the current Mark. True when it wrote anything. A frame that
// cannot be extracted leaves no thumbnail (placeholder card) and no error.
fn refresh_folder(dir: &Path, probe: Probe, extract: Extract) -> bool {
    let Some(f) = folder(dir) else { return false };
    let mut changed = false;
    let duration_s = match cached_duration(dir, &f.screen) {
        Some(d) => d,
        None => {
            let d = probe(&f.screen).ok();
            let Ok(len) = std::fs::metadata(&f.screen).map(|m| m.len()) else { return false };
            let cache = serde_json::to_vec(&ProbeCache { screen_len: len, duration_s: d }).unwrap();
            changed = std::fs::write(dir.join(PROBE_CACHE), cache).is_ok();
            d
        }
    };
    let Some(t) = thumb_time(f.sidecar.thumbnail_time, duration_s) else { return changed };
    let thumb = thumb_path(dir, t);
    if thumb.is_file() {
        return changed;
    }
    // Written beside it and renamed, so the webview never loads half a file.
    let tmp = dir.join(".thumb-tmp.jpg");
    if let Err(e) = extract(&f.screen, t, &tmp).and_then(|_| {
        std::fs::rename(&tmp, &thumb).map_err(|e| format!("rename thumbnail: {e}"))
    }) {
        eprintln!("[library] no thumbnail for {}: {e}", dir.display());
        let _ = std::fs::remove_file(&tmp);
        return changed;
    }
    for old in std::fs::read_dir(dir).into_iter().flatten().flatten().map(|e| e.path()) {
        let name = old.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if name.starts_with("thumb-") && name.ends_with(".jpg") && old != thumb {
            let _ = std::fs::remove_file(&old);
        }
    }
    true
}

// One frame of the raw screen file, 480 px wide, as a JPEG.
fn extract_frame(screen: &Path, t: f64, out: &Path) -> Result<(), String> {
    let o = Command::new(FFMPEG_PATH)
        .args(["-v", "error", "-y", "-ss", &format!("{t:.3}"), "-i"])
        .arg(screen)
        .args(["-frames:v", "1", "-vf", "scale=480:-2", "-q:v", "4", "-f", "image2"])
        .arg(out)
        .output()
        .map_err(|e| format!("run ffmpeg: {e}"))?;
    // Seeking past the end exits 0 without writing a frame.
    if !o.status.success() || std::fs::metadata(out).map_or(true, |m| m.len() == 0) {
        return Err(format!("ffmpeg: {}", String::from_utf8_lossy(&o.stderr).trim()));
    }
    Ok(())
}

// Recordings are kept this long after they were made, then removed at launch
// (Keith, 2026-11-16). Age is the recording time in the folder's name, not the
// folder's modification time, which every reopen and edit would refresh.
const KEEP_DAYS: i64 = 30;

pub(crate) fn sweep_expired(root: &Path, now: chrono::NaiveDateTime) {
    let Ok(entries) = std::fs::read_dir(root) else { return };
    for dir in entries.flatten().map(|e| e.path()).filter(|p| p.is_dir()) {
        let made = dir
            .file_name()
            .and_then(|n| n.to_str())
            .and_then(|n| n.strip_prefix("recording-"))
            .and_then(|s| chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%d-%H%M%S").ok());
        if made.is_some_and(|m| now - m > chrono::Duration::days(KEEP_DAYS)) {
            eprintln!("[library] removing {} (older than {KEEP_DAYS} days)", dir.display());
            let _ = std::fs::remove_dir_all(&dir);
        }
    }
}

// Review is done with a recording but it stays in the library: drop what is
// rebuilt on the next open (the preview's audio-processed copy of the screen
// file, as large as the screen file itself) and the export temp files.
#[tauri::command]
pub fn release_recording(scratch_mp4_path: String) -> Result<(), String> {
    let dir = PathBuf::from(&scratch_mp4_path)
        .parent()
        .ok_or("recording path has no parent")?
        .to_path_buf();
    for preview in [dir.join("preview-screen.mp4"), dir.join("sources/preview-screen.mp4")] {
        let _ = std::fs::remove_file(preview);
    }
    if let Some(stamp) = dir.file_name().and_then(|n| n.to_str()).and_then(|n| n.strip_prefix("recording-")) {
        let _ = crate::exports::cleanup_recording_exports_internal(stamp);
    }
    Ok(())
}

fn dir_size(dir: &Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    entries
        .flatten()
        .map(|e| match e.file_type() {
            Ok(t) if t.is_dir() => dir_size(&e.path()),
            Ok(t) if t.is_file() => e.metadata().map(|m| m.len()).unwrap_or(0),
            _ => 0,
        })
        .sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: &Path, body: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, body).unwrap();
    }

    #[test]
    fn scans_both_shapes_and_skips_folders_without_sidecar() {
        let root = std::env::temp_dir().join(format!("zeigen-lib-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);

        // Webcam shape, older, measured lead and window source.
        let a = root.join("recording-2026-01-01-100000");
        write(&a.join("sources/screen.mp4"), "screen");
        write(&a.join("sources/webcam.mp4"), "cam");
        write(
            &a.join(".recording-2026-01-01-100000.annotations.json"),
            r#"{"webcam_lead_ms": -42.5, "source_kind": "window", "name": "Safari - Docs (Window)"}"#,
        );

        // Screen-only shape, newer, old sidecar without lead or source kind.
        let b = root.join("recording-2026-01-02-100000");
        write(&b.join("recording-2026-01-02-100000.mp4"), "screen only");
        write(&b.join(".recording-2026-01-02-100000.annotations.json"), "{}");

        // No sidecar: skipped.
        let c = root.join("recording-2026-01-03-100000");
        write(&c.join("recording-2026-01-03-100000.mp4"), "x");

        // Sidecar but no screen file: skipped.
        let d = root.join("recording-2026-01-04-100000");
        write(&d.join(".recording-2026-01-04-100000.annotations.json"), "{}");

        // Unparseable sidecar: skipped.
        let e = root.join("recording-2026-01-05-100000");
        write(&e.join("recording-2026-01-05-100000.mp4"), "x");
        write(&e.join(".recording-2026-01-05-100000.annotations.json"), "not json");

        let list = scan(&root);
        assert_eq!(list.len(), 2);

        let newest = &list[0];
        assert_eq!(newest.stamp, "2026-01-02-100000");
        assert_eq!(newest.screen_path, b.join("recording-2026-01-02-100000.mp4").to_string_lossy());
        assert_eq!(newest.scratch_mp4_path, newest.screen_path);
        assert!(newest.webcam_path.is_none());
        assert_eq!(newest.webcam_lead_ms, WEBCAM_LEAD_MS);
        assert_eq!(newest.source_kind, "display");
        assert!(newest.name.is_none());
        assert!(newest.duration_s.is_none()); // not a real mp4

        let older = &list[1];
        assert_eq!(older.stamp, "2026-01-01-100000");
        assert_eq!(older.scratch_mp4_path, a.join("recording-2026-01-01-100000.mp4").to_string_lossy());
        assert_eq!(older.screen_path, a.join("sources/screen.mp4").to_string_lossy());
        assert_eq!(older.webcam_path.as_deref(), Some(&*a.join("sources/webcam.mp4").to_string_lossy()));
        assert_eq!(older.webcam_lead_ms, -42.5);
        assert_eq!(older.source_kind, "window");
        assert_eq!(older.name.as_deref(), Some("Safari - Docs (Window)"));
        let sidecar_len = std::fs::metadata(a.join(".recording-2026-01-01-100000.annotations.json")).unwrap().len();
        assert_eq!(older.size_bytes, 6 + 3 + sidecar_len);

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn sweep_removes_only_recordings_older_than_thirty_days() {
        let root = std::env::temp_dir().join(format!("zeigen-sweep-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let old = root.join("recording-2026-01-01-100000");
        let fresh = root.join("recording-2026-01-20-100000");
        let other = root.join(".prewarm");
        for d in [&old, &fresh, &other] {
            write(&d.join("x"), "x");
        }
        let now = chrono::NaiveDateTime::parse_from_str("2026-02-01-100001", "%Y-%m-%d-%H%M%S").unwrap();
        sweep_expired(&root, now);
        assert!(!old.exists(), "31 days old: removed");
        assert!(fresh.exists(), "12 days old: kept");
        assert!(other.exists(), "not a recording folder: never touched");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn thumb_time_prefers_mark_then_one_second_then_midpoint() {
        assert_eq!(thumb_time(Some(7.5), Some(30.0)), Some(7.5));
        assert_eq!(thumb_time(Some(0.2), None), Some(0.2));
        assert_eq!(thumb_time(None, Some(30.0)), Some(1.0));
        assert_eq!(thumb_time(None, Some(2.0)), Some(1.0));
        assert_eq!(thumb_time(None, Some(1.2)), Some(0.6));
        assert_eq!(thumb_time(None, None), None);
    }

    // A screen-only folder whose sidecar holds `sidecar`.
    fn recording(root: &Path, sidecar: &str) -> PathBuf {
        let dir = root.join("recording-2026-01-01-100000");
        write(&dir.join("recording-2026-01-01-100000.mp4"), "screen");
        write(&dir.join(".recording-2026-01-01-100000.annotations.json"), sidecar);
        dir
    }

    fn temp_root(tag: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("zeigen-lib-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        root
    }

    #[test]
    fn refresh_probes_once_and_scan_never_probes() {
        let root = temp_root("probe");
        let dir = recording(&root, "{}");
        let probes = std::cell::Cell::new(0);
        let probe = |_: &Path| {
            probes.set(probes.get() + 1);
            Ok(12.0)
        };
        let extract = |_: &Path, _: f64, out: &Path| std::fs::write(out, "jpg").map_err(|e| e.to_string());

        // Before any refresh the scan shows the recording without a duration.
        assert!(scan(&root)[0].duration_s.is_none());

        assert!(refresh_folder(&dir, &probe, &extract));
        assert_eq!(probes.get(), 1);
        assert!(!refresh_folder(&dir, &probe, &extract), "nothing left to do");
        for _ in 0..3 {
            assert_eq!(scan(&root)[0].duration_s, Some(12.0));
        }
        assert_eq!(probes.get(), 1, "unchanged recording is not probed again");

        // A screen file of a different length is probed again.
        write(&dir.join("recording-2026-01-01-100000.mp4"), "longer screen");
        assert!(scan(&root)[0].duration_s.is_none());
        refresh_folder(&dir, &probe, &extract);
        assert_eq!(probes.get(), 2);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn thumbnail_follows_the_mark() {
        let root = temp_root("thumb");
        let dir = recording(&root, "{}");
        let made = std::cell::RefCell::new(Vec::new());
        let probe = |_: &Path| Ok(30.0);
        let extract = |_: &Path, t: f64, out: &Path| {
            made.borrow_mut().push(t);
            std::fs::write(out, "jpg").map_err(|e| e.to_string())
        };

        refresh_folder(&dir, &probe, &extract);
        assert_eq!(*made.borrow(), vec![1.0], "no mark: a second in");
        let first = scan(&root)[0].thumb_path.clone().unwrap();
        assert!(first.ends_with("thumb-1000.jpg"));

        refresh_folder(&dir, &probe, &extract);
        assert_eq!(made.borrow().len(), 1, "same mark: not made again");

        // Review sets a Mark: a new thumbnail, and the old one is removed.
        write(&dir.join(".recording-2026-01-01-100000.annotations.json"), r#"{"thumbnail_time": 7.25}"#);
        assert!(scan(&root)[0].thumb_path.is_none(), "stale thumbnail is not shown");
        assert!(refresh_folder(&dir, &probe, &extract));
        assert_eq!(*made.borrow(), vec![1.0, 7.25]);
        assert!(scan(&root)[0].thumb_path.clone().unwrap().ends_with("thumb-7250.jpg"));
        assert!(!Path::new(&first).exists());
        assert!(!dir.join(".thumb-tmp.jpg").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn failed_extract_or_probe_leaves_a_placeholder() {
        let root = temp_root("fail");
        let dir = recording(&root, "{}");
        let fail = |_: &Path, _: f64, out: &Path| {
            std::fs::write(out, "partial").unwrap();
            Err("ffmpeg: boom".to_string())
        };
        refresh_folder(&dir, &|_| Ok(30.0), &fail);
        let r = &scan(&root)[0];
        assert_eq!(r.duration_s, Some(30.0));
        assert!(r.thumb_path.is_none());
        assert!(!dir.join(".thumb-tmp.jpg").exists(), "partial output removed");

        // Unreadable screen file (the real ffmpeg on a non-video): no duration,
        // no thumbnail, cached so the next focus does not probe again.
        let root2 = temp_root("fail2");
        let dir2 = recording(&root2, "{}");
        let probes = std::cell::Cell::new(0);
        let probe = |p: &Path| {
            probes.set(probes.get() + 1);
            edit::probe_duration_seconds(p)
        };
        refresh_folder(&dir2, &probe, &extract_frame);
        refresh_folder(&dir2, &probe, &extract_frame);
        assert_eq!(probes.get(), 1);
        let r = &scan(&root2)[0];
        assert!(r.duration_s.is_none() && r.thumb_path.is_none());

        // A Mark on an unreadable file runs the real ffmpeg, which fails quietly.
        write(&dir2.join(".recording-2026-01-01-100000.annotations.json"), r#"{"thumbnail_time": 3.0}"#);
        assert!(!refresh_folder(&dir2, &probe, &extract_frame));
        assert!(scan(&root2)[0].thumb_path.is_none());
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&root2);
    }

    // Thumbnails of the real library written to a temp dir (the recordings are
    // only read), for eyeballing and timing:
    // cargo test --lib real_library_thumbs -- --ignored --nocapture
    #[test]
    #[ignore]
    fn real_library_thumbs() {
        let out = std::env::temp_dir().join("zeigen-real-thumbs");
        std::fs::create_dir_all(&out).unwrap();
        for dir in std::fs::read_dir(recordings_root().unwrap()).unwrap().flatten().map(|e| e.path()) {
            let Some(f) = folder(&dir) else { continue };
            let t0 = std::time::Instant::now();
            let d = edit::probe_duration_seconds(&f.screen).ok();
            let probe_ms = t0.elapsed().as_millis();
            let Some(t) = thumb_time(f.sidecar.thumbnail_time, d) else { continue };
            let jpg = out.join(format!("{}.jpg", f.stamp));
            let t1 = std::time::Instant::now();
            let r = extract_frame(&f.screen, t, &jpg);
            println!(
                "{} dur={d:?} mark={:?} t={t} probe={probe_ms}ms extract={}ms {:?} {}",
                f.stamp, f.sidecar.thumbnail_time, t1.elapsed().as_millis(), r.err(), jpg.display()
            );
        }
    }

    // Read-only listing of the real library, for eyeballing:
    // cargo test --lib list_real_library -- --ignored --nocapture
    #[test]
    #[ignore]
    fn list_real_library() {
        for r in scan(&recordings_root().unwrap()) {
            println!("{r:?}");
        }
    }
}
