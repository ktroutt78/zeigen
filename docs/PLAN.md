# Zeigen Plan

Build order is sequential. Each phase must hit its acceptance criteria before the next begins. Ship local-first; cloud and LinkedIn come after recording is rock-solid.

## How to work this plan

- Complete deliverables in the order listed within each phase.
- A phase is closed only when every deliverable is implemented and the "Done when" check passes with evidence (a working recording, a playable file, a visible UI state).
- Add or keep green whatever tests are needed to prove a deliverable works. No ceremony beyond that.
- Coding standards from `CLAUDE.md` apply throughout.

## Phase 1: Tauri scaffold + device enumeration

Stand up the app shell and prove we can see all capture devices.

**Deliverables**
- Tauri + React + Vite project initialized
- Rust command that runs `ffmpeg -f avfoundation -list_devices true -i ""` and parses output into `{ video: [], audio: [], screens: [] }`
- Minimal settings screen displaying available devices
- macOS permission prompts triggered and handled on first run (Screen Recording, Camera, Mic)
- Capture API spike: record a 30-second test clip via both (a) `ffmpeg -f avfoundation` screen input and (b) a minimal ScreenCaptureKit-backed Rust/Swift helper. Compare cursor fidelity, perf on battery, HDR handling, multi-display behavior, and frame drops. Update Phase 2 in this doc with the chosen API before Phase 2 begins.

**Done when:** Launching the app lists FaceTime HD, any connected USB camera, and Continuity Camera (when iPhone is awake and nearby). Revoking a permission in System Settings surfaces a clear error on next launch. The spike is documented and Phase 2 in this doc reflects the chosen capture API.

## Phase 2: Screen-only recording to mp4

Simplest possible recording path. No webcam yet.

**Deliverables**
- Start / pause / resume / stop recording controls in the main window. Pause/resume produces a gapless output (PTS offset by total paused duration) — not a multi-segment file. Phase 4 tray icon already anticipates a `paused` state.
- **Swift helper binary** (`recording-engine`, Swift Package at `src-tauri/recording-engine/`) that owns all capture: screen via `SCStream` (ScreenCaptureKit), microphone via `AVCaptureSession`, both muxed into a single mp4 by `AVAssetWriter` (H.264 video + AAC audio). Decided in the Phase 1 spike — see `docs/spike/SPIKE-RESULTS.md`; ffmpeg avfoundation screen input is non-functional on macOS 26 because Apple removed `AVCaptureScreenInput`.
- Rust spawns the Swift helper as a long-lived child process and drives it via line-delimited JSON on stdin/stdout — protocol in `docs/IPC-SPEC.md`. Screens and microphones are enumerated via the helper's `enumerate` command (SCK/CoreAudio is the source of truth for screens; ffmpeg's `enumerate_devices` from Phase 1 stays for cameras in Phase 3).
- Recording at native display resolution, 30fps ceiling — no aspect ratio transformation at capture time (aspect changes happen only at export in Phase 6). SCK delivers variable frame rate by design; do not try to force CFR at capture. Normalize to CFR only at export time if a downstream tool needs it.
- Writes to `~/Movies/Zeigen/` as a single mp4. Filename format: `recording-YYYY-MM-DD-HHMMSS.mp4`.

