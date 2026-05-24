#!/usr/bin/env python3
"""V2.2 c1 drift harness.

Drives the recording-engine binary via stdin/stdout JSON IPC (see
docs/IPC-SPEC.md) across a 10-take matrix alternating primary + external
displays, then computes V-A drift per take with ffprobe.

Standard library only. See harness/v2-drift/README.md for usage.
"""

import argparse
import csv
import json
import queue
import re
import subprocess
import sys
import threading
import time
from pathlib import Path

# iPhone Continuity mics enumerate with a bare UUID as their UID and couple
# with the iPhone camera over a single channel; SCK's mic-via-SCStream path
# in v1.0 fails with SCStreamErrorDomain -3820 on the second consecutive
# capture session and poisons subsequent takes (no audio). The harness
# avoids them unless explicitly requested via --mic-uid.
UUID_RE = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
ENGINE_DIR = REPO / "src-tauri" / "recording-engine"
DEFAULT_ENGINE = ENGINE_DIR / ".build" / "release" / "recording-engine"
OUT_DIR = HERE / "output"

READ_TIMEOUT_S = 60.0
LIVENESS_TIMEOUT_S = 5.0
READY_TIMEOUT_S = 10.0


def log(msg: str) -> None:
    print(f"harness: {msg}", file=sys.stderr, flush=True)


class EngineIO:
    """Line-delimited JSON IPC over a Popen pipe pair, plus stderr forwarder."""

    def __init__(self, proc: subprocess.Popen) -> None:
        self.proc = proc
        self.events: "queue.Queue[dict | None]" = queue.Queue()
        threading.Thread(target=self._stdout_reader, daemon=True).start()
        threading.Thread(target=self._stderr_forwarder, daemon=True).start()

    def _stdout_reader(self) -> None:
        try:
            assert self.proc.stdout is not None
            for raw in iter(self.proc.stdout.readline, b""):
                line = raw.decode("utf-8", "replace").strip()
                if not line:
                    continue
                try:
                    ev = json.loads(line)
                except json.JSONDecodeError as e:
                    log(f"non-JSON line: {line!r} ({e})")
                    continue
                self.events.put(ev)
        finally:
            self.events.put(None)

    def _stderr_forwarder(self) -> None:
        assert self.proc.stderr is not None
        for raw in iter(self.proc.stderr.readline, b""):
            sys.stderr.write("engine: " + raw.decode("utf-8", "replace"))
            sys.stderr.flush()

    def send(self, obj: dict) -> None:
        assert self.proc.stdin is not None
        self.proc.stdin.write((json.dumps(obj) + "\n").encode("utf-8"))
        self.proc.stdin.flush()

    def wait_for(self, predicate, timeout: float = READ_TIMEOUT_S,
                 on_event=None):
        """Return the first event matching predicate or None on timeout/EOF."""
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
            if on_event is not None:
                on_event(ev)
            if predicate(ev):
                return ev


def build_if_missing(engine: Path) -> None:
    if engine.exists():
        return
    log(f"engine binary missing at {engine}; running swift build -c release")
    subprocess.run(["swift", "build", "-c", "release"],
                   cwd=ENGINE_DIR, check=True)


def pick_mic(mics: list[dict], override: str | None) -> str | None:
    if override is not None:
        return override or None
    if not mics:
        return None
    for m in mics:
        if not UUID_RE.match(m["uid"]):
            return m["uid"]
    return mics[0]["uid"]


def pick_displays(displays: list[dict], mode: str) -> list[tuple[str, dict]]:
    """Resolve --displays mode against the enumerated set."""
    if not displays:
        return []
    primary = next(
        (d for d in displays if d["x"] == 0 and d["y"] == 0),
        displays[0],
    )
    externals = [d for d in displays if d["id"] != primary["id"]]
    rotation: list[tuple[str, dict]] = []
    for label in (s.strip() for s in mode.split(",") if s.strip()):
        if label == "primary":
            rotation.append(("primary", primary))
        elif label == "external":
            if externals:
                rotation.append(("external", externals[0]))
            else:
                log("no external display available; substituting primary")
                rotation.append(("primary", primary))
        else:
            log(f"unknown display label {label!r}; ignoring")
    return rotation


