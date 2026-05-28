#!/usr/bin/env python3
"""UAT-1: Mic hot-swap (R4) — manual hardware test of D-07's MIC_DROPPED bucket.

Drives the engine over IPC and times the recording, but the mic drop itself is
a PHYSICAL action: at the T+10s mark this script prints an ACTION banner and you
must sleep the iPhone (Continuity) or unplug the USB mic. The script keeps the
recording running to T+25s, then stops.

Per-take expected outcome (PLAN UAT-1):
  - `stopped` event fires; NO `MIC_SESSION_FAILED` IPC error.
  - Engine stderr contains a `MIC_DROPPED reason=<reason>` line.
  - Output MP4: video ~25s, audio ~10s (audio cleanly truncated on purpose).

If the Continuity drop emits MIC_SESSION_FAILED instead of routing to
MIC_DROPPED, that is the D-07 bucket-boundary violation (PLAN FLAG-1) — a
CONTEXT amendment is required before c3 commits. This script flags it loudly.

Usage:
  python3 uat1.py [--mic <uid>] [--display <id>] [--takes 3]
                  [--drop-at 10] [--stop-at 25]

With no --mic, prefers a Continuity (UUID-pattern uid) mic, else the first
non-built-in mic. All enumerated mics are printed so you can re-run with --mic.
"""

import argparse
import json
import os
import queue
import re
import subprocess
import sys
import threading
import time
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent.parent
ENGINE = REPO / "src-tauri" / "recording-engine" / ".build" / "release" / "recording-engine"
OUT_DIR = Path(__file__).resolve().parent / "output"
READ_TIMEOUT = 15.0
UUID_RE = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)


def log(msg):
    print(f"[uat1] {msg}", file=sys.stderr, flush=True)


def banner(msg):
    bar = "!" * 60
    print(f"\n{bar}\n  {msg}\n{bar}\n", file=sys.stderr, flush=True)


class EngineIO:
    def __init__(self, proc):
        self.proc = proc
        self.events = queue.Queue()
        self.stderr_lines = []
        threading.Thread(target=self._stdout_reader, daemon=True).start()
        threading.Thread(target=self._stderr_capture, daemon=True).start()

    def _stdout_reader(self):
        for raw in iter(self.proc.stdout.readline, b""):
            line = raw.decode("utf-8", "replace").strip()
            if not line:
                continue
            try:
                self.events.put(json.loads(line))
            except json.JSONDecodeError:
                log(f"non-JSON: {line!r}")
        self.events.put(None)

    def _stderr_capture(self):
        for raw in iter(self.proc.stderr.readline, b""):
            line = raw.decode("utf-8", "replace").rstrip()
            self.stderr_lines.append(line)
            sys.stderr.write(f"engine: {line}\n")
            sys.stderr.flush()

    def send(self, obj):
        self.proc.stdin.write((json.dumps(obj) + "\n").encode())
        self.proc.stdin.flush()
        log(f">> {json.dumps(obj)}")

    def wait_event(self, predicate, timeout=READ_TIMEOUT):
        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return None
            try:
                ev = self.events.get(timeout=max(0.05, remaining))
            except queue.Empty:
                return None
            if ev is None:
                return None
            log(f"<< {json.dumps(ev)}")
            if predicate(ev):
                return ev

    def drain(self, seconds):
        """Drain events for `seconds`, returning any error event seen first."""
        deadline = time.monotonic() + seconds
        first_error = None
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return first_error
            try:
                ev = self.events.get(timeout=max(0.05, remaining))
            except queue.Empty:
                continue
            if ev is None:
                return first_error
            log(f"<< {json.dumps(ev)}")
            if ev.get("event") == "error" and first_error is None:
                first_error = ev


