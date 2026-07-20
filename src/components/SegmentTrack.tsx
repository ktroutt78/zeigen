import { useRef } from "react";

// Generic timeline track row — time-bounded segments rendered as a mid-point
// pip that drags the whole window (duration preserved) plus, when selected, a
// highlighted band and two edge handles for independent start/end resize.
// Drives the zoom lane below the timeline. The row is a full-width
// absolutely-positioned strip; the container ignores pointer events so the
// timeline underneath keeps its scrub behavior — only pips and handles are
// interactive.

export type TrackSegment = { start: number; end: number };

type SegmentTrackProps = {
  segments: TrackSegment[];
  duration: number;
  selectedIndex: number | null;
  // null deselects — a click (no drag) on the already-selected pip toggles off.
  onSelect: (i: number | null) => void;
  onChange: (i: number, patch: { start?: number; end?: number }) => void;
  // Live frame-feedback hook. Fired during a pip/edge drag with the time the
  // user is positioning against (start frame for whole-window moves, the moving
  // edge for resizes) so the caller can drive a scrub thumbnail; null on drag
  // end.
  onDragHover?: (time: number | null) => void;
  label: (i: number) => string;
  // Zoom-lane ramp duration (seconds). When set, each band paints a brighter
  // held-at-full-scale core (dur - 2*ramp) against dimmer ramp shoulders, and
  // the selected band shows a dur/held readout — making the otherwise-invisible
  // ramp reality visible.
  ramp?: number;
  // Allowed [min, max] window a segment may occupy. Default is the whole
  // timeline; the zoom track passes neighbor bounds so segments can't overlap.
  bounds?: (i: number) => { min: number; max: number };
  // Render a muted band for unselected segments too — zoom segments are
  // ranges the user reasons about, so they stay visible on their lane.
  alwaysBand?: boolean;
  minGap?: number;
  // Row height in px (band, held-core, and edge handles span it; the pip badge
  // stays a fixed 14px, vertically centered). Default 14 (the compact lane).
  bandHeight?: number;
  // When set, a click on empty track (not on a pip/handle/band) calls this with
  // the clicked time — the caller adds a segment there. A click landing inside
  // an existing segment's span is the caller's to interpret (select vs. add).
  onAddAt?: (t: number) => void;
  // Positions the row inside its relatively-positioned parent.
  style?: React.CSSProperties;
};

