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

---

## R2. AAC priming residual may persist if encoder unchanged

**What could go wrong.** Phase 13 measured ~43ms of AAC encoder priming on saved MP4s. Unified capture fixes the *source* clock, but the *encoder* may still introduce priming silence at the start of the audio track. If the encoder is unchanged between v1.0 and v2 (same AVAssetWriter + same AAC settings), the priming gap likely persists. V−A drift fix doesn't imply audio-start fix.

**Severity:** **Medium.** Doesn't block V2.4 — the charter says "verify whether the ~43ms AAC priming residual persists or is fixed (don't assume)." Either outcome is acceptable as long as we measure and document.

**Spike coverage.** V2.1 partially — the spike produces MP4s we can `ffprobe` for audio `start_time`. Full characterization lands in V2.4.

**Fallback.** If priming persists: document it as a known v2 limitation matching v1.0 behavior. No production change. If a future phase wants to fix it, options are (a) audio-track edit list / `priming_info` atom written via the muxer, (b) silence-trim post-encode, (c) different encoder. If priming is fixed in v2 (residual disappears), that's the v2 win — note it in the v2.0 release notes.

---

## R3. IPC contract cascade into Rust side

**What could go wrong.** Unified capture forces a change to the Swift engine's payload shape (e.g. new field, removed field, renamed event), which cascades into Rust IPC handlers (`src-tauri/src/`), TS event listeners (`src/App.tsx`, `src/Review.tsx`), and `docs/IPC-SPEC.md`. The charter says IPC changes are in-scope only if "forced" — risk is that "forced" gets stretched into "convenient."

**Severity:** **Medium.** Mitigations are organizational, not technical.

**Spike coverage.** V2.1 does not touch IPC — the spike is a standalone Swift binary. IPC cascade risk surfaces in V2.2 / V2.3.

**Fallback.** Hard rule per the charter: IPC contract changes only on a forcing function. If a v2.2 plan suggests an IPC change, the plan must name the specific unified-capture constraint that forces it. "Cleaner shape" or "while we're here" are not forcing functions. If an IPC change does land, `docs/IPC-SPEC.md` updates in the same commit.

---

## R4. Mic hot-swap behavior differences

**What could go wrong.** v1.0's separate mic AVCaptureSession is independent from screen capture; mic plug/unplug (USB, Continuity drop, iPhone sleep) doesn't tear down screen capture. In a unified session, a mic device disappearing mid-record may interrupt the entire session including screen — losing the recording instead of just losing audio. Continuity Camera drop is already in CLAUDE.md as a known gotcha.

**Severity:** **Medium.** Real-world user-facing regression if it materializes. Edge case but a known-recurring one (Continuity is unreliable).

**Spike coverage.** V2.1 does not exercise hot-swap (deliberately — V2.1 is the unified-clock hypothesis, not robustness). Surfaces in V2.4 if at all.

**Fallback.** Two directions. (1) If the unified session can be configured to keep running on mic-input failure, that's the fix. (2) If not, fall back to v1.0's architecture (separate mic session) and accept the V−A drift as the tradeoff. Choice depends on what V2.4 measurements show — if drift fix is large and hot-swap loss is rare, take the unified path with the hot-swap regression documented.

---

## R5. Multi-display edge cases

**What could go wrong.** Phase 7, Phase 14 c1, and DECISIONS.md 2026-04-26 are full of multi-display footguns: negative-x coordinates for screens left of primary, DisplayLink screens with NSWindow.setFrame placement failures, half-size landings on non-primary displays. Unified capture's screen-input path may have its own analogues we haven't characterized.

**Severity:** **Medium.** v1.0's multi-display behavior is hard-won — Phase 14 c1 was its own commit on the bubble-placement bug. Regressions here would be visible immediately.

**Spike coverage.** V2.1 criterion (b) — "Works on primary + at least one external display." Tests basic recording but not the bubble/countdown/identify placements (those are UI, out of scope for the spike).

**Fallback.** UI placements (bubble, countdown, identify) already use `set_window_frame_cg` per Phase 7 / Phase 14 c1 — they don't depend on the capture engine, so they're invariant under v2. The risk is purely about whether the *recording* (the SCK-equivalent path) handles all displays the same way. If it doesn't, V2.4 catches it and we either fix or roll back.

---

## R6. Permission flow differences (screen + mic at session creation)

**What could go wrong.** v1.0 requests Screen Recording, Camera, and Mic permissions independently. Unified `AVCaptureSession` with screen + mic inputs may require both permissions at session creation; if either is denied, the session fails before recording starts. The user-facing permission prompt sequence may also change — new dialogs, different timing, or all-at-once vs incremental.

**Severity:** **Medium.** First-run experience regression. The user has long since granted permissions on their dev machine so this won't surface in daily use; surfaces only on a fresh install or after a permission reset.

**Spike coverage.** V2.1 does not — the spike runs on a machine with permissions already granted. First-run flow surfaces in V2.4.

**Fallback.** If the unified session prompts differently, two options. (1) Match the prompt UX to v1.0 by pre-requesting permissions via the existing utilities before constructing the session. (2) Document the new flow as a minor v2 difference; this falls under the charter's "v1.0 surface parity" criterion, so a deliberate UX change here is technically a charter violation — escalate before accepting.

---

## Update protocol

- A spike or production finding that changes a risk's severity or fallback edits this file in the same commit as the change.
- New risks discovered during V2.1+ land here, not in some other doc.
- When V2.4 closes, mark each risk as **realized** (and what we did) or **didn't materialize** so future v3-class work can learn from the inventory.

---

*Drafted 2026-05-21 alongside `docs/V2-PHASE-PLAN.md`.*
