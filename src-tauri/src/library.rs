// The recordings library: kept recordings under <active root>/.recordings
// (storage.rs; ~/Movies/Zeigen/.recordings by default), one folder per recording in the same layout the scratch dir uses, so Review
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
//   thumb-<ms>-<edit>.jpg  the card's thumbnail: the finished picture (the
//                       export's render) <ms> into the recording, for the edit
//                       whose sidecar hashes to <edit>

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;

use tauri::{AppHandle, Emitter};

use crate::composite::{FFMPEG_PATH, WEBCAM_LEAD_MS};
use crate::edit::{self, SidecarState};
use crate::storage;

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
    // None until the thumbnail for the current Mark and edit has been made, or
    // when it could not be made; the card shows a placeholder.
    pub thumb_path: Option<String>,
    // Made while the Save to folder was on a drive and not moved there yet; it
    // is still in ~/Movies/Zeigen/.recordings (storage.rs).
    pub pending_move: bool,
}

#[derive(Debug, serde::Serialize)]
pub struct Library {
    pub keep_days: i64,
    pub recordings: Vec<LibraryRecording>,
}

// Fill-ins run one at a time: a second list (the window regaining focus) waits
// for the first, then finds nothing left to do.
static REFRESH: Mutex<()> = Mutex::new(());

// Answers from what is on disk, without running ffprobe or ffmpeg. Then, on a
// background thread: recordings waiting to move to the Save to folder are moved
// when it is available (a `library-changed` event asks for a fresh list), and
// missing durations and thumbnails are made, each recording that changed sent
// again as a `library-recording` event.
#[tauri::command]
pub async fn list_recordings(app: AppHandle) -> Result<Library, String> {
    let default_lib = storage::library(&storage::default_root()?);
    if storage::chosen().is_none() {
        storage::clear_pending(&default_lib);
    }
    let current_lib = storage::library(&storage::active()?.root);
    let recordings = list_for(&default_lib, &current_lib);
    std::thread::spawn(move || {
        let _one_at_a_time = REFRESH.lock();
        if retry_pending_moves(&app) > 0 {
            let _ = app.emit("library-changed", ());
        }
        let current_lib = match storage::active() {
            Ok(a) => storage::library(&a.root),
            Err(_) => return,
        };
        for r in list_for(&default_lib, &current_lib) {
            let Some(dir) = Path::new(&r.scratch_mp4_path).parent() else { continue };
            if refresh_folder(dir, &edit::probe_duration_seconds, &make_thumb) {
                if let Some(r) = read_folder(dir) {
                    let _ = app.emit("library-recording", r);
                }
            }
        }
    });
    Ok(Library { keep_days: KEEP_DAYS, recordings })
}

// The current library, plus the default library's recordings still waiting to
// move when the current library is elsewhere.
pub(crate) fn list_for(default_lib: &Path, current_lib: &Path) -> Vec<LibraryRecording> {
    let mut out = scan(current_lib);
    if current_lib != default_lib {
        out.extend(scan(default_lib).into_iter().filter(|r| r.pending_move));
        out.sort_by(|a, b| b.stamp.cmp(&a.stamp));
    }
    out
}

// Moves recordings waiting in the default library to the chosen folder's
// library when it is available, skipping any being recorded or open in Review.
// Returns how many moved.
pub(crate) fn retry_pending_moves(app: &AppHandle) -> usize {
    let (Ok(default), Some(chosen)) = (storage::default_root(), storage::chosen()) else { return 0 };
    if !storage::is_available(&chosen) {
        return 0;
    }
    storage::retry_pending(
        &storage::library(&default),
        &storage::library(&chosen),
        &|d| crate::recording_in_use(app, d),
    )
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
    // Hash of the sidecar's bytes: a new edit wants a new thumbnail.
    edit_key: String,
}

