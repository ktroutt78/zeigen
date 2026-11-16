import { useCallback, useRef, useState } from "react";
import Waveform from "../Waveform";
import ScrubPreview from "../ScrubPreview";
import type { RedactionEditor, Trim, ZoomEditor } from "../Review";
import { fmt, parseStampFromPath, TRIM_EPS, ZOOM_MIN_DURATION, ZOOM_RAMP_S } from "../reviewShared";
import SegmentTrack from "./SegmentTrack";
import { timeScale } from "./scale";

// The Review window's timeline: header, main track (waveform, trim dimming,
// thumbnail tick, trim handles, playhead), the zoom lane, the redaction lane,
// and the hover scrub preview. All time<->position maths goes through ./scale.

type TimelineProps = {
  assetUrl: string | null;
  sourcePath: string | null;
  videoRef: React.MutableRefObject<HTMLVideoElement | null>;
  duration: number | null;
  currentTime: number;
  trim: Trim | null;
  setTrim: React.Dispatch<React.SetStateAction<Trim | null>>;
  seek: (t: number) => void;
  // Bracket every seek-per-pointermove drag (track scrub, trim handles) so
  // Review can suspend webcam aligns for the duration and do one align at
  // pointer-up.
  onScrubStart: () => void;
  onScrubEnd: () => void;
  audioStart: number | null;
  zoom: ZoomEditor;
  redact: RedactionEditor;
  thumbnailTime: number | null;
};

// Union of redaction intervals for the collapsed overview bar — overlaps merge
// into one continuous span ("is anything redacted here", not which region).
function mergeIntervals(regs: { start: number; end: number }[]): { start: number; end: number }[] {
  const sorted = regs.map((r) => ({ start: r.start, end: r.end })).sort((a, b) => a.start - b.start);
  const out: { start: number; end: number }[] = [];
  for (const iv of sorted) {
    const last = out[out.length - 1];
    if (last && iv.start <= last.end) last.end = Math.max(last.end, iv.end);
    else out.push({ ...iv });
  }
  return out;
}

