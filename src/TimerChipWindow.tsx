import TimerChip from "./components/TimerChip";
import { useRecordingState } from "./hooks/useRecordingState";

export default function TimerChipWindow() {
  const { state, elapsed } = useRecordingState();
  return (
    <div
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
      <TimerChip state={state} elapsedSec={elapsed} />
    </div>
  );
}
