#!/usr/bin/env python3
"""Temporal smoothness probe for the V3 harness.

Recovers per-frame pan translation from the RENDERED output via FFT phase
correlation (sub-pixel, parabolic peak fit), then reports the smoothness
signature of the motion:

  - velocity      : per-frame |shift| in output px
  - jerk          : frame-to-frame change in velocity (RMS + max)
  - quant_fraction: fraction of frames whose recovered shift sits within 0.12 px
                    of an integer — the fingerprint of integer-pixel quantization
                    (V2's zoompan s/4 stepping) vs continuous sub-pixel motion.

This measures the actual pixels that were encoded, not the transform model. It is
the one part of "buttery" that can be judged objectively: a quantized pan shows a
staircase (jerk spikes, high quant_fraction); a smooth sub-pixel pan is flat.

Usage:
  temporal_probe.py --video pan.mp4 [--crop x,y,w,h] [--max-frames 120] [--json out]
"""
import argparse
import json
import subprocess
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image

FFMPEG = "/opt/homebrew/bin/ffmpeg"


def extract_gray(path, crop, max_frames, outdir):
    vf = "format=gray"
    if crop:
        x, y, w, h = crop
        vf = f"crop={w}:{h}:{x}:{y},format=gray"
    subprocess.run([FFMPEG, "-i", path, "-vf", vf, "-vsync", "0",
                    "-frames:v", str(max_frames), str(Path(outdir) / "g%05d.png")],
                   capture_output=True, text=True)
    frames = sorted(Path(outdir).glob("g*.png"))
    return [np.asarray(Image.open(p), dtype=np.float64) for p in frames]


def phase_corr(a, b):
    """Sub-pixel translation (dy, dx) that maps a -> b via phase correlation."""
    win = np.outer(np.hanning(a.shape[0]), np.hanning(a.shape[1]))
    Fa = np.fft.fft2(a * win)
    Fb = np.fft.fft2(b * win)
    R = Fa * np.conj(Fb)
    R /= np.abs(R) + 1e-8
    r = np.fft.ifft2(R).real
    py, px = np.unravel_index(np.argmax(r), r.shape)

    def subpix(vm1, v0, vp1):
        d = vm1 - 2 * v0 + vp1
        return 0.0 if d == 0 else 0.5 * (vm1 - vp1) / d

    H, W = r.shape
    dy = py + subpix(r[(py - 1) % H, px], r[py, px], r[(py + 1) % H, px])
    dx = px + subpix(r[py, (px - 1) % W], r[py, px], r[py, (px + 1) % W])
    if dy > H / 2:
        dy -= H
    if dx > W / 2:
        dx -= W
    return dy, dx


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--video", required=True)
    ap.add_argument("--crop", help="x,y,w,h region to track (default: full frame)")
    ap.add_argument("--max-frames", type=int, default=120)
    ap.add_argument("--json")
    args = ap.parse_args()
    crop = tuple(int(v) for v in args.crop.split(",")) if args.crop else None

    with tempfile.TemporaryDirectory() as d:
        frames = extract_gray(args.video, crop, args.max_frames, d)
    if len(frames) < 3:
        print(json.dumps({"error": f"only {len(frames)} frames"}))
        return

    shifts = [phase_corr(frames[i], frames[i + 1]) for i in range(len(frames) - 1)]
    vel = np.array([np.hypot(dy, dx) for dy, dx in shifts])
    jerk = np.diff(vel)
    # distance of each recovered shift component from the nearest integer
    comps = np.array([c for s in shifts for c in s])
    frac_from_int = np.abs(comps - np.round(comps))
    quant_fraction = float(np.mean(frac_from_int < 0.12))

    result = {
        "video": args.video,
        "frames": len(frames),
        "velocity_mean": float(vel.mean()),
        "velocity_max": float(vel.max()),
        "jerk_rms": float(np.sqrt(np.mean(jerk ** 2))),
        "jerk_max": float(np.max(np.abs(jerk))),
        "quant_fraction": quant_fraction,
        "shifts": [[round(dy, 3), round(dx, 3)] for dy, dx in shifts],
    }
    print(json.dumps(result, indent=2))
    if args.json:
        Path(args.json).write_text(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
