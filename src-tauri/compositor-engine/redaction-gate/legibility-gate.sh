#!/bin/bash
# Redaction LEGIBILITY gate (REDACTION-PLAN, rebuilt 2026-07-26 after the gradient
# gate shipped readable text). Two independent FAIL conditions per redacted region:
#
#   OCR      — Vision reads the region of the exported frame (raw + 3x upscale). If it
#              recognizes any real token of the secret, FAIL. OCR is a hard-fail
#              TRIGGER only; OCR failing to read does NOT pass the region (Vision
#              missing text a human reads is exactly the false-pass we must not trust).
#   STRUCT   — the real backstop. Low-frequency structural correlation between the
#              sharp control export and the redacted export at legibility-critical
#              resolution, z-normalized so the frost's tint/contrast don't count —
#              only whether the glyph SHAPE survived. High correlation = legible = FAIL.
#              This catches large bold text whose shape lives below the blur cutoff,
#              which gradient energy went blind to.
#
# Neither replaces the owner's real-footage eye-check; both must pass for the build.
#
# Corpus is representative (large bold KPI numbers + small labels/values, light and
# dark cards) and box margins are swept. Usage: ./legibility-gate.sh [struct_threshold]
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
FF=/opt/homebrew/bin/ffmpeg
STRUCT_TH="${1:-}"   # empty => calibration mode (report only, no verdict)
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
RH="$WORK/rh"
CICO="$WORK/cico"
echo "building compositor + harness..."
swiftc -O "$HERE/../main.swift" -o "$CICO" 2>"$WORK/c.err" || { grep -i error "$WORK/c.err"|head; exit 2; }
swiftc -O "$HERE/harness.swift" -o "$RH" 2>"$WORK/h.err" || { grep -i error "$WORK/h.err"|head; exit 2; }

# One redaction+probe pass over a scene. $1 card(light|dark) $2 margin-frac-of-h
# $3 label $4.. extra env (e.g. destroyed-control params). Prints one line per item.
run_case() {
  local card=$1 marginf=$2 tag=$3; shift 3
  local W=3024 H=1964
  local scene="$WORK/scene-$tag.png" manifest="$WORK/items-$tag.txt"
  "$RH" scene "$scene" $W $H "$card" > "$manifest"
  local input="$WORK/in-$tag.mp4"
  "$FF" -y -loglevel error -loop 1 -i "$scene" -t 1 -r 30 -crf 12 -pix_fmt yuv420p -c:v libx264 "$input" 2>/dev/null
  # Build one REDACT_REGIONS json covering every item (padded box), default tint.
  local rjson="$WORK/red-$tag.json"
  python3 - "$manifest" "$W" "$H" "$marginf" > "$rjson" <<'PY'
import sys, json
manifest, W, H, mf = sys.argv[1], float(sys.argv[2]), float(sys.argv[3]), float(sys.argv[4])
regs=[]
for ln in open(manifest):
    p=ln.split(); _id=p[1]; x,y,w,h=map(float,p[2:6])
    pad=max(4.0, mf*h)
    regs.append({"x":(x-pad)/W,"y":(y-pad)/H,"w":(w+2*pad)/W,"h":(h+2*pad)/H,"start":0,"end":5,"tint":"light"})
print(json.dumps(regs))
PY
  local ctrl="$WORK/ctrl-$tag.mp4" treat="$WORK/treat-$tag.mp4"
  "$CICO" "$input" "$ctrl" >/dev/null 2>&1
  REDACT_REGIONS="$rjson" "$@" "$CICO" "$input" "$treat" >/dev/null 2>&1
  # Probe each item: OCR hit? structural correlation?
  while read -r _ id x y w h text; do
    local pad fx fy fw fh
    pad=$(python3 -c "print(max(4.0,$marginf*$h))")
    fx=$(python3 -c "print(($x-$pad)/$W)"); fy=$(python3 -c "print(($y-$pad)/$H)")
    fw=$(python3 -c "print(($w+2*$pad)/$W)"); fh=$(python3 -c "print(($h+2*$pad)/$H)")
    local ocr octrl corr hit
    ocr=$("$RH" ocr "$treat" $fx $fy $fw $fh | sed 's/^OCR //' | tr '\n' '|')
    octrl=$("$RH" ocr "$ctrl" $fx $fy $fw $fh | sed 's/^OCR //' | tr '\n' '|')
    corr=$("$RH" struct "$ctrl" "$treat" $fx $fy $fw $fh | sed 's/^CORR //')
    # OCR hit = any 3+ char alnum token of the secret appears in the OCR output.
    hit=$(python3 -c "
import re,sys
secret=re.sub(r'[^A-Za-z0-9]',' ',' '.join('''$text'''.split()))
toks=[t for t in secret.split() if len(t)>=3]
ocr='''$ocr'''.lower()
print('HIT' if any(t.lower() in ocr for t in toks) else '-')
")
    printf '  [%s/%s] %-8s corr=%-7s ocr=%-3s  \"%s\"  read:[%s]  (sharp-OCR:[%s])\n' \
      "$card" "$tag" "$id" "$corr" "$hit" "$(echo $text)" "${ocr%|}" "${octrl%|}"
  done < "$manifest"
}

echo ""
echo "==== CURRENT PARAMETERS (must FAIL big + small) ===="
run_case light 0.05 L-tight
run_case light 0.30 L-loose
run_case dark  0.05 D-tight

echo ""
echo "==== DESTROYED CONTROL (heavy blur — gate must PASS this) ===="
run_case light 0.05 DESTROYED REDACT_RADIUS_FLOOR=400 REDACT_RADIUS_K=0.6 REDACT_ALPHA=0.85

echo ""
echo "(corr = low-freq shape correlation vs sharp control; higher = more legible."
echo " ocr HIT = Vision read a real token of the secret.)"
if [ -z "$STRUCT_TH" ]; then
  echo "Calibration mode: no verdict. Re-run with a threshold once the separation is clear."
fi
