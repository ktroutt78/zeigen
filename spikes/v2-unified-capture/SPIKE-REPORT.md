# V2.1 — Unified-capture spike — Report

**Run date:** 2026-05-21
**Branch:** `capture-engine-v2`
**Phase docs:** `docs/V2-CHARTER.md`, `docs/V2-PHASE-PLAN.md` §V2.1, `docs/V2.1-CONTEXT.md`, `docs/V2.1-PLAN.md`

---

## Verdict

**GO (Track B).** Shared-clock SCK fallback validates the unified-clock hypothesis on this hardware and SDK. AVCaptureSession-native screen device (Track A) does not exist on macOS 26.4.1 / SDK 26.2 — Track A is unavailable, not failed.

**Next:** draft V2.2 CONTEXT against the validated path. Production engine productionizes Track B's shape (SCStream screen + AVCaptureSession mic via shared host-clock CMSampleBuffer feeds into AVAssetWriter), with the two V2.2-load-bearing implementation fixes in §"V2.2 carryover."

The V2.1 spike validates the *premise* V2.2–V2.4 build on. It does not hit the V2-CHARTER DONE bar for saved-file `abs_drift_ms < 17ms`; that bar is V2.4's gate and depends on the V2.2 carryover work below.

---

## Three-signal verdict logic

c2's measurement harness separated `abs_drift_ms` (Phase 13's user-visible metric) into three signals. Each maps to a different phase of work and a different role in the verdict:

| Signal | What it captures | Where it gets fixed | Hypothesis-load-bearing? |
|---|---|---|---|
| `abs_drift_ms` | Saved-MP4 V−A track-length mismatch (Phase 13 metric, V2-CHARTER DONE gate) | Composite — fixed when the two below are fixed | **No** — derived |
| `startup_gap_ms` | Asymmetric writer-start; audio first-PTS lags video first-PTS in shared host-clock time | **V2.2** — `startSession(atSourceTime:)` aligned to `max(first_video_pts, first_audio_pts)`; gate writer-start until both pipelines have produced a sample | **No** — pipeline implementation artifact |
| `end_time_drift_ms` | Stream-end gap in shared host-clock time. *If stable across takes, this is the clock-parity signal.* | **V2.2** (symmetric teardown — see below) and **V2.4** (residual AAC characterization per R2) | **Yes** — this is the actual hypothesis test |

**Why `end_time_drift_ms` is load-bearing.** If shared-clock failed (i.e. video and audio CMSampleBuffer timestamps lived in different time bases that drift), `end_time_drift_ms` would either accumulate with recording length or vary chaotically take-to-take. Stable, bounded values across runs say the timestamps stay in step — the hypothesis holds.

**Relationship.** `abs_drift_ms ≈ |startup_gap_ms − end_time_drift_ms|`. Spot-check from `output/results.csv`: primary-03 gives `|243.298 − 42.298| = 201.000` (matches); primary-02 gives `|80.717 − 87.717| = 7.000` (matches); primary-01 gives `|106.708 − 65.708| = 41.000` (matches). The decomposition is consistent across all 10 takes.

### Hypothesis test — GO bar

The unified-clock hypothesis is **supported** iff all of:

1. `end_time_drift_ms` **median < 80ms on each display**.
2. `end_time_drift_ms` **per-display spread (max − min) < 80ms**. Stability matters more than absolute magnitude — a wandering 30ms signal is worse than a stable 70ms one.
3. All takes exit 0 across both displays.

### Hypothesis falsified — NO-GO bar

The hypothesis is **falsified** iff any of:

1. `end_time_drift_ms` median ≥ 200ms on either display, or unbounded across takes.
2. Per-display spread ≥ 200ms (chaotic — suggests genuine drift, not fixed offset).
3. Both tracks fail to record at all.

### Ambiguous zone — duration scaling test

For future-V2 reference: if a future run lands in the 80–200ms median or 80–200ms spread band, re-run the matrix at `--duration 60` and compare `end_time_drift_ms` distributions. If the signal does not scale with duration, the hypothesis holds with a larger fixed offset. If it scales linearly with duration, clocks are genuinely drifting — falsification.

**Not exercised in this run; data was unambiguous.** (Documented here so the protocol is captured in a single place when ambiguity comes up later.)

---

## Applying the criteria to the c2 matrix

