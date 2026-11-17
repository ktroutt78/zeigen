// The Recordings window: kept recordings from ~/Movies/Zeigen/.recordings,
// newest first. Open hands the recording to the main window, which owns the
// Review windows (open-recording event, handled in App.tsx).
import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { ask, message } from "@tauri-apps/plugin-dialog";

export type LibraryRecording = {
  stamp: string;
  scratch_mp4_path: string;
  screen_path: string;
  webcam_path: string | null;
  webcam_lead_ms: number;
  source_kind: string;
  name: string | null;
  duration_s: number | null;
  size_bytes: number;
};

// Stamp is YYYY-MM-DD-HHMMSS, local time.
function stampDate(stamp: string): string {
  const m = stamp.match(/^(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})$/);
  if (!m) return stamp;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
  return new Date(y, mo - 1, d, h, mi, s).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function length(s: number | null): string {
  if (s == null) return "-:--";
  const t = Math.round(s);
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
}

function size(bytes: number): string {
  const mb = bytes / 1e6;
  return mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

const SOURCE_LABEL: Record<string, string> = {
  display: "Display",
  window: "Window",
  area: "Area",
};

export default function RecordingsWindow() {
  const [items, setItems] = useState<LibraryRecording[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);

  const load = useCallback(
    () =>
      invoke<LibraryRecording[]>("list_recordings")
        .then((r) => {
          setItems(r);
          setError(null);
        })
        .catch((e) => setError(String(e))),
    [],
  );

  // Reload on open and whenever the window regains focus (a Discard in
  // Review may have removed one, a new recording may have been added).
  useEffect(() => {
    load();
    window.addEventListener("focus", load);
    return () => window.removeEventListener("focus", load);
  }, [load]);

  const onDelete = useCallback(
    async (r: LibraryRecording) => {
      if (await WebviewWindow.getByLabel(`review-${r.stamp}`)) {
        await message("This recording is open in Review. Close it first.", { title: "Recordings" });
        return;
      }
      const ok = await ask(
        `Delete the recording from ${stampDate(r.stamp)}? Files you exported from it stay.`,
        { title: "Delete recording?", kind: "warning", okLabel: "Delete", cancelLabel: "Cancel" },
      );
      if (!ok) return;
      await invoke("discard_recording", { scratchMp4Path: r.scratch_mp4_path }).catch((e) =>
        setError(String(e)),
      );
      load();
    },
    [load],
  );

  // Open is unavailable while a recording runs, like the tray's controls.
  useEffect(() => {
    const p = listen<{ event: string }>("engine-event", (e) => {
      if (e.payload.event === "started") setRecording(true);
      else if (e.payload.event === "stopped" || e.payload.event === "error")
        setRecording(false);
    });
    return () => {
      p.then((f) => f());
    };
  }, []);

  return (
    <main
      style={{
        minHeight: "100vh",
        background: "var(--bg-window)",
        color: "var(--fg-primary)",
        padding: "14px 14px 16px",
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      {error && (
        <div style={{ color: "var(--recording-tint)", fontSize: "var(--text-small)" }}>
          {error}
        </div>
      )}
      {items && items.length === 0 && (
        <div className="faint" style={{ fontSize: "var(--text-body)", padding: "8px 2px" }}>
          No recordings yet. Recordings are kept here for 30 days.
        </div>
      )}
      {items && items.length > 0 && (
        <div
          style={{
            background: "var(--bg-sidebar)",
            borderRadius: "var(--r-lg)",
            padding: "4px 0",
          }}
        >
          {items.map((r, i) => (
            <div
              key={r.stamp}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                padding: "9px 14px",
                borderTop: i === 0 ? "none" : "1px solid var(--border-faint)",
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  title={r.name ?? undefined}
                  style={{
                    fontSize: "var(--text-body)",
                    fontWeight: 500,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {r.name ?? stampDate(r.stamp)}
                </div>
                <div
                  className="faint"
                  style={{
                    fontSize: "var(--text-caption)",
                    marginTop: 2,
                    // The date joins this line when a name takes the main one.
                    ...(r.name ? { whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } : {}),
                  }}
                >
                  {r.name && `${stampDate(r.stamp)} · `}
                  <span style={{ fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" }}>
                    {length(r.duration_s)}
                  </span>
                  {" · "}
                  {size(r.size_bytes)}
                  {" · "}
                  {SOURCE_LABEL[r.source_kind] ?? r.source_kind}
                  {" · "}
                  {r.webcam_path ? "Webcam" : "No webcam"}
                </div>
              </div>
              <button
                className="btn-secondary"
                disabled={recording}
                title={recording ? "Unavailable while recording" : undefined}
                onClick={() => emit("open-recording", r).catch(() => {})}
                style={{
                  fontSize: "var(--text-small)",
                  opacity: recording ? 0.4 : 1,
                  cursor: recording ? "not-allowed" : "pointer",
                }}
              >
                Open
              </button>
              <button
                className="btn-ghost"
                onClick={() => onDelete(r)}
                style={{ fontSize: "var(--text-small)", color: "var(--fg-secondary)" }}
              >
                Delete
              </button>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
