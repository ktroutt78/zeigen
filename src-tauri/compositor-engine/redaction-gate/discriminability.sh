#!/bin/bash
# Discriminability validation. For an item, render the TRUE value + decoys (same
# layout, different digits), treat each through the compositor, and measure how much
# of the sharp true-vs-decoy pixel difference SURVIVES the treatment:
#   retention_i = dist(treated_true, treated_decoy_i) / dist(sharp_true, sharp_decoy_i)
# Discriminability D = median retention. Envelope cancels (it's shared, subtracts out
# in the difference). High D = candidates still distinguishable = legible.
# Usage: discrim.sh <id> <true> <decoys-comma-sep> <env...>   (env forces treatment)
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"; GD="$HERE"
FF=/opt/homebrew/bin/ffmpeg; RH="$(mktemp -d)/rh"; CICO="$(dirname "$RH")/cico"
swiftc -O "$GD/harness.swift" -o "$RH" 2>/tmp/hb || { grep -i error /tmp/hb|head; exit 1; }
swiftc -O "$GD/../main.swift" -o "$CICO" 2>/dev/null
W=3024; H=1964
id=$1; TRUE=$2; IFS=',' read -ra DECOYS <<<"$3"; shift 3
D="$(mktemp -d)"; trap 'rm -rf "$D"' EXIT
mkmp4(){ "$FF" -y -loglevel error -loop 1 -i "$1" -t 1 -r 30 -crf 12 -pix_fmt yuv420p -c:v libx264 "$2" 2>/dev/null; }
# VideoToolbox occasionally writes a 0-byte file under rapid repeated invocation;
# retry until non-empty (production's Rust wiring guards this with has_output).
cico_export(){ local out="${!#}"; local t; for t in 1 2 3 4 5; do "$@" >/dev/null 2>&1; [ -s "$out" ] && return 0; done; echo "EXPORT FAILED after retries: $out" >&2; return 1; }

# True: render, get bbox, build region (5% margin), export sharp(control) + treated.
bbox=$("$RH" renderitem "$D/true.png" $W $H light "$id" "$TRUE" | sed 's/BBOX //')
read tx ty tw th <<<"$bbox"; pad=$(python3 -c "print(max(4,int(0.05*$th)))")
fx=$(python3 -c "print(($tx-$pad)/$W)"); fy=$(python3 -c "print(($ty-$pad)/$H)")
fw=$(python3 -c "print(($tw+2*$pad)/$W)"); fh=$(python3 -c "print(($th+2*$pad)/$H)")
rjson="$D/r.json"; printf '[{"x":%s,"y":%s,"w":%s,"h":%s,"start":0,"end":5,"tint":"light"}]\n' $fx $fy $fw $fh > "$rjson"
mkmp4 "$D/true.png" "$D/true.mp4"
cico_export "$CICO" "$D/true.mp4" "$D/true_sharp.mp4" || exit 1
cico_export env REDACT_REGIONS="$rjson" "$@" "$CICO" "$D/true.mp4" "$D/true_treat.mp4" || exit 1

rets=()
for dc in "${DECOYS[@]}"; do
  "$RH" renderitem "$D/d.png" $W $H light "$id" "$dc" >/dev/null
  mkmp4 "$D/d.png" "$D/d.mp4"
  cico_export "$CICO" "$D/d.mp4" "$D/d_sharp.mp4" || continue
  cico_export env REDACT_REGIONS="$rjson" "$@" "$CICO" "$D/d.mp4" "$D/d_treat.mp4" || continue
  dsharp=$("$RH" dist "$D/true_sharp.mp4" "$D/d_sharp.mp4" $fx $fy $fw $fh | sed 's/DIST //')
  dtreat=$("$RH" dist "$D/true_treat.mp4" "$D/d_treat.mp4" $fx $fy $fw $fh | sed 's/DIST //')
  ret=$(python3 -c "print('%.4f'%($dtreat/$dsharp if $dsharp>0.5 else 0))")
  rets+=("$ret")
  printf '    decoy %-12s dsharp=%-8s dtreat=%-8s retention=%s\n' "$dc" "$dsharp" "$dtreat" "$ret"
done
python3 -c "
r=sorted([$(IFS=,; echo "${rets[*]}")])
import statistics
print('  D(median retention)=%.4f  D(max)=%.4f'%(statistics.median(r), max(r)))
"