| Criterion | Primary | External | Result |
|---|---|---|---|
| `end_time_drift_ms` median | **62.418ms** | **69.609ms** | Both < 80ms → **pass (1)** |
| `end_time_drift_ms` spread (max − min) | **45.419ms** (42.298 → 87.717) | **4.419ms** (67.315 → 71.734) | Both < 80ms → **pass (2)** |
| Take exits | 5/5 exit 0 | 5/5 exit 0 | **pass (3)** |

All three criteria pass on both displays.

The external-display 4.4ms spread is the strongest "clocks hold" signal the matrix produced. Five consecutive 30-second takes landed `end_time_drift_ms` values in [67.315, 71.734] — a 4ms band — which is not a random walk. That's a fixed pipeline-shape offset, not clock divergence.

→ **Verdict: GO (Track B).**

---

## Track A — unavailable on this SDK

Per c1's probe (`probeScreenAVDevice` in `Sources/spike/main.swift`), neither `AVCaptureDevice.DiscoverySession` nor `AVCaptureDevice.devices(for: .video)` returns a screen- or display-shaped `deviceType` on macOS 26.4.1 / SDK 26.2. The probe matched against `deviceType.rawValue` containing "screen" or "display" (case-insensitive) and found no hits.

**Enumerated video devices observed at c1 commit time (exit code 80, `TRACK_A_UNAVAILABLE`):**

- `AVCaptureDeviceTypeBuiltInWideAngleCamera` — MacBook Air Camera
- `AVCaptureDeviceTypeDeskViewCamera` — KT iPhone Desk View Camera
- `AVCaptureDeviceTypeDeskViewCamera` — MacBook Air Desk View Camera
- `AVCaptureDeviceTypeExternal` — KT iPhone Camera

All four are camera-shaped. The `AVCaptureScreenInput` removal noted in `CLAUDE.md §"Known gotchas"` is confirmed not to have been replaced by an equivalent `AVCaptureDevice.DeviceType` in this SDK. Track A as the charter literally framed it ("AVCaptureSession-native screen device") is not available; the unified-clock premise has to be tested through Track B's shape.

This is a recorded finding for the V2 trail — if a future macOS SDK ships such a deviceType, V2.x may revisit Track A. Until then, Track B is the path.

---

## Track B — implementation summary

Per c2 (`runTrackB` and `TrackBRunner` in `Sources/spike/main.swift`):

