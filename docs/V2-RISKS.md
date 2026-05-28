# V2 Risk Register

**Drafted:** 2026-05-21
**Status:** Living document — update on every spike finding or production surprise.

Each risk: **what could go wrong**, **severity** (probability × blast radius), **spike coverage** (whether V2.1 exercises it), **fallback** (what we do if it materializes).

Severity scale:

- **High** — falsifies the v2 hypothesis or forces a charter-level rethink.
- **Medium** — survivable but expensive; may push phase boundaries or compromise the done-definition.
- **Low** — known cost, isolated mitigation, doesn't move the schedule.

---

## R1. AVCaptureSession screen capture quirks on macOS 26

**What could go wrong.** `AVCaptureScreenInput` is gone on macOS 26 per CLAUDE.md. The replacement path through `AVCaptureSession` either (a) doesn't exist in a usable form on current macOS and we're stuck on ScreenCaptureKit, defeating the unified-clock premise, or (b) exists but has its own multi-display / DisplayLink quirks (Phase 7, Phase 14 c1, DECISIONS.md 2026-04-26) that we haven't characterized.

**Severity:** **High.** This risk is the spike. If the unified path doesn't exist or doesn't share a clock, V2.1's pass criterion (a) fails and the v2 hypothesis is falsified.

**Spike coverage.** V2.1 directly. The spike's first job is to identify and instantiate the screen-capture input that participates in `session.masterClock`.

**Fallback.** If the unified path doesn't exist: stop V2. Document the falsification in SPIKE-REPORT.md and back out to v1.0 with a different drift mitigation approach (silence-pad on save, or thread S into the file). The fallback is *not* "build a halfway version of V2."

**Realized (2026-05-21, V2.1 spike).** **GO via Track B.** Outcome (a) materialized — `AVCaptureScreenInput`'s removal has no successor `AVCaptureDevice.DeviceType` on macOS 26.4.1 / SDK 26.2. The spike's `AVCaptureDevice.DiscoverySession` + `AVCaptureDevice.devices(for: .video)` probe enumerated only camera-shaped types (BuiltInWideAngleCamera, DeskViewCamera×2, External), no screen device. Charter's literal hypothesis (AVCaptureSession-native screen) is foreclosed on this SDK family.

The unified-*clock* premise was preserved through the fallback shape: SCStream screen + AVCaptureSession mic, both producing PTS in host time, muxed into one AVAssetWriter. `end_time_drift_ms` median 62ms (primary) / 70ms (external), spread 45ms / 4ms — well inside the 80ms GO bar. V2.2 productionizes this shape. See `spikes/v2-unified-capture/SPIKE-REPORT.md` for full data.

Methodology note for V2.2: clock parity is at the **time-base** level, not at the CMClock-**object-reference** level. `AVCaptureSession.synchronizationClock !== CMClockGetHostTimeClock()` by identity, yet both produce PTS in the same host-time range. Do not verify the clock contract with `===` reference equality — use time-base agreement on produced PTS values.

---

## R2. AAC priming residual may persist if encoder unchanged

**What could go wrong.** Phase 13 measured ~43ms of AAC encoder priming on saved MP4s. Unified capture fixes the *source* clock, but the *encoder* may still introduce priming silence at the start of the audio track. If the encoder is unchanged between v1.0 and v2 (same AVAssetWriter + same AAC settings), the priming gap likely persists. V−A drift fix doesn't imply audio-start fix.

**Severity:** **Medium.** Doesn't block V2.4 — the charter says "verify whether the ~43ms AAC priming residual persists or is fixed (don't assume)." Either outcome is acceptable as long as we measure and document.

**Spike coverage.** V2.1 partially — the spike produces MP4s we can `ffprobe` for audio `start_time`. Full characterization lands in V2.4.

**Fallback.** If priming persists: document it as a known v2 limitation matching v1.0 behavior. No production change. If a future phase wants to fix it, options are (a) audio-track edit list / `priming_info` atom written via the muxer, (b) silence-trim post-encode, (c) different encoder. If priming is fixed in v2 (residual disappears), that's the v2 win — note it in the v2.0 release notes.

**Update (2026-05-21, V2.1 spike).** **Cannot yet cleanly measure.** The spike's `audio_start_time` ranged 80–243ms across 10 takes, but this is dominated by `startup_gap_ms` (pipeline writer-start asymmetry — V2.2-fixable), not AAC encoder priming. `audio_start_s × 1000` and `startup_gap_ms` track each other to within rounding error per take, leaving no headroom to read the priming residual separately. Two structural contributors are tangled in the V2.1 measurement:

1. Writer-start asymmetry: 80–243ms per take, dominant.
2. AAC encoder priming proper: masked; magnitude unknown until V2.2 writer-start alignment lands.

After V2.2 lands writer-start alignment (`startSession(atSourceTime: max(first_video_pts, first_audio_pts))`), the residual `audio_start_time` reads cleanly as priming proper. V2.4 measures it then and decides on muxer-level fix vs documented-as-known-limitation per the existing fallback options.

