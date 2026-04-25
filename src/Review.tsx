import { useEffect, useState } from "react";
import { Icon, I, P } from "./components/icons";

// Phase 5 review window. Opens on recording stop. Layout mirrors
// docs/design/surfaces/review.jsx — left column is player + timeline + action
// footer, right column is the Phase 6 export panel rendered at full visual
// fidelity but inert (opacity 0.4, pointer-events: none, "Coming in Phase 6"
// caption). Phase 6 only removes the disable.
//
// C1 ships the visual scaffold + window lifecycle. The video player, trim
// handles, annotation editor, and ffmpeg save pipeline land in C2-C5.

type ReviewParams = {
  path: string | null;
};

function readParams(): ReviewParams {
  const hash = window.location.hash || "";
  const q = hash.indexOf("?");
  if (q < 0) return { path: null };
  const params = new URLSearchParams(hash.slice(q + 1));
  return { path: params.get("path") };
}

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(i + 1) : p;
}

export default function Review() {
  const [params, setParams] = useState<ReviewParams>(() => readParams());

  useEffect(() => {
    const onHash = () => setParams(readParams());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const sourceName = params.path ? basename(params.path) : "Untitled Recording";

  return (
    <main
      className="accent-blue"
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        background: "var(--bg-window)",
        color: "var(--fg-primary)",
        fontFamily: "var(--font-system)",
      }}
    >
      <Header sourceName={sourceName} />
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 296px",
          flex: 1,
          minHeight: 0,
        }}
      >
        <LeftColumn />
        <ExportPanel />
      </div>
    </main>
  );
}

function Header({ sourceName }: { sourceName: string }) {
  return (
    <div
      style={{
        height: 42,
        padding: "0 14px",
        display: "flex",
        alignItems: "center",
        gap: 8,
        borderBottom: "1px solid var(--border-faint)",
        background: "linear-gradient(to bottom, #2a2a2c, #232325)",
      }}
    >
      <span
        style={{
          width: 18,
          height: 18,
          borderRadius: 5,
          background: "linear-gradient(135deg, var(--accent), var(--accent-deep))",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          color: "#fff",
        }}
      >
        <Icon d={P.play} size={9} stroke={0} fill="currentColor" />
      </span>
      <span
        style={{
          fontWeight: 600,
          fontSize: 13,
          letterSpacing: "-0.01em",
          color: "var(--fg-primary)",
        }}
        title={sourceName}
      >
        Screen Recording
      </span>
      <span style={{ color: "var(--fg-tertiary)", fontSize: 12 }}>·</span>
      <span style={{ color: "var(--fg-tertiary)", fontSize: 12 }}>just now</span>
    </div>
  );
}

function LeftColumn() {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        borderRight: "1px solid var(--border-faint)",
        minWidth: 0,
      }}
    >
      <Toolbar />
      <VideoStage />
      <Timeline />
      <ActionFooter />
    </div>
  );
}

function Toolbar() {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "10px 14px",
        borderBottom: "1px solid var(--border-faint)",
        color: "var(--fg-secondary)",
        fontSize: 12,
      }}
    >
      <div style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
        <span style={{ color: "var(--fg-primary)", fontWeight: 500, fontSize: 12.5 }}>
          Untitled Recording
        </span>
        <span style={{ color: "var(--fg-tertiary)" }}>·</span>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-tertiary)" }}>
          .mp4
        </span>
      </div>
      <div style={{ display: "inline-flex", alignItems: "center", gap: 4, opacity: 0.5 }}>
        <ToolButton icon={P.edit} label="Trim" kbd="T" />
        <ToolButton icon="M2 13h12M5 10l3-7 3 7M6.5 8h3" label="Text" kbd="A" />
        <ToolButton icon="M3 8h9M9 5l3 3-3 3" label="Arrow" kbd="R" />
      </div>
    </div>
  );
}

function ToolButton({ icon, label, kbd }: { icon: string; label: string; kbd: string }) {
  return (
    <button
      disabled
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "5px 9px",
        height: 26,
        background: "transparent",
        border: "1px solid transparent",
        borderRadius: 6,
        cursor: "not-allowed",
        color: "var(--fg-secondary)",
        fontFamily: "var(--font-system)",
        fontSize: 12,
        fontWeight: 500,
      }}
      title="Coming in next commit"
    >
      <Icon d={icon} size={12} stroke={1.4} />
      <span>{label}</span>
      <span style={{ marginLeft: 4, color: "var(--fg-tertiary)", fontSize: 10.5 }}>{kbd}</span>
    </button>
  );
}

