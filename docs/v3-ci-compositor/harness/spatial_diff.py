#!/usr/bin/env python3
"""Spatial correctness diff between two same-resolution videos (V3 harness).

Measures, for a matched pair (ref vs test):
  - global SSIM + per-channel (Y/U/V) PSNR via ffmpeg's own filters
  - global perceptual color error (CIEDE2000 mean / p95) on sampled frames
  - per-region SSIM + PSNR + CIEDE2000 for named overlay bounding boxes
  - signalstats luma/chroma averages (a color range / matrix-tag break detector)

This tool MEASURES; it does not judge. Calibration and pass/fail verdicts live in
the driver (build_demo.py), which compares these numbers against a noise floor.

Usage:
  spatial_diff.py --ref A.mp4 --test B.mp4 \
      [--region label:x,y,w,h ...] [--fps 2] [--json out.json]
"""
import argparse
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image

FFMPEG = "/opt/homebrew/bin/ffmpeg"
FFPROBE = "/opt/homebrew/bin/ffprobe"


def run(cmd):
    return subprocess.run(cmd, capture_output=True, text=True)


def probe_res(path):
    out = run([FFPROBE, "-v", "error", "-select_streams", "v:0",
               "-show_entries", "stream=width,height,nb_read_frames",
               "-of", "json", "-count_frames", path])
    info = json.loads(out.stdout)["streams"][0]
    return int(info["width"]), int(info["height"]), int(info.get("nb_read_frames", 0))


def ffmpeg_ssim(ref, test):
    r = run([FFMPEG, "-i", ref, "-i", test, "-lavfi", "[0:v][1:v]ssim", "-f", "null", "-"])
    m = re.search(r"SSIM.*?Y:([\d.]+).*?U:([\d.]+).*?V:([\d.]+).*?All:([\d.]+)", r.stderr)
    if not m:
        return {"error": "ssim parse failed", "stderr_tail": r.stderr[-400:]}
    return {"y": float(m[1]), "u": float(m[2]), "v": float(m[3]), "all": float(m[4])}


def ffmpeg_psnr(ref, test):
    r = run([FFMPEG, "-i", ref, "-i", test, "-lavfi", "[0:v][1:v]psnr", "-f", "null", "-"])
    m = re.search(r"PSNR.*?y:([\d.inf]+).*?u:([\d.inf]+).*?v:([\d.inf]+).*?average:([\d.inf]+)",
                  r.stderr)
    if not m:
        return {"error": "psnr parse failed", "stderr_tail": r.stderr[-400:]}
    f = lambda s: float("inf") if s == "inf" else float(s)
    return {"y": f(m[1]), "u": f(m[2]), "v": f(m[3]), "average": f(m[4])}


def signalstats(path, fps):
    """Mean luma/chroma over sampled frames. A range (tv/pc) or matrix-tag break
    shifts these even when structure (SSIM) is untouched."""
    r = run([FFMPEG, "-i", path, "-vf", f"fps={fps},signalstats,metadata=print",
             "-f", "null", "-"])
    acc = {k: [] for k in ("YAVG", "UAVG", "VAVG", "YMIN", "YMAX")}
    for key in acc:
        for m in re.finditer(rf"lavfi\.signalstats\.{key}=([\d.]+)", r.stderr):
            acc[key].append(float(m[1]))
    return {k: (sum(v) / len(v) if v else None) for k, v in acc.items()}


def extract_frames(path, fps, outdir):
    run([FFMPEG, "-i", path, "-vf", f"fps={fps}", "-vsync", "0",
         str(Path(outdir) / "f%05d.png")])
    return sorted(Path(outdir).glob("f*.png"))


def load_rgb(png):
    return np.asarray(Image.open(png).convert("RGB"), dtype=np.float64) / 255.0