Related: `end_time_drift_ms` (~62–70ms median across takes, well bounded) is **not** AAC tail — it is dominated by teardown order (`stream.stopCapture` awaits in-flight callbacks while AVCaptureSession keeps producing audio). V2.2 closes this with symmetric teardown. Severity unchanged.

---

## R3. IPC contract cascade into Rust side

**What could go wrong.** Unified capture forces a change to the Swift engine's payload shape (e.g. new field, removed field, renamed event), which cascades into Rust IPC handlers (`src-tauri/src/`), TS event listeners (`src/App.tsx`, `src/Review.tsx`), and `docs/IPC-SPEC.md`. The charter says IPC changes are in-scope only if "forced" — risk is that "forced" gets stretched into "convenient."

**Severity:** **Medium.** Mitigations are organizational, not technical.

**Spike coverage.** V2.1 does not touch IPC — the spike is a standalone Swift binary. IPC cascade risk surfaces in V2.2 / V2.3.

**Fallback.** Hard rule per the charter: IPC contract changes only on a forcing function. If a v2.2 plan suggests an IPC change, the plan must name the specific unified-capture constraint that forces it. "Cleaner shape" or "while we're here" are not forcing functions. If an IPC change does land, `docs/IPC-SPEC.md` updates in the same commit.

**Realized (2026-05-27, V2.2 c2/c3).** Three new error codes added per the V2.2-CONTEXT D-04 forcing function — `MIC_NO_FIRST_SAMPLE` (c2), `CLOCK_MISMATCH` and `MIC_SESSION_FAILED` (c3). The widening is the minimum the new architecture forced: clock verification, a mid-recording AVCaptureSession, and a no-first-audio-sample timeout are all failure modes v1.0's SCK-mic path could not produce, and collapsing them into `WRITER_FAILED`/`INTERNAL` would lose the diagnostic information V2.4's parity gate depends on. No structural payload changes — no new events, no new/removed/renamed fields, only new `code` string values on the existing `error` event. `docs/IPC-SPEC.md` updated in the landing commits per the same-commit rule. Severity stays Medium until V2.3 wires the Rust-side handlers to the new codes; downgrade after. See `docs/V2.2-REPORT.md`.

---

## R4. Mic hot-swap behavior differences

**What could go wrong.** v1.0's separate mic AVCaptureSession is independent from screen capture; mic plug/unplug (USB, Continuity drop, iPhone sleep) doesn't tear down screen capture. In a unified session, a mic device disappearing mid-record may interrupt the entire session including screen — losing the recording instead of just losing audio. Continuity Camera drop is already in CLAUDE.md as a known gotcha.

**Severity:** **Medium.** Real-world user-facing regression if it materializes. Edge case but a known-recurring one (Continuity is unreliable).

**Spike coverage.** V2.1 does not exercise hot-swap (deliberately — V2.1 is the unified-clock hypothesis, not robustness). Surfaces in V2.4 if at all.

**Fallback.** Two directions. (1) If the unified session can be configured to keep running on mic-input failure, that's the fix. (2) If not, fall back to v1.0's architecture (separate mic session) and accept the V−A drift as the tradeoff. Choice depends on what V2.4 measurements show — if drift fix is large and hot-swap loss is rare, take the unified path with the hot-swap regression documented.

**Realized (2026-05-27, V2.2 c3 UAT-1) — severity downgraded Medium → Low (not closed).** Direction (1) held: the unified session keeps running on mic-input failure. The catastrophic outcome this risk feared — a mid-record mic loss tearing down the whole session and losing the recording — does not materialize; the recording is never lost wholesale, worst case is a valid file with a shorter or silent audio track. By device class: iPhone Continuity never ceases at the buffer level (macOS substitutes silence — confirmed across screen-lock, Wi-Fi-off, and Airplane Mode; full-length file with a silent span, no freeze, no error); USB-class genuine cessation is handled by D-15 — cap-release so video continues video-only, plus a 1.0s cessation watchdog that emits `MIC_DROPPED`. Downgraded — catastrophic loss disproven, graceful degradation confirmed for target inputs; **residual = the D-15(c) watchdog path is code-verified but runtime-unfired (no target input produces cessation: built-in never drops, Continuity silence-substitutes, USB is not a target input).** Low, not closed — a real but small residual, not gone. D-15(b) (`AVCaptureDeviceWasDisconnected` observation) is a V2.3 faster-signal optimization, not an open gap. See `docs/V2.2-REPORT.md` and V2.2-CONTEXT D-15.

---

## R5. Multi-display edge cases

**What could go wrong.** Phase 7, Phase 14 c1, and DECISIONS.md 2026-04-26 are full of multi-display footguns: negative-x coordinates for screens left of primary, DisplayLink screens with NSWindow.setFrame placement failures, half-size landings on non-primary displays. Unified capture's screen-input path may have its own analogues we haven't characterized.

