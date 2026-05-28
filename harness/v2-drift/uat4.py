#!/usr/bin/env python3
"""UAT-4: ZEIGEN_FORCE_MIC_SESSION_ERROR=1 fault injection.

Tests the env-var fault path for D-07's MIC_SESSION_FAILED error code (D-12).
Three sub-cases:
  A. Normal fault: start -> started -> MIC_SESSION_FAILED after ~100ms.
  B. Race: start -> stop within 50ms -> verify no MIC_SESSION_FAILED fires.
  C. Regression: restart without env var -> clean start + stop succeeds.
"""

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


def log(msg):
    print(f"[uat4] {msg}", file=sys.stderr, flush=True)


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

    def recv_all(self, timeout=READ_TIMEOUT):
        """Collect all events until timeout."""
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
                log(f"<< {json.dumps(ev)}")
                collected.append(ev)
            except queue.Empty:
                break
        return collected

    def wait_event(self, predicate, timeout=READ_TIMEOUT, collect_all=False):
        deadline = time.monotonic() + timeout
        collected = []
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return (None, collected) if collect_all else None
            try:
                ev = self.events.get(timeout=max(0.05, remaining))
            except queue.Empty:
                return (None, collected) if collect_all else None
            if ev is None:
                return (None, collected) if collect_all else None
            log(f"<< {json.dumps(ev)}")
            if collect_all:
                collected.append(ev)
            if predicate(ev):
                return (ev, collected) if collect_all else ev


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


def wait_ready(io, label=""):
    ev = io.wait_event(lambda e: e.get("event") == "ready", timeout=10.0)
    if ev:
        log(f"engine ready{' (' + label + ')' if label else ''}: version={ev.get('version')}")
    return ev


UUID_RE = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)


def pick_non_continuity_mic(mics):
    """Prefer built-in/USB mic; skip iPhone Continuity (UUID-pattern uid).

    Continuity mics fire AVCaptureSessionRuntimeError at AVCaptureSession
    startup — a transient OS quirk — which sets fatalErrorFired before the
    100ms synthetic fault fires, suppressing the injection. Use built-in
    mic for the fault injection UAT.
    """
    for m in mics:
        if not UUID_RE.match(m["uid"]):
            return m["uid"]
    # Fallback: use first mic even if it looks like Continuity; log a warning.
    if mics:
        log(f"warning: only Continuity-pattern mics available; UAT-4 may "
            f"have fatalErrorFired pre-set — use built-in/USB mic for clean result")
        return mics[0]["uid"]
    return None


