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

## Phase 3.5: Recording experience polish — **Complete (2026-04-25)**

All seven deliverables shipped; UAT closed (countdown sizing, bubble ghosting, bubble lifecycle, control pill below bubble, mirror flip, black first frame in review, length cap tints).

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

## Phase 5.5: Scratch-and-commit save model — **Complete (2026-04-26)**

All seven deliverables shipped across five atomic commits; UAT closed (scratch routing, commit/discard backends, footer button overhaul, close-prompt always fires until commit, Record another auto-start). One UAT fix commit between steps 2 and 3 covered the asset-protocol scope for `.scratch/`, the first-frame paint via muted play+pause prime, and the post-commit toast refresh.

Numbered 5.5 because it corrects the Phase 5 save pipeline; sequenced after Phase 3.5 and before Phase 6 so the export panel inherits the corrected commit semantics.

Phase 5 finalized recordings directly to `~/Movies/Zeigen/recording-….mp4`. That auto-saves every recording, including throwaway test takes, and only offers a non-destructive "Discard edits" in review. Comparable tools (Loom, CleanShot X, QuickTime, ScreenFlow) all hold the recording in scratch state until the user explicitly commits. Phase 5.5 aligns Zeigen with that mental model.

**Deliverables**

1. Recording-finalize writes the composited mp4 to a scratch path under `~/Movies/Zeigen/.scratch/<id>/` (not the final path). The sidecar JSON (and bubble position log) lives alongside the scratch mp4.
2. The review window opens against the scratch file. All trim/annotation work happens there.
3. Explicit **"Save recording"** button in the review footer moves the scratch mp4 to `~/Movies/Zeigen/recording-….mp4` and applies pending edits at move time. The sidecar moves with it.
4. Explicit **"Discard recording"** button deletes the scratch directory in full (mp4 + sidecar + raw source files). Asks for confirmation.
5. Closing the review window with unsaved state prompts: **Save / Discard / Cancel.** Default button is **Discard** (matches the destructive-modal-default decision in DECISIONS.md, 2026-04-25).
6. **"Record another"** button in the review window. If state is unsaved, fires the same Save/Discard/Cancel prompt against the current recording first; on Save or Discard, then opens the capture window for a fresh recording.
7. Closing the review window always restores the capture (main) window — never leaves the user with no visible app surface. Tray icon stays present regardless.

**Implementation order**

1. Scratch path layout + finalize routes the composite output to scratch.
2. Review window opens against the scratch path; existing edit pipeline operates unchanged on scratch input.
3. Save action (move scratch → final + apply edits in one pass).
4. Discard action (delete scratch directory).
5. Close-with-unsaved-state prompt (3-button dialog, Discard default).
6. Record-another button + capture-window restoration on review close.

**Done when:** A new recording lands in `.scratch/`, not in `~/Movies/Zeigen/`. Closing the review window with no Save click leaves nothing in `~/Movies/Zeigen/`. Clicking Save produces the expected `recording-….mp4` and removes the scratch dir. Clicking Discard removes the scratch dir and produces nothing in `~/Movies/Zeigen/`. The Record-another flow works end-to-end without leaving stranded windows.

## Phase 6: Export destinations — **Complete (2026-04-26)**

Three destinations shipped (Save locally + Reveal, Copy to Clipboard, Export for LinkedIn). Hosted Cloudflare R2 + Pages share-link path was deliberately dropped mid-phase — see DECISIONS.md 2026-04-26 entry. Zeigen is positioned as a local recording tool with smart export paths, not a hosted sharing service.

The original commit plan was reshaped twice during build:
1. First, by the product decision to drop hosted sharing (R2/Pages/credentials/SigV4 — none of it ships).
2. Second, by an architecture revision adopting iPhone screenshot semantics for the review window: explicit Save = keep, anything else = throw away. The Phase 5.5 close-prompt was removed (later partially restored, scoped to the title-bar X on uncommitted recordings only). Copy and LinkedIn became independent destinations that produce temp/separate files without committing the source.

**What shipped**
- Footer "Save recording" stays open after commit; right side splits into a "Saved" status and a Reveal-in-Finder button.
- Footer "Discard recording" — instant cleanup, no confirm modal.
- "Record another" — same iPhone-screenshot cleanup, then emits to main, then closes.
- Close window (red X): silent if committed; Save/Discard/Cancel modal if uncommitted.
- Copy to Clipboard row — copies source mp4 to `~/Library/Caches/com.zeigen.app/exports/recording-<stamp>/` and points NSPasteboard at the temp copy. Transient "Copied" indicator. ⌘C shortcut wired (skips when text is selected or input is focused).
- Export for LinkedIn row — transcodes via h264_videotoolbox (high profile, yuv420p, +faststart, AAC 128k, scale-cap 1080p, bitrate solved per-duration to keep file under 200 MB). Output goes to `~/Movies/Zeigen/recording-<stamp>-linkedin.mp4` (persists across all cleanup events). Caption template lands on the clipboard, Safari opens the share composer, Finder lands on top with the file selected. Drag-then-paste-caption is the manual handoff (LinkedIn has no upload API for personal profiles).
- App-launch sweep removes any per-recording exports cache dir older than 24h.
- Bonus tpad fix landed mid-phase: webcam bubble visible from t=0 instead of popping in after the AVCaptureSession start lag (composite.rs).

