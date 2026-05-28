#!/usr/bin/env python3
"""UAT-3: ZEIGEN_FORCE_CLOCK_MISMATCH=1 fault injection.

Tests the env-var fault path for D-01's CLOCK_MISMATCH error code (D-12).
Expected: engine emits CLOCK_MISMATCH on every start while env var is set,
then accepts a clean start after restart without it.
"""

import json
import os
import queue
import subprocess
import sys
import threading
import time
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent.parent
ENGINE = REPO / "src-tauri" / "recording-engine" / ".build" / "release" / "recording-engine"
OUT_DIR = Path(__file__).resolve().parent / "output"
READ_TIMEOUT = 15.0


def log(msg):
    print(f"[uat3] {msg}", file=sys.stderr, flush=True)


class EngineIO:
    def __init__(self, proc):
        self.proc = proc
        self.events = queue.Queue()
        self._stderr_lines = []
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
            self._stderr_lines.append(line)
            sys.stderr.write(f"engine: {line}\n")
            sys.stderr.flush()

    def send(self, obj):
        self.proc.stdin.write((json.dumps(obj) + "\n").encode())
        self.proc.stdin.flush()
        log(f">> {json.dumps(obj)}")

    def recv(self, timeout=READ_TIMEOUT):
        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return None
            try:
                ev = self.events.get(timeout=remaining)
                if ev is not None:
                    log(f"<< {json.dumps(ev)}")
                return ev
            except queue.Empty:
                return None

    def wait_event(self, predicate, timeout=READ_TIMEOUT):
        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return None
            try:
                ev = self.events.get(timeout=remaining)
            except queue.Empty:
                return None
            if ev is None:
                return None
            log(f"<< {json.dumps(ev)}")
            if predicate(ev):
                return ev

    def drain(self, timeout=0.5):
        """Drain any pending events."""
        deadline = time.monotonic() + timeout
        collected = []
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            try:
                ev = self.events.get(timeout=max(0.05, remaining))
                if ev is None:
                    break
                log(f"<< (drain) {json.dumps(ev)}")
                collected.append(ev)
            except queue.Empty:
                break
        return collected