**Done when:** A 2-minute screen recording produces a clean mp4 that plays in QuickTime with synced audio, no dropped frames reported by the engine, reasonable file size (will vary by content — static screens smaller due to SCK's adaptive delivery; active demos roughly 20-40MB/min at ~30fps).

## Phase 3: Webcam capture + composite on stop

Record the webcam to a separate source file during capture, then composite it onto the screen recording when the user stops. Simpler recovery than live compositing if either stream glitches.

**Deliverables**
- Second ffmpeg process capturing the selected webcam device to a **video-only** file (no audio — the webcam ffmpeg process explicitly does not capture audio; mic audio stays muxed into the screen file from Phase 2) in `~/Movies/Zeigen/.sources/`
- Stop action terminates both ffmpeg processes cleanly and kicks off a composite pass
- Composite step uses `filter_complex` to overlay the webcam (scaled, cropped to square, circular mask, positioned in the chosen corner) onto the screen file, producing the final mp4 in `~/Movies/Zeigen/`. When the webcam track is shorter than the screen track (e.g., Continuity drop mid-recording), end the webcam overlay at that point and continue with screen-only video — do not pad with black. Screen track defines final duration
- Raw source files are retained on disk until the user explicitly discards the recording from the Phase 5 review screen — do not auto-delete after composite
- Floating always-on-top Tauri window showing live `getUserMedia` webcam feed (for the user's own reference while recording)
- Settings for webcam size (small/medium/large) and corner position

**Done when:** A recording with Continuity Camera selected produces a final mp4 with the iPhone camera feed as a circular overlay in the chosen corner. Both raw source files remain on disk after the composite pass completes. Floating preview window stays visible across all Spaces and apps.

## Phase 4: Global hotkey + tray icon

Make it usable without the app window visible.

**Deliverables**
- System tray icon with Start/Stop, device picker submenu, Settings, Quit
- Tray icon reflects recording state (idle / recording / paused)
- Configurable global hotkey (default: Cmd+Shift+R) for start/stop
- Main window hidden during recording so it doesn't appear in the capture
- Start action is a no-op when a recording is already in progress — tray Start item disabled and hotkey ignored based on recording state. No modal prompts.

**Done when:** Recording can be started and stopped entirely via hotkey or tray with no app window visible. Tray icon state matches actual recording state even if the hotkey is pressed rapidly.

## Phase 5: Post-record review + trim + annotate

Review screen that opens automatically when a recording stops. New Tauri window labeled `review` (940px wide per mockup) opens on stop; main window stays hidden (per Phase 4). Separate window keeps capture and review concerns isolated and matches the eventual multi-recording flow.

**Deliverables**
- Video player with scrubber
- Trim in/out handles. Trim always re-encodes via `h264_videotoolbox` for frame accuracy — no stream-copy keyframe-snap path. Hardware encoding makes this cheap on Apple Silicon.
- Simple annotation: text labels and arrows rendered as an overlay at export time (not destructive to the source file). Annotations stored in a sidecar JSON file next to the source mp4 (`<basename>.annotations.json`). Schema: array of annotations, each with `type` (`text` | `arrow`), `start_time`, `end_time`, `position` (`x`, `y` as fractions of source-video dimensions), and `content`. New annotations default to `[playhead, playhead+3s]`; the timeline pip is draggable to adjust duration. At export time, text uses ffmpeg `drawtext`; arrows are pre-rasterized to transparent PNGs and composited via `overlay` with `enable='between(t,start,end)'`.
- "Save edits" produces `<original>-edited.mp4` alongside the source; sidecar JSON updates in place. "Discard edits" reverts trim/annotation state but keeps the source recording on disk. (Destructive delete of the recording itself is deferred.)
- Phase 6 export panel is scaffolded in the review window at full visual fidelity but disabled (opacity 0.4, `pointer-events: none`, "Coming in Phase 6" caption). Phase 6 just removes the disable.

**Done when:** A recording can be trimmed to a sub-segment, annotated with a text label and arrow, and exported to a new mp4 that plays correctly with annotations visible. The Phase 6 export panel is visible but inert.

## Phase 3.5: Recording experience polish

Numbered 3.5 because it extends Phase 3's recording UI; sequenced here because it depends on Phase 5's save pipeline.

Bundles four features and one bug fix from Phase 5 UAT. All recording-lifecycle / floating-window territory.

**Deliverables**

1. Draggable webcam bubble — free drag with corner snapping. Pre-record and during-record. Position log written to sidecar (same pattern as the annotation sidecar).
   - Schema: a new `bubble_position_log` field on the sidecar — array of `{t, x, y}` entries, where `x` and `y` are fractions [0..1] of the *recorded display's* physical frame, clamped at edges if the bubble is dragged off. Phase 5's save-pipeline reader is extended to consume it.
2. Countdown overlay before recording — full-screen, big number, single "go" sound at start. Esc cancels, Spacebar/Enter skips. Setting: 5s / 3s / Off. Not baked into the recording — SCK starts after countdown.
3. Recording timer, primary surface on the webcam bubble — small chip integrated into the bubble. Mono font. Semi-transparent dark pill background.
4. Recording timer, fallback when no webcam — standalone draggable chip when `cameraState === "none"`. Same visual treatment as the bubble timer. Bottom-right default, draggable.
5. Recording timer, secondary menu bar surface — tray icon shows elapsed time. Always present, not primary.
6. Length cap mode (opt-in) — setting: No limit / Set target. When set, timer shows `MM:SS / MM:SS`, tints orange at 80%, red at 100%. Recording continues — never auto-stops. Bubble/chip tints only; menu bar stays clean. Default: no limit.
7. Bug fix from Phase 5 UAT — floating preview captured by SCK because `alwaysOnTop`. Shared `makeCaptureInvisible(window)` utility setting `NSWindow.sharingType = .none`. Used by floating preview, countdown overlay, draggable bubble, standalone timer chip.

**Implementation order**

1. `makeCaptureInvisible()` utility + apply to the existing floating preview (closes the two-bubble bug standalone).
2. Draggable bubble (pre-record first, then during-record + position log).
3. Countdown overlay.
4. Timer — menu bar surface.
5. Timer — bubble integration.
6. Timer — standalone fallback chip.
7. Length cap + tint warnings.

**Done when:** A recording made with the bubble dragged mid-record produces a final mp4 where the bubble follows the logged path; the countdown plays before SCK starts and is not in the recording; the timer is visible on the bubble (or the standalone chip when no webcam) and on the tray icon; the length cap tints the timer at 80% / 100% without auto-stopping; the floating preview no longer appears in the captured screen.

## Phase 6: Export destinations

Four output paths from the review screen. Local save already works from Phase 2; this phase adds the other three.

**Deliverables**
- **Save locally** — already working; add "Reveal in Finder" button
- **Copy file to clipboard** — for drag-paste into Slack, Messages, email
- **Cloudflare R2 + Pages bootstrap** — none of this is provisioned yet. Create the R2 bucket with public-read access so objects are fetched directly by the viewer page (delete-to-unshare is the expected UX; no signed URLs, no expiration). Create a scoped API token with *write* access only, stored in Tauri's secure store (not source) — the token is for uploads from Rust, never for reads. Create a Cloudflare Pages project named `zeigen-share` deployed to the default `zeigen-share.pages.dev` subdomain (no custom domain). Implement the `/v/[id]` viewer route that loads the public R2 object. Short-URL scheme: 10-character nanoid as the object key.
- **Cloudflare R2 upload + share link** — upload from Rust, copy short URL to clipboard
- **LinkedIn export** — transcode to LinkedIn-optimized preset (max 10min warning, target <200MB, H.264+AAC), reveal in Finder, copy caption template to clipboard, open `linkedin.com/feed/?shareActive=true` in browser

**Done when:** Each of the four export paths produces the expected result for a 3-minute test recording. R2 link plays in an incognito browser. LinkedIn export file drags cleanly into the LinkedIn post composer.

## Phase 7: Polish pass

Only tackle after Phases 1-6 are all working end-to-end.

**Deliverables**
- Recording preset picker (16:9 default, 1:1 square, 9:16 vertical)
- Settings persistence across app restarts
- Error surface for common failures (device disappeared mid-record, disk full, permission revoked)
- App icon, DMG installer via `tauri build`

**Done when:** Zeigen can be installed fresh on another Mac from the DMG, recorded with for a real demo, and shared to LinkedIn and R2 without touching the terminal.

## Deferred / out of scope

- Real-time annotation during recording
- Multi-monitor capture selection (assume primary display)
- Windows and Linux builds
- Auto-transcription, chapters, captions
- Direct LinkedIn API posting (not possible for personal profiles)
- A/V sync drift (surfaced in Phase 5 UAT) — separate follow-up, own diagnosis pass needed
