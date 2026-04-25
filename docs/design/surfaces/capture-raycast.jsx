// Capture window — Raycast-inspired
// Tight spacing, monochrome, single column, dividers between rows, accent only on record button.

function CaptureRaycast() {
  const [source, setSource] = React.useState("display");
  const [display, setDisplay] = React.useState("Built-in Retina · 3024×1964");
  const [webcam, setWebcam] = React.useState("FaceTime HD Camera");
  const [mic, setMic] = React.useState("MacBook Pro Microphone");
  const [preset, setPreset] = React.useState("1080p · 60fps");
  const [systemAudio, setSystemAudio] = React.useState(true);

  const Row = ({ icon, label, children, last }) => (
    <div style={{
      display: "grid", gridTemplateColumns: "20px 1fr auto",
      alignItems: "center", gap: 10,
      padding: "9px 14px", minHeight: 36,
      borderBottom: last ? "none" : "1px solid var(--border-faint)",
    }}>
      <span style={{ color: "var(--fg-tertiary)", display: "inline-flex" }}>{icon}</span>
      <span style={{ color: "var(--fg-primary)", fontWeight: 400 }}>{label}</span>
      <span>{children}</span>
    </div>
  );

  const Picker = ({ value, onChange, options }) => (
    <select className="select" value={value} onChange={(e) => onChange(e.target.value)}
      style={{ minWidth: 200, fontSize: 12.5, color: "var(--fg-primary)" }}>
      {options.map((o) => <option key={o} value={o}>{o}</option>)}
    </select>
  );

  return (
    <div className="mac-window accent-blue" style={{ width: 480 }}>
      <div className="mac-titlebar">
        <div className="mac-traffic"><span className="close"/><span className="min"/><span className="max"/></div>
        <div className="title">Zeigen</div>
      </div>

      {/* Source segmented control — full width, no padding */}
      <div style={{ padding: "12px 14px 8px", display: "flex", alignItems: "center", gap: 8 }}>
        <div className="segmented" style={{ flex: 1, display: "grid", gridTemplateColumns: "repeat(4, 1fr)" }}>
          {[
            { id: "display", label: "Display", icon: I.monitor },
            { id: "window",  label: "Window",  icon: I.window },
            { id: "area",    label: "Area",    icon: I.area },
            { id: "webcam",  label: "Webcam",  icon: I.webcam },
          ].map((s) => (
            <button key={s.id} className={source === s.id ? "on" : ""}
              onClick={() => setSource(s.id)}
              style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6, padding: "5px 0" }}>
              <span style={{ color: source === s.id ? "var(--fg-primary)" : "var(--fg-tertiary)" }}>{s.icon}</span>
              <span>{s.label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Rows */}
      <div style={{ padding: "0 0 4px" }}>
        <Row icon={I.monitor} label="Display">
          <Picker value={display} onChange={setDisplay} options={[
            "Built-in Retina · 3024×1964",
            "LG UltraFine 5K · 5120×2880",
            "Studio Display · 5120×2880",
          ]}/>
        </Row>
        <Row icon={I.webcam} label="Camera">
          <Picker value={webcam} onChange={setWebcam} options={[
            "FaceTime HD Camera",
            "Continuity Camera · iPhone",
            "Logitech Brio 4K",
            "No webcam",
          ]}/>
        </Row>
        <Row icon={I.mic} label="Microphone">
          <Picker value={mic} onChange={setMic} options={[
            "MacBook Pro Microphone",
            "AirPods Pro",
            "Shure MV7+",
            "No microphone",
          ]}/>
        </Row>
        <Row icon={I.video} label="Quality">
          <Picker value={preset} onChange={setPreset} options={[
            "720p · 30fps",
            "1080p · 60fps",
            "1440p · 60fps",
            "4K · 60fps",
          ]}/>
        </Row>
        <Row icon={I.command} label="System audio" last>
          <div className={`toggle ${systemAudio ? "on" : ""}`} onClick={() => setSystemAudio(!systemAudio)}/>
        </Row>
      </div>

      <div className="hairline"/>

      {/* Footer */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 12px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <button className="btn-ghost" title="Preferences" style={{ padding: "5px 7px", color: "var(--fg-secondary)" }}>{I.gear}</button>
          <button className="btn-ghost" title="History" style={{ padding: "5px 7px", color: "var(--fg-secondary)" }}>{I.history}</button>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span className="kbd">⌥</span>
          <span className="kbd">⇧</span>
          <span className="kbd">5</span>
          <button className="btn-primary" style={{
            display: "inline-flex", alignItems: "center", gap: 7,
            padding: "6px 14px",
          }}>
            <span style={{ width: 8, height: 8, borderRadius: 99, background: "#fff", display: "inline-block" }}/>
            Start Recording
          </button>
        </div>
      </div>
    </div>
  );
}

window.CaptureRaycast = CaptureRaycast;
