import type { RecordingState } from "../hooks/useRecordingState";

type Props = {
  state: RecordingState;
  elapsedSec: number;
};

function fmtMmSs(s: number): string {
  const total = Math.max(0, Math.floor(s));
  const m = String(Math.floor(total / 60)).padStart(2, "0");
  const ss = String(total % 60).padStart(2, "0");
  return `${m}:${ss}`;
}

export default function TimerChip({ state, elapsedSec }: Props) {
  if (state !== "recording" && state !== "paused") return null;
  const isRec = state === "recording";
  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "4px 10px",
        background: "rgba(20,20,22,0.78)",
        backdropFilter: "blur(10px)",
        WebkitBackdropFilter: "blur(10px)",
        border: "0.5px solid rgba(255,255,255,0.18)",
        borderRadius: 99,
        color: "#f2f2f7",
        fontFamily: "var(--font-mono)",
        fontSize: 11,
        fontVariantNumeric: "tabular-nums",
        letterSpacing: "0.02em",
        boxShadow: "0 4px 14px rgba(0,0,0,0.4)",
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: 99,
          background: isRec ? "var(--recording)" : "var(--fg-secondary)",
          boxShadow: isRec ? "0 0 6px var(--recording)" : "none",
        }}
      />
      <span>{fmtMmSs(elapsedSec)}</span>
    </div>
  );
}
