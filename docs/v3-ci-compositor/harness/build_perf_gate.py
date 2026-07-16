#!/usr/bin/env python3
"""Phase 6 standalone perf gate: V3 full pipeline vs V2 full pipeline.

Same input (screen + webcam + mask + shadow + logo + 3 zoom segments). Both produce
video-only (audio is identical arnndn on both, muxed later — not the differentiator).

Measures (agreed bars, DECISIONS.md 2026-07-16):
  - CPU-time (user+sys, /usr/bin/time -l): V3 <= 60% of V2  [hard].
  - Wall-time: V3 <= 60% of V2 = pass; 60-100% owner-judges; >=100% fail.
  - Tripwires: color atoms 709/tv/yuv420p; frame count match; bubble+watermark bbox dE
    within floors; zoom-peak whole-frame SSIM high (geometry parity).
Plus blind quality stills at each zoom peak + full clips.

This MEASURES; the wall-time judgment band and the quality call are the owner's.
"""
import argparse, json, re, statistics, subprocess
from pathlib import Path

FFMPEG = "/opt/homebrew/bin/ffmpeg"
FFPROBE = "/opt/homebrew/bin/ffprobe"
HERE = Path(__file__).parent
W, H, FPS = 1920, 1080, 30
VT = ["-c:v", "h264_videotoolbox", "-b:v", "8M", "-profile:v", "high", "-pix_fmt",
      "yuv420p", "-tag:v", "avc1", "-allow_sw", "1", "-colorspace", "bt709",
      "-color_primaries", "bt709", "-color_trc", "bt709", "-an"]
D = 240; P = 24; SP = round(0.25 * D); OY = round(D / 30); SIGMA = round(0.075 * D)
WM_H = round(0.10 * H); WM_P = round(0.02 * H)


def sh(cmd, **kw):
    r = subprocess.run(cmd, capture_output=True, text=True, **kw)
    if r.returncode != 0:
        print("FAILED:", " ".join(str(c) for c in cmd)); print(r.stderr[-1600:]); raise SystemExit(1)
    return r


# ---- multi-segment V2 zoom (edit.rs: 4x lanczos oversample -> zoompan -> lanczos down) ----
def ease(u):
    return f"if(lt({u},0.5),4*({u})*({u})*({u}),1-pow(-2*({u})+2,3)/2)"


def zseg(s):
    a, b, sc, ramp = s["start"], s["end"], s["scale"], min(s["ramp"], (s["end"] - s["start"]) / 2)
    amp = sc - 1
    return (f"if(lt(it,{a+ramp:.4f}),1+{amp:.4f}*{ease(f'(it-{a:.4f})/{ramp:.4f}')},"
            f"if(gt(it,{b-ramp:.4f}),1+{amp:.4f}*{ease(f'({b:.4f}-it)/{ramp:.4f}')},{sc:.4f}))")


def nest(segs, val_of, default):
    e = default
    for s in reversed(segs):
        e = f"if(between(it,{s['start']:.4f},{s['end']:.4f}),{val_of(s)},{e})"
    return e


def v2_zoom(segs, n=4):
    nw, nh = n * W, n * H
    z = nest(segs, zseg, "1")
    cx = nest(segs, lambda s: f"{s['cxf']*W:.4f}", f"{W/2}")
    cy = nest(segs, lambda s: f"{s['cyf']*H:.4f}", f"{H/2}")
    px = f"st(0,{cx});{n}*clip(ld(0),{W}/(2*zoom),{W}-{W}/(2*zoom))-{nw}/(2*zoom)"
    py = f"st(0,{cy});{n}*clip(ld(0),{H}/(2*zoom),{H}-{H}/(2*zoom))-{nh}/(2*zoom)"
    return (f"scale={nw}:{nh}:flags=lanczos,"
            f"zoompan=z='{z}':x='{px}':y='{py}':d=1:s={nw}x{nh}:fps={FPS},"
            f"scale={W}:{H}:flags=lanczos")


