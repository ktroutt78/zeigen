import { useEffect, useRef, useState } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";

// Floating timeline scrub thumbnail. Phase 11 c6 — companion to the
// track-anywhere drag (c5). Pre-extracts a sprite PNG via the Rust
// `extract_thumb_sprite` command on mount; while that's in flight, falls
// back to an off-screen <video> seeked to hoverTime and painted to canvas.

type ThumbSpriteInfo = {
  sprite_path: string;
  cols: number;
  rows: number;
  thumb_w: number;
  thumb_h: number;
  count: number;
};

type Props = {
  assetUrl: string | null;
  recordingId: string | null;
  sourcePath: string | null;
  duration: number | null;
  hoverTime: number | null;
  trackRect: DOMRect | null;
};

const FALLBACK_W = 160;
const FALLBACK_H = 90;
const ABOVE_TRACK_GAP = 10;
const VIEWPORT_EDGE_PAD = 4;

function fmtTime(s: number): string {
  if (!isFinite(s) || s < 0) return "00:00";
  const m = Math.floor(s / 60);
  const ss = Math.floor(s % 60);
  return `${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

export default function ScrubPreview(props: Props) {
  const [sprite, setSprite] = useState<ThumbSpriteInfo | null>(null);
  const [spriteUrl, setSpriteUrl] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (!props.sourcePath || !props.recordingId) return;
    let cancelled = false;
    setSprite(null);
    setSpriteUrl(null);
    invoke<ThumbSpriteInfo>("extract_thumb_sprite", {
      sourcePath: props.sourcePath,
      recordingId: props.recordingId,
    })
      .then((info) => {
        if (cancelled) return;
        setSprite(info);
        setSpriteUrl(convertFileSrc(info.sprite_path));
      })
      .catch(() => {
        // Canvas fallback covers extraction failure.
      });
    return () => {
      cancelled = true;
    };
  }, [props.sourcePath, props.recordingId]);

  // Canvas fallback: seek the off-screen video to hoverTime, draw on `seeked`.
  useEffect(() => {
    if (sprite) return;
    if (props.hoverTime == null) return;
    const v = videoRef.current;
    const c = canvasRef.current;
    if (!v || !c) return;
    const target = Math.max(0, Math.min(props.duration ?? props.hoverTime, props.hoverTime));
    const onSeeked = () => {
      const ctx = c.getContext("2d");
      if (!ctx) return;
      ctx.drawImage(v, 0, 0, c.width, c.height);
    };
    v.addEventListener("seeked", onSeeked, { once: true });
    try {
      v.currentTime = target;
    } catch {
      v.removeEventListener("seeked", onSeeked);
    }
    return () => v.removeEventListener("seeked", onSeeked);
  }, [props.hoverTime, props.duration, sprite]);

  const usingSprite = sprite != null && spriteUrl != null;
  const thumbW = sprite ? sprite.thumb_w : FALLBACK_W;
  const thumbH = sprite ? sprite.thumb_h : FALLBACK_H;

  const visible =
    props.hoverTime != null && props.duration != null && props.trackRect != null;

  let left = 0;
  let top = 0;
  if (visible) {
    const cursorX =
      props.trackRect!.left +
      (props.hoverTime! / props.duration!) * props.trackRect!.width;
    left = Math.max(
      VIEWPORT_EDGE_PAD,
      Math.min(window.innerWidth - thumbW - VIEWPORT_EDGE_PAD, cursorX - thumbW / 2),
    );
    top = props.trackRect!.top - thumbH - ABOVE_TRACK_GAP;
  }

  let body: React.ReactNode = null;
  if (usingSprite && props.duration != null && props.hoverTime != null) {
    const frac = Math.max(0, Math.min(0.999999, props.hoverTime / props.duration));
    const idx = Math.min(sprite!.count - 1, Math.floor(frac * sprite!.count));
    const col = idx % sprite!.cols;
    const row = Math.floor(idx / sprite!.cols);
    body = (
      <div
        style={{
          width: thumbW,
          height: thumbH,
          backgroundImage: `url("${spriteUrl}")`,
          backgroundPosition: `-${col * thumbW}px -${row * thumbH}px`,
          backgroundRepeat: "no-repeat",
        }}
      />
    );
  } else {
    body = (
      <canvas
        ref={canvasRef}
        width={thumbW}
        height={thumbH}
        style={{ display: "block", width: thumbW, height: thumbH, background: "#000" }}
      />
    );
  }

  return (
    <>
      {!usingSprite && (
        <video
          ref={videoRef}
          src={props.assetUrl ?? undefined}
          muted
          preload="auto"
          playsInline
          style={{
            position: "fixed",
            left: -9999,
            top: -9999,
            width: 1,
            height: 1,
            opacity: 0,
            pointerEvents: "none",
          }}
        />
      )}
      {visible && (
        <div
          style={{
            position: "fixed",
            left,
            top,
            zIndex: 1000,
            pointerEvents: "none",
            borderRadius: 6,
            overflow: "hidden",
            boxShadow: "0 4px 18px rgba(0,0,0,0.6)",
            border: "1px solid rgba(255,255,255,0.08)",
            background: "#000",
          }}
        >
          {body}
          <div
            style={{
              padding: "3px 6px",
              fontSize: 11,
              fontFamily: "var(--font-mono)",
              color: "rgba(255,255,255,0.92)",
              background: "rgba(0,0,0,0.7)",
              textAlign: "center",
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {fmtTime(props.hoverTime ?? 0)}
          </div>
        </div>
      )}
    </>
  );
}