fn folder(dir: &Path) -> Option<Folder> {
    if !dir.is_dir() {
        return None;
    }
    let stamp = dir.file_name()?.to_str()?.strip_prefix("recording-")?.to_string();
    let scratch_mp4 = dir.join(format!("recording-{stamp}.mp4"));
    let sidecar = edit::read_sidecar_path(&scratch_mp4).ok()??;
    let edit_key = {
        use std::hash::{Hash, Hasher};
        let mut h = std::hash::DefaultHasher::new();
        std::fs::read(edit::sidecar_path(&scratch_mp4)).ok()?.hash(&mut h);
        format!("{:016x}", h.finish())
    };

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
    Some(Folder { stamp, scratch_mp4, screen, webcam, sidecar, edit_key })
}

pub(crate) fn read_folder(dir: &Path) -> Option<LibraryRecording> {
    let f = folder(dir)?;
    let duration_s = cached_duration(dir, &f.screen).flatten();
    let thumb = thumb_time(f.sidecar.thumbnail_time, duration_s)
        .map(|t| thumb_path(dir, t, &f.edit_key))
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
        pending_move: storage::is_pending(dir),
    })
}

// The thumbnail's frame: the Mark (poster frame) when one is set, otherwise
// about a second in, past the first frame, which is often black. Recordings
// shorter than two seconds use their midpoint. None while the duration is
// unknown.
fn thumb_time(mark: Option<f64>, duration_s: Option<f64>) -> Option<f64> {
    mark.or_else(|| duration_s.map(|d| if d < 2.0 { d / 2.0 } else { 1.0 }))
}

