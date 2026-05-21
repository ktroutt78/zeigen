import { useEffect, useRef, useState } from "react";

// Canvas-based audio waveform for the review-window Timeline. Decodes the
// recording's audio track via Web Audio, buckets to a fixed-size peak cache,
// and draws mirrored peaks. The decoded PCM is dropped immediately after
// bucketing so the only durable allocation is the ~16KB peak cache.

const PEAK_CACHE_SIZE = 4096;
const SILENCE_THRESHOLD = 0.001;
const CLIPPING_THRESHOLD = 0.98;
const BAR_COLOR = "#6f6f74"; // var(--fg-tertiary)
const CENTERLINE_COLOR = "#4a4a4f"; // var(--fg-quaternary)
const LABEL_FONT =
  '500 11px -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", Arial, sans-serif';

// Resolved on first draw and cached; --warning-tint is the existing amber
// token used by TimerChip / RecordingControlPill.
let cachedClipColor: string | null = null;
function getClipColor(): string {
  if (cachedClipColor !== null) return cachedClipColor;
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue("--warning-tint")
    .trim();
  cachedClipColor = v || "#d4a76a";
  return cachedClipColor;
}

type Props = {
  assetUrl: string | null;
  // V — videoElement.duration in seconds. Used with audioStart to map canvas
  // pixels into audio-time so peaks line up with the playhead. Null until the
  // <video> emits loadedmetadata; render falls back to a/A mapping (the
  // pre-Phase-13 behavior) while null.
  videoDuration: number | null;
  // S — audio-stream start_time in seconds (mic-startup gap before the first
  // CMSampleBuffer reaches the writer; 30–650ms in practice). Null until the
  // probe_audio_track command resolves; render falls back to a/A mapping.
  audioStart: number | null;
};

type State =
  | { kind: "loading" }
  | {
      kind: "ready";
      peaks: Float32Array;
      clipped: Uint8Array;
      maxPeak: number;
      // A — decoded audio-track duration in seconds. Captured at decode time
      // because the per-pixel mapping needs it and the AudioBuffer is dropped
      // immediately after bucketing.
      audioDuration: number;
    }
  | { kind: "empty" };

