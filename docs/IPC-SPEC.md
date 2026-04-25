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
- `display_id` (uint) — `CGDirectDisplayID`, returned by `enumerated`.
- `microphone_uid` (string) — CoreAudio device UID, returned by `enumerated`. Pass `null` to record silent video (no mic).
- `output_path` (string) — absolute path; parent directory must already exist.
- `max_fps` (uint, optional) — frame rate ceiling. Default 30. SCK delivers VFR; this is the max, not the guaranteed rate.

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
    {"id": 1, "name": "Built-in Retina Display", "width": 2560, "height": 1664}
  ],
  "microphones": [
    {"uid": "BuiltInMicrophoneDevice", "name": "MacBook Air Microphone"}
  ]
}
```

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

### `error`
```json
{"event": "error", "code": "PERMISSION_DENIED", "message": "Screen Recording permission not granted"}
```
Codes:
- `PERMISSION_DENIED` — Screen Recording or Microphone permission not granted
- `DISPLAY_NOT_FOUND` — `display_id` not present in current enumeration
- `MIC_NOT_FOUND` — `microphone_uid` not present in current enumeration
- `OUTPUT_PATH_INVALID` — parent dir missing, not writable, or path exists and can't be overwritten
- `WRITER_FAILED` — AVAssetWriter failed to start or finalize
- `INVALID_COMMAND` — malformed JSON or unknown command; engine stays running
- `INVALID_STATE` — command is not valid from the current state (e.g., `pause` when idle, `resume` when recording, `start` when already recording); engine stays running
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
