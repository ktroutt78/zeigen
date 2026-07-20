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

## Coding standards

1. Use latest versions of libraries and idiomatic approaches as of today
2. Keep it simple - NEVER over-engineer, ALWAYS simplify, NO unnecessary defensive programming. No extra features - focus on simplicity.
3. Be concise. Keep README minimal. IMPORTANT: no emojis ever
4. When hitting issues, always identify root cause before trying a fix. Do not guess. Prove with evidence, then fix the root cause.

## Working documentation

All planning and execution docs live in `docs/`. Review `docs/PLAN.md` before proceeding.
