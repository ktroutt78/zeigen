use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

// First persisted-prefs mechanism in the app. Hand-rolled JSON (matching
// the sidecar pattern) at ~/Library/Application Support/com.zeigen.app/
// settings.json. Holds only the watermark keys for now; the struct is
// shaped to extend.

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Settings {
    #[serde(default)]
    pub watermark: WatermarkSettings,
    // "off" | "low" | "med" | "high" — RNNoise (arnndn) strength.
    #[serde(default = "default_noise_reduction")]
    pub noise_reduction: String,
    // Webcam bubble corner roundness set in the recorder before recording:
    // 0.0 (square) .. <1.0 (rounded square). None = full circle. Remembered
    // default only — the value each recording was made with is stamped into
    // its sidecar at finalize (lib.rs), so changing this later never
    // reshapes an existing recording.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bubble_roundness: Option<f64>,
    // V3 (Core Image) compositor as the default export path. Default true (the
    // switchover). Flip to false to route every export through V2 (ffmpeg) with
    // no rebuild. A V3 runtime failure does NOT fall back to V2 (owner,
    // 2026-07-17): it fails the export loudly with the reason so a fixable bug
    // surfaces instead of hiding under a silent V2 rescue.
    #[serde(default = "default_true")]
    pub use_v3_compositor: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            watermark: WatermarkSettings::default(),
            noise_reduction: default_noise_reduction(),
            bubble_roundness: None,
            use_v3_compositor: default_true(),
        }
    }
}

fn default_noise_reduction() -> String {
    "med".to_string()
}

fn default_true() -> bool {
    true
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct WatermarkSettings {
    // Absolute path to the copied watermark.png in app storage (not the
    // user's original pick). None when no logo is saved.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub logo_path: Option<String>,
    #[serde(default = "default_corner")]
    pub corner: String,
    // Logo width as a fraction of video width (0.05..=0.40). None = the
    // legacy 10%-of-shorter-dimension height sizing, byte-identical filter.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scale: Option<f64>,
    // Alpha multiplier 0.0..=1.0. None = 1.0 (legacy, no filter added).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub opacity: Option<f64>,
}

impl Default for WatermarkSettings {
    fn default() -> Self {
        Self {
            logo_path: None,
            corner: default_corner(),
            scale: None,
            opacity: None,
        }
    }
}

fn default_corner() -> String {
    "tr".to_string()
}

// Resolve ~/Library/Application Support/com.zeigen.app (no mkdir — writes
// create the dir on demand so a pure read never has a side effect).
fn config_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map_err(|e| format!("app_config_dir: {e}"))
}

// HOME-based resolver matching app_config_dir() on macOS — lets non-command
// code (the edit pipeline) read settings without an AppHandle.
fn home_config_dir() -> Option<PathBuf> {
    let home = std::env::var("HOME").ok()?;
    Some(PathBuf::from(home).join("Library/Application Support/com.zeigen.app"))
}

// Bubble roundness preference, read fresh at recording start (lib.rs
// captures it into the active recording; the finalize stamp uses that
// captured value, not a re-read).
pub fn bubble_roundness() -> Option<f64> {
    let dir = home_config_dir()?;
    read_settings_from(&dir).bubble_roundness
}

// Noise-reduction strength as an arnndn `mix` (0..1), or None when "off".
// Read fresh each call so a settings change takes effect on the next save.
pub fn noise_reduction_mix() -> Option<f64> {
    let dir = home_config_dir()?;
    match read_settings_from(&dir).noise_reduction.as_str() {
        "off" => None,
        "low" => Some(0.5),
        "high" => Some(1.0),
        _ => Some(0.75), // "med" (and any unexpected value)
    }
}

// V3 compositor default-path flag, read fresh each export (a settings change
// takes effect on the next save). Absent config dir / first run / missing key
// all resolve to the default (true) via read_settings_from.
pub fn use_v3_compositor() -> bool {
    match home_config_dir() {
        Some(dir) => read_settings_from(&dir).use_v3_compositor,
        None => true,
    }
}