function VideoStage() {
  return (
    <div style={{ position: "relative", padding: 16, background: "#0c0d10", flex: 1 }}>
      <div
        style={{
          position: "relative",
          aspectRatio: "16 / 9",
          width: "100%",
          borderRadius: 8,
          overflow: "hidden",
          border: "1px solid rgba(255,255,255,0.06)",
          background:
            "repeating-linear-gradient(135deg, #2a2030 0 14px, #251c2a 14px 28px)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--fg-tertiary)",
          fontSize: 12,
        }}
      >
        <span>Video preview lands in next commit</span>
      </div>
    </div>
  );
}

function Timeline() {
  return (
    <div
      style={{
        padding: "10px 16px 14px",
        borderTop: "1px solid var(--border-faint)",
        background: "rgba(255,255,255,0.012)",
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
        <span
          style={{
            fontSize: 11,
            color: "var(--fg-tertiary)",
            letterSpacing: "0.04em",
            textTransform: "uppercase",
            fontWeight: 600,
          }}
        >
          Timeline
        </span>
        <span style={{ fontSize: 11, color: "var(--fg-tertiary)", fontFamily: "var(--font-mono)" }}>
          --:--
        </span>
      </div>
      <div style={{ position: "relative", height: 44, marginTop: 6 }}>
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: 4,
            bottom: 4,
            borderRadius: 5,
            border: "1px solid var(--border-faint)",
            background:
              "repeating-linear-gradient(90deg," +
              "#3a2e36 0 8%, #4a3c44 8% 16%, #3f3138 16% 24%, #4d3f47 24% 32%," +
              "#37292f 32% 40%, #443840 40% 48%, #3c2e34 48% 56%, #50404a 56% 64%," +
              "#3d2f37 64% 72%, #463842 72% 80%, #392c33 80% 88%, #4a3c46 88% 100%)",
            opacity: 0.6,
          }}
        />
      </div>
    </div>
  );
}

function ActionFooter() {
  // C1 stubs: buttons render but do not act. C2 wires Save edits + Discard
  // edits + the Save/Discard/Cancel close prompt.
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "10px 16px",
        borderTop: "1px solid var(--border-faint)",
        background: "rgba(255,255,255,0.012)",
      }}
    >
      <button
        disabled
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          background: "transparent",
          border: "1px solid transparent",
          color: "var(--fg-tertiary)",
          padding: "6px 12px",
          borderRadius: 6,
          height: 30,
          cursor: "not-allowed",
          fontFamily: "var(--font-system)",
          fontSize: 12.5,
          fontWeight: 500,
          opacity: 0.6,
        }}
      >
        {I.trash}
        <span>Discard edits</span>
      </button>
      <button
        disabled
        className="btn-primary"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          padding: "6px 14px",
          borderRadius: 6,
          height: 30,
          fontSize: 12.5,
          fontWeight: 600,
          letterSpacing: "-0.005em",
          opacity: 0.55,
          cursor: "not-allowed",
        }}
      >
        <Icon d={P.check} size={13} stroke={1.6} />
        <span>Save edits</span>
      </button>
    </div>
  );
}