## Phase 7: Polish pass — **Complete (2026-04-26)**

Three deliverables shipped this pass. The original phase scope listed seven items; four of those were reclassified at the close of the pass — three to backlog (low urgency, do when needed) and one (DMG installer) deferred until after Phase 9 since the app keeps gaining capabilities and shipping a bundle now would lock in pre-window-capture functionality.

**Shipped**
- Capture window sizing — fixed 480x700, settings panel always visible (no toggle), loosened row spacing, dropdowns alpha-sorted, displays renamed to sequential "Display 1..N" instead of raw CGDirectDisplayIDs.
- Identify-display button next to the Screen dropdown — click flashes a translucent number overlay on each physical display via NSWindow.setFrame in Cocoa coords. Works on first-class macOS displays. **Does not render on DisplayLink-driven displays** — see DECISIONS.md 2026-04-26.
- App icon + brand identity — finalized Zeigen mark across the Dock, DMG, BrandBar swatch, and tray (template-style outlined Z, alpha-tinted by macOS). index.html title corrected from the Tauri scaffold default.

**Done when:** Capture window fits its content without scrolling at any state combination; clicking Identify flashes a number on each physical display in dropdown order; the Zeigen mark replaces the placeholder icon on Dock and tray. ✓

## Phase 9: Selected Area recording

Third capture mode alongside Display (Phase 2) and Window (Phase 8). User drags a marquee selection over the screen; that rectangle becomes the recorded region. Intended for short clips where the recording surface is much smaller than the full display — bubble is off by default in this mode.

**Deliverables**
- New `CaptureMode::Area` variant in the engine, sibling to `Display` and `Window`. Region passed as `{display_id, x, y, width, height}` in logical points (matches the Phase 8 fix that standardized coordinate units at the JS→Rust boundary).
- Marquee selection UI — full-screen always-on-top transparent overlay window with dimmed mask + draggable selection rectangle. Esc cancels. Enter / double-click confirms. Single click on the dim mask cancels.
- Selection rectangle shows live dimensions (`WxH` in points) inside or adjacent to the rect during drag. Snap to display edges when dragged within a few points of the boundary.
- Source picker in the capture window gains a third option: Display / Window / **Area**. Choosing Area opens the marquee overlay immediately; the picker shows the resulting rect as `Area 1280x720 @ Display 1` until cleared or re-selected.
- SCK capture uses `SCContentFilter(display:excludingWindows:)` cropped via `SCStreamConfiguration.sourceRect` (region of the display) and `destinationRect` (output frame). Output mp4 dimensions match the selection — no letterboxing. Exact unit/rect semantics to be verified during spike — see PHASE_9_HANDOFF.md.
- **Bubble disabled by default in Area mode.** Picking Area hides the floating bubble window and clears the webcam selection from the engine call. Once hidden, the bubble stays off across mode switches until the user explicitly re-enables a webcam via the device picker — no auto-restore.
- Identify-display (Phase 7) and countdown overlay (Phase 3.5) continue to render on the host display; countdown spans the selected region only (not the full screen) so the user sees what will actually be captured.
- Tray "Start" gate (Phase 4 / Phase 8 `source_kind`) extends to require a non-empty Area selection before enabling.

**Done when:** A user can drag a marquee over any portion of any display, start a recording, and produce a final mp4 whose dimensions match the selection. Picking Area auto-hides the bubble; explicitly re-enabling a webcam in Area mode brings the bubble back, positioned relative to the selected region. Switching between Display / Window / Area in the picker works without restarting the app.

## Phase 10: Review window — GIF export + timeline waveform

Two deliverables landing in the review window (`src/Review.tsx`), tied together by the same surface and the same edit pipeline. The Phase 10 slot was originally scoped as "drawing tools" — that work (text + arrow annotations) shipped in earlier phases, so the slot is reused for the review-window items surfaced at Phase 9 close-out (see `docs/PHASE_9_HANDOFF.md`).

