#!/bin/bash
# V2.1 unified-capture spike — measurement driver.
# Drives the spike binary across a 5×30s × 2-display matrix and computes
# |video_duration − audio_duration| per take via ffprobe (CONTEXT D-06,
# PLAN c2 §"Driver harness"). One MP4 per invocation (CONTEXT D-04).

set -e

PRIMARY="${1:?usage: run.sh <primary_display_id> <external_display_id> [mic_uid] [track]}"
EXTERNAL="${2:?missing external display id}"
MIC_UID="${3:-}"
TRACK_OVERRIDE="${4:-auto}"   # auto | A | B — defaults to spike's auto-select

cd "$(dirname "$0")"
SPIKE="./.build/release/spike"
OUT="output"
mkdir -p "$OUT"

if [ ! -x "$SPIKE" ]; then
    echo "spike binary not found at $SPIKE — run 'swift build -c release' first" >&2
    exit 1
fi
if ! command -v ffprobe >/dev/null 2>&1; then
    echo "ffprobe not on PATH — install ffmpeg or activate the project's PATH" >&2
    exit 1
fi

# Metadata snapshot — referenced from SPIKE-REPORT.md (PLAN c3).
{
    echo "macos_version,$(sw_vers -productVersion)"
    echo "sdk_version,$(xcrun --show-sdk-version --sdk macosx 2>/dev/null || echo unknown)"
    echo "track_override,$TRACK_OVERRIDE"
    echo "primary_display,$PRIMARY"
    echo "external_display,$EXTERNAL"
    echo "mic_uid,${MIC_UID:-default}"
} > "$OUT/meta.csv"

echo "display,take,track,wall_clock_s,video_dur_s,audio_start_s,audio_dur_s,abs_drift_ms,first_video_pts_s,first_audio_pts_s,post_alignment_drift_ms,end_time_drift_ms,startup_gap_ms,exit_code" \
    > "$OUT/results.csv"

for LABEL in primary external; do
    case "$LABEL" in
        primary)  DISPLAY_ID="$PRIMARY"  ;;
        external) DISPLAY_ID="$EXTERNAL" ;;
    esac
    for i in 01 02 03 04 05; do
        OUTFILE="$OUT/${LABEL}-take-${i}.mp4"
        rm -f "$OUTFILE" "$OUTFILE.track" "$OUTFILE.pts"

        echo
        echo "=== $LABEL take $i (display $DISPLAY_ID, track $TRACK_OVERRIDE) ==="

        START=$(date +%s)
        set +e
        if [ -n "$MIC_UID" ]; then
            "$SPIKE" --display "$DISPLAY_ID" --mic "$MIC_UID" --duration 30 --track "$TRACK_OVERRIDE" --out "$OUTFILE"
        else
            "$SPIKE" --display "$DISPLAY_ID" --duration 30 --track "$TRACK_OVERRIDE" --out "$OUTFILE"
        fi
        EXIT=$?
        set -e
        END=$(date +%s)
        WALL=$((END - START))

        TRACK="n/a"; VDUR=""; ASTART=""; ADUR=""; DRIFT_MS=""
        VPTS=""; APTS=""; POST_DRIFT_MS=""; END_DRIFT_MS=""; STARTUP_GAP_MS=""
        if [ "$EXIT" -eq 0 ] && [ -f "$OUTFILE" ]; then
            TRACK=$(cat "$OUTFILE.track" 2>/dev/null || echo "?")
            VDUR=$(ffprobe -v error -select_streams v:0 -show_entries stream=duration -of csv=p=0 "$OUTFILE" 2>/dev/null || echo "")
            ASTART=$(ffprobe -v error -select_streams a:0 -show_entries stream=start_time -of csv=p=0 "$OUTFILE" 2>/dev/null || echo "")
            ADUR=$(ffprobe -v error -select_streams a:0 -show_entries stream=duration -of csv=p=0 "$OUTFILE" 2>/dev/null || echo "")
            if [ -n "$VDUR" ] && [ -n "$ADUR" ]; then
                DRIFT_MS=$(awk -v v="$VDUR" -v a="$ADUR" 'BEGIN{d=(v-a)*1000; if(d<0) d=-d; printf "%.3f\n", d}')
            fi
            # Three derived signals from the .pts sidecar (absolute host-time
            # PTS of each pipeline's first sample):
            #   post_alignment_drift_ms — literal from spec:
            #     |(video_dur − first_video_pts) − (audio_dur − first_audio_pts)| × 1000
            #   end_time_drift_ms — wall-clock gap between when each stream
            #     ended in host time:
            #     |(video_dur + first_video_pts) − (audio_dur + first_audio_pts)| × 1000
            #     (= the actual clock-parity hypothesis test, factoring out startup)
            #   startup_gap_ms — pipeline-startup asymmetry (fixable via
            #     V2.2 startSession alignment):
            #     |first_audio_pts − first_video_pts| × 1000
            if [ -f "$OUTFILE.pts" ]; then
                VPTS=$(grep '^video=' "$OUTFILE.pts" | cut -d= -f2)
                APTS=$(grep '^audio=' "$OUTFILE.pts" | cut -d= -f2)
                if [ -n "$VPTS" ] && [ -n "$APTS" ] && [ -n "$VDUR" ] && [ -n "$ADUR" ]; then
                    POST_DRIFT_MS=$(awk -v vd="$VDUR" -v ad="$ADUR" -v vp="$VPTS" -v ap="$APTS" \
                        'BEGIN{x=(vd-vp)-(ad-ap); if(x<0) x=-x; printf "%.3f\n", x*1000}')
                    END_DRIFT_MS=$(awk -v vd="$VDUR" -v ad="$ADUR" -v vp="$VPTS" -v ap="$APTS" \
                        'BEGIN{x=(vd+vp)-(ad+ap); if(x<0) x=-x; printf "%.3f\n", x*1000}')
                    STARTUP_GAP_MS=$(awk -v vp="$VPTS" -v ap="$APTS" \
                        'BEGIN{x=ap-vp; if(x<0) x=-x; printf "%.3f\n", x*1000}')
                fi
            fi
        fi
        echo "$LABEL,$i,$TRACK,$WALL,$VDUR,$ASTART,$ADUR,$DRIFT_MS,$VPTS,$APTS,$POST_DRIFT_MS,$END_DRIFT_MS,$STARTUP_GAP_MS,$EXIT" >> "$OUT/results.csv"
    done
done

echo
echo "=== Results in $OUT/results.csv ==="
column -t -s, "$OUT/results.csv"
