import { useEffect, useState } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

function readNumber(): string {
  const hash = window.location.hash || "";
  const q = hash.indexOf("?");
  if (q < 0) return "?";
  const params = new URLSearchParams(hash.slice(q + 1));
  return params.get("n") || "?";
}

export default function IdentifyOverlay() {
  const [out, setOut] = useState(false);

  useEffect(() => {
    const tOut = window.setTimeout(() => setOut(true), 3300);
    const tClose = window.setTimeout(() => {
      getCurrentWebviewWindow()
        .close()
        .catch(() => {});
    }, 3700);
    return () => {
      window.clearTimeout(tOut);
      window.clearTimeout(tClose);
    };
  }, []);

  return (
    <div
      style={{
        width: "100vw",
        height: "100vh",
        background: "transparent",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "#ffffff",
        fontFamily: "var(--font-system)",
        userSelect: "none",
        opacity: out ? 0 : 1,
        transition: "opacity 280ms ease",
      }}
    >
      <div
        style={{
          fontSize: "32vmin",
          fontWeight: 700,
          lineHeight: 1,
          letterSpacing: "-0.06em",
          textShadow:
            "0 0 40px rgba(0,0,0,0.85), 0 0 100px rgba(0,0,0,0.55), 0 6px 24px rgba(0,0,0,0.6)",
          animation: "zg-identify-in 320ms cubic-bezier(0.2, 0.8, 0.4, 1.2)",
        }}
      >
        {readNumber()}
      </div>
      <style>{`
        @keyframes zg-identify-in {
          0%   { transform: scale(0.5); opacity: 0; }
          100% { transform: scale(1.0); opacity: 1; }
        }
      `}</style>
    </div>
  );
}
