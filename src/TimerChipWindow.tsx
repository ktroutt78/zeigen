import { emit } from "@tauri-apps/api/event";
import RecordingControlPill from "./components/RecordingControlPill";
import { useRecordingState } from "./hooks/useRecordingState";

function StartRecordingChip() {
  return (
    <button
      type="button"
      onClick={() => emit("request-area-start").catch(() => {})}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 14px 6px 10px",
        background: "rgba(20,20,22,0.78)",
        backdropFilter: "blur(10px)",
        WebkitBackdropFilter: "blur(10px)",
        border: "0.5px solid rgba(255,255,255,0.18)",
        borderRadius: 99,
        boxShadow: "0 4px 14px rgba(0,0,0,0.4)",
        color: "#fff",
        fontFamily: "var(--font-system)",
        fontSize: 12,
        fontWeight: 600,
        letterSpacing: "0.01em",
        cursor: "pointer",
      }}
    >
      <span
        style={{
          width: 10,
          height: 10,
          borderRadius: 99,
          background: "var(--recording)",
          boxShadow: "0 0 6px var(--recording)",
        }}
      />
      <span>Start Recording</span>
    </button>
  );
}

export default function TimerChipWindow() {
  const { state, elapsed, capSec } = useRecordingState();
  const idle = state === "idle";
  return (
    <div
      // Drag the empty regions around the pill to reposition the chip.
      // Buttons inside the pill receive their own click events.
      data-tauri-drag-region
      style={{
        width: "100vw",
        height: "100vh",
        background: "transparent",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        cursor: "grab",
      }}
    >
      {idle ? (
        <StartRecordingChip />
      ) : (
        <RecordingControlPill state={state} elapsedSec={elapsed} capSec={capSec} />
      )}
    </div>
  );
}