// The time and the edit are in the name, so a thumbnail made for an older Mark
// or edit is simply not found, and the webview never shows a cached copy of the
// old picture.
fn thumb_path(dir: &Path, t: f64, edit_key: &str) -> PathBuf {
    dir.join(format!("thumb-{}-{edit_key}.jpg", (t * 1000.0).round() as i64))
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
type Thumb<'a> = &'a dyn Fn(&Folder, f64, &Path) -> Result<(), String>;

// Makes whatever of the folder's cache is missing or stale: the duration, then
// the thumbnail for the current Mark and edit. True when it wrote anything. A
// thumbnail that cannot be made leaves none (placeholder card) and no error.
fn refresh_folder(dir: &Path, probe: Probe, make: Thumb) -> bool {
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
    let thumb = thumb_path(dir, t, &f.edit_key);
    if thumb.is_file() {
        return changed;
    }
    // Written beside it and renamed, so the webview never loads half a file.
    let tmp = dir.join(".thumb-tmp.jpg");
    if let Err(e) = make(&f, t, &tmp).and_then(|_| {
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

// The finished picture at `t`, drawn by the export's render (edit::render_still).
// A render that fails for any reason falls back to the plain screen frame.
fn make_thumb(f: &Folder, t: f64, out: &Path) -> Result<(), String> {
    let work = f.scratch_mp4.with_file_name(".thumb-work");
    match edit::render_still(&f.scratch_mp4, t, &work, out) {
        Ok(true) => Ok(()),
        Ok(false) => extract_frame(&f.screen, t, out),
        Err(e) => {
            eprintln!("[library] thumbnail render failed, using the screen frame: {e}");
            extract_frame(&f.screen, t, out)
        }
    }
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

    // A recording staged in the default library for a Save to folder on a drive
    // is listed as waiting; once the retry moves it, it is listed from the
    // chosen library and the default library no longer has it.
    #[test]
    fn pending_recording_is_listed_then_moves_to_the_chosen_library() {
        let root = temp_root("pending");
        let default_lib = root.join("default/.recordings");
        let chosen_lib = root.join("chosen/.recordings");
        let kept = chosen_lib.join("recording-2026-01-01-100000");
        write(&kept.join("recording-2026-01-01-100000.mp4"), "screen");
        write(&kept.join(".recording-2026-01-01-100000.annotations.json"), "{}");
        let staged = default_lib.join("recording-2026-01-02-100000");
        write(&staged.join("recording-2026-01-02-100000.mp4"), "screen");
        write(&staged.join(".recording-2026-01-02-100000.annotations.json"), "{}");
        write(&staged.join(storage::PENDING_MOVE), "");
        // An ordinary default-library recording is not part of the chosen list.
        let other = default_lib.join("recording-2026-01-03-100000");
        write(&other.join("recording-2026-01-03-100000.mp4"), "screen");
        write(&other.join(".recording-2026-01-03-100000.annotations.json"), "{}");

        let list = list_for(&default_lib, &chosen_lib);
        let stamps: Vec<_> = list.iter().map(|r| (r.stamp.as_str(), r.pending_move)).collect();
        assert_eq!(stamps, vec![("2026-01-02-100000", true), ("2026-01-01-100000", false)]);

        assert_eq!(storage::retry_pending(&default_lib, &chosen_lib, &|_| false), 1);
        let list = list_for(&default_lib, &chosen_lib);
        assert_eq!(list.len(), 2);
        let moved = list.iter().find(|r| r.stamp == "2026-01-02-100000").unwrap();
        assert!(!moved.pending_move);
        assert!(moved.scratch_mp4_path.starts_with(&*chosen_lib.to_string_lossy()));
        assert!(scan(&default_lib).iter().all(|r| r.stamp != "2026-01-02-100000"));
        let _ = std::fs::remove_dir_all(&root);
    }

    // The clean-up is given the current library only; another library's
    // recordings, however old, are not touched.
    #[test]
    fn sweep_touches_only_the_library_it_is_given() {
        let root = temp_root("sweep-current");
        let current = root.join("chosen/.recordings");
        let default_lib = root.join("default/.recordings");
        let old_current = current.join("recording-2026-01-01-100000");
        let old_default = default_lib.join("recording-2026-01-01-100000");
        for d in [&old_current, &old_default] {
            write(&d.join("x"), "x");
        }
        write(&old_default.join(storage::PENDING_MOVE), "");
        let now = chrono::NaiveDateTime::parse_from_str("2026-03-01-100000", "%Y-%m-%d-%H%M%S").unwrap();
        sweep_expired(&current, now);
        assert!(!old_current.exists());
        assert!(old_default.exists(), "not in the current library: not swept");
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
        let extract = |_: &Folder, _: f64, out: &Path| std::fs::write(out, "jpg").map_err(|e| e.to_string());

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
        let extract = |_: &Folder, t: f64, out: &Path| {
            made.borrow_mut().push(t);
            std::fs::write(out, "jpg").map_err(|e| e.to_string())
        };

        refresh_folder(&dir, &probe, &extract);
        assert_eq!(*made.borrow(), vec![1.0], "no mark: a second in");
        let first = scan(&root)[0].thumb_path.clone().unwrap();
        assert!(first.contains("/thumb-1000-"));

        refresh_folder(&dir, &probe, &extract);
        assert_eq!(made.borrow().len(), 1, "same mark: not made again");

        // Review sets a Mark: a new thumbnail, and the old one is removed.
        write(&dir.join(".recording-2026-01-01-100000.annotations.json"), r#"{"thumbnail_time": 7.25}"#);
        assert!(scan(&root)[0].thumb_path.is_none(), "stale thumbnail is not shown");
        assert!(refresh_folder(&dir, &probe, &extract));
        assert_eq!(*made.borrow(), vec![1.0, 7.25]);
        assert!(scan(&root)[0].thumb_path.clone().unwrap().contains("/thumb-7250-"));
        assert!(!Path::new(&first).exists());
        assert!(!dir.join(".thumb-tmp.jpg").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn failed_extract_or_probe_leaves_a_placeholder() {
        let root = temp_root("fail");
        let dir = recording(&root, "{}");
        let fail = |_: &Folder, _: f64, out: &Path| {
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
        refresh_folder(&dir2, &probe, &make_thumb);
        refresh_folder(&dir2, &probe, &make_thumb);
        assert_eq!(probes.get(), 1);
        let r = &scan(&root2)[0];
        assert!(r.duration_s.is_none() && r.thumb_path.is_none());

        // A Mark on an unreadable file runs the real ffmpeg, which fails quietly.
        write(&dir2.join(".recording-2026-01-01-100000.annotations.json"), r#"{"thumbnail_time": 3.0}"#);
        assert!(!refresh_folder(&dir2, &probe, &make_thumb));
        assert!(scan(&root2)[0].thumb_path.is_none());
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&root2);
    }

    // A webcam recording like the export tests' (blue screen with sound, red
    // webcam, bubble bottom-right, a Full webcam scene from 1.5 s to 3.2 s), the
    // Mark at `mark`.
    fn synth_webcam_recording(root: &Path, mark: f64) -> PathBuf {
        let dir = root.join("recording-2026-01-01-100000");
        let sources = dir.join("sources");
        std::fs::create_dir_all(&sources).unwrap();
        let synth = |out: &Path, args: &[&str]| {
            let o = Command::new(FFMPEG_PATH).args(["-y", "-v", "error"]).args(args)
                .args(["-c:v", "libx264", "-pix_fmt", "yuv420p"]).arg(out).output().unwrap();
            assert!(o.status.success(), "synth: {}", String::from_utf8_lossy(&o.stderr));
        };
        synth(&sources.join("screen.mp4"), &["-f", "lavfi", "-i", "color=c=blue:s=1280x720:r=30:d=4",
            "-f", "lavfi", "-i", "sine=frequency=440:duration=4", "-c:a", "aac", "-shortest"]);
        synth(&sources.join("webcam.mp4"), &["-f", "lavfi", "-i", "color=c=red:s=480x480:r=30:d=4"]);
        set_mark(&dir, mark, "bottom_right");
        dir
    }

    fn set_mark(dir: &Path, mark: f64, zone: &str) {
        let sidecar = format!(
            r#"{{"thumbnail_time": {mark}, "bubble_zone": "{zone}",
                "scenes": [{{"start": 1.5, "end": 3.2, "layout": "full_webcam"}}]}}"#
        );
        write(&dir.join(".recording-2026-01-01-100000.annotations.json"), &sidecar);
    }

    // Mean colour of an 8x8 patch of a JPEG.
    fn patch(jpg: &Path, x: u32, y: u32) -> (u8, u8, u8) {
        let o = Command::new(FFMPEG_PATH)
            .args(["-v", "error", "-i"]).arg(jpg)
            .args(["-vf", &format!("crop=8:8:{x}:{y},scale=1:1:flags=area"), "-f", "rawvideo", "-pix_fmt", "rgb24", "-"])
            .output().unwrap();
        assert_eq!(o.stdout.len(), 3, "{}", String::from_utf8_lossy(&o.stderr));
        (o.stdout[0], o.stdout[1], o.stdout[2])
    }
    fn red((r, _, b): (u8, u8, u8)) -> bool { r > 150 && b < 100 }
    fn blue((r, _, b): (u8, u8, u8)) -> bool { b > 150 && r < 100 }
    // Any red patch in the bottom-right quarter of a 480x270 thumbnail.
    fn has_bubble(jpg: &Path) -> bool {
        (0..10).flat_map(|i| (0..6).map(move |j| (244 + i * 22, 137 + j * 21))).any(|(x, y)| red(patch(jpg, x, y)))
    }

    // The thumbnail is the finished picture: inside the Full webcam scene it is
    // the webcam (red), outside it the screen (blue) with the bubble.
    #[test]
    fn thumbnail_is_the_finished_picture() {
        let root = temp_root("finished");
        let dir = synth_webcam_recording(&root, 2.4);
        let probe = &edit::probe_duration_seconds;
        assert!(refresh_folder(&dir, probe, &make_thumb));
        let jpg = PathBuf::from(scan(&root)[0].thumb_path.clone().expect("thumbnail made"));
        assert!(red(patch(&jpg, 236, 131)), "in the scene: webcam fills the picture {:?}", patch(&jpg, 236, 131));
        assert!(red(patch(&jpg, 20, 20)), "in the scene: corner {:?}", patch(&jpg, 20, 20));

        set_mark(&dir, 0.5, "bottom_right");
        assert!(refresh_folder(&dir, probe, &make_thumb));
        let jpg2 = PathBuf::from(scan(&root)[0].thumb_path.clone().unwrap());
        assert!(blue(patch(&jpg2, 236, 131)), "outside the scene: the screen {:?}", patch(&jpg2, 236, 131));
        assert!(has_bubble(&jpg2), "outside the scene: the webcam bubble shows");
        assert!(!jpg.exists(), "the older thumbnail is removed");
        assert!(!dir.join(".thumb-work").exists(), "render work folder removed");
        let _ = std::fs::remove_dir_all(&root);
    }

    // Made again when the edit changes (same Mark), not when nothing changed.
    #[test]
    fn thumbnail_follows_the_edit() {
        let root = temp_root("edit");
        let dir = recording(&root, r#"{"thumbnail_time": 2.0}"#);
        let made = std::cell::Cell::new(0);
        let make = |_: &Folder, _: f64, out: &Path| {
            made.set(made.get() + 1);
            std::fs::write(out, "jpg").map_err(|e| e.to_string())
        };
        refresh_folder(&dir, &|_| Ok(30.0), &make);
        refresh_folder(&dir, &|_| Ok(30.0), &make);
        assert_eq!(made.get(), 1, "nothing changed: not made again");
        let first = scan(&root)[0].thumb_path.clone().unwrap();
        write(&dir.join(".recording-2026-01-01-100000.annotations.json"),
            r#"{"thumbnail_time": 2.0, "bubble_zone": "top_left"}"#);
        assert!(scan(&root)[0].thumb_path.is_none(), "the old edit's thumbnail is not shown");
        assert!(refresh_folder(&dir, &|_| Ok(30.0), &make));
        assert_eq!(made.get(), 2, "edit changed: made again");
        assert!(!Path::new(&first).exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    // A render that fails (here a damaged cursor log, which also fails the
    // export) falls back to the plain screen frame: blue, no bubble.
    #[test]
    fn failed_render_falls_back_to_the_screen_frame() {
        let root = temp_root("fallback");
        let dir = synth_webcam_recording(&root, 0.5);
        write(&dir.join("sources/.screen.cursor.json"), "not json");
        assert!(edit::render_still(&dir.join("recording-2026-01-01-100000.mp4"), 0.5,
            &root.join("work"), &root.join("x.jpg")).is_err());
        assert!(refresh_folder(&dir, &edit::probe_duration_seconds, &make_thumb));
        let jpg = PathBuf::from(scan(&root)[0].thumb_path.clone().expect("plain thumbnail made"));
        assert!(blue(patch(&jpg, 236, 131)));
        assert!(!has_bubble(&jpg), "plain screen frame: no bubble");
        let _ = std::fs::remove_dir_all(&root);
    }

    // Thumbnails of the real library written to a temp dir (the recordings are
    // only read; the render's work folder is in the temp dir too), for
    // eyeballing and timing:
    // cargo test --lib real_library_thumbs -- --ignored --nocapture
    #[test]
    #[ignore]
    fn real_library_thumbs() {
        let out = std::env::temp_dir().join("zeigen-real-thumbs");
        std::fs::create_dir_all(&out).unwrap();
        for dir in std::fs::read_dir(storage::library(&storage::active().unwrap().root)).unwrap().flatten().map(|e| e.path()) {
            let Some(f) = folder(&dir) else { continue };
            let d = edit::probe_duration_seconds(&f.screen).ok();
            let Some(t) = thumb_time(f.sidecar.thumbnail_time, d) else { continue };
            // THUMB_AT=0.9 times the frame at 90% of the recording instead.
            let t = std::env::var("THUMB_AT").ok().and_then(|v| v.parse::<f64>().ok()).zip(d).map_or(t, |(k, d)| k * d);
            let plain = out.join(format!("{}-plain.jpg", f.stamp));
            let t0 = std::time::Instant::now();
            let p = extract_frame(&f.screen, t, &plain);
            let plain_ms = t0.elapsed().as_millis();
            let done = out.join(format!("{}-finished.jpg", f.stamp));
            let t1 = std::time::Instant::now();
            let r = edit::render_still(&f.scratch_mp4, t, &out.join(format!("work-{}", f.stamp)), &done);
            println!(
                "{} dur={d:?} mark={:?} t={t} plain={plain_ms}ms {:?} finished={}ms {r:?}",
                f.stamp, f.sidecar.thumbnail_time, p.err(), t1.elapsed().as_millis()
            );
        }
    }

    // Read-only listing of the real library, for eyeballing:
    // cargo test --lib list_real_library -- --ignored --nocapture
    #[test]
    #[ignore]
    fn list_real_library() {
        for r in scan(&storage::library(&storage::active().unwrap().root)) {
            println!("{r:?}");
        }
    }
}
