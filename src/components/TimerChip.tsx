import type { RecordingState } from "../hooks/useRecordingState";

type Props = {
  state: RecordingState;
  elapsedSec: number;
  capSec?: number | null;
};

function fmtMmSs(s: number): string {
  const total = Math.max(0, Math.floor(s));
  const m = String(Math.floor(total / 60)).padStart(2, "0");
  const ss = String(total % 60).padStart(2, "0");
  return `${m}:${ss}`;
}

type Tint = "neutral" | "warning" | "over";

function tintFor(elapsedSec: number, capSec: number | null | undefined): Tint {
  if (!capSec || capSec <= 0) return "neutral";
  const f = elapsedSec / capSec;
  if (f >= 1) return "over";
  if (f >= 0.8) return "warning";
  return "neutral";
}

export default function TimerChip({ state, elapsedSec, capSec }: Props) {
  if (state !== "recording" && state !== "paused") return null;
  const isRec = state === "recording";
  const tint = tintFor(elapsedSec, capSec ?? null);

  const textColor =
    tint === "over"
      ? "var(--recording-tint)"
      : tint === "warning"
      ? "var(--warning-tint)"
      : "#f2f2f7";
  const dotColor = isRec
    ? tint === "over"
      ? "var(--recording)"
      : tint === "warning"
      ? "var(--warning)"
      : "var(--recording)"
    : "var(--fg-secondary)";
  const dotGlow =
    isRec && tint === "warning"
      ? "0 0 6px var(--warning)"
      : isRec
      ? "0 0 6px var(--recording)"
      : "none";

  const display =
    capSec && capSec > 0
      ? `${fmtMmSs(elapsedSec)} / ${fmtMmSs(capSec)}`
      : fmtMmSs(elapsedSec);

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
        color: textColor,
        fontFamily: "var(--font-mono)",
        fontSize: 11,
        fontVariantNumeric: "tabular-nums",
        letterSpacing: "0.02em",
        boxShadow: "0 4px 14px rgba(0,0,0,0.4)",
        transition: "color var(--dur-smooth) ease",
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: 99,
          background: dotColor,
          boxShadow: dotGlow,
        }}
      />
      <span>{display}</span>
    </div>
  );
}
