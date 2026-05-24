# V2.2 drift harness

Drives the `recording-engine` binary via stdin/stdout JSON IPC (see
`docs/IPC-SPEC.md`) and measures V−A drift per take with ffprobe.

Lifetime: V2.2 c1 builds it; V2.4 reuses it for the parity-gate
verification matrix. Lives at top-level `harness/` (not under
`spikes/`) per `docs/V2-CHARTER.md` §"Branch hygiene".

## Usage

```
python3 harness/v2-drift/run.py [--engine PATH] [--takes N]
                                [--duration SECONDS]
                                [--displays primary,external]
```

Defaults: 10 takes × 30s, alternating primary + external displays,
engine binary at `src-tauri/recording-engine/.build/release/recording-engine`.

If the engine binary is missing, the harness runs `swift build -c release`
in the engine directory before starting.

## Requirements

- Python 3 (stdlib only — no pip install)
- `ffprobe` on `PATH`
- macOS Screen Recording + Microphone permissions granted to the
  process running the harness (Terminal/iTerm for dev runs)

## Outputs

`output/` is gitignored except `.gitkeep`. Per-run:

- `take-<label>-NN.mp4` — one MP4 per take
- `results.csv` — per-take measurements
  (`display, take, wall_clock_s, video_dur_s, audio_start_s, audio_dur_s, abs_drift_ms, exit_code, output_path`)
- `meta.csv` — host metadata (macOS version, SDK, repo commit, mic UID, displays)

## Display selection

Default `--displays primary,external` alternates per take: takes
1,3,5,7,9 on primary; 2,4,6,8,10 on external. Primary is picked as
the display at origin `(0,0)` (or `displays[0]` as fallback).

If only one display is enumerated, all takes run on it and that is
recorded in `meta.csv`.

## What the harness does NOT do

- It does not enforce a drift bar. The bar (`abs_drift_ms < 100ms` for
  V2.2 c2 per `docs/V2.2-CONTEXT.md` D-11) is evaluated by reading
  `results.csv` after the run.
- It does not start/stop multiple engine processes. One engine
  subprocess per harness invocation drives all 10 takes (matches
  production daily-use shape: one engine per UI session).
