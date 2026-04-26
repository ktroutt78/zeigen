# Zeigen

Personal Loom-style screen + webcam recorder for dashboard and analytics demos. Tauri desktop app, macOS-only.

## Known limitations

- **DisplayLink-driven displays.** Recording works (ScreenCaptureKit can capture them), but the countdown overlay and the Identify-display button can't show on a DisplayLink display — macOS does not reliably allow `NSWindow` placement on virtual displays from third-party drivers. Choose the display from the dropdown directly in that case.