# --- sRGB -> CIE Lab (D65) ---
def srgb_to_lab(rgb):
    a = np.where(rgb <= 0.04045, rgb / 12.92, ((rgb + 0.055) / 1.055) ** 2.4)
    m = np.array([[0.4124564, 0.3575761, 0.1804375],
                  [0.2126729, 0.7151522, 0.0721750],
                  [0.0193339, 0.1191920, 0.9503041]])
    xyz = a @ m.T
    white = np.array([0.95047, 1.0, 1.08883])
    xyz = xyz / white
    e, k = 216 / 24389, 24389 / 27
    fx = np.where(xyz > e, np.cbrt(xyz), (k * xyz + 16) / 116)
    L = 116 * fx[..., 1] - 16
    A = 500 * (fx[..., 0] - fx[..., 1])
    B = 200 * (fx[..., 1] - fx[..., 2])
    return np.stack([L, A, B], axis=-1)


def ciede2000(lab1, lab2):
    L1, a1, b1 = lab1[..., 0], lab1[..., 1], lab1[..., 2]
    L2, a2, b2 = lab2[..., 0], lab2[..., 1], lab2[..., 2]
    C1 = np.hypot(a1, b1)
    C2 = np.hypot(a2, b2)
    Cbar = (C1 + C2) / 2
    G = 0.5 * (1 - np.sqrt(Cbar ** 7 / (Cbar ** 7 + 25.0 ** 7)))
    a1p, a2p = (1 + G) * a1, (1 + G) * a2
    C1p, C2p = np.hypot(a1p, b1), np.hypot(a2p, b2)
    h1p = np.degrees(np.arctan2(b1, a1p)) % 360
    h2p = np.degrees(np.arctan2(b2, a2p)) % 360
    dLp = L2 - L1
    dCp = C2p - C1p
    dhp = h2p - h1p
    dhp = np.where(dhp > 180, dhp - 360, dhp)
    dhp = np.where(dhp < -180, dhp + 360, dhp)
    dHp = 2 * np.sqrt(C1p * C2p) * np.sin(np.radians(dhp) / 2)
    Lbar = (L1 + L2) / 2
    Cbarp = (C1p + C2p) / 2
    hsum = h1p + h2p
    hbar = np.where(np.abs(h1p - h2p) > 180, (hsum + 360) / 2, hsum / 2)
    hbar = np.where((C1p * C2p) == 0, hsum, hbar)
    T = (1 - 0.17 * np.cos(np.radians(hbar - 30))
         + 0.24 * np.cos(np.radians(2 * hbar))
         + 0.32 * np.cos(np.radians(3 * hbar + 6))
         - 0.20 * np.cos(np.radians(4 * hbar - 63)))
    dTheta = 30 * np.exp(-(((hbar - 275) / 25) ** 2))
    Rc = 2 * np.sqrt(Cbarp ** 7 / (Cbarp ** 7 + 25.0 ** 7))
    Sl = 1 + (0.015 * (Lbar - 50) ** 2) / np.sqrt(20 + (Lbar - 50) ** 2)
    Sc = 1 + 0.045 * Cbarp
    Sh = 1 + 0.015 * Cbarp * T
    Rt = -np.sin(np.radians(2 * dTheta)) * Rc
    return np.sqrt((dLp / Sl) ** 2 + (dCp / Sc) ** 2 + (dHp / Sh) ** 2
                   + Rt * (dCp / Sc) * (dHp / Sh))


# --- box-filter SSIM via integral images (no scipy) ---
def _integral(x):
    return np.pad(np.cumsum(np.cumsum(x, 0), 1), ((1, 0), (1, 0)))


def _boxsum(ii, w):
    return (ii[w:, w:] - ii[:-w, w:] - ii[w:, :-w] + ii[:-w, :-w])


