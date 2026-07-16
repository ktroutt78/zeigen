#!/usr/bin/env python3
"""Phase 4 A/B: V3 Core Image watermark vs V2 ffmpeg watermark (screen-anchored).

The SAME logo PNG is fed to both renderers (only the composite math differs), and
the V2 fragment is replicated verbatim from composite.rs. Two renders:
  - identity (no zoom): per-bbox region diff (watermark box + a clean control box) —
    the mechanical tripwire (placement / scale / opacity / edge parity).
  - punch (2x zoom): confirms the watermark stays SCREEN-ANCHORED (same position and
    size on the zoomed frame, not zoomed with content) + blind stills for the eye.

Harness MEASURES; it does not judge "better." Verdicts are the owner's.
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
# composite.rs metrics: height = round(0.10*short), padding = round(0.02*short).
SHORT = min(W, H)
WM_CORNER = "tr"        # composite.rs default is tr (Corner::from_code default br, UI tr)
WM_OPACITY = 1.0        # test at full opacity first; opacity path is a one-line add
WM_SCALE_FRAC = None    # None -> legacy height-based 10% of short side


def sh(cmd):
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        print("FAILED:", " ".join(str(c) for c in cmd)); print(r.stderr[-1200:]); raise SystemExit(1)
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


def wm_scale_frag():
    """composite.rs scale + opacity fragment on input [1:v] -> [wm]."""
    if WM_SCALE_FRAC is not None:
        s = f"scale={round(W * WM_SCALE_FRAC)}:-2"
    else:
        s = f"scale=-2:{round(SHORT * 0.10)}"
    fade = f",format=rgba,colorchannelmixer=aa={WM_OPACITY:.3f}" if WM_OPACITY < 0.999 else ""
    return f"[1:v]{s}{fade}[wm]"


def wm_overlay_xy(p):
    return {
        "tl": f"{p}:{p}",
        "tr": f"main_w-overlay_w-{p}:{p}",
        "bl": f"{p}:main_h-overlay_h-{p}",
        "br": f"main_w-overlay_w-{p}:main_h-overlay_h-{p}",
    }[WM_CORNER]


def wm_bbox(logo_w, logo_h):
    """Watermark rect in output px (top-left origin), matching composite.rs placement."""
    if WM_SCALE_FRAC is not None:
        ow = round(W * WM_SCALE_FRAC)
        oh = round(ow * logo_h / logo_w / 2) * 2  # ffmpeg -2 -> even
    else:
        oh = round(SHORT * 0.10)
        ow = round(logo_w * oh / logo_h / 2) * 2
    p = round(SHORT * 0.02)
    x = {"tl": p, "bl": p, "tr": W - ow - p, "br": W - ow - p}[WM_CORNER]
    y = {"tl": p, "tr": p, "bl": H - oh - p, "br": H - oh - p}[WM_CORNER]
    return x, y, ow, oh


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True)
    ap.add_argument("--logo", required=True)
    ap.add_argument("--workdir", required=True)
    ap.add_argument("--compositor", required=True)
    ap.add_argument("--python", required=True)
    args = ap.parse_args()
    wd = Path(args.workdir); wd.mkdir(parents=True, exist_ok=True)
    venv = args.python

    from PIL import Image
    lw, lh = Image.open(args.logo).size

    clip = wd / "clip.mp4"
    if not clip.exists():
        sh([FFMPEG, "-y", "-v", "error", "-i", str(args.src), "-t", str(CLIP_SECS),
            "-vf", f"scale={W}:{H}", "-r", str(FPS), *VT, str(clip)])

    env_v3 = {"WATERMARK_PNG": str(args.logo), "WATERMARK_CORNER": WM_CORNER,
              "WATERMARK_OPACITY": str(WM_OPACITY)}
    if WM_SCALE_FRAC is not None:
        env_v3["WATERMARK_SCALE_FRAC"] = str(WM_SCALE_FRAC)

    def run_v3(out, scenario):
        import os
        r = subprocess.run([args.compositor, str(clip), str(out), scenario],
                           capture_output=True, text=True, env={**os.environ, **env_v3})
        if r.returncode != 0:
            print("V3 FAILED:", r.stderr or r.stdout); raise SystemExit(1)

    def run_v2(out, zoom):
        p = round(SHORT * 0.02)
        if zoom:
            fc = f"[0:v]{v2_zoom_chain(PUNCH)}[zv];{wm_scale_frag()};[zv][wm]overlay={wm_overlay_xy(p)}[vout]"
        else:
            fc = f"{wm_scale_frag()};[0:v][wm]overlay={wm_overlay_xy(p)}[vout]"
        sh([FFMPEG, "-y", "-v", "error", "-i", str(clip), "-i", str(args.logo),
            "-filter_complex", fc, "-map", "[vout]", *VT, str(out)])

    box = wm_bbox(lw, lh)
    # control box: opposite corner, same size, no watermark
    ctrl = (round(SHORT * 0.02), round(SHORT * 0.02), box[2], box[3])  # top-left corner

    # ---- identity: mechanical parity ----
    run_v2(wd / "v2_wm_id.mp4", zoom=False)
    run_v3(wd / "v3_wm_id.mp4", "identity")
    diff = wd / "wm_id_diff.json"
    sh([venv, str(HERE / "spatial_diff.py"), "--ref", str(wd / "v2_wm_id.mp4"),
        "--test", str(wd / "v3_wm_id.mp4"),
        "--region", "watermark:" + ",".join(map(str, box)),
        "--region", "control:" + ",".join(map(str, ctrl)),
        "--fps", "3", "--json", str(diff)])
    d = json.loads(diff.read_text())

    # ---- punch zoom: watermark must stay screen-anchored (same box, sharp) ----
    run_v2(wd / "v2_wm_zoom.mp4", zoom=True)
    run_v3(wd / "v3_wm_zoom.mp4", "punch")
    zdiff = json.loads(sh([venv, str(HERE / "spatial_diff.py"),
        "--ref", str(wd / "v2_wm_zoom.mp4"), "--test", str(wd / "v3_wm_zoom.mp4"),
        "--region", "watermark:" + ",".join(map(str, box)),
        "--fps", "3"]).stdout)

    # blind stills (identity, full frame) + blind A/B clip mapping
    assign = ["v2", "v3"]
    random.Random(4444).shuffle(assign)
    mapping = {"A": assign[0], "B": assign[1]}
    (wd / "wm_blind_map.json").write_text(json.dumps(mapping))
    for L, tag in mapping.items():
        sh([FFMPEG, "-y", "-v", "error", "-i", str(wd / f"{tag}_wm_id.mp4"),
            "-vf", "select=eq(n\\,30)", "-frames:v", "1", str(wd / f"BLIND_{L}_wm_id.png")])
        sh([FFMPEG, "-y", "-v", "error", "-i", str(wd / f"{tag}_wm_id.mp4"),
            "-vf", f"select=eq(n\\,30),crop={box[2]+40}:{box[3]+40}:{max(0,box[0]-20)}:{max(0,box[1]-20)},scale=iw*3:ih*3:flags=neighbor",
            "-frames:v", "1", str(wd / f"BLIND_{L}_wm_peep.png")])
        (wd / f"BLIND_{L}_wm.mp4").write_bytes((wd / f"{tag}_wm_zoom.mp4").read_bytes())

    print("\n==================== WATERMARK A/B ====================")
    print(f"logo={Path(args.logo).name} {lw}x{lh}  corner={WM_CORNER}  opacity={WM_OPACITY}  box(xywh)={box}")
    print("IDENTITY (mechanical parity, V2 vs V3 — same logo PNG, only composite math):")
    print(f"  global     SSIM {d['global']['ssim']['all']:.4f}  PSNR-Y {d['global']['psnr']['y']:.2f} dB  dE {d['global']['de00_mean']:.3f}")
    for r in ("watermark", "control"):
        m = d["regions"][r]
        print(f"  {r:9}  SSIM {m['ssim']:.4f}  PSNR {m['psnr']:.2f} dB  dE {m['de00_mean']:.3f}")
    print(f"  frames V2/V3: {d['frames']}  match={d['frames_match']}")
    print("\nPUNCH 2x (watermark stays SCREEN-ANCHORED — same box, not zoomed):")
    wmz = zdiff["regions"]["watermark"]
    print(f"  watermark box  SSIM {wmz['ssim']:.4f}  PSNR {wmz['psnr']:.2f} dB  dE {wmz['de00_mean']:.3f}")
    print(f"  whole-frame    SSIM {zdiff['global']['ssim']['all']:.4f} (content differs: V3 sharper zoom — eye-judged)")
    print(f"\nblind stills: {wd}/BLIND_A_wm_id.png  {wd}/BLIND_B_wm_id.png  (+ _wm_peep.png 3x)")
    print(f"blind clips:  {wd}/BLIND_A_wm.mp4  {wd}/BLIND_B_wm.mp4")
    print(f"(A/B mapping held in wm_blind_map.json)")


if __name__ == "__main__":
    main()
