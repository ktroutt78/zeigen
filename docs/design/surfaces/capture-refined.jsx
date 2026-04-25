// Capture window — CleanShot X refined
// Canonical version. Webcam picker has 3 states (none / selected / Continuity),
// record button has idle + recording states, save-location footer.

function CaptureCleanShotRefined({ cameraState = "selected", recording = false }) {
  // cameraState: "none" | "selected" | "continuity"
  const [source, setSource] = React.useState("area");
  const [mic, setMic] = React.useState("MacBook Pro Microphone");
  const [preset, setPreset] = React.useState("1080p · 60fps");
  const [audioMix, setAudioMix] = React.useState("both");
  const [bubbleSize, setBubbleSize] = React.useState("medium");
  const [bubbleCorner, setBubbleCorner] = React.useState("br");
  const [elapsed, setElapsed] = React.useState(0);

  // Tick recording timer
  React.useEffect(() => {
    if (!recording) { setElapsed(0); return; }
    const i = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(i);
  }, [recording]);

  const fmtTime = (s) => {
    const m = Math.floor(s / 60).toString().padStart(2, "0");
    const ss = (s % 60).toString().padStart(2, "0");
    return `${m}:${ss}`;
  };

  // Camera picker value
  const cameraValue =
    cameraState === "none" ? "No webcam" :
    cameraState === "continuity" ? "Continuity Camera · iPhone" :
    "FaceTime HD Camera";

  const sources = [
    { id: "display", label: "Entire Display", sub: "Built-in Retina", icon: I.monitor },
    { id: "window",  label: "Window",         sub: "Pick a window",   icon: I.window },
    { id: "area",    label: "Selected Area",  sub: "Drag to capture", icon: I.area },
    { id: "webcam",  label: "Webcam Only",    sub: "Front camera",    icon: I.webcam },
  ];

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

  // Size segmented
  const SizePicker = () => {
    const opts = [
      { id: "small",  label: "S" },
      { id: "medium", label: "M" },
      { id: "large",  label: "L" },
    ];
    return (
      <div className="segmented" style={{ padding: 2 }}>
        {opts.map((o) => (
          <button key={o.id} className={bubbleSize === o.id ? "on" : ""} onClick={() => setBubbleSize(o.id)} style={{ minWidth: 24 }}>
            {o.label}
          </button>
        ))}
      </div>
    );
  };

  // Corner picker — 2x2 tiny grid
  const CornerPicker = () => {
    const corners = [
      { id: "tl", x: 0, y: 0 },
      { id: "tr", x: 1, y: 0 },
      { id: "bl", x: 0, y: 1 },
      { id: "br", x: 1, y: 1 },
    ];
    return (
      <div style={{
        width: 34, height: 24,
        background: "var(--bg-input)",
        border: "1px solid var(--border-subtle)",
        borderRadius: 5,
        position: "relative",
        display: "grid",
        gridTemplateColumns: "1fr 1fr",
        gridTemplateRows: "1fr 1fr",
        padding: 2, gap: 1,
      }}>
        {corners.map((c) => {
          const on = bubbleCorner === c.id;
          return (
            <button key={c.id} onClick={() => setBubbleCorner(c.id)} style={{
              background: "transparent", border: "none", padding: 0, margin: 0, cursor: "pointer",
              display: "flex", alignItems: "center", justifyContent: "center",
            }}>
              <span style={{
                width: 6, height: 6, borderRadius: 1.5,
                background: on ? "var(--accent)" : "var(--fg-quaternary)",
              }}/>
            </button>
          );
        })}
      </div>
    );
  };

  return (
    <div className="mac-window accent-blue" style={{ width: 480 }}>
      {/* Toolbar-style titlebar */}
      <div className="mac-titlebar" style={{ height: 42, borderBottom: "1px solid var(--border-faint)" }}>
        <div className="mac-traffic"><span className="close"/><span className="min"/><span className="max"/></div>
        <div style={{ marginLeft: 14, display: "flex", alignItems: "center", gap: 7 }}>
          <span style={{
            width: 18, height: 18, borderRadius: 5,
            background: "linear-gradient(135deg, var(--accent), oklch(0.5 0.18 250))",
            display: "inline-flex", alignItems: "center", justifyContent: "center", color: "#fff",
          }}>
            <Icon d="M5 3v10l8-5z" size={9} stroke={0} fill="currentColor"/>
          </span>
          <span style={{ fontWeight: 600, fontSize: 13, letterSpacing: "-0.01em" }}>Zeigen</span>
          {recording && (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6, marginLeft: 8,
              padding: "2px 7px", borderRadius: 99,
              background: "oklch(0.62 0.18 25 / 0.14)",
              border: "1px solid oklch(0.62 0.18 25 / 0.35)",
              color: "oklch(0.78 0.15 25)",
              fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 500,
            }}>
              <span className="rec-dot"/> REC {fmtTime(elapsed)}
            </span>
          )}
        </div>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 2 }}>
          <button className="btn-ghost" title="History" style={{ padding: 5, color: "var(--fg-secondary)" }}>{I.history}</button>
          <button className="btn-ghost" title="Preferences" style={{ padding: 5, color: "var(--fg-secondary)" }}>{I.gear}</button>
        </div>
      </div>

      {/* Source tiles */}
      <div style={{ padding: 14, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        {sources.map((s) => {
          const on = source === s.id;
          return (
            <button key={s.id} onClick={() => setSource(s.id)} style={{
              display: "flex", alignItems: "center", gap: 11,
              padding: "11px 12px",
              background: on ? "var(--accent-soft)" : "var(--bg-elevated)",
              border: `1px solid ${on ? "var(--accent)" : "var(--border-faint)"}`,
              borderRadius: 8, cursor: "pointer", textAlign: "left", color: "var(--fg-primary)",
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

      {/* Devices block */}
      <div style={{ padding: "12px 14px", display: "grid", gridTemplateColumns: "auto 1fr", rowGap: 10, columnGap: 12, alignItems: "center" }}>
        {/* Camera row */}
        <div style={{ display: "inline-flex", alignItems: "center", gap: 7, color: "var(--fg-secondary)", fontSize: 12 }}>
          {I.webcam}<span>Camera</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <select className="select" key={cameraValue} defaultValue={cameraValue}
            style={{ flex: 1, fontSize: 12.5,
              color: cameraState === "none" ? "var(--fg-tertiary)" : "var(--fg-primary)" }}>
            <option>FaceTime HD Camera</option>
            <option>Continuity Camera · iPhone</option>
            <option>Logitech Brio 4K</option>
            <option>No webcam</option>
          </select>
          {cameraState === "continuity" && (
            <span style={{
              display: "inline-flex", alignItems: "center", gap: 5,
              padding: "3px 8px",
              background: "oklch(0.62 0.13 155 / 0.14)",
              border: "1px solid oklch(0.62 0.13 155 / 0.34)",
              borderRadius: 99,
              color: "oklch(0.82 0.13 155)",
              fontSize: 10.5, fontWeight: 500, whiteSpace: "nowrap",
              letterSpacing: "-0.005em",
            }}>
              <span style={{ width: 5, height: 5, borderRadius: 99, background: "oklch(0.82 0.13 155)",
                boxShadow: "0 0 0 2px oklch(0.62 0.13 155 / 0.32)" }}/>
              iPhone connected
            </span>
          )}
        </div>

        {/* Inline webcam controls — only if a camera is selected */}
        {cameraState !== "none" && (
          <>
            <div/>
            <div style={{
              display: "flex", alignItems: "center", gap: 14,
              padding: "8px 10px",
              background: "var(--bg-input)",
              border: "1px solid var(--border-faint)",
              borderRadius: 6,
            }}>
              <div style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
                <span style={{ fontSize: 11, color: "var(--fg-tertiary)" }}>Size</span>
                <SizePicker/>
              </div>
              <div style={{ width: 1, height: 16, background: "var(--border-faint)" }}/>
              <div style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
                <span style={{ fontSize: 11, color: "var(--fg-tertiary)" }}>Corner</span>
                <CornerPicker/>
              </div>
              <div style={{ width: 1, height: 16, background: "var(--border-faint)" }}/>
              <div style={{ display: "inline-flex", alignItems: "center", gap: 7, color: "var(--fg-tertiary)", fontSize: 11 }}>
                <Icon d={I.rect.props.d} size={11}/>
                <span>Circle</span>
              </div>
            </div>
          </>
        )}

        {/* Mic */}
        <div style={{ display: "inline-flex", alignItems: "center", gap: 7, color: "var(--fg-secondary)", fontSize: 12 }}>
          {I.mic}<span>Microphone</span>
        </div>
        <select className="select" value={mic} onChange={(e) => setMic(e.target.value)} style={{ width: "100%", fontSize: 12.5 }}>
          <option>MacBook Pro Microphone</option>
          <option>AirPods Pro</option>
          <option>Shure MV7+</option>
          <option>No microphone</option>
        </select>

        {/* Quality */}
        <div style={{ display: "inline-flex", alignItems: "center", gap: 7, color: "var(--fg-secondary)", fontSize: 12 }}>
          {I.video}<span>Quality</span>
        </div>
        <select className="select" value={preset} onChange={(e) => setPreset(e.target.value)} style={{ width: "100%", fontSize: 12.5 }}>
          <option>720p · 30fps</option>
          <option>1080p · 60fps</option>
          <option>1440p · 60fps</option>
          <option>4K · 60fps · ProRes</option>
        </select>

        {/* Audio mix */}
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
          <Icon d="M2 4.5A1.5 1.5 0 013.5 3h2L7 4.5h5.5A1.5 1.5 0 0114 6v5.5A1.5 1.5 0 0112.5 13h-9A1.5 1.5 0 012 11.5z" size={12} stroke={1.25}/>
          <span>Saves to <span style={{ color: "var(--fg-secondary)", fontFamily: "var(--font-mono)", fontSize: 11 }}>~/Movies/Zeigen</span></span>
        </div>
        {recording ? (
          <button style={{
            display: "inline-flex", alignItems: "center", gap: 8,
            padding: "7px 14px 7px 11px",
            background: "oklch(0.62 0.18 25)", color: "#fff",
            border: "none", borderRadius: 6,
            fontFamily: "var(--font-system)", fontWeight: 600, fontSize: 13,
            letterSpacing: "-0.005em", cursor: "pointer",
            boxShadow: "0 0 0 3px oklch(0.62 0.18 25 / 0.25), 0 1px 0 rgba(255,255,255,0.15) inset",
          }}>
            <span style={{
              width: 16, height: 16, borderRadius: 4,
              background: "rgba(255,255,255,0.18)",
              display: "inline-flex", alignItems: "center", justifyContent: "center",
            }}>
              <span style={{ width: 8, height: 8, borderRadius: 2, background: "#fff" }}/>
            </span>
            <span style={{ fontVariantNumeric: "tabular-nums", fontFamily: "var(--font-mono)", fontSize: 12 }}>
              Stop · {fmtTime(elapsed)}
            </span>
          </button>
        ) : (
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
        )}
      </div>
    </div>
  );
}

window.CaptureCleanShotRefined = CaptureCleanShotRefined;
