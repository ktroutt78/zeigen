import { useRef } from "react";

// Generic timeline track row — time-bounded segments rendered as a mid-point
// pip that drags the whole window (duration preserved) plus, when selected, a
// highlighted band and two edge handles for independent start/end resize.
// Extracted verbatim from Review.tsx's annotation pips (zoom-layer step 3) so
// annotations and the zoom track ride one implementation. The row is a
// full-width absolutely-positioned strip; the container ignores pointer
// events so the timeline underneath keeps its scrub behavior — only pips and
// handles are interactive.

export type TrackSegment = { start: number; end: number };

type SegmentTrackProps = {
  segments: TrackSegment[];
  duration: number;
  selectedIndex: number | null;
  onSelect: (i: number) => void;
  onChange: (i: number, patch: { start?: number; end?: number }) => void;
  label: (i: number) => string;
  // Allowed [min, max] window a segment may occupy. Default is the whole
  // timeline (annotation behavior); the zoom track passes neighbor bounds so
  // segments can't overlap.
  bounds?: (i: number) => { min: number; max: number };
  // Render a muted band for unselected segments too — zoom segments are
  // ranges the user reasons about, so they stay visible on their lane.
  alwaysBand?: boolean;
  minGap?: number;
  // Positions the row inside its relatively-positioned parent (annotations
  // sit at top: -2 overlapping the track strip's top edge).
  style?: React.CSSProperties;
};

export default function SegmentTrack({
  segments,
  duration,
  selectedIndex,
  onSelect,
  onChange,
  label,
  bounds,
  alwaysBand = false,
  minGap = 0.1,
  style,
}: SegmentTrackProps) {
  const rowRef = useRef<HTMLDivElement | null>(null);

  return (
    <div
      ref={rowRef}
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        height: 14,
        pointerEvents: "none",
        ...style,
      }}
    >
      {segments.map((seg, idx) => {
        const mid = (seg.start + seg.end) / 2;
        const pct = (mid / duration) * 100;
        const startPct = (seg.start / duration) * 100;
        const endPct = (seg.end / duration) * 100;
        const selected = selectedIndex === idx;
        const segBounds = () => (bounds ? bounds(idx) : { min: 0, max: duration });
        const onPipDown = (e: React.PointerEvent) => {
          e.stopPropagation();
          e.preventDefault();
          onSelect(idx);
          const row = rowRef.current;
          if (!row) return;
          const rect = row.getBoundingClientRect();
          const startX = e.clientX;
          const startStart = seg.start;
          const startEnd = seg.end;
          const b = segBounds();
          const onMove = (ev: PointerEvent) => {
            const dx = ((ev.clientX - startX) / rect.width) * duration;
            const dur = startEnd - startStart;
            let nextStart = Math.max(b.min, startStart + dx);
            let nextEnd = nextStart + dur;
            if (nextEnd > b.max) {
              nextEnd = b.max;
              nextStart = nextEnd - dur;
            }
            onChange(idx, { start: nextStart, end: nextEnd });
          };
          const onUp = () => {
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
          };
          window.addEventListener("pointermove", onMove);
          window.addEventListener("pointerup", onUp);
        };
        const onEdgeDown = (side: "start" | "end") => (e: React.PointerEvent) => {
          e.stopPropagation();
          e.preventDefault();
          onSelect(idx);
          const row = rowRef.current;
          if (!row) return;
          const rect = row.getBoundingClientRect();
          const fixedStart = seg.start;
          const fixedEnd = seg.end;
          const b = segBounds();
          const onMove = (ev: PointerEvent) => {
            const t = ((ev.clientX - rect.left) / rect.width) * duration;
            if (side === "start") {
              onChange(idx, { start: Math.max(b.min, Math.min(fixedEnd - minGap, t)) });
            } else {
              onChange(idx, { end: Math.min(b.max, Math.max(fixedStart + minGap, t)) });
            }
          };
          const onUp = () => {
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
          };
          window.addEventListener("pointermove", onMove);
          window.addEventListener("pointerup", onUp);
        };
        return (
          <div key={idx}>
            {(selected || alwaysBand) && (
              <div
                style={{
                  position: "absolute",
                  left: `${startPct}%`,
                  width: `${Math.max(0, endPct - startPct)}%`,
                  top: 0,
                  height: 14,
                  background: selected ? "rgba(255,255,255,0.12)" : "rgba(255,255,255,0.05)",
                  border: selected
                    ? "1px solid var(--accent)"
                    : "1px solid var(--border-faint)",
                  borderRadius: 3,
                  pointerEvents: "none",
                }}
              />
            )}
            <div
              onPointerDown={onPipDown}
              style={{
                position: "absolute",
                left: `${pct}%`,
                top: 0,
                transform: "translateX(-50%)",
                cursor: "grab",
                pointerEvents: "auto",
              }}
            >
              <span
                style={{
                  display: "inline-block",
                  width: 14,
                  height: 14,
                  borderRadius: 99,
                  background: selected ? "var(--accent)" : "var(--bg-elevated)",
                  border: "1px solid var(--accent)",
                  color: selected ? "#fff" : "var(--accent)",
                  textAlign: "center",
                  lineHeight: "12px",
                  fontSize: 9,
                  fontWeight: 700,
                  fontFamily: "var(--font-system)",
                }}
              >
                {label(idx)}
              </span>
            </div>
            {selected && (
              <>
                <EdgeHandle pct={startPct} side="start" onPointerDown={onEdgeDown("start")} />
                <EdgeHandle pct={endPct} side="end" onPointerDown={onEdgeDown("end")} />
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

// Per-segment start/end resize handle — same ew-resize visual language as
// the timeline's TrimHandle, scaled down to sit at the segment row.
function EdgeHandle({
  pct,
  side,
  onPointerDown,
}: {
  pct: number;
  side: "start" | "end";
  onPointerDown: (e: React.PointerEvent) => void;
}) {
  return (
    <div
      onPointerDown={onPointerDown}
      style={{
        position: "absolute",
        left: `${pct}%`,
        top: 0,
        width: 6,
        height: 14,
        transform: side === "start" ? "translateX(-100%)" : "translateX(0)",
        background: "var(--accent)",
        borderRadius: 2,
        cursor: "ew-resize",
        boxShadow: "0 1px 2px rgba(0,0,0,0.4)",
        touchAction: "none",
        pointerEvents: "auto",
      }}
    />
  );
}
