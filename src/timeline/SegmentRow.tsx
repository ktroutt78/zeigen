import { useState } from "react";
import type { TimeScale } from "./scale";

// One timeline row of time-bounded segments (the Zoom row, the Blur row). Each
// segment is a full-height block: the whole block drags to move it (duration
// preserved), 12px hit areas inside each edge resize it. Every x<->time
// conversion uses the tracks column's rect (getRect), the same rect the ruler,
// the Video row and the playhead use. The row itself ignores the pointer, so
// bare hover reaches the tracks column's hover-scrub; only blocks (and the
// optional add surface) take presses, and they stopPropagation.

export type TrackSegment = { start: number; end: number };

const MOVE_THRESHOLD_PX = 3;
const EDGE_HIT_PX = 12;
const LABEL_MIN_PX = 28;

type SegmentRowProps = {
  segments: TrackSegment[];
  scale: TimeScale;
  // The tracks column's rect, read at pointerdown.
  getRect: () => DOMRect;
  // The tracks column's width in px (label hiding, handle sizing, shading).
  trackWidth: number;
  selectedIndex: number | null;
  // null deselects: a press without drag on the selected block toggles off.
  onSelect: (i: number | null) => void;
  onChange: (i: number, patch: { start?: number; end?: number }) => void;
  // Fired during a move/resize with the time being positioned (start for a
  // move, the moving edge for a resize) to drive the scrub thumbnail; null at
  // the end.
  onDragHover: (time: number | null) => void;
  label: (i: number) => string;
  // Allowed [min, max] window per segment. Default: the whole recording.
  bounds?: (i: number) => { min: number; max: number };
  minGap?: number;
  // A plain click on empty row space calls this with the clicked time.
  onAddAt?: (t: number) => void;
  // Drawn inside a block behind its label (the zoom row's camera shading).
  background?: (i: number, blockWidth: number) => React.ReactNode;
  color: string;
  colorSoft: string;
};

