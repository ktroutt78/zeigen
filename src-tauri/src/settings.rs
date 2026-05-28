use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

// First persisted-prefs mechanism in the app. Hand-rolled JSON (matching
// the sidecar pattern) at ~/Library/Application Support/com.zeigen.app/
// settings.json. Holds only the watermark keys for now; the struct is
// shaped to extend.

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct Settings {
    #[serde(default)]
    pub watermark: WatermarkSettings,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct WatermarkSettings {
    // Absolute path to the copied watermark.png in app storage (not the
    // user's original pick). None when no logo is saved.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub logo_path: Option<String>,
    #[serde(default = "default_corner")]
    pub corner: String,
}

impl Default for WatermarkSettings {
    fn default() -> Self {
        Self {
            logo_path: None,
            corner: default_corner(),
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

#[tauri::command]
pub fn clear_watermark_logo(app: AppHandle) -> Result<(), String> {
    let dir = config_dir(&app)?;
    clear_logo_in(&dir)
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
