# Zeigen

Personal Loom-style screen + webcam recorder, built for dashboard and analytics demos. Tauri desktop app, macOS-first.

## Scope

Record screen + external webcam (built-in, USB, or iPhone Continuity) into a single mp4. Webcam overlaid as a circle. Device picker, floating webcam preview, global hotkey, tray icon, trim + annotate post-record, multiple export paths (local, clipboard, Cloudflare R2 link, LinkedIn).

Out of scope: real-time annotation, Windows/Linux, transcription, team features.

## Stack

- Tauri + React + Vite
- Swift helper binary (`src-tauri/recording-engine/`) for screen + mic capture via ScreenCaptureKit + AVCaptureSession, muxed by AVAssetWriter. Protocol in `docs/IPC-SPEC.md`.
- Swift compositor binary (`src-tauri/compositor-engine/`, `cicompositor`) is the **single canonical render/composite path**: Core Image renders every zoom / webcam bubble / watermark at export. The old ffmpeg `filter_complex` oversample-composite path (V2) was eliminated 2026-07-19 (`v0.1.0-engine-v2-removed`); there is no fallback — a compositor failure fails the export loudly.
- ffmpeg remains only for webcam capture (Phase 3), GIF palettegen, and H.264 transcoding (`h264_videotoolbox`). It no longer composites edits. ffmpeg `-f avfoundation` is **not** used for screen capture — `AVCaptureScreenInput` was removed on macOS 26.
- Cloudflare R2 for storage, Cloudflare Pages for the `/v/[id]` viewer

**Portability note:** collapsing to one compositor path means a future Windows port reimplements a single render pipeline (cicompositor's Core Image logic), not two — the dual ffmpeg-vs-Core-Image split is gone.

## Known gotchas

- Continuity Camera drops when iPhone sleeps. Re-enumerate on failure.
- iPhone Continuity routes camera + mic from the same iPhone over a single channel. If the webcam ffmpeg process claims the iPhone camera, SCK cannot also claim the iPhone mic — fails with `SCStreamErrorDomain Code=-3820 "Stream failed to start microphone"`. Don't combine iPhone camera with iPhone mic; future UI slice should disable that combination in the picker.
- `avfoundation` device indices are not stable. Enumerate before every recording.
- Resolution and framerate must be set explicitly per device.
- macOS requires Screen Recording, Camera, and Mic permissions.
- Use a single audio source to avoid sync drift.
- LinkedIn has no direct upload API for personal profiles. Export path opens composer and relies on manual drag-in.
- DisplayLink-driven displays enumerate via SCK/CGDisplay (so they record fine) but `NSWindow.setFrame` placement on them is unreliable — macOS doesn't officially support windows on virtual displays from third-party drivers. Identify-display button and countdown overlay won't render on a DisplayLink screen. No fix at the application layer.
- Window recordings capture everything the picked window's app draws on that display, cropped to the window (`RecordingSession.swift`), so the app's menus and dialogs show, but so does a second overlapping window of the same app; system-owned panels like the file open/save panel do not, and a popup hanging past the window's edge is cut off at the edge.
- macOS delivers `mouseMoved` events only to the *key* window, and only one window can be key at a time. So a hover-driven overlay built as one window per display works only on whichever overlay is key (the primary). Drag-driven overlays (marquee) are immune because `mouseDragged` reaches non-key windows. The window picker hits this: hover works on the primary display only; the Window dropdown is the fallback for secondary displays. Robust fix (deferred): one overlay spanning the union of all displays.

## Ownership

This codebase is yours. How Zeigen is built is your call, and you'll keep building on it.
What Zeigen is for, and what "good" looks like, is Keith's call. He's the product owner.

**You own (decide without asking):**
- Architecture, module boundaries, data flow, file layout
- Refactors and rewrites, including deleting code that's in the way
- Algorithms and tuning: the zoom detector, camera motion, easing, capture pipeline
- Test strategy and the validation harness
- How work gets split and handed to the implementer agent

**Keith owns (bring to him):**
- What the app should do and how it should feel. He judges results by watching real recordings.
- Priority order of the backlog
- Anything that changes his recording workflow: shortcuts, defaults, what's on by default, file formats
- Trade-offs he'd notice: export time, file size, CPU load while recording

**How we work:**
1. Keith describes a problem in product terms ("the zoom whips into place").
2. You investigate, decide the approach, and write a short plan: problem, root cause, approach, files touched, how we'll know it's fixed. Write it in plain language, because Keith reads it to decide yes or no and doesn't read diffs.
3. Hand implementation to the `implementer` agent (Opus) with the plan. Keep anything delicate or architectural yourself.
4. Review the implementer's diff against the plan before calling it done. You're accountable for what ships, not just what you wrote.
5. Hand Keith a specific thing to watch: "record a 30s clip that clicks between two far-apart buttons; the zoom should glide and settle, not snap."

**Standing rules:**
- Preview and export must match. Any visual effect is defined once and rendered by both paths, never two separate implementations.
- Tell Keith what you couldn't verify (e.g. "couldn't drive the live timeline headless") instead of implying it works.
- When you leave something worse than you'd like, write it in `docs/DEBT.md`, not just in a commit message.
- Commit at each working step. Don't batch a day of changes into one commit.

## Coding standards

1. Use latest versions of libraries and idiomatic approaches as of today
2. Keep it simple - NEVER over-engineer, ALWAYS simplify, NO unnecessary defensive programming. No extra features - focus on simplicity.
3. Be concise. Keep README minimal. IMPORTANT: no emojis ever
4. When hitting issues, always identify root cause before trying a fix. Do not guess. Prove with evidence, then fix the root cause.

## Working documentation

All planning and execution docs live in `docs/`. Review `docs/PLAN.md` before proceeding.

Current assignment: `docs/ZOOM-POLISH-AND-CAPTURE-BRIEF.md`.