**Severity:** **Medium.** v1.0's multi-display behavior is hard-won — Phase 14 c1 was its own commit on the bubble-placement bug. Regressions here would be visible immediately.

**Spike coverage.** V2.1 criterion (b) — "Works on primary + at least one external display." Tests basic recording but not the bubble/countdown/identify placements (those are UI, out of scope for the spike).

**Fallback.** UI placements (bubble, countdown, identify) already use `set_window_frame_cg` per Phase 7 / Phase 14 c1 — they don't depend on the capture engine, so they're invariant under v2. The risk is purely about whether the *recording* (the SCK-equivalent path) handles all displays the same way. If it doesn't, V2.4 catches it and we either fix or roll back.

**Update (2026-05-21, V2.1 spike).** **No multi-display regression in the recording path.** The spike's 5×30s × 2-display matrix (primary BenQ id=3 + built-in MacBook Air id=1) ran 10/10 takes to exit 0 on Track B. Per-display `end_time_drift_ms` variance *favors* the external/built-in display (4.4ms spread across 5 takes vs 45.4ms on primary). Direction is the opposite of the usual multi-display story.

Likely an artifact of less compositor activity on the less-cluttered screen rather than a fundamental property of Track B's screen-handling — not load-bearing for V2.2 design, but worth not relying on if a future test uses two equally-busy displays. Third available display (secondary BenQ id=14) was not exercised; not load-bearing for the V2.1 criterion ("primary + at least one external"). Severity unchanged.

---

## R6. Permission flow differences (screen + mic at session creation)

**What could go wrong.** v1.0 requests Screen Recording, Camera, and Mic permissions independently. Unified `AVCaptureSession` with screen + mic inputs may require both permissions at session creation; if either is denied, the session fails before recording starts. The user-facing permission prompt sequence may also change — new dialogs, different timing, or all-at-once vs incremental.

**Severity:** **Medium.** First-run experience regression. The user has long since granted permissions on their dev machine so this won't surface in daily use; surfaces only on a fresh install or after a permission reset.

**Spike coverage.** V2.1 does not — the spike runs on a machine with permissions already granted. First-run flow surfaces in V2.4.

**Fallback.** If the unified session prompts differently, two options. (1) Match the prompt UX to v1.0 by pre-requesting permissions via the existing utilities before constructing the session. (2) Document the new flow as a minor v2 difference; this falls under the charter's "v1.0 surface parity" criterion, so a deliberate UX change here is technically a charter violation — escalate before accepting.

**Update (2026-05-21, V2.1 spike).** **Partial data — no regression on this dev machine.** The spike's first c1 run prompted Screen Recording first (granted), then Microphone (granted) — one dialog each, sequential, matching v1.0's order. Subsequent runs prompted nothing (cached). The spike pre-requests both permissions via `CGRequestScreenCaptureAccess()` and `AVCaptureDevice.requestAccess(for: .audio)` before AVCaptureSession construction (CONTEXT D-07), so this finding is partly an artifact of the spike's chosen pre-request pattern, not the unified-session shape per se.

**Caveat.** This dev machine had v1.0 microphone permission already cached from prior `recording-engine` runs, so V2.1 does not characterize a fresh-install flow. The first-real-prompt sequence and copy under the unified path still need a clean-machine test. V2.4 carries this; severity unchanged.

**Partially realized (2026-05-27, V2.2 c3) — order verified, GUI run deferred to V2.3.** Permission *order* is code-verified: `main.swift` pre-requests `CGRequestScreenCaptureAccess()` (screen) then `AVCaptureDevice.requestAccess(for: .audio)` (mic) before `ready`; both gate `ready`, and either denial emits `PERMISSION_DENIED` + non-zero exit (D-08). That is the contract this risk cares about. The live clean-machine GUI run was deferred — against the current CLI dev build, TCC attributes screen/mic permission to the host application (the terminal/IDE running the binary), not a Zeigen app bundle, and the Screen Recording relaunch behavior (a grant not taking effect until the responsible process relaunches) is a dev-build artifact, not a property of the engine. The meaningful clean-machine test belongs against the **packaged Tauri app** (responsible process `com.zeigen.app`) in V2.3, where the relaunch behavior must be re-checked. Supersedes the V2.1 "V2.4 carries this" note above — the GUI validation moves to V2.3 packaging. Not fully closed; severity unchanged. See `docs/V2.2-REPORT.md`.

---

## Update protocol

- A spike or production finding that changes a risk's severity or fallback edits this file in the same commit as the change.
- New risks discovered during V2.1+ land here, not in some other doc.
- When V2.4 closes, mark each risk as **realized** (and what we did) or **didn't materialize** so future v3-class work can learn from the inventory.

---

*Drafted 2026-05-21 alongside `docs/V2-PHASE-PLAN.md`.*
