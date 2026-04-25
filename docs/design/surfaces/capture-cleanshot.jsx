// Capture window — CleanShot X-inspired
// Native Mac feel: traffic-light titlebar with window-blended toolbar, system materials,
// big visual source picker tile, compact device row at bottom.

function CaptureCleanShot() {
  const [source, setSource] = React.useState("area");
  const [webcam, setWebcam] = React.useState("FaceTime HD Camera");
  const [mic, setMic] = React.useState("MacBook Pro Microphone");
  const [preset, setPreset] = React.useState("1080p · 60fps");
  const [audioMix, setAudioMix] = React.useState("both"); // mic | system | both | none

  const sources = [
    { id: "display", label: "Entire Display", sub: "Built-in Retina", icon: I.monitor },
    { id: "window",  label: "Window",         sub: "Pick a window",   icon: I.window },
    { id: "area",    label: "Selected Area",  sub: "Drag to capture", icon: I.area },
    { id: "webcam",  label: "Webcam Only",    sub: "Front camera",    icon: I.webcam },
  ];

  // Tiny segmented audio mix
  const Mix = () => {
    const opts = [
      { id: "mic", label: "Mic" },
      { id: "system", label: "System" },
      { id: "both", label: "Both" },
      { id: "none", label: "None" },
    ];
    return (
      <div className="segmented">
        {opts.map((o) => (
          <button key={o.id} className={audioMix === o.id ? "on" : ""} onClick={() => setAudioMix(o.id)}>
            {o.label}
          </button>
        ))}
      </div>
    );
  };

  return (
    <div className="mac-window accent-blue" style={{ width: 480 }}>
      {/* Unified titlebar (no centered title — toolbar style) */}
      <div className="mac-titlebar" style={{ height: 42, borderBottom: "1px solid var(--border-faint)" }}>
        <div className="mac-traffic"><span className="close"/><span className="min"/><span className="max"/></div>
        <div style={{ marginLeft: 14, display: "flex", alignItems: "center", gap: 7 }}>
          <span style={{
            width: 18, height: 18, borderRadius: 5,
            background: "linear-gradient(135deg, var(--accent), oklch(0.5 0.18 250))",
            display: "inline-flex", alignItems: "center", justifyContent: "center",
            color: "#fff",
          }}>
            <Icon d="M5 3v10l8-5z" size={9} stroke={0} fill="currentColor"/>
          </span>
          <span style={{ fontWeight: 600, fontSize: 13, letterSpacing: "-0.01em" }}>Zeigen</span>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 2 }}>
          <button className="btn-ghost" title="History" style={{ padding: 5, color: "var(--fg-secondary)" }}>{I.history}</button>
          <button className="btn-ghost" title="Preferences" style={{ padding: 5, color: "var(--fg-secondary)" }}>{I.gear}</button>
        </div>
      </div>

      {/* Big source tiles — 2×2 grid */}
      <div style={{ padding: 14, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        {sources.map((s) => {
          const on = source === s.id;
          return (
            <button key={s.id} onClick={() => setSource(s.id)} style={{
              display: "flex", alignItems: "center", gap: 11,
              padding: "11px 12px",
              background: on ? "var(--accent-soft)" : "var(--bg-elevated)",
              border: `1px solid ${on ? "var(--accent)" : "var(--border-faint)"}`,
              borderRadius: 8,
              cursor: "pointer", textAlign: "left", color: "var(--fg-primary)",
              fontFamily: "var(--font-system)", boxShadow: on ? "0 0 0 3px var(--accent-soft)" : "none",
              transition: "all 120ms ease",
            }}>
              <span style={{
                width: 30, height: 30, borderRadius: 7, flexShrink: 0,
                background: on ? "var(--accent)" : "var(--bg-input)",
                color: on ? "#fff" : "var(--fg-secondary)",
                display: "inline-flex", alignItems: "center", justifyContent: "center",
                border: "1px solid var(--border-faint)",
              }}>
                <Icon d={s.icon.props.d} size={16} stroke={1.4}/>
              </span>
              <span style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0 }}>
                <span style={{ fontSize: 12.5, fontWeight: 600, letterSpacing: "-0.005em" }}>{s.label}</span>
                <span style={{ fontSize: 11, color: "var(--fg-tertiary)" }}>{s.sub}</span>
              </span>
            </button>
          );
        })}
      </div>

      <div className="hairline"/>

      {/* Compact device row */}
      <div style={{ padding: "12px 14px", display: "grid", gridTemplateColumns: "auto 1fr", rowGap: 8, columnGap: 12, alignItems: "center" }}>
        <div style={{ display: "inline-flex", alignItems: "center", gap: 7, color: "var(--fg-secondary)", fontSize: 12 }}>
          {I.webcam}<span>Camera</span>
        </div>
        <select className="select" value={webcam} onChange={(e) => setWebcam(e.target.value)}
          style={{ width: "100%", fontSize: 12.5 }}>
          <option>FaceTime HD Camera</option>
          <option>Continuity Camera · iPhone</option>
          <option>Logitech Brio 4K</option>
          <option>No webcam</option>
        </select>

        <div style={{ display: "inline-flex", alignItems: "center", gap: 7, color: "var(--fg-secondary)", fontSize: 12 }}>
          {I.mic}<span>Microphone</span>
        </div>
        <select className="select" value={mic} onChange={(e) => setMic(e.target.value)}
          style={{ width: "100%", fontSize: 12.5 }}>
          <option>MacBook Pro Microphone</option>
          <option>AirPods Pro</option>
          <option>Shure MV7+</option>
          <option>No microphone</option>
        </select>

        <div style={{ display: "inline-flex", alignItems: "center", gap: 7, color: "var(--fg-secondary)", fontSize: 12 }}>
          {I.video}<span>Quality</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <select className="select" value={preset} onChange={(e) => setPreset(e.target.value)} style={{ flex: 1, fontSize: 12.5 }}>
            <option>720p · 30fps</option>
            <option>1080p · 60fps</option>
            <option>1440p · 60fps</option>
            <option>4K · 60fps · ProRes</option>
          </select>
        </div>

        <div style={{ display: "inline-flex", alignItems: "center", gap: 7, color: "var(--fg-secondary)", fontSize: 12 }}>
          {I.command}<span>Audio</span>
        </div>
        <Mix/>
      </div>

      {/* Footer record bar */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "12px 14px",
        background: "rgba(255,255,255,0.015)",
        borderTop: "1px solid var(--border-faint)",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--fg-tertiary)", fontSize: 11.5 }}>
          <Icon d="M8 1.5L13 3v4.5c0 3.5-2.5 6-5 7-2.5-1-5-3.5-5-7V3z" size={12} stroke={1.25}/>
          <span>Saves to <span style={{ color: "var(--fg-secondary)", fontFamily: "var(--font-mono)", fontSize: 11 }}>~/Movies/Zeigen</span></span>
        </div>
        <button className="btn-primary" style={{
          display: "inline-flex", alignItems: "center", gap: 8,
          padding: "7px 14px 7px 11px", fontWeight: 600, letterSpacing: "-0.005em",
        }}>
          <span style={{
            width: 16, height: 16, borderRadius: 99,
            background: "rgba(255,255,255,0.2)",
            display: "inline-flex", alignItems: "center", justifyContent: "center",
          }}>
            <span style={{ width: 8, height: 8, borderRadius: 99, background: "#fff" }}/>
          </span>
          Start Recording
        </button>
      </div>
    </div>
  );
}

window.CaptureCleanShot = CaptureCleanShot;
