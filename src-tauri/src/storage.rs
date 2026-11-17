// Where files go. The one place that answers it (DECISIONS 2026-11-17, save
// location setting).
//
//   default root   ~/Movies/Zeigen, always on this Mac; prewarm scratch and the
//                  stale-scratch sweep stay here whatever the setting says.
//   chosen root    the "Save to" setting (settings.save_dir), or the default.
//   active root    the chosen root when it is available (exists, is a folder,
//                  can be written to), otherwise the default. Exports go here and
//                  its `.recordings` is the library the Recordings window shows.
//
// A chosen folder is never created: a missing /Volumes/<drive>/... must read as
// unavailable, not appear on the internal disk.
//
// A recording made while the chosen folder is on another volume (an external
// drive) is written to the default library first, with a `.pending-move`
// marker, and moved at finalize; one whose move fails keeps its marker and is
// retried later (retry_pending).
//
// Functions take their roots as parameters so tests never touch HOME; the
// wrappers at the bottom read HOME and the settings file.

use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub(crate) const LIBRARY: &str = ".recordings";
pub(crate) const PENDING_MOVE: &str = ".pending-move";

pub(crate) fn library(root: &Path) -> PathBuf {
    root.join(LIBRARY)
}

// Exists, is a directory, and a file can be created and removed in it.
pub(crate) fn is_available(dir: &Path) -> bool {
    if !dir.is_dir() {
        return false;
    }
    let probe = dir.join(format!(".zeigen-write-test-{}", std::process::id()));
    match std::fs::File::create(&probe) {
        Ok(_) => {
            let _ = std::fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Active {
    pub root: PathBuf,
    // Some(chosen) when a chosen folder is set but unavailable, so `root` is
    // the default instead.
    pub fallback_from: Option<PathBuf>,
}

pub(crate) fn resolve(default: &Path, chosen: Option<&Path>) -> Active {
    match chosen {
        Some(c) if c != default && !is_available(c) => {
            Active { root: default.to_path_buf(), fallback_from: Some(c.to_path_buf()) }
        }
        Some(c) => Active { root: c.to_path_buf(), fallback_from: None },
        None => Active { root: default.to_path_buf(), fallback_from: None },
    }
}

// On a different volume than the user's home folder.
pub(crate) fn is_external(dir: &Path, home: &Path) -> bool {
    match (std::fs::metadata(dir), std::fs::metadata(home)) {
        (Ok(d), Ok(h)) => d.dev() != h.dev(),
        _ => false,
    }
}

#[derive(Debug, PartialEq)]
pub(crate) struct RecordPlan {
    // The library the recording folder is created in.
    pub library: PathBuf,
    // Some(chosen library) when the recording is staged in the default library
    // and moved there at finalize.
    pub move_to: Option<PathBuf>,
    // Some(chosen) when the chosen folder is unavailable.
    pub fallback_from: Option<PathBuf>,
}

pub(crate) fn record_plan(default: &Path, chosen: Option<&Path>, home: &Path) -> RecordPlan {
    let a = resolve(default, chosen);
    if a.root == default {
        RecordPlan { library: library(default), move_to: None, fallback_from: a.fallback_from }
    } else if is_external(&a.root, home) {
        RecordPlan { library: library(default), move_to: Some(library(&a.root)), fallback_from: None }
    } else {
        RecordPlan { library: library(&a.root), move_to: None, fallback_from: None }
    }
}

// Creates the library folder inside a save folder that is there. Never creates
// the save folder itself: with the drive unplugged that would quietly build
// the missing path on whatever disk still answers to it.
fn ensure_library(lib: &Path) -> Result<(), String> {
    if lib.is_dir() {
        return Ok(());
    }
    match lib.parent() {
        Some(root) if root.is_dir() => {
            std::fs::create_dir(lib).map_err(|e| format!("create {}: {e}", lib.display()))
        }
        _ => Err(format!("{} is not available", lib.display())),
    }
}

// One move at a time: finalize, the pending retry and the move offered on a
// folder change can otherwise pick the same folder.
static MOVES: Mutex<()> = Mutex::new(());

// Moves a recording folder into `dest_library` under the same name: a rename on
// the same volume, otherwise copy, check, then delete the original. Returns the
// new folder. On failure nothing changes at the source and no partial copy is
// left. An existing folder of the same name is never overwritten.
pub(crate) fn move_recording(src: &Path, dest_library: &Path) -> Result<PathBuf, String> {
    ensure_library(dest_library)?;
    let same_volume = match (std::fs::metadata(src), std::fs::metadata(dest_library)) {
        (Ok(s), Ok(d)) => s.dev() == d.dev(),
        _ => false,
    };
    move_recording_with(src, dest_library, !same_volume)
}

pub(crate) fn move_recording_with(src: &Path, dest_library: &Path, copy: bool) -> Result<PathBuf, String> {
    let _one = MOVES.lock().unwrap_or_else(|e| e.into_inner());
    if !src.is_dir() {
        return Err(format!("{} is not there", src.display()));
    }
    let name = src.file_name().ok_or("recording folder has no name")?.to_os_string();
    ensure_library(dest_library)?;
    let dest = dest_library.join(&name);
    if dest.exists() {
        return Err(format!("{} already exists", dest.display()));
    }
    if !copy {
        std::fs::rename(src, &dest).map_err(|e| format!("move to {}: {e}", dest.display()))?;
        let _ = std::fs::remove_file(dest.join(PENDING_MOVE));
        return Ok(dest);
    }
    let mut incoming_name = std::ffi::OsString::from(".incoming-");
    incoming_name.push(&name);
    let incoming = dest_library.join(incoming_name);
    let _ = std::fs::remove_dir_all(&incoming); // left by an earlier crash
    let copied = copy_tree(src, &incoming, true)
        .and_then(|_| verify_tree(src, &incoming, true))
        .and_then(|_| {
            std::fs::rename(&incoming, &dest).map_err(|e| format!("rename into place: {e}"))
        });
    if let Err(e) = copied {
        let _ = std::fs::remove_dir_all(&incoming);
        return Err(e);
    }
    // The copy is complete. Drop the marker first, so a source that cannot be
    // removed entirely is not retried against the copy forever.
    let _ = std::fs::remove_file(src.join(PENDING_MOVE));
    if let Err(e) = std::fs::remove_dir_all(src) {
        eprintln!("[storage] moved {} but could not remove the original: {e}", src.display());
    }
    Ok(dest)
}

// Copies files and folders; each file is flushed to disk. `top` skips the
// pending marker at the folder's top level.
fn copy_tree(src: &Path, dest: &Path, top: bool) -> Result<(), String> {
    std::fs::create_dir(dest).map_err(|e| format!("create {}: {e}", dest.display()))?;
    for entry in std::fs::read_dir(src).map_err(|e| format!("read {}: {e}", src.display()))? {
        let entry = entry.map_err(|e| format!("read {}: {e}", src.display()))?;
        if top && entry.file_name() == PENDING_MOVE {
            continue;
        }
        let from = entry.path();
        let to = dest.join(entry.file_name());
        if from.is_dir() {
            copy_tree(&from, &to, false)?;
        } else {
            std::fs::copy(&from, &to).map_err(|e| format!("copy {}: {e}", from.display()))?;
            std::fs::File::open(&to)
                .and_then(|f| f.sync_all())
                .map_err(|e| format!("flush {}: {e}", to.display()))?;
        }
    }
    Ok(())
}

// Every file under `src` exists under `dest` with the same length.
fn verify_tree(src: &Path, dest: &Path, top: bool) -> Result<(), String> {
    for entry in std::fs::read_dir(src).map_err(|e| format!("read {}: {e}", src.display()))? {
        let entry = entry.map_err(|e| format!("read {}: {e}", src.display()))?;
        if top && entry.file_name() == PENDING_MOVE {
            continue;
        }
        let from = entry.path();
        let to = dest.join(entry.file_name());
        if from.is_dir() {
            verify_tree(&from, &to, false)?;
        } else {
            let a = std::fs::metadata(&from).map_err(|e| format!("{}: {e}", from.display()))?.len();
            let b = std::fs::metadata(&to).map(|m| m.len()).ok();
            if b != Some(a) {
                return Err(format!("copy of {} does not match", from.display()));
            }
        }
    }
    Ok(())
}

pub(crate) fn is_pending(dir: &Path) -> bool {
    dir.join(PENDING_MOVE).is_file()
}

fn recording_dirs(lib: &Path) -> Vec<PathBuf> {
    std::fs::read_dir(lib)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.is_dir()
                && p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with("recording-"))
        })
        .collect()
}