def box_ssim(a, b, win=7):
    """Mean SSIM over a `win`x`win` sliding box. a,b are 2D float [0,1]."""
    C1, C2 = 0.01 ** 2, 0.03 ** 2
    n = win * win
    mu_a = _boxsum(_integral(a), win) / n
    mu_b = _boxsum(_integral(b), win) / n
    va = _boxsum(_integral(a * a), win) / n - mu_a ** 2
    vb = _boxsum(_integral(b * b), win) / n - mu_b ** 2
    vab = _boxsum(_integral(a * b), win) / n - mu_a * mu_b
    ssim = ((2 * mu_a * mu_b + C1) * (2 * vab + C2)) / \
           ((mu_a ** 2 + mu_b ** 2 + C1) * (va + vb + C2))
    return float(np.clip(ssim, -1, 1).mean())


def rgb_to_gray(rgb):
    return rgb @ np.array([0.2126, 0.7152, 0.0722])


def region_metrics(ref_frames, test_frames, regions):
    out = {}
    for label, (x, y, w, h) in regions.items():
        ss, ps, de = [], [], []
        for rf, tf in zip(ref_frames, test_frames):
            r = rf[y:y + h, x:x + w]
            t = tf[y:y + h, x:x + w]
            ss.append(box_ssim(rgb_to_gray(r), rgb_to_gray(t)))
            mse = np.mean((r - t) ** 2)
            ps.append(float("inf") if mse == 0 else 10 * np.log10(1.0 / mse))
            de.append(float(ciede2000(srgb_to_lab(r), srgb_to_lab(t)).mean()))
        out[label] = {"ssim": float(np.mean(ss)),
                      "psnr": float(np.mean([p for p in ps if p != float("inf")] or [99.0])),
                      "de00_mean": float(np.mean(de))}
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ref", required=True)
    ap.add_argument("--test", required=True)
    ap.add_argument("--region", action="append", default=[],
                    help="label:x,y,w,h (repeatable)")
    ap.add_argument("--fps", type=float, default=2.0)
    ap.add_argument("--json")
    args = ap.parse_args()

    regions = {}
    for spec in args.region:
        label, box = spec.split(":")
        regions[label] = tuple(int(v) for v in box.split(","))

    rw, rh, rn = probe_res(args.ref)
    tw, th, tn = probe_res(args.test)
    result = {"ref": args.ref, "test": args.test,
              "res": [rw, rh], "res_match": (rw, rh) == (tw, th),
              "global": {}, "signalstats": {}, "regions": {}}
    if (rw, rh) != (tw, th):
        result["error"] = f"resolution mismatch {rw}x{rh} vs {tw}x{th}"
        print(json.dumps(result, indent=2))
        sys.exit(1)

    result["global"]["ssim"] = ffmpeg_ssim(args.ref, args.test)
    result["global"]["psnr"] = ffmpeg_psnr(args.ref, args.test)
    result["signalstats"] = {"ref": signalstats(args.ref, args.fps),
                             "test": signalstats(args.test, args.fps)}

    with tempfile.TemporaryDirectory() as da, tempfile.TemporaryDirectory() as db:
        rfp = extract_frames(args.ref, args.fps, da)
        tfp = extract_frames(args.test, args.fps, db)
        pairs = min(len(rfp), len(tfp))
        ref_frames = [load_rgb(p) for p in rfp[:pairs]]
        test_frames = [load_rgb(p) for p in tfp[:pairs]]
        de = [float(ciede2000(srgb_to_lab(r), srgb_to_lab(t)).mean())
              for r, t in zip(ref_frames, test_frames)]
        de_p95 = [float(np.percentile(ciede2000(srgb_to_lab(r), srgb_to_lab(t)), 95))
                  for r, t in zip(ref_frames, test_frames)]
        result["global"]["de00_mean"] = float(np.mean(de))
        result["global"]["de00_p95"] = float(np.mean(de_p95))
        result["frames_compared"] = pairs
        if regions:
            result["regions"] = region_metrics(ref_frames, test_frames, regions)

    print(json.dumps(result, indent=2))
    if args.json:
        Path(args.json).write_text(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
