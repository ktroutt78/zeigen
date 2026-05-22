# V2 Phase Plan

**Drafted:** 2026-05-21
**Status:** Draft — V2.1 and V2.4 fully specified, V2.2 + V2.3 sketched only.
**Source of truth for scope:** `docs/V2-CHARTER.md`

V2.2's detail is deliberately deferred until the V2.1 spike returns measurements. The hard parts of unified capture are not knowable in advance — productionizing a thing that doesn't work yet is wasted planning. V2.4 is fully specified because the parity gate is fixed by the charter regardless of how V2.2/V2.3 shake out.

Same gray-area-first discipline as Phase 10-14: surface open questions in CONTEXT before drafting PLAN. Forward-merge `main` → `capture-engine-v2` at the start of every phase.

---

## V2.1 — Unified-capture spike

**Status:** Fully specified. Next action.

Validate the unified-AVCaptureSession hypothesis in isolation before touching production code. If the hypothesis is wrong, V2.2-V2.4 don't exist in their current shape.

### Location

Standalone Swift project under `spikes/v2-unified-capture/`. Self-contained — its own Package.swift / Xcode project, its own build output. Does not import or modify anything under `src-tauri/recording-engine/`. Can be deleted wholesale post-merge without affecting v2 production code.

### Scope

A Swift command-line tool that:

- Creates a single `AVCaptureSession` with both screen input (via the platform's unified screen-capture path — `AVCaptureScreenInput` is gone on macOS 26, so the spike validates whatever the modern equivalent is) and mic input (`AVCaptureDeviceInput` for the user's selected mic).
- Configures both inputs to share the session's master clock (`session.masterClock`).
- Muxes through a single `AVAssetWriter` to an MP4.
- Records for 30 seconds, then exits cleanly.
- No UI, no picker — display ID and mic UID are CLI args.
- Records to `spikes/v2-unified-capture/output/*.mp4` (gitignored). Add `spikes/*/output/` to `.gitignore` in the same commit.

Nothing else. No webcam, no compositing, no save/edit, no IPC.

### Pass criteria (all must hold — single failure = no-go)

a) **V−A drift < 17ms** across **5 consecutive 30s recordings** measured via the Phase 13 method (`ffprobe -select_streams a:0 -show_entries stream=start_time,duration` vs video duration). 17ms = single frame at 60fps; tighter than the charter's per-frame done-definition because V2.1 is a spike, not the final cutover.

b) **Works on primary + at least one external display.** Spike runs against both — exercises multi-display path that Phase 7 / Phase 14 c1 already proved is its own class of bug.

c) **Works with the mic currently in use** — whatever's on the user's machine when the spike runs. Continuity / USB / built-in coverage isn't a V2.1 concern; V2.4 widens that.

Failure = the unified-clock hypothesis is falsified. Stop and revisit before V2.2. Do not refactor production code on a falsified hypothesis.

### Deliverable

`spikes/v2-unified-capture/SPIKE-REPORT.md` containing:

- The 5 V−A measurements per criterion (a), as a table.
- Display IDs and mic UID used.
- Wall-clock recording length per take (sanity check).
- macOS version + ScreenCaptureKit / AVFoundation framework versions in play.
- Any surprises discovered during spike construction (these become V2-RISKS.md updates).
- **Go/no-go verdict** — a single line. The spike either falsifies or supports the hypothesis; "maybe" is not a valid outcome.

---

## V2.2 — Productionize unified capture (sketch)

**Status:** Sketch only — detail deferred until V2.1 reports.

Rebuild `src-tauri/recording-engine/` around the V2.1-validated approach. Keep the existing IPC contract (`docs/IPC-SPEC.md`) unless V2.1 surfaces a forcing function. Webcam capture (currently ffmpeg `-f avfoundation` per CLAUDE.md, Phase 3) stays in its own subprocess — V2 is about screen + mic clock parity, not webcam.

Real decisions land here only after V2.1's SPIKE-REPORT.md exists.

---

## V2.3 — Integration (sketch)

**Status:** Sketch only — detail deferred until V2.2 reports.

Wire the V2.2 engine into Tauri. Verify the IPC contract still holds end-to-end. Webcam compositing, scratch lifecycle, sidecar, save pipeline all continue to operate against the same MP4 shape as v1.0.

---

## V2.4 — Parity gate + cutover

**Status:** Fully specified. The done-definition from the charter, made executable.

### Scope

End-to-end verification that v2 is indistinguishable from v1.0 in every user-facing way, except that V−A drift is gone.

### Verification matrix

**1. V−A drift across 10+ recordings.** Per the charter's done-definition. Varied conditions:

- At least 2 different displays (primary + external).
- At least 2 different mics (built-in + USB or Continuity).
- A spread of recording lengths (short ≤30s, medium ~2min, long ~5min+).
- Measured via `ffprobe -select_streams a:0 -show_entries stream=start_time,duration` per take.

Acceptance: every take's `|V − A_duration|` < 17ms (sub-frame at 60fps). Use absolute value — leading drift counts too, even though v1.0 only exhibited trailing.

**2. AAC priming residual.** Phase 13 noted ~43ms encoder priming. Measure on v2 output. Two outcomes:

- Fixed → record as a v2 win, no further action.
- Persists → known limitation, document in the SPIKE-REPORT or a V2.4 addendum; not a blocker if it's bounded and identical to v1.0.

Do not assume either outcome.

**3. v1.0 surface parity.** Walk every v1.0 UAT path:

- Picker enumerates displays + windows + areas + cameras + mics correctly.
- Display recording, window recording, area recording all produce MP4s.
- Continuity Camera in/out works (CLAUDE.md known gotcha — Continuity drop + re-enumerate).
- Webcam bubble appears on the picker target (Phase 14 c1 regression sentinel).
- Countdown overlay lands correctly on non-primary displays (Phase 3.5 / Phase 7).
- Identify overlays land correctly (Phase 7).
- Global hotkey + tray icon work.
- Pause / resume preserves continuity.
- Review window opens with thumb sprite, waveform, scrub preview, audio-meta probe (Phase 13 c3), NR preview (Phase 14 c2).
- Save produces an MP4 in `~/Movies/Zeigen/` with NR applied (Phase 12 c3).
- GIF export, clipboard copy, LinkedIn export all work.
- Scratch lifecycle: discard removes dir, save replaces it (Phase 5.5).

Any divergence is a v2 bug, not a "v1.0 baseline issue." Fix or roll back.

**4. Performance parity.** Subjective but tracked:

- Recording start latency (hotkey press → red dot).
- Stop latency (stop → review window opens).
- CPU + memory during a 5min recording.

No formal threshold; flag regressions worse than ~25% as v2 bugs.

### Cutover

After all four pass and the user signs off:

- Forward-merge `main` → `capture-engine-v2` one final time.
- Merge `capture-engine-v2` → `main`.
- Tag `v2.0` on the merge commit.
- Delete `spikes/v2-unified-capture/` (it was a research artifact; the production code is in `src-tauri/recording-engine/`).
- Mark V2 charter complete.

If any pass fails, V2.4 doesn't merge. Iterate or roll back.

---

*Drafted 2026-05-21 from `v1.0` baseline.*
