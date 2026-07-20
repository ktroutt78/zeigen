// Zeigen — Tailwind config. Tokens live in src/styles/tokens.css.

/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx,html}"],
  darkMode: "class",
  theme: {
    extend: {
      fontFamily: {
        system: [
          "-apple-system", "BlinkMacSystemFont",
          "SF Pro Text", "SF Pro Display",
          "Helvetica Neue", "Arial", "sans-serif",
        ],
        mono: ["ui-monospace", "SF Mono", "JetBrains Mono", "Menlo", "monospace"],
      },
      fontSize: {
        "micro":   ["10.5px", { lineHeight: "1.4",  letterSpacing: "0.06em" }],
        "caption": ["11px",   { lineHeight: "1.4",  letterSpacing: "0"      }],
        "small":   ["12px",   { lineHeight: "1.4",  letterSpacing: "-0.005em" }],
        "body":    ["13px",   { lineHeight: "1.45", letterSpacing: "-0.005em" }],
        "label":   ["12.5px", { lineHeight: "1.4",  letterSpacing: "-0.005em" }],
        "title":   ["14px",   { lineHeight: "1.35", letterSpacing: "-0.01em"  }],
        "display": ["17px",   { lineHeight: "1.3",  letterSpacing: "-0.015em" }],
      },
      letterSpacing: {
        tightish: "-0.005em",
        tight:    "-0.01em",
        eyebrow:  "0.06em",
      },
      colors: {
        canvas:   "var(--bg-canvas)",
        window:   "var(--bg-window)",
        sidebar:  "var(--bg-sidebar)",
        elevated: "var(--bg-elevated)",
        raised:   "var(--bg-raised)",
        input:    "var(--bg-input)",
        hover:    "var(--bg-hover)",
        active:   "var(--bg-active)",
        "border-faint":  "var(--border-faint)",
        "border-subtle": "var(--border-subtle)",
        "border-strong": "var(--border-strong)",
        fg: {
          DEFAULT:    "var(--fg-primary)",
          primary:    "var(--fg-primary)",
          secondary:  "var(--fg-secondary)",
          tertiary:   "var(--fg-tertiary)",
          quaternary: "var(--fg-quaternary)",
        },
        accent: {
          DEFAULT: "var(--accent)",
          bright:  "var(--accent-bright)",
          soft:    "var(--accent-soft)",
          line:    "var(--accent-line)",
          ring:    "var(--accent-ring)",
          tint:    "var(--accent-tint)",
        },
        recording: {
          DEFAULT: "var(--recording)",
          soft:    "var(--recording-soft)",
          ring:    "var(--recording-ring)",
          tint:    "var(--recording-tint)",
        },
        zoom: {
          DEFAULT: "var(--zoom)",
          soft:    "var(--zoom-soft)",
        },
        success: {
          DEFAULT: "var(--success)",
          soft:    "var(--success-soft)",
          tint:    "var(--success-tint)",
        },
        warning: {
          DEFAULT: "var(--warning)",
          tint:    "var(--warning-tint)",
        },
      },
      spacing: {
        "row":      "9px",
        "row-x":    "14px",
        "pane-x":   "14px",
        "pane-y":   "12px",
        "tile":     "11px",
        "control":  "5px",
      },
      borderRadius: {
        "xs":     "4px",
        "sm":     "6px",
        "DEFAULT":"9px",
        "md":     "9px",
        "lg":     "12px",
        "xl":     "14px",
        "bubble": "999px",
      },
      borderWidth: {
        hair: "0.5px",
        "1":  "1px",
      },
      boxShadow: {
        "ds-sm":  "0 1px 2px rgba(0,0,0,0.4)",
        "ds-md":  "0 8px 24px rgba(0,0,0,0.45), 0 1px 0 rgba(255,255,255,0.04) inset",
        "ds-lg":  "0 30px 80px rgba(0,0,0,0.6), 0 0 0 0.5px rgba(255,255,255,0.08)",
        "ds-xl":  "0 18px 56px rgba(0,0,0,0.55), 0 0 0 0.5px rgba(255,255,255,0.06) inset",
        "ds-accent-ring":   "0 0 0 3px var(--accent-soft), 0 1px 0 rgba(255,255,255,0.12) inset",
        "ds-recording-ring":"0 0 0 3px var(--recording-ring), 0 1px 0 rgba(255,255,255,0.15) inset",
        "ds-accent-glow":   "0 1px 0 rgba(255,255,255,0.14) inset, 0 2px 8px oklch(0.60 0.17 252 / 0.35)",
      },
      backdropBlur: {
        "ds-thin":   "10px",
        "ds-medium": "14px",
        "ds-thick":  "20px",
      },
      transitionDuration: {
        "instant": "80ms",
        "quick":   "120ms",
        "smooth":  "160ms",
        "settle":  "240ms",
      },
      transitionTimingFunction: {
        "ds":         "cubic-bezier(0.4, 0, 0.2, 1)",
        "ds-spring":  "cubic-bezier(0.34, 1.56, 0.64, 1)",
      },
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