export default function SegmentTrack({
  segments,
  duration,
  selectedIndex,
  onSelect,
  onChange,
  onDragHover,
  label,
  bounds,
  alwaysBand = false,
  minGap = 0.1,
  ramp,
  bandHeight = 14,
  onAddAt,
  style,
}: SegmentTrackProps) {
  const rowRef = useRef<HTMLDivElement | null>(null);
  const pipTop = (bandHeight - 14) / 2;

  return (
    <div
      ref={rowRef}
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        height: bandHeight,
        pointerEvents: "none",
        ...style,
      }}
    >
      {/* Blank-track add surface: sits under the pips/handles (which are
          pointerEvents:auto and stopPropagation), so only clicks on empty track
          or a segment band reach it. A drag is ignored (that's a scrub, not an
          add); a plain click maps x -> time and hands it to onAddAt. */}
      {onAddAt && (
        <div
          onPointerDown={(e) => {
            const row = rowRef.current;
            if (!row) return;
            const rect = row.getBoundingClientRect();
            const startX = e.clientX;
            let moved = false;
            const onMove = (ev: PointerEvent) => {
              if (Math.abs(ev.clientX - startX) > 3) moved = true;
            };
            const onUp = (ev: PointerEvent) => {
              window.removeEventListener("pointermove", onMove);
              window.removeEventListener("pointerup", onUp);
              if (moved) return;
              const t = ((ev.clientX - rect.left) / rect.width) * duration;
              onAddAt(Math.max(0, Math.min(duration, t)));
            };
            window.addEventListener("pointermove", onMove);
            window.addEventListener("pointerup", onUp);
          }}
          style={{
            position: "absolute",
            inset: 0,
            pointerEvents: "auto",
            cursor: "copy",
          }}
        />
      )}
      {segments.map((seg, idx) => {
        const mid = (seg.start + seg.end) / 2;
        const pct = (mid / duration) * 100;
        const startPct = (seg.start / duration) * 100;
        const endPct = (seg.end / duration) * 100;
        const selected = selectedIndex === idx;
        // Ramp reality (zoom lane only): the eased ramps eat `r` off each end,
        // so the window actually held at full scale is `dur - 2*r`. `r` halves
        // for windows shorter than 2*ramp, where held collapses to 0.
        const dur = seg.end - seg.start;
        const r = ramp != null ? Math.min(ramp, dur / 2) : 0;
        const held = Math.max(0, dur - 2 * r);
        const heldStartPct = ((seg.start + r) / duration) * 100;
        const heldEndPct = ((seg.end - r) / duration) * 100;
        const segBounds = () => (bounds ? bounds(idx) : { min: 0, max: duration });
        const onPipDown = (e: React.PointerEvent) => {
          e.stopPropagation();
          e.preventDefault();
          // Toggle-off: a click (no drag) on an already-selected pip deselects.
          // Select on down so an unselected pip can be dragged immediately;
          // remember prior state + track movement to decide toggle on up.
          const wasSelected = selectedIndex === idx;
          let moved = false;
          onSelect(idx);
          const row = rowRef.current;
          if (!row) return;
          const rect = row.getBoundingClientRect();
          const startX = e.clientX;
          const startStart = seg.start;
          const startEnd = seg.end;
          const b = segBounds();
          const onMove = (ev: PointerEvent) => {
            if (Math.abs(ev.clientX - startX) > 3) moved = true;
            const dx = ((ev.clientX - startX) / rect.width) * duration;
            const dur = startEnd - startStart;
            let nextStart = Math.max(b.min, startStart + dx);
            let nextEnd = nextStart + dur;
            if (nextEnd > b.max) {
              nextEnd = b.max;
              nextStart = nextEnd - dur;
            }
            onChange(idx, { start: nextStart, end: nextEnd });
            // Whole-window move: preview the start frame — that's the blind
            // anchor the user is placing.
            onDragHover?.(nextStart);
          };
          const onUp = () => {
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
            onDragHover?.(null);
            if (wasSelected && !moved) onSelect(null);
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
              const ns = Math.max(b.min, Math.min(fixedEnd - minGap, t));
              onChange(idx, { start: ns });
              onDragHover?.(ns);
            } else {
              const ne = Math.min(b.max, Math.max(fixedStart + minGap, t));
              onChange(idx, { end: ne });
              onDragHover?.(ne);
            }
          };
          const onUp = () => {
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
            onDragHover?.(null);
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
                  height: bandHeight,
                  background: selected ? "rgba(255,255,255,0.12)" : "rgba(255,255,255,0.05)",
                  border: selected
                    ? "1px solid var(--zoom)"
                    : "1px solid var(--border-faint)",
                  borderRadius: 3,
                  pointerEvents: "none",
                }}
              />
            )}
            {/* Held-at-full-scale core: brighter accent fill spanning the
                window minus both ramp shoulders, so the dim band ends read as
                "ramping" and the bright middle as "full zoom". */}
            {ramp != null && held > 0 && (selected || alwaysBand) && (
              <div
                style={{
                  position: "absolute",
                  left: `${heldStartPct}%`,
                  width: `${Math.max(0, heldEndPct - heldStartPct)}%`,
                  top: 0,
                  height: bandHeight,
                  background: "var(--zoom)",
                  opacity: selected ? 0.38 : 0.18,
                  borderRadius: 2,
                  pointerEvents: "none",
                }}
              />
            )}
            {/* Duration / held readout — selected band only, so the lane isn't
                cluttered. Updates live as the band is dragged/resized. */}
            {ramp != null && selected && (
              <div
                style={{
                  position: "absolute",
                  left: `${pct}%`,
                  top: -17,
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
                }}
              >
                {dur.toFixed(1)}s · full {held.toFixed(1)}s
              </div>
            )}
            <div
              onPointerDown={onPipDown}
              style={{
                position: "absolute",
                left: `${pct}%`,
                top: pipTop,
                transform: "translateX(-50%)",
                cursor: "grab",
                pointerEvents: "auto",
              }}
            >
              <span
                style={{
                  display: "inline-block",
                  padding: "1px 6px",
                  borderRadius: "var(--r-pill)",
                  background: selected ? "var(--zoom-soft)" : "transparent",
                  color: "var(--zoom)",
                  lineHeight: "12px",
                  fontSize: 9,
                  fontWeight: 600,
                  letterSpacing: "0.03em",
                  fontFamily: "var(--font-system)",
                  opacity: selected ? 1 : 0.9,
                  whiteSpace: "nowrap",
                }}
              >
                {label(idx)}
              </span>
            </div>
            {selected && (
              <>
                <EdgeHandle pct={startPct} side="start" height={bandHeight} onPointerDown={onEdgeDown("start")} />
                <EdgeHandle pct={endPct} side="end" height={bandHeight} onPointerDown={onEdgeDown("end")} />
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
  height,
  onPointerDown,
}: {
  pct: number;
  side: "start" | "end";
  height: number;
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
        height,
        transform: side === "start" ? "translateX(-100%)" : "translateX(0)",
        background: "var(--zoom)",
        borderRadius: 2,
        cursor: "ew-resize",
        boxShadow: "0 1px 2px rgba(0,0,0,0.4)",
        touchAction: "none",
        pointerEvents: "auto",
      }}
    />
  );
}
