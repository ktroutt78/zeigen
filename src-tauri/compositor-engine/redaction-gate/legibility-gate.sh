#!/bin/bash
# Redaction LEGIBILITY gate (pixelate era, 2026-07-26). Bar A = READABILITY.
# Per redacted region, two checks:
#
#   GEOMETRIC (the teeth) — cell size must exceed the text stroke width, or the
#     mosaic preserves the glyph (measured: cell 16 leaked, 24 held; stroke ~25 on
#     big bold). Reliable and reproducible, unlike OCR. FAIL if cell < 1.5*stroke.
#     The cell FLOOR is the safety parameter (DECISIONS 2026-07-26): it does not
#     come down without a logged reason. Teeth are demonstrated below: a forced
#     below-floor cell (16) falls under the big-text stroke width.
#   HARDENED OCR (hard fail) — Vision after contrast-recovery (undo the overlay) +
#     sharpen + upscale, raw and enlarged. Reading any real token of the secret =
#     FAIL. OCR is noisy, so it is a hard-fail TRIGGER, never a pass on its own; the
#     geometric check is what proves safety.
#
# DISCRIMINABILITY D (redaction-gate discriminability.sh) is reported ADVISORY only
# (DECISIONS 2026-07-26): pixelate is unreadable but its block pattern still
# distinguishes values against a candidate list — a known, accepted limitation.
#
# Neither replaces the owner's real-footage eye-check. Usage: ./legibility-gate.sh
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
FF=/opt/homebrew/bin/ffmpeg
[ -x "$FF" ] || FF=$(command -v ffmpeg) || { echo "ffmpeg not found"; exit 2; }
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
RH="$WORK/rh"; CICO="$WORK/cico"
MARGIN=1.5   # cell must be at least this multiple of stroke width
PASS=1
ok(){ printf 'PASS  %s\n' "$*"; }
bad(){ printf 'FAIL  %s\n' "$*"; PASS=0; }
say(){ printf '%s\n' "$*"; }
# VideoToolbox occasionally writes a 0-byte file under rapid invocation; retry.
xport(){ local out="${!#}" t; for t in 1 2 3 4 5; do env "$@" >/dev/null 2>&1; [ -s "$out" ] && return 0; done; echo "EXPORT FAILED: $out" >&2; return 1; }
tokhit(){ python3 -c "
import re
secret=re.sub(r'[^A-Za-z0-9]',' ','''$1''')
toks=[t for t in secret.split() if len(t)>=3]
ocr='''$2'''.lower()
print('HIT' if any(t.lower() in ocr for t in toks) else '-')"; }

say "building compositor + harness..."
swiftc -O "$HERE/../main.swift" -o "$CICO" 2>"$WORK/c.err" || { grep -i error "$WORK/c.err"|head; exit 2; }
swiftc -O "$HERE/harness.swift" -o "$RH" 2>"$WORK/h.err" || { grep -i error "$WORK/h.err"|head; exit 2; }
W=3024; H=1964

gate_card() {
  local card=$1
  say ""; say "==== $card card — shipped pixelate defaults ===="
  local scene="$WORK/s-$card.png" man="$WORK/m-$card.txt"
  "$RH" scene "$scene" $W $H "$card" > "$man"
  local input="$WORK/in-$card.mp4"
  "$FF" -y -loglevel error -loop 1 -i "$scene" -t 1 -r 30 -crf 12 -pix_fmt yuv420p -c:v libx264 "$input" 2>/dev/null
  # Redact every item at once; capture per-region cell from the first frame's debug.
  local rjson="$WORK/r-$card.json"
  python3 - "$man" "$W" "$H" > "$rjson" <<'PY'
import sys,json
man,W,H=sys.argv[1],float(sys.argv[2]),float(sys.argv[3]); regs=[]
for ln in open(man):
    p=ln.split();
    if len(p)<6: continue
    x,y,w,h=map(float,p[2:6]); pad=max(4.0,0.05*h)
    regs.append({"x":(x-pad)/W,"y":(y-pad)/H,"w":(w+2*pad)/W,"h":(h+2*pad)/H,"start":0,"end":5,"tint":"light"})
print(json.dumps(regs))
PY
  local ctrl="$WORK/c-$card.mp4" treat="$WORK/t-$card.mp4"
  xport "$CICO" "$input" "$ctrl" || { bad "$card control export"; return; }
  xport REDACT_REGIONS="$rjson" REDACT_DEBUG=on "$CICO" "$input" "$treat" || { bad "$card treated export"; return; }
  # per-region cell values (first frame): one REDACT line per region, in json order.
  # (bash 3.2 on macOS has no mapfile.)
  local nitems; nitems=$(grep -c '^ITEM ' "$man")
  cells=()
  while IFS= read -r cl; do cells+=("$cl"); done < <(env REDACT_REGIONS="$rjson" REDACT_DEBUG=on "$CICO" "$input" "$WORK/dbg.mp4" 2>&1 >/dev/null | grep 'REDACT ' | head -n "$nitems" | sed -E 's/.*cell=([0-9.]+).*/\1/')
  local i=0
  while read -r _ id x y w h text; do
    local pad fx fy fw fh cell stroke ratio ocr hit
    pad=$(python3 -c "print(max(4.0,0.05*$h))")
    fx=$(python3 -c "print(($x-$pad)/$W)"); fy=$(python3 -c "print(($y-$pad)/$H)")
    fw=$(python3 -c "print(($w+2*$pad)/$W)"); fh=$(python3 -c "print(($h+2*$pad)/$H)")
    cell=${cells[$i]:-0}
    stroke=$("$RH" stroke "$ctrl" $fx $fy $fw $fh | sed -E 's/STROKE ([0-9.]+).*/\1/')
    ratio=$(python3 -c "print('%.2f'%($cell/$stroke if $stroke>0.1 else 99))")
    ocr=$("$RH" ocr2 "$treat" $fx $fy $fw $fh | sed 's/OCR //' | tr '\n' '|')
    hit=$(tokhit "$text" "${ocr%|}")
    say "  $id: cell=$cell stroke=$stroke ratio=${ratio}x ocr=[${ocr%|}]"
    python3 -c "exit(0 if $cell >= $MARGIN*$stroke else 1)" \
      && : || bad "$card/$id cell $cell < ${MARGIN}x stroke $stroke (glyph may survive)"
    [ "$hit" = "HIT" ] && bad "$card/$id hardened OCR READ the secret [$ocr]"
    i=$((i+1))
  done < "$man"
}

gate_card light
gate_card dark

# ---- TEETH: a forced below-floor cell must fall under the big-text stroke ----
say ""; say "==== TEETH — the stroke clamp is meaningful ===="
# Safety now rides the runtime stroke clamp (cell >= 1.5x MEASURED stroke), not a
# fixed floor. Teeth: a cell of 16 forced on the big region falls under 1.5x its
# measured stroke, so the geometric check rejects it (and the compositor would clamp
# it up). This is the boundary the eye-check confirmed (cell 16 leaked, >=24 held).
read bx by bw bh <<<"$(grep '^ITEM big ' "$WORK/m-light.txt" | awk '{print $3,$4,$5,$6}')"
p=$(python3 -c "print(max(4.0,0.05*$bh))")
bfx=$(python3 -c "print(($bx-$p)/$W)"); bfy=$(python3 -c "print(($by-$p)/$H)"); bfw=$(python3 -c "print(($bw+2*$p)/$W)"); bfh=$(python3 -c "print(($bh+2*$p)/$H)")
bstroke=$("$RH" stroke "$WORK/c-light.mp4" $bfx $bfy $bfw $bfh | sed -E 's/STROKE ([0-9.]+).*/\1/')
say "  big stroke=$bstroke ; a forced cell of 16 => ratio $(python3 -c "print('%.2f'%(16/$bstroke))")x (need >= 1.5x)"
python3 -c "exit(0 if 16 < 1.5*$bstroke else 1)" \
  && ok "teeth: forced cell 16 is below 1.5x the measured stroke ($bstroke) — rejected/clamped up" \
  || bad "teeth: cell 16 clears 1.5x stroke $bstroke — clamp no longer meaningful"

# ---- ADVISORY: discriminability D (not a hard fail) ----
say ""; say "==== ADVISORY — discriminability D (block-pattern leak, accepted limit) ===="
dbig=$(bash "$HERE/discriminability.sh" big '$849' '$135,$672,$908,$314,$567' 2>/dev/null | grep 'D(median' | sed 's/^ *//')
say "  big \$849 pixelate: $dbig  (advisory; see DECISIONS 2026-07-26)"

say ""
say "NOTE (DECISIONS 2026-07-27): these checks are NECESSARY, NOT SUFFICIENT. Hardened"
say "OCR read NOTHING off a short small-values strip the owner's eye read clearly (cell"
say "11, floor 10) — a false pass. The cell>1.5*stroke geometric check is likewise a"
say "stroke check, not a legibility guarantee (stroke ~ 1/4 of a character). The FLOOR"
say "(24) is the guarantee; the OWNER'S EYE is the final gate. This gate narrows the"
say "search, it does not clear the build."
say ""
if [ $PASS -eq 1 ]; then say "===== LEGIBILITY GATE: ALL PASS (eye-check still required — see NOTE) ====="; else say "===== LEGIBILITY GATE: FAILURES ABOVE ====="; fi
exit $((1-PASS))
