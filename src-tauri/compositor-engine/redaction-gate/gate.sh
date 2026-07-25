#!/bin/bash
# Redaction illegibility gate (REDACTION-PLAN commit 2). Objective, re-runnable,
# no eyeballing. Builds the compositor from ../main.swift and a text-fixture +
# gradient-measure harness, then asserts:
#
#   CHECK A  illegibility at 1x and 2x source scale — the frosted panel over a
#            realistic address at normal UI font is illegible AFTER an attacker
#            inverts the known overlay (B = (out - a*C)/(1-a)). Measured as
#            recovered luma-gradient energy vs the sharp-text control; must be a
#            tiny fraction. RECOVERY-AWARE so the OVERLAY cannot mask a weak blur.
#   CHECK A-teeth  the SAME gate with the radius floor lowered to 4 must FAIL —
#            proof the gate is not vacuous, so a future floor reduction is caught.
#   CHECK B  coverage holds under zoom — a 2x zoom centered on the text; the frost
#            must land on the MAGNIFIED text (transform tracks content, not a fixed
#            screen box).
#   CHECK C  radius scales with region size — a small box pins at the floor, a
#            large box scales by k*min(w,h).
#
# The blur-radius FLOOR is a SAFETY parameter (DECISIONS 2026-07-25): it may rise
# but not fall without a stated reason. CHECK A-teeth enforces that here.
#
# NOTE: this is the CURRENT-binary regression gate. The one-time "redaction-absent
# export is byte-identical to pre-feature" proof (decoded-pixel A/B vs the pre-change
# binary) is recorded in the commit that introduced the feature; the permanent
# guard is the Rust wiring test (no redaction env emitted for an empty list) plus
# the compositor's `if !redactions.isEmpty` gate.
#
# Usage: ./gate.sh      (needs swiftc + /opt/homebrew/bin/ffmpeg)
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
FF=/opt/homebrew/bin/ffmpeg
[ -x "$FF" ] || FF=$(command -v ffmpeg) || { echo "ffmpeg not found"; exit 2; }
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
ADDR="1428 Maple Grove Terrace, Springfield IL"
ILLEG_TH=0.005
PASS=1
say(){ printf '%s\n' "$*"; }
ok(){ printf 'PASS  %s\n' "$*"; }
bad(){ printf 'FAIL  %s\n' "$*"; PASS=0; }
mkg(){ local o; o=$("$FF" -y -loglevel error "$@" 2>&1) || { echo "ffmpeg failed: $o"; exit 2; }; }
frac(){ python3 -c "print('%.6f'%($1/$2))"; }

say "building compositor + harness..."
swiftc -O "$HERE/../main.swift" -o "$WORK/cico" 2>"$WORK/c.err" || { grep -i error "$WORK/c.err"|head; exit 2; }
swiftc -O "$HERE/harness.swift" -o "$WORK/h" 2>"$WORK/h.err" || { grep -i error "$WORK/h.err"|head; exit 2; }
NEW="$WORK/cico"; H="$WORK/h"

BB1=$("$H" gen "$WORK/t1.png" 1512 982 15 "$ADDR"); read _ bx1 by1 bw1 bh1 <<<"$BB1"
BB2=$("$H" gen "$WORK/t2.png" 3024 1964 30 "$ADDR"); read _ bx2 by2 bw2 bh2 <<<"$BB2"
mkg -loop 1 -i "$WORK/t1.png" -t 2 -r 30 -pix_fmt yuv420p -c:v libx264 "$WORK/in1.mp4"
mkg -loop 1 -i "$WORK/t2.png" -t 2 -r 30 -pix_fmt yuv420p -c:v libx264 "$WORK/in2.mp4"

# ---- CHECK A: illegibility (recovery-aware) + teeth ----
say ""; say "==== CHECK A: illegibility after overlay-recovery (1x + 2x) ===="
illeg(){ # in W H bx by bw bh label
  local IN=$1 W=$2 Hh=$3 X=$4 Y=$5 Bw=$6 Bh=$7 LB=$8
  local padx pady rx ry rw rh mfx mfy mfw mfh ec et ratio et4 ratio4
  pady=$(python3 -c "print(max(4,int($Bh*0.4)))"); padx=$(python3 -c "print(max(6,int($Bh*0.6)))")
  rx=$(frac $((X-padx)) $W); ry=$(frac $((Y-pady)) $Hh); rw=$(frac $((Bw+2*padx)) $W); rh=$(frac $((Bh+2*pady)) $Hh)
  mfx=$(frac $X $W); mfy=$(frac $Y $Hh); mfw=$(frac $Bw $W); mfh=$(frac $Bh $Hh)
  printf '[{"x":%s,"y":%s,"w":%s,"h":%s,"start":0,"end":5,"tint":"light"}]\n' $rx $ry $rw $rh > "$WORK/r_$LB.json"
  "$NEW" "$IN" "$WORK/ctl_$LB.mp4" >/dev/null 2>&1
  ec=$("$H" measure "$WORK/ctl_$LB.mp4" $mfx $mfy $mfw $mfh)
  REDACT_REGIONS="$WORK/r_$LB.json" "$NEW" "$IN" "$WORK/red_$LB.mp4" >/dev/null 2>&1
  et=$("$H" measure "$WORK/red_$LB.mp4" $mfx $mfy $mfw $mfh 0.6 1.0)
  ratio=$(python3 -c "print('%.6f'%($et/$ec if $ec>0 else 9))")
  say "  $LB: control=$ec recovered-residual=$et ratio=$ratio (< $ILLEG_TH)"
  python3 -c "exit(0 if $ratio < $ILLEG_TH else 1)" && ok "$LB illegible (ratio $ratio)" || bad "$LB recoverable (ratio $ratio)"
  REDACT_RADIUS_FLOOR=4 REDACT_REGIONS="$WORK/r_$LB.json" "$NEW" "$IN" "$WORK/red4_$LB.mp4" >/dev/null 2>&1
  et4=$("$H" measure "$WORK/red4_$LB.mp4" $mfx $mfy $mfw $mfh 0.6 1.0)
  ratio4=$(python3 -c "print('%.6f'%($et4/$ec if $ec>0 else 9))")
  say "  $LB teeth: floor=4 ratio=$ratio4 (must be >= $ILLEG_TH)"
  python3 -c "exit(0 if $ratio4 >= $ILLEG_TH else 1)" && ok "$LB gate has teeth (floor=4 fails)" || bad "$LB gate VACUOUS (floor=4 passes)"
}
illeg "$WORK/in1.mp4" 1512 982 $bx1 $by1 $bw1 $bh1 "1x"
illeg "$WORK/in2.mp4" 3024 1964 $bx2 $by2 $bw2 $bh2 "2x"

