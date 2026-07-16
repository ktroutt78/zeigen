#!/usr/bin/env python3
"""Phase 2 A/B: V3 Core Image zoom (single lanczos) vs V2 ffmpeg zoom
(oversample+zoompan, 3 resamples) vs an ideal single-lanczos reference.

- SHARPNESS (const 2x center): Laplacian edge energy + PSNR to the ideal
  single-resample. V3 should sit near the ideal; V2's 3-resample should be softer.
- SMOOTHNESS (slow 2.5s ramp, off-center): temporal probe on V3 vs V2-4x vs
  V2-naive-1x. V3 (continuous) should have the lowest jerk / quant_fraction.

V2 filters are ported from edit.rs zoom_filter_fragment, using the segment's own
ramp so V2 and V3 render the SAME motion (fair A/B). Geometry is validated by SSIM
between V2 and V3 at peak zoom.
"""
import argparse
import json
import subprocess
from pathlib import Path

FFMPEG = "/opt/homebrew/bin/ffmpeg"
HERE = Path(__file__).parent
W, H, FPS = 1920, 1080, 30
VT = ["-c:v", "h264_videotoolbox", "-b:v", "8M", "-profile:v", "high", "-pix_fmt",
      "yuv420p", "-tag:v", "avc1", "-allow_sw", "1", "-colorspace", "bt709",
      "-color_primaries", "bt709", "-color_trc", "bt709", "-an"]


def sh(cmd):
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        print("FAILED:", " ".join(str(c) for c in cmd)); print(r.stderr[-700:]); raise SystemExit(1)
    return r


def ease(u):
    return f"if(lt({u},0.5),4*({u})*({u})*({u}),1-pow(-2*({u})+2,3)/2)"


def scale_expr(seg, tv="it"):
    a, b, sc, ramp = seg["start"], seg["end"], seg["scale"], seg["ramp"]
    ramp = min(ramp, (b - a) / 2)
    if ramp <= 0.001:
        segx = f"{sc:.4f}"
    else:
        uin, uout = f"({tv}-{a:.4f})/{ramp:.4f}", f"({b:.4f}-{tv})/{ramp:.4f}"
        amp = sc - 1
        segx = (f"if(lt({tv},{a+ramp:.4f}),1+{amp:.4f}*{ease(uin)},"
                f"if(gt({tv},{b-ramp:.4f}),1+{amp:.4f}*{ease(uout)},{sc:.4f}))")
    return f"if(between({tv},{a:.4f},{b:.4f}),{segx},1)"


def pan_expr(c_px, dim, n):
    nd = n * dim
    return f"st(0,{c_px:.4f});{n}*clip(ld(0),{dim}/(2*zoom),{dim}-{dim}/(2*zoom))-{nd}/(2*zoom)"


def v2_filter(seg, n):
    """edit.rs zoom_filter_fragment: n-x lanczos oversample -> zoompan -> lanczos down."""
    nw, nh = n * W, n * H
    z = scale_expr(seg)
    px = pan_expr(seg["cx_px"], W, n)
    py = pan_expr(seg["cy_px"], H, n)
    zp = f"zoompan=z='{z}':x='{px}':y='{py}':d=1:s={nw}x{nh}:fps={FPS}"
    if n == 1:
        return zp
    return f"scale={nw}:{nh}:flags=lanczos,{zp},scale={W}:{H}:flags=lanczos"


def render_v2(src, out, seg, n):
    sh([FFMPEG, "-y", "-v", "error", "-i", str(src), "-vf", v2_filter(seg, n), *VT, str(out)])