def v2_filter(segs):
    # zoom -> bubble (shadow+mask) -> watermark. inputs 0=screen 1=webcam 2=mask 3=shadow 4=logo.
    return (
        f"[0:v]{v2_zoom(segs)}[zv];"
        f"[1:v]hflip,crop='min(iw\\,ih)':'min(iw\\,ih)',scale={D}:{D},format=yuva420p[wc_rgba];"
        f"[2:v]format=gray[mask_g];[wc_rgba][mask_g]alphamerge[wc];"
        f"[3:v]format=rgba,gblur=sigma={SIGMA},colorchannelmixer=aa=0.22[sh];"
        f"[zv][sh]overlay=main_w-{D+P+SP}:main_h-{D+P-OY+SP}:eof_action=pass[shadowed];"
        f"[shadowed][wc]overlay=main_w-overlay_w-{P}:main_h-overlay_h-{P}:eof_action=pass[bv];"
        f"[4:v]scale=-2:{WM_H}[wm];[bv][wm]overlay=main_w-overlay_w-{WM_P}:{WM_P}[vout]")


def timed(cmd, env=None, runs=3):
    reals, cpus = [], []
    for _ in range(runs):
        r = subprocess.run(["/usr/bin/time", "-l"] + cmd, capture_output=True, text=True, env=env)
        if r.returncode != 0:
            print(r.stderr[-1200:]); raise SystemExit("run failed")
        m = re.search(r"([\d.]+)\s+real\s+([\d.]+)\s+user\s+([\d.]+)\s+sys", r.stderr)
        if not m:
            print(r.stderr[-800:]); raise SystemExit("time parse failed")
        reals.append(float(m[1])); cpus.append(float(m[2]) + float(m[3]))
    return statistics.median(reals), statistics.median(cpus)


def atoms(path):
    r = sh([FFPROBE, "-v", "error", "-select_streams", "v:0", "-show_entries",
            "stream=pix_fmt,color_space,color_primaries,color_transfer,nb_read_frames",
            "-count_frames", "-of", "json", path])
    return json.loads(r.stdout)["streams"][0]


