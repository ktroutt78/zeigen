// macOS tray menu — native NSMenu look. Idle + Recording states.
// 1px hairlines, system-tinted highlight on hover, monochrome SF-Symbols-ish icons,
// keyboard equivalents right-aligned, submenu chevrons.

function TrayMenu({ state = "idle" }) {
  const recording = state === "recording";
  const elapsed = recording ? "01:24" : null;
  const camera = "Continuity Camera · iPhone";
  const screen = "Built-in Retina Display";

  // Common item row
  const Item = ({ icon, label, kbd, sub, danger, onHover, hasSubmenu, header, dim }) => {
    const [hov, setHov] = React.useState(false);
    const isHover = hov && !header;
    return (
      <div
        onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
        style={{
          display: "grid",
          gridTemplateColumns: "20px 1fr auto",
          alignItems: "center",
          gap: 8,
          padding: "0 12px 0 10px",
          height: header ? 30 : 22,
          margin: "0 4px",
          borderRadius: 4,
          background: isHover ? "rgba(255,255,255,0.10)" : "transparent",
          color: header ? "var(--fg-tertiary)" :
                  danger ? "#ff8a80" :
                  dim ? "var(--fg-tertiary)" : "var(--fg-primary)",
          cursor: header ? "default" : "default",
          fontSize: header ? 11 : 13,
          fontWeight: header ? 600 : 400,
          letterSpacing: header ? "0.04em" : "-0.005em",
          textTransform: header ? "uppercase" : "none",
          fontFamily: "var(--font-system)",
        }}>
        <span style={{ display: "inline-flex", color: header ? "var(--fg-tertiary)" : (isHover ? "var(--fg-primary)" : "var(--fg-secondary)") }}>
          {icon}
        </span>
        <span style={{ display: "flex", alignItems: "baseline", gap: 6, minWidth: 0 }}>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
          {sub && <span style={{ color: "var(--fg-tertiary)", fontSize: 11.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{sub}</span>}
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4, color: "var(--fg-tertiary)", fontSize: 12, fontFamily: "var(--font-system)" }}>
          {kbd}
          {hasSubmenu && <Icon d={I.chevronRight.props.d} size={10} stroke={1.4} style={{ marginLeft: 2, opacity: 0.6 }}/>}
        </span>
      </div>
    );
  };

  const Sep = () => (
    <div style={{ height: 1, background: "var(--border-faint)", margin: "5px 8px" }}/>
  );

  return (
    <div style={{
      width: 296,
      background: "rgba(40,40,42,0.96)",
      backdropFilter: "blur(20px) saturate(1.4)",
      border: "0.5px solid rgba(0,0,0,0.5)",
      boxShadow: "0 18px 56px rgba(0,0,0,0.55), 0 0 0 0.5px rgba(255,255,255,0.05) inset",
      borderRadius: 8,
      padding: "5px 0",
      color: "var(--fg-primary)",
      fontFamily: "var(--font-system)",
      fontSize: 13,
      position: "relative",
    }}>
      {/* Status header — not interactive */}
      <div style={{ padding: "6px 14px 8px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            {recording ? (
              <>
                <span className="rec-dot"/>
                <span style={{ fontSize: 12, fontWeight: 600, color: "var(--fg-primary)", letterSpacing: "-0.005em" }}>Recording</span>
              </>
            ) : (
              <>
                <span style={{ width: 8, height: 8, borderRadius: 99, background: "var(--fg-quaternary)", display: "inline-block" }}/>
                <span style={{ fontSize: 12, fontWeight: 600, color: "var(--fg-secondary)", letterSpacing: "-0.005em" }}>Zeigen — Idle</span>
              </>
            )}
          </div>
          {recording && (
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "oklch(0.78 0.15 25)", fontVariantNumeric: "tabular-nums", fontWeight: 500 }}>
              {elapsed}
            </span>
          )}
        </div>
        {recording && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6, fontSize: 11, color: "var(--fg-tertiary)" }}>
            <span style={{ fontFamily: "var(--font-mono)" }}>1080p · 60fps</span>
            <span>·</span>
            <span>Display + Mic + Camera</span>
          </div>
        )}
      </div>

      <Sep/>

      {/* Main action — Start / Stop / Pause */}
      {recording ? (
        <>
          <Item
            icon={<span style={{ width: 10, height: 10, borderRadius: 1, background: "oklch(0.62 0.18 25)", display: "inline-block" }}/>}
            label="Stop Recording"
            kbd={<><span className="kbd">⌥</span><span className="kbd">⇧</span><span className="kbd">5</span></>}
          />
          <Item
            icon={<Icon d={I.pause.props.d} size={12} stroke={1.4}/>}
            label="Pause"
            kbd={<><span className="kbd">⌥</span><span className="kbd">⇧</span><span className="kbd">P</span></>}
          />
          <Item
            icon={<Icon d="M1.5 8h13M11 4.5L14.5 8 11 11.5" size={12} stroke={1.4}/>}
            label="Mark Moment"
            kbd={<><span className="kbd">⌥</span><span className="kbd">M</span></>}
          />
          <Item
            icon={<Icon d={I.trash.props.d} size={12} stroke={1.4}/>}
            label="Cancel & Discard"
            danger
          />
        </>
      ) : (
        <>
          <Item
            icon={<span style={{ width: 8, height: 8, borderRadius: 99, background: "var(--accent)", display: "inline-block",
              boxShadow: "0 0 0 2px var(--accent-soft)" }}/>}
            label="Start Recording"
            kbd={<><span className="kbd">⌥</span><span className="kbd">⇧</span><span className="kbd">5</span></>}
          />
          <Item
            icon={<Icon d={I.area.props.d} size={12} stroke={1.4}/>}
            label="Record Area…"
            kbd={<><span className="kbd">⌥</span><span className="kbd">⇧</span><span className="kbd">4</span></>}
          />
          <Item
            icon={<Icon d={I.window.props.d} size={12} stroke={1.4}/>}
            label="Record Window…"
            kbd={<><span className="kbd">⌥</span><span className="kbd">⇧</span><span className="kbd">W</span></>}
          />
        </>
      )}

      <Sep/>

      {/* Source submenus */}
      <Item
        icon={<Icon d={I.webcam.props.d} size={12} stroke={1.4}/>}
        label="Camera"
        sub={camera}
        hasSubmenu
      />
      <Item
        icon={<Icon d={I.monitor.props.d} size={12} stroke={1.4}/>}
        label="Screen"
        sub={screen}
        hasSubmenu
      />
      <Item
        icon={<Icon d={I.mic.props.d} size={12} stroke={1.4}/>}
        label="Microphone"
        sub="MacBook Pro Mic"
        hasSubmenu
      />

      <Sep/>

      {/* Recent — only meaningful when idle */}
      {!recording && (
        <>
          <Item icon={null} label="Recent Recordings" header/>
          <Item
            icon={<Icon d={I.video.props.d} size={12} stroke={1.4}/>}
            label="Onboarding flow"
            sub="2:22 · today"
            kbd={<span className="kbd">⌘1</span>}
          />
          <Item
            icon={<Icon d={I.video.props.d} size={12} stroke={1.4}/>}
            label="Bug repro · auth"
            sub="0:48 · yesterday"
            kbd={<span className="kbd">⌘2</span>}
          />
          <Sep/>
        </>
      )}

      <Item
        icon={<Icon d={I.gear.props.d} size={12} stroke={1.4}/>}
        label="Settings…"
        kbd={<><span className="kbd">⌘</span><span className="kbd">,</span></>}
      />
      <Item
        icon={<Icon d={I.power.props.d} size={12} stroke={1.4}/>}
        label="Quit Zeigen"
        kbd={<><span className="kbd">⌘</span><span className="kbd">Q</span></>}
      />
    </div>
  );
}

