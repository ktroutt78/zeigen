import { useEffect, useRef, useState } from "react";
import { Icon, P } from "./icons";
import { useCornerSnap } from "../hooks/useCornerSnap";
import { useBubblePositionLog } from "../hooks/useBubblePositionLog";
import { useRecordingState } from "../hooks/useRecordingState";
import TimerChip from "./TimerChip";

// Floating circular webcam preview. Mirrors the WebcamOrbit variant from
// docs/design/surfaces/webcam-bubble.jsx — circular feed, hover-only chrome,
// resize handle bottom-right.
//
// The window itself is created by the main App via Tauri's WebviewWindow
// API. URL hash carries the chosen device name, e.g. `#bubble?name=...`.

function readDeviceName(): string | null {
  const hash = window.location.hash || "";
  const q = hash.indexOf("?");
  if (q < 0) return null;
  const params = new URLSearchParams(hash.slice(q + 1));
  return params.get("name");
}

// Pin to the same camera mode the recording-side ffmpeg requests
// (1280x720 @ 30fps). When both consumers ask for the same mode, macOS
// doesn't renegotiate when the second consumer attaches — so the
// preview frame doesn't visibly zoom mid-recording.
const VIDEO_CONSTRAINTS: MediaTrackConstraints = {
  width: { ideal: 1280 },
  height: { ideal: 720 },
  frameRate: { ideal: 30 },
};

async function findStream(deviceName: string | null): Promise<MediaStream> {
  // Prefer matching by label so we follow the user's Tauri-side selection.
  // Browser device IDs aren't stable across sessions; labels are.
  const stream = await navigator.mediaDevices.getUserMedia({
    video: VIDEO_CONSTRAINTS,
    audio: false,
  });

  if (!deviceName) return stream;

  // After the first prompt, labels are populated. Re-enumerate and switch
  // if a better match exists.
  const devices = await navigator.mediaDevices.enumerateDevices();
  const match = devices.find(
    (d) => d.kind === "videoinput" && d.label === deviceName,
  );
  if (!match || !match.deviceId) return stream;

  // If the initial stream is already the right device, keep it.
  const currentTrack = stream.getVideoTracks()[0];
  const settings = currentTrack?.getSettings();
  if (settings?.deviceId === match.deviceId) return stream;

  // Switch tracks: stop the old one, request the specific device.
  stream.getTracks().forEach((t) => t.stop());
  return await navigator.mediaDevices.getUserMedia({
    video: { ...VIDEO_CONSTRAINTS, deviceId: { exact: match.deviceId } },
    audio: false,
  });
}

export default function WebcamBubble() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [hover, setHover] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useCornerSnap();
  useBubblePositionLog();
  const { state: recState, elapsed } = useRecordingState();

  useEffect(() => {
    let cancelled = false;
    let stream: MediaStream | null = null;

    const start = async () => {
      try {
        const name = readDeviceName();
        const s = await findStream(name);
        if (cancelled) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        stream = s;
        if (videoRef.current) {
          videoRef.current.srcObject = s;
          await videoRef.current.play().catch(() => {});
        }
      } catch (err) {
        if (!cancelled) setError(String(err));
      }
    };

    start();
    return () => {
      cancelled = true;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        width: "100vw",
        height: "100vh",
        background: "transparent",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        overflow: "hidden",
      }}
    >
      <div
        data-tauri-drag-region
        style={{
          width: "min(100vw, 100vh)",
          height: "min(100vw, 100vh)",
          borderRadius: "50%",
          overflow: "hidden",
          position: "relative",
          background: "#1a1a1c",
          border: "1.5px solid rgba(255,255,255,0.12)",
          boxShadow: "0 18px 48px rgba(0,0,0,0.55), 0 0 0 0.5px rgba(0,0,0,0.5)",
          cursor: hover ? "grab" : "default",
        }}
      >
        {error ? (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: 16,
              textAlign: "center",
              color: "var(--fg-secondary)",
              fontSize: 11,
              lineHeight: 1.4,
              fontFamily: "var(--font-system)",
            }}
          >
            {error}
          </div>
        ) : (
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            style={{
              width: "100%",
              height: "100%",
              objectFit: "cover",
              transform: "scaleX(-1)",
              pointerEvents: "none",
            }}
          />
        )}

        <div
          style={{
            position: "absolute",
            inset: 0,
            background: "radial-gradient(circle at 35% 30%, rgba(255,255,255,0.08), transparent 55%)",
            pointerEvents: "none",
          }}
        />

        {hover && (
          <div
            style={{
              position: "absolute",
              right: 8,
              bottom: 8,
              width: 24,
              height: 24,
              borderRadius: 99,
              background: "rgba(0,0,0,0.55)",
              backdropFilter: "blur(6px)",
              color: "#fff",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              border: "0.5px solid rgba(255,255,255,0.2)",
              cursor: "se-resize",
            }}
            // The bubble window is system-resizable from any edge in Tauri,
            // but the visible affordance reads as a Mac-style grab handle.
          >
            <Icon d={P.resize} size={11} stroke={1.4} />
          </div>
        )}

        {(recState === "recording" || recState === "paused") && (
          <div
            style={{
              position: "absolute",
              left: "50%",
              bottom: 14,
              transform: "translateX(-50%)",
              pointerEvents: "none",
            }}
          >
            <TimerChip state={recState} elapsedSec={elapsed} />
          </div>
        )}
      </div>
    </div>
  );
}