function ExportPanel() {
  // Phase 6 export panel rendered at full visual fidelity but inert.
  // opacity 0.4 + pointer-events: none + aria-hidden. Phase 6 removes the
  // disable; the layout does not change.
  return (
    <div style={{ display: "flex", flexDirection: "column", background: "var(--bg-sidebar)" }}>
      <div style={{ padding: "12px 14px 8px" }}>
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            justifyContent: "space-between",
            gap: 8,
          }}
        >
          <span
            style={{
              fontSize: 10.5,
              color: "var(--fg-tertiary)",
              letterSpacing: "0.06em",
              textTransform: "uppercase",
              fontWeight: 600,
            }}
          >
            Export
          </span>
          <span
            style={{
              fontSize: 10,
              color: "var(--fg-quaternary)",
              letterSpacing: "0.04em",
              textTransform: "uppercase",
              fontWeight: 600,
            }}
          >
            Coming in Phase 6
          </span>
        </div>
      </div>

      <div
        aria-hidden="true"
        style={{
          opacity: 0.4,
          pointerEvents: "none",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div style={{ padding: "0 12px 8px", display: "flex", flexDirection: "column", gap: 6 }}>
          <DestRow
            primary
            icon={<Icon d={P.check} size={14} stroke={1.6} />}
            title="Saved Locally"
            sub="~/Movies/Zeigen/recording-…mp4"
            action={
              <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11.5 }}>
                {I.finder}
                <span>Reveal</span>
              </span>
            }
          />
          <DestRow
            icon={<Icon d="M5 2h6v3M5 2v9a1 1 0 001 1h7a1 1 0 001-1V6L11 2M3 6h6v8" size={14} stroke={1.4} />}
            title="Copy to Clipboard"
            sub="Paste into Slack, Mail, Messages…"
            kbd={
              <>
                <span className="kbd">⌘</span>
                <span className="kbd">C</span>
              </>
            }
          />
          <DestRow
            icon={<Icon d={P.cloud} size={14} stroke={1.5} />}
            title="Upload & Share Link"
            sub="zeigen-share.pages.dev/v/…"
            kbd={
              <>
                <span className="kbd">⌘</span>
                <span className="kbd">⇧</span>
                <span className="kbd">L</span>
              </>
            }
          />
          <DestRow
            icon={<Icon d="M2.5 5h11v9h-11zM5 8.5v3M5 6.5h.01M7.5 11.5v-3c0-.8.7-1.5 1.5-1.5s1.5.7 1.5 1.5v3M10.5 11.5v-3" size={13} stroke={1.4} />}
            title="Export for LinkedIn"
            sub="MP4 · ≤ 10 min · 1080p capped"
          />
        </div>

        <div className="hairline" style={{ margin: "6px 14px" }} />

        <div style={{ padding: "6px 14px 10px" }}>
          <div
            style={{
              fontSize: 10.5,
              color: "var(--fg-tertiary)",
              letterSpacing: "0.06em",
              textTransform: "uppercase",
              fontWeight: 600,
              marginBottom: 8,
            }}
          >
            Quick export
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            {["MP4", "GIF", "ProRes"].map((f) => (
              <button
                key={f}
                className="btn-secondary"
                style={{ flex: 1, fontSize: 12, padding: "6px 0", height: 28 }}
              >
                {f}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div style={{ flex: 1 }} />
    </div>
  );
}

function DestRow({
  icon,
  title,
  sub,
  action,
  kbd,
  primary,
}: {
  icon: React.ReactNode;
  title: string;
  sub: string;
  action?: React.ReactNode;
  kbd?: React.ReactNode;
  primary?: boolean;
}) {
  return (
    <button
      style={{
        display: "grid",
        gridTemplateColumns: "28px 1fr auto",
        alignItems: "center",
        gap: 10,
        padding: "9px 11px",
        width: "100%",
        background: primary ? "var(--accent-soft)" : "var(--bg-elevated)",
        border: `1px solid ${primary ? "var(--accent)" : "var(--border-faint)"}`,
        borderRadius: 7,
        cursor: "pointer",
        textAlign: "left",
        color: "var(--fg-primary)",
        fontFamily: "var(--font-system)",
      }}
    >
      <span
        style={{
          width: 26,
          height: 26,
          borderRadius: 6,
          background: primary ? "var(--accent)" : "var(--bg-input)",
          color: primary ? "#fff" : "var(--fg-secondary)",
          border: "1px solid var(--border-faint)",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {icon}
      </span>
      <span style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0 }}>
        <span style={{ fontSize: 12.5, fontWeight: 600, letterSpacing: "-0.005em" }}>{title}</span>
        <span
          style={{
            fontSize: 11,
            color: "var(--fg-tertiary)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {sub}
        </span>
      </span>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
        {action && <span style={{ color: "var(--fg-tertiary)" }}>{action}</span>}
        {kbd && <span style={{ display: "inline-flex", gap: 3 }}>{kbd}</span>}
      </span>
    </button>
  );
}
