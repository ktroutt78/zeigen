# Resume — V2.3 c3 supplement close (2026-06-08)

## Next session start: A/V sync regression — measurement-harness-first

The intermittent webcam-vs-mic-audio sync issue (Phase 15 close-out backlog item) surfaced again during c3.S2 verification: `recording-2026-06-08-183256` **saved cleanly and is fine as a c3.S2 happy-path verification** (8-second recording, clean stop, review opened, save worked) — but **by eye, on playback, the bubble's mouth movements show a visible gap from the audio**. The clean save says nothing about sync; these are independent facts.

**Leading hypothesis (unconfirmed):** `WEBCAM_LEAD_MS` (~280ms) vs measured sck_lag variance. `lib.rs:476` records sck_lag varying 225-360ms between recordings on this hardware; if actual lag is 360ms but the player applies 280ms, the bubble would be 80ms out of sync — within perceptible range. **But this is not established.** Earlier clap tests came back in-sync on measured files, and a cross-correlation on the suspect file was inconclusive. Could also be:
- The Phase 15 #4 bubble-anchor shift (engine `first_frame` → finalize-time keyframe rebase) not actually applying as designed on this code path
- A second drift source the bubble-anchor fix doesn't address (e.g. webcam ffmpeg startup latency vs SCK first-frame timing — distinct from sck_lag)

**Plan: measurement-harness-first.** Before any fix:
1. Add per-recording sck_lag persistence — Rust already timestamps `first_frame_at` on the active recording for the bubble-shift logic at `lib.rs:486`. Persist that delta to the sidecar or FinalizedRecording payload so offline analysis can correlate sync-by-eye with measured lag per recording.
2. Clap-test methodology from the Phase 15 close-out note: bisect against known-in-sync historical recordings; cross-correlate audio peak vs visual peak in playback.
3. Decide between: (a) per-recording adaptive `webcamLeadMs` from measured sck_lag, (b) tighter `WEBCAM_LEAD_MS` calibration, (c) accept residual variance + tune dual-stream player's 50ms drift threshold, (d) bubble-anchor pipeline fix if it's not applying as designed, (e) something else if the cause turns out to be neither sck_lag nor the anchor pipeline.

**Do NOT** fix the player or the constant before measurement data is in hand. The cause is genuinely unknown.

## Remaining V2.3 work

- **R6 packaged-app TCC permission UAT** (D-07 from original V2.3-PLAN). Build local unsigned `com.zeigen.app` bundle, confirm-gated `tccutil reset`, observe clean-machine Screen Recording → Microphone sequence, characterize relaunch-gotcha. ~30 min.
- **`docs/V2.3-REPORT.md`** — per-commit outcomes (c1, c2, c3.S1, c3.S2, c3=D-07), risk-register cross-references, carry-forward list.
- **`docs/V2-RISKS.md` R3 + R6 updates** — R3 downgrade (codes wired end-to-end through Tauri spawn path), R6 close-or-residual depending on UAT outcome.

## Carry-forward (severity-tagged)

**Real next-work** (V2.3 supplement or follow-on):
- **A/V sync regression** — see "Next session start" above. **Priority.**
- **Watchdog → `recording_reset` discard.** App.tsx countdown watchdog (`App.tsx:1334`) takes state via `recording_reset` rather than `recording_finalize`, silently discarding any captured webcam-on-disk content. Same shape as c3.S2's fix space, different trigger. Reachable on iPhone+iPhone Continuity slow-startup, possibly other slow-init combos.

**Minor / out of V2.3 scope:**
- **Engine-side synthetic test ordering bug.** Synthetic `ZEIGEN_FORCE_MIC_SESSION_ERROR=1` has been a no-op since V2.2 c3 on slow-init devices — `handleStart` assigns session/state AFTER the synthetic's 100ms async-after, so `handleFatalError`'s guard fails. Engine V2.2-frozen; defer.
- **`recording_cleanup_local` dead-code.** c3.S2 removed its last App.tsx caller; Rust handler + Tauri registration still in place pending field validation.
- **Scrollbar layout overflow** when error banner pushes main-window content beyond viewport. Cosmetic.

## Branch state

`capture-engine-v2` is **27 commits ahead of `main`** as of c3.S2 (`85ef7bb`). Two supplement commits on top of c1 (`578fca3`) + c2 (`1fda7f2`). V2.3 c3 (= D-07 R6 packaged-app UAT) is the only remaining piece before V2.4 parity gate + cutover.

`main` has not moved since v1.0 (`2484bb9`); forward-merge cadence remains a no-op.
