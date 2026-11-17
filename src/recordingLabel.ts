// How a recording is named and timed wherever it is shown: the Recordings
// window, the Review header and the Review window's title.

const FALLBACK_NAME: Record<string, string> = {
  window: "Window recording",
  display: "Display recording",
  area: "Area recording",
};

// The recording's name, or a stand-in from what was captured when it has none.
export function recordingName(name: string | null, sourceKind: string | null): string {
  return name ?? FALLBACK_NAME[sourceKind ?? ""] ?? "Screen recording";
}

// Length as m:ss, e.g. "0:29".
export function recordingLength(s: number): string {
  const t = Math.round(s);
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
}
