# Zoom manual-editing WYSIWYG plan ("Thread B")

Status (as of 2026-07-14): **Slice 1 done** (`9ff7aea`), **Slice 1.5 done** (`8854413`),
**Slice 2 not started**, **Slice 3 likely unnecessary — reassess first**. Captured from the
July 2026 zoom work where it was called "Thread B" — the complement to the conservative
auto-suggestion detector ("Thread A", committed `7e9e87c`; see DECISIONS.md 2026-07-14).

Slice 1.5 (looped slow preview, not in the original three-slice scope) was added mid-stream
and it time-multiplexes Slice 3's design problem away: paused/selected shows the crop box,
playing the loop shows the zoomed motion, never both at once — so the split-view question
Slice 3 existed to answer no longer needs answering. Before building Slice 3, reassess
whether any of it is still wanted. See DECISIONS.md 2026-07-14 (Thread B).

## Why this exists (the complementarity)

Thread A's conservative detector deliberately stays wide when intent is ambiguous — it
drops bare-click-only cases and vetoes post-click-stillness (see DECISIONS.md). Every one
of those is a zoom the user adds back **by hand**. Thread B makes that hand-editing
painless, so the detector can afford to be conservative. Good manual editing is what
licenses aggressive conservatism in the detector. They were designed as a pair.

## The three complaints it solves ("editing blind")

All three stem from editing a zoom without seeing the video frame you're editing against.

1. **Blind START position.** A zoom's start is set by dragging the `Z` pip/band on the
   14px zoom lane (`SegmentTrack`). Dragging changes `seg.start` but does **not** move the
   playhead or show any frame. The thumbnail preview (`ScrubPreview`) is wired to
   *main-track hover only*, not the zoom lane. So you position a bar on a bare strip with
   zero frame feedback — to see what's at the start you must separately scrub the main
   playhead there.

2. **Guessy DURATION.** Set by dragging the band's two 6px `EdgeHandle`s. Same no-frame
   blindness at the in/out points, **plus** two hidden facts: there's no time or duration
   readout, and the 600ms ramps (`ZOOM_RAMP_S`) mean the actual *held-at-full-zoom* window
   is `dur − 2×ramp` — invisible. You can't see where the zoom reaches full scale vs. where
   it's still ramping, so duration is a guess.

3. **Unintuitive BOUNDING BOX.** When a zoom is selected, `ZoomEditLayer` shows a dashed
   crop rect + dimmed surround + a draggable center crosshair — position editing *is* real
   WYSIWYG. Two gaps: **(a)** there's **no resize handle on the box** — size comes from a
   separate *Scale slider* in the right panel, so "make the framed area bigger" means
   leaving the video, dragging a slider, and watching the rect resize indirectly; **(b)**
   while editing, the video is **held at identity (full frame)** — you see the crop
   *rectangle* but never the actual *zoomed-in result*, so you don't see what the viewer
   will see until you deselect.

## The three slices (sized independently)

### Slice 1 — Timeline frame-feedback (start + duration). SMALL–MEDIUM. Highest value; do first.
Reuse the **existing** thumbnail infra — the `extract_thumb_sprite` Rust command produces a
sprite PNG (`ScrubPreview.tsx`), with an off-screen seeked-`<video>` canvas fallback. Feed
the zoom lane's live drag position as `hoverTime` so the thumbnail shows the start/end frame
as you drag, plus a small time/duration readout on the band. This is wiring drag→hoverTime +
a label; the extraction already exists. This slice alone kills "editing blind" and stands on
its own.

### Slice 2 — Box-resize handles. MEDIUM.
Add corner handles to `ZoomEditLayer` mapping corner-drag → scale (inverse of the crop rect
size). New interaction, but the coordinate math (`contentBox` / `toContentFrac`, the crop
rect) is all already in that component. Removes the "leave the video to drag a slider" step
of complaint 3(a).

### Slice 3 — Edit-time zoom preview. MEDIUM. Design call.
The live-preview transform already exists (the rAF tick in `VideoStage` that CSS-scales the
`<video>`) — it's *deliberately suppressed* while a zoom is selected (video held at identity
so the crop box is visible). Un-suppress it, or show a "full frame + zoomed inset" split.
Solves complaint 3(b). This is a design decision (how to show both the crop box and the
zoomed result at once), not just wiring.

## Overall sizing

**MEDIUM.** All frontend — no backend/pipeline/schema work. The two hardest pieces
(thumbnail extraction, live zoom transform) already exist and just need to be pointed at the
edit flow. Not "polish" (several coordinated stage + lane interactions), not a "real project."

## Recommended sequence

1. Slice 1 (timeline frame-feedback) — enabling UX, small, immediate win.
2. Slice 2 (box-resize handles).
3. Slice 3 (edit-time zoom preview) — the design-heaviest.

## Code anchors (July 2026 state; line numbers approximate — grep the symbols)

- **Zoom lane render** — `src/Review.tsx`, the `<SegmentTrack ... segments={props.zoom.segments}>`
  block (~line 4534, after the auto-dismiss commit). It's a 14px lane; drag = move, edges =
  resize.
- **SegmentTrack** — `src/components/SegmentTrack.tsx`. `onPipDown` (drag whole window,
  duration preserved), `onEdgeDown` + `EdgeHandle` (6px start/end resize). `onChange(i, {start?, end?})`
  updates times but nothing shows a frame.
- **ScrubPreview** — `src/ScrubPreview.tsx`. `extract_thumb_sprite` Rust command → sprite PNG;
  canvas fallback seeks an off-screen `<video>`. Takes `hoverTime` + `trackRect` props. Today
  fed only by main-track hover.
- **ZoomEditLayer** — `src/Review.tsx` (~line 3119). Dashed crop rect + dimmed surround +
  draggable center crosshair; `onCenter(cx, cy)` only — no resize handle.
- **Live preview transform** — `src/Review.tsx` `VideoStage` (~line 2415, the `useEffect` rAF
  `tick`). Suppressed when `zoomEditing` (`selectedIndex != null`) — reset to identity so the
  crop box shows. Un-suppressing this is Slice 3.
- **Right-panel zoom controls** — `src/Review.tsx` (~line 5263). Scale slider
  (`ZOOM_MIN_SCALE 1.1`–`ZOOM_MAX_SCALE 2.5`), Add at playhead, Suggest zooms, Delete.
- **Constants** — `src/Review.tsx` ~line 171: `ZOOM_RAMP_S=0.6`, `ZOOM_MIN_DURATION=0.5`,
  `ZOOM_DEFAULT_DURATION=3`, `ZOOM_DEFAULT_SCALE=2.0`.

## Adjacent backlog items (PLAN.md) worth folding in when this is built

- "Timeline scrubbing — draggable playhead + hover frame preview" (Phase 11 proposed) —
  shares the frame-preview infra with Slice 1.
- "Trim handle hit target too small" — the 6px/10px handles are hard to grab; a transparent
  ~24px padding wrapper helps both trim and zoom-lane edges.
- "Scrub preview thumbnail clips playhead grab dot" — cosmetic, same preview surface.
