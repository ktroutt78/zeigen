// Zeigen — Tailwind v3+ config snippet
// Drop in tailwind.config.{js,ts}. CSS variables live in tokens.css.

/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./src/**/*.{js,ts,jsx,tsx,html}"],
  darkMode: "class",
  theme: {
    extend: {
      // ─── Type ──────────────────────────────────────────────────────────
      fontFamily: {
        system: [
          "-apple-system", "BlinkMacSystemFont",
          "SF Pro Text", "SF Pro Display",
          "Helvetica Neue", "Arial", "sans-serif",
        ],
        mono: ["ui-monospace", "SF Mono", "JetBrains Mono", "Menlo", "monospace"],
      },
      fontSize: {
        // [size, { lineHeight, letterSpacing, fontWeight }]
        "micro":   ["10.5px", { lineHeight: "1.4",  letterSpacing: "0.06em" }], // section eyebrows (UPPERCASE)
        "caption": ["11px",   { lineHeight: "1.4",  letterSpacing: "0"      }], // helper / metadata
        "small":   ["12px",   { lineHeight: "1.4",  letterSpacing: "-0.005em" }], // dense rows
        "body":    ["13px",   { lineHeight: "1.45", letterSpacing: "-0.005em" }], // base
        "label":   ["12.5px", { lineHeight: "1.4",  letterSpacing: "-0.005em" }], // form labels
        "title":   ["14px",   { lineHeight: "1.35", letterSpacing: "-0.01em"  }], // pane titles
        "display": ["17px",   { lineHeight: "1.3",  letterSpacing: "-0.015em" }], // rare — empty states
      },
      letterSpacing: {
        tightish: "-0.005em",
        tight:    "-0.01em",
        eyebrow:  "0.06em",
      },

      // ─── Color ─────────────────────────────────────────────────────────
      // Surfaces use raw vars so theming is centralized.
      colors: {
        // Surfaces
        window:   "var(--bg-window)",
        sidebar:  "var(--bg-sidebar)",
        elevated: "var(--bg-elevated)",
        input:    "var(--bg-input)",
        hover:    "var(--bg-hover)",
        active:   "var(--bg-active)",

        // Borders (1px hairlines)
        "border-faint":  "var(--border-faint)",
        "border-subtle": "var(--border-subtle)",
        "border-strong": "var(--border-strong)",

        // Foreground
        fg: {
          DEFAULT:    "var(--fg-primary)",
          primary:    "var(--fg-primary)",
          secondary:  "var(--fg-secondary)",
          tertiary:   "var(--fg-tertiary)",
          quaternary: "var(--fg-quaternary)",
        },

        // Accent (electric blue) — also exposed via per-element CSS vars
        accent: {
          DEFAULT: "oklch(0.62 0.18 250)",
          soft:    "oklch(0.62 0.18 250 / 0.16)",
          ring:    "oklch(0.62 0.18 250 / 0.30)",
          deep:    "oklch(0.50 0.18 250)",
          tint:    "oklch(0.78 0.14 250)",
        },

        // Status
        recording: {
          DEFAULT: "oklch(0.62 0.18 25)",
          soft:    "oklch(0.62 0.18 25 / 0.14)",
          tint:    "oklch(0.78 0.15 25)",
        },
        success: {
          DEFAULT: "oklch(0.62 0.13 155)",
          soft:    "oklch(0.62 0.13 155 / 0.14)",
          tint:    "oklch(0.82 0.13 155)",
        },

        // Mac traffic-light auths (raw, not for app UI)
        traffic: {
          close: "#ff5f57",
          min:   "#febc2e",
          max:   "#28c840",
        },
      },

      // ─── Spacing — 4px base, dense (Raycast-tight) ─────────────────────
      // Tailwind defaults (1=4px) cover most needs. Named tokens for the
      // recurring values in our surfaces.
      spacing: {
        "row":      "9px",   // settings row vertical padding
        "row-x":    "14px",  // settings row horizontal padding
        "pane-x":   "14px",  // pane outer padding x
        "pane-y":   "12px",  // pane outer padding y
        "tile":     "11px",  // tile internal padding
        "control":  "5px",   // small control internal padding
      },

      // ─── Radius ────────────────────────────────────────────────────────
      borderRadius: {
        "xs":     "4px",   // micro pills, frame chips
        "sm":     "6px",   // inputs, secondary buttons, ghost hover
        "DEFAULT":"8px",   // cards, tiles, control bars
        "md":     "8px",
        "lg":     "10px",  // window chrome corner
        "xl":     "14px",  // floating panels (rare)
        "bubble": "999px", // pills + circular bubble
      },

      // ─── Borders ───────────────────────────────────────────────────────
      borderWidth: {
        hair: "0.5px", // very fine separators (titlebars, tray)
        "1":  "1px",
      },

      // ─── Shadows ───────────────────────────────────────────────────────
      boxShadow: {
        // sm — pressed buttons, inset highlights
        "ds-sm":  "0 1px 2px rgba(0,0,0,0.4)",
        // md — popovers, tray menu
        "ds-md":  "0 8px 24px rgba(0,0,0,0.45), 0 1px 0 rgba(255,255,255,0.04) inset",
        // lg — main app windows
        "ds-lg":  "0 24px 64px rgba(0,0,0,0.55), 0 1px 0 rgba(255,255,255,0.04) inset",
        // xl — tray menu (over wallpaper)
        "ds-xl":  "0 18px 56px rgba(0,0,0,0.55), 0 0 0 0.5px rgba(255,255,255,0.05) inset",
        // glow — recording stop button + accent buttons in pressed state
        "ds-accent-ring":   "0 0 0 3px var(--accent-soft), 0 1px 0 rgba(255,255,255,0.12) inset",
        "ds-recording-ring":"0 0 0 3px oklch(0.62 0.18 25 / 0.25), 0 1px 0 rgba(255,255,255,0.15) inset",
      },

      // ─── Backdrop blur — translucent surfaces ─────────────────────────
      backdropBlur: {
        "ds-thin":   "10px",  // overlays on video
        "ds-medium": "14px",  // dock pill
        "ds-thick":  "20px",  // tray menu (NSMenu vibrancy)
      },

      // ─── Motion ────────────────────────────────────────────────────────
      transitionDuration: {
        "instant": "80ms",   // hover feedback on buttons
        "quick":   "120ms",  // tile selection, toggle thumb
        "smooth":  "160ms",  // border tint, focus ring fade
        "settle":  "240ms",  // surface enter/exit
      },
      transitionTimingFunction: {
        // Standard ease for nearly everything — feels "Mac"
        "ds":         "cubic-bezier(0.4, 0, 0.2, 1)",
        "ds-spring":  "cubic-bezier(0.34, 1.56, 0.64, 1)", // tray reveal only
      },

      // Z-stack — tray + overlays
      zIndex: {
        "ds-window":  "10",
        "ds-overlay": "20",
        "ds-tray":    "30",
        "ds-toast":   "40",
      },
    },
  },
  plugins: [],
};