// Moves the default library's pending recordings into the chosen library,
// skipping those `in_use` says are open. Returns how many moved.
pub(crate) fn retry_pending(default_lib: &Path, chosen_lib: &Path, in_use: &dyn Fn(&Path) -> bool) -> usize {
    let mut moved = 0;
    for dir in recording_dirs(default_lib).into_iter().filter(|d| is_pending(d) && !in_use(d)) {
        match move_recording(&dir, chosen_lib) {
            Ok(_) => moved += 1,
            Err(e) => eprintln!("[storage] {} not moved yet: {e}", dir.display()),
        }
    }
    moved
}

// With no chosen folder the default library is the library, and a marker left
// from an earlier setting means nothing.
pub(crate) fn clear_pending(default_lib: &Path) {
    for dir in recording_dirs(default_lib) {
        let _ = std::fs::remove_file(dir.join(PENDING_MOVE));
    }
}

// Moves every recording in `from_lib` into `to_lib`, skipping those in use.
// Returns the names moved and the names not moved.
pub(crate) fn move_library(
    from_lib: &Path,
    to_lib: &Path,
    in_use: &dyn Fn(&Path) -> bool,
    label: &dyn Fn(&Path) -> String,
) -> (usize, Vec<String>) {
    let mut moved = 0;
    let mut failed = Vec::new();
    let mut dirs = recording_dirs(from_lib);
    dirs.sort();
    for dir in dirs {
        if in_use(&dir) {
            failed.push(format!("{} (open in Review)", label(&dir)));
            continue;
        }
        match move_recording(&dir, to_lib) {
            Ok(_) => moved += 1,
            Err(e) => {
                eprintln!("[storage] could not move {}: {e}", dir.display());
                failed.push(label(&dir));
            }
        }
    }
    (moved, failed)
}

