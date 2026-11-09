"""Capture 2.0, body: GVHMR on the Mac (MPS), from a video to SMPL-X in the world.

Runs inside GVHMR's own environment, not data/'s (it pins torch 2.3 and needs pytorch3d):

    data/thirdparty/GVHMR/.venv/bin/python data/capture2/gvhmr_mac.py <video> [--static] [--f-mm 24]

GVHMR (https://github.com/zju3dv/GVHMR) recovers the person's body (SMPL-X) anchored to the world,
with gravity and a camera that may move, so walking toward the camera still advances (today's
data/lift.py gives ~0 m/s from the front, data/README.md). Its license is non-commercial and asks
that modifications of its code be published, so this file does not modify it: it imports it and
patches it from the outside for Apple Silicon:

- every `.cuda()` (tensors and modules) goes to MPS (or CPU), and YOLO's tracker gets that device;
  GVHMR's final model runs on the CPU (it aborts on MPS with torch 2.3);
- no DPVO (CUDA only): a moving camera uses GVHMR's SimpleVO (SIFT, CPU); --static skips it;
- no rendering (pytorch3d's renderer): Tridi only needs the parameters.

Output: <video>.gvhmr.npz next to the video (or --out): per frame, SMPL-X params in the world
(global_orient, body_pose, betas, transl) and in the camera, plus fps. data/capture2/README.md says
what is needed first (checkpoints, body models) and why.
"""

from __future__ import annotations

import argparse
import os
import sys
import time
from pathlib import Path

GVHMR = Path(os.environ.get("GVHMR_ROOT", Path(__file__).resolve().parents[1] / "thirdparty" / "GVHMR"))


def _patch_device(device: str) -> None:
    import torch

    def to_device(self, *args, **kwargs):  # .cuda(), .cuda(0), .cuda(non_blocking=True)
        return self.to(device)

    torch.Tensor.cuda = to_device
    torch.nn.Module.cuda = to_device
    # Lightning modules (HMR2, GVHMR's own) have their own .cuda(), which asks torch.cuda directly.
    from lightning_fabric.utilities.device_dtype_mixin import _DeviceDtypeModuleMixin

    _DeviceDtypeModuleMixin.cuda = to_device

    from hmr4d.utils.preproc import tracker

    original = tracker.Tracker.track

    def track(self, video_path):
        call = self.yolo.track

        def on_device(*args, **kwargs):
            kwargs["device"] = device
            return call(*args, **kwargs)

        self.yolo.track = on_device
        try:
            return original(self, video_path)
        finally:
            self.yolo.track = call

    tracker.Tracker.track = track


def run(video: Path, out: Path, static: bool, f_mm: int | None, device: str) -> Path:
    os.chdir(GVHMR)  # GVHMR reads its checkpoints and configs relative to its root
    sys.path.insert(0, str(GVHMR))
    _patch_device(device)

    import hydra
    import numpy as np
    import torch

    sys.argv = ["demo", "--video", str(video), "--output_root", str(out.parent / "gvhmr_work")]
    if static:
        sys.argv.append("--static_cam")
    if f_mm is not None:
        sys.argv += ["--f_mm", str(f_mm)]
    from tools.demo import demo

    cfg = demo.parse_args_to_cfg()
    start = time.time()
    demo.run_preprocess(cfg)
    data = demo.load_data_dict(cfg)
    # GVHMR's own model on the CPU: on MPS (torch 2.3) it aborts in a slice ("subRange.start +
    # subRange.length does not fit in dimension"). It is small (156 MB); the heavy ViT networks of
    # the preprocessing above stay on the GPU.
    _patch_device("cpu")
    model = hydra.utils.instantiate(cfg.model, _recursive_=False)
    model.load_pretrained_model(cfg.ckpt_path)
    model = model.eval().to("cpu")
    with torch.no_grad():
        pred = demo.detach_to_cpu(model.predict(data, static_cam=cfg.static_cam))
    seconds = time.time() - start

    arrays = {f"{space}_{k}": v.numpy() for space in ("global", "incam") for k, v in pred[f"smpl_params_{space}"].items()}
    import cv2

    fps = cv2.VideoCapture(str(video)).get(cv2.CAP_PROP_FPS) or 30.0  # GVHMR keeps every frame of the video
    np.savez_compressed(out, fps=fps, static_cam=static, seconds=seconds, **arrays)
    frames = int(data["length"])
    print(f"{video.name}: {frames} frames in {seconds:.0f} s ({frames / seconds:.1f} frames/s; preprocessing on {device}) -> {out}")
    return out


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("video", type=Path)
    p.add_argument("--out", type=Path, help="default: <video>.gvhmr.npz")
    p.add_argument("--static", action="store_true", help="the camera does not move (skips visual odometry)")
    p.add_argument("--f-mm", type=int, help="focal length in mm, 35 mm equivalent (iPhone 1x: 24)")
    p.add_argument("--device", default=None, help="mps (default when available) or cpu")
    args = p.parse_args()
    import torch

    device = args.device or ("mps" if torch.backends.mps.is_available() else "cpu")
    video = args.video.resolve()
    out = (args.out or video.with_suffix(".gvhmr.npz")).resolve()
    run(video, out, args.static, args.f_mm, device)


if __name__ == "__main__":
    main()
