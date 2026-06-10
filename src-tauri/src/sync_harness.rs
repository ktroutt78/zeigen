// A/V sync measurement harness (Phase A — Rust-side anchors only).
//
// Captures per-recording diagnostic data into
// ~/Movies/Zeigen/.sync-measurements.jsonl so the offline clap-based
// A/V offset measurement can be correlated against engine-side timing.
// Phase A intentionally does NOT touch the webcam ffmpeg spawn path
// (stderr stays at Stdio::null) — webcam first-frame timing is Phase B
// pending whether SCK-side data already explains the variance.
//
// All deltas are signed ms from engine_start_at. webcam_spawn happens
// BEFORE engine_start_at in current code (lib.rs spawns the ffmpeg
// segmenter before stamping started_at), so its delta is negative;
// SCK first_frame happens after, so its delta is positive (the
// existing 225-360ms range).
//
// Best-effort I/O — errors are logged to stderr and swallowed. This
// module must never propagate a failure back to recording_finalize.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::Path;
use std::time::Instant;

#[derive(serde::Serialize)]
pub struct SyncMeasurement<'a> {
    pub stamp: &'a str,
    pub mode: &'a str,
    pub display_id: Option<u32>,
    pub window_id: Option<u32>,
    pub camera_index: Option<u32>,
    pub microphone_uid: Option<&'a str>,
    pub webcam_lead_ms_applied: f64,
    pub webcam_spawn_delta_ms: Option<f64>,
    pub sck_first_frame_delta_ms: Option<f64>,
    // Phase B: receipt instant of webcam ffmpeg's first progress
    // line (frame=N, N>=1) expressed as signed ms delta from
    // engine_start. None for screen-only recordings, missed
    // markers, or recordings that ended before the first frame.
    pub webcam_first_frame_delta_ms: Option<f64>,
}

pub fn signed_delta_ms(later: Instant, earlier: Instant) -> f64 {
    if later >= earlier {
        later.duration_since(earlier).as_secs_f64() * 1000.0
    } else {
        -(earlier.duration_since(later).as_secs_f64() * 1000.0)
    }
}

pub fn log_finalize_best_effort(log_path: &Path, record: &SyncMeasurement<'_>) {
    // Live readout for the manual recording batch.
    eprintln!(
        "[sync-harness] stamp={} mode={} cam={:?} mic={:?} \
         webcam_spawn_delta_ms={:?} webcam_first_frame_delta_ms={:?} \
         sck_first_frame_delta_ms={:?} webcam_lead_ms_applied={}",
        record.stamp,
        record.mode,
        record.camera_index,
        record.microphone_uid,
        record.webcam_spawn_delta_ms,
        record.webcam_first_frame_delta_ms,
        record.sck_first_frame_delta_ms,
        record.webcam_lead_ms_applied,
    );

    let line = match serde_json::to_string(record) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[sync-harness] serialize failed: {e}");
            return;
        }
    };
    if let Some(parent) = log_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    match OpenOptions::new().create(true).append(true).open(log_path) {
        Ok(mut f) => {
            if let Err(e) = writeln!(f, "{line}") {
                eprintln!("[sync-harness] write failed: {e}");
            }
        }
        Err(e) => eprintln!("[sync-harness] open failed: {e}"),
    }
}
