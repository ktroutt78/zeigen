# Phase 1 capture API spike

Goal: decide between `ffmpeg -f avfoundation` and ScreenCaptureKit for Phase 2 screen capture. Record a 30-second clip with each, compare.

## Running

Both require **Screen Recording permission**. First run will prompt in System Settings. You may need to re-launch after granting.

```bash
# ffmpeg path
docs/spike/run-ffmpeg-avfoundation.sh

# ScreenCaptureKit path
cd docs/spike/sckit && swift run
```

Samples land in `docs/spike/samples/`.

## Metrics to compare

For each sample:
- File size and duration (should be ~30s)
- Frame drops reported by the tool
- Cursor visible and at the right position
- Playback in QuickTime: smooth, no tearing, correct colors
- Wall-clock overhead (how long did the 30s recording actually take)
- Battery impact (ballpark — run on battery, check % before/after)
- HDR/SDR handling on an HDR-capable display
- Multi-display behavior (what gets captured when multiple displays are connected)

## Decision

Update `docs/PLAN.md` Phase 2 with the winning API before Phase 2 begins.