def ffprobe(args: list[str], mp4: Path) -> str:
    cmd = ["ffprobe", "-v", "error", *args, "-of", "csv=p=0", str(mp4)]
    try:
        return subprocess.check_output(
            cmd, stderr=subprocess.DEVNULL, text=True
        ).strip()
    except subprocess.CalledProcessError:
        return ""


def measure(mp4: Path) -> tuple[str, str, str, str]:
    video_dur = ffprobe(
        ["-select_streams", "v:0", "-show_entries", "stream=duration"], mp4
    )
    audio_combo = ffprobe(
        ["-select_streams", "a:0", "-show_entries",
         "stream=start_time,duration"],
        mp4,
    )
    audio_start, audio_dur = "", ""
    if "," in audio_combo:
        audio_start, audio_dur = audio_combo.split(",", 1)
    elif audio_combo:
        audio_start = audio_combo
    drift_ms = ""
    if video_dur and audio_dur:
        try:
            drift_ms = f"{abs(float(video_dur) - float(audio_dur)) * 1000:.3f}"
        except ValueError:
            pass
    return video_dur, audio_start, audio_dur, drift_ms


def shell_capture(args: list[str]) -> str:
    try:
        return subprocess.check_output(
            args, text=True, stderr=subprocess.DEVNULL
        ).strip()
    except Exception:
        return "unknown"


def write_meta(meta_csv: Path, mic_uid: str | None,
               rotation: list[tuple[str, dict]]) -> None:
    rows = [
        ("macos_version", shell_capture(["sw_vers", "-productVersion"])),
        ("sdk_version",
         shell_capture(["xcrun", "--show-sdk-version", "--sdk", "macosx"])),
        ("repo_commit",
         shell_capture(["git", "-C", str(REPO), "rev-parse", "HEAD"])),
        ("mic_uid", mic_uid or "none"),
        ("displays",
         "; ".join(f"{label}={d['id']}" for label, d in rotation)),
    ]
    with open(meta_csv, "w", newline="") as f:
        w = csv.writer(f)
        for row in rows:
            w.writerow(row)


def run_take(io: EngineIO, idx: int, label: str, display: dict,
             mic_uid: str | None, duration: int) -> tuple:
    mp4 = OUT_DIR / f"take-{label}-{idx:02d}.mp4"
    if mp4.exists():
        mp4.unlink()
    log(f"=== take {idx:02d} ({label}, display {display['id']}) ===")

    cmd: dict = {
        "command": "start",
        "display_id": display["id"],
        "output_path": str(mp4),
        "max_fps": 30,
    }
    if mic_uid:
        cmd["microphone_uid"] = mic_uid

    start_wall = time.monotonic()
    io.send(cmd)

    started = io.wait_for(
        lambda e: e.get("event") in ("started", "error"),
        timeout=READY_TIMEOUT_S,
    )
    if not started:
        log("no started event within 10s; aborting take")
        return (label, idx, "", "", "", "", "", 1, str(mp4))
    if started.get("event") == "error":
        log(f"start error: {started}")
        return (label, idx, "", "", "", "", "", 1, str(mp4))

    last_progress = time.monotonic()
    deadline = time.monotonic() + duration
    mid_error: dict | None = None
    while time.monotonic() < deadline:
        remaining = max(0.05, min(1.0, deadline - time.monotonic()))
        ev = io.wait_for(lambda e: True, timeout=remaining)
        if ev is None:
            if time.monotonic() - last_progress > LIVENESS_TIMEOUT_S:
                log("no progress for >5s; breaking duration loop")
                break
            continue
        if ev.get("event") == "progress":
            last_progress = time.monotonic()
        elif ev.get("event") == "error":
            mid_error = ev
            log(f"mid-recording error: {ev}")
            break

    io.send({"command": "stop"})
    stopped = io.wait_for(
        lambda e: e.get("event") in ("stopped", "error"),
        timeout=READ_TIMEOUT_S,
    )
    wall = time.monotonic() - start_wall

    exit_code = 0
    if not stopped:
        log("no stopped/error event within 60s of stop; marking failure")
        exit_code = 1
    elif stopped.get("event") == "error":
        log(f"stop error: {stopped}")
        exit_code = 1
    if mid_error is not None:
        exit_code = exit_code or 1

    video_dur, audio_start, audio_dur, drift_ms = "", "", "", ""
    if mp4.exists():
        video_dur, audio_start, audio_dur, drift_ms = measure(mp4)
    else:
        log(f"output mp4 missing: {mp4}")
        exit_code = exit_code or 1

    return (label, idx, f"{wall:.3f}", video_dur, audio_start, audio_dur,
            drift_ms, exit_code, str(mp4))


