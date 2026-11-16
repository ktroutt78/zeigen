import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import Waveform from "../Waveform";
import { I } from "../components/icons";
import type { RedactionEditor, Trim, ZoomEditor } from "../Review";
import { fmt, TRIM_EPS, ZOOM_MIN_DURATION } from "../reviewShared";
import SegmentRow, { MOVE_THRESHOLD_PX } from "./SegmentRow";
import CameraShade from "./CameraShade";
import { tickLabel, timeScale } from "./scale";

// The Review window's timeline: a header, then a fixed label column beside ONE
// tracks column holding the ruler and the rows (Video, Zoom, and Blur when the
// recording has redactions), with one playhead through all of them. Hovering
// shows that moment in the preview and leaves the playhead alone; a click sets
// the playhead; a drag scrubs it. Every
// time<->position conversion goes through ./scale against the tracks column's
// rect, so all rows line up by construction. Zooming widens the tracks column
// inside a horizontal scroll viewport; the label column stays put.

type TimelineProps = {
  assetUrl: string | null;
  videoRef: React.MutableRefObject<HTMLVideoElement | null>;
  duration: number | null;
  trim: Trim | null;
  setTrim: React.Dispatch<React.SetStateAction<Trim | null>>;
  // The playhead (not the frame the preview happens to show), see Review.
  getPlayhead: () => number;
  setPlayhead: (t: number) => void;
  // Show a moment in the preview without moving the playhead; null ends it.
  previewAt: (t: number | null) => void;
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

const LABEL_COL_W = 84;
const RULER_H = 18;
const ROW_H = 36;
const ROW_GAP = 6;
// The scroll viewport reaches this far past each end of the tracks column so
// trim handles and labels that stick out past 0 or the end are not clipped.
const EDGE_PAD = 12;
// Zoom controls: buttons step by ZOOM_STEP; the slider is logarithmic.
const ZOOM_STEP = 1.5;
const SLIDER_STEPS = 1000;
// Following the playhead: page once it passes FOLLOW_PAGE_AT of the view,
// landing it at FOLLOW_LAND_AT.
const FOLLOW_PAGE_AT = 0.9;
const FOLLOW_LAND_AT = 0.1;

const labelStyle: React.CSSProperties = {
  fontSize: 11,
  color: "var(--fg-tertiary)",
  letterSpacing: "0.04em",
  textTransform: "uppercase",
  fontWeight: 600,
};

const rowBg: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  borderRadius: 6,
  border: "1px solid var(--border-faint)",
  background: "rgba(255,255,255,0.03)",
};

const zoomButton: React.CSSProperties = {
  padding: "2px 4px",
  display: "inline-flex",
  color: "var(--fg-secondary)",
};

// "1.7x", "2x": one decimal, no trailing ".0".
const fmtScale = (s: number) => `${Number(s.toFixed(1))}x`;

