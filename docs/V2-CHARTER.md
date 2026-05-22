# V2 Charter — Capture Engine

**Branched:** 2026-05-21 from `v1.0` (`2484bb9`)
**Status:** Active

The v1.0 capture path uses ScreenCaptureKit for screen + a separate AVCaptureSession for mic, muxed by AVAssetWriter. The two sources don't share a master clock; the last mic CMSampleBuffer reaches the writer before the last video frame, so the audio track is shorter than the video track. Phase 12 c2 / Phase 13 measured V−A drift up to 644ms. Phase 13 worked around it visually (waveform rescale using S = audio `start_time`); the file itself still ships with mismatched track lengths.

v2 replaces the dual-source path with a single AVCaptureSession driving screen + mic against a shared master clock. The goal is to eliminate the drift at the source instead of compensating downstream.

## In-scope

- Capture engine — Swift binary at `src-tauri/recording-engine/`.
- IPC contract (`docs/IPC-SPEC.md`) — only if unified capture forces a shape change. Default is to keep the existing protocol.

## Out-of-scope (hard line)

- UI changes of any kind — picker, bubble, countdown, identify overlays, review window, export panel. Untouched.
- New features — no "while we're here" additions, no scope creep from real-world UAT findings.
- Adjacent refactors — file moves, naming cleanup, dependency upgrades not directly required by unified capture.
- Save / edit pipeline (`src-tauri/src/edit.rs`, save_recording) — untouched. The save side already handles whatever the engine writes; if v2 writes the same MP4 shape, save is invariant.
- Backlog items unrelated to the V−A drift fix.

If a v2 phase produces a change that touches anything in this list, that change is wrong or out of scope — escalate before committing.

## Daily-use guarantee

`main` keeps shipping throughout v2 work. `v1.0` is the daily driver. No v2 → main merge until:

1. Every parity criterion in the V2.4 done-definition passes.
2. Explicit user signoff after end-to-end UAT.

If `main` ships a bug fix or backlog item during v2 work, it lands on `main` and gets forward-merged into `capture-engine-v2`.

## Forward-merge cadence

`main` → `capture-engine-v2` at the **start of every v2 phase** — not "periodically", not "when things look stale." Pin to phase boundaries so the merge cost is predictable and the v2 branch never falls more than one phase behind main.

The merge runs before any v2 phase planning so the phase plan reflects current `main` reality.

## Done definition (parity gate)

v2 is done when ALL of the following hold simultaneously:

- **V−A drift < 1 video frame** (at 30fps, that's ~33ms; at 60fps, ~17ms) across **10+ consecutive recordings** under varied conditions (different displays, different mics, different recording lengths).
- **Every v1.0 user-facing surface works identically.** The reference is the v1.0 UAT path — open the picker, pick a display, record, review, save, export. Same behavior, same outputs, same edge cases.
- **AAC priming residual** — verify whether the ~43ms encoder priming gap persists or is fixed by the unified clock path. Don't assume either way; measure.

Anything less is not done. Partial fixes don't merge.

## Branch hygiene

- All v2 work lands on `capture-engine-v2`.
- Spikes live under `spikes/` and can be deleted post-merge — they are not load-bearing for the v2 cutover.
- Same gray-area-first discipline as Phase 10-14: surface the open questions in CONTEXT before drafting a PLAN.

---

*Branched from v1.0 (2484bb9), 2026-05-21*
