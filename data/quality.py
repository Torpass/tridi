"""How good is a PoseClip, with no ground truth? The quality card of the test set (docs/plan-v2.md, pillar B).

    uv run --project data python -m data.quality data/clips/<clip>.json [more.json ...] [--save <label>]

The test set is mostly videos from the internet (dances, people washing dishes, walking, running),
so there is no motion capture to compare with. What a real human body cannot do is the reference:

    valid       share of frames where the person was really detected (not interpolated)
    jitter      p95 acceleration of the knees and ankles (m/s²): MediaPipe's per-frame noise
    slide       median horizontal speed of the planted foot (m/s): a planted foot does not move
    sink        p95 depth of the lowest foot below the clip's floor (cm): feet do not go into the floor
    bones       mean coefficient of variation of thigh, shin, upper arm and forearm lengths (%):
                bones do not stretch
    height      estimated standing height (m): MediaPipe runs 10-20 % short (data/README.md)

Every change to the capture (pillar B) is run on the whole set and compared with --save rows in
data/set-de-prueba/quality.csv, so "better tracking" is a number, not an impression.
"""

from __future__ import annotations

import argparse
import csv
import time
from pathlib import Path

import numpy as np

from .jitter import FEET, gait, load

OUT = Path(__file__).parent / "set-de-prueba" / "quality.csv"
# MediaPipe indices: (from, to) of each bone, both sides.
BONES = {"thigh": ((23, 25), (24, 26)), "shin": ((25, 27), (26, 28)), "upper_arm": ((11, 13), (12, 14)),
         "forearm": ((13, 15), (14, 16))}
COLUMNS = ["valid", "jitter", "slide", "sink", "bones", "height"]


def card(path: Path) -> dict[str, float]:
    joints, fps, valid = load(path)
    v = np.diff(joints, axis=0) * fps
    a = np.diff(v, axis=0) * fps
    legs = np.linalg.norm(a[:, [25, 26, 27, 28]], axis=-1)
    feet = np.stack([joints[:, list(idx)] for idx in FEET], axis=1)
    lowest = feet[..., 1].min(axis=(1, 2))  # [F] the lowest foot point (y up)
    # The floor: the height the lowest foot comes back to most, the 10th percentile (feet rest on it
    # in most frames; the deepest 10 % are what sinks).
    floor = np.percentile(lowest, 10)
    lengths = []
    for pairs in BONES.values():
        for i, j in pairs:
            n = np.linalg.norm(joints[:, i] - joints[:, j], axis=-1)
            lengths.append(np.std(n) / max(np.mean(n), 1e-6))
    # Height: ankle to the top of the head is not in MediaPipe's 33; nose to the floor plus ~10 cm
    # (nose to the crown of an adult head), taken where the person stands tallest (p90).
    nose = joints[:, 0, 1] - floor
    return {"valid": valid, "jitter": float(np.percentile(legs, 95)), "slide": gait(joints, fps)["stance_slide"],
            "sink": float(100 * np.percentile(np.maximum(0, floor - lowest), 95)), "bones": float(100 * np.mean(lengths)),
            "height": float(np.percentile(nose, 90) + 0.10)}


def main() -> None:
    p = argparse.ArgumentParser(prog="python -m data.quality", description=__doc__.split("\n")[0])
    p.add_argument("clips", nargs="+", type=Path)
    p.add_argument("--save", help="label of this capture version (e.g. mediapipe-2026-11): appends to quality.csv")
    args = p.parse_args()
    print(f"{'clip':44s} {'valid':>6} {'jitter':>7} {'slide':>6} {'sink':>5} {'bones':>6} {'height':>6}")
    rows = []
    for path in args.clips:
        c = card(path)
        rows.append((path.stem, c))
        print(f"{path.stem[:44]:44s} {c['valid']:6.0%} {c['jitter']:7.1f} {c['slide']:6.2f} {c['sink']:5.1f} "
              f"{c['bones']:5.1f}% {c['height']:6.2f}")
    if args.save:
        OUT.parent.mkdir(parents=True, exist_ok=True)
        new = not OUT.exists()
        with open(OUT, "a", newline="") as f:
            w = csv.writer(f)
            if new:
                w.writerow(["date", "capture", "clip", *COLUMNS])
            for name, c in rows:
                w.writerow([time.strftime("%Y-%m-%d"), args.save, name, *(round(c[k], 4) for k in COLUMNS)])
        print(f"-> {OUT}")


if __name__ == "__main__":
    main()