export default function Timeline(props: TimelineProps) {
  const tracksRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [trackWidth, setTrackWidth] = useState(0);
  const [viewportWidth, setViewportWidth] = useState(0);
  const [hover, setHover] = useState<number | null>(null);
  const playheadRef = useRef<HTMLDivElement | null>(null);
  // Zoom factor: the tracks column is zoom x the viewport's width (1 = fit).
  // zoomRef is the latest requested value, ahead of the render, so a burst of
  // pinch events compounds; anchorRef is the moment to keep under the pointer
  // once the new width is laid out.
  const [zoomState, setZoomState] = useState(1);
  const zoomRef = useRef(1);
  const anchorRef = useRef<{ t: number; clientX: number; origin: number } | null>(null);

  // The playhead line is positioned every frame straight from the playhead, so
  // it glides during playback instead of stepping with the video's progress
  // events. While playing zoomed in, the view pages to keep the playhead in sight.
  const { duration, getPlayhead, videoRef } = props;
  useEffect(() => {
    if (duration == null) return;
    const s = timeScale(duration);
    let raf = 0;
    const tick = () => {
      const t = getPlayhead();
      if (playheadRef.current) playheadRef.current.style.left = `${s.pct(t)}%`;
      const vp = viewportRef.current;
      if (videoRef.current?.paused === false && zoomRef.current > 1 && vp && tracksRef.current) {
        const vr = vp.getBoundingClientRect();
        const rect = tracksRef.current.getBoundingClientRect();
        const x = rect.left + s.xAt(t, rect.width);
        if (x < vr.left || x > vr.left + vr.width * FOLLOW_PAGE_AT)
          vp.scrollLeft += x - (vr.left + vr.width * FOLLOW_LAND_AT);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [duration, getPlayhead, videoRef]);

  useEffect(() => {
    const el = tracksRef.current;
    if (!el) return;
    const update = () => setTrackWidth(el.getBoundingClientRect().width);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // The viewport's content-box width sets the zoom range. Its width comes
  // from the layout around it, never from the tracks column inside, so this
  // and the tracks observer cannot feed each other.
  useEffect(() => {
    const vp = viewportRef.current!;
    const ro = new ResizeObserver(([e]) => setViewportWidth(e.contentRect.width));
    ro.observe(vp);
    return () => ro.disconnect();
  }, []);

  // The one rect every x<->time conversion in the timeline uses.
  const getRect = () => tracksRef.current!.getBoundingClientRect();

  const scale = props.duration != null ? timeScale(props.duration) : null;

  // Clamped at render, so a narrower window lowers the zoom without an effect.
  const maxZoom = scale ? scale.maxZoom(viewportWidth) : 1;
  const zoom = Math.min(zoomState, maxZoom);
  const canZoom = maxZoom > 1;

  // Zoom to `next`, keeping the moment at `clientX` where it is on screen.
  const zoomTo = (next: number, clientX: number) => {
    const cur = Math.min(zoomRef.current, maxZoom);
    const z = Math.max(1, Math.min(maxZoom, next));
    if (!scale || z === cur) return;
    const rect = getRect();
    // origin: the tracks column's left edge at scroll 0, unchanged by zoom.
    anchorRef.current = {
      t: scale.rawTimeAtClientX(clientX, rect),
      clientX,
      origin: rect.left + viewportRef.current!.scrollLeft,
    };
    zoomRef.current = z;
    setZoomState(z);
  };

  // After the new width is laid out, scroll so the anchored moment is back
  // under its screen x. getRect() here reads the new width.
  useLayoutEffect(() => {
    const a = anchorRef.current;
    if (!a || !scale) return;
    anchorRef.current = null;
    viewportRef.current!.scrollLeft = a.origin + scale.xAt(a.t, getRect().width) - a.clientX;
  }, [zoom]);

  // Cmd+scroll (or ctrl+wheel) and pinch zoom around the pointer;
  // plain scrolling is left to the viewport, which pans. React's onWheel is
  // passive, so this listener is attached by hand to be able to preventDefault.
  const zoomByWheel = useRef<(e: WheelEvent) => void>(() => {});
  zoomByWheel.current = (e) =>
    zoomTo(Math.min(zoomRef.current, maxZoom) * Math.exp(-e.deltaY * 0.01), e.clientX);
  const zoomByGesture = useRef<(z: number, clientX: number) => void>(() => {});
  zoomByGesture.current = zoomTo;
  useEffect(() => {
    const vp = viewportRef.current!;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      zoomByWheel.current(e);
    };
    // WKWebView reports a trackpad pinch as gesture events carrying a scale
    // relative to the gesture's start, not as ctrl+wheel.
    let base = 1;
    const onGestureStart = (e: Event) => {
      e.preventDefault();
      base = zoomRef.current;
    };
    const onGestureChange = (e: Event) => {
      e.preventDefault();
      const g = e as Event & { scale: number; clientX: number };
      zoomByGesture.current(base * g.scale, g.clientX);
    };
    vp.addEventListener("wheel", onWheel, { passive: false });
    vp.addEventListener("gesturestart", onGestureStart);
    vp.addEventListener("gesturechange", onGestureChange);
    return () => {
      vp.removeEventListener("wheel", onWheel);
      vp.removeEventListener("gesturestart", onGestureStart);
      vp.removeEventListener("gesturechange", onGestureChange);
    };
  }, []);

  // Slider and buttons zoom around the playhead when it is in view, otherwise
  // around the middle of the view.
  const controlAnchor = () => {
    const vr = viewportRef.current!.getBoundingClientRect();
    const rect = getRect();
    const x = rect.left + scale!.xAt(getPlayhead(), rect.width);
    return x >= vr.left && x <= vr.right ? x : vr.left + vr.width / 2;
  };
  const sliderValue = canZoom ? Math.round((Math.log(zoom) / Math.log(maxZoom)) * SLIDER_STEPS) : 0;

  const inPct = scale && props.trim != null ? scale.pct(props.trim.in) : 0;
  const outPct = scale && props.trim != null ? scale.pct(props.trim.out) : 100;

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
      const track = tracksRef.current;
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
        const next =
          side === "in"
            ? Math.max(0, Math.min(fixedOut - 0.1, t))
            : Math.min(duration, Math.max(fixedIn + 0.1, t));
        props.setTrim(side === "in" ? { in: next, out: fixedOut } : { in: fixedIn, out: next });
        props.setPlayhead(next);
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

  // Anywhere on the tracks that is not a segment: a click sets the playhead,
  // press+drag scrubs it. A click on a row's add ghost adds a segment instead
  // (SegmentRow handles that), so it leaves the playhead alone.
  const onTrackPointerDown = (e: React.PointerEvent) => {
    if (!scale) return;
    const rect = getRect();
    const startX = e.clientX;
    const wasPlaying = !props.videoRef.current?.paused;
    const onGhost = (e.target as Element).closest("[data-adds-on-click]") != null;
    let dragging = false;
    setHover(null);
    const onMove = (ev: PointerEvent) => {
      if (!dragging && Math.abs(ev.clientX - startX) > MOVE_THRESHOLD_PX) {
        dragging = true;
        if (wasPlaying) props.videoRef.current?.pause();
        props.onScrubStart();
      }
      if (dragging) props.setPlayhead(scale.timeAtClientX(ev.clientX, rect));
    };
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      if (!dragging && !onGhost) props.setPlayhead(scale.timeAtClientX(ev.clientX, rect));
      props.onScrubEnd();
      if (dragging && wasPlaying) props.videoRef.current?.play().catch(() => {});
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  // Bare hover: the hover line follows the mouse and the preview shows that
  // moment (Review ignores the preview while playing). Drags handle themselves.
  const onTracksPointerMove = (e: React.PointerEvent) => {
    if (!scale || e.buttons !== 0) return;
    const t = scale.timeAtClientX(e.clientX, getRect());
    setHover(t);
    props.previewAt(t);
  };

  const onTracksPointerLeave = () => {
    setHover(null);
    props.previewAt(null);
  };

  // A segment being moved or resized: preview the edge being placed.
  const onDragHover = (t: number | null) => props.previewAt(t);

  const trimLen =
    props.trim && props.duration != null ? Math.max(0, props.trim.out - props.trim.in) : null;

  const hasBlur = props.redact.regions.length > 0;
  const rows: { name: string; icon: React.ReactNode }[] = [
    { name: "Video", icon: I.video },
    { name: "Zoom", icon: I.zoomIn },
    ...(hasBlur ? [{ name: "Blur", icon: I.blur }] : []),
  ];

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
        <span style={labelStyle}>Timeline</span>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 4, opacity: canZoom ? 1 : 0.4 }}>
            <button
              className="btn-ghost"
              style={zoomButton}
              disabled={!canZoom}
              title="Zoom out"
              onClick={() => zoomTo(zoom / ZOOM_STEP, controlAnchor())}
            >
              {I.zoomOut}
            </button>
            <input
              type="range"
              className="slider"
              min={0}
              max={SLIDER_STEPS}
              value={sliderValue}
              disabled={!canZoom}
              onChange={(e) =>
                zoomTo(maxZoom ** (Number(e.target.value) / SLIDER_STEPS), controlAnchor())
              }
              style={
                {
                  width: 96,
                  display: "block",
                  "--fill": `${(sliderValue / SLIDER_STEPS) * 100}%`,
                } as React.CSSProperties
              }
            />
            <button
              className="btn-ghost"
              style={zoomButton}
              disabled={!canZoom}
              title="Zoom in"
              onClick={() => zoomTo(zoom * ZOOM_STEP, controlAnchor())}
            >
              {I.zoomIn}
            </button>
            <button
              className="btn-ghost"
              style={{ ...zoomButton, fontSize: 11 }}
              disabled={!canZoom}
              title="Fit the whole recording"
              onClick={() => zoomTo(1, controlAnchor())}
            >
              Fit
            </button>
          </div>
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
      </div>

      <div style={{ display: "flex" }}>
        {/* Label column: one entry per row, same heights as the tracks column. */}
        <div style={{ width: LABEL_COL_W, flexShrink: 0, paddingTop: RULER_H }}>
          {rows.map((r) => (
            <div
              key={r.name}
              style={{
                ...labelStyle,
                height: ROW_H,
                marginTop: ROW_GAP,
                display: "flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              {r.icon}
              {r.name}
            </div>
          ))}
        </div>

        {/* Scroll viewport around the tracks column. It reaches EDGE_PAD past
            the column on each side (negative margin, same padding) so the
            layout is unchanged and edge handles are not clipped. */}
        <div
          ref={viewportRef}
          style={{
            flex: 1,
            minWidth: 0,
            overflowX: "auto",
            overflowY: "hidden",
            margin: `0 -${EDGE_PAD}px`,
            padding: `0 ${EDGE_PAD}px`,
          }}
        >
          {/* Tracks column: ruler + rows + playhead, one rect for all of them.
              zoom x the viewport's width; its rect moves and grows with scroll
              and zoom, so every conversion against it needs no zoom maths. */}
          <div
            ref={tracksRef}
            onPointerDown={onTrackPointerDown}
            onPointerMove={onTracksPointerMove}
            onPointerLeave={onTracksPointerLeave}
            style={{ position: "relative", width: `${zoom * 100}%`, touchAction: "none", cursor: "pointer" }}
          >
            {/* Ruler */}
            <div style={{ position: "relative", height: RULER_H }}>
              {scale &&
                trackWidth > 0 &&
                scale.ticks(trackWidth).map((t) => (
                  <div
                    key={t}
                    style={{
                      position: "absolute",
                      left: `${scale.pct(t)}%`,
                      top: 0,
                      bottom: 0,
                      borderLeft: "1px solid var(--border-faint)",
                      pointerEvents: "none",
                    }}
                  >
                    {/* Label only where it fits before the right edge. */}
                    {scale.pxWidth(t, scale.duration, trackWidth) >= 32 && (
                      <span
                        style={{
                          position: "absolute",
                          left: 3,
                          top: 2,
                          fontSize: 9,
                          lineHeight: "10px",
                          fontFamily: "var(--font-mono)",
                          fontVariantNumeric: "tabular-nums",
                          color: "var(--fg-tertiary)",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {tickLabel(t)}
                      </span>
                    )}
                  </div>
                ))}
            </div>

            {/* Video row: waveform, trim dimming, thumbnail tick, trim handles. */}
            <div
              style={{ position: "relative", height: ROW_H, marginTop: ROW_GAP, cursor: "pointer" }}
            >
              <div style={{ ...rowBg, overflow: "hidden" }}>
                <Waveform
                  assetUrl={props.assetUrl}
                  videoDuration={props.duration}
                  audioStart={props.audioStart}
                />
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

              {/* Thumbnail tick, inside the row's bottom edge. Click jumps the
                  scrubber to the picked frame so the user can verify. Muted color
                  + tooltip when the picked time falls outside the active trim. */}
              {props.thumbnailTime != null && scale && (() => {
                const t = props.thumbnailTime;
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
                      props.setPlayhead(t);
                    }}
                    title={title}
                    style={{
                      position: "absolute",
                      left: `${scale.pct(t)}%`,
                      bottom: 0,
                      transform: "translateX(-50%)",
                      cursor: "pointer",
                    }}
                  >
                    <svg width={10} height={12} viewBox="0 0 10 12" style={{ display: "block" }} aria-hidden>
                      <path d="M0 0h10v12L5 9.5 0 12z" fill={color} opacity={outOfRange ? 0.6 : 1} />
                    </svg>
                  </div>
                );
              })()}

              {props.trim && props.duration != null && (
                <>
                  <TrimHandle pct={inPct} side="in" onPointerDown={startHandleDrag("in")} />
                  <TrimHandle pct={outPct} side="out" onPointerDown={startHandleDrag("out")} />
                </>
              )}
            </div>

            {/* Zoom row. Always present once the duration is known; hovering
                empty space shows the zoom a click would add. */}
            <div style={{ position: "relative", height: ROW_H, marginTop: ROW_GAP }}>
              <div style={rowBg} />
              {scale && (
                <SegmentRow
                  segments={props.zoom.segments}
                  scale={scale}
                  getRect={getRect}
                  trackWidth={trackWidth}
                  selectedIndex={props.zoom.selectedIndex}
                  onSelect={props.zoom.select}
                  ghost={{ place: props.zoom.place, add: props.zoom.addAt }}
                  onChange={(i, p) => props.zoom.update(i, p)}
                  onDragHover={onDragHover}
                  label={(i) => {
                    const s = props.zoom.segments[i];
                    return `${s.reason ?? "Zoom"} ${fmtScale(s.scale)}`;
                  }}
                  bounds={props.zoom.bounds}
                  minGap={ZOOM_MIN_DURATION}
                  background={(i, blockWidth) => {
                    const camera = props.zoom.camera;
                    const s = props.zoom.segments[i];
                    return camera ? (
                      <CameraShade
                        camera={camera}
                        start={s.start}
                        end={s.end}
                        peak={s.scale}
                        blockWidth={blockWidth}
                        color="var(--zoom)"
                      />
                    ) : null;
                  }}
                  color="var(--zoom)"
                  colorSoft="var(--zoom-soft)"
                />
              )}
            </div>

            {/* Blur row: every redaction region, free to overlap (no bounds). */}
            {hasBlur && (
              <div style={{ position: "relative", height: ROW_H, marginTop: ROW_GAP }}>
                <div style={rowBg} />
                {scale && (
                  <SegmentRow
                    segments={props.redact.regions}
                    scale={scale}
                    getRect={getRect}
                    trackWidth={trackWidth}
                    selectedIndex={props.redact.selectedIndex}
                    onSelect={props.redact.select}
                    onChange={(i, p) => props.redact.update(i, p)}
                    onDragHover={onDragHover}
                    label={(i) => `Blur ${i + 1}`}
                    color="var(--redact)"
                    colorSoft="var(--redact-soft)"
                  />
                )}
              </div>
            )}

            {/* Hover line: where a click would put the playhead. */}
            {hover != null && scale && (
              <div
                style={{
                  position: "absolute",
                  left: `${scale.pct(hover)}%`,
                  top: 0,
                  bottom: 0,
                  borderLeft: "1px solid var(--fg-tertiary)",
                  pointerEvents: "none",
                  zIndex: 1,
                }}
              />
            )}

            {/* Playhead: one line through the ruler and every row, head in the ruler. */}
            <div
              ref={playheadRef}
              style={{
                position: "absolute",
                left: 0,
                top: 4,
                bottom: 0,
                width: 0,
                borderLeft: "1.5px solid #fff",
                transform: "translateX(-1px)",
                filter: "drop-shadow(0 0 4px rgba(255,255,255,0.4))",
                pointerEvents: "none",
                zIndex: 2,
              }}
            >
              <span
                style={{
                  position: "absolute",
                  top: -2,
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
        </div>
      </div>

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