// Wrapper that places the menu under a faux menu-bar with the app's tray icon
function TrayContext({ children, state }) {
  const recording = state === "recording";
  return (
    <div style={{ position: "relative", width: 380, height: "auto" }}>
      {/* Faux menu bar (translucent dark) */}
      <div style={{
        position: "relative", height: 26,
        background: "rgba(30,30,32,0.92)",
        backdropFilter: "blur(16px)",
        borderTopLeftRadius: 6, borderTopRightRadius: 6,
        borderBottom: "0.5px solid rgba(0,0,0,0.4)",
        display: "flex", alignItems: "center",
        padding: "0 12px",
        color: "rgba(255,255,255,0.85)",
        fontSize: 13,
        gap: 14,
      }}>
        <span style={{ width: 14, height: 14, borderRadius: 3,
          background: "linear-gradient(135deg, #f4f4f7, #cfcfd4)", display: "inline-block" }}/>
        <span style={{ fontWeight: 600, letterSpacing: "-0.005em" }}>Zeigen</span>
        <span style={{ color: "rgba(255,255,255,0.55)" }}>File</span>
        <span style={{ color: "rgba(255,255,255,0.55)" }}>Edit</span>
        <span style={{ color: "rgba(255,255,255,0.55)" }}>View</span>
        <span style={{ color: "rgba(255,255,255,0.55)" }}>Help</span>
        <div style={{ flex: 1 }}/>
        {/* status bar items */}
        <span style={{ color: "rgba(255,255,255,0.6)", fontFamily: "var(--font-mono)", fontSize: 11 }}>100%</span>
        <span style={{ color: "rgba(255,255,255,0.6)" }}>
          <Icon d="M2 8a6 6 0 0112 0M4 8a4 4 0 018 0M6 8a2 2 0 014 0" size={11} stroke={1.4}/>
        </span>
        {/* The tray icon — highlighted to show it's "open" */}
        <span style={{
          display: "inline-flex", alignItems: "center", gap: 5,
          padding: "1px 6px", borderRadius: 4,
          background: "rgba(255,255,255,0.12)",
        }}>
          {recording ? (
            <>
              <span className="rec-dot" style={{ width: 6, height: 6 }}/>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "oklch(0.85 0.13 25)" }}>01:24</span>
            </>
          ) : (
            <Icon d="M2 4.5h12M2 9h12M2 13.5h7" size={12} stroke={1.4}/>
          )}
          {!recording && <Icon d="M2.5 5.5L8 11l5.5-5.5" size={11} stroke={1.4}/>}
        </span>
        <span style={{ color: "rgba(255,255,255,0.6)", fontSize: 11.5, fontFamily: "var(--font-system)" }}>Fri 11:24</span>
      </div>
      {/* Translucent backdrop suggestion */}
      <div style={{
        height: 16,
        background: "linear-gradient(to bottom, rgba(60,55,70,0.4), transparent)",
      }}/>
      {/* Pointer connecting the tray icon to the menu */}
      <div style={{ display: "flex", justifyContent: "flex-end", paddingRight: 50, marginTop: -16 }}>
        <div style={{ marginTop: 10 }}>{children}</div>
      </div>
    </div>
  );
}

window.TrayMenu = TrayMenu;
window.TrayContext = TrayContext;
