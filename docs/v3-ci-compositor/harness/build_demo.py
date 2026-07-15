#!/usr/bin/env python3
"""Phase 0 demonstration driver for the V3 validation harness.

Injects KNOWN faults into a real recording and shows what the harness catches and
what it cannot. There is no V3 renderer yet, so we prove the tripwire by mutating a
V2-style encode with faults that mimic the actual V3 fat-tail failure modes:

  color   : luma range mis-handling (tv/pc) -- the insidious color break
  geom    : ~0.8% scale/shift -- a registration / geometry error
  ovshift : an overlay displaced 8x5 px -- per-overlay parity break
  soft    : mild gaussian blur -- one half of the "different, not clearly
  sharp   : mild unsharp       -- worse/better" pair: the harness's blind spot
  ref2    : a second identical encode -- the encoder NOISE FLOOR to calibrate against

Plus two synthetic pans (quantized integer-step vs 4x-oversampled sub-pixel, i.e.
exactly V2's stutter and V2's fix) for the temporal probe.

Usage: build_demo.py --recording <mp4> --workdir <dir>
"""
import argparse
import json
import subprocess
from pathlib import Path

FFMPEG = "/opt/homebrew/bin/ffmpeg"
FFPROBE = "/opt/homebrew/bin/ffprobe"
HERE = Path(__file__).parent

VT =["-c:v", "h264_videotoolbox", "-b:v", "8M", "-profile:v", "high",
      "-pix_fmt", "yuv420p", "-tag:v", "avc1", "-allow_sw", "1",
      "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709"]

# overlay marker box (content-anchored region under test) and a control region
BOX = (1400, 200, 220, 130)          # x, y, w, h
BOX_SHIFT = (1408, 205, 220, 130)    # +8, +5
CTRL = (120, 820, 220, 130)          # identical in both -> must stay at floor


def sh(cmd):
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        print("CMD FAILED:", " ".join(str(c) for c in cmd))
        print(r.stderr[-600:])
        raise SystemExit(1)
    return r


def ff(args_in, vf, out, extra=None):
    cmd = [FFMPEG, "-y", *args_in, "-vf", vf, *(extra or VT),
           "-an", "-r", "30", str(out)]
    sh(cmd)


def make_artifacts(recording, wd):
    src = wd / "src6.mp4"
    # deterministic libx264 source so every variant derives from identical pixels
    sh([FFMPEG, "-y", "-ss", "5", "-t", "6", "-i", recording,
        "-vf", "scale=1920:1080:flags=lanczos,fps=30", "-c:v", "libx264",
        "-crf", "16", "-pix_fmt", "yuv420p", "-an", str(src)])
    S = ["-i", str(src)]

    ff(S, "null", wd / "ref.mp4")
    ff(S, "null", wd / "ref2.mp4")
    # luma range mishandling: expand limited 16-235 as if it were full 0-255
    ff(S, "lutyuv=y=(val-16)*255/219", wd / "fault_color.mp4")
    ff(S, "scale=iw*1.008:ih*1.008:flags=lanczos,crop=1920:1080", wd / "fault_geom.mp4")
    ff(S, "gblur=sigma=0.7", wd / "fault_soft.mp4")
    ff(S, "unsharp=5:5:0.8:5:5:0.0", wd / "fault_sharp.mp4")
    bx = "drawbox=x={0}:y={1}:w={2}:h={3}:color=red@1.0:t=fill"
    ff(S, bx.format(*BOX), wd / "ref_ov.mp4")
    ff(S, bx.format(*BOX_SHIFT), wd / "fault_ovshift.mp4")

    # synthetic pans for the temporal probe (0.6 output-px/frame, 60 frames)
    still = wd / "still.png"
    sh([FFMPEG, "-y", "-ss", "3", "-i", recording, "-frames:v", "1",
        "-vf", "scale=1600:900:flags=lanczos", str(still)])
    still4 = wd / "still4.png"
    sh([FFMPEG, "-y", "-i", str(still), "-vf", "scale=6400:3600:flags=lanczos", str(still4)])
    # quantized: crop truncates the fractional offset to integer -> staircase
    sh([FFMPEG, "-y", "-loop", "1", "-i", str(still), "-frames:v", "60",
        "-vf", "crop=1280:720:x='0.6*n':y=0", "-c:v", "libx264", "-crf", "12",
        "-pix_fmt", "yuv420p", "-r", "30", str(wd / "pan_quantized.mp4")])
    # smooth: 4x oversample -> integer step on 4x canvas = 0.25 px on output
    sh([FFMPEG, "-y", "-loop", "1", "-i", str(still4), "-frames:v", "60",
        "-vf", "crop=5120:2880:x='2.4*n':y=0,scale=1280:720:flags=lanczos",
        "-c:v", "libx264", "-crf", "12", "-pix_fmt", "yuv420p", "-r", "30",
        str(wd / "pan_smooth.mp4")])


