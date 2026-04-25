// Floating webcam bubble — three takes.
// Each shown on a small "desktop" patch so the chrome reads in context.
// Variants:
//   A · Pure orbit — circle with no chrome until hover. Resize handle bottom-right.
//   B · Halo controls — a thin ring of icon controls fades in on hover, around the bubble.
//   C · Dock pill — bubble + horizontal pill of controls below, like a mini dock.
// All include circle/rect shape toggle.

// Faux camera feed — striped placeholder with a small "you" label, no SVG portraiture.
function CameraFeed({ shape = "circle", size = 160, hover, controlsHeight = 0, label = true }) {
  const radius = shape === "circle" ? size / 2 : 18;
  const w = shape === "circle" ? size : Math.round(size * 1.33);
  const h = size;
  return (
    <div style={{
      width: w, height: h, borderRadius: radius,
      overflow: "hidden", position: "relative",
      background:
        "repeating-linear-gradient(135deg, #5b4a52 0 6px, #4d3e46 6px 12px)",
      border: "1.5px solid rgba(255,255,255,0.12)",
      boxShadow: "0 18px 48px rgba(0,0,0,0.55), 0 0 0 0.5px rgba(0,0,0,0.5)",
      transition: "border-color 160ms ease, box-shadow 160ms ease",
    }}>
      {/* subtle vignette */}
      <div style={{
        position: "absolute", inset: 0,
        background: "radial-gradient(circle at 35% 30%, rgba(255,255,255,0.08), transparent 55%)",
      }}/>
      {label && (
        <div style={{
          position: "absolute", left: 0, right: 0, bottom: 8, textAlign: "center",
          color: "rgba(255,255,255,0.7)",
          fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "0.06em",
        }}>WEBCAM PREVIEW</div>
      )}
    </div>
  );
}

