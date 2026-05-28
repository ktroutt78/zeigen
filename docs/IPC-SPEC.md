# Recording engine IPC protocol

The Swift helper binary (`recording-engine`) captures the screen via ScreenCaptureKit and the microphone via AVCaptureSession, muxing both into a single mp4 via AVAssetWriter. Rust controls it as a long-lived child process via line-delimited JSON over stdin/stdout.

## Channels

- **stdin** — commands from Rust, one JSON object per line
- **stdout** — events from the engine, one JSON object per line
- **stderr** — free-form log lines (captured by Rust for debugging, not parsed)

## Process lifecycle

1. Rust spawns the engine binary.
2. Engine emits `ready` on stdout when it is prepared to accept commands.
3. Rust sends commands as needed.
4. Engine responds with events. Commands are processed serially — do not pipeline.
5. Rust sends `quit` (or closes stdin) to shut the engine down cleanly.
6. If the engine hits an unrecoverable error mid-recording, it emits `error` then exits.

## Commands (Rust → engine)

### `enumerate`
List available screens and microphones.
```json
{"command": "enumerate"}
```
Response: `enumerated` event.

### `start`
Begin a recording.
```json
{
  "command": "start",
  "display_id": 1,
  "microphone_uid": "BuiltInMicrophoneDevice",
  "output_path": "/Users/you/Movies/Zeigen/recording-2026-04-24-110000.mp4",
  "max_fps": 30
}
```
Fields:
- `display_id` (uint) — `CGDirectDisplayID`, returned by `enumerated`. Mutually exclusive with `window_id`; exactly one is required. Required (alongside `area_*`) for area capture.
- `window_id` (uint) — `CGWindowID`, returned by `enumerated`. Captures only that window's content (occluding windows are invisible in the recording). Mutually exclusive with `display_id`.
- `microphone_uid` (string) — CoreAudio device UID, returned by `enumerated`. Pass `null` to record silent video (no mic).
- `output_path` (string) — absolute path; parent directory must already exist.
- `max_fps` (uint, optional) — frame rate ceiling. Default 30. SCK delivers VFR; this is the max, not the guaranteed rate.
- `area_x`, `area_y`, `area_width`, `area_height` (float, optional) — sub-region of the display to capture. All four must be present together alongside `display_id`; partial sets are rejected. Units are logical points relative to the display's top-left origin. When present, SCK is configured via `SCStreamConfiguration.sourceRect` and the output mp4's pixel dimensions are `area_width × scale` by `area_height × scale` where `scale = SCDisplay.width / SCDisplay.frame.width` for the chosen display. Forbidden with `window_id`.

For window captures the engine sizes the output to native pixels (window's point size × the containing display's scale factor) and fixes that resolution for the lifetime of the recording. Resizing the window mid-record is allowed but the resized content gets letterboxed/padded inside the original frame.

For area captures the recorded region is fixed at start; the captured sub-region cannot be moved or resized mid-record. Output dimensions match the requested area in logical points scaled to display pixels (same scale factor used for window mode).

Response: `started` event, then periodic `progress` events, then `stopped` (after `stop`) or `error`.

### `pause`
Suspend the current recording without finalizing the file. SCK and AVCaptureSession keep running; the engine stops appending sample buffers to `AVAssetWriter` and records the pause timestamp. `progress` events stop. Only valid while recording.
```json
{"command": "pause"}
```
Response: `paused` event.

### `resume`
Resume a paused recording. The engine resumes appending sample buffers to `AVAssetWriter` with their PTS offset by the total paused duration so the output timeline is gapless. `progress` events resume. Only valid while paused.
```json
{"command": "resume"}
```
Response: `resumed` event.

### `stop`
Finalize the current recording. Engine calls `AVAssetWriter.finishWriting()` before responding. Valid from both recording and paused states.
```json
{"command": "stop"}
```
Response: `stopped` event.

### `quit`
Shut down the engine cleanly. Engine exits after replying or immediately if no recording is in progress.
```json
{"command": "quit"}
```
No event response — the process terminates. Rust should also tolerate stdin close as a quit signal.

## Events (engine → Rust)

### `ready`
Emitted once on startup, before any commands are processed.
```json
{"event": "ready", "version": "0.1.0"}
```

### `enumerated`
```json
{
  "event": "enumerated",
  "displays": [
    {"id": 1, "name": "Built-in Retina Display", "x": 0, "y": 0, "width": 2560, "height": 1664}
  ],
  "microphones": [
    {"uid": "BuiltInMicrophoneDevice", "name": "MacBook Air Microphone"}
  ],
  "windows": [
    {
      "id": 4231,
      "app": "Safari",
      "bundle_id": "com.apple.Safari",
      "title": "Zeigen — github.com",
      "x": 240, "y": 120,
      "width": 1440, "height": 900,
      "on_screen": true
    }
  ]
}
```

The `windows` array lists windows the user could plausibly capture. Filters applied by the engine:
- Owned by an application (system surfaces excluded)
- Not owned by Zeigen itself (`com.zeigen.app`)
- `windowLayer == 0` (normal app windows; menubar items, tooltips, popups excluded)
- `width >= 100 && height >= 100` (skips 0-size phantom windows)