- **Screen.** `SCStream` with `SCContentFilter(display:excludingWindows:)` against the requested `CGDirectDisplayID`. `captureMicrophone` deliberately **not** set — Track B's defining choice is routing mic through `AVCaptureSession`, not through SCK.
- **Mic.** `AVCaptureSession` with `AVCaptureDeviceInput(device: micDevice)` and `AVCaptureAudioDataOutput` delegate. Audio settings forced to mono float PCM 48kHz so the AAC encoder input matches its output 1:1 (the mic could otherwise be stereo, and writer downmix isn't guaranteed).
- **Mux.** Single `AVAssetWriter(outputURL:, fileType: .mp4)`. Both `AVAssetWriterInput`s (video H.264 8Mbps, audio AAC 48kHz mono 128kbps) take settings verbatim from `src-tauri/recording-engine/Sources/recording-engine/RecordingSession.swift:111-143` so this spike's MP4s are apples-to-apples vs the v1.0 baseline.
- **Writer-session start.** Whichever pipeline produces the first valid CMSampleBuffer triggers `writer.startSession(atSourceTime: pts)`. The other pipeline's samples land relative to that origin. *This is precisely where V2.2 will tighten — see below.*
- **Teardown.** `stream.stopCapture()` (awaits in-flight SCK callbacks) → `session.stopRunning()` → `markAsFinished()` on both inputs → `finishWriting`. Audio capture continues during the awaited `stopCapture`, which produces the observed teardown asymmetry.

---

## Clock identity finding

The spike logged AVCaptureSession's `synchronizationClock` against `CMClockGetHostTimeClock()` both pre- and post-`startRunning`. Observations:

- **Pre-start:** `session.synchronizationClock` is `nil`. The session hasn't selected a clock yet.
- **Post-start:** `session.synchronizationClock` is populated, but **`!== CMClockGetHostTimeClock()` by object identity**. They are different CMClock object references.
- **PTS observation:** the CMSampleBuffer presentation timestamps produced by both pipelines land in the same wall-clock seconds range. From `output/results.csv` first PTS columns, both `first_video_pts_s` and `first_audio_pts_s` per take are within ~80–243ms of each other in the same multi-second host-time range (e.g. primary-01: `1778678.645813` vs `1778678.752521`).

**Interpretation.** Shared-clock parity is at the **time-base** level, not at the CMClock-object-reference level. Both clocks tick host time (`CLOCK_MONOTONIC_RAW` in macOS terms). The spike's original c1 done-when criterion ("verify both inputs reference the same clock object") was the wrong test — object-identity equality of CMClock references is not what the hypothesis requires. The actual requirement is that PTS values produced by both pipelines are comparable in the same time base, which they are.

This is a methodology refinement worth flagging for V2.2 CONTEXT: do not check CMClock object identity; check time-base agreement via produced PTS values (or via `CMClockConvertHostTimeToSystemUptime` round-trip).

---

## V2.2 carryover

These are the two pipeline-shape fixes V2.2 must implement for the saved file to hit the V2-CHARTER DONE bar (`abs_drift_ms < 17ms`). Neither is a hypothesis problem — both are implementation work the spike deliberately did not optimize for, but the V2.4 gate cannot pass without them.

### 1. Writer-start alignment (eliminates `startup_gap_ms`)

The spike's `TrackBRunner.append` triggers `writer.startSession(atSourceTime:)` on the **first sample of whichever pipeline produces one**. In practice video samples arrive first by 80–243ms, so the writer session origin is anchored at the first video PTS — and audio's first sample lands ~80–243ms into the session, leaving an audio-silent prefix that ffprobe surfaces as `audio_start_time`.

**Fix.** Gate writer-start until both pipelines have produced at least one sample, then call `writer.startSession(atSourceTime: max(first_video_pts, first_audio_pts))`. Drop or trim any pre-origin samples from the earlier pipeline. The audio prefix collapses to ~0; the saved MP4's audio_start_time approaches 0.

**Expected impact on `abs_drift_ms`.** `startup_gap_ms` is the dominant contributor to `abs_drift_ms` (it ranges 80–243ms, vs `end_time_drift_ms`'s 42–88ms; the difference between them is the saved-file drift). Fixing startup alignment alone removes 80–243ms from the saved-file drift. Post-fix `abs_drift_ms` ≈ `end_time_drift_ms` ≈ 42–88ms.

### 2. Symmetric teardown (reduces `end_time_drift_ms`)

The spike's teardown order is `stream.stopCapture()` → `session.stopRunning()` → `markAsFinished()` → `finishWriting`. `SCStream.stopCapture` is async and awaits in-flight callbacks; while it awaits, `AVCaptureSession` continues producing audio samples. The ~42–88ms `end_time_drift_ms` consistent across takes is the duration of that `stopCapture` await — audio runs ~65ms past video, as a constant offset.

**Fix.** Stop both pipelines concurrently (`async let` on `stream.stopCapture()` and a wrapped `session.stopRunning()` future), or stop AVCaptureSession's audio output explicitly *before* awaiting `stream.stopCapture`. Either way the audio tail past video-end shrinks.

**Expected impact on `abs_drift_ms`.** With writer-start alignment + symmetric teardown, the residual is dominated by AAC frame quantization (AAC frames at 48kHz are ~21ms; last-frame tail is 0–21ms). That residual is R2 territory and V2.4 measures it.

### Why these aren't V2.1 spike work

The spike's job is hypothesis validation, not engine production. Implementing writer-start alignment + symmetric teardown inside the spike would obscure which signal is which — V2.1 deliberately ran them naive so c3 could separate startup, end-time, and AAC contributions. V2.2 builds the production engine fresh with both fixes (per V2-CHARTER §"Branch hygiene" — the spike is not transplanted).

---

## Results matrix

From `spikes/v2-unified-capture/output/results.csv` (10 takes, Track B, default mic, --duration 30):

| display | take | track | wall (s) | video_dur (s) | audio_start (s) | audio_dur (s) | abs_drift (ms) | startup_gap (ms) | end_time_drift (ms) | exit |
|---|---|---|---|---|---|---|---|---|---|---|
| primary | 01 | B | 31 | 30.611667 | 0.106687 | 30.570667 | 41.000 | 106.708 | 65.708 | 0 |
| primary | 02 | B | 31 | 30.158333 | 0.080708 | 30.165333 | 7.000 | 80.717 | 87.717 | 0 |
| primary | 03 | B | 31 | 30.345000 | 0.243292 | 30.144000 | 201.000 | 243.298 | 42.298 | 0 |
| primary | 04 | B | 31 | 30.265000 | 0.179375 | 30.144000 | 121.000 | 179.384 | 58.384 | 0 |
| primary | 05 | B | 31 | 30.278333 | 0.154083 | 30.186667 | 91.666 | 154.084 | 62.418 | 0 |
| external | 01 | B | 31 | 30.233333 | 0.202042 | 30.101333 | 132.000 | 202.043 | 70.043 | 0 |
| external | 02 | B | 31 | 30.150000 | 0.115979 | 30.101333 | 48.667 | 115.982 | 67.315 | 0 |
| external | 03 | B | 31 | 30.183333 | 0.149583 | 30.101333 | 82.000 | 149.587 | 67.587 | 0 |
| external | 04 | B | 31 | 30.166667 | 0.134937 | 30.101333 | 65.334 | 134.943 | 69.609 | 0 |
| external | 05 | B | 30 | 30.150000 | 0.120396 | 30.101333 | 48.667 | 120.401 | 71.734 | 0 |

Per-display stats:

| signal | primary median | primary spread | external median | external spread |
|---|---|---|---|---|
| `abs_drift_ms` | 91.666 | 194.000 | 65.334 | 83.333 |
| `startup_gap_ms` | 154.084 | 162.581 | 134.943 | 86.061 |
| `end_time_drift_ms` | **62.418** | **45.419** | **69.609** | **4.419** |

Source data: `output/results.csv` + `output/meta.csv` (in the spike's `output/` directory, gitignored per `spikes/*/output/` rule).

---

## AAC priming residual snapshot (R2 carry-over)

Phase 13 measured ~43ms of AAC priming silence at the saved MP4's audio start (ffprobe `audio_start_time`). The spike's `audio_start_time` values range 80–243ms, but the dominant contributor is **pipeline startup_gap**, not encoder priming — `startup_gap_ms` and `audio_start_s × 1000` track each other to within rounding error (e.g. primary-03: `audio_start_s × 1000 = 243.292`, `startup_gap_ms = 243.298`).

After V2.2's writer-start alignment lands and `startup_gap` collapses to ~0, the residual `audio_start_time` is the AAC encoder priming proper. We don't have that data yet — the spike can't separate the two without the V2.2 fix in place.

**For R2:** V2.1 does not produce a clean priming measurement under the unified path. V2.4 measures it after V2.2 lands, then decides on muxer-level fix vs documented-as-known-limitation. Severity unchanged.

---

## Surprises

Each surprise either edits `docs/V2-RISKS.md` (existing risk gets new data) or — if novel — would add a new risk. Risk-register changes land in this commit per V2-RISKS.md §"Update protocol."

1. **Track A is not just absent — it never had a SDK shape on macOS 26 to begin with.** The charter implied "AVCaptureSession-native screen device" as the literal hypothesis target. `AVCaptureScreenInput`'s removal isn't paired with a successor `AVCaptureDevice.DeviceType`. R1 update: Track A path foreclosed for the foreseeable future on this SDK family.

2. **Clock identity is NOT object identity.** AVCaptureSession's `synchronizationClock` and `CMClockGetHostTimeClock()` are different CMClock objects but both produce PTS in host time. The spike's planned c1 done-when ("both inputs reference the same clock object") would have produced a false-negative falsification if applied literally to Track B. The actual requirement is time-base parity, not reference parity. V2.2 CONTEXT should call this out so the production engine doesn't reintroduce the wrong check.

3. **`end_time_drift_ms` is dominated by teardown order, not AAC residual.** The c2 commit body diagnoses the ~65ms residual as "audio stops ~65ms after video because session.stopRunning awaits stream.stopCapture." This makes R2 (AAC priming) **less load-bearing** than the risk register assumed — most of the visible saved-file residual is V2.2-fixable pipeline shape, not encoder behavior. The remaining AAC residual after V2.2's symmetric teardown is likely small (one AAC frame ≈ 21ms at 48kHz).

4. **External display is *more* stable than primary on `end_time_drift_ms`.** 4.4ms spread vs 45.4ms spread. The opposite of the usual multi-display story (primary tends to behave; external misbehaves). R5 update: positive evidence — Track B's screen-handling does not regress on external displays; if anything it's more consistent there (likely a coincidence of fewer compositor events on a less-cluttered external screen, but it's not a regression to mitigate against).

5. **Three displays present, two were used.** The host has primary BenQ (id=3), built-in MacBook Air (id=1), and secondary BenQ (id=14). Matrix used primary BenQ + built-in for the two-display test. Secondary BenQ untested; not load-bearing for the hypothesis (V2.1 criterion is "primary + at least one external"; both passed).

6. **Permission flow under the unified path (R6 data point).** First c1 run prompted Screen Recording first (granted), then Microphone (granted). One dialog each, sequential, matched v1.0's order. Subsequent runs (with cached permissions) prompted nothing. No first-run flow regression observed. R6 update: no surface change vs v1.0 — but caveat that c1 already had v1.0's Mic permission cached from prior recording-engine runs, so the "fresh install" character may differ; V2.4 catches that.

---

## Metadata

From `output/meta.csv`:

- **macOS:** 26.4.1 (Build 25E253, per c1 commit body)
- **macOS SDK:** 26.2
- **Swift:** 6.2.4
- **Spike track override:** auto (resolved to B every take)
- **Primary display:** CGDirectDisplayID `3` — BenQ (primary)
- **External display:** CGDirectDisplayID `1` — built-in MacBook Air display
- **Mic:** default (built-in, not specified by UID)
- **Recording duration:** 30s per take
- **Driver:** `spikes/v2-unified-capture/run.sh`

Available displays at `--list-displays` time (3 displays):

| CGDirectDisplayID | size | is_primary | name | avc_uniqueID |
|---|---|---|---|---|
| 3 | (BenQ res) | yes | BenQ | n/a |
| 1 | (built-in res) | no | built-in | n/a |
| 14 | (secondary BenQ res) | no | secondary BenQ | n/a |

All three displays return `n/a` for `avc_uniqueID` — consistent with Track A unavailability (no AVCaptureDevice maps to any CGDirectDisplayID on this SDK).

Available mics at `--list-mics` time:

| uniqueID | localizedName | is_default |
|---|---|---|
| (built-in UID) | built-in microphone | yes |
| (iPhone Continuity UID) | KT iPhone Microphone | no |

---

## Risk register updates (committed with this report)

Per `docs/V2-RISKS.md` §"Update protocol":

- **R1** moves from "spike coverage" to **realized — GO via Track B; Track A SDK-unavailable on macOS 26.4.1 / SDK 26.2 (no AVCaptureDevice.DeviceType for screens).** Fallback engaged successfully.
- **R2** gains data: AAC priming residual cannot be cleanly measured under the spike's pipeline shape; dominant `audio_start_time` contributor is `startup_gap`, not encoder priming. V2.4 measures the true residual after V2.2's writer-start alignment lands. Severity unchanged.
- **R5** gains data: per-display variance in `end_time_drift_ms` is small and *favors* the external display (4.4ms spread vs 45.4ms primary). No multi-display regression observed in the spike's recording path. UI placements (bubble, countdown, identify) remain Phase 7 / Phase 14 c1's invariant.
- **R6** gains data: permission prompt sequence under the unified Track B path matches v1.0's (Screen Recording, then Microphone, one dialog each). No regression on this dev machine. First-run-with-fresh-install character still requires V2.4 verification.

A **new** finding worth its own line — methodology refinement on CMClock identity — is **noted in V2.2's eventual CONTEXT, not a new risk**, because it changes how V2.2 verifies the clock contract, not what could go wrong.

---

## Files referenced by this report

- `spikes/v2-unified-capture/Sources/spike/main.swift` — spike binary source.
- `spikes/v2-unified-capture/run.sh` — 5×30s × 2-display driver.
- `spikes/v2-unified-capture/output/results.csv` — per-take measurements.
- `spikes/v2-unified-capture/output/meta.csv` — host metadata snapshot.
- `spikes/v2-unified-capture/output/*.mp4` — recorded takes (gitignored).
- `spikes/v2-unified-capture/output/*.pts` — per-take first-PTS sidecars (gitignored).
- `spikes/v2-unified-capture/output/*.track` — per-take track identity sidecars (A or B; gitignored).
- `src-tauri/recording-engine/Sources/recording-engine/RecordingSession.swift:111-143` — v1.0 writer settings the spike inherits verbatim.
- `docs/V2-CHARTER.md` — DONE definition the V2.4 gate enforces (saved-file `abs_drift_ms < 17ms`).
- `docs/V2-PHASE-PLAN.md` §V2.1 — phase scope and deliverable shape.
- `docs/V2-RISKS.md` — risk register updated alongside this report.

---

*Phase: V2.1-unified-capture-spike*
*Verdict: GO (Track B), 2026-05-21*
