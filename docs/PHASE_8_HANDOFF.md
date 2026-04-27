# Phase 8 handoff

## Shipped this session (oldest → newest)

- `4a3db9b` — c1: engine enumerates capturable windows
- `380581e` — c2: engine accepts window_id for SCK window capture
- `6ca3427` — c3: 5Hz window_frame event during window capture
- `b1ff450` — c4: rust window-mode plumbing (`CaptureMode` enum, listener taps `window_frame` events)
- `53cb035` — c5: window source picker (tiles interactive, picker dropdown live)
- `46bd647` — c5 fix: clamp window-picker dropdown to grid column
- `fb6b840` — c5 fix: tighten window filter (57 → 15 windows; isOnScreen, Apple allowlist, WebView, dedupe)
- `3b1a4f1` — c5 fix: bubble state fallback (App.tsx broadcasts `recording-state`) + activate captured window
- `d0991e2` — c5 fix: revert engine activate() crash + stop()/watchdog stuck-state recovery
- `554cce4` — c5 fix: `NSApplication.shared` bootstraps CG in the engine binary (window mode requires it)
- `a7ad1ef` — c5 fix: `minmax(0, 1fr)` on settings grid prevents select-driven overflow
- `076789d` — c5 fix: `recording_cleanup_local` so engine errors aren't overwritten by INVALID_STATE follow-on
- `4348ec6` — c5 fix: drop dead webcam Size + Corner controls
- `4a8aed5` — c7: identify-window button + IdentifyWindowOverlay component (badge ships; outline doesn't render — see open issues)

## Open Phase 8 items (priority order)

- **c7 outline rendering bug** — badge appears at correct position but the surrounding blue tint and 4px outline don't render visually. Tried `border` → `inset box-shadow`, cranked tint to 0.25 alpha, dropped `make_capture_invisible` — none worked. Suspect transparent NSWindow / WKWebView compositor interaction. Console.log of cg coords + size was added during debugging — re-add to confirm Tauri actually receives the window's correct dimensions; then dig from there.
- **Composite bubble size match** — live bubble is drag-resizable, but composite always renders 240px (Medium default). Add `diameter` field to bubble position log entries; bubble JS reads its own outerSize at each poll; composite uses `bubble_position_log[0].diameter`. Removes the residual disconnect from killing Size/Corner controls.
- **c6 focus-aware sort** — window picker is alpha-by-app + alpha-by-title. User refinement was: focused-app windows on top, then most-recently-non-Zeigen activated. Needs NSWorkspace `didActivateApplicationNotification` observer in the Rust main process (Tauri has NSApplication context, engine doesn't), MRU deque, new Tauri command returning recent bundle IDs, UI consumes for sort.
- **Tray window-mode fix** — `tray::build_menu` Start enabled check is `state.selected_display.is_some()` only. In Window mode it's greyed out even when a window is selected. Add `selected_window: Option<u32>` to `UiState`, push it from App.tsx's tray-state effect, expand the enable check.
- **Tray Window submenu** — tray has Screen submenu, no Window submenu. Mirror the pattern using the windows array in UiState.
- **c8 edge cases** — implement `SCStreamDelegate.stream(_:didStopWithError:)` so window-closed mid-record finalizes gracefully (currently engine probably hangs / silently drops). Surface a "window minimized" warning chip when `window_frame` events report `on_screen: false`.
- **Visual window picker (deferred)** — thumbnail grid alternative to dropdown for users with many windows; YAGNI for now since the filter already keeps the list to ~15.

## Known UAT findings, deliberately deferred

- **Picking an inactive/hidden window doesn't auto-raise it to foreground.** Tried `NSRunningApplication.activate()` from the engine; crashes with `CGS_REQUIRE_INIT` (engine has no NSApplication run loop). Move the activation to the Rust/Tauri main process where AppKit is fully booted. Punted per Keith.

## Worth knowing for the next session

- **Engine needs `_ = NSApplication.shared` at startup** (main.swift). Required for SCK's window-mode code path; display mode worked without it. If you ever see `CGS_REQUIRE_INIT` in engine stderr, that's the cause.
- **Engine errors must use `recording_cleanup_local`, not `recording_reset`.** The latter sends Stop to the engine, which is already idle on its own error → INVALID_STATE → original error gets overwritten. (App.tsx error handler now uses cleanup_local.)
- **Bubble useRecordingState listens to two signals**: engine-event (`started`/`stopped`) AND a redundant `recording-state` broadcast from App.tsx. Belt-and-suspenders against missed events; if you change the broadcast shape, update both consumers.
- **Window filter (`Engine.swift::filterShareableWindows`) is opinionated.** `!isOnScreen` drops, `com.apple.*` requires allowlist membership, app name contains `"WebView"` drops, dedupe by `(bundle_id, title)` keeping largest. From raw ~57 to ~15 in normal use. Add to `appleAllowlist` if a user reports a missing real Apple app.
- **Bubble coords in window mode** read from a cached window frame populated by 5Hz `window_frame` events. The first ~200ms after recording start may no-op (cache not yet populated) — visible as a brief gap in the position log.
- **Stale Cargo build artifacts** bit twice this session (serde, cssparser). Targeted `cargo clean -p <crate>` recovers without a full rebuild.
- **Long-running dev**: use `nohup npm run tauri dev > /tmp/zeigen-dev.log 2>&1 & disown` so the wrapper bash exit doesn't take Tauri/Vite down with it. Read `/tmp/zeigen-dev.log` for engine stderr (look for `[engine]` lines).
- **Webcam Size/Corner controls were removed**, but `webcam_size`/`webcam_corner` params are still accepted by `engine_start` (Rust falls through to Medium/BottomRight defaults). Safe to leave; revisit when the composite-size-match work lands.