`bundle_id` is omitted when SCK reports no bundle for the owning application. UI sorts and labels — the engine returns SCK's order. `on_screen: false` means the window exists but isn't visible (minimized, in another Space, behind a fullscreen app); UI may still offer it but identify-window won't render an overlay on it.

### `started`
```json
{"event": "started", "started_at": "2026-04-24T21:00:00Z"}
```

### `progress`
Emitted every 1 second while recording. Not emitted while paused. `elapsed_s` is the gapless output-timeline duration (paused time excluded).
```json
{
  "event": "progress",
  "frames": 300,
  "dropped": 0,
  "elapsed_s": 10.0
}
```

### `paused`
```json
{"event": "paused", "elapsed_s": 42.3}
```

### `resumed`
```json
{"event": "resumed", "elapsed_s": 42.3}
```

### `stopped`
Emitted after `stop` completes.
```json
{
  "event": "stopped",
  "output_path": "/Users/you/Movies/Zeigen/recording-2026-04-24-110000.mp4",
  "duration_s": 120.3,
  "bytes": 12345678,
  "frames": 3600,
  "dropped": 0
}
```

### `window_frame`
Only emitted while a `window`-mode recording is active. 5Hz cadence (200ms). Reports the captured window's current `CGWindowListCopyWindowInfo` bounds so the consumer can map screen-space coordinates (e.g., the floating bubble) into window-relative fractions even as the user moves or resizes the window mid-record. `on_screen: false` means the window has been minimized, hidden, or moved to a Space the engine isn't observing — frame values are still the last-known bounds.
```json
{"event": "window_frame", "x": 240, "y": 120, "width": 1440, "height": 900, "on_screen": true}
```

### `error`
```json
{"event": "error", "code": "PERMISSION_DENIED", "message": "Screen Recording permission not granted"}
```
Codes:
- `PERMISSION_DENIED` — Screen Recording or Microphone permission not granted
- `DISPLAY_NOT_FOUND` — `display_id` not present in current enumeration
- `WINDOW_NOT_FOUND` — `window_id` not present in current enumeration
- `MIC_NOT_FOUND` — `microphone_uid` not present in current enumeration
- `OUTPUT_PATH_INVALID` — parent dir missing, not writable, or path exists and can't be overwritten
- `WRITER_FAILED` — AVAssetWriter failed to start or finalize
- `MIC_NO_FIRST_SAMPLE` — AVCaptureSession produced no audio sample within 250ms of the first video sample; engine tears down the recording and stays running
- `CLOCK_MISMATCH` — on `start`, host-clock parity check failed after streams started; recording does not begin, engine stays running
- `MIC_SESSION_FAILED` — AVCaptureSession reported a runtime error mid-recording; engine finalizes whatever was written and returns to idle
- `INVALID_COMMAND` — malformed JSON or unknown command; engine stays running
- `INVALID_STATE` — command is not valid from the current state (e.g., `pause` when idle, `resume` when recording, `start` when already recording, `pause` before writer-start has anchored the muxed timeline); engine stays running
- `INTERNAL` — anything else; engine exits after emitting this

## State machine

```
idle  --start-->  recording  --pause-->  paused
                  ^                      |
                  |<------- resume ------|
                  |
recording, paused --stop--> idle (with `stopped` event)
```

All states accept `enumerate` and `quit`.

## Device ownership

Two enumeration paths exist in Zeigen, by device type:

| Device type   | Authoritative enumerator                    | Source of truth                             |
|---------------|---------------------------------------------|---------------------------------------------|
| Screens       | Swift helper `enumerate`                    | `SCShareableContent.displays` (SCK)         |
| Microphones   | Swift helper `enumerate`                    | `AVCaptureDevice.devices(for: .audio)`      |
| Cameras       | Rust `enumerate_devices` (ffmpeg, Phase 3)  | `ffmpeg -f avfoundation -list_devices true` |

The React settings screen **must** display microphones only from the Swift helper's `enumerate` response — never from the Rust ffmpeg path — to avoid double-listing and ensure the mic identifier the user selects is the same UID the helper will accept in `start`.

Naming consistency: both enumerators ultimately read from AVFoundation, so the same physical mic should surface with the same display name on both paths. Continuity and virtual devices are edge cases — the Swift helper is always authoritative.

## Binary layout
- Source: `src-tauri/recording-engine/` (Swift Package Manager)
- Built binary (dev): `src-tauri/recording-engine/.build/debug/recording-engine`
- Built binary (release, Phase 7 bundling concern): copied into the .app's Resources directory
- Rust spawns by absolute path; if the binary is missing, Rust surfaces a clear error at startup

## Conventions
- All times UTC ISO-8601.
- All durations in seconds (floats).
- All sizes in bytes (uints).
- Newline is `\n`; no trailing whitespace on lines.
- No JSON pretty-printing in messages — one line per message, compact.