def lap_sharp(png, venv):
    code = ("import sys,numpy as np;from PIL import Image;"
            "a=np.asarray(Image.open(sys.argv[1]).convert('L'),float);"
            "k=np.array([[0,1,0],[1,-4,1],[0,1,0]]);"
            "from numpy.lib.stride_tricks import sliding_window_view as s;"
            "w=s(a,(3,3));l=(w*k).sum((-1,-2));print(round(float(np.abs(l).mean()),3))")
    return float(subprocess.run([venv, "-c", code, png], capture_output=True, text=True).stdout)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True)
    ap.add_argument("--workdir", required=True)
    ap.add_argument("--compositor", required=True)
    ap.add_argument("--python", required=True)
    args = ap.parse_args()
    wd = Path(args.workdir); wd.mkdir(parents=True, exist_ok=True)
    venv = args.python

    const = {"start": 0, "end": 9999, "scale": 2.0, "ramp": 0.0, "cx_px": W / 2, "cy_px": H / 2}
    slow = {"start": 0, "end": 5, "scale": 1.6, "ramp": 2.5, "cx_px": 1750, "cy_px": 520}

    # ---- SHARPNESS: const 2x ----
    sh([args.compositor, str(args.src), str(wd / "v3_const.mp4"), "const"])
    render_v2(args.src, wd / "v2_const.mp4", const, 4)
    sh([FFMPEG, "-y", "-v", "error", "-i", str(args.src),
        "-vf", f"crop={W//2}:{H//2}:{W//4}:{H//4},scale={W}:{H}:flags=lanczos", *VT,
        str(wd / "ideal_const.mp4")])
    for name in ("v3_const", "v2_const", "ideal_const"):
        sh([FFMPEG, "-y", "-v", "error", "-i", str(wd / f"{name}.mp4"),
            "-vf", "select=eq(n\\,90)", "-frames:v", "1", str(wd / f"{name}_90.png")])
    sharp = {n: lap_sharp(str(wd / f"{n}_90.png"), venv) for n in
             ("v3_const", "v2_const", "ideal_const")}

    def spatial(ref, test, extra=""):
        cmd = [venv, str(HERE / "spatial_diff.py"), "--ref", str(wd / ref),
               "--test", str(wd / test), "--fps", "3"]
        d = json.loads(subprocess.run(cmd, capture_output=True, text=True).stdout)
        return d["global"]["ssim"]["all"], d["global"]["psnr"]["y"]

    v3_vs_ideal = spatial("ideal_const.mp4", "v3_const.mp4")
    v2_vs_ideal = spatial("ideal_const.mp4", "v2_const.mp4")
    v2_vs_v3 = spatial("v2_const.mp4", "v3_const.mp4")

    # ---- SMOOTHNESS: slow ramp ----
    sh([args.compositor, str(args.src), str(wd / "v3_slow.mp4"), "slow"])
    render_v2(args.src, wd / "v2_slow_4x.mp4", slow, 4)
    render_v2(args.src, wd / "v2_slow_naive.mp4", slow, 1)

    def probe(video):
        cmd = [venv, str(HERE / "temporal_probe.py"), "--video", str(wd / video),
               "--crop", "300,250,1000,500", "--max-frames", "120"]
        return json.loads(subprocess.run(cmd, capture_output=True, text=True).stdout)

    probes = {n: probe(f"{n}.mp4") for n in ("v3_slow", "v2_slow_4x", "v2_slow_naive")}
    # geometry validation: SSIM between V2-4x and V3 at peak zoom
    geom = spatial("v2_slow_4x.mp4", "v3_slow.mp4")

    print("\n==================== SHARPNESS (const 2x) ====================")
    print("Laplacian edge energy (higher = sharper):")
    print(f"  ideal (1 lanczos) {sharp['ideal_const']:.2f}   V3 (1 lanczos) "
          f"{sharp['v3_const']:.2f}   V2 (3 resample) {sharp['v2_const']:.2f}")
    print(f"PSNR-Y to ideal:  V3 {v3_vs_ideal[1]:.2f} dB   V2 {v2_vs_ideal[1]:.2f} dB "
          f"(closer to ideal = sharper)")
    print(f"V2 vs V3: SSIM {v2_vs_v3[0]:.4f} (structure/geometry match)")

    print("\n==================== SMOOTHNESS (slow 2.5s ramp) ====================")
    print(f"geometry check V2-4x vs V3: SSIM {geom[0]:.4f}")
    print(f"{'variant':16} {'jerk_rms':>9} {'jerk_max':>9} {'quant_frac':>11} {'vel_mean':>9}")
    for n in ("v2_slow_naive", "v2_slow_4x", "v3_slow"):
        p = probes[n]
        print(f"{n:16} {p['jerk_rms']:9.4f} {p['jerk_max']:9.4f} {p['quant_fraction']:11.3f} "
              f"{p['velocity_mean']:9.3f}")
    (wd / "zoom_ab.json").write_text(json.dumps(
        {"sharp": sharp, "v3_vs_ideal": v3_vs_ideal, "v2_vs_ideal": v2_vs_ideal,
         "geom": geom, "probes": probes}, indent=2))
    print("\nwrote", wd / "zoom_ab.json")


if __name__ == "__main__":
    main()