**10.1 — GIF quick export**
- Replaces the "Coming Later" placeholder in the QUICK EXPORT row.
- No audio — GIF doesn't carry audio, and dropping it simplifies the pipeline.
- Honors existing sidecar edits: trim window, text annotations, arrow annotations all apply to the GIF output.
- ffmpeg `palettegen` + `paletteuse` pipeline for color-quantized output (single-pass low-fps as a fallback option to evaluate).
- Caps output dimensions and frame rate so file size stays sane — Loom-style defaults to be researched during planning.
- Respects the current trim window only — exports the trimmed range, not the full source.
- UX parity with the mp4 path: progress feedback + save dialog, no silent multi-minute waits.

**10.2 — Timeline waveform**
- Replaces the decorative gradient Timeline track (search `TIMELINE` in `src/Review.tsx`) with a functional audio waveform.
- Renders the recording's audio amplitude across the timeline so the user can see where speech / sound lands — useful for trimming around content.
- Open implementation question to resolve in planning: ffmpeg `showwavespic` (still image) vs. pre-decode AAC at low resolution into raw samples and draw on `<canvas>`. The canvas path is the leading candidate for crisper visual + scrubbing affordances.
- Lazy-render after first paint of the review window so waveform extraction doesn't block playback.
- Edge case: recordings with no microphone — render a flat/neutral track rather than failing.

**Done when:** Clicking GIF in the QUICK EXPORT row produces a `.gif` that honors the current trim + text + arrow edits, with progress + save-dialog feedback matching the mp4 path. The Timeline track in the review window shows an actual audio waveform for the current recording (flat track for mic-less recordings), and remains responsive while it extracts.

## Backlog

Items that were considered but didn't earn a phase. Pull from here when a real need surfaces.

- **Settings persistence across app restarts** — hotkey, countdown duration, length cap, bubble size/corner all reset to defaults on launch. Tauri store plugin or localStorage if/when this becomes annoying.
- **Error surface for common failures** — device disappeared mid-record, disk full, permission revoked. Existing StatusStrip handles engine errors but coverage hasn't been audited end-to-end. Survey gaps when a real failure surprises a recording.
- **Recording preset picker (16:9 / 1:1 / 9:16)** — would require composite + export pipeline changes. YAGNI for the current use case (analytics demos are 16:9); reconsider only if a non-16:9 demand appears.
- **Unified export flow — format selector + single Save button** — surfaced during Phase 10 c3 verification (2026-05-19). Today the "Save recording" footer action produces an MP4 via the edit pipeline, while the right-sidebar Quick Export has separate buttons for MP4 / GIF / ProRes with only GIF live (MP4 and ProRes disabled with "Coming later" sub-captions). The disabled MP4 button is confusing — MP4 export already works, just through a different control. Proposed direction: collapse to a format segmented control (MP4 / GIF / ProRes / …) + one Save action. Open design questions to resolve before planning: does the selector replace Quick Export entirely or live alongside it; where does Copy to Clipboard fit; does LinkedIn Export stay separate or fold in; how do GIF-specific presets (resolution, fps) appear/hide conditionally.
- **Timeline scrubbing — draggable playhead + hover frame preview** — surfaced during Phase 10 c4 verification (2026-05-19). Today the playhead is visual only (`pointerEvents: "none"`) and clicking anywhere on the timeline seeks via the trackRef onClick handler — there is no pointermove-driven scrub. Two complementary improvements: (1) **Draggable playhead** — pointerdown on the circle/line begins a drag, video preview updates on every pointermove, drop on pointerup. Requires adding a pointerdown handler on the playhead and switching from `cursor: pointer` + onClick to a pointermove-based seek (the trim handle pattern at `Review.tsx:1631-1659` is the closest analog). (2) **Hover frame preview** — small thumbnail next to the cursor showing the frame at the hover position, Loom/YouTube convention. Likely needs either a pre-generated thumbnail strip (extracted once via ffmpeg during commit or on review-open) or an off-screen `<video>` seeked on the fly. Open questions: does scrub during playback pause the video and resume on release; does the preview show during a real drag or only on idle hover; thumbnail strip resolution and cache location if pre-generated.

## Post-Phase-10 ship prep

- **DMG installer via `tauri build`** — run after Phase 8 (window capture), Phase 9 (selected area), and Phase 10 (GIF export + timeline waveform) ship so the first packaged build reflects the full feature set. **Will ship unsigned** — Gatekeeper warning on first launch is acceptable for a personal tool; users can right-click → Open to bypass.

## Deferred / out of scope

- Real-time annotation during recording
- Multi-monitor capture selection (assume primary display)
- Windows and Linux builds
- Auto-transcription, chapters, captions
- Direct LinkedIn API posting (not possible for personal profiles)
- A/V sync drift (surfaced in Phase 5 UAT) — separate follow-up, own diagnosis pass needed