def spawn(env=None):
    merged = {**os.environ, **(env or {})}
    proc = subprocess.Popen(
        [str(ENGINE)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        bufsize=0,
        env=merged,
    )
    io = EngineIO(proc)
    return proc, io


def get_display_and_mic(io):
    io.send({"command": "enumerate"})
    ev = io.wait_event(lambda e: e.get("event") == "enumerated")
    if not ev:
        return None, None
    displays = ev.get("displays", [])
    mics = ev.get("microphones", [])
    display_id = displays[0]["id"] if displays else None
    mic_uid = mics[0]["uid"] if mics else None
    return display_id, mic_uid


def wait_ready(io):
    ev = io.wait_event(lambda e: e.get("event") == "ready", timeout=10.0)
    if ev:
        log(f"engine ready: version={ev.get('version')}")
    return ev


def kill(proc):
    if proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(timeout=5.0)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    results = {}

    # ------------------------------------------------------------------ #
    # Phase A: ZEIGEN_FORCE_CLOCK_MISMATCH=1 — two starts in same process #
    # ------------------------------------------------------------------ #
    log("=== Phase A: CLOCK_MISMATCH forced (two starts) ===")
    proc, io = spawn(env={"ZEIGEN_FORCE_CLOCK_MISMATCH": "1"})

    if not wait_ready(io):
        log("FAIL: no ready event")
        kill(proc)
        sys.exit(1)

    display_id, mic_uid = get_display_and_mic(io)
    if not display_id or not mic_uid:
        log("FAIL: no display or mic from enumerate")
        kill(proc)
        sys.exit(1)
    log(f"using display_id={display_id}, mic_uid={mic_uid}")

    start_cmd = {
        "command": "start",
        "display_id": display_id,
        "microphone_uid": mic_uid,
        "output_path": str(OUT_DIR / "uat3-take1.mp4"),
        "max_fps": 30,
    }

    # Start #1
    log("--- Start #1 (should get CLOCK_MISMATCH) ---")
    io.send(start_cmd)
    ev1 = io.wait_event(
        lambda e: e.get("event") in ("started", "error", "stopped"),
        timeout=10.0,
    )
    results["start1_event"] = ev1
    drained1 = io.drain()

    # Start #2 (same process, env var still set)
    log("--- Start #2 (same process, should get CLOCK_MISMATCH again) ---")
    start_cmd2 = {**start_cmd, "output_path": str(OUT_DIR / "uat3-take2.mp4")}
    io.send(start_cmd2)
    ev2 = io.wait_event(
        lambda e: e.get("event") in ("started", "error", "stopped"),
        timeout=10.0,
    )
    results["start2_event"] = ev2
    io.drain()

    io.send({"command": "quit"})
    try:
        proc.wait(timeout=5.0)
    except subprocess.TimeoutExpired:
        pass
    kill(proc)

    # ------------------------------------------------------------------ #
    # Phase B: no env var — normal start succeeds (regression check)      #
    # ------------------------------------------------------------------ #
    log("=== Phase B: regression check — no env var ===")
    proc2, io2 = spawn()

    if not wait_ready(io2):
        log("FAIL: no ready event (phase B)")
        kill(proc2)
        sys.exit(1)

    display_id2, mic_uid2 = get_display_and_mic(io2)
    if not display_id2 or not mic_uid2:
        log("FAIL: no display or mic (phase B)")
        kill(proc2)
        sys.exit(1)

    regress_mp4 = OUT_DIR / "uat3-regress.mp4"
    io2.send({
        "command": "start",
        "display_id": display_id2,
        "microphone_uid": mic_uid2,
        "output_path": str(regress_mp4),
        "max_fps": 30,
    })
    ev_regress = io2.wait_event(
        lambda e: e.get("event") in ("started", "error"),
        timeout=10.0,
    )
    results["regress_start_event"] = ev_regress

    if ev_regress and ev_regress.get("event") == "started":
        time.sleep(1.0)
        io2.send({"command": "stop"})
        ev_stop = io2.wait_event(
            lambda e: e.get("event") in ("stopped", "error"),
            timeout=15.0,
        )
        results["regress_stop_event"] = ev_stop

    io2.send({"command": "quit"})
    try:
        proc2.wait(timeout=5.0)
    except subprocess.TimeoutExpired:
        pass
    kill(proc2)

    # ------------------------------------------------------------------ #
    # Verdict                                                              #
    # ------------------------------------------------------------------ #
    print("\n" + "=" * 60)
    print("UAT-3 RESULTS")
    print("=" * 60)

    ok1 = (ev1 and ev1.get("event") == "error" and ev1.get("code") == "CLOCK_MISMATCH")
    ok2 = (ev2 and ev2.get("event") == "error" and ev2.get("code") == "CLOCK_MISMATCH")
    ok_regress = (results.get("regress_start_event") and
                  results["regress_start_event"].get("event") == "started")

    print(f"Start #1 event:  {json.dumps(ev1)}")
    print(f"Start #2 event:  {json.dumps(ev2)}")
    print(f"Regress start:   {json.dumps(results.get('regress_start_event'))}")
    print(f"Regress stop:    {json.dumps(results.get('regress_stop_event'))}")
    print()
    print(f"[{'PASS' if ok1 else 'FAIL'}] Start #1 emits CLOCK_MISMATCH error")
    print(f"[{'PASS' if ok2 else 'FAIL'}] Start #2 emits CLOCK_MISMATCH error (same process)")
    print(f"[{'PASS' if ok_regress else 'FAIL'}] Regression: clean start succeeds without env var")

    all_pass = ok1 and ok2 and ok_regress
    print(f"\nOVERALL: {'PASS' if all_pass else 'FAIL'}")
    return 0 if all_pass else 1


if __name__ == "__main__":
    sys.exit(main())
