// Why Start recording is disabled, in plain words, or null when it isn't (or
// when the button already says what is happening, e.g. "Starting"). One
// reason, the most actionable first. Mirrors App.tsx's canStartNow; pure, so
// it is unit-tested (startReason.test.ts).
export type StartInputs = {
  state: "idle" | "countdown" | "recording" | "paused";
  sourceKind: "display" | "window" | "area";
  picked: boolean; // canStartNow
  displays: number;
  windows: number;
  permissionDenied: boolean;
};

export function startBlockedReason(s: StartInputs): string | null {
  if (s.state !== "idle" || s.picked) return null;
  // No displays: the engine's list hasn't arrived, or Screen Recording
  // permission stopped it (the error line above says which).
  if (s.displays === 0) {
    return s.permissionDenied ? "Allow Screen Recording in System Settings to start" : "Looking for displays…";
  }
  if (s.sourceKind === "display") return "Pick a display to start";
  if (s.sourceKind === "area") return "Select an area to start";
  return s.windows === 0 ? "No windows to record. Open one, then pick it" : "Pick a window to start";
}
