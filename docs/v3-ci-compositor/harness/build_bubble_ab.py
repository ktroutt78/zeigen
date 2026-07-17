#!/usr/bin/env python3
"""Phase 4 A/B: V3 Core Image webcam bubble vs V2 ffmpeg bubble (composite.rs).

The SAME webcam source + mask PNG + shadow silhouette PNG feed both renderers, so
only the composite math (and CIGaussianBlur-vs-gblur for the shadow) differs. The
V2 filter is replicated verbatim from composite.rs. Two renders:
  - identity: per-bbox region diff (bubble box + shadow band + clean control) — the
    mechanical tripwire for mask edge / placement / shadow parity.
  - punch 2x: confirms the bubble stays SCREEN-ANCHORED (same box, same size) + blind
    stills/clips for the eye.

Harness MEASURES; verdicts are the owner's. Shadow gblur-vs-CIGaussianBlur is a known
tuning knob (BUBBLE_SHADOW_RADIUS_K) — budget rounds there if the shadow band diverges.
"""
import argparse
import json
import random
import subprocess
from pathlib import Path

FFMPEG = "/opt/homebrew/bin/ffmpeg"
HERE = Path(__file__).parent
W, H, FPS = 1920, 1080, 30
CLIP_SECS = 6
VT = ["-c:v", "h264_videotoolbox", "-b:v", "8M", "-profile:v", "high", "-pix_fmt",
      "yuv420p", "-tag:v", "avc1", "-allow_sw", "1", "-colorspace", "bt709",
      "-color_primaries", "bt709", "-color_trc", "bt709", "-an"]
PUNCH = {"start": 1.0, "end": 4.0, "scale": 2.0, "ramp": 0.6, "cxf": 0.66, "cyf": 0.42}

# RE-BASELINED 2026-07-16: V3 now SHIPS an offset-down-right drop shadow (main.swift
# `elevated`, the default), while V2 keeps its flat gblur shadow. So the bubble +
# shadow_band region diffs below WILL diverge from V2 BY DESIGN — that divergence is
# NOT a regression and this is no longer a V2-parity gate for the bubble. The mask/
# placement (mechanical) and screen-anchoring still hold. See DECISIONS.md.
D = 240                 # bubble diameter
ZONE = "br"             # br|bl|tr|tl|bc|tc
P = 30                  # composite.rs PADDING_PX (bumped 24->30 for the shadow's room)
SP = round(0.25 * D)    # shadow padding = 60
OY = round(D / 30)      # shadow y offset = 8
SIGMA = round(0.075 * D)  # gblur sigma = 18
ALPHA = 0.22
CS = D + 2 * SP         # shadow canvas = 360


def sh(cmd):
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        print("FAILED:", " ".join(str(c) for c in cmd)); print(r.stderr[-1400:]); raise SystemExit(1)
    return r


def ease(u):
    return f"if(lt({u},0.5),4*({u})*({u})*({u}),1-pow(-2*({u})+2,3)/2)"


def scale_expr(seg, tv="it"):
    a, b, sc, ramp = seg["start"], seg["end"], seg["scale"], seg["ramp"]
    ramp = min(ramp, (b - a) / 2)
    uin, uout = f"({tv}-{a:.4f})/{ramp:.4f}", f"({b:.4f}-{tv})/{ramp:.4f}"
    amp = sc - 1
    segx = (f"if(lt({tv},{a+ramp:.4f}),1+{amp:.4f}*{ease(uin)},"
            f"if(gt({tv},{b-ramp:.4f}),1+{amp:.4f}*{ease(uout)},{sc:.4f}))")
    return f"if(between({tv},{a:.4f},{b:.4f}),{segx},1)"


def pan_expr(c_px, dim, n):
    nd = n * dim
    return f"st(0,{c_px:.4f});{n}*clip(ld(0),{dim}/(2*zoom),{dim}-{dim}/(2*zoom))-{nd}/(2*zoom)"


