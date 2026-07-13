# Review panel redesign — functional checklist

Gate for the accordion right-panel redesign (2026-07-12). Every item must
pass in a real recording session before the redesign is considered done.
The old top toolbar and label-beside-control rows are gone; everything
below exercises the moved controls in their new home.

## Layout (the bugs this redesign exists to fix)

- [ ] No horizontal scrollbar anywhere at default window size (940x640)
- [ ] No horizontal scrollbar or clipped controls at min window size (720x520)
- [ ] "Source" resolution segment fully visible and clickable (MP4 and GIF)
- [ ] All Annotate rows fully visible (Trim, Text, Arrow, Blur, Spotlight, Thumbnail)
- [ ] Panel scrolls vertically (only) when all sections are expanded at min height

## Accordion behavior (exclusive — one section open at a time)

- [ ] First run: only Export expanded
- [ ] Clicking a collapsed section's header opens it and collapses the previous one
- [ ] Clicking the open section's header collapses it (all sections closed)
- [ ] The open section survives closing and reopening a review window
- [ ] Pressing T/A/R/B/S auto-opens Annotate (collapsing the others) and shows the active tool
- [ ] Pressing M auto-opens Annotate and opens the thumbnail popover
- [ ] Footer (Record another / Discard) visible regardless of section state

## Annotation tools (moved from toolbar)

- [ ] Text: T or row click -> place -> type -> renders in preview and saved file
- [ ] Arrow: R -> drag -> renders
- [ ] Blur: B -> drag region -> renders
- [ ] Spotlight: S -> drag region -> renders
- [ ] Thumbnail: M or row click -> popover shows correct frame -> Use this frame -> row shows active state; saved file has the poster
- [ ] Esc cancels tool / deselects; Backspace deletes selection

## Trim — GATE for deleting the Trim row

- [ ] Trim via timeline handles: drag in/out, playback loops within range
- [ ] Trim via I/O keys at playhead
- [ ] Saved file honors trim
- [ ] Header length readout updates to post-trim length

Only after all four pass: delete the disabled Trim row from the Annotate
section (one ToolRow in Review.tsx, marked with a comment pointing here).

## Export / Share / Watermark / lifecycle (re-parented, logic untouched)

- [ ] Save as MP4 (each resolution incl. Source) and GIF (res + fps) works; progress fill renders
- [ ] Cmd+S saves; Cmd+C copies to clipboard; both flash confirmation
- [ ] Export for LinkedIn chain works
- [ ] Reveal in Finder appears post-save and works
- [ ] Watermark: choose/change/remove logo, corner select, apply toggle; preview + saved file match
- [ ] Record another / Discard / close-window modal (Save / Discard / Cancel, Enter = Discard) unchanged
- [ ] Playback: space, arrows, ,/. frame-step, </> speed, scrub, waveform, webcam bubble all unchanged
