#!/usr/bin/env bash
# D-04 orphan webcam-ffmpeg kill test (V2.3 c2).
#
# The webcam ffmpeg is a direct child of the Tauri process. On a graceful stop,
# stop_segment (q\n) and Drop reap it. On crash / force-quit / SIGKILL neither
# runs — the 187GB orphan scenario. The D-04 watchdog (a detached /bin/sh that
# polls both pids) is the only thing that can stop ffmpeg in that case.
#
# This script does the deterministic kill+assert half of the UAT. A human must
# first START A RECORDING WITH THE WEBCAM ACTIVELY CAPTURING — this script
# cannot verify a physical camera is producing frames, only that the ffmpeg
# capture process exists.
#
# Usage:
#   harness/orphan-kill-test.sh [--graceful] [--tauri-pid PID] [--ff-pid PID]
#
#   default       kill -9 the Tauri process (UNGRACEFUL: Drop/stop_segment do
#                 NOT run, so only the watchdog can stop ffmpeg). The load-
#                 bearing test — a PASS here proves the watchdog works.
#   --graceful    kill (SIGTERM) the Tauri process instead — a softer-signal
#                 contrast run. (A SIGTERM still does not unwind Rust Drop, so
#                 the watchdog remains the killer; the true in-app graceful path
#                 is exercised by clicking Stop in the UI, not by this script.)
#   --tauri-pid   explicit Tauri pid (default: pgrep the dev binary).
#   --ff-pid      explicit webcam ffmpeg pid (default: pgrep -f avfoundation).
#
# Exit 0 = PASS (ffmpeg gone within the deadline), 1 = FAIL / setup error.

set -u

GRACEFUL=0
TAURI_PID=""
FF_PID=""
DEADLINE_S=3
POLL_S=0.2

while [ $# -gt 0 ]; do
  case "$1" in
    --graceful) GRACEFUL=1 ;;
    --tauri-pid) shift; TAURI_PID="${1:-}" ;;
    --ff-pid) shift; FF_PID="${1:-}" ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
  shift
done

# macOS `date` has no %N; use python3 for millisecond timestamps.
now_ms() { python3 -c 'import time; print(int(time.time()*1000))'; }

# Resolve the webcam ffmpeg pid (the avfoundation capture). Screen capture is
# SCK/Swift and composite/thumbs ffmpeg runs do not use avfoundation, so this
# pattern uniquely identifies the live webcam segmenter. pgrep excludes itself.
if [ -z "$FF_PID" ]; then
  FF_PID="$(pgrep -f avfoundation | head -1)"
fi
if [ -z "$FF_PID" ] || ! kill -0 "$FF_PID" 2>/dev/null; then
  echo "no webcam ffmpeg found — is a webcam recording active? (start one, then re-run)" >&2
  exit 1
fi

# Resolve the Tauri pid. Dev build: target/debug/zeigen. Bundle: com.zeigen.app.
if [ -z "$TAURI_PID" ]; then
  TAURI_PID="$(pgrep -f 'target/debug/zeigen' | head -1)"
fi
if [ -z "$TAURI_PID" ]; then
  TAURI_PID="$(pgrep -x zeigen | head -1)"
fi
if [ -z "$TAURI_PID" ] || ! kill -0 "$TAURI_PID" 2>/dev/null; then
  echo "could not resolve a running Tauri pid — pass --tauri-pid PID" >&2
  exit 1
fi

if [ "$FF_PID" = "$TAURI_PID" ]; then
  echo "resolved pids collide ($FF_PID) — pass explicit --tauri-pid / --ff-pid" >&2
  exit 1
fi

if [ "$GRACEFUL" -eq 1 ]; then
  MODE="SIGTERM (graceful contrast)"
  SIG="-TERM"
else
  MODE="SIGKILL (ungraceful — the orphan test)"
  SIG="-9"
fi

echo "webcam ffmpeg pid=$FF_PID, Tauri pid=$TAURI_PID"
echo "sending kill $SIG to Tauri pid $TAURI_PID — $MODE"

START_MS=$(now_ms)
kill "$SIG" "$TAURI_PID" 2>/dev/null
DEADLINE_MS=$(( START_MS + DEADLINE_S * 1000 ))

while :; do
  if ! kill -0 "$FF_PID" 2>/dev/null; then
    MS=$(( $(now_ms) - START_MS ))
    echo "RESULT: $MODE — ffmpeg $FF_PID gone ${MS}ms after Tauri kill $SIG — PASS"
    exit 0
  fi
  if [ "$(now_ms)" -ge "$DEADLINE_MS" ]; then
    MS=$(( $(now_ms) - START_MS ))
    echo "RESULT: $MODE — ffmpeg $FF_PID STILL ALIVE ${MS}ms after Tauri kill $SIG — FAIL (orphan survived)"
    exit 1
  fi
  sleep "$POLL_S"
done
