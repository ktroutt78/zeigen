# Zeigen — Refreshed UI Spec (v2 skin)

Two screens, one design language. Reference implementations:
- `Capture window - refreshed.html`
- `Review window - refreshed.html`

Both share the same `:root` token block verbatim. Copy it into a global stylesheet and consume via CSS variables — do not hardcode hex values in components.

---

## Design tokens (copy exactly)

```css
:root {
  --font: -apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", "Helvetica Neue", sans-serif;
  --mono: ui-monospace, "SF Mono", Menlo, monospace;

  /* Tonal elevation — sections divide by contrast, NOT by hairline borders */
  --l0: #0d0e11;   /* deepest — video canvas */
  --l1: #16171a;   /* window base, input/track fills */
  --l2: #1e2024;   /* panels: rail, timeline, settings groups */
  --l3: #26282d;   /* cards, tiles, secondary buttons */
  --l4: #303237;   /* hover / active segmented thumb */

  --fg:  #f3f4f6;  /* primary text */
  --fg2: #a9acb3;  /* labels, secondary */
  --fg3: #71747c;  /* hints, metadata, eyebrows */
  --fg4: #4c4f56;  /* faint / disabled */

  --accent: oklch(0.60 0.17 252);            /* electric blue — ONE per screen */
  --accent-bright: oklch(0.66 0.17 252);     /* hover */
  --accent-soft: oklch(0.60 0.17 252 / 0.16);/* selected fill */
  --accent-line: oklch(0.60 0.17 252 / 0.5); /* selected border */

  --zoom: oklch(0.66 0.17 300);              /* violet — zoom markers only */
  --zoom-soft: oklch(0.66 0.17 300 / 0.18);
  --rec: oklch(0.63 0.19 25);                /* red — live/destructive only */

  --r-sm: 6px; --r-md: 9px; --r-lg: 12px;
}
```

---

## Core rules

1. **No hairline borders between regions.** Use elevation steps (l0→l4). A panel is `--l2` floating on the `--l1` window with a gap; cards inside are `--l3`. Contrast does the dividing.
2. **One accent per screen.** Solid `--accent` is reserved for the single primary action (Start Recording / Save). Selections use `--accent-soft` fill + `--accent-line` border. Secondary buttons are `--l3`.
3. **Color meaning is fixed.** Blue = primary/selected. Violet = zoom markers. Red = live recording + destructive (discard). Never reuse blue for zoom or vice versa.
4. **Radii:** inputs/segmented `--r-sm`, cards/tiles/buttons `--r-md`, panels `--r-lg`.
5. **Transitions:** 120ms on background/color/border for hover + selection. Nothing longer in these two screens.

---

## Shared components

**Segmented control** — `--l1` track, 2px padding; active thumb `--l4` + `--fg`; inactive `--fg2`. Used for Countdown, Length cap, Noise reduction, Format, Resolution, Easing, Follow-cursor.

**Panel** — `background: --l2; border-radius: --r-lg; padding: 14px 16px`. Eyebrow title: 10.5px, 600, uppercase, `letter-spacing: 0.08em`, `--fg3`.

**Primary button** — `--accent` bg, white text, `font-weight: 650`, inset top highlight + soft accent glow shadow. Hover → `--accent-bright`.

**Secondary button** — `--l3` bg, `--fg` text. Hover → `--l4`.

**Destructive ghost** — transparent, `--fg3` text. Hover → `--rec` text + `oklch(0.63 0.19 25 / 0.10)` bg.

---

## Capture window specifics

- 560px wide. Three stacked panels: Settings, Source tiles (2×2 grid, not a panel — bare tiles), Devices.
- **Source tiles:** `--l3` bg. Selected = `--accent-soft` bg + `--accent-line` border + icon chip flips to solid `--accent`. Disabled ("Webcam Only — Coming soon") = `opacity: 0.42`.
- **Devices:** label+icon (108px col) / control / optional trailing icon-button. Bubble size is a slider (blue fill). Screen row has a trailing search/picker icon-button.
- **Footer:** "Saves to ~/Movies/Zeigen" (mono path, `--fg2`) on the left; Start Recording primary on the right with a ring-dot glyph.

## Review window specifics

- 1200px wide. Grid `1fr 320px`: player column + right rail.
- **Player column:** video on `--l0` wrap; timeline is a `--l2` panel below.
- **Tool toolbar (replaces old accordion):** 4-up icon+label grid at top of rail — Trim / Bubble / Zoom / Mark. Active tool = `--accent-soft` bg + `--accent-bright` text. Selecting a tool swaps the contextual controls card below it.
- **Timeline:**
  - Waveform dimmed to `opacity: 0.4`, masked to fade top/bottom.
  - **Zoom markers** = violet pins ABOVE the track: tiny level cap (`2×`, `1.5×`) + 2px stem. Hover/active raises opacity to 1. Faint `--zoom-soft` tint bands under the track mark zoom regions.
  - Trim handles = 6px `--accent` bars at both ends.
  - Playhead = white 1.5px line + dot, extends above track through the pins.
  - Small legend by the "Timeline" eyebrow: violet swatch + "Zoom points".
- **Rail export block:** Save (primary) + destination rows (Copy to Clipboard, Export for LinkedIn, Reveal in Finder) as `--l3` cards with icon chip + title + subtitle, optional ⌘-key hints.
- **Footer actions:** Record another (secondary) + Discard recording (destructive ghost).

---

## Zoom timeline — PRESERVE existing behavior (do not redesign)

The current shipped app already has a working zoom timeline: a two-lane layout with a scrubber/trim track on top and a **zoom-region capsule lane** below (the blue pill containing a circled zoom glyph, spanning the start/end of each zoom). **Keep this structure and interaction exactly as it is today.** The ONLY change from the refresh is color:

- Recolor every zoom element from blue to violet using `--zoom` (fill), `--zoom-soft` (region/capsule fill), and full-opacity `--zoom` for the glyph/stem.
- The zoom-region capsule keeps its current shape, drag-to-resize edges, and circled zoom icon — just violet instead of blue.
- Do NOT convert existing zoom capsules into something else or remove the second lane. The violet "pins above the track" in `Review window - refreshed.html` are a visual refinement layered on top of — not a replacement for — the existing capsule lane. If in doubt, match the current app's zoom-timeline mechanics and only swap the color.
- Blue stays reserved for trim handles / primary actions; violet is exclusively zoom. This is what keeps them visually distinct.

## Handoff notes for Claude Code

- The two HTML files are self-contained (inline CSS, inline SVG icons) — read them as the source of truth for exact markup, spacing, and icon paths.
- Everything is `oklch()`. If the target rendering stack can't do `oklch`, sRGB fallbacks: accent `#3b6cf2`, zoom `#a855f7`, rec `#f0523e`.
- Icons are 1.4–1.5px stroke, `stroke-linecap/linejoin: round`, currentColor. Keep that weight — don't swap in a heavier icon set.

---

## Owner deviation (recorded 2026-07-19, Keith)

**Zoom timeline lines:** Do NOT add the row of violet "pin" ticks above the track from
`Review window - refreshed.html`. Keep the current shipped two-lane timeline exactly as it
is today; the ONLY zoom change is recoloring the existing zoom capsule/indicator blue → violet
(`--zoom`). This supersedes the "violet pins ABOVE the track" bullet under *Review window
specifics* — the pins are a wireframe flourish and are out of scope.
