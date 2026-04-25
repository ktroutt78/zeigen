#!/usr/bin/env bash
# Phase 3 spike: 10-second camera capture via ffmpeg + avfoundation.
# Validates that AVCaptureDevice (camera) input still works on macOS 26
# even though AVCaptureScreenInput is removed.
# Usage: docs/spike/run-ffmpeg-camera.sh [camera_index]
set -euo pipefail

FFMPEG="/opt/homebrew/bin/ffmpeg"
OUT="$(dirname "$0")/spike-camera-ffmpeg.mov"
DURATION=10
INDEX="${1:-0}"

echo "Recording camera index $INDEX for ${DURATION}s to $OUT"

START=$(date +%s)
"$FFMPEG" -y -hide_banner \
	-f avfoundation \
	-framerate 30 \
	-i "$INDEX" \
	-t "$DURATION" \
	-c:v h264_videotoolbox \
	-b:v 4M \
	-pix_fmt nv12 \
	"$OUT" 2>&1 | tee "$(dirname "$OUT")/spike-camera-ffmpeg.log"
EXIT_CODE=${PIPESTATUS[0]}
END=$(date +%s)

echo ""
echo "Wall clock: $((END - START))s"
echo "ffmpeg exit: $EXIT_CODE"
if [[ -f "$OUT" ]]; then
	ls -lh "$OUT"
	"$FFMPEG" -hide_banner -i "$OUT" 2>&1 | grep -E "Duration|Stream" || true
else
	echo "no output file produced"
fi
exit $EXIT_CODE