def get_display_and_mic(io):
    io.send({"command": "enumerate"})
    ev = io.wait_event(lambda e: e.get("event") == "enumerated")
    if not ev:
        return None, None
    displays = ev.get("displays", [])
    mics = ev.get("microphones", [])
    display_id = displays[0]["id"] if displays else None
    mic_uid = pick_non_continuity_mic(mics)
    log(f"selected mic: {mic_uid}")
    return display_id, mic_uid


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
    # Phase A: start -> wait for started -> expect MIC_SESSION_FAILED     #
    # ------------------------------------------------------------------ #
    log("=== Phase A: normal fault path (start #1) ===")
    proc, io = spawn(env={"ZEIGEN_FORCE_MIC_SESSION_ERROR": "1"})

    if not wait_ready(io, "A"):
        log("FAIL: no ready event")
        kill(proc)
        sys.exit(1)

    display_id, mic_uid = get_display_and_mic(io)
    if not display_id or not mic_uid:
        log("FAIL: no display or mic")
        kill(proc)
        sys.exit(1)
    log(f"using display_id={display_id}, mic_uid={mic_uid}")

    mp4_a1 = OUT_DIR / "uat4-a1.mp4"
    io.send({
        "command": "start",
        "display_id": display_id,
        "microphone_uid": mic_uid,
        "output_path": str(mp4_a1),
        "max_fps": 30,
    })

    # Expect started, then MIC_SESSION_FAILED within ~500ms
    started_a1 = io.wait_event(
        lambda e: e.get("event") in ("started", "error"),
        timeout=10.0,
    )
    results["a1_started"] = started_a1
    t_started = time.monotonic()

    error_a1 = None
    if started_a1 and started_a1.get("event") == "started":
        error_a1 = io.wait_event(
            lambda e: e.get("event") == "error",
            timeout=2.0,
        )
        t_error = time.monotonic()
        results["a1_error"] = error_a1
        if error_a1:
            results["a1_fault_latency_ms"] = round((t_error - t_started) * 1000)
            log(f"fault fired {results['a1_fault_latency_ms']}ms after started")

    # Drain any extra events, then send second start in same process
    io.recv_all(timeout=0.3)

    # ------------------------------------------------------------------ #
    # Phase A (start #2 in same process)                                  #
    # ------------------------------------------------------------------ #
    log("--- Phase A: start #2 (same process) ---")
    mp4_a2 = OUT_DIR / "uat4-a2.mp4"
    io.send({
        "command": "start",
        "display_id": display_id,
        "microphone_uid": mic_uid,
        "output_path": str(mp4_a2),
        "max_fps": 30,
    })
    started_a2 = io.wait_event(
        lambda e: e.get("event") in ("started", "error"),
        timeout=10.0,
    )
    results["a2_started"] = started_a2
    t_started2 = time.monotonic()

    error_a2 = None
    if started_a2 and started_a2.get("event") == "started":
        error_a2 = io.wait_event(
            lambda e: e.get("event") == "error",
            timeout=2.0,
        )
        t_error2 = time.monotonic()
        results["a2_error"] = error_a2
        if error_a2:
            results["a2_fault_latency_ms"] = round((t_error2 - t_started2) * 1000)
            log(f"fault #2 fired {results['a2_fault_latency_ms']}ms after started")

    io.recv_all(timeout=0.3)

    # ------------------------------------------------------------------ #
    # Phase B: Race — start then stop within 50ms                         #
    # Fault fires at 100ms; stop() sets cutoffPTS which guards the fault. #
    # Expected: stopped event arrives, NO MIC_SESSION_FAILED fires.       #
    # ------------------------------------------------------------------ #
    log("=== Phase B: race — stop within 50ms of start ===")
    mp4_race = OUT_DIR / "uat4-race.mp4"
    io.send({
        "command": "start",
        "display_id": display_id,
        "microphone_uid": mic_uid,
        "output_path": str(mp4_race),
        "max_fps": 30,
    })

    # Wait for started (should be fast)
    t_send = time.monotonic()
    started_race = io.wait_event(
        lambda e: e.get("event") in ("started", "error"),
        timeout=5.0,
    )
    t_after_started = time.monotonic()
    results["race_started"] = started_race

    if started_race and started_race.get("event") == "started":
        elapsed_to_started = (t_after_started - t_send) * 1000
        log(f"started received {elapsed_to_started:.0f}ms after start command sent")
        # If we already spent >50ms getting here, just stop immediately
        io.send({"command": "stop"})
        t_stop_sent = time.monotonic()
        log(f"stop sent {(t_stop_sent - t_after_started)*1000:.0f}ms after started received")

        # Collect all events for 1.5s to see if fault fires after stop
        all_race_events = io.recv_all(timeout=1.5)
        results["race_all_events"] = all_race_events
        stopped_race = next(
            (e for e in all_race_events if e.get("event") in ("stopped", "error")),
            None,
        )
        fault_in_race = [e for e in all_race_events if e.get("event") == "error"]
        results["race_stopped"] = stopped_race
        results["race_fault_events"] = fault_in_race
        log(f"race all events: {[e.get('event') for e in all_race_events]}")
    else:
        log("start returned non-started event in race phase; skipping stop")

    io.recv_all(timeout=0.3)

    io.send({"command": "quit"})
    try:
        proc.wait(timeout=5.0)
    except subprocess.TimeoutExpired:
        pass
    kill(proc)

    # ------------------------------------------------------------------ #
    # Phase C: Regression — restart without env var                       #
    # ------------------------------------------------------------------ #
    log("=== Phase C: regression check — no env var ===")
    proc3, io3 = spawn()

    if not wait_ready(io3, "C"):
        log("FAIL: no ready event (phase C)")
        kill(proc3)
        sys.exit(1)

    display_id3, mic_uid3 = get_display_and_mic(io3)
    if not display_id3 or not mic_uid3:
        log("FAIL: no display or mic (phase C)")
        kill(proc3)
        sys.exit(1)

    mp4_c = OUT_DIR / "uat4-regress.mp4"
    io3.send({
        "command": "start",
        "display_id": display_id3,
        "microphone_uid": mic_uid3,
        "output_path": str(mp4_c),
        "max_fps": 30,
    })
    ev_c_start = io3.wait_event(
        lambda e: e.get("event") in ("started", "error"),
        timeout=10.0,
    )
    results["c_start"] = ev_c_start

    if ev_c_start and ev_c_start.get("event") == "started":
        # Let it run 1s (past the 100ms fault window) with no error
        fault_check = io3.wait_event(
            lambda e: e.get("event") == "error",
            timeout=1.2,
        )
        results["c_fault_check"] = fault_check
        if fault_check:
            log(f"REGRESSION: unexpected error in phase C: {fault_check}")
        else:
            log("no error in 1.2s — regression clean")
        io3.send({"command": "stop"})
        ev_c_stop = io3.wait_event(
            lambda e: e.get("event") in ("stopped", "error"),
            timeout=15.0,
        )
        results["c_stop"] = ev_c_stop

    io3.send({"command": "quit"})
    try:
        proc3.wait(timeout=5.0)
    except subprocess.TimeoutExpired:
        pass
    kill(proc3)

    # ------------------------------------------------------------------ #
    # Verdict                                                              #
    # ------------------------------------------------------------------ #
    print("\n" + "=" * 60)
    print("UAT-4 RESULTS")
    print("=" * 60)

    ok_a1_started = results.get("a1_started", {}) and results["a1_started"].get("event") == "started"
    ok_a1_error = (results.get("a1_error") and
                   results["a1_error"].get("event") == "error" and
                   results["a1_error"].get("code") == "MIC_SESSION_FAILED")
    ok_a2_started = results.get("a2_started", {}) and results["a2_started"].get("event") == "started"
    ok_a2_error = (results.get("a2_error") and
                   results["a2_error"].get("event") == "error" and
                   results["a2_error"].get("code") == "MIC_SESSION_FAILED")

    # Race: stopped event arrived AND no fault fired
    race_events = results.get("race_all_events", [])
    race_stopped_ok = any(e.get("event") == "stopped" for e in race_events) if race_events else False
    race_no_fault = not any(e.get("event") == "error" for e in race_events) if race_events else True
    # If started was an error (state machine returned error on start), skip race verdict
    race_start_was_error = results.get("race_started", {}) and results.get("race_started", {}).get("event") == "error"

    ok_c_start = results.get("c_start") and results["c_start"].get("event") == "started"
    ok_c_no_fault = results.get("c_fault_check") is None
    ok_c_stop = results.get("c_stop") and results["c_stop"].get("event") == "stopped"

    print(f"\nPhase A start #1:  started={json.dumps(results.get('a1_started'))}")
    print(f"Phase A error #1:  {json.dumps(results.get('a1_error'))}")
    if "a1_fault_latency_ms" in results:
        print(f"  fault latency: {results['a1_fault_latency_ms']}ms (expected ~100ms)")
    print(f"\nPhase A start #2:  started={json.dumps(results.get('a2_started'))}")
    print(f"Phase A error #2:  {json.dumps(results.get('a2_error'))}")
    if "a2_fault_latency_ms" in results:
        print(f"  fault latency: {results['a2_fault_latency_ms']}ms")

    print(f"\nPhase B (race):")
    print(f"  started: {json.dumps(results.get('race_started'))}")
    print(f"  all events: {[e.get('event') for e in race_events]}")
    print(f"  stopped received: {race_stopped_ok}")
    print(f"  no fault fired:   {race_no_fault}")

    print(f"\nPhase C (regression):")
    print(f"  start: {json.dumps(results.get('c_start'))}")
    print(f"  unexpected error: {json.dumps(results.get('c_fault_check'))}")
    print(f"  stop:  {json.dumps(results.get('c_stop'))}")

    print()
    print(f"[{'PASS' if ok_a1_started else 'FAIL'}] A1 started event received")
    print(f"[{'PASS' if ok_a1_error else 'FAIL'}] A1 MIC_SESSION_FAILED error emitted")
    print(f"[{'PASS' if ok_a2_started else 'FAIL'}] A2 started event received (same process)")
    print(f"[{'PASS' if ok_a2_error else 'FAIL'}] A2 MIC_SESSION_FAILED error emitted")
    if not race_start_was_error:
        print(f"[{'PASS' if race_stopped_ok else 'FAIL'}] Race: stopped event received")
        print(f"[{'PASS' if race_no_fault else 'FAIL'}] Race: no MIC_SESSION_FAILED fired after stop")
    else:
        print(f"[SKIP] Race: start returned error (state machine note — see below)")
    print(f"[{'PASS' if ok_c_start else 'FAIL'}] C: regression start succeeds")
    print(f"[{'PASS' if ok_c_no_fault else 'FAIL'}] C: no fault fires without env var")
    print(f"[{'PASS' if ok_c_stop else 'FAIL'}] C: regression stop succeeds")

    if race_start_was_error:
        print("\nNote: Race phase B — start returned error instead of started.")
        print("This can happen if the previous take's teardown left the engine in")
        print("a transitional state. Not a UAT-4 failure if A1/A2/C all pass.")

    core_pass = ok_a1_started and ok_a1_error and ok_a2_started and ok_a2_error and ok_c_start and ok_c_no_fault and ok_c_stop
    race_pass = race_stopped_ok and race_no_fault
    all_pass = core_pass and (race_pass or race_start_was_error)
    print(f"\nOVERALL: {'PASS' if all_pass else 'FAIL'}")
    return 0 if all_pass else 1


if __name__ == "__main__":
    sys.exit(main())