def spawn():
    proc = subprocess.Popen(
        [str(ENGINE)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        bufsize=0,
        env=os.environ.copy(),
    )
    return proc, EngineIO(proc)


def kill(proc):
    if proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(timeout=5.0)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()


def is_builtin(mic):
    uid = mic.get("uid", "")
    name = mic.get("name", "")
    return "BuiltIn" in uid or "Built-in" in name or "MacBook" in name


def pick_mic(mics, override):
    if override:
        return override
    # UAT-1 wants a droppable external mic. Prefer Continuity (UUID uid),
    # then any non-built-in, then warn and fall back to the first mic.
    for m in mics:
        if UUID_RE.match(m.get("uid", "")):
            return m["uid"]
    for m in mics:
        if not is_builtin(m):
            return m["uid"]
    if mics:
        log("warning: only built-in mic available — a hot-swap drop is not "
            "physically possible on the built-in mic. Use Continuity/USB.")
        return mics[0]["uid"]
    return None


def enumerate_devices(io, mic_override):
    io.send({"command": "enumerate"})
    ev = io.wait_event(lambda e: e.get("event") == "enumerated")
    if not ev:
        return None, None
    displays = ev.get("displays", [])
    mics = ev.get("microphones", [])
    log("microphones:")
    for m in mics:
        tag = "BUILTIN" if is_builtin(m) else ("CONTINUITY" if UUID_RE.match(m.get("uid", "")) else "EXTERNAL")
        log(f"  [{tag}] {m.get('name')!r} uid={m.get('uid')}")
    display_id = displays[0]["id"] if displays else None
    mic_uid = pick_mic(mics, mic_override)
    return display_id, mic_uid


def ffprobe(args, mp4):
    cmd = ["ffprobe", "-v", "error", *args, "-of", "csv=p=0", str(mp4)]
    try:
        return subprocess.check_output(cmd, stderr=subprocess.DEVNULL, text=True).strip()
    except (subprocess.CalledProcessError, FileNotFoundError):
        return ""


def measure(mp4):
    video_dur = ffprobe(
        ["-select_streams", "v:0", "-show_entries", "stream=duration"], mp4)
    audio_dur = ffprobe(
        ["-select_streams", "a:0", "-show_entries", "stream=duration"], mp4)

    def as_float(s):
        try:
            return float(s)
        except (ValueError, TypeError):
            return None
    return as_float(video_dur), as_float(audio_dur)


MIC_DROPPED_RE = re.compile(r"MIC_DROPPED(?:\s+reason=(?P<reason>.+))?")


def run_take(idx, args):
    log(f"\n========== TAKE {idx} ==========")
    proc, io = spawn()
    take = {"idx": idx}
    try:
        ready = io.wait_event(lambda e: e.get("event") == "ready", timeout=10.0)
        if not ready:
            take["error"] = "no ready event"
            return take

        display_id, mic_uid = enumerate_devices(io, args.mic)
        if args.display:
            display_id = args.display
        if not display_id or not mic_uid:
            take["error"] = "no display or mic"
            return take
        log(f"display_id={display_id} mic_uid={mic_uid}")

        mp4 = OUT_DIR / f"uat1-take{idx}.mp4"
        if mp4.exists():
            mp4.unlink()
        stderr_mark = len(io.stderr_lines)

        banner(f"TAKE {idx} STARTING — recording begins now. "
               f"Have the mic CONNECTED and ready.")
        io.send({
            "command": "start",
            "display_id": display_id,
            "microphone_uid": mic_uid,
            "output_path": str(mp4),
            "max_fps": 30,
        })
        # Continuity mics can take >15s to activate on a cold start right
        # after a Wi-Fi reconnect (a long tail of the finding-1 latency).
        started = io.wait_event(
            lambda e: e.get("event") in ("started", "error"), timeout=30.0)
        if not started or started.get("event") != "started":
            take["error"] = f"did not start: {started}"
            return take
        t0 = time.monotonic()

        # Run to drop-at, draining events (catch an early MIC_SESSION_FAILED).
        err = io.drain(args.drop_at)
        if err:
            take["fatal_before_drop"] = err
            log(f"FATAL before drop point: {err}")

        banner(f"ACTION REQUIRED NOW: DROP THE MIC "
               f"(sleep iPhone / unplug USB). Leave it dropped until stop.")

        # Run from drop-at to stop-at, watching for a fatal error.
        remaining = args.stop_at - (time.monotonic() - t0)
        err2 = io.drain(max(0.0, remaining))
        if err2 and "fatal_before_drop" not in take:
            take["fatal_after_drop"] = err2

        io.send({"command": "stop"})
        stopped = io.wait_event(
            lambda e: e.get("event") in ("stopped", "error"), timeout=20.0)
        take["stopped_event"] = stopped

        # Scan the stderr produced during this take for MIC_DROPPED.
        new_lines = io.stderr_lines[stderr_mark:]
        drop_reason = None
        for ln in new_lines:
            m = MIC_DROPPED_RE.search(ln)
            if m:
                drop_reason = m.group("reason") or "(no reason key)"
                break
        take["mic_dropped"] = drop_reason is not None
        take["drop_reason"] = drop_reason

        # Any MIC_SESSION_FAILED anywhere = bucket-boundary violation.
        take["mic_session_failed"] = any(
            (e or {}).get("code") == "MIC_SESSION_FAILED"
            for e in (take.get("fatal_before_drop"), take.get("fatal_after_drop"),
                      stopped if (stopped or {}).get("event") == "error" else None)
        )

        v, a = measure(mp4)
        take["video_dur"] = v
        take["audio_dur"] = a
    finally:
        io.send({"command": "quit"})
        try:
            proc.wait(timeout=5.0)
        except subprocess.TimeoutExpired:
            pass
        kill(proc)
    return take


def verdict_take(t, args):
    stopped_ok = (t.get("stopped_event") or {}).get("event") == "stopped"
    no_session_fail = not t.get("mic_session_failed")
    dropped_ok = bool(t.get("mic_dropped"))
    v, a = t.get("video_dur"), t.get("audio_dur")
    video_ok = v is not None and abs(v - args.stop_at) <= 3.0
    # Audio drop time is human; assert it is clearly shorter than video.
    audio_ok = (a is not None and v is not None and a < v - 3.0)
    checks = {
        "stopped (no MIC_SESSION_FAILED)": stopped_ok and no_session_fail,
        "MIC_DROPPED in stderr": dropped_ok,
        f"video ~{args.stop_at}s": video_ok,
        "audio clearly truncated < video": audio_ok,
    }
    return checks, all(checks.values())


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--mic", default=None, help="override microphone uid")
    p.add_argument("--display", type=int, default=None, help="override display id")
    p.add_argument("--takes", type=int, default=3)
    p.add_argument("--drop-at", type=int, default=10, help="seconds into take to drop mic")
    p.add_argument("--stop-at", type=int, default=25, help="seconds into take to stop")
    args = p.parse_args()

    if not ENGINE.exists():
        log(f"engine binary not found at {ENGINE} — run: "
            f"(cd src-tauri/recording-engine && swift build -c release)")
        return 2
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    takes = []
    for i in range(1, args.takes + 1):
        takes.append(run_take(i, args))
        if i < args.takes:
            banner(f"RECONNECT THE MIC, then press Enter for take {i + 1}.")
            try:
                input()
            except EOFError:
                pass

    print("\n" + "=" * 60)
    print("UAT-1 RESULTS (hot-swap / MIC_DROPPED — R4)")
    print("=" * 60)
    all_pass = True
    for t in takes:
        print(f"\nTake {t['idx']}:")
        if t.get("error"):
            print(f"  SETUP ERROR: {t['error']}")
            all_pass = False
            continue
        print(f"  drop reason: {t.get('drop_reason')}")
        print(f"  video_dur={t.get('video_dur')}s  audio_dur={t.get('audio_dur')}s")
        if t.get("mic_session_failed"):
            print("  ** MIC_SESSION_FAILED fired — D-07 BUCKET-BOUNDARY VIOLATION (PLAN FLAG-1) **")
        checks, ok = verdict_take(t, args)
        for label, passed in checks.items():
            print(f"  [{'PASS' if passed else 'FAIL'}] {label}")
        all_pass = all_pass and ok

    # Consistency across takes (PLAN: 3 runs, consistent outcomes).
    reasons = {t.get("drop_reason") for t in takes if t.get("drop_reason")}
    print(f"\nInterruption reason(s) observed: {reasons or '(none captured)'}")
    print(f"\nOVERALL: {'PASS' if all_pass else 'FAIL'}")

    # D-05b: self-clean this run's take mp4s (the harness bypasses the Tauri
    # launch sweeper, so it owns its own cleanup — no dev accumulation).
    removed = 0
    for t in takes:
        mp4 = OUT_DIR / f"uat1-take{t['idx']}.mp4"
        if mp4.exists():
            mp4.unlink()
            removed += 1
    log(f"cleaned up {removed} take mp4(s)")

    return 0 if all_pass else 1


if __name__ == "__main__":
    sys.exit(main())
