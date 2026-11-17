// The Recordings window: kept recordings from the Save to folder's .recordings
// (plus any still waiting to move there, storage.rs) as a grid of cards grouped by day, newest first. Clicking a card hands the
// recording to the main window, which owns the Review windows (open-recording
// event, handled in App.tsx). Durations and thumbnails are filled in by the
// backend after the list appears (library-recording events, library.rs).
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { ask, message } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import "./styles/recordings.css";

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
  thumb_path: string | null;
  // Still on this Mac, waiting to move to the Save to folder's drive.
  pending_move: boolean;
};

type Library = { keep_days: number; recordings: LibraryRecording[] };

// Stamp is YYYY-MM-DD-HHMMSS, local time.
function stampTime(stamp: string): Date | null {
  const m = stamp.match(/^(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})$/);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
  return new Date(y, mo - 1, d, h, mi, s);
}

function stampDate(stamp: string): string {
  return (
    stampTime(stamp)?.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) ?? stamp
  );
}

// "Today", "Yesterday", "Nov 15", or "Nov 15, 2025" outside the current year.
function dayLabel(d: Date, now: Date): string {
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86_400_000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: d.getFullYear() === now.getFullYear() ? undefined : "numeric",
  });
}

function length(s: number): string {
  const t = Math.round(s);
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
}

function size(bytes: number): string {
  const mb = bytes / 1e6;
  return mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

const FALLBACK_NAME: Record<string, string> = {
  window: "Window recording",
  display: "Display recording",
  area: "Area recording",
};

function displayName(r: LibraryRecording): string {
  return r.name ?? FALLBACK_NAME[r.source_kind] ?? "Screen recording";
}

const folderOf = (r: LibraryRecording) =>
  r.scratch_mp4_path.slice(0, r.scratch_mp4_path.lastIndexOf("/"));

// An open Review would write its own copy of the name over a rename, and a
// delete would pull the files out from under it.
async function openInReview(r: LibraryRecording, what: string): Promise<boolean> {
  if (!(await WebviewWindow.getByLabel(`review-${r.stamp}`))) return false;
  await message(`This recording is open in Review. Close it first to ${what} it.`, {
    title: "Recordings",
  });
  return true;
}

export default function RecordingsWindow() {
  const [lib, setLib] = useState<Library | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [query, setQuery] = useState("");
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);

  const load = useCallback(
    () =>
      invoke<Library>("list_recordings")
        .then((l) => {
          setLib(l);
          setError(null);
        })
        .catch((e) => setError(String(e))),
    [],
  );

  // Reload on open and whenever the window regains focus (a Discard in
  // Review may have removed one, a new recording may have been added, a new
  // Mark wants a new thumbnail). Cheap: the backend reads only its cache.
  useEffect(() => {
    load();
    window.addEventListener("focus", load);
    return () => window.removeEventListener("focus", load);
  }, [load]);

  // Recordings waiting for the Save to folder's drive were moved there.
  useEffect(() => {
    const p = listen("library-changed", () => load());
    return () => {
      p.then((f) => f());
    };
  }, [load]);

  // A duration or thumbnail the backend just made.
  useEffect(() => {
    const p = listen<LibraryRecording>("library-recording", (e) =>
      setLib((l) =>
        l && {
          ...l,
          recordings: l.recordings.map((r) => (r.stamp === e.payload.stamp ? e.payload : r)),
        },
      ),
    );
    return () => {
      p.then((f) => f());
    };
  }, []);

  // Opening is unavailable while a recording runs, like the tray's controls.
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

  const onDelete = useCallback(
    async (r: LibraryRecording) => {
      if (await openInReview(r, "delete")) return;
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

  const onStartRename = useCallback(async (r: LibraryRecording) => {
    if (await openInReview(r, "rename")) return;
    setRenaming(r.stamp);
  }, []);

  const onRename = useCallback(
    async (r: LibraryRecording, name: string) => {
      setRenaming(null);
      if (!name || name === displayName(r)) return;
      await invoke("rename_recording", { sourcePath: r.scratch_mp4_path, name }).catch((e) =>
        setError(`rename: ${e}`),
      );
      load();
    },
    [load],
  );

  const onReveal = useCallback((r: LibraryRecording) => {
    revealItemInDir(folderOf(r)).catch((e) => setError(`show in Finder: ${e}`));
  }, []);

  const all = lib?.recordings ?? [];
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const now = new Date();
    const out: { label: string; items: LibraryRecording[] }[] = [];
    for (const r of all) {
      if (q && !displayName(r).toLowerCase().includes(q)) continue;
      const d = stampTime(r.stamp);
      const label = d ? dayLabel(d, now) : "Older";
      const last = out[out.length - 1];
      if (last?.label === label) last.items.push(r);
      else out.push({ label, items: [r] });
    }
    return out;
  }, [all, query]);

  const total = all.reduce((n, r) => n + r.size_bytes, 0);

  return (
    <main
      style={{
        height: "100vh",
        background: "var(--bg-window)",
        color: "var(--fg-primary)",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "flex-end",
          gap: 16,
          padding: "18px 24px 16px",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
          <h1
            style={{
              margin: 0,
              fontSize: 20,
              fontWeight: 650,
              letterSpacing: "var(--track-tight)",
            }}
          >
            Recordings
          </h1>
          {lib && all.length > 0 && (
            <span className="faint" style={{ fontSize: "var(--text-small)", whiteSpace: "nowrap" }}>
              {all.length === 1 ? "1 recording" : `${all.length} recordings`} · {size(total)} · kept
              for {lib.keep_days} days
            </span>
          )}
        </div>
        <div style={{ flex: 1 }} />
        <label className="rec-search">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-4-4" />
          </svg>
          <input
            type="search"
            placeholder="Search"
            aria-label="Search recordings"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
      </header>

      <div
        className="scroll"
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "0 24px 24px",
          display: "flex",
          flexDirection: "column",
          gap: 24,
        }}
      >
        {error && (
          <div style={{ color: "var(--recording-tint)", fontSize: "var(--text-small)" }}>{error}</div>
        )}
        {lib && all.length === 0 && (
          <Empty title="No recordings yet">
            Recordings are kept here for {lib.keep_days} days.
          </Empty>
        )}
        {all.length > 0 && groups.length === 0 && (
          <Empty title="No matches">No recording names contain “{query.trim()}”.</Empty>
        )}
        {groups.map((g) => (
          <section key={g.label} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <h2
              style={{
                margin: 0,
                fontSize: "var(--text-body)",
                fontWeight: 600,
                color: "var(--fg-secondary)",
              }}
            >
              {g.label}
            </h2>
            <div className="rec-grid">
              {g.items.map((r) => (
                <Card
                  key={r.stamp}
                  r={r}
                  recording={recording}
                  menuOpen={menuFor === r.stamp}
                  renaming={renaming === r.stamp}
                  onMenu={(open) => setMenuFor(open ? r.stamp : null)}
                  onOpen={() => emit("open-recording", r).catch(() => {})}
                  onStartRename={() => onStartRename(r)}
                  onRename={(name) => onRename(r, name)}
                  onCancelRename={() => setRenaming(null)}
                  onReveal={() => onReveal(r)}
                  onDelete={() => onDelete(r)}
                />
              ))}
            </div>
          </section>
        ))}
      </div>
    </main>
  );
}

