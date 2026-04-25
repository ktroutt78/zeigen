// Post-record review window — CleanShot/Mac aesthetic, same green accent.
// Two states: justStopped (no edits) and midEdit (trim + 1 text annotation).

function ReviewWindow({ state = "justStopped" }) {
  // Timeline math (in seconds)
  const total = 142; // 2:22
  const trimIn = state === "midEdit" ? 8 : 0;
  const trimOut = state === "midEdit" ? 118 : total;
  const playhead = state === "midEdit" ? 64 : 0;
  const annotationT = 42;

  const fmt = (s) => {
    const m = Math.floor(s / 60).toString().padStart(2, "0");
    const ss = Math.floor(s % 60).toString().padStart(2, "0");
    return `${m}:${ss}`;
  };

  const inPct = (trimIn / total) * 100;
  const outPct = (trimOut / total) * 100;
  const playPct = (playhead / total) * 100;
  const annoPct = (annotationT / total) * 100;

  // Export panel destination row
  const Dest = ({ icon, title, sub, accent, action, primary, kbd }) => (
    <button style={{
      display: "grid", gridTemplateColumns: "28px 1fr auto", alignItems: "center", gap: 10,
      padding: "9px 11px", width: "100%",
      background: primary ? "var(--accent-soft)" : "var(--bg-elevated)",
      border: `1px solid ${primary ? "var(--accent)" : "var(--border-faint)"}`,
      borderRadius: 7, cursor: "pointer", textAlign: "left",
      color: "var(--fg-primary)", fontFamily: "var(--font-system)",
    }}>
      <span style={{
        width: 26, height: 26, borderRadius: 6,
        background: primary ? "var(--accent)" : "var(--bg-input)",
        color: primary ? "#fff" : "var(--fg-secondary)",
        border: "1px solid var(--border-faint)",
        display: "inline-flex", alignItems: "center", justifyContent: "center",
      }}>{icon}</span>
      <span style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0 }}>
        <span style={{ fontSize: 12.5, fontWeight: 600, letterSpacing: "-0.005em" }}>{title}</span>
        <span style={{ fontSize: 11, color: "var(--fg-tertiary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{sub}</span>
      </span>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
        {action && <span style={{ color: "var(--fg-tertiary)" }}>{action}</span>}
        {kbd && <span style={{ display: "inline-flex", gap: 3 }}>{kbd}</span>}
      </span>
    </button>
  );

  // Timeline frame strip — striped placeholder
  const FrameStrip = () => (
    <div style={{
      position: "absolute", inset: 0, borderRadius: 5,
      background:
        "repeating-linear-gradient(90deg," +
        "#3a2e36 0 8%, #4a3c44 8% 16%, #3f3138 16% 24%, #4d3f47 24% 32%," +
        "#37292f 32% 40%, #443840 40% 48%, #3c2e34 48% 56%, #50404a 56% 64%," +
        "#3d2f37 64% 72%, #463842 72% 80%, #392c33 80% 88%, #4a3c46 88% 100%)",
    }}/>
  );

  // Tool button (toolbar)
  const Tool = ({ icon, label, on, kbd }) => (
    <button style={{
      display: "inline-flex", alignItems: "center", gap: 6,
      padding: "5px 9px", height: 26,
      background: on ? "var(--accent-soft)" : "transparent",
      border: `1px solid ${on ? "var(--accent)" : "transparent"}`,
      borderRadius: 6, cursor: "pointer",
      color: on ? "var(--fg-primary)" : "var(--fg-secondary)",
      fontFamily: "var(--font-system)", fontSize: 12, fontWeight: 500,
    }}>
      {icon}<span>{label}</span>
      {kbd && <span style={{ marginLeft: 4, color: "var(--fg-tertiary)", fontSize: 10.5 }}>{kbd}</span>}
    </button>
  );

  // Annotation overlay on the video — only for midEdit
  const TextAnnotation = () => (
    <div style={{
      position: "absolute", left: "18%", top: "26%",
      padding: "5px 9px",
      background: "rgba(20,20,22,0.86)", color: "#fff",
      borderRadius: 6, border: "0.5px solid rgba(255,255,255,0.18)",
      fontFamily: "var(--font-system)", fontSize: 13, fontWeight: 600,
      letterSpacing: "-0.005em",
      boxShadow: "0 6px 16px rgba(0,0,0,0.45)",
      // Selection ring
      outline: "1.5px solid var(--accent)",
      outlineOffset: 2,
    }}>
      Here's where it breaks
      {/* drag handles */}
      <span style={handleStyle(-3, -3)}/>
      <span style={handleStyle(-3, "calc(100% - 4px)")}/>
      <span style={handleStyle("calc(100% - 4px)", -3)}/>
      <span style={handleStyle("calc(100% - 4px)", "calc(100% - 4px)")}/>
    </div>
  );

  return (
    <div className="mac-window accent-blue" style={{ width: 940, fontFamily: 'var(--font-system)' }}>
      {/* Toolbar titlebar */}
      <div className="mac-titlebar" style={{ height: 44 }}>
        <div className="mac-traffic"><span className="close"/><span className="min"/><span className="max"/></div>
        <div style={{ marginLeft: 14, display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{
            width: 18, height: 18, borderRadius: 5,
            background: "linear-gradient(135deg, var(--accent), oklch(0.5 0.18 250))",
            display: "inline-flex", alignItems: "center", justifyContent: "center", color: "#fff",
          }}>
            <Icon d="M5 3v10l8-5z" size={9} stroke={0} fill="currentColor"/>
          </span>
          <span style={{ fontWeight: 600, fontSize: 13, letterSpacing: "-0.01em" }}>
            {state === "midEdit" ? "Screen Recording — edited" : "Screen Recording"}
          </span>
          <span style={{ color: "var(--fg-tertiary)", fontSize: 12 }}>·</span>
          <span style={{ color: "var(--fg-tertiary)", fontSize: 12 }}>just now</span>
        </div>
        <div style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 2 }}>
          <button className="btn-ghost" style={{ padding: 5, color: "var(--fg-secondary)" }} title="More">{I.more}</button>
        </div>
      </div>

      {/* Body */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 296px", minHeight: 540 }}>
        {/* LEFT — player */}
        <div style={{ display: "flex", flexDirection: "column", borderRight: "1px solid var(--border-faint)" }}>
          {/* Filename row */}
          <div style={{
            display: "flex", alignItems: "center", justifyContent: "space-between",
            padding: "10px 14px", borderBottom: "1px solid var(--border-faint)",
            color: "var(--fg-secondary)", fontSize: 12,
          }}>
            <div style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
              <span style={{ color: "var(--fg-primary)", fontWeight: 500, fontSize: 12.5 }}>Untitled Recording</span>
              <span style={{ color: "var(--fg-tertiary)" }}>·</span>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-tertiary)" }}>
                native res · 30fps · {fmt(state === "midEdit" ? trimOut - trimIn : total)} · .mp4
              </span>
            </div>
            <div style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
              <Tool icon={<Icon d={I.scissors.props.d} size={12} stroke={1.4}/>} label="Trim" on={state === "midEdit"} kbd="T"/>
              <Tool icon={<Icon d="M2 13h12M5 10l3-7 3 7M6.5 8h3" size={12} stroke={1.4}/>} label="Text" on={state === "midEdit"} kbd="A"/>
              <Tool icon={<Icon d="M3 8h9M9 5l3 3-3 3" size={12} stroke={1.4}/>} label="Arrow" kbd="R"/>
            </div>
          </div>

          {/* Video stage */}
          <div style={{ position: "relative", padding: 16, background: "#0c0d10", flex: 1 }}>
            <div style={{
              position: "relative", aspectRatio: "16/9", width: "100%",
              borderRadius: 8, overflow: "hidden",
              border: "1px solid rgba(255,255,255,0.06)",
              background:
                "repeating-linear-gradient(135deg, #2a2030 0 14px, #251c2a 14px 28px)",
            }}>
              {/* faux app window inside the recording */}
              <div style={{
                position: "absolute", left: "8%", top: "10%", width: "70%", height: "75%",
                background: "rgba(245,245,247,0.96)", borderRadius: 9,
                boxShadow: "0 18px 40px rgba(0,0,0,0.45)",
                display: "flex", flexDirection: "column", overflow: "hidden",
                border: "1px solid rgba(0,0,0,0.2)",
              }}>
                <div style={{ height: 22, background: "#e6e6e9", display: "flex", alignItems: "center", padding: "0 8px", gap: 5, borderBottom: "1px solid rgba(0,0,0,0.08)" }}>
                  <span style={{ width: 8, height: 8, borderRadius: 99, background: "#ff5f57" }}/>
                  <span style={{ width: 8, height: 8, borderRadius: 99, background: "#febc2e" }}/>
                  <span style={{ width: 8, height: 8, borderRadius: 99, background: "#28c840" }}/>
                </div>
                <div style={{ flex: 1, padding: 14, display: "flex", flexDirection: "column", gap: 6 }}>
                  <div style={{ height: 8, width: "40%", background: "#1a1a1c", borderRadius: 2 }}/>
                  <div style={{ height: 5, width: "75%", background: "#bdbdc0", borderRadius: 2 }}/>
                  <div style={{ height: 5, width: "60%", background: "#bdbdc0", borderRadius: 2 }}/>
                  <div style={{ height: 5, width: "70%", background: "#bdbdc0", borderRadius: 2 }}/>
                  <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                    <div style={{ height: 32, background: "#e8e8eb", borderRadius: 5 }}/>
                    <div style={{ height: 32, background: "#e8e8eb", borderRadius: 5 }}/>
                  </div>
                </div>
              </div>
              {/* webcam bubble bottom-right */}
              <div style={{
                position: "absolute", right: 18, bottom: 18, width: 80, height: 80, borderRadius: 99,
                background: "repeating-linear-gradient(135deg, #5b4a52 0 5px, #4d3e46 5px 10px)",
                border: "1.5px solid rgba(255,255,255,0.18)",
                boxShadow: "0 10px 24px rgba(0,0,0,0.5)",
              }}/>
              {/* Annotation overlay (mid-edit only) */}
              {state === "midEdit" && <TextAnnotation/>}

              {/* Playback overlay (bottom of video) */}
              <div style={{
                position: "absolute", left: 12, right: 12, bottom: 12,
                display: "flex", alignItems: "center", gap: 10,
                padding: "6px 10px",
                background: "rgba(20,20,22,0.6)", backdropFilter: "blur(10px)",
                border: "0.5px solid rgba(255,255,255,0.1)",
                borderRadius: 8, color: "#fff",
              }}>
                <button style={{ background: "transparent", border: "none", color: "#fff", cursor: "pointer", padding: 2 }}>
                  <Icon d={I.play.props.d} size={14} stroke={0} fill="currentColor"/>
                </button>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "rgba(255,255,255,0.85)", fontVariantNumeric: "tabular-nums" }}>
                  {fmt(playhead)} / {fmt(total)}
                </span>
                <div style={{ flex: 1 }}/>
                <button style={{ background: "transparent", border: "none", color: "rgba(255,255,255,0.7)", cursor: "pointer", padding: 2 }} title="Mute">
                  <Icon d="M2 6v4h3l4 3V3L5 6H2z" size={13} stroke={1.4}/>
                </button>
                <button style={{ background: "transparent", border: "none", color: "rgba(255,255,255,0.7)", cursor: "pointer", padding: 2 }} title="Fullscreen">
                  <Icon d="M3 6V3h3M10 3h3v3M13 10v3h-3M6 13H3v-3" size={12} stroke={1.4}/>
                </button>
              </div>
            </div>
          </div>

          {/* Timeline */}
          <div style={{ padding: "10px 16px 14px", borderTop: "1px solid var(--border-faint)", background: "rgba(255,255,255,0.012)" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
              <span style={{ fontSize: 11, color: "var(--fg-tertiary)", letterSpacing: "0.04em", textTransform: "uppercase", fontWeight: 600 }}>Timeline</span>
              {state === "midEdit" ? (
                <span style={{ fontSize: 11, color: "var(--fg-secondary)", fontFamily: "var(--font-mono)" }}>
                  In <span style={{ color: "var(--accent)" }}>{fmt(trimIn)}</span> · Out <span style={{ color: "var(--accent)" }}>{fmt(trimOut)}</span> · Length {fmt(trimOut - trimIn)}
                </span>
              ) : (
                <span style={{ fontSize: 11, color: "var(--fg-tertiary)", fontFamily: "var(--font-mono)" }}>{fmt(total)}</span>
              )}
            </div>

            {/* Track */}
            <div style={{ position: "relative", height: 44, marginTop: 6 }}>
              {/* The strip */}
              <div style={{ position: "absolute", left: 0, right: 0, top: 4, bottom: 4, borderRadius: 5, overflow: "hidden",
                border: "1px solid var(--border-faint)" }}>
                <FrameStrip/>
                {/* dimmed regions (outside trim) — only mid-edit */}
                {state === "midEdit" && (
                  <>
                    <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${inPct}%`, background: "rgba(12,13,16,0.7)" }}/>
                    <div style={{ position: "absolute", right: 0, top: 0, bottom: 0, width: `${100 - outPct}%`, background: "rgba(12,13,16,0.7)" }}/>
                  </>
                )}
              </div>

              {/* Annotation marker pip — mid-edit only */}
              {state === "midEdit" && (
                <div style={{ position: "absolute", left: `${annoPct}%`, top: -2, transform: "translateX(-50%)" }}>
                  <span style={{ display: "inline-block", width: 14, height: 14, borderRadius: 99,
                    background: "var(--bg-elevated)", border: "1px solid var(--accent)",
                    color: "var(--accent)", textAlign: "center", lineHeight: "12px",
                    fontSize: 9, fontWeight: 700, fontFamily: "var(--font-system)",
                  }}>A</span>
                </div>
              )}

              {/* Trim handles — mid-edit */}
              {state === "midEdit" && (
                <>
                  <TrimHandle pct={inPct} side="in"/>
                  <TrimHandle pct={outPct} side="out"/>
                </>
              )}

              {/* Playhead */}
              <div style={{ position: "absolute", left: `${playPct}%`, top: -2, bottom: -2, width: 0,
                borderLeft: "1.5px solid #fff", transform: "translateX(-1px)",
                filter: "drop-shadow(0 0 4px rgba(255,255,255,0.4))",
              }}>
                <span style={{ position: "absolute", top: -6, left: -5, width: 11, height: 11, borderRadius: 99,
                  background: "#fff", boxShadow: "0 1px 4px rgba(0,0,0,0.5)" }}/>
              </div>
            </div>

            {/* time scale labels */}
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8, fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg-quaternary)" }}>
              <span>00:00</span><span>00:30</span><span>01:00</span><span>01:30</span><span>02:00</span><span>02:22</span>
            </div>
          </div>
        </div>

        {/* RIGHT — export panel */}
        <div style={{ display: "flex", flexDirection: "column", background: "var(--bg-sidebar)" }}>
          <div style={{ padding: "12px 14px 8px" }}>
            <div style={{ fontSize: 10.5, color: "var(--fg-tertiary)", letterSpacing: "0.06em", textTransform: "uppercase", fontWeight: 600 }}>Export</div>
          </div>

          <div style={{ padding: "0 12px 8px", display: "flex", flexDirection: "column", gap: 6 }}>
            <Dest
              primary
              icon={<Icon d="M3 8.5l3 3 7-7" size={14} stroke={1.6}/>}
              title="Saved Locally"
              sub="~/Movies/Zeigen/recording-2026-04-24-143052.mp4"
              action={<span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11.5 }}>{I.finder}<span>Reveal</span></span>}
            />
            <Dest
              icon={<Icon d="M5 2h6v3M5 2v9a1 1 0 001 1h7a1 1 0 001-1V6L11 2M3 6h6v8" size={14} stroke={1.4}/>}
              title="Copy to Clipboard"
              sub="Paste into Slack, Mail, Messages…"
              kbd={<><span className="kbd">⌘</span><span className="kbd">C</span></>}
            />
            <Dest
              icon={<Icon d={I.link.props.d} size={14} stroke={1.5}/>}
              title="Upload & Share Link"
              sub="zeigen-share.pages.dev/v/V1StGXR8Z9"
              kbd={<><span className="kbd">⌘</span><span className="kbd">⇧</span><span className="kbd">L</span></>}
            />
            <Dest
              icon={<Icon d="M2.5 5h11v9h-11zM5 8.5v3M5 6.5h.01M7.5 11.5v-3c0-.8.7-1.5 1.5-1.5s1.5.7 1.5 1.5v3M10.5 11.5v-3" size={13} stroke={1.4}/>}
              title="Export for LinkedIn"
              sub="MP4 · ≤ 10 min · 1080p capped"
            />
          </div>

          <div className="hairline" style={{ margin: "6px 14px" }}/>

          {/* Format presets */}
          <div style={{ padding: "6px 14px 10px" }}>
            <div style={{ fontSize: 10.5, color: "var(--fg-tertiary)", letterSpacing: "0.06em", textTransform: "uppercase", fontWeight: 600, marginBottom: 8 }}>Quick export</div>
            <div style={{ display: "flex", gap: 6 }}>
              {["MP4", "GIF", "ProRes"].map((f) => (
                <button key={f} className="btn-secondary" style={{ flex: 1, fontSize: 12, padding: "6px 0", height: 28 }}>{f}</button>
              ))}
            </div>
          </div>

          <div className="hairline" style={{ margin: "0 14px 8px" }}/>

          {/* Open in editor */}
          <div style={{ padding: "0 14px" }}>
            <button className="btn-secondary" style={{
              width: "100%", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 7, height: 30,
            }}>
              {I.external}<span>Open in Final Cut</span>
            </button>
          </div>

          <div style={{ flex: 1 }}/>

          {/* Discard — de-emphasized */}
          <div style={{ padding: "12px 14px", borderTop: "1px solid var(--border-faint)" }}>
            <button style={{
              width: "100%", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 7,
              background: "transparent", border: "1px solid transparent", color: "var(--fg-tertiary)",
              padding: "6px 0", borderRadius: 6, cursor: "pointer",
              fontFamily: "var(--font-system)", fontSize: 12, fontWeight: 500,
            }}
            onMouseEnter={(e) => { e.currentTarget.style.borderColor = "rgba(255,80,80,0.25)"; e.currentTarget.style.color = "oklch(0.78 0.15 25)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.borderColor = "transparent"; e.currentTarget.style.color = "var(--fg-tertiary)"; }}
            >
              {I.trash}<span>Discard recording</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function TrimHandle({ pct, side }) {
  return (
    <div style={{
      position: "absolute", left: `${pct}%`, top: 0, bottom: 0,
      transform: side === "in" ? "translateX(-100%)" : "translateX(0)",
      width: 10,
      background: "var(--accent)",
      borderTopLeftRadius: side === "in" ? 4 : 0,
      borderBottomLeftRadius: side === "in" ? 4 : 0,
      borderTopRightRadius: side === "out" ? 4 : 0,
      borderBottomRightRadius: side === "out" ? 4 : 0,
      cursor: "ew-resize",
      display: "inline-flex", alignItems: "center", justifyContent: "center",
      boxShadow: "0 1px 2px rgba(0,0,0,0.4)",
    }}>
      <span style={{ width: 1, height: 14, background: "rgba(255,255,255,0.55)" }}/>
    </div>
  );
}

function handleStyle(top, left) {
  return {
    position: "absolute", top, left,
    width: 7, height: 7, borderRadius: 1.5,
    background: "#fff", border: "1px solid var(--accent)",
  };
}

window.ReviewWindow = ReviewWindow;
