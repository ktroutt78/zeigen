import { useEffect, useState } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

function readParams(): { app: string; title: string } {
  const hash = window.location.hash || "";
  const q = hash.indexOf("?");
  if (q < 0) return { app: "", title: "" };
  const params = new URLSearchParams(hash.slice(q + 1));
  return {
    app: params.get("app") || "",
    title: params.get("title") || "",
  };
}

export default function IdentifyWindowOverlay() {
  const [out, setOut] = useState(false);
  const { app, title } = readParams();

  useEffect(() => {
    const tOut = window.setTimeout(() => setOut(true), 1400);
    const tClose = window.setTimeout(() => {
      getCurrentWebviewWindow()
        .close()
        .catch(() => {});
    }, 1900);
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
        position: "relative",
        boxSizing: "border-box",
        // 4px accent border traces the captured window's frame so the user
        // can spot which window is the one they picked.
        border: "4px solid var(--accent)",
        borderRadius: 6,
        boxShadow:
          "0 0 0 1px rgba(0,0,0,0.5) inset, 0 0 24px rgba(0, 102, 255, 0.5)",
        opacity: out ? 0 : 1,
        transition: "opacity 280ms ease",
        pointerEvents: "none",
        userSelect: "none",
      }}
    >
      <div
        style={{
          position: "absolute",
          top: 12,
          left: 12,
          padding: "6px 10px",
          background: "rgba(20,20,22,0.85)",
          backdropFilter: "blur(8px)",
          WebkitBackdropFilter: "blur(8px)",
          border: "1px solid var(--accent)",
          borderRadius: 6,
          color: "#fff",
          fontFamily: "var(--font-system)",
          fontSize: 13,
          fontWeight: 600,
          letterSpacing: "-0.005em",
          maxWidth: "70%",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          boxShadow: "0 4px 14px rgba(0,0,0,0.55)",
          animation: "zg-id-win-in 220ms cubic-bezier(0.2, 0.8, 0.4, 1.05)",
        }}
      >
        <span style={{ color: "var(--accent-tint)", marginRight: 6 }}>
          {app || "Window"}
        </span>
        {title && (
          <span style={{ color: "rgba(255,255,255,0.85)", fontWeight: 500 }}>
            — {title}
          </span>
        )}
      </div>
      <style>{`
        @keyframes zg-id-win-in {
          0%   { transform: translateY(-6px); opacity: 0; }
          100% { transform: translateY(0); opacity: 1; }
        }
      `}</style>
    </div>
  );
}
