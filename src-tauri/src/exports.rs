use std::path::PathBuf;
use std::time::{Duration, SystemTime};

// Per-recording subdir under the user's Caches root. Hosts temp artifacts
// from Phase 6 export rows that don't commit the source recording (Copy
// to Clipboard's transcoded copy, future preview thumbnails, etc.). The
// macOS convention puts these under ~/Library/Caches/<bundle_id>/ — Time
// Machine ignores them, the OS may purge under disk pressure, and the
// app is responsible for orderly cleanup.
//
// Layout:
//   ~/Library/Caches/com.zeigen.app/exports/recording-<stamp>/...
//
// Cleaned up on: footer Discard, close window, "Record another", and
// app-launch sweep for anything older than STALE_THRESHOLD.

const STALE_THRESHOLD: Duration = Duration::from_secs(24 * 60 * 60);

fn exports_root() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME not set".to_string())?;
    let dir = PathBuf::from(home).join("Library/Caches/com.zeigen.app/exports");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("create {}: {e}", dir.display()))?;
    Ok(dir)
}

pub fn recording_exports_dir(stamp: &str) -> Result<PathBuf, String> {
    let root = exports_root()?;
    let dir = root.join(format!("recording-{stamp}"));
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("create {}: {e}", dir.display()))?;
    Ok(dir)
}

// Idempotent: silent no-op if the dir doesn't exist.
pub fn cleanup_recording_exports_internal(stamp: &str) -> Result<(), String> {
    let root = match exports_root() {
        Ok(p) => p,
        Err(_) => return Ok(()),
    };
    let dir = root.join(format!("recording-{stamp}"));
    if dir.exists() {
        std::fs::remove_dir_all(&dir)
            .map_err(|e| format!("remove {}: {e}", dir.display()))?;
    }
    Ok(())
}

#[tauri::command]
pub fn cleanup_recording_exports(stamp: String) -> Result<(), String> {
    cleanup_recording_exports_internal(&stamp)
}

// App-launch safety net for orphans from prior sessions that crashed or
// force-quit before the per-recording cleanup ran. Best-effort — failures
// are silent so a hostile cache state never blocks startup.
pub fn sweep_stale_exports() {
    let root = match exports_root() {
        Ok(p) => p,
        Err(_) => return,
    };
    let entries = match std::fs::read_dir(&root) {
        Ok(e) => e,
        Err(_) => return,
    };
    let now = SystemTime::now();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        let Ok(mtime) = meta.modified() else { continue };
        if let Ok(age) = now.duration_since(mtime) {
            if age > STALE_THRESHOLD {
                let _ = std::fs::remove_dir_all(&path);
            }
        }
    }
}