export default function Timeline(props: TimelineProps) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [hover, setHover] = useState<{ time: number; rect: DOMRect } | null>(null);
  // Redaction lane disclosure: collapsed (merged overview only) vs expanded
  // (overview + an editable row for the selected region). Pure UI chrome.
  const [redactExpanded, setRedactExpanded] = useState(false);
  // Hover-scrub (Model A): true while a bare-hover skim is driving the playhead,
  // so onScrubStart/End fire once per skim session (webcam bubble aligns once at
  // the end, not per tick). Reset when a drag ends so the two stay in sync.
  const skimmingRef = useRef(false);
  const stamp = props.sourcePath ? parseStampFromPath(props.sourcePath) : null;

  const scale = props.duration != null ? timeScale(props.duration) : null;

  const inPct = scale && props.trim != null ? scale.pct(props.trim.in) : 0;
  const outPct = scale && props.trim != null ? scale.pct(props.trim.out) : 100;
  const playPct = scale ? scale.pct(props.currentTime) : 0;

  // Trim with your eyes: the video seeks to follow the handle during drag
  // so the user sees the exact frame they're cutting on. The bound NOT
  // being dragged (fixedIn/fixedOut) is captured once at drag-start rather
  // than read from a functional setTrim updater — it never changes during
  // this gesture, so a plain closure is enough and lets the seek live next
  // to the setTrim call instead of inside a state-updater side effect.
  const startHandleDrag = useCallback(
    (side: "in" | "out") => (e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const track = trackRef.current;
      if (!track || !scale || !props.trim) return;
      const duration = scale.duration;
      const rect = track.getBoundingClientRect();
      const fixedIn = props.trim.in;
      const fixedOut = props.trim.out;
      const video = props.videoRef.current;
      const wasPlaying = !!video && !video.paused;
      video?.pause();
      props.onScrubStart();
      const move = (clientX: number) => {
        const t = scale.rawTimeAtClientX(clientX, rect);
        if (side === "in") {
          const next = Math.max(0, Math.min(fixedOut - 0.1, t));
          props.setTrim({ in: next, out: fixedOut });
          props.seek(next);
        } else {
          const next = Math.min(duration, Math.max(fixedIn + 0.1, t));
          props.setTrim({ in: fixedIn, out: next });
          props.seek(next);
        }
      };
      const onMove = (ev: PointerEvent) => move(ev.clientX);
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        props.onScrubEnd();
        if (wasPlaying) video?.play().catch(() => {});
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [props, scale],
  );

  const onTrackPointerDown = (e: React.PointerEvent) => {
    if (!scale) return;
    const track = trackRef.current;
    if (!track) return;
    const rect = track.getBoundingClientRect();
    const startX = e.clientX;
    const wasPlaying = !props.videoRef.current?.paused;
    let movedPastThreshold = false;
    const seekAt = (clientX: number) => {
      props.seek(scale.timeAtClientX(clientX, rect));
    };
    const onMove = (ev: PointerEvent) => {
      if (!movedPastThreshold && Math.abs(ev.clientX - startX) > 3) {
        movedPastThreshold = true;
        if (wasPlaying) props.videoRef.current?.pause();
        props.onScrubStart();
      }
      if (movedPastThreshold) seekAt(ev.clientX);
      setHover({ time: scale.timeAtClientX(ev.clientX, rect), rect });
    };
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      if (!movedPastThreshold) {
        seekAt(ev.clientX);
      } else {
        props.onScrubEnd();
        // Drag ended the scrub session; keep skim state in sync so the next
        // bare-hover re-arms onScrubStart instead of seeking un-gated.
        skimmingRef.current = false;
        if (wasPlaying) props.videoRef.current?.play().catch(() => {});
      }
      const overTrack =
        ev.clientX >= rect.left &&
        ev.clientX <= rect.right &&
        ev.clientY >= rect.top &&
        ev.clientY <= rect.bottom;
      if (!overTrack) setHover(null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  // Hover-scrub seek: a bare hover (no button) over a PAUSED video moves the
  // playhead + scrubs live via the gated seek (Model A: the playhead follows the
  // cursor and stays where you left it). Paused-only so it never fights playback;
  // gated seek + one-shot onScrubStart keep it from seek-flooding or churning the
  // webcam decoder. Shared by the main track and the zoom lane (same x->time).
  const skimSeek = (clientX: number) => {
    const track = trackRef.current;
    if (!scale || !track) return;
    if (!props.videoRef.current?.paused) {
      // Playing (e.g. Space pressed while hovering): don't scrub over playback,
      // and end any active skim so scrubbingRef doesn't stay set during play.
      endSkim();
      return;
    }
    const rect = track.getBoundingClientRect();
    // HOLD when the pointer is outside the track horizontally. The panel is to the
    // RIGHT, so mousing toward it used to sweep the playhead to the clip end
    // (scale.timeAtClientX clamps to [0, duration]). Freezing on horizontal exit
    // keeps the frame you left — the one "Set to playhead" reads — instead of
    // dragging it to the end as you leave.
    if (clientX < rect.left - 1 || clientX > rect.right + 1) {
      endSkim();
      return;
    }
    if (!skimmingRef.current) {
      skimmingRef.current = true;
      props.onScrubStart();
    }
    props.seek(scale.timeAtClientX(clientX, rect));
  };
  const endSkim = () => {
    if (skimmingRef.current) {
      skimmingRef.current = false;
      props.onScrubEnd();
    }
  };

  const onTrackPointerMove = (e: React.PointerEvent) => {
    if (!scale) return;
    const track = trackRef.current;
    if (!track) return;
    const rect = track.getBoundingClientRect();
    setHover({ time: scale.timeAtClientX(e.clientX, rect), rect });
    if (e.buttons === 0) skimSeek(e.clientX); // hover, not a drag
  };

  const onTrackPointerLeave = () => {
    setHover(null);
    endSkim();
  };

  const trimLen =
    props.trim && props.duration != null ? Math.max(0, props.trim.out - props.trim.in) : null;

  return (
    <div
      style={{
        margin: "8px 12px 12px",
        padding: "12px 16px 14px",
        background: "var(--bg-sidebar)",
        borderRadius: "var(--r-lg)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 6,
        }}
      >
        <span
          style={{
            fontSize: 11,
            color: "var(--fg-tertiary)",
            letterSpacing: "0.04em",
            textTransform: "uppercase",
            fontWeight: 600,
          }}
        >
          Timeline
        </span>
        {props.trim && trimLen != null && props.duration != null && trimLen < props.duration - TRIM_EPS ? (
          <span style={{ fontSize: 11, color: "var(--fg-secondary)", fontFamily: "var(--font-mono)" }}>
            In <span style={{ color: "var(--accent)" }}>{fmt(props.trim.in)}</span> · Out{" "}
            <span style={{ color: "var(--accent)" }}>{fmt(props.trim.out)}</span> · Length {fmt(trimLen)}
          </span>
        ) : (
          <span
            style={{
              fontSize: 11,
              color: "var(--fg-tertiary)",
              fontFamily: "var(--font-mono)",
            }}
          >
            {fmt(props.duration)}
          </span>
        )}
      </div>

      <div
        ref={trackRef}
        onPointerDown={onTrackPointerDown}
        onPointerMove={onTrackPointerMove}
        onPointerLeave={onTrackPointerLeave}
        style={{ position: "relative", height: 44, marginTop: 6, cursor: "pointer", touchAction: "none" }}
      >
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: 4,
            bottom: 4,
            borderRadius: 5,
            border: "1px solid var(--border-faint)",
            overflow: "hidden",
            background: "rgba(255,255,255,0.02)",
          }}
        >
          <Waveform
            assetUrl={props.assetUrl}
            videoDuration={props.duration}
            audioStart={props.audioStart}
          />
          {/* Dimmed regions outside trim */}
          {props.trim && props.duration != null && (
            <>
              <div
                style={{
                  position: "absolute",
                  left: 0,
                  top: 0,
                  bottom: 0,
                  width: `${inPct}%`,
                  background: "rgba(12,13,16,0.7)",
                }}
              />
              <div
                style={{
                  position: "absolute",
                  right: 0,
                  top: 0,
                  bottom: 0,
                  width: `${100 - outPct}%`,
                  background: "rgba(12,13,16,0.7)",
                }}
              />
            </>
          )}
        </div>

        {/* Thumbnail tick — sits below the track so it doesn't fight the
            playhead/trim handles visually. Click jumps the scrubber to the
            picked frame so the user can verify. Muted color + tooltip when
            the picked time falls outside the active trim range. */}
        {props.thumbnailTime != null && scale && (() => {
          const t = props.thumbnailTime;
          const pct = scale.pct(t);
          const outOfRange =
            props.trim != null &&
            (t < props.trim.in - TRIM_EPS || t > props.trim.out + TRIM_EPS);
          const color = outOfRange ? "var(--fg-tertiary)" : "var(--accent)";
          const title = outOfRange
            ? `Thumbnail at ${t.toFixed(2)}s — outside trim range, save will fall back to a frame inside the trimmed output`
            : `Thumbnail at ${t.toFixed(2)}s — click to jump`;
          return (
            <div
              onPointerDown={(e) => {
                e.stopPropagation();
                e.preventDefault();
                props.seek(t);
              }}
              title={title}
              style={{
                position: "absolute",
                left: `${pct}%`,
                top: "calc(100% + 1px)",
                transform: "translateX(-50%)",
                cursor: "pointer",
                pointerEvents: "auto",
              }}
            >
              <svg
                width={10}
                height={12}
                viewBox="0 0 10 12"
                style={{ display: "block" }}
                aria-hidden
              >
                <path
                  d="M0 0h10v12L5 9.5 0 12z"
                  fill={color}
                  opacity={outOfRange ? 0.6 : 1}
                />
              </svg>
            </div>
          );
        })()}

        {/* Trim handles */}
        {props.trim && props.duration != null && (
          <>
            <TrimHandle pct={inPct} side="in" onPointerDown={startHandleDrag("in")} />
            <TrimHandle pct={outPct} side="out" onPointerDown={startHandleDrag("out")} />
          </>
        )}

        {/* Playhead */}
        <div
          style={{
            position: "absolute",
            left: `${playPct}%`,
            top: -2,
            bottom: -2,
            width: 0,
            borderLeft: "1.5px solid #fff",
            transform: "translateX(-1px)",
            filter: "drop-shadow(0 0 4px rgba(255,255,255,0.4))",
            pointerEvents: "none",
          }}
        >
          <span
            style={{
              position: "absolute",
              top: -6,
              left: -5,
              width: 11,
              height: 11,
              borderRadius: 99,
              background: "#fff",
              boxShadow: "0 1px 4px rgba(0,0,0,0.5)",
            }}
          />
        </div>
      </div>

      {/* Zoom lane — second SegmentTrack row under the main track. Always
          rendered once the duration is known (even with zero zooms) so the
          lane is a standing click-to-add surface: clicking empty track adds
          the first zoom exactly as it adds a later one. Gating it on
          segments.length created a dead end — a no-zoom recording had no lane
          to click and no other way in. marginTop clears the thumbnail tick
          that hangs below the track. Bands stay visible unselected
          (alwaysBand): a zoom is a range the user reasons about, not a point. */}
      {scale && (
        <div
          style={{ position: "relative", height: 44, marginTop: 16 }}
          onPointerMove={(e) => {
            // Hover-scrub over the zoom lane too — same x->time as the main
            // track (uses trackRef's rect). Pips/handles stopPropagation their
            // own pointerdown, so this only fires for bare hover.
            if (e.buttons === 0) skimSeek(e.clientX);
          }}
          onPointerLeave={onTrackPointerLeave}
        >
          {/* Empty-lane affordance: a visible violet strip that makes the
              otherwise-blank lane discoverable and reads as "click to add".
              pointerEvents:none so the click falls through to the
              SegmentTrack add-surface underneath. Disappears once a zoom
              exists (the bands then carry the lane's visibility). */}
          {props.zoom.segments.length === 0 && (
            <div
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                top: 4,
                height: 36,
                border: "1px dashed var(--zoom)",
                background: "var(--zoom-soft)",
                borderRadius: 4,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 11,
                fontWeight: 600,
                letterSpacing: "0.03em",
                color: "var(--zoom)",
                opacity: 0.85,
                pointerEvents: "none",
              }}
            >
              Click to add a zoom
            </div>
          )}
          <SegmentTrack
            segments={props.zoom.segments}
            scale={scale}
            selectedIndex={props.zoom.selectedIndex}
            onSelect={props.zoom.select}
            onAddAt={props.zoom.addAt}
            bandHeight={36}
            onChange={(i, p) => props.zoom.update(i, p)}
            onDragHover={(t) => {
              const track = trackRef.current;
              if (t == null || !track) {
                setHover(null);
                return;
              }
              // Reuse the main-track scrub preview: show the dragged zoom time's
              // frame above the timeline at that x. The main track isn't hovered
              // during a zoom-lane drag, so borrowing its rect + hover state is
              // safe and needs no second ScrubPreview.
              setHover({ time: t, rect: track.getBoundingClientRect() });
            }}
            label={(i) => props.zoom.segments[i]?.reason ?? "zoom"}
            bounds={props.zoom.bounds}
            alwaysBand
            minGap={ZOOM_MIN_DURATION}
            ramp={ZOOM_RAMP_S}
            style={{ top: 4 }}
          />
        </div>
      )}

      {/* Redaction lane (teal, distinct from the violet zoom lane). Collapsed:
          a merged read-only overview bar (where anything is redacted). Expanded:
          the overview plus one editable SegmentTrack row bound to the SELECTED
          region — the "overview + focus" model. No bounds (redactions overlap
          freely) and no ramp. Regions are drawn on the video; this lane trims
          timing. */}
      {props.redact.regions.length > 0 && scale && (
        <div style={{ position: "relative", marginTop: 16 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, height: 14, marginBottom: 2 }}>
            <button
              onClick={() => setRedactExpanded((v) => !v)}
              title={redactExpanded ? "Collapse redaction lane" : "Expand to edit each region's range"}
              style={{
                width: 16, height: 14, padding: 0, lineHeight: "14px", fontSize: 9,
                background: "transparent", border: "none", color: "var(--redact)", cursor: "pointer",
              }}
            >
              {redactExpanded ? "▾" : "▸"}
            </button>
            <span style={{ fontSize: 9, letterSpacing: "0.06em", color: "var(--redact)", fontWeight: 600 }}>
              REDACTIONS
            </span>
          </div>
          {/* Merged overview — read-only; the playhead skims over it like the track. */}
          <div
            style={{ position: "relative", height: 10 }}
            onPointerMove={(e) => { if (e.buttons === 0) skimSeek(e.clientX); }}
            onPointerLeave={onTrackPointerLeave}
          >
            {mergeIntervals(props.redact.regions).map((iv, k) => (
              <div
                key={k}
                style={{
                  position: "absolute",
                  left: `${scale.pct(iv.start)}%`,
                  width: `${scale.widthPct(iv.start, iv.end)}%`,
                  top: 0, height: 10,
                  background: "var(--redact-soft)",
                  border: "1px solid var(--redact)",
                  borderRadius: 3,
                  pointerEvents: "none",
                }}
              />
            ))}
          </div>
          {/* Focus edit row — the selected region only, draggable/resizable. */}
          {redactExpanded && (
            <div
              style={{ position: "relative", height: 40, marginTop: 4 }}
              onPointerMove={(e) => { if (e.buttons === 0) skimSeek(e.clientX); }}
              onPointerLeave={onTrackPointerLeave}
            >
              {props.redact.selectedIndex != null && props.redact.regions[props.redact.selectedIndex] ? (
                <SegmentTrack
                  segments={[props.redact.regions[props.redact.selectedIndex]]}
                  scale={scale}
                  selectedIndex={0}
                  onSelect={(i) => { if (i == null) props.redact.select(null); }}
                  onChange={(_i, p) => {
                    const ri = props.redact.selectedIndex;
                    if (ri != null) props.redact.update(ri, p);
                  }}
                  onDragHover={(t) => {
                    const track = trackRef.current;
                    if (t == null || !track) { setHover(null); return; }
                    setHover({ time: t, rect: track.getBoundingClientRect() });
                  }}
                  label={() => `redaction ${(props.redact.selectedIndex ?? 0) + 1}`}
                  alwaysBand
                  bandHeight={36}
                  color="var(--redact)"
                  colorSoft="var(--redact-soft)"
                  style={{ top: 2 }}
                />
              ) : (
                <div style={{ fontSize: 11, color: "var(--fg-tertiary)", padding: "10px 2px" }}>
                  Select a redaction (panel row or its box on the video) to edit its range here.
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <ScrubPreview
        assetUrl={props.assetUrl}
        recordingId={stamp}
        sourcePath={props.sourcePath}
        duration={props.duration}
        hoverTime={hover?.time ?? null}
        trackRect={hover?.rect ?? null}
      />
    </div>
  );
}

function TrimHandle({
  pct,
  side,
  onPointerDown,
}: {
  pct: number;
  side: "in" | "out";
  onPointerDown: (e: React.PointerEvent) => void;
}) {
  return (
    <div
      onPointerDown={onPointerDown}
      style={{
        position: "absolute",
        left: `${pct}%`,
        top: 0,
        bottom: 0,
        transform: side === "in" ? "translateX(-100%)" : "translateX(0)",
        width: 10,
        background: "var(--accent)",
        borderTopLeftRadius: side === "in" ? 4 : 0,
        borderBottomLeftRadius: side === "in" ? 4 : 0,
        borderTopRightRadius: side === "out" ? 4 : 0,
        borderBottomRightRadius: side === "out" ? 4 : 0,
        cursor: "ew-resize",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        boxShadow: "0 1px 2px rgba(0,0,0,0.4)",
        touchAction: "none",
      }}
    >
      <span style={{ width: 1, height: 14, background: "rgba(255,255,255,0.55)" }} />
    </div>
  );
}
