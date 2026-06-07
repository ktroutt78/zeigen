# Resume — Phase 15 close-out (2026-06-07)

## Status: Phase 15 COMPLETE on `capture-engine-v2`

12 commits, `17f9a2f` → `0d753f2`. Shipped: deferred composite to export (stop→preview is instant on long recordings), dual-stream review player (screen + webcam as separate `<video>` elements with CSS bubble), #4 bubble first-frame anchor fix (engine emits `first_frame` for screen, finalize shifts bubble_position_log entries to align with screen.mp4 PTS=0 — replaces the visible "pulled by a string" lag). c2 byte-stability assertion removed (intentionally divergent from Phase 14 post-fix).

## Open backlog (all sub-shippable, all noted in `docs/PLAN.md`)

- **#5 — Preview-only ~20ms mouth lag** from webcam `play()` startup latency. Stable `drift_ms ≈ -22` post-c3. Saved file unaffected. User accepted as sub-perceptible.
- **Intermittent webcam-vs-mic-audio regression** on capture-engine-v2 history (was good → broke → good). Reproducible cause unknown. **Bisect against a clap-test recording** if it recurs — we have the measurement method now.
- **Fast-drag bubble-position flicker** — bubble_position_event samples at ~10Hz during drag (the dedupe at `lib.rs:362` allows entries every 250ms). Fast cursor sweeps produce sparse keyframes; rAF interpolates linearly between them, so very fast drags look stepped between sparse samples even though rendering is smooth.

## Branch state in the V2 plan

`capture-engine-v2` is daily-driver-ready. Ahead before merge to `main`:

- **V2.3** — integration cleanup (process-lifecycle items inherited from v1.0 per `docs/PLAN.md`: BACKLOG-V2.3-1 webcam ffmpeg orphan, -2 scratch sweeper, -3 harness run-provenance).
- **V2.4** — parity gate + cutover to main.
