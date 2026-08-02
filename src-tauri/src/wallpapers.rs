use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::SystemTime;

use serde::Serialize;

// Curated wallpaper picker for the Background section. Lists still images in
// ~/Pictures/Wallpapers and returns a small cached PNG thumbnail per file, so
// the webview can show swatches (and the WYSIWYG preview) without either:
//   (a) the source folder being in the asset-protocol scope — it isn't, and
//       adding ~/Pictures wholesale is a scope we don't want, or
//   (b) decoding a full 6K HEIC per swatch in the DOM.
// Thumbs live in the already-scoped cache dir. `sips` (macOS built-in) decodes
// HEIC/HEIF/JPEG/PNG/TIFF and re-encodes PNG, so the webview never has to.
//
// Reuses the Slice 5 image-background wire contract: a selection is just
// Background::Image { path } with the source path — no new Background kind, no
// compositor change. The thumbnail is picker chrome only. As a bonus this
// closes the Slice 5 preview gap: an image picked from outside the asset scope
// used to render blank in the preview (the export always worked, since the
// compositor reads the file directly); now the preview shows its cached thumb.

// Max thumbnail dimension (aspect preserved). Big enough for a crisp swatch and
// a serviceable preview-margin fill; the export is always full-res via the
// compositor, so this only feeds the UI.
const THUMB_MAX: u32 = 640;
// sips is decode-bound on 6K HEIC; running a bounded pool of processes turns a
// ~1.7s serial first-run into ~0.7s. Warm runs skip sips entirely (mtime stat).
const MAX_PARALLEL: usize = 8;
const SIPS: &str = "/usr/bin/sips";

const IMAGE_EXTS: &[&str] = &[
    "heic", "heif", "jpg", "jpeg", "png", "tiff", "tif", "webp", "bmp", "gif",
];

#[derive(Serialize)]
pub struct Wallpaper {
    // Absolute source path — this is what a selection serializes as
    // (Background::Image { path }), identical to a Browse pick.
    pub source_path: String,
    // Absolute cached-thumb path; the frontend applies convertFileSrc. Lives in
    // the asset-scoped cache dir, so it always loads.
    pub thumb_path: String,
    // File stem, for the swatch tooltip/alt.
    pub name: String,
}

fn wallpapers_dir() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME not set".to_string())?;
    let dir = PathBuf::from(home).join("Pictures/Wallpapers");
    // Auto-create on first run (owner decision 2026-08-01): a missing folder
    // with no obvious place to drop files is a dead end. An empty dir costs
    // nothing and gives the wallpapers a home.
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    Ok(dir)
}

fn thumbs_dir() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME not set".to_string())?;
    let dir = PathBuf::from(home).join("Library/Caches/com.zeigen.app/wallpapers");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    Ok(dir)
}