def main():
    ap = argparse.ArgumentParser()
    for a in ("--screen", "--webcam", "--mask", "--shadow", "--logo", "--zooms",
              "--workdir", "--compositor", "--python"):
        ap.add_argument(a, required=True)
    ap.add_argument("--runs", type=int, default=3)
    args = ap.parse_args()
    wd = Path(args.workdir); wd.mkdir(parents=True, exist_ok=True)
    venv = args.python
    segs = json.loads(Path(args.zooms).read_text())

    v2_out, v3_out = wd / "v2_full.mp4", wd / "v3_full.mp4"
    v2_cmd = [FFMPEG, "-y", "-v", "error", "-i", args.screen, "-i", args.webcam,
              "-i", args.mask, "-i", args.shadow, "-i", args.logo,
              "-filter_complex", v2_filter(segs), "-map", "[vout]", *VT, str(v2_out)]
    import os
    v3_env = {**os.environ, "ZOOM_SEGMENTS": args.zooms,
              "BUBBLE_WEBCAM": args.webcam, "BUBBLE_MASK_PNG": args.mask,
              "BUBBLE_SHADOW_PNG": args.shadow, "BUBBLE_DIAMETER": str(D),
              "BUBBLE_ZONE": "br", "BUBBLE_SHADOW_ALPHA": "0.22",
              "WATERMARK_PNG": args.logo, "WATERMARK_CORNER": "tr", "WATERMARK_OPACITY": "1.0"}
    v3_cmd = [args.compositor, args.screen, str(v3_out), "identity"]

    print(f"timing {args.runs} runs each (median)...")
    v2_real, v2_cpu = timed(v2_cmd, runs=args.runs)
    v3_real, v3_cpu = timed(v3_cmd, env=v3_env, runs=args.runs)

    # tripwires
    a2, a3 = atoms(str(v2_out)), atoms(str(v3_out))
    # bubble + watermark bbox dE, and zoom-peak whole-frame SSIM
    bub = (W - D - P, H - D - P, D, D)
    wm = (W - 108 - WM_P, WM_P, 108, 108)
    diff = json.loads(sh([venv, str(HERE / "spatial_diff.py"), "--ref", str(v2_out),
        "--test", str(v3_out), "--region", "bubble:" + ",".join(map(str, bub)),
        "--region", "watermark:" + ",".join(map(str, wm)), "--fps", "3"]).stdout)

    # zoom-peak SSIM: mid-hold frames of each segment
    peaks = [round((s["start"] + s["end"]) / 2 * FPS) for s in segs]
    peak_ssim = []
    for i, fr in enumerate(peaks):
        for tag, src in (("v2", v2_out), ("v3", v3_out)):
            sh([FFMPEG, "-y", "-v", "error", "-i", str(src), "-vf", f"select=eq(n\\,{fr})",
                "-frames:v", "1", str(wd / f"{tag}_peak{i}.png")])
        r = sh([FFMPEG, "-i", str(wd / f"v2_peak{i}.png"), "-i", str(wd / f"v3_peak{i}.png"),
                "-lavfi", "ssim", "-f", "null", "-"])
        m = re.search(r"All:([\d.]+)", r.stderr)
        peak_ssim.append(float(m[1]) if m else None)

    # blind quality: peak stills + full clips
    import random
    assign = ["v2", "v3"]; random.Random(9090).shuffle(assign)
    mapping = {"A": assign[0], "B": assign[1]}
    (wd / "perf_blind_map.json").write_text(json.dumps(mapping))
    for L, tag in mapping.items():
        (wd / f"BLIND_{L}_full.mp4").write_bytes((wd / f"{tag}_full.mp4").read_bytes())
        for i, fr in enumerate(peaks):
            (wd / f"BLIND_{L}_peak{i}.png").write_bytes((wd / f"{tag}_peak{i}.png").read_bytes())

    def pct(a, b): return f"{100*a/b:.1f}%"
    print("\n==================== PHASE 6 STANDALONE PERF GATE ====================")
    print(f"input: 21.4s 1080p30 dashboard, 3 zooms (KPI/chart/table), bubble br + watermark tr")
    print(f"\nWALL-TIME (median of {args.runs}):  V2 {v2_real:.2f}s   V3 {v3_real:.2f}s   "
          f"V3 = {pct(v3_real, v2_real)} of V2   [bar: <=60% pass, 60-100% judge, >=100% fail]")
    print(f"CPU-TIME  (user+sys):        V2 {v2_cpu:.2f}s   V3 {v3_cpu:.2f}s   "
          f"V3 = {pct(v3_cpu, v2_cpu)} of V2   [bar: <=60%]")
    print("\nTRIPWIRES:")
    for label, a in (("V2", a2), ("V3", a3)):
        print(f"  {label} atoms: pix={a['pix_fmt']} space={a.get('color_space')} "
              f"prim={a.get('color_primaries')} trc={a.get('color_transfer')} frames={a['nb_read_frames']}")
    print(f"  frame count match: {a2['nb_read_frames'] == a3['nb_read_frames']}")
    print(f"  bubble box dE {diff['regions']['bubble']['de00_mean']:.2f} (floor ~1.1)   "
          f"watermark box dE {diff['regions']['watermark']['de00_mean']:.2f} (floor ~0.55)")
    print(f"  zoom-peak whole-frame SSIM (geometry parity): "
          f"{['%.4f' % s for s in peak_ssim]}")
    print(f"\nblind quality stills: {wd}/BLIND_A_peak[0-2].png  {wd}/BLIND_B_peak[0-2].png")
    print(f"blind quality clips:  {wd}/BLIND_A_full.mp4  {wd}/BLIND_B_full.mp4  (map: perf_blind_map.json)")
    (wd / "perf_result.json").write_text(json.dumps(
        {"v2_real": v2_real, "v3_real": v3_real, "v2_cpu": v2_cpu, "v3_cpu": v3_cpu,
         "atoms": {"v2": a2, "v3": a3}, "bbox": diff["regions"], "peak_ssim": peak_ssim}, indent=2))


if __name__ == "__main__":
    main()
