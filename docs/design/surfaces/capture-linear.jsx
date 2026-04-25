// Capture window — Linear-inspired
// Generous breathing room, refined type hierarchy, structured rows with help text, warmer.

function CaptureLinear() {
  const [source, setSource] = React.useState("display");
  const [display, setDisplay] = React.useState("Built-in Retina · 3024×1964");
  const [webcam, setWebcam] = React.useState("Continuity Camera · iPhone");
  const [mic, setMic] = React.useState("Shure MV7+");
  const [preset, setPreset] = React.useState("1080p · 60fps");
  const [systemAudio, setSystemAudio] = React.useState(true);
  const [showCursor, setShowCursor] = React.useState(true);

  const Field = ({ icon, label, hint, children }) => (
    <div style={{
      display: "grid",
      gridTemplateColumns: "1fr 220px",
      alignItems: "center",
      gap: 16,
      padding: "12px 18px",
    }}>
      <div>
        <div style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <span style={{ color: "var(--fg-tertiary)" }}>{icon}</span>
          <span style={{ fontWeight: 500, color: "var(--fg-primary)", letterSpacing: "-0.005em" }}>{label}</span>
        </div>
        {hint && <div style={{ marginTop: 2, marginLeft: 22, color: "var(--fg-tertiary)", fontSize: 11.5, lineHeight: 1.4 }}>{hint}</div>}
      </div>
      <div style={{ justifySelf: "end" }}>{children}</div>
    </div>
  );

  const Picker = ({ value, onChange, options, width = 220 }) => (
    <select className="select" value={value} onChange={(e) => onChange(e.target.value)}
      style={{ width, fontSize: 12.5 }}>
      {options.map((o) => <option key={o} value={o}>{o}</option>)}
    </select>
  );

  return (
    <div className="mac-window accent-blue" style={{ width: 480, fontFamily: 'var(--font-system)' }}>
      <div className="mac-titlebar">
        <div className="mac-traffic"><span className="close"/><span className="min"/><span className="max"/></div>
        <div className="title">New Recording</div>
      </div>

      {/* Heading + source picker as cards */}
      <div style={{ padding: "18px 18px 14px" }}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 12 }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, letterSpacing: "-0.01em", color: "var(--fg-primary)" }}>Capture</div>
            <div style={{ fontSize: 11.5, color: "var(--fg-tertiary)", marginTop: 2 }}>Choose what to record.</div>
          </div>
          <span style={{ fontSize: 11, color: "var(--fg-tertiary)", letterSpacing: "0.04em", textTransform: "uppercase" }}>Source</span>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8 }}>
          {[
            { id: "display", label: "Display", icon: I.monitor },
            { id: "window",  label: "Window",  icon: I.window },
            { id: "area",    label: "Area",    icon: I.area },
            { id: "webcam",  label: "Webcam",  icon: I.webcam },
          ].map((s) => {
            const on = source === s.id;
            return (
              <button key={s.id} onClick={() => setSource(s.id)}
                style={{
                  display: "flex", flexDirection: "column", alignItems: "center", gap: 6,
                  padding: "12px 6px",
                  background: on ? "var(--accent-soft)" : "var(--bg-elevated)",
                  border: `1px solid ${on ? "var(--accent)" : "var(--border-faint)"}`,
                  borderRadius: 8,
                  color: on ? "var(--fg-primary)" : "var(--fg-secondary)",
                  cursor: "pointer",
                  fontFamily: "var(--font-system)",
                  fontSize: 12,
                  fontWeight: 500,
                  letterSpacing: "-0.005em",
                  transition: "all 120ms ease",
                }}>
                <span style={{ color: on ? "var(--accent)" : "var(--fg-secondary)" }}>
                  <Icon d={s.icon.props.d} size={18} stroke={1.4}/>
                </span>
                {s.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="hairline"/>

      {/* Section: Devices */}
      <div style={{ padding: "10px 18px 4px" }}>
        <div style={{ fontSize: 10.5, color: "var(--fg-tertiary)", letterSpacing: "0.06em", textTransform: "uppercase", fontWeight: 600 }}>Devices</div>
      </div>
      <Field icon={I.monitor} label="Display" hint="3024 × 1964 · Built-in">
        <Picker value={display} onChange={setDisplay} options={[
          "Built-in Retina · 3024×1964",
          "LG UltraFine 5K · 5120×2880",
          "Studio Display · 5120×2880",
        ]}/>
      </Field>
      <div style={{ height: 1, background: "var(--border-faint)", margin: "0 18px" }}/>
      <Field icon={I.webcam} label="Camera" hint="Bubble overlays in the bottom-right">
        <Picker value={webcam} onChange={setWebcam} options={[
          "FaceTime HD Camera",
          "Continuity Camera · iPhone",
          "Logitech Brio 4K",
          "No webcam",
        ]}/>
      </Field>
      <div style={{ height: 1, background: "var(--border-faint)", margin: "0 18px" }}/>
      <Field icon={I.mic} label="Microphone" hint="Levels shown live in the tray">
        <Picker value={mic} onChange={setMic} options={[
          "MacBook Pro Microphone",
          "AirPods Pro",
          "Shure MV7+",
          "No microphone",
        ]}/>
      </Field>

      <div className="hairline" style={{ marginTop: 6 }}/>

      {/* Section: Output */}
      <div style={{ padding: "10px 18px 4px" }}>
        <div style={{ fontSize: 10.5, color: "var(--fg-tertiary)", letterSpacing: "0.06em", textTransform: "uppercase", fontWeight: 600 }}>Output</div>
      </div>
      <Field icon={I.video} label="Quality">
        <Picker value={preset} onChange={setPreset} options={[
          "720p · 30fps",
          "1080p · 60fps",
          "1440p · 60fps",
          "4K · 60fps · ProRes",
        ]}/>
      </Field>
      <div style={{ height: 1, background: "var(--border-faint)", margin: "0 18px" }}/>
      <Field icon={I.command} label="System audio">
        <div className={`toggle ${systemAudio ? "on" : ""}`} onClick={() => setSystemAudio(!systemAudio)}/>
      </Field>
      <div style={{ height: 1, background: "var(--border-faint)", margin: "0 18px" }}/>
      <Field icon={I.cursor} label="Show cursor">
        <div className={`toggle ${showCursor ? "on" : ""}`} onClick={() => setShowCursor(!showCursor)}/>
      </Field>

      {/* Footer */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 16px", borderTop: "1px solid var(--border-faint)", background: "rgba(255,255,255,0.015)" }}>
        <button className="btn-ghost" style={{ display: "inline-flex", alignItems: "center", gap: 6, color: "var(--fg-secondary)" }}>
          {I.gear}<span>Preferences</span>
        </button>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ display: "inline-flex", gap: 3 }}>
            <span className="kbd">⌥</span><span className="kbd">⇧</span><span className="kbd">5</span>
          </span>
          <button className="btn-primary" style={{
            display: "inline-flex", alignItems: "center", gap: 8, padding: "7px 16px",
            fontWeight: 600, letterSpacing: "-0.005em",
          }}>
            <span style={{ width: 8, height: 8, borderRadius: 99, background: "#fff", display: "inline-block" }}/>
            Record
          </button>
        </div>
      </div>
    </div>
  );
}

window.CaptureLinear = CaptureLinear;
