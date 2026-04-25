#!/usr/bin/env bash
# Phase 1 spike: 30-second screen capture via ffmpeg + avfoundation.
# Usage: docs/spike/run-ffmpeg-avfoundation.sh [screen_index]
# If screen_index is omitted, uses the first "Capture screen" found via enumeration.
set -euo pipefail

FFMPEG="/opt/homebrew/bin/ffmpeg"
OUT="$(dirname "$0")/spike-avfoundation.mov"
DURATION=30

if [[ $# -ge 1 ]]; then
	SCREEN_INDEX="$1"
else
	SCREEN_INDEX=$("$FFMPEG" -hide_banner -f avfoundation -list_devices true -i "" 2>&1 \
		| awk -F'[][]' '/Capture screen/ {print $4; exit}')
fi

if [[ -z "$SCREEN_INDEX" ]]; then
	echo "Could not determine screen index. Run ffmpeg -f avfoundation -list_devices true -i ''"
	exit 1
fi

echo "Recording screen index $SCREEN_INDEX for ${DURATION}s to $OUT"
mkdir -p "$(dirname "$OUT")"

START=$(date +%s)
"$FFMPEG" -y -hide_banner \
	-f avfoundation \
	-framerate 30 \
	-capture_cursor 1 \
	-i "$SCREEN_INDEX" \
	-t "$DURATION" \
	-c:v h264_videotoolbox \
	-b:v 8M \
	-pix_fmt nv12 \
	"$OUT" 2>&1 | tee "$(dirname "$OUT")/spike-avfoundation.log"
END=$(date +%s)

echo ""
echo "Wall clock: $((END - START))s"
echo "Output: $OUT"
ls -lh "$OUT"
"$FFMPEG" -hide_banner -i "$OUT" 2>&1 | grep -E "Duration|Stream"