def v2_zoom_chain(seg, n=4):
    nw, nh = n * W, n * H
    z, px, py = scale_expr(seg), pan_expr(seg["cxf"] * W, W, n), pan_expr(seg["cyf"] * H, H, n)
    return (f"scale={nw}:{nh}:flags=lanczos,"
            f"zoompan=z='{z}':x='{px}':y='{py}':d=1:s={nw}x{nh}:fps={FPS},"
            f"scale={W}:{H}:flags=lanczos")


def bubble_xy():
    hR, hC = ZONE.endswith("r"), ZONE.endswith("c")
    vT = ZONE.startswith("t")
    x = "main_w-overlay_w-{}".format(P) if hR else (f"(main_w-{D})/2" if hC else f"{P}")
    y = f"{P}" if vT else "main_h-overlay_h-{}".format(P)
    return f"{x}:{y}"


def shadow_xy():
    hR, hC = ZONE.endswith("r"), ZONE.endswith("c")
    vT = ZONE.startswith("t")
    x = f"main_w-{D+P+SP}" if hR else (f"(main_w-{D})/2-{SP}" if hC else f"{P-SP}")
    y = f"{P+OY-SP}" if vT else f"main_h-{D+P-OY+SP}"
    return f"{x}:{y}"


def bubble_bbox_px():
    hR, hC = ZONE.endswith("r"), ZONE.endswith("c")
    vT = ZONE.startswith("t")
    x = W - D - P if hR else ((W - D) // 2 if hC else P)
    y = P if vT else H - D - P
    return x, y, D, D


def v2_bubble_frag(base, out):
    """composite.rs webcam_overlay_filter rendering tail. inputs: 1=webcam 2=mask 3=shadow."""
    return (f"[1:v]hflip,crop='min(iw\\,ih)':'min(iw\\,ih)',scale={D}:{D},format=yuva420p[wc_rgba];"
            f"[2:v]format=gray[mask_g];[wc_rgba][mask_g]alphamerge[wc];"
            f"[3:v]format=rgba,gblur=sigma={SIGMA},colorchannelmixer=aa={ALPHA}[sh];"
            f"[{base}][sh]overlay={shadow_xy()}:eof_action=pass[shadowed];"
            f"[shadowed][wc]overlay={bubble_xy()}:eof_action=pass[{out}]")


def main():
    ap = argparse.ArgumentParser()
    for a in ("--src", "--webcam", "--mask", "--shadow", "--workdir", "--compositor", "--python"):
        ap.add_argument(a, required=True)
    args = ap.parse_args()
    wd = Path(args.workdir); wd.mkdir(parents=True, exist_ok=True)
    venv = args.python

    clip = wd / "clip.mp4"
    if not clip.exists():
        sh([FFMPEG, "-y", "-v", "error", "-i", str(args.src), "-t", str(CLIP_SECS),
            "-vf", f"scale={W}:{H}", "-r", str(FPS), *VT, str(clip)])

    env_v3 = {"BUBBLE_WEBCAM": str(args.webcam), "BUBBLE_MASK_PNG": str(args.mask),
              "BUBBLE_SHADOW_PNG": str(args.shadow), "BUBBLE_DIAMETER": str(D),
              "BUBBLE_ZONE": ZONE, "BUBBLE_SHADOW_ALPHA": str(ALPHA)}

    def run_v3(out, scenario):
        import os
        r = subprocess.run([args.compositor, str(clip), str(out), scenario],
                           capture_output=True, text=True, env={**os.environ, **env_v3})
        if r.returncode != 0:
            print("V3 FAILED:", r.stderr or r.stdout); raise SystemExit(1)

    def run_v2(out, zoom):
        if zoom:
            fc = f"[0:v]{v2_zoom_chain(PUNCH)}[zv];{v2_bubble_frag('zv','vout')}"
        else:
            fc = v2_bubble_frag("0:v", "vout")
        sh([FFMPEG, "-y", "-v", "error", "-i", str(clip), "-i", str(args.webcam),
            "-i", str(args.mask), "-i", str(args.shadow),
            "-filter_complex", fc, "-map", "[vout]", *VT, str(out)])

    bx, by, bw, bh = bubble_bbox_px()
    shadow_band = (max(0, bx - SP), max(0, by - SP), bw + 2 * SP, bh + 2 * SP)  # bubble + shadow halo
    ctrl = (round(0.03 * W), round(0.03 * H), bw, bh)

    run_v2(wd / "v2_bub_id.mp4", zoom=False)
    run_v3(wd / "v3_bub_id.mp4", "identity")
    diff = wd / "bub_id_diff.json"
    sh([venv, str(HERE / "spatial_diff.py"), "--ref", str(wd / "v2_bub_id.mp4"),
        "--test", str(wd / "v3_bub_id.mp4"),
        "--region", "bubble:" + ",".join(map(str, (bx, by, bw, bh))),
        "--region", "shadow_band:" + ",".join(map(str, shadow_band)),
        "--region", "control:" + ",".join(map(str, ctrl)),
        "--fps", "3", "--json", str(diff)])
    d = json.loads(diff.read_text())

    run_v2(wd / "v2_bub_zoom.mp4", zoom=True)
    run_v3(wd / "v3_bub_zoom.mp4", "punch")
    zdiff = json.loads(sh([venv, str(HERE / "spatial_diff.py"),
        "--ref", str(wd / "v2_bub_zoom.mp4"), "--test", str(wd / "v3_bub_zoom.mp4"),
        "--region", "bubble:" + ",".join(map(str, (bx, by, bw, bh))),
        "--fps", "3"]).stdout)

    assign = ["v2", "v3"]; random.Random(7777).shuffle(assign)
    mapping = {"A": assign[0], "B": assign[1]}
    (wd / "bub_blind_map.json").write_text(json.dumps(mapping))
    peep = (max(0, bx - SP - 10), max(0, by - SP - 10), bw + 2 * SP + 20, bh + 2 * SP + 20)
    for L, tag in mapping.items():
        sh([FFMPEG, "-y", "-v", "error", "-i", str(wd / f"{tag}_bub_id.mp4"),
            "-vf", "select=eq(n\\,60)", "-frames:v", "1", str(wd / f"BLIND_{L}_bub_id.png")])
        sh([FFMPEG, "-y", "-v", "error", "-i", str(wd / f"{tag}_bub_id.mp4"),
            "-vf", f"select=eq(n\\,60),crop={peep[2]}:{peep[3]}:{peep[0]}:{peep[1]},scale=iw*2:ih*2:flags=neighbor",
            "-frames:v", "1", str(wd / f"BLIND_{L}_bub_peep.png")])
        (wd / f"BLIND_{L}_bub.mp4").write_bytes((wd / f"{tag}_bub_zoom.mp4").read_bytes())

    print("\n==================== WEBCAM BUBBLE A/B ====================")
    print(f"diameter={D} zone={ZONE} shadow(sigma={SIGMA} alpha={ALPHA} pad={SP} offY={OY})  bubble box={bubble_bbox_px()}")
    print("IDENTITY (mechanical parity, V2 vs V3 — same webcam+mask+shadow):")
    print(f"  global       SSIM {d['global']['ssim']['all']:.4f}  PSNR-Y {d['global']['psnr']['y']:.2f} dB  dE {d['global']['de00_mean']:.3f}")
    for r in ("bubble", "shadow_band", "control"):
        m = d["regions"][r]
        print(f"  {r:12} SSIM {m['ssim']:.4f}  PSNR {m['psnr']:.2f} dB  dE {m['de00_mean']:.3f}")
    print(f"  frames V2/V3: {d['frames']}  match={d['frames_match']}")
    bz = zdiff["regions"]["bubble"]
    print(f"\nPUNCH 2x (bubble stays SCREEN-ANCHORED): box SSIM {bz['ssim']:.4f} PSNR {bz['psnr']:.2f} dB dE {bz['de00_mean']:.3f}")
    print(f"\nblind stills: {wd}/BLIND_A_bub_id.png  {wd}/BLIND_B_bub_id.png  (+ _bub_peep.png 2x)")
    print(f"blind clips:  {wd}/BLIND_A_bub.mp4  {wd}/BLIND_B_bub.mp4   (mapping: bub_blind_map.json)")


if __name__ == "__main__":
    main()