fn is_png(p: &Path) -> bool {
    p.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("png"))
        .unwrap_or(false)
}

// Read settings.json from `dir`. Always succeeds: first-run (no file),
// malformed JSON, and read errors all fall back to defaults with a log
// breadcrumb — a corrupt prefs file must never crash the app, and the
// next write rewrites it cleanly.
fn read_settings_from(dir: &Path) -> Settings {
    let path = dir.join("settings.json");
    if !path.exists() {
        return Settings::default();
    }
    match std::fs::read_to_string(&path) {
        Ok(data) => serde_json::from_str::<Settings>(&data).unwrap_or_else(|e| {
            eprintln!("[settings] malformed settings.json, using defaults: {e}");
            Settings::default()
        }),
        Err(e) => {
            eprintln!("[settings] read {}: {e}, using defaults", path.display());
            Settings::default()
        }
    }
}

fn write_settings_to(dir: &Path, settings: &Settings) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    let path = dir.join("settings.json");
    let data =
        serde_json::to_string_pretty(settings).map_err(|e| format!("serialize settings: {e}"))?;
    std::fs::write(&path, data).map_err(|e| format!("write {}: {e}", path.display()))
}

// Copy `source` (a .png) into `dir`/watermark.png and persist the path.
// Returns the updated settings so the caller can convertFileSrc the copy.
fn set_logo_in(dir: &Path, source: &Path) -> Result<Settings, String> {
    if !source.is_file() {
        return Err(format!("logo source not a file: {}", source.display()));
    }
    if !is_png(source) {
        return Err("watermark logo must be a .png".to_string());
    }
    std::fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    let dest = dir.join("watermark.png");
    std::fs::copy(source, &dest).map_err(|e| format!("copy logo to {}: {e}", dest.display()))?;
    let mut settings = read_settings_from(dir);
    settings.watermark.logo_path = Some(dest.to_string_lossy().into_owned());
    write_settings_to(dir, &settings)?;
    Ok(settings)
}

fn clear_logo_in(dir: &Path) -> Result<(), String> {
    let _ = std::fs::remove_file(dir.join("watermark.png")); // best-effort
    let mut settings = read_settings_from(dir);
    settings.watermark.logo_path = None;
    write_settings_to(dir, &settings)
}

#[tauri::command]
pub fn get_settings(app: AppHandle) -> Settings {
    match config_dir(&app) {
        Ok(dir) => read_settings_from(&dir),
        Err(e) => {
            eprintln!("[settings] {e}, using defaults");
            Settings::default()
        }
    }
}

#[tauri::command]
pub fn set_bubble_roundness(app: AppHandle, roundness: Option<f64>) -> Result<(), String> {
    let dir = config_dir(&app)?;
    let mut settings = read_settings_from(&dir);
    // Full circle stores as None — same normalization the sidecar stamp
    // uses, so "circle" is always the absent-field state everywhere.
    settings.bubble_roundness = roundness
        .filter(|r| *r < 1.0)
        .map(|r| r.clamp(0.0, 1.0));
    write_settings_to(&dir, &settings)
}

#[tauri::command]
pub fn set_watermark_logo(app: AppHandle, source_path: String) -> Result<Settings, String> {
    let dir = config_dir(&app)?;
    set_logo_in(&dir, Path::new(&source_path))
}

#[tauri::command]
pub fn set_watermark_corner(app: AppHandle, corner: String) -> Result<(), String> {
    if !matches!(corner.as_str(), "tl" | "tr" | "bl" | "br") {
        return Err(format!("invalid corner: {corner}"));
    }
    let dir = config_dir(&app)?;
    let mut settings = read_settings_from(&dir);
    settings.watermark.corner = corner;
    write_settings_to(&dir, &settings)
}

