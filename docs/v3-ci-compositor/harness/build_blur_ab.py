#!/usr/bin/env python3
"""Phase 5 motion-blur A/B (eye judgment — the harness cannot rank aesthetics).

On a realistic punch-in (0.6s ramp to 2x, off-center, hold, 0.6s out), render:
  V2 (ffmpeg 4x oversample+zoompan) — the current daily driver, no motion blur
  V3 no-blur                        — Phase 2 zoom
  V3 blur: subtle / medium / strong — radius = floor + k*|v|, CIZoomBlur

so the owner can see whether motion blur reads as "expensive" or just "blurry".
"""
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from build_zoom_ab import render_v2  # noqa: E402

PUNCH = {"start": 1.0, "end": 4.0, "scale": 2.0, "ramp": 0.6, "cx_px": 0.66 * 1920, "cy_px": 0.42 * 1080}
STRENGTHS = {
    "subtle": {"BLUR_FLOOR": "1.0", "BLUR_K": "0.12", "BLUR_MAX": "22"},
    "medium": {"BLUR_FLOOR": "1.5", "BLUR_K": "0.25", "BLUR_MAX": "48"},
    "strong": {"BLUR_FLOOR": "2.0", "BLUR_K": "0.45", "BLUR_MAX": "95"},
}


def main():
    import argparse, os
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True)
    ap.add_argument("--workdir", required=True)
    ap.add_argument("--compositor", required=True)
    args = ap.parse_args()
    wd = Path(args.workdir); wd.mkdir(parents=True, exist_ok=True)

    print("V2 (ffmpeg 4x, no blur)...")
    render_v2(args.src, wd / "punch_v2.mp4", PUNCH, 4)

    print("V3 no-blur...")
    subprocess.run([args.compositor, str(args.src), str(wd / "punch_v3_noblur.mp4"), "punch"], check=True)

    for name, env in STRENGTHS.items():
        print(f"V3 blur {name}...")
        e = {**os.environ, "BLUR": "on", **env}
        subprocess.run([args.compositor, str(args.src), str(wd / f"punch_v3_{name}.mp4"), "punch"],
                       check=True, env=e)

    print("\nfiles for eyeball A/B (open in QuickTime):")
    for f in ("punch_v2", "punch_v3_noblur", "punch_v3_subtle", "punch_v3_medium", "punch_v3_strong"):
        print("  ", wd / f"{f}.mp4")


if __name__ == "__main__":
    main()
