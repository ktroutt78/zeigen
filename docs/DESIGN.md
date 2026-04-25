# Zeigen — Design System

The design system is fully specified in `docs/design/`. This file is the index.

## What to use

- **Tokens:** `docs/design/tokens.css` — copy to `src/styles/tokens.css`
- **Tailwind:** `docs/design/design-system/tailwind.config.js` — merge into project Tailwind config
- **Icons:** `docs/design/icons.jsx` — copy to `src/components/icons.jsx`
- **Capture window:** adapt `docs/design/surfaces/capture-refined.jsx` (the chosen variant)
- **Other surfaces:** `surfaces/review.jsx`, `surfaces/tray.jsx`, `surfaces/webcam-bubble.jsx`

## Identity

Dark + electric blue. macOS-native feel. Accent is `oklch(0.62 0.18 250)`. Recording state uses red `oklch(0.62 0.18 25)`. Success uses green `oklch(0.62 0.13 155)`. All three share lightness 0.62 — keep it that way.

System font stack only. No custom fonts. No light mode.

## Variants

`capture-refined.jsx` is canonical. The other `capture-*.jsx` files (cleanshot, linear, raycast) are reference only — don't ship them, don't delete them.

## Rules

- Match the mockups. Don't reinvent.
- Use tokens, not hardcoded colors.
- Use the named motion durations (instant/quick/smooth/settle). Don't introduce new ones.
- Save path is `~/Movies/Zeigen`.