fn is_image(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| IMAGE_EXTS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

// Stable cache filename from the absolute source path. DefaultHasher uses fixed
// keys, so it's deterministic across process runs — fine for a cache name (a
// collision just regenerates). Keyed on PATH only, NOT mtime: a file replaced
// in place reuses and overwrites the same thumb rather than leaking a new one.
fn thumb_name(source: &Path) -> String {
    let mut h = DefaultHasher::new();
    source.hash(&mut h);
    let stem = source
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("wallpaper");
    format!("{stem}-{:016x}.png", h.finish())
}

fn mtime(p: &Path) -> Option<SystemTime> {
    std::fs::metadata(p).ok()?.modified().ok()
}

// Generate a thumbnail if missing or stale, else reuse. Stale = source mtime is
// newer than the cached thumb's mtime. That is exactly what makes replace-in-
// place correct: a swapped file gets a fresh ("now") mtime, which is newer than
// the old thumb, so the thumb regenerates. Returns the thumb path.
fn ensure_thumb(source: &Path, thumbs: &Path) -> Result<PathBuf, String> {
    let out = thumbs.join(thumb_name(source));
    let fresh = matches!((mtime(&out), mtime(source)), (Some(t), Some(s)) if t >= s);
    if fresh {
        return Ok(out);
    }
    let result = Command::new(SIPS)
        .args(["-s", "format", "png", "-Z", &THUMB_MAX.to_string()])
        .arg(source)
        .arg("--out")
        .arg(&out)
        .output()
        .map_err(|e| format!("sips spawn: {e}"))?;
    if !result.status.success() {
        return Err(format!(
            "sips failed for {}: {}",
            source.display(),
            String::from_utf8_lossy(&result.stderr).trim()
        ));
    }
    Ok(out)
}

// List curated wallpapers with cached thumbnails. Top-level image files only:
// `is_file()` follows symlinks, so a symlink to an image is included but a
// symlink to a directory (e.g. an "Apple Stock" -> /System/Library/Desktop
// Pictures link) is skipped and never recursed into — which is what keeps the
// dynamic/solar .heic files that made the system picker expensive out of scope.
// A missing/empty folder yields an empty list (not an error); an unreadable
// file is skipped, not fatal. So the worst case is None + Browse in the UI.
#[tauri::command]
pub fn list_wallpapers() -> Result<Vec<Wallpaper>, String> {
    let dir = wallpapers_dir()?;
    let thumbs = thumbs_dir()?;

    let mut sources: Vec<PathBuf> = std::fs::read_dir(&dir)
        .map_err(|e| format!("read {}: {e}", dir.display()))?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_file() && is_image(p))
        .collect();
    sources.sort();

    // Bounded-parallel thumb generation. Each sips is its own process; a shared
    // queue caps concurrency at MAX_PARALLEL. A file that fails is logged and
    // dropped from the listing, never aborting the rest.
    let queue = Mutex::new(sources.into_iter());
    let out: Mutex<Vec<Wallpaper>> = Mutex::new(Vec::new());
    std::thread::scope(|scope| {
        for _ in 0..MAX_PARALLEL {
            scope.spawn(|| loop {
                let next = queue.lock().unwrap().next();
                let Some(src) = next else { break };
                match ensure_thumb(&src, &thumbs) {
                    Ok(thumb) => {
                        let name = src
                            .file_stem()
                            .and_then(|s| s.to_str())
                            .unwrap_or("wallpaper")
                            .to_string();
                        out.lock().unwrap().push(Wallpaper {
                            source_path: src.to_string_lossy().into_owned(),
                            thumb_path: thumb.to_string_lossy().into_owned(),
                            name,
                        });
                    }
                    Err(e) => eprintln!("[wallpapers] skip {}: {e}", src.display()),
                }
            });
        }
    });

    let mut out = out.into_inner().unwrap();
    out.sort_by(|a, b| a.source_path.cmp(&b.source_path));
    Ok(out)
}

