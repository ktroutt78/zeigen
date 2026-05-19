// Horizontal recording-control pill: [• mm:ss] [pause/resume] [stop].
//
// Rendered standalone in the timer-chip window when no webcam bubble is
// active (the bubble has its own pause/stop pill in the same style).
// Visual styling matches WebcamBubble.tsx's inline pill so the two
// surfaces look identical to the user.

import { invoke } from "@tauri-apps/api/core";
import { Icon, P } from "./icons";
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

function tintFor(elapsedSec: number, capSec: number | null | undefined) {
  if (!capSec || capSec <= 0) return "neutral" as const;
  const f = elapsedSec / capSec;
  if (f >= 1) return "over" as const;
  if (f >= 0.8) return "warning" as const;
  return "neutral" as const;
}

export default function RecordingControlPill({ state, elapsedSec, capSec }: Props) {
  if (state !== "recording" && state !== "paused") return null;
  const isRec = state === "recording";
  const tint = tintFor(elapsedSec, capSec);

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
        gap: 8,
        padding: "4px 4px 4px 12px",
        background: "rgba(20,20,22,0.78)",
        backdropFilter: "blur(10px)",
        WebkitBackdropFilter: "blur(10px)",
        border: "0.5px solid rgba(255,255,255,0.18)",
        borderRadius: 99,
        boxShadow: "0 4px 14px rgba(0,0,0,0.4)",
        color: textColor,
        fontFamily: "var(--font-mono)",
        fontSize: 11,
        fontVariantNumeric: "tabular-nums",
        letterSpacing: "0.02em",
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: 99,
          background: dotColor,
          boxShadow: dotGlow,
          flexShrink: 0,
        }}
      />
      <span style={{ flexShrink: 0 }}>{display}</span>
      <button
        title={state === "paused" ? "Resume" : "Pause"}
        onClick={() => {
          if (state === "paused") {
            invoke("engine_resume").catch(() => {});
          } else {
            invoke("engine_pause").catch(() => {});
          }
        }}
        style={{
          width: 26,
          height: 26,
          borderRadius: 99,
          background: "transparent",
          color: "#fff",
          border: "none",
          cursor: "pointer",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Icon d={state === "paused" ? P.play : P.pause} size={12} stroke={1.5} />
      </button>
      <button
        title="Stop"
        onClick={() => invoke("engine_stop").catch(() => {})}
        style={{
          width: 26,
          height: 26,
          borderRadius: 99,
          background: "var(--recording)",
          color: "#fff",
          border: "none",
          cursor: "pointer",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <span
          style={{
            width: 8,
            height: 8,
            background: "#fff",
            borderRadius: 1.5,
            display: "inline-block",
          }}
        />
      </button>
    </div>
  );
}
