# Phase 1 capture API spike results

Date: 2026-04-24
Hardware: MacBook Air, macOS 26.4 (Darwin 25.4.0), 1920x1080 primary display
ffmpeg: 8.1 (Homebrew, `--enable-videotoolbox --enable-audiotoolbox`)
Swift: default (macOS 26 toolchain)

## Verdict

**Use ScreenCaptureKit for screen capture in Phase 2.** ffmpeg `-f avfoundation` screen capture is not usable on macOS 26.

## Evidence

### ffmpeg `-f avfoundation` screen input — fails

Invocation (5s smoke test, screen index 4):

```
ffmpeg -y -hide_banner -f avfoundation -framerate 30 -capture_cursor 1 \
  -i "4" -t 5 -c:v h264_videotoolbox -b:v 8M -pix_fmt nv12 out.mov
```

Output (excerpt):

```
objc[48824]: class `NSKVONotifying_AVCaptureScreenInput' not linked into application
[AVFoundation indev @ 0x764c20140] Configuration of video device failed, falling back to default.
[in#0 @ 0x765018000] Selected pixel format (yuv420p) is not supported by the input device.
```

Exit 1, **no output file produced**.

Root cause: Apple removed `AVCaptureScreenInput` on macOS 15+. It was deprecated in favor of ScreenCaptureKit and is now non-functional at runtime on macOS 26. ffmpeg builds against the SDK still reference the class but the runtime binding fails. This is a hard kill — not a configuration issue, not something bitrate or framerate settings can work around.

Device enumeration via ffmpeg `-list_devices` still works (uses a different code path), so `enumerate_devices` in `src-tauri/src/devices.rs` is unaffected.

### ScreenCaptureKit via Swift — works cleanly

Invocation: `cd docs/spike/sckit && swift run` (30s recording).

Output: `docs/spike/spike-sckit.mov` — 6.0 MB, 31.2s duration, H.264 AVC, 1920x1080, BT.709, progressive, yuv420p.

Swift tool reported: `appended frames: 556, dropped: 0`.

Notes:
- Screen Recording TCC prompt fired on first run and was accepted; subsequent runs pass silently.
- Average fps is ~17.8 (VFR container) because the screen was mostly static during the test. SCK only emits frames when content changes — a feature for file size, not a defect. Real demo content (scrolling, pointer motion) will push fps to the 30fps ceiling set by `minimumFrameInterval`.
- Output plays cleanly in QuickTime.

## Implications for Phase 2 and beyond

- **Screen capture:** SCStream with `SCContentFilter(display:…)`, encoded via AVAssetWriter H.264. The spike file `docs/spike/sckit/Sources/sckit-spike/main.swift` is the reference implementation.
- **Rust integration:** spawn a Swift helper binary as a child process, IPC via stdin/stdout commands (start / stop / status), binary writes the mp4 directly. Alternative: use the [`screencapturekit-rs`](https://crates.io/crates/screencapturekit) crate if it tracks macOS 26 APIs. Crate approach keeps Rust-only but adds a macOS-specific dependency.
- **VFR vs CFR:** SCK delivers VFR. Phase 3 composite and Phase 6 LinkedIn export may prefer CFR; normalize to 30 CFR via ffmpeg at export time (`-vsync cfr -r 30`) rather than at capture. Do not fight SCK's adaptive delivery.
- **ffmpeg still useful for:** device enumeration, mic/webcam capture (AVCaptureDevice path, different from AVCaptureScreenInput, not yet verified on macOS 26 — retest before Phase 3), filter_complex composite on stop, h264_videotoolbox encode/transcode for LinkedIn preset.
- **Don't remove ffmpeg** — the plan still needs it. What changes is the screen input.

## Files produced

- `docs/spike/spike-sckit.mov` — SCK 30s capture sample, open in QuickTime
- `docs/spike/sckit/` — reference Swift Package for SCK capture
- `docs/spike/run-ffmpeg-avfoundation.sh` — ffmpeg attempt script (kept for future reference if macOS/ffmpeg resolves this)
- (no `spike-avfoundation.mov` exists — ffmpeg produced no output)

## Phase 3 addendum: ffmpeg camera capture on macOS 26

Date: 2026-04-24

Run before Phase 3 begins to confirm ffmpeg's `-f avfoundation` camera input still works on macOS 26 even though `-f avfoundation` screen input was killed by the `AVCaptureScreenInput` removal.

Invocation:

```
ffmpeg -y -hide_banner -f avfoundation -framerate 30 \
  -i "0" -t 10 -c:v h264_videotoolbox -b:v 4M -pix_fmt nv12 \
  docs/spike/spike-camera-ffmpeg.mov
```

Result: works. 10.0s output, 4.1 MB, 300 frames, 30.10 fps, H.264 yuv420p, 3.5 Mbps. No `NSKVONotifying_*` errors. Camera capture uses `AVCaptureDevice` (not the removed `AVCaptureScreenInput`), so it's unaffected by the macOS 26 deprecation.

**Implication for Phase 3:** webcam capture via ffmpeg `-f avfoundation -i <camera_index>` is viable. No need for a second Swift helper. Continue with PLAN.md Phase 3 as written: a second ffmpeg process captures the webcam to a video-only file in `~/Movies/Zeigen/.sources/`, then the composite step on stop overlays it onto the screen file.

Notes:
- ffmpeg auto-resolves the camera's native pixel format (uyvy422 here) and converts to nv12 for `h264_videotoolbox`. No manual `-pix_fmt` gymnastics required.
- `-framerate` is honored when the camera supports it. If the requested rate isn't supported ffmpeg falls back to the default.
- Camera reports its native orientation. The MacBook Air Camera reports 1080x1920 (portrait). For Phase 3 we'll crop to a square anyway via `filter_complex`, so source orientation only matters for which side of the frame the user appears in. Test per camera before locking in defaults.

Sample file: `docs/spike/spike-camera-ffmpeg.mov`