// Remembered size/opacity for the review's watermark sliders. None resets
// to the legacy default (scale: 10%-of-shorter-dim height, opacity: 1.0).
#[tauri::command]
pub fn set_watermark_style(
    app: AppHandle,
    scale: Option<f64>,
    opacity: Option<f64>,
) -> Result<(), String> {
    if let Some(s) = scale {
        if !(0.05..=0.40).contains(&s) {
            return Err(format!("invalid watermark scale: {s}"));
        }
    }
    if let Some(o) = opacity {
        if !(0.0..=1.0).contains(&o) {
            return Err(format!("invalid watermark opacity: {o}"));
        }
    }
    let dir = config_dir(&app)?;
    let mut settings = read_settings_from(&dir);
    settings.watermark.scale = scale;
    settings.watermark.opacity = opacity;
    write_settings_to(&dir, &settings)
}

#[tauri::command]
pub fn clear_watermark_logo(app: AppHandle) -> Result<(), String> {
    let dir = config_dir(&app)?;
    clear_logo_in(&dir)
}

#[tauri::command]
pub fn set_noise_reduction(app: AppHandle, level: String) -> Result<(), String> {
    if !matches!(level.as_str(), "off" | "low" | "med" | "high") {
        return Err(format!("invalid noise reduction level: {level}"));
    }
    let dir = config_dir(&app)?;
    let mut settings = read_settings_from(&dir);
    settings.noise_reduction = level;
    write_settings_to(&dir, &settings)
}

#[tauri::command]
pub fn set_use_v3_compositor(app: AppHandle, enabled: bool) -> Result<(), String> {
    let dir = config_dir(&app)?;
    let mut settings = read_settings_from(&dir);
    settings.use_v3_compositor = enabled;
    write_settings_to(&dir, &settings)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("zeigen-settings-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn first_run_and_round_trip() {
        let dir = scratch("rt");

        // First-run: no file -> defaults, no file created by the read.
        let s = read_settings_from(&dir);
        assert_eq!(s.watermark.corner, "tr");
        assert!(s.watermark.logo_path.is_none());
        assert!(!dir.join("settings.json").exists(), "read must not create the file");

        // Write + read back.
        let mut s2 = Settings::default();
        s2.watermark.corner = "bl".into();
        s2.watermark.logo_path = Some("/x/watermark.png".into());
        write_settings_to(&dir, &s2).unwrap();
        let s3 = read_settings_from(&dir);
        assert_eq!(s3.watermark.corner, "bl");
        assert_eq!(s3.watermark.logo_path.as_deref(), Some("/x/watermark.png"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupt_falls_back_to_default() {
        let dir = scratch("corrupt");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("settings.json"), b"{ this is not json").unwrap();

        let s = read_settings_from(&dir);
        assert_eq!(s.watermark.corner, "tr");
        assert!(s.watermark.logo_path.is_none());

        // A subsequent write rewrites valid JSON.
        write_settings_to(&dir, &s).unwrap();
        let data = std::fs::read_to_string(dir.join("settings.json")).unwrap();
        assert!(serde_json::from_str::<Settings>(&data).is_ok());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn set_logo_copies_persists_and_validates() {
        let root = scratch("logo");
        std::fs::create_dir_all(&root).unwrap();
        let fake = root.join("src-logo.png");
        std::fs::write(&fake, b"\x89PNG\r\n\x1a\n fake-bytes").unwrap();
        let cfg = root.join("cfg");

        let s = set_logo_in(&cfg, &fake).unwrap();
        let dest = cfg.join("watermark.png");
        assert!(dest.is_file(), "logo must be copied into app storage");
        assert_eq!(s.watermark.logo_path.as_deref(), Some(dest.to_string_lossy().as_ref()));
        assert!(read_settings_from(&cfg).watermark.logo_path.is_some(), "logo_path persists");

        // Non-png is rejected.
        let notpng = root.join("x.jpg");
        std::fs::write(&notpng, b"x").unwrap();
        assert!(set_logo_in(&cfg, &notpng).is_err());

        // Clear removes the copy and nulls the path.
        clear_logo_in(&cfg).unwrap();
        assert!(!dest.exists(), "clear removes watermark.png");
        assert!(read_settings_from(&cfg).watermark.logo_path.is_none());

        let _ = std::fs::remove_dir_all(&root);
    }
}
