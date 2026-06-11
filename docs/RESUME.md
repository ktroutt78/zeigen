# Resume — A/V sync investigation closed (2026-06-11)

## A/V SYNC FULLY RESOLVED

The intermittent webcam-vs-mic-audio sync issue (priority next-work from the 2026-06-08 RESUME) is **resolved end-to-end**. Validated dead-on (cold ~30ms / warm ~10ms residual, both within one 30fps frame and below A/V perception threshold) via strict-clap by-eye + clean-clap measurement.

### Root cause

The previous framing — "intermittent sync drift" — was a misread. The actual phenomenon: **every first recording per process lifetime / per long-idle break was out of sync; every subsequent recording in the same warm session was fine.** Going back through all 18 measured recordings in this investigation, every "cold" tag was literally first-of-session, every "warm" tag was non-first.

The driver was a **first-call init penalty** on three macOS framework caches that all real recordings hit:

- avfoundation device-open (webcam ffmpeg's `-f avfoundation` indev)
- VTCompressionSession creation (h264_videotoolbox first-frame)
- ScreenCaptureKit first-capture-call (engine `first_frame` event lag — directly measured: 232-265ms warm vs 336-503ms cold)

The webcam-vs-sck wallclock offset varies asymmetrically across cold vs warm, so a single fixed `WEBCAM_LEAD_MS` constant cannot match both states. No constant-only fix exists.

### Fix shape

1. **Per-recording pre-warm** (`src-tauri/src/prewarm.rs`) — a brief throwaway capture cycle that runs concurrently with the countdown window, warming the framework caches before every real recording. Two parallel tracks: throwaway webcam ffmpeg (Track A, ~500ms kill) + engine Start+Stop with `.prewarm-`-prefixed scratch (Track B, ~800ms + 400ms flush). Total Rust-side budget ~1.2s, hidden inside any 3s/5s countdown. Frontend caps the await at 1500ms hard ceiling. Skipped when countdown is Off.

2. **`WEBCAM_LEAD_MS` recalibration** — once pre-warm equalizes the cold/warm pipeline state, a single constant works. Empirically dialed to **360ms** via strict-clap measurement.

### The five commits

| sha | what |
|---|---|
| `aebc3b8` | chore(av-sync): remove Phase A + B measurement harness — diagnostic done, no need to ship stderr piping or JSONL writes on the capture path |
| `3f8d7a1` | fix(av-sync): WEBCAM_LEAD_MS 280 → 220 — mid-investigation midpoint when we still thought cold needed a separate lead (later disproved) |
| `b906945` | feat(av-sync): per-recording pre-warm to fix first-recording sync — Track A + Track B + abort path + 1500ms frontend ceiling |
| `c98a744` | fix(av-sync): filter pre-warm engine events from frontend handlers — engine's started/progress/stopped events from the throwaway were leaking through the same listener that drives the real recording's UI state |
| `040b104` | fix(av-sync): WEBCAM_LEAD_MS 220 → 360 — final calibration post-pre-warm, validated by dial-test (220 +100/+100ms lag → 310 +50ms lag → 360 +30/+10ms, both within ~1 frame) |

Full progression on the const: **280 → 220 → 360**. The 220 was a midpoint dictated by an incomplete model; once pre-warm closed the cold/warm gap, the true webcam-vs-sck on the warm pipeline state landed at ~360ms.

### Investigation history (not load-bearing, archival only)

We spent significant time on a measurement harness (Phase A + Phase B) trying to instrument webcam-first-frame timing per recording. Phase B's reading turned out to be **systematically biased** by encoder pipeline latency — ffmpeg's first `frame=N` progress line marks "first ENCODED frame," not "first frame captured by avfoundation," and h264_videotoolbox buffers 200-400ms of input before emitting its first output. The sync model (tpad direction, what value the constant approximates) was correct; only the measurement was unreliable for absolute prediction. The harness was reverted (`aebc3b8`) once user-perception became the established ground truth.

Lessons captured:

- Don't pursue `-use_wallclock_as_timestamps` or `-bf 0` to chase a cleaner measurement — both change the recorded mp4 (PTS scheme / bitstream) and add real capture-path risk for a diagnostic.
- "Cold/warm sliding lag" was the wrong model. The first-of-session pattern is binary, not continuous.
- Adaptive-per-recording lead was on the table for a while; pre-warm made it unnecessary by collapsing the variance the adaptive scheme would have compensated for.

## Two edge tests still pending before session close

1. **countdown=Off, first recording of a fresh session.** Pre-warm is skipped on Off per the chosen policy. Need to characterize: is the first-recording sync mildly off, or unusable? If unusable, Off users may need a separate answer (e.g., a forced minimal pre-warm even on Off).
2. **Cancel during countdown.** Confirm pre-warm aborts cleanly (Track A child killed, Track B engine Stop dispatched, scratch cleaned, state returns to idle, no orphan processes).

These are user-action tests. After both pass (or surface a follow-up), the session closes.

## Remaining V2.3 work (carry-forward, unchanged)

- **R6 packaged-app TCC permission UAT** (D-07 from original V2.3-PLAN). Build local unsigned `com.zeigen.app` bundle, confirm-gated `tccutil reset`, observe clean-machine Screen Recording → Microphone sequence, characterize relaunch-gotcha. ~30 min.
- **`docs/V2.3-REPORT.md`** — per-commit outcomes (c1, c2, c3.S1, c3.S2, c3=D-07), risk-register cross-references, carry-forward list.
- **`docs/V2-RISKS.md` R3 + R6 updates** — R3 downgrade (codes wired end-to-end through Tauri spawn path), R6 close-or-residual depending on UAT outcome.

## Carry-forward (severity-tagged)

**Real next-work** (V2.3 supplement or follow-on):

- **Watchdog → `recording_reset` discard.** App.tsx countdown watchdog (`App.tsx:1334`) takes state via `recording_reset` rather than `recording_finalize`, silently discarding any captured webcam-on-disk content. Same shape as c3.S2's fix space, different trigger. Reachable on iPhone+iPhone Continuity slow-startup, possibly other slow-init combos.

**Minor / out of V2.3 scope:**

- **Engine-side synthetic test ordering bug.** Synthetic `ZEIGEN_FORCE_MIC_SESSION_ERROR=1` has been a no-op since V2.2 c3 on slow-init devices — `handleStart` assigns session/state AFTER the synthetic's 100ms async-after, so `handleFatalError`'s guard fails. Engine V2.2-frozen; defer.
- **`recording_cleanup_local` dead-code.** c3.S2 removed its last App.tsx caller; Rust handler + Tauri registration still in place pending field validation.
- **Scrollbar layout overflow** when error banner pushes main-window content beyond viewport. Cosmetic.

## Cross-platform stance (formalized this session)

Surfaced as a strategic question mid-investigation. Searched the record — Windows/Linux are explicitly **out of scope** in CLAUDE.md, README.md, and docs/PLAN.md; never encoded as a goal anywhere. Decision: Zeigen stays macOS-only. Any future Windows path would be a separate lightweight web-based recorder, not a port of this engine. No architecture changes required from this decision; the existing Tauri/React layer is already portable, and the Swift engine is well-isolated behind the IPC contract if a parallel Windows native engine is ever needed.

## Branch state

`capture-engine-v2` is **57 commits ahead of `main`** as of `040b104`. Five A/V sync commits added this session on top of the V2.3 c3 supplement work.

`main` has not moved since v1.0 (`2484bb9`); forward-merge cadence remains a no-op.