pub(crate) fn move_summary(moved: usize, failed: &[String]) -> String {
    let n = |k: usize| if k == 1 { "1 recording".to_string() } else { format!("{k} recordings") };
    if failed.is_empty() {
        format!("Moved {}.", n(moved))
    } else {
        format!("Moved {moved}. {} could not be moved: {}.", failed.len(), failed.join(", "))
    }
}

// A recording folder that discard and the other path-taking commands may act
// on: strictly inside one of `roots` (canonicalized, so `..` and symlinks
// cannot escape), never a root itself.
pub(crate) fn validate_recording_dir(p: &Path, roots: &[PathBuf]) -> Result<(), String> {
    let canon = p.canonicalize().map_err(|e| format!("canonicalize {}: {e}", p.display()))?;
    let inside = roots
        .iter()
        .filter_map(|r| r.canonicalize().ok())
        .any(|root| canon != root && canon.starts_with(&root));
    if !inside {
        return Err(format!("path not under a recordings folder: {}", p.display()));
    }
    Ok(())
}

// "~/Movies/Zeigen" for paths in the home folder.
pub(crate) fn display_path(p: &Path, home: &Path) -> String {
    match p.strip_prefix(home) {
        Ok(rest) if rest.as_os_str().is_empty() => "~".into(),
        Ok(rest) => format!("~/{}", rest.display()),
        Err(_) => p.display().to_string(),
    }
}

// ---- Wrappers over HOME and the settings file ------------------------------

pub(crate) fn home() -> Result<PathBuf, String> {
    std::env::var("HOME").map(PathBuf::from).map_err(|_| "HOME not set".to_string())
}

pub(crate) fn default_root() -> Result<PathBuf, String> {
    let dir = home()?.join("Movies/Zeigen");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    Ok(dir)
}

// The setting, None when unset or equal to the default.
pub(crate) fn chosen() -> Option<PathBuf> {
    let c = crate::settings::save_dir()?;
    let default = home().ok()?.join("Movies/Zeigen");
    (c != default).then_some(c)
}