// ---------- A · Pure orbit ----------
function WebcamOrbit({ hover = false, shape = "circle" }) {
  const size = 160;
  return (
    <div style={{ position: "relative", width: size + 20, height: size + 20, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <CameraFeed shape={shape} size={size}/>
      {/* Resize handle bottom-right */}
      {hover && (
        <div style={{
          position: "absolute", right: 6, bottom: 6,
          width: 22, height: 22, borderRadius: 99,
          background: "rgba(0,0,0,0.55)", backdropFilter: "blur(6px)",
          color: "#fff",
          display: "inline-flex", alignItems: "center", justifyContent: "center",
          border: "0.5px solid rgba(255,255,255,0.2)",
        }}>
          <Icon d="M11 5h2v2M5 11H3v-2M5 11l8-8M3 13l8-8" size={11} stroke={1.4}/>
        </div>
      )}
      {/* Tiny shape toggle top-right */}
      {hover && (
        <div style={{
          position: "absolute", right: 6, top: 6,
          height: 22, padding: "0 7px", borderRadius: 99,
          background: "rgba(0,0,0,0.55)", backdropFilter: "blur(6px)",
          color: "#fff",
          display: "inline-flex", alignItems: "center", gap: 5,
          border: "0.5px solid rgba(255,255,255,0.2)",
          fontFamily: "var(--font-system)", fontSize: 10.5, fontWeight: 500,
        }}>
          <Icon d="M3 8a5 5 0 1110 0 5 5 0 01-10 0z" size={9} stroke={1.4}/>
          <span style={{ width: 1, height: 9, background: "rgba(255,255,255,0.25)" }}/>
          <Icon d={I.rect.props.d} size={10} stroke={1.4} style={{ opacity: 0.55 }}/>
        </div>
      )}
    </div>
  );
}

// ---------- B · Halo controls ----------
function WebcamHalo({ hover = true, shape = "circle" }) {
  const size = 160;
  const Btn = ({ icon, danger, primary, title }) => (
    <button title={title} style={{
      width: 30, height: 30, borderRadius: 99,
      background: primary ? "oklch(0.62 0.18 25)" : "rgba(20,20,22,0.78)",
      color: "#fff", border: "0.5px solid rgba(255,255,255,0.18)",
      backdropFilter: "blur(10px)",
      display: "inline-flex", alignItems: "center", justifyContent: "center",
      cursor: "pointer",
      boxShadow: "0 4px 14px rgba(0,0,0,0.4)",
    }}>{icon}</button>
  );
  return (
    <div style={{ position: "relative", width: size + 100, height: size + 60, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <CameraFeed shape={shape} size={size}/>
      {hover && (
        <>
          {/* Top — pause / stop */}
          <div style={{
            position: "absolute", top: -2, left: "50%", transform: "translate(-50%, -50%)",
            display: "inline-flex", gap: 6, padding: 4,
          }}>
            <Btn title="Pause" icon={<Icon d={I.pause.props.d} size={12} stroke={1.5}/>}/>
            <Btn title="Stop" primary icon={<Icon d="" size={10} stroke={0} fill="currentColor" style={{ width: 8, height: 8, borderRadius: 1, background: "#fff" }}/>}/>
          </div>
          {/* Right — shape toggle */}
          <div style={{
            position: "absolute", top: "50%", right: 0, transform: "translate(50%, -50%)",
            display: "flex", flexDirection: "column", gap: 6,
          }}>
            <Btn title="Circle" icon={<Icon d="M3 8a5 5 0 1110 0 5 5 0 01-10 0z" size={12} stroke={1.5}/>}/>
            <Btn title="Rectangle" icon={<Icon d={I.rect.props.d} size={12} stroke={1.5}/>}/>
          </div>
          {/* Bottom-right — resize */}
          <div style={{
            position: "absolute", right: 8, bottom: 6,
            width: 22, height: 22, borderRadius: 99,
            background: "rgba(0,0,0,0.55)", color: "#fff",
            display: "inline-flex", alignItems: "center", justifyContent: "center",
            border: "0.5px solid rgba(255,255,255,0.18)",
          }}>
            <Icon d="M11 5h2v2M5 11H3v-2M5 11l8-8M3 13l8-8" size={10} stroke={1.4}/>
          </div>
        </>
      )}
    </div>
  );
}

// ---------- C · Dock pill ----------
function WebcamDock({ hover = true, shape = "circle" }) {
  const size = 160;
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
      <CameraFeed shape={shape} size={size}/>
      {hover && (
        <div style={{
          display: "inline-flex", alignItems: "center", gap: 2,
          padding: 4,
          background: "rgba(20,20,22,0.78)", backdropFilter: "blur(14px)",
          border: "0.5px solid rgba(255,255,255,0.14)",
          borderRadius: 99,
          boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
        }}>
          <button title="Pause" style={dockBtn()}>
            <Icon d={I.pause.props.d} size={12} stroke={1.5}/>
          </button>
          <button title="Stop" style={dockBtn({ danger: true })}>
            <span style={{ width: 8, height: 8, borderRadius: 1.5, background: "#fff", display: "inline-block" }}/>
          </button>
          <span style={{ width: 1, height: 14, background: "rgba(255,255,255,0.15)", margin: "0 3px" }}/>
          <button title="Circle" style={dockBtn({ active: shape === "circle" })}>
            <Icon d="M3 8a5 5 0 1110 0 5 5 0 01-10 0z" size={12} stroke={1.5}/>
          </button>
          <button title="Rectangle" style={dockBtn({ active: shape !== "circle" })}>
            <Icon d={I.rect.props.d} size={12} stroke={1.5}/>
          </button>
          <span style={{ width: 1, height: 14, background: "rgba(255,255,255,0.15)", margin: "0 3px" }}/>
          <button title="Resize" style={dockBtn()}>
            <Icon d="M11 5h2v2M5 11H3v-2M5 11l8-8M3 13l8-8" size={11} stroke={1.4}/>
          </button>
        </div>
      )}
    </div>
  );
}
function dockBtn({ danger, active } = {}) {
  return {
    width: 26, height: 26, borderRadius: 99,
    background: danger ? "oklch(0.62 0.18 25)" : active ? "rgba(255,255,255,0.12)" : "transparent",
    color: "#fff", border: "none", cursor: "pointer",
    display: "inline-flex", alignItems: "center", justifyContent: "center",
  };
}

// Wallpaper backdrop for showing the bubble in context
function Desktop({ children, w, h }) {
  return (
    <div style={{
      width: w, height: h, position: "relative", overflow: "hidden", borderRadius: 8,
      background:
        "radial-gradient(900px 500px at 0% 0%, #2c2238 0%, transparent 60%)," +
        "radial-gradient(700px 500px at 100% 100%, #1a2230 0%, transparent 60%)," +
        "#15161a",
      border: "1px solid var(--border-faint)",
    }}>
      {/* faint window suggestion */}
      <div style={{
        position: "absolute", left: 22, top: 22, width: w - 44, height: h - 44,
        borderRadius: 8, border: "1px solid rgba(255,255,255,0.04)",
        background: "rgba(255,255,255,0.012)",
      }}/>
      <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
        {children}
      </div>
    </div>
  );
}

window.WebcamOrbit = WebcamOrbit;
window.WebcamHalo = WebcamHalo;
window.WebcamDock = WebcamDock;
window.Desktop = Desktop;
