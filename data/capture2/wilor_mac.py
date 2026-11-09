"""Capture 2.0, hands: WiLoR on the Mac, from a video to the fingers of both hands (MANO), per frame.

Runs inside WiLoR's own environment, not data/'s:

    data/thirdparty/WiLoR/.venv/bin/python data/capture2/wilor_mac.py <video> [--device mps]

WiLoR (https://github.com/rolpotamias/WiLoR) finds the hands with its own YOLO detector and gives,
per hand, the MANO parameters: 15 finger joints (3 per finger) as rotations, the wrist's turn and the
hand's shape. GVHMR (gvhmr_mac.py) gives the body with stiff hands; these are the fingers that go
into its wrists (the fusion into PoseClip v2 comes after its contract, docs/plan-v2.md).

Its weights are non-commercial and no-derivatives (CC BY-NC-ND), and it needs MANO (non-commercial,
account at mano.is.tue.mpg.de): Juan accepted both for Tridi v2 as a playground (2026-11-04,
docs/plan-v2.md section 10). This file does not modify WiLoR: it imports it and picks the device.

Output: <video>.wilor.npz next to the video (or --out): for each side ("left", "right") and frame,
MANO global_orient [F, 3, 3], hand_pose [F, 15, 3, 3], betas [F, 10], the 21 3D keypoints in the
camera [F, 21, 3] (m), the detector's confidence [F] (0 = no hand that frame), plus fps. One hand
per side per frame: the most confident one (several people's hands are a fusion-step problem, where
GVHMR's wrists say which hand is the subject's).
"""

from __future__ import annotations

import argparse
import os
import sys
import time
from pathlib import Path

import numpy as np

WILOR = Path(os.environ.get("WILOR_ROOT", Path(__file__).resolve().parents[1] / "thirdparty" / "WiLoR"))
# The detector's own threshold in WiLoR's demo: below it, blurred hands in motion read as noise.
MIN_CONF = 0.3
# WiLoR's demo pads each hand's box by 2x so the crop keeps the whole hand when the box is tight.
RESCALE = 2.0
SIDES = ("left", "right")  # the detector's classes: 0 left, 1 right


def run(video: Path, out: Path, device: str, max_frames: int | None = None) -> Path:
    os.chdir(WILOR)  # WiLoR reads its configs and MANO files relative to its root
    sys.path.insert(0, str(WILOR))
    # WiLoR imports pyrender (drawing only) and asks it for Linux's headless EGL, which macOS lacks;
    # "darwin" lets the import through. The renderers its model builds for training previews are
    # switched off: nothing here draws.
    os.environ.setdefault("PYOPENGL_PLATFORM", "darwin")
    import cv2
    import torch
    import wilor.models.wilor as wilor_model
    from ultralytics import YOLO
    from wilor.datasets.vitdet_dataset import ViTDetDataset
    from wilor.models import load_wilor
    from wilor.utils import recursive_to
    from wilor.utils.renderer import cam_crop_to_full

    wilor_model.MeshRenderer = wilor_model.SkeletonRenderer = lambda *args, **kwargs: None

    model, cfg = load_wilor(checkpoint_path="./pretrained_models/wilor_final.ckpt", cfg_path="./pretrained_models/model_config.yaml")
    # WiLoR's own model on the CPU: on MPS (torch 2.3) it aborts in a slice ("subRange.start ... is
    # not less than length of dimension"), as GVHMR's did. The hand detector stays on the GPU.
    model = model.to("cpu").eval()
    detector = YOLO("./pretrained_models/detector.pt")

    cap = cv2.VideoCapture(str(video))
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    n = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    n = min(n, max_frames or n)
    res = {s: {"global_orient": np.tile(np.eye(3), (n, 1, 1)), "hand_pose": np.tile(np.eye(3), (n, 15, 1, 1)),
               "betas": np.zeros((n, 10)), "keypoints": np.zeros((n, 21, 3)), "conf": np.zeros(n)} for s in SIDES}
    start = time.time()
    for f in range(n):
        ok, img = cap.read()
        if not ok:
            break
        det = detector(img, conf=MIN_CONF, verbose=False, device=device)[0]
        best = {}
        for box, cls, conf in zip(det.boxes.xyxy.cpu().numpy(), det.boxes.cls.cpu().numpy(), det.boxes.conf.cpu().numpy()):
            side = int(cls)
            if conf > best.get(side, (None, 0))[1]:
                best[side] = (box, float(conf))
        if best:
            sides = sorted(best)
            data = ViTDetDataset(cfg, img, np.stack([best[s][0] for s in sides]), np.array(sides, float), rescale_factor=RESCALE)
            batch = torch.utils.data.default_collate([data[i] for i in range(len(data))])
            # The crops come with some float64 tensors (box centers, sizes): float32 as the model's.
            batch = recursive_to({k: v.float() if torch.is_tensor(v) and v.dtype == torch.float64 else v for k, v in batch.items()}, "cpu")
            with torch.no_grad():
                o = model(batch)
            # WiLoR predicts every hand as a right hand on a mirrored crop: a left one is mirrored back in x.
            cam = o["pred_cam"]
            cam[:, 1] = (2 * batch["right"] - 1) * cam[:, 1]
            size = batch["img_size"].float()
            focal = cfg.EXTRA.FOCAL_LENGTH / cfg.MODEL.IMAGE_SIZE * size.max()
            cam_t = cam_crop_to_full(cam, batch["box_center"].float(), batch["box_size"].float(), size, focal).cpu().numpy()
            for i, s in enumerate(sides):
                r = res[SIDES[s]]
                p = o["pred_mano_params"]
                r["global_orient"][f] = p["global_orient"][i].reshape(3, 3).cpu().numpy()
                r["hand_pose"][f] = p["hand_pose"][i].reshape(15, 3, 3).cpu().numpy()
                r["betas"][f] = p["betas"][i].cpu().numpy()
                k = o["pred_keypoints_3d"][i].cpu().numpy()
                k[:, 0] *= 2 * s - 1
                r["keypoints"][f] = k + cam_t[i]
                r["conf"][f] = best[s][1]
        if f % 30 == 0:
            print(f"\rhands: {f}/{n} frames ({time.time() - start:.0f} s)", end="", flush=True)
    seconds = time.time() - start
    np.savez_compressed(out, fps=fps, seconds=seconds, **{f"{s}_{k}": v for s in SIDES for k, v in res[s].items()})
    seen = {s: float((res[s]["conf"] > 0).mean()) for s in SIDES}
    print(f"\n{video.name}: {n} frames in {seconds:.0f} s; hands seen: left {seen['left']:.0%}, right {seen['right']:.0%} -> {out}")
    return out


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("video", type=Path)
    p.add_argument("--out", type=Path, help="default: <video>.wilor.npz")
    p.add_argument("--device", default=None, help="mps (default when available) or cpu")
    p.add_argument("--max-frames", type=int, help="only the first N frames (a quick test)")
    args = p.parse_args()
    import torch

    device = args.device or ("mps" if torch.backends.mps.is_available() else "cpu")
    video = args.video.resolve()
    run(video, (args.out or video.with_suffix(".wilor.npz")).resolve(), device, args.max_frames)


if __name__ == "__main__":
    main()
