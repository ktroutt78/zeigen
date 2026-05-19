// Persistent visual indicator for an in-progress area recording.
//
// One transparent always-on-top window sized to the selected region's
// screen-space rect. Renders a dashed border around its inside edge so
// the user can always see what's being captured. The window is invisible
// to SCK (make_capture_invisible) and click-through
// (setIgnoreCursorEvents) so it never bleeds into the recording or
// blocks interaction with whatever's underneath.

export default function AreaIndicator() {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        // Border drawn inside the window's 100vw/100vh so it fully shows
        // along the selected region's edges. box-sizing: border-box keeps
        // the 2px border within the box rather than expanding it.
        border: "2px dashed rgba(220, 38, 38, 0.92)",
        boxSizing: "border-box",
        background: "transparent",
        pointerEvents: "none",
      }}
    />
  );
}