export default function SegmentRow({
  segments,
  scale,
  getRect,
  trackWidth,
  selectedIndex,
  onSelect,
  onChange,
  onDragHover,
  label,
  bounds,
  minGap = 0.1,
  onAddAt,
  background,
  color,
  colorSoft,
}: SegmentRowProps) {
  const [hovered, setHovered] = useState<number | null>(null);

  const onAddDown = (e: React.PointerEvent) => {
    if (!onAddAt) return;
    e.stopPropagation();
    const rect = getRect();
    const startX = e.clientX;
    let moved = false;
    const onMove = (ev: PointerEvent) => {
      if (Math.abs(ev.clientX - startX) > MOVE_THRESHOLD_PX) moved = true;
    };
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      if (!moved) onAddAt(scale.timeAtClientX(ev.clientX, rect));
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const segBounds = (idx: number) => (bounds ? bounds(idx) : { min: 0, max: scale.duration });

  const onBodyDown = (idx: number) => (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    // Select on down so an unselected block drags at once; a press without
    // drag on an already-selected block deselects on up.
    const wasSelected = selectedIndex === idx;
    onSelect(idx);
    const rect = getRect();
    const startX = e.clientX;
    const startStart = segments[idx].start;
    const dur = segments[idx].end - startStart;
    const b = segBounds(idx);
    let moved = false;
    const onMove = (ev: PointerEvent) => {
      if (!moved && Math.abs(ev.clientX - startX) <= MOVE_THRESHOLD_PX) return;
      moved = true;
      let nextStart = Math.max(b.min, startStart + scale.secondsForPx(ev.clientX - startX, rect));
      let nextEnd = nextStart + dur;
      if (nextEnd > b.max) {
        nextEnd = b.max;
        nextStart = nextEnd - dur;
      }
      onChange(idx, { start: nextStart, end: nextEnd });
      onDragHover(nextStart);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      onDragHover(null);
      if (wasSelected && !moved) onSelect(null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const onEdgeDown = (idx: number, side: "start" | "end") => (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    onSelect(idx);
    const rect = getRect();
    const fixedStart = segments[idx].start;
    const fixedEnd = segments[idx].end;
    const b = segBounds(idx);
    // The handle sits inside the block, so the press lands a few px off the
    // edge; keep that offset or the edge jumps to the pointer on the first move.
    const grab =
      scale.rawTimeAtClientX(e.clientX, rect) - (side === "start" ? fixedStart : fixedEnd);
    const onMove = (ev: PointerEvent) => {
      const t = scale.rawTimeAtClientX(ev.clientX, rect) - grab;
      if (side === "start") {
        const ns = Math.max(b.min, Math.min(fixedEnd - minGap, t));
        onChange(idx, { start: ns });
        onDragHover(ns);
      } else {
        const ne = Math.min(b.max, Math.max(fixedStart + minGap, t));
        onChange(idx, { end: ne });
        onDragHover(ne);
      }
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      onDragHover(null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  // Selected block last so it draws on top where segments overlap (Blur row).
  const order = segments.map((_, i) => i);
  if (selectedIndex != null && selectedIndex < segments.length) {
    order.splice(selectedIndex, 1);
    order.push(selectedIndex);
  }

  return (
    <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
      {onAddAt && (
        <div
          onPointerDown={onAddDown}
          style={{ position: "absolute", inset: 0, pointerEvents: "auto", cursor: "copy" }}
        />
      )}
      {order.map((idx) => {
        const seg = segments[idx];
        const selected = selectedIndex === idx;
        const blockWidth = scale.pxWidth(seg.start, seg.end, trackWidth);
        // Narrow blocks: each handle takes at most a third so the middle still moves.
        const edgeWidth = Math.min(EDGE_HIT_PX, blockWidth / 3);
        const showGrip = selected || hovered === idx;
        return (
          <div
            key={idx}
            onPointerDown={onBodyDown(idx)}
            onPointerEnter={() => setHovered(idx)}
            onPointerLeave={() => setHovered((h) => (h === idx ? null : h))}
            style={{
              position: "absolute",
              left: `${scale.pct(seg.start)}%`,
              width: `${scale.widthPct(seg.start, seg.end)}%`,
              top: 0,
              bottom: 0,
              boxSizing: "border-box",
              background: colorSoft,
              border: `1px solid ${selected ? color : "var(--border-faint)"}`,
              borderRadius: 5,
              cursor: "grab",
              pointerEvents: "auto",
              touchAction: "none",
            }}
          >
            <div style={{ position: "absolute", inset: 0, borderRadius: 4, overflow: "hidden" }}>
              {background?.(idx, blockWidth)}
              <div
                style={{
                  position: "absolute",
                  left: 0,
                  top: 0,
                  bottom: 0,
                  width: 3,
                  background: `color-mix(in oklch, ${color} 65%, black)`,
                }}
              />
              {blockWidth >= LABEL_MIN_PX && (
                <div
                  style={{
                    position: "absolute",
                    left: 8,
                    right: 4,
                    top: 0,
                    bottom: 0,
                    display: "flex",
                    alignItems: "center",
                    fontSize: 10,
                    fontWeight: 600,
                    letterSpacing: "0.02em",
                    color: "var(--fg-primary)",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    pointerEvents: "none",
                  }}
                >
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{label(idx)}</span>
                </div>
              )}
            </div>
            <EdgeHandle side="start" width={edgeWidth} grip={showGrip} color={color} onPointerDown={onEdgeDown(idx, "start")} />
            <EdgeHandle side="end" width={edgeWidth} grip={showGrip} color={color} onPointerDown={onEdgeDown(idx, "end")} />
            {selected && (
              <div
                style={{
                  position: "absolute",
                  left: "50%",
                  top: -19,
                  transform: "translateX(-50%)",
                  pointerEvents: "none",
                  whiteSpace: "nowrap",
                  fontSize: 10,
                  fontFamily: "var(--font-mono)",
                  fontVariantNumeric: "tabular-nums",
                  color: "var(--fg-secondary)",
                  background: "var(--bg-elevated)",
                  border: "1px solid var(--border-faint)",
                  borderRadius: 4,
                  padding: "1px 5px",
                  boxShadow: "0 1px 3px rgba(0,0,0,0.4)",
                  zIndex: 1,
                }}
              >
                {(seg.end - seg.start).toFixed(1)}s
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// Resize hit area inside one edge of a block; the grip shows on hover/selection.
function EdgeHandle({
  side,
  width,
  grip,
  color,
  onPointerDown,
}: {
  side: "start" | "end";
  width: number;
  grip: boolean;
  color: string;
  onPointerDown: (e: React.PointerEvent) => void;
}) {
  return (
    <div
      onPointerDown={onPointerDown}
      style={{
        position: "absolute",
        [side === "start" ? "left" : "right"]: 0,
        top: 0,
        bottom: 0,
        width,
        cursor: "ew-resize",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        touchAction: "none",
      }}
    >
      {grip && (
        <span style={{ width: 3, height: 16, maxWidth: "100%", borderRadius: 2, background: color }} />
      )}
    </div>
  );
}