function Empty({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={{ padding: "64px 0", textAlign: "center" }}>
      <div style={{ fontSize: "var(--text-title)", fontWeight: 600 }}>{title}</div>
      <div className="faint" style={{ fontSize: "var(--text-body)", marginTop: 6 }}>
        {children}
      </div>
    </div>
  );
}

function Card({
  r,
  recording,
  menuOpen,
  renaming,
  onMenu,
  onOpen,
  onStartRename,
  onRename,
  onCancelRename,
  onReveal,
  onDelete,
}: {
  r: LibraryRecording;
  recording: boolean;
  menuOpen: boolean;
  renaming: boolean;
  onMenu: (open: boolean) => void;
  onOpen: () => void;
  onStartRename: () => void;
  onRename: (name: string) => void;
  onCancelRename: () => void;
  onReveal: () => void;
  onDelete: () => void;
}) {
  const name = displayName(r);
  const moreRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const openRef = useRef<HTMLButtonElement>(null);
  // Esc after a rename should not also save it on the blur that follows.
  const cancelled = useRef(false);

  const onMenuRef = useRef(onMenu);
  onMenuRef.current = onMenu;

  // Keyboard: the menu takes focus when it opens. A click outside it closes it.
  useEffect(() => {
    if (!menuOpen) return;
    menuRef.current?.querySelector("button")?.focus();
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!menuRef.current?.contains(t) && !moreRef.current?.contains(t)) onMenuRef.current(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [menuOpen]);

  const closeMenu = () => {
    onMenu(false);
    moreRef.current?.focus();
  };
  // Focus goes back to the "..." button; Rename then moves it to the name field.
  const pick = (action: () => void) => () => {
    closeMenu();
    action();
  };

  const t = stampTime(r.stamp);
  const time = t?.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

  return (
    <div
      className={`rec-card${recording ? " disabled" : ""}`}
      title={recording ? "Unavailable while recording" : undefined}
    >
      <button
        ref={openRef}
        className="rec-open"
        disabled={recording}
        aria-label={`Open ${name}`}
        onClick={onOpen}
      />
      <div className="rec-thumb">
        {r.thumb_path && <img src={convertFileSrc(r.thumb_path)} alt="" draggable={false} />}
        {r.duration_s != null && <span className="rec-badge">{length(r.duration_s)}</span>}
      </div>
      <button
        ref={moreRef}
        className="rec-more"
        aria-label={`More actions for ${name}`}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={() => onMenu(!menuOpen)}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <circle cx="5" cy="12" r="1.8" />
          <circle cx="12" cy="12" r="1.8" />
          <circle cx="19" cy="12" r="1.8" />
        </svg>
      </button>
      {menuOpen && (
        <div
          ref={menuRef}
          className="rec-menu"
          role="menu"
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              closeMenu();
            }
          }}
          onBlur={(e) => {
            const to = e.relatedTarget as Node | null;
            if (to && !menuRef.current?.contains(to) && to !== moreRef.current) onMenu(false);
          }}
        >
          <button role="menuitem" onClick={pick(onStartRename)}>
            Rename
          </button>
          <button role="menuitem" onClick={pick(onReveal)}>
            Show in Finder
          </button>
          <button role="menuitem" className="danger" onClick={pick(onDelete)}>
            Delete
          </button>
        </div>
      )}
      <div style={{ minWidth: 0 }}>
        {renaming ? (
          <input
            className="rec-rename"
            autoFocus
            defaultValue={name}
            aria-label="Recording name"
            onFocus={(e) => {
              cancelled.current = false;
              e.target.select();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              else if (e.key === "Escape") {
                cancelled.current = true;
                onCancelRename();
                openRef.current?.focus();
              }
            }}
            onBlur={(e) => {
              if (!cancelled.current) onRename(e.target.value.trim());
            }}
          />
        ) : (
          <div className="rec-name" title={name}>
            {name}
          </div>
        )}
        <div className="rec-meta">
          {time} · {size(r.size_bytes)}
          {r.pending_move && " · Not yet moved"}
        </div>
      </div>
    </div>
  );
}
