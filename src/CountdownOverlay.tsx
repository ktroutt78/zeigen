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
        background: "transparent",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        color: "#ffffff",
        fontFamily: "var(--font-system)",
        userSelect: "none",
      }}
    >
      <div
        key={tick}
        style={{
          fontSize: 280,
          fontWeight: 200,
          letterSpacing: "var(--track-tight)",
          lineHeight: 1,
          textShadow:
            "0 0 32px rgba(0,0,0,0.85), 0 0 80px rgba(0,0,0,0.55), 0 6px 24px rgba(0,0,0,0.6)",
          animation: "zg-countdown-pulse var(--dur-settle) ease-out",
        }}
      >
        {n > 0 ? n : "GO"}
      </div>
      <div
        style={{
          marginTop: 28,
          fontSize: "var(--text-caption)",
          color: "rgba(255,255,255,0.85)",
          letterSpacing: "var(--track-eyebrow)",
          textTransform: "uppercase",
          textShadow: "0 0 12px rgba(0,0,0,0.85), 0 2px 6px rgba(0,0,0,0.7)",
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