pub(crate) fn active() -> Result<Active, String> {
    Ok(resolve(&default_root()?, chosen().as_deref()))
}

pub(crate) fn show(p: &Path) -> String {
    match home() {
        Ok(h) => display_path(p, &h),
        Err(_) => p.display().to_string(),
    }
}

// Where a recording folder may be: the default library (and the old .scratch)
// and the chosen folder's library.
pub(crate) fn recording_roots() -> Result<Vec<PathBuf>, String> {
    let default = default_root()?;
    let mut roots = vec![default.join(".scratch"), library(&default)];
    if let Some(c) = chosen() {
        roots.push(library(&c));
    }
    Ok(roots)
}

pub(crate) fn unavailable_note(chosen: &Path, saved: bool) -> String {
    if saved {
        format!("{} isn't available. Saved to ~/Movies/Zeigen instead.", show(chosen))
    } else {
        format!("{} isn't available. This recording will be saved to ~/Movies/Zeigen.", show(chosen))
    }
}

pub(crate) fn move_failed_note(chosen_lib: &Path) -> String {
    let folder = chosen_lib.parent().unwrap_or(chosen_lib);
    format!(
        "Couldn't move this recording to {}. It is saved on this Mac and will be moved when the drive is available.",
        show(folder)
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn temp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("zeigen-storage-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        // The chosen save folder exists (a move never creates it).
        std::fs::create_dir_all(d.join("chosen")).unwrap();
        d
    }

    fn write(path: &Path, body: &[u8]) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, body).unwrap();
    }

    fn set_mode(p: &Path, mode: u32) {
        std::fs::set_permissions(p, std::fs::Permissions::from_mode(mode)).unwrap();
    }

    // A recording folder with a nested file and a pending marker.
    fn staged(lib: &Path, stamp: &str) -> PathBuf {
        let dir = lib.join(format!("recording-{stamp}"));
        write(&dir.join("sources/screen.mp4"), b"screen bytes");
        write(&dir.join("sources/webcam.mp4"), b"cam");
        write(&dir.join(format!(".recording-{stamp}.annotations.json")), b"{}");
        write(&dir.join(PENDING_MOVE), b"");
        dir
    }

    #[test]
    fn missing_chosen_falls_back_and_is_not_created() {
        let t = temp("missing");
        let default = t.join("default");
        std::fs::create_dir_all(&default).unwrap();
        let chosen = t.join("Volumes/LaCie/Zeigen");
        let a = resolve(&default, Some(&chosen));
        assert_eq!(a.root, default);
        assert_eq!(a.fallback_from.as_deref(), Some(chosen.as_path()));
        assert!(!chosen.exists(), "the chosen folder is never created");
        assert!(!t.join("Volumes").exists());

        let plan = record_plan(&default, Some(&chosen), &t);
        assert_eq!(plan.library, library(&default));
        assert!(plan.move_to.is_none());
        assert_eq!(plan.fallback_from.as_deref(), Some(chosen.as_path()));
        assert!(!chosen.exists());
        let _ = std::fs::remove_dir_all(&t);
    }

    #[test]
    fn unwritable_chosen_falls_back() {
        let t = temp("ro");
        let default = t.join("default");
        let chosen = t.join("readonly");
        std::fs::create_dir_all(&default).unwrap();
        std::fs::create_dir_all(&chosen).unwrap();
        set_mode(&chosen, 0o555);
        let a = resolve(&default, Some(&chosen));
        set_mode(&chosen, 0o755);
        assert_eq!(a.root, default);
        assert_eq!(a.fallback_from.as_deref(), Some(chosen.as_path()));
        assert_eq!(std::fs::read_dir(&chosen).unwrap().count(), 0, "probe file not left behind");

        // A file is not a folder.
        let file = t.join("file");
        std::fs::write(&file, b"x").unwrap();
        assert_eq!(resolve(&default, Some(&file)).root, default);

        // Available: used directly, and on the same volume it records in place.
        let ok = t.join("ok");
        std::fs::create_dir_all(&ok).unwrap();
        assert_eq!(resolve(&default, Some(&ok)), Active { root: ok.clone(), fallback_from: None });
        let plan = record_plan(&default, Some(&ok), &t);
        assert_eq!(plan, RecordPlan { library: library(&ok), move_to: None, fallback_from: None });
        assert_eq!(resolve(&default, None).root, default);
        let _ = std::fs::remove_dir_all(&t);
    }

    #[test]
    fn copy_move_matches_removes_source_and_drops_marker() {
        let t = temp("copy");
        let src = staged(&t.join("default/.recordings"), "2026-11-17-100000");
        let dest_lib = t.join("chosen/.recordings");
        let dest = move_recording_with(&src, &dest_lib, true).unwrap();
        assert_eq!(dest, dest_lib.join("recording-2026-11-17-100000"));
        assert!(!src.exists(), "source removed");
        assert!(!dest.join(PENDING_MOVE).exists(), "marker not carried");
        assert_eq!(std::fs::read(dest.join("sources/screen.mp4")).unwrap(), b"screen bytes");
        assert_eq!(std::fs::read(dest.join("sources/webcam.mp4")).unwrap(), b"cam");
        assert!(dest.join(".recording-2026-11-17-100000.annotations.json").is_file());
        assert_eq!(std::fs::read_dir(&dest_lib).unwrap().count(), 1, "no .incoming left");

        // Same-volume rename path drops the marker too.
        let src2 = staged(&t.join("default/.recordings"), "2026-11-17-110000");
        let dest2 = move_recording(&src2, &dest_lib).unwrap();
        assert!(!src2.exists() && !dest2.join(PENDING_MOVE).exists());
        assert!(dest2.join("sources/screen.mp4").is_file());
        let _ = std::fs::remove_dir_all(&t);
    }

    #[test]
    fn existing_destination_is_refused() {
        let t = temp("exists");
        let src = staged(&t.join("default/.recordings"), "2026-11-17-100000");
        let dest_lib = t.join("chosen/.recordings");
        write(&dest_lib.join("recording-2026-11-17-100000/other"), b"keep");
        for copy in [true, false] {
            assert!(move_recording_with(&src, &dest_lib, copy).is_err());
            assert!(src.join("sources/screen.mp4").is_file() && is_pending(&src), "source intact");
            assert_eq!(std::fs::read(dest_lib.join("recording-2026-11-17-100000/other")).unwrap(), b"keep");
        }
        let _ = std::fs::remove_dir_all(&t);
    }

    #[test]
    fn failed_copy_leaves_source_intact_and_no_partial() {
        let t = temp("fail");
        let src = staged(&t.join("default/.recordings"), "2026-11-17-100000");
        let dest_lib = t.join("chosen/.recordings");

        // A file that cannot be read, part-way through the copy.
        let unreadable = src.join("sources/webcam.mp4");
        set_mode(&unreadable, 0o000);
        let r = move_recording_with(&src, &dest_lib, true);
        set_mode(&unreadable, 0o644);
        assert!(r.is_err());
        assert!(src.join("sources/screen.mp4").is_file() && unreadable.is_file() && is_pending(&src));
        assert_eq!(std::fs::read_dir(&dest_lib).unwrap().count(), 0, "partial copy removed");

        // A destination that cannot be written.
        set_mode(&dest_lib, 0o555);
        let r = move_recording_with(&src, &dest_lib, true);
        set_mode(&dest_lib, 0o755);
        assert!(r.is_err());
        assert!(src.join("sources/screen.mp4").is_file() && is_pending(&src));
        assert_eq!(std::fs::read_dir(&dest_lib).unwrap().count(), 0);
        let _ = std::fs::remove_dir_all(&t);
    }

    #[test]
    fn retry_moves_pending_and_skips_in_use() {
        let t = temp("retry");
        let default_lib = t.join("default/.recordings");
        let chosen_lib = t.join("chosen/.recordings");
        let a = staged(&default_lib, "2026-11-17-100000");
        let b = staged(&default_lib, "2026-11-17-110000");
        let plain = default_lib.join("recording-2026-11-17-120000");
        write(&plain.join("x"), b"x"); // no marker: stays
        let moved = retry_pending(&default_lib, &chosen_lib, &|d| d == b);
        assert_eq!(moved, 1);
        assert!(!a.exists() && chosen_lib.join("recording-2026-11-17-100000").is_dir());
        assert!(b.exists() && is_pending(&b), "open in Review: left for later");
        assert!(plain.exists());

        clear_pending(&default_lib);
        assert!(!is_pending(&b));
        let _ = std::fs::remove_dir_all(&t);
    }

    #[test]
    fn move_library_reports_what_did_not_move() {
        let t = temp("movelib");
        let from = t.join("old/.recordings");
        let to = t.join("new/.recordings");
        for s in ["2026-11-17-100000", "2026-11-17-110000", "2026-11-17-120000"] {
            staged(&from, s);
        }
        write(&to.join("recording-2026-11-17-120000/x"), b"x"); // name taken
        let open = from.join("recording-2026-11-17-110000");
        let label = |d: &Path| d.file_name().unwrap().to_string_lossy().into_owned();
        let (moved, failed) = move_library(&from, &to, &|d| d == open, &label);
        assert_eq!(moved, 1);
        assert_eq!(failed, vec![
            "recording-2026-11-17-110000 (open in Review)".to_string(),
            "recording-2026-11-17-120000".to_string(),
        ]);
        assert!(open.is_dir() && from.join("recording-2026-11-17-120000").is_dir());
        assert_eq!(move_summary(9, &[]), "Moved 9 recordings.");
        assert_eq!(move_summary(1, &[]), "Moved 1 recording.");
        assert_eq!(move_summary(7, &["a".into(), "b".into()]), "Moved 7. 2 could not be moved: a, b.");
        let _ = std::fs::remove_dir_all(&t);
    }

    #[test]
    fn validation_accepts_folders_in_either_library_only() {
        let t = temp("validate");
        let default_lib = t.join("default/.recordings");
        let chosen_lib = t.join("chosen/.recordings");
        let in_chosen = chosen_lib.join("recording-2026-11-17-100000");
        let in_default = default_lib.join("recording-2026-11-17-110000");
        let outside = t.join("elsewhere/recording-2026-11-17-120000");
        for d in [&in_chosen, &in_default, &outside] {
            std::fs::create_dir_all(d).unwrap();
        }
        let roots = vec![default_lib.clone(), chosen_lib.clone()];
        assert!(validate_recording_dir(&in_chosen, &roots).is_ok());
        assert!(validate_recording_dir(&in_default, &roots).is_ok());
        assert!(validate_recording_dir(&chosen_lib, &roots).is_err(), "the root itself");
        assert!(validate_recording_dir(&default_lib, &roots).is_err());
        assert!(validate_recording_dir(&outside, &roots).is_err());
        assert!(validate_recording_dir(&chosen_lib.join("../../elsewhere/recording-2026-11-17-120000"), &roots).is_err());
        assert!(validate_recording_dir(&t.join("chosen"), &roots).is_err());
        let _ = std::fs::remove_dir_all(&t);
    }

    #[test]
    fn display_path_uses_tilde() {
        let home = Path::new("/Users/k");
        assert_eq!(display_path(Path::new("/Users/k/Movies/Zeigen"), home), "~/Movies/Zeigen");
        assert_eq!(display_path(Path::new("/Volumes/LaCie/Zeigen"), home), "/Volumes/LaCie/Zeigen");
    }

    // Reads (never writes) whatever is mounted under /Volumes and prints whether
    // it counts as external: cargo test --lib list_volumes -- --ignored --nocapture
    #[test]
    #[ignore]
    fn list_volumes() {
        let home = home().unwrap();
        for v in std::fs::read_dir("/Volumes").unwrap().flatten() {
            println!("{} external={}", v.path().display(), is_external(&v.path(), &home));
        }
        assert!(!is_external(&home.join("Movies"), &home));
    }

    #[test]
    fn a_move_never_creates_the_save_folder() {
        let t = temp("nocreate");
        let src = staged(&t.join("default/.recordings"), "2026-11-17-120000");
        let gone = t.join("unplugged");
        assert!(move_recording_with(&src, &library(&gone), true).is_err());
        assert!(!gone.exists(), "the missing save folder is not created");
        assert!(src.join("sources/screen.mp4").is_file() && is_pending(&src));
    }
}
