import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";

export type RecordingState = "idle" | "recording" | "paused";

type EngineEventEnvelope = {
  event: string;
  elapsed_s?: number;
  duration_s?: number;
};

export function useRecordingState() {
  const [state, setState] = useState<RecordingState>("idle");
  const [elapsed, setElapsed] = useState(0);
  const [capSec, setCapSec] = useState<number | null>(null);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;

    (async () => {
      const fn = await listen<EngineEventEnvelope>("engine-event", (e) => {
        const ev = e.payload;
        switch (ev.event) {
          case "started":
            setState("recording");
            setElapsed(0);
            break;
          case "progress":
            if (typeof ev.elapsed_s === "number") setElapsed(ev.elapsed_s);
            break;
          case "paused":
            setState("paused");
            if (typeof ev.elapsed_s === "number") setElapsed(ev.elapsed_s);
            break;
          case "resumed":
            setState("recording");
            if (typeof ev.elapsed_s === "number") setElapsed(ev.elapsed_s);
            break;
          case "stopped":
            setState("idle");
            if (typeof ev.duration_s === "number") setElapsed(ev.duration_s);
            break;
        }
      });
      if (cancelled) {
        fn();
        return;
      }
      unlisten = fn;
    })();

    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    (async () => {
      const fn = await listen<{ capSec: number | null }>("length-cap", (e) => {
        const v = e.payload.capSec;
        setCapSec(typeof v === "number" && v > 0 ? v : null);
      });
      if (cancelled) {
        fn();
        return;
      }
      unlisten = fn;
    })();
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, []);

  // Redundant signal from the main window (App.tsx broadcasts on every state
  // change). Catches the case where this hook mounted after the engine
  // emitted `started` and missed it. App.tsx's "countdown" maps to "idle"
  // here — bubble controls only show during real recording.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    (async () => {
      const fn = await listen<{
        state: "idle" | "countdown" | "recording" | "paused";
        elapsed_s: number;
        cap_sec: number | null;
      }>("recording-state", (e) => {
        const s = e.payload.state;
        setState(s === "countdown" ? "idle" : s);
        if (typeof e.payload.elapsed_s === "number") {
          setElapsed(e.payload.elapsed_s);
        }
        const cap = e.payload.cap_sec;
        setCapSec(typeof cap === "number" && cap > 0 ? cap : null);
      });
      if (cancelled) {
        fn();
        return;
      }
      unlisten = fn;
    })();
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, []);

  return { state, elapsed, capSec };
}