def spatial(py, wd, ref, test, regions=None):
    cmd = [py, str(HERE / "spatial_diff.py"), "--ref", str(wd / ref),
           "--test", str(wd / test), "--fps", "3"]
    for label, box in (regions or {}).items():
        cmd += ["--region", f"{label}:{box[0]},{box[1]},{box[2]},{box[3]}"]
    return json.loads(subprocess.run(cmd, capture_output=True, text=True).stdout)


def temporal(py, wd, video):
    cmd = [py, str(HERE / "temporal_probe.py"), "--video", str(wd / video),
           "--crop", "200,150,900,450"]
    return json.loads(subprocess.run(cmd, capture_output=True, text=True).stdout)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--recording", required=True)
    ap.add_argument("--workdir", required=True)
    ap.add_argument("--python", required=True, help="venv python with numpy+pillow")
    ap.add_argument("--skip-build", action="store_true")
    args = ap.parse_args()
    wd = Path(args.workdir)
    wd.mkdir(parents=True, exist_ok=True)
    if not args.skip_build:
        make_artifacts(args.recording, wd)

    floor = spatial(args.python, wd, "ref.mp4", "ref2.mp4")
    results = {
        "floor": floor,
        "color": spatial(args.python, wd, "ref.mp4", "fault_color.mp4"),
        "geom": spatial(args.python, wd, "ref.mp4", "fault_geom.mp4"),
        "soft": spatial(args.python, wd, "ref.mp4", "fault_soft.mp4"),
        "sharp": spatial(args.python, wd, "ref.mp4", "fault_sharp.mp4"),
        "ovshift": spatial(args.python, wd, "ref_ov.mp4", "fault_ovshift.mp4",
                           {"box": BOX, "ctrl": CTRL}),
    }
    temporal_res = {
        "quantized": temporal(args.python, wd, "pan_quantized.mp4"),
        "smooth": temporal(args.python, wd, "pan_smooth.mp4"),
    }
    (wd / "results.json").write_text(json.dumps(
        {"spatial": results, "temporal": temporal_res}, indent=2))

    def g(r):
        return (r["global"]["ssim"]["all"], r["global"]["psnr"]["y"],
                r["global"]["psnr"]["u"], r["global"]["psnr"]["v"],
                r["global"]["de00_mean"], r["global"]["de00_p95"])

    print("\n==================== SPATIAL DIFF ====================")
    print(f"{'case':10} {'SSIM':>7} {'PSNR-Y':>7} {'PSNR-U':>7} {'PSNR-V':>7} "
          f"{'dE mean':>8} {'dE p95':>7}")
    for name in ("floor", "color", "geom", "soft", "sharp"):
        s = g(results[name])
        print(f"{name:10} {s[0]:7.4f} {s[1]:7.2f} {s[2]:7.2f} {s[3]:7.2f} "
              f"{s[4]:8.3f} {s[5]:7.3f}")
    fs = results["floor"]["signalstats"]
    cs = results["color"]["signalstats"]
    print(f"\nsignalstats YAVG  ref={fs['ref']['YAVG']:.1f}  "
          f"floor-test={fs['test']['YAVG']:.1f}  color-test={cs['test']['YAVG']:.1f}  "
          f"(YMIN {cs['ref']['YMIN']:.0f}->{cs['test']['YMIN']:.0f}, "
          f"YMAX {cs['ref']['YMAX']:.0f}->{cs['test']['YMAX']:.0f})")

    print("\n----- overlay shift (needs REGION diff; global misses it) -----")
    ov = results["ovshift"]
    print(f"global SSIM {ov['global']['ssim']['all']:.4f}  "
          f"| box-region SSIM {ov['regions']['box']['ssim']:.4f} "
          f"dE {ov['regions']['box']['de00_mean']:.2f}  "
          f"| ctrl-region SSIM {ov['regions']['ctrl']['ssim']:.4f} "
          f"dE {ov['regions']['ctrl']['de00_mean']:.2f}")

    print("\n==================== TEMPORAL PROBE ====================")
    print(f"{'pan':10} {'vel_mean':>9} {'jerk_rms':>9} {'jerk_max':>9} {'quant_frac':>11}")
    for name in ("quantized", "smooth"):
        t = temporal_res[name]
        print(f"{name:10} {t['velocity_mean']:9.3f} {t['jerk_rms']:9.4f} "
              f"{t['jerk_max']:9.4f} {t['quant_fraction']:11.3f}")
    print("\nwrote", wd / "results.json")


if __name__ == "__main__":
    main()
