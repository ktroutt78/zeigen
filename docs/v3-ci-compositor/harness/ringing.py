#!/usr/bin/env python3
"""Objective ringing measurement (overshoot/undershoot adjacent to hard edges).

Raw edge energy (Laplacian) CANNOT tell ringing from sharpness: ringing halos ADD
edge energy, so a rougher, ringy image scores as "equally sharp". This measures the
thing the eye reacts to instead — the Gibbs-style over/undershoot right next to a
high-contrast step:

  for each strong step edge, take the two plateaus a few px on either side, then
  measure how far the pixels immediately adjacent to the edge shoot PAST those
  plateaus (brighter than the bright side / darker than the dark side), normalized
  by the step height. A clean monotone edge -> ~0. Lanczos/bicubic ringing -> > 0.

Reported per image; scan rows and columns. Higher = more ringing.
"""
import sys
import numpy as np
from PIL import Image


def ringing_1d(lines, step_min=28):
    overs = []
    for row in lines:
        d = np.diff(row)
        idx = np.where(np.abs(d) > step_min)[0]
        for i in idx:
            if i < 8 or i > len(row) - 9:
                continue
            lo_p = np.median(row[i - 7:i - 2])
            hi_p = np.median(row[i + 3:i + 8])
            lo, hi = min(lo_p, hi_p), max(lo_p, hi_p)
            step = hi - lo
            if step < step_min:
                continue
            near = row[i - 2:i + 4]  # pixels straddling the edge
            over = max(0.0, float(near.max()) - hi)   # overshoot past bright plateau
            under = max(0.0, lo - float(near.min()))  # undershoot past dark plateau
            overs.append((over + under) / step)
    return overs


def measure(path):
    a = np.asarray(Image.open(path).convert("L"), float)
    overs = ringing_1d(a[::3]) + ringing_1d(a.T[::3])
    if not overs:
        return 0.0, 0.0, 0
    o = np.array(overs)
    return float(o.mean()), float(np.percentile(o, 95)), len(o)


if __name__ == "__main__":
    print(f"{'image':16} {'ring_mean':>10} {'ring_p95':>10} {'n_edges':>8}")
    for p in sys.argv[1:]:
        m, p95, n = measure(p)
        label = p.split("/")[-1]
        print(f"{label:16} {m:10.4f} {p95:10.4f} {n:8d}")