export default function Waveform({ assetUrl, videoDuration, audioStart }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    if (!assetUrl) {
      setState({ kind: "loading" });
      return;
    }

    let cancelled = false;
    setState({ kind: "loading" });

    const run = async () => {
      let audioBuffer: AudioBuffer | null = null;
      try {
        const res = await fetch(assetUrl);
        const arr = await res.arrayBuffer();
        const ctx = new AudioContext();
        try {
          audioBuffer = await ctx.decodeAudioData(arr);
        } finally {
          ctx.close().catch(() => {});
        }
      } catch {
        if (!cancelled) setState({ kind: "empty" });
        return;
      }

      if (cancelled) return;
      if (!audioBuffer || audioBuffer.numberOfChannels === 0) {
        setState({ kind: "empty" });
        return;
      }

      const channel = audioBuffer.getChannelData(0);
      const audioDuration = audioBuffer.duration;
      const peaks = new Float32Array(PEAK_CACHE_SIZE);
      const clipped = new Uint8Array(PEAK_CACHE_SIZE);
      const samplesPerBucket = channel.length / PEAK_CACHE_SIZE;
      let max = 0;
      for (let i = 0; i < PEAK_CACHE_SIZE; i++) {
        const start = Math.floor(i * samplesPerBucket);
        const end = Math.floor((i + 1) * samplesPerBucket);
        let m = 0;
        for (let j = start; j < end; j++) {
          const v = channel[j];
          const a = v < 0 ? -v : v;
          if (a > m) m = a;
        }
        peaks[i] = m;
        if (m >= CLIPPING_THRESHOLD) clipped[i] = 1;
        if (m > max) max = m;
      }
      // Release the decoded PCM (~10MB/min) — only the 16KB cache survives.
      audioBuffer = null;

      if (cancelled) return;
      setState(
        max < SILENCE_THRESHOLD
          ? { kind: "empty" }
          : { kind: "ready", peaks, clipped, maxPeak: max, audioDuration },
      );
    };

    const idle =
      typeof window !== "undefined" &&
      (window as unknown as { requestIdleCallback?: (cb: () => void) => number })
        .requestIdleCallback;
    if (idle) idle(() => { if (!cancelled) run(); });
    else setTimeout(() => { if (!cancelled) run(); }, 0);

    return () => { cancelled = true; };
  }, [assetUrl]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const draw = () => {
      const rect = container.getBoundingClientRect();
      const w = Math.max(1, Math.floor(rect.width));
      const h = Math.max(1, Math.floor(rect.height));
      const dpr = window.devicePixelRatio || 1;
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
      }
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;

      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const mid = Math.floor(h / 2);

      if (state.kind === "loading") {
        ctx.fillStyle = CENTERLINE_COLOR;
        ctx.fillRect(0, mid, w, 1);
        return;
      }

      if (state.kind === "empty") {
        ctx.fillStyle = CENTERLINE_COLOR;
        ctx.fillRect(0, mid, w, 1);
        ctx.fillStyle = BAR_COLOR;
        ctx.font = LABEL_FONT;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("No microphone", w / 2, mid);
        return;
      }

      const peaks = state.peaks;
      const clipped = state.clipped;
      const norm = 1 / state.maxPeak;
      const half = h / 2;
      const clipColor = getClipColor();
      const A = state.audioDuration;

      const drawBar = (x: number, startB: number, endB: number) => {
        let amp = 0;
        let clip = 0;
        for (let b = startB; b < endB; b++) {
          const v = peaks[b];
          if (v > amp) amp = v;
          if (clipped[b]) clip = 1;
        }
        ctx.fillStyle = clip ? clipColor : BAR_COLOR;
        const barH = Math.max(1, Math.round(amp * norm * half));
        ctx.fillRect(x, mid - barH, 1, barH * 2);
      };

      // V/S-aware mapping: pixel x represents video-time vt = (x/w) * V; the
      // audio sample at vt lives at audio-time at = vt − S. Pixels outside
      // [S, S+A] have no audio and stay blank. Falls back to the old
      // pre-Phase-13 mapping ([0,A] → [0,W]) while props are still null or
      // when S is outside a sane range — fallback matches the original drift
      // bug, which is preferable to a flicker as props resolve.
      const V = videoDuration;
      const S = audioStart;
      if (V != null && S != null && S >= 0 && S < V) {
        const xStart = Math.max(0, Math.ceil((S / V) * w));
        const xEnd = Math.min(w, Math.floor(((S + A) / V) * w));
        for (let x = xStart; x < xEnd; x++) {
          const at = (x / w) * V - S;
          const atNext = ((x + 1) / w) * V - S;
          const startB = Math.floor((at / A) * PEAK_CACHE_SIZE);
          const endB = Math.max(startB + 1, Math.floor((atNext / A) * PEAK_CACHE_SIZE));
          drawBar(x, startB, endB);
        }
      } else {
        for (let x = 0; x < w; x++) {
          const startB = Math.floor((x / w) * PEAK_CACHE_SIZE);
          const endB = Math.max(
            startB + 1,
            Math.floor(((x + 1) / w) * PEAK_CACHE_SIZE),
          );
          drawBar(x, startB, endB);
        }
      }
    };

    draw();
    const ro = new ResizeObserver(() => draw());
    ro.observe(container);
    return () => ro.disconnect();
  }, [state, videoDuration, audioStart]);

  return (
    <div
      ref={containerRef}
      style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
    >
      <canvas
        ref={canvasRef}
        style={{ display: "block", pointerEvents: "none" }}
      />
    </div>
  );
}