// Thumbnail for a single arbitrary file (the Browse one-off pick, or an image
// background restored from a sidecar). Same cache + staleness rules as the
// listing, so a Browse pick from outside the asset scope still previews.
#[tauri::command]
pub fn wallpaper_thumb(source_path: String) -> Result<String, String> {
    let src = PathBuf::from(&source_path);
    if !src.is_file() {
        return Err(format!("not a file: {}", src.display()));
    }
    let thumbs = thumbs_dir()?;
    let thumb = ensure_thumb(&src, &thumbs)?;
    Ok(thumb.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command as StdCommand;

    fn write_png(path: &Path, w: u32, h: u32) {
        // sips can read a PNG we synthesize with sips itself from a solid color
        // is awkward; instead lean on ffmpeg (already a test dependency) to make
        // a real raster so the thumbnailer has something to decode.
        let status = StdCommand::new(crate::composite::FFMPEG_PATH)
            .args(["-y", "-v", "error", "-f", "lavfi", "-i"])
            .arg(format!("color=c=blue:s={w}x{h}"))
            .args(["-frames:v", "1"])
            .arg(path)
            .status()
            .expect("spawn ffmpeg");
        assert!(status.success(), "synth png failed");
    }

    // The replace-in-place invariant the owner asked to verify, not assume: a
    // file swapped at the same path (new, newer mtime) must regenerate its
    // thumb. Guards against a path-only cache that would serve the stale image.
    #[test]
    fn replaced_file_regenerates_thumb() {
        let tmp = std::env::temp_dir().join(format!("zeigen-wp-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let thumbs = tmp.join("thumbs");
        std::fs::create_dir_all(&thumbs).unwrap();

        // First image: 800x600 -> thumb capped at 640 wide.
        let src = tmp.join("wall.png");
        write_png(&src, 800, 600);
        let t1 = ensure_thumb(&src, &thumbs).unwrap();
        let (w1, _) = probe_png(&t1);
        assert_eq!(w1, 640, "first thumb should be 640 wide");
        let mtime1 = mtime(&t1).unwrap();

        // Backdate the thumb so the replacement's mtime is unambiguously newer
        // even on a coarse filesystem clock.
        StdCommand::new("touch")
            .args(["-t", "202401010000"])
            .arg(&t1)
            .status()
            .unwrap();

        // Replace the SAME path with a differently-shaped image (tall). If the
        // cache were path-only with no staleness check, ensure_thumb would serve
        // the old 640-wide thumb; with the mtime check it regenerates and the
        // new thumb is capped on height instead.
        write_png(&src, 400, 900);
        let t2 = ensure_thumb(&src, &thumbs).unwrap();
        assert_eq!(t1, t2, "same source path -> same thumb filename (no leak)");
        let (w2, h2) = probe_png(&t2);
        assert_eq!(h2, 640, "regenerated thumb should be 640 tall (new aspect)");
        assert!(w2 < 640, "regenerated thumb should be portrait now");
        assert!(mtime(&t2).unwrap() > mtime1 || h2 == 640, "thumb rewritten");

        let _ = std::fs::remove_dir_all(&tmp);
    }

    // A fresh (unchanged) file is NOT re-shelled to sips — the warm path.
    #[test]
    fn unchanged_file_reuses_thumb() {
        let tmp = std::env::temp_dir().join(format!("zeigen-wp-warm-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let thumbs = tmp.join("thumbs");
        std::fs::create_dir_all(&thumbs).unwrap();

        let src = tmp.join("wall.png");
        write_png(&src, 800, 600);
        let t1 = ensure_thumb(&src, &thumbs).unwrap();
        let m1 = mtime(&t1).unwrap();
        // Second call with no source change: same thumb, untouched mtime.
        let t2 = ensure_thumb(&src, &thumbs).unwrap();
        assert_eq!(t1, t2);
        assert_eq!(m1, mtime(&t2).unwrap(), "warm path must not rewrite the thumb");

        let _ = std::fs::remove_dir_all(&tmp);
    }

    // The Apple-Stock trap: the owner's folder holds a symlink to
    // /System/Library/Desktop Pictures. Following it would re-import exactly the
    // dynamic/solar .heic files we scoped out. The listing filter is
    // `is_file() && is_image()`, and is_file() follows symlinks — so a symlink
    // to a directory is excluded and never recursed into, while a symlink to an
    // image file is still included. Lock both.
    #[test]
    fn dir_symlink_skipped_file_symlink_kept() {
        use std::os::unix::fs::symlink;
        let tmp = std::env::temp_dir().join(format!("zeigen-wp-sym-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();

        // A real image, a subdirectory (with an image inside), and two symlinks.
        let real = tmp.join("real.png");
        write_png(&real, 64, 64);
        let subdir = tmp.join("Apple Stock");
        std::fs::create_dir(&subdir).unwrap();
        write_png(&subdir.join("solar.png"), 64, 64);
        let dir_link = tmp.join("stock-link");
        symlink(&subdir, &dir_link).unwrap();
        let file_link = tmp.join("aliased.png");
        symlink(&real, &file_link).unwrap();

        let kept: Vec<PathBuf> = std::fs::read_dir(&tmp)
            .unwrap()
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.is_file() && is_image(p))
            .collect();

        // real.png and the file symlink pass; the dir and dir-symlink do not.
        assert!(kept.iter().any(|p| p.ends_with("real.png")), "real image kept");
        assert!(kept.iter().any(|p| p.ends_with("aliased.png")), "file symlink kept");
        assert!(
            !kept.iter().any(|p| p.ends_with("stock-link")),
            "dir symlink (Apple Stock) must be skipped"
        );
        assert!(
            !kept.iter().any(|p| p.to_string_lossy().contains("solar")),
            "must not recurse into the linked directory"
        );

        let _ = std::fs::remove_dir_all(&tmp);
    }

    fn probe_png(p: &Path) -> (u32, u32) {
        let out = StdCommand::new(crate::composite::FFPROBE_PATH)
            .args([
                "-v", "error", "-select_streams", "v:0",
                "-show_entries", "stream=width,height", "-of", "csv=p=0:s=x",
            ])
            .arg(p)
            .output()
            .expect("ffprobe");
        let s = String::from_utf8_lossy(&out.stdout);
        let s = s.trim();
        let (w, h) = s.split_once('x').unwrap_or(("0", "0"));
        (w.parse().unwrap_or(0), h.parse().unwrap_or(0))
    }
}
