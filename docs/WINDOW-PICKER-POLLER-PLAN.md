# Window-picker poller plan

Branch: `activation-priming-click`. Approved 2026-07-28. Supersedes the
key-window/setFocus approach for the picker. Background + evidence:
DECISIONS.md 2026-07-28 (priming-click root cause = key-window exclusivity;
global monitors refuted on macOS 26; polling is the sanctioned mechanism).

## Goal

Hover highlight follows the cursor across every display with zero clicks;
single click selects on any display; cancel works on every display. No overlay
ever needs to be key, so the key-steal (N overlays each stealing key on
`setFocus`, only the last receiving `mouseMoved`) is gone at the root.

## Mechanism (NOT a global monitor)

A native cursor poller in the main app process: a ~60 Hz timer reading
`CGEventGetLocation(CGEventCreate(nil))` (global position, CG top-left points)
and detecting clicks via `CGEventSourceCounterForEventType(combinedSessionState,
leftMouseDown)` deltas. This is the permission-free pattern CursorTracker uses
(see its header) — no key window, no Input Monitoring, no Accessibility.
Implemented via direct CoreGraphics C FFI (no new crate dependency).

## Architecture

While the picker is open the poller emits two Tauri events:
- `picker-cursor {x, y}` every tick (global CG point)
- `picker-click {x, y}` on a mouse-down

Each overlay is handed its own display's CG origin + size (URL params),
self-maps global -> local (`local = g - origin`, in-bounds check), and drives
the EXISTING `resolveAt` / highlight in `WindowPickerOverlay`. The working
hit-test and z-order logic are reused untouched. Point -> display resolution
lives in the overlays (they already own per-display geometry); no central
coordinator.

## Slices

### Slice 1 — Native poller (no behavior change)
Add the CG poller + `picker_cursor_start` / `picker_cursor_stop` commands;
emit `picker-cursor` / `picker-click`. Wire `start` on picker open and `stop`
in the picker's `finish()` choke point (so select, cancel, AND Esc all stop
it). Slice-1 verification logs to `/tmp/zeigen-picker-poller.log` (throttled
positions, every click, start/stop-with-reason).

Done when:
- [ ] With the picker open and another app frontmost, the log shows cursor
      positions spanning ALL displays and a line per click.
- [ ] The poller thread stops on EVERY exit path — cancel, select, and Esc —
      verified by a "poller stop" line for each (no 60 Hz timer survives a
      picker close; `start` is idempotent and stops any prior thread).

### Slice 2 — Hover via poller; remove setFocus
Overlays consume `picker-cursor`, self-map, highlight; clear when the cursor
leaves their bounds. Delete all `setFocus` in the picker path
(`WindowPickerOverlay` mount + pointermove-recovery; `App.tsx` primary
`setFocus`; `focus: i===0`).

Done when:
- [ ] Highlight follows the cursor on ALL displays with zero clicks; Zeigen
      never comes forward; `grep setFocus` in the picker path is empty.
- [ ] Verified with THREE displays AND with a SINGLE display connected — the
      key-steal only manifests with multiple overlays, so a single-display
      regression must not hide behind the multi-display setup.

### Slice 3 — Select + cancel-everywhere
Overlays consume `picker-click`; click order = (1) inside the on-screen
Cancel-button rect -> cancel; (2) `resolveAt` hits a window -> select; (3)
empty -> cancel. Neutralize the DOM `onPointerDown` select path (no
double-fire). The "click empty space to cancel" instruction text must render
on EVERY overlay, not just the first.

Done when:
- [ ] Single click selects the hovered window on any display.
- [ ] Empty-space click cancels on any display; the Cancel button cancels on
      any display; no double-select.
- [ ] The cancel-instruction text is visible on every display's overlay.

### Slice 4 — Cleanup
Remove the diagnostic probes (`focus_probe` / `try_activate_probe`, lib.rs
registration, the WindowPickerOverlay probe calls — reverts `a16fb20`) and the
Slice-1 poller logging. Append the outcome to DECISIONS.

Done when:
- [ ] `grep focus_probe` empty; build clean.
- [ ] DECISIONS records "poller shipped, key-steal removed."

## Cancel-everywhere tradeoff (accepted)

The guaranteed cancels are the two MOUSE paths (Cancel button + empty-space
click), both poller-driven and working on every display. Esc CANNOT be made to
work on all displays without Input Monitoring (refuted on macOS 26) or a keyed
window per display (impossible — key is exclusive). So the mouse paths are the
everywhere-cancel; the visible instruction text stays on every overlay; Esc is
best-effort (fires only if some window is key). Recorded in DECISIONS so it
isn't re-litigated.

## Risks / flags

- 60 Hz cross-window Tauri events — throttle to on-change if janky.
- CG-space edge behavior near the open 2x-Retina coordinate-overflow issue
  (pre-existing, not worsened by the poller).
- DisplayLink displays still won't render an overlay (known limitation) though
  the poller sees the cursor there.
- `CGEventCreate(nil)` returns a +1 CFTypeRef — `CFRelease` every tick or leak.

## Non-goals

The 2x-Retina coordinate-overflow fix; the union-spanning overlay; any change
to the enumerate / z-order logic.
