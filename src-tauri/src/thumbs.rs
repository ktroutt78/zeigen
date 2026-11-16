use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

// Sweeps for stale files. The timeline scrub-thumbnail sprite this module used
// to build is gone (TIMELINE-PLAN step 2: the preview itself shows the hovered
// frame); the sweep of its cache dir stays so sprites left by older builds are
// cleaned up.

const STALE_THRESHOLD: Duration = Duration::from_secs(24 * 60 * 60);

fn thumbs_root() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME not set".to_string())?;
    let dir = PathBuf::from(home).join("Library/Caches/com.zeigen.app/thumbs");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    Ok(dir)
}

// App-launch safety net for sprites left over from sessions that didn't
// clean up. Best-effort; failures are silent.
pub fn sweep_stale_thumbs() {
    let root = match thumbs_root() {
        Ok(p) => p,
        Err(_) => return,
    };
    sweep_dir_older_than(&root, STALE_THRESHOLD, "thumb-sweep");
}

pub(crate) fn sweep_dir_older_than(root: &Path, threshold: Duration, label: &str) {
    let entries = match std::fs::read_dir(root) {
        Ok(e) => e,
        Err(_) => return,
    };
    let now = SystemTime::now();
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(meta) = entry.metadata() else { continue };
        let Ok(mtime) = meta.modified() else { continue };
        if let Ok(age) = now.duration_since(mtime) {
            if age > threshold {
                eprintln!(
                    "[{label}] removing stale {} (age {}h)",
                    path.display(),
                    age.as_secs() / 3600
                );
                if path.is_dir() {
                    let _ = std::fs::remove_dir_all(&path);
                } else {
                    let _ = std::fs::remove_file(&path);
                }
            }
        }
    }
}
