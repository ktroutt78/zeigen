import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { Icon, P } from "./icons";
import { useCornerSnap } from "../hooks/useCornerSnap";
import { useBubblePositionLog } from "../hooks/useBubblePositionLog";
import { useRecordingState } from "../hooks/useRecordingState";
import TimerChip from "./TimerChip";
import { PILL_STRIP_CSS } from "../constants/bubble";

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
  const { state: recState, elapsed, capSec } = useRecordingState();

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

  const recActive = recState === "recording" || recState === "paused";

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        width: "100vw",
        height: "100vh",
        background: "transparent",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        overflow: "hidden",
      }}
    >
      <div
        data-tauri-drag-region
        style={{
          width: `min(100vw, calc(100vh - ${PILL_STRIP_CSS}px))`,
          height: `min(100vw, calc(100vh - ${PILL_STRIP_CSS}px))`,
          flexShrink: 0,
          borderRadius: "50%",
          overflow: "hidden",
          position: "relative",
          background: "#1a1a1c",
          // White ~25% rim, no black inner hairline. Subtle drop shadow only —
          // tight enough to fade inside the window's corner gap so the
          // transparent backdrop reads clean.
          border: "1.5px solid rgba(255,255,255,0.28)",
          boxShadow: "0 4px 10px rgba(0,0,0,0.28)",
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

        {recActive && (
          <div
            style={{
              position: "absolute",
              left: "50%",
              bottom: 14,
              transform: "translateX(-50%)",
              pointerEvents: "none",
            }}
          >
            <TimerChip state={recState} elapsedSec={elapsed} capSec={capSec} />
          </div>
        )}

      </div>

      {!recActive && (
        <div
          style={{
            height: PILL_STRIP_CSS,
            width: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
          }}
        >
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              padding: 4,
              background: "rgba(20,20,22,0.78)",
              backdropFilter: "blur(10px)",
              WebkitBackdropFilter: "blur(10px)",
              border: "0.5px solid rgba(255,255,255,0.18)",
              borderRadius: 99,
              boxShadow: "0 4px 14px rgba(0,0,0,0.4)",
            }}
          >
            <button
              title="Turn camera off"
              onClick={() => emit("bubble-close-request").catch(() => {})}
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
              <Icon d={P.x} size={12} stroke={1.5} />
            </button>
          </div>
        </div>
      )}

      {recActive && (
        <div
          style={{
            height: PILL_STRIP_CSS,
            width: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
          }}
        >
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              padding: 4,
              background: "rgba(20,20,22,0.78)",
              backdropFilter: "blur(10px)",
              WebkitBackdropFilter: "blur(10px)",
              border: "0.5px solid rgba(255,255,255,0.18)",
              borderRadius: 99,
              boxShadow: "0 4px 14px rgba(0,0,0,0.4)",
            }}
          >
            <button
              title={recState === "paused" ? "Resume" : "Pause"}
              onClick={() => {
                if (recState === "paused") {
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
              <Icon
                d={recState === "paused" ? P.play : P.pause}
                size={12}
                stroke={1.5}
              />
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
        </div>
      )}
    </div>
  );
}