def run(args: argparse.Namespace) -> int:
    engine = Path(args.engine).resolve()
    build_if_missing(engine)
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    log(f"spawning engine: {engine}")
    proc = subprocess.Popen(
        [str(engine)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        bufsize=0,
    )
    io = EngineIO(proc)
    results: list[tuple] = []
    rotation: list[tuple[str, dict]] = []
    mic_uid: str | None = None

    try:
        ready = io.wait_for(
            lambda e: e.get("event") == "ready", timeout=READY_TIMEOUT_S
        )
        if not ready:
            log("engine did not emit ready within 10s; aborting")
            return 1
        log(f"engine ready: version={ready.get('version')}")

        io.send({"command": "enumerate"})
        enumerated = io.wait_for(
            lambda e: e.get("event") == "enumerated", timeout=READY_TIMEOUT_S
        )
        if not enumerated:
            log("enumerate did not respond within 10s; aborting")
            return 1
        displays = enumerated.get("displays", [])
        mics = enumerated.get("microphones", [])
        log(f"enumerated {len(displays)} display(s), {len(mics)} microphone(s)")
        if not displays:
            log("no displays available; aborting")
            return 1

        rotation = pick_displays(displays, args.displays)
        if not rotation:
            log("no displays selected; aborting")
            return 1
        for m in mics:
            log(f"  available mic: uid={m['uid']!r} name={m['name']!r}")
        mic_uid = pick_mic(mics, args.mic_uid)
        log(f"rotation: {[(lab, d['id']) for lab, d in rotation]}, "
            f"mic_uid={mic_uid}")

        for i in range(1, args.takes + 1):
            label, display = rotation[(i - 1) % len(rotation)]
            results.append(run_take(io, i, label, display, mic_uid,
                                    args.duration))

        try:
            io.send({"command": "quit"})
        except Exception as e:
            log(f"quit send failed: {e}")
        try:
            proc.wait(timeout=10.0)
        except subprocess.TimeoutExpired:
            log("engine did not exit within 10s of quit; terminating")
            proc.terminate()

    finally:
        if proc.poll() is None:
            try:
                proc.terminate()
                proc.wait(timeout=5.0)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()

    results_csv = OUT_DIR / "results.csv"
    with open(results_csv, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow([
            "display", "take", "wall_clock_s",
            "video_dur_s", "audio_start_s", "audio_dur_s",
            "abs_drift_ms", "exit_code", "output_path",
        ])
        for row in results:
            w.writerow(row)
    log(f"wrote {results_csv} ({len(results)} rows)")

    meta_csv = OUT_DIR / "meta.csv"
    write_meta(meta_csv, mic_uid, rotation)
    log(f"wrote {meta_csv}")

    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="V2.2 c1 drift harness")
    parser.add_argument("--engine", default=str(DEFAULT_ENGINE),
                        help="path to recording-engine binary")
    parser.add_argument("--takes", type=int, default=10,
                        help="number of takes (default 10)")
    parser.add_argument("--duration", type=int, default=30,
                        help="seconds per take (default 30)")
    parser.add_argument("--displays", default="primary,external",
                        help="comma-separated display labels to alternate")
    parser.add_argument("--mic-uid", default=None,
                        help="explicit mic UID; default skips iPhone "
                             "Continuity UUIDs and prefers built-in/USB")
    return run(parser.parse_args())


if __name__ == "__main__":
    sys.exit(main())
