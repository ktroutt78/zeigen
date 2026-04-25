import { useEffect, useState } from "react";
import { emit } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

function readDuration(): number {
  const hash = window.location.hash || "";
  const q = hash.indexOf("?");
  if (q < 0) return 5;
  const params = new URLSearchParams(hash.slice(q + 1));
  const v = Number(params.get("duration"));
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 5;
}

function playGoSound() {
  try {
    const AC =
      (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = "sine";
    osc.frequency.value = 880;
    const t = ctx.currentTime;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.35, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.32);
    osc.start(t);
    osc.stop(t + 0.36);
  } catch {
    // best effort — no audio is fine
  }
}

async function close() {
  try {
    await getCurrentWebviewWindow().close();
  } catch {
    // ignore
  }
}

export default function CountdownOverlay() {
  const [n, setN] = useState<number>(readDuration());
  const [tick, setTick] = useState<number>(0);

  useEffect(() => {
    if (n <= 0) {
      playGoSound();
      emit("countdown-done").finally(close);
      return;
    }
    const id = window.setTimeout(() => {
      setN((v) => v - 1);
      setTick((t) => t + 1);
    }, 1000);
    return () => window.clearTimeout(id);
  }, [n]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        emit("countdown-cancelled").finally(close);
      } else if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        playGoSound();
        emit("countdown-done").finally(close);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div
      style={{
        width: "100vw",
        height: "100vh",
        background: "var(--bg-overlay-strong)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        color: "var(--fg-primary)",
        fontFamily: "var(--font-system)",
        userSelect: "none",
      }}
    >
      <div
        key={tick}
        style={{
          fontSize: 220,
          fontWeight: 200,
          letterSpacing: "var(--track-tight)",
          lineHeight: 1,
          animation: "zg-countdown-pulse var(--dur-settle) ease-out",
        }}
      >
        {n > 0 ? n : "GO"}
      </div>
      <div
        style={{
          marginTop: 36,
          fontSize: "var(--text-caption)",
          color: "var(--fg-tertiary)",
          letterSpacing: "var(--track-eyebrow)",
          textTransform: "uppercase",
        }}
      >
        Esc cancel · Space or Enter skip
      </div>
      <style>{`
        @keyframes zg-countdown-pulse {
          0%   { transform: scale(1.18); opacity: 0; }
          40%  { opacity: 1; }
          100% { transform: scale(1.0); opacity: 1; }
        }
      `}</style>
    </div>
  );
}