# ---- CHECK B: coverage holds under zoom ----
say ""; say "==== CHECK B: coverage holds under zoom (frost tracks magnified text) ===="
cxf=$(python3 -c "print('%.5f'%(($bx1+$bw1/2)/1512))"); cyf=$(python3 -c "print('%.5f'%(($by1+$bh1/2)/982))")
printf '[{"start":0,"end":5,"scale":2.0,"ramp":0,"cxf":%s,"cyf":%s}]\n' $cxf $cyf > "$WORK/zoomc.json"
padx=$(python3 -c "print(max(6,int($bh1*0.6)))"); pady=$(python3 -c "print(max(4,int($bh1*0.4)))")
rrx=$(frac $((bx1-padx)) 1512); rry=$(frac $((by1-pady)) 982); rrw=$(frac $((bw1+2*padx)) 1512); rrh=$(frac $((bh1+2*pady)) 982)
printf '[{"x":%s,"y":%s,"w":%s,"h":%s,"start":0,"end":5,"tint":"light"}]\n' $rrx $rry $rrw $rrh > "$WORK/redz.json"
ZOOM_SEGMENTS="$WORK/zoomc.json" "$NEW" "$WORK/in1.mp4" "$WORK/zc_ctl.mp4" >/dev/null 2>&1
ZOOM_SEGMENTS="$WORK/zoomc.json" REDACT_REGIONS="$WORK/redz.json" "$NEW" "$WORK/in1.mp4" "$WORK/zc_red.mp4" >/dev/null 2>&1
ez_c=$("$H" measure "$WORK/zc_ctl.mp4" 0.25 0.40 0.50 0.20)
ez_r=$("$H" measure "$WORK/zc_red.mp4" 0.25 0.40 0.50 0.20 0.6 1.0)
zratio=$(python3 -c "print('%.6f'%($ez_r/$ez_c if $ez_c>0 else 9))")
say "  zoomed central band: control=$ez_c recovered-residual=$ez_r ratio=$zratio (< 0.01)"
python3 -c "exit(0 if $zratio < 0.01 else 1)" && ok "frost tracks magnified text (ratio $zratio)" || bad "frost misses magnified text (ratio $zratio)"

# ---- CHECK C: radius scales with region size ----
say ""; say "==== CHECK C: radius scales with region size ===="
cat > "$WORK/radii.json" <<JSON
[{"x":0.10,"y":0.10,"w":0.05,"h":0.011,"start":0,"end":5,"tint":"light"},
 {"x":0.40,"y":0.40,"w":0.35,"h":0.35,"start":0,"end":5,"tint":"light"}]
JSON
REDACT_DEBUG=on REDACT_REGIONS="$WORK/radii.json" "$NEW" "$WORK/in1.mp4" "$WORK/radii.mp4" 2>"$WORK/radii.log" >/dev/null
r_small=$(grep REDACT "$WORK/radii.log" | head -1 | sed -E 's/.*radius=([0-9.]+).*/\1/')
r_large=$(grep REDACT "$WORK/radii.log" | head -2 | tail -1 | sed -E 's/.*radius=([0-9.]+).*/\1/')
say "  small radius=$r_small (expect floor 16.00)  large radius=$r_large (expect ~0.08*min)"
python3 -c "exit(0 if abs($r_small-16.0)<0.01 else 1)" && ok "small region at floor" || bad "small radius=$r_small not floor"
python3 -c "exit(0 if $r_large>20 and abs($r_large-0.08*min(0.35*1512,0.35*982))<1.0 else 1)" && ok "large region scales (radius=$r_large)" || bad "large radius=$r_large not scaling"

say ""; if [ $PASS -eq 1 ]; then say "===== REDACTION GATE: ALL PASS ====="; else say "===== REDACTION GATE: FAILURES ABOVE ====="; fi
exit $((1-PASS))
