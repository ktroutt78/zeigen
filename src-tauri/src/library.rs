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

use std::path::{Path, PathBuf};

use crate::composite::WEBCAM_LEAD_MS;
use crate::edit;

#[derive(Debug, serde::Serialize)]
pub struct LibraryRecording {
    pub stamp: String,
    pub scratch_mp4_path: String,
    pub screen_path: String,
    pub webcam_path: Option<String>,
    pub webcam_lead_ms: f64,
    pub source_kind: String,
    // None when ffprobe cannot read the screen file.
    pub duration_s: Option<f64>,
    pub size_bytes: u64,
}

pub(crate) fn recordings_root() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME not set".to_string())?;
    Ok(PathBuf::from(home).join("Movies/Zeigen/.recordings"))
}

#[tauri::command]
pub async fn list_recordings() -> Result<Vec<LibraryRecording>, String> {
    Ok(scan(&recordings_root()?))
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

fn read_folder(dir: &Path) -> Option<LibraryRecording> {
    if !dir.is_dir() {
        return None;
    }
    let stamp = dir.file_name()?.to_str()?.strip_prefix("recording-")?.to_string();
    let scratch_mp4 = dir.join(format!("recording-{stamp}.mp4"));
    let sidecar = edit::read_sidecar_path(&scratch_mp4).ok()??;

    // Same choice recording_finalize makes: a sources/screen.mp4 means the
    // webcam shape; otherwise the logical mp4 is the screen capture.
    let sources_screen = dir.join("sources/screen.mp4");
    let (screen, webcam) = if sources_screen.is_file() {
        let webcam = dir.join("sources/webcam.mp4");
        (sources_screen, webcam.is_file().then_some(webcam))
    } else if scratch_mp4.is_file() {
        (scratch_mp4.clone(), None)
    } else {
        return None;
    };

    Some(LibraryRecording {
        stamp,
        scratch_mp4_path: scratch_mp4.to_string_lossy().into_owned(),
        duration_s: edit::probe_duration_seconds(&screen).ok(),
        screen_path: screen.to_string_lossy().into_owned(),
        webcam_path: webcam.map(|p| p.to_string_lossy().into_owned()),
        webcam_lead_ms: sidecar.webcam_lead_ms.unwrap_or(WEBCAM_LEAD_MS),
        source_kind: sidecar.source_kind.unwrap_or_else(|| "display".into()),
        size_bytes: dir_size(dir),
    })
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
            r#"{"webcam_lead_ms": -42.5, "source_kind": "window"}"#,
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
        assert!(newest.duration_s.is_none()); // not a real mp4

        let older = &list[1];
        assert_eq!(older.stamp, "2026-01-01-100000");
        assert_eq!(older.scratch_mp4_path, a.join("recording-2026-01-01-100000.mp4").to_string_lossy());
        assert_eq!(older.screen_path, a.join("sources/screen.mp4").to_string_lossy());
        assert_eq!(older.webcam_path.as_deref(), Some(&*a.join("sources/webcam.mp4").to_string_lossy()));
        assert_eq!(older.webcam_lead_ms, -42.5);
        assert_eq!(older.source_kind, "window");
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
