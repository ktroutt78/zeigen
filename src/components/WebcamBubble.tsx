import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { Icon, P } from "./icons";
import { useCornerSnap } from "../hooks/useCornerSnap";
import { useBubblePositionLog } from "../hooks/useBubblePositionLog";
import { useRecordingState } from "../hooks/useRecordingState";
import TimerChip from "./TimerChip";
import { PILL_STRIP_CSS } from "../constants/bubble";

type Octant =
  | "East"
  | "North"
  | "NorthEast"
  | "NorthWest"
  | "South"
  | "SouthEast"
  | "SouthWest"
  | "West";

// Eight-octant direction from a click on the circle's edge. atan2 gives
// angle in [-π, π] with 0 along +x; screen-Y points down, so SE is +π/4.
function octantForAngle(rad: number): Octant {
  const oct = Math.round(rad / (Math.PI / 4));
  const norm = ((oct % 8) + 8) % 8;
  return (
    [
      "East",
      "SouthEast",
      "South",
      "SouthWest",
      "West",
      "NorthWest",
      "North",
      "NorthEast",
    ] as Octant[]
  )[norm];
}

function cursorForOctant(d: Octant): string {
  switch (d) {
    case "East":
    case "West":
      return "ew-resize";
    case "North":
    case "South":
      return "ns-resize";
    case "NorthEast":
    case "SouthWest":
      return "nesw-resize";
    case "NorthWest":
    case "SouthEast":
      return "nwse-resize";
  }
}

const BUBBLE_MIN_DIAM = 120;
const BUBBLE_MAX_DIAM = 800;

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
  const [ringCursor, setRingCursor] = useState<string>("nwse-resize");

  useCornerSnap();
  useBubblePositionLog();
  const { state: recState, elapsed, capSec } = useRecordingState();

  const onRingMove = (e: React.PointerEvent<SVGPathElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const angle = Math.atan2(e.clientY - cy, e.clientX - cx);
    setRingCursor(cursorForOctant(octantForAngle(angle)));
  };

  // macOS has no native "start resize drag" API for transparent
  // decoration-less windows (Tauri's startResizeDragging silently no-ops),
  // so drive the resize by hand: every pointermove sets the new diameter
  // such that the cursor stays at the circle's edge, and re-anchors the
  // window so the circle's center stays put. Pointer capture keeps events
  // flowing even when the mouse moves outside the bubble window's bounds.
  const onRingDown = (e: React.PointerEvent<SVGPathElement>) => {
    e.stopPropagation();
    e.preventDefault();
    const target = e.currentTarget;
    const pointerId = e.pointerId;

    void (async () => {
      const win = getCurrentWebviewWindow();
      const dpr = window.devicePixelRatio || 1;
      const initialPos = await win.outerPosition();
      const initialSize = await win.outerSize();
      const initialDiamLogical = initialSize.width / dpr;
      // Circle is anchored at the top of the window with the pill strip
      // below; circle center y is therefore (windowTop + diameter/2).
      const centerXLogical = initialPos.x / dpr + initialDiamLogical / 2;
      const centerYLogical = initialPos.y / dpr + initialDiamLogical / 2;

      try {
        target.setPointerCapture(pointerId);
      } catch {
        // best effort
      }

      const onMove = (ev: PointerEvent) => {
        const dx = ev.screenX - centerXLogical;
        const dy = ev.screenY - centerYLogical;
        const r = Math.hypot(dx, dy);
        const newDiam = Math.max(
          BUBBLE_MIN_DIAM,
          Math.min(BUBBLE_MAX_DIAM, 2 * r),
        );
        const newWidth = newDiam;
        const newHeight = newDiam + PILL_STRIP_CSS;
        const newX = centerXLogical - newDiam / 2;
        const newY = centerYLogical - newDiam / 2;
        win.setSize(new LogicalSize(newWidth, newHeight)).catch(() => {});
        win
          .setPosition(new LogicalPosition(newX, newY))
          .catch(() => {});
      };

      const cleanup = () => {
        try {
          target.releasePointerCapture(pointerId);
        } catch {
          // best effort
        }
        target.removeEventListener("pointermove", onMove);
        target.removeEventListener("pointerup", cleanup);
        target.removeEventListener("pointercancel", cleanup);
      };

      target.addEventListener("pointermove", onMove);
      target.addEventListener("pointerup", cleanup);
      target.addEventListener("pointercancel", cleanup);
    })();
  };

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

        {/* Annular hit target on the circle's outer edge — pointerdown
            triggers a native macOS resize via Tauri's startResizeDragging,
            with the direction inferred from which octant was clicked. The
            SVG fills the whole bubble box; even-odd path leaves a hole in
            the middle so drag-region (move) still works inside the circle. */}
        <svg
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            pointerEvents: "none",
            overflow: "visible",
          }}
        >
          <path
            d="M 0,50 A 50,50 0 1,1 100,50 A 50,50 0 1,1 0,50 Z M 14,50 A 36,36 0 1,0 86,50 A 36,36 0 1,0 14,50 Z"
            fillRule="evenodd"
            fill={hover ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0)"}
            onPointerDown={onRingDown}
            onPointerMove={onRingMove}
            style={{ pointerEvents: "all", cursor: ringCursor }}
          />
        </svg>

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
