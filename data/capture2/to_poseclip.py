"""GVHMR's SMPL-X (gvhmr_mac.py) + optional WiLoR hands (wilor_mac.py) -> PoseClip v2 (docs/contrato.md).

Runs in GVHMR's environment (needs smplx, scipy and torch):

    data/thirdparty/GVHMR/.venv/bin/python data/capture2/to_poseclip.py <video>.gvhmr.npz [--hands <video>.wilor.npz] [--out-dir DIR] [--raw]

Writes clip_<video>-gvhmr.json and .npz in --out-dir (default: a clips/ folder next to the .npz), as
docs/contrato.md's PoseClip v2: y up, z toward the camera, the first frame's hips at (0, 0, 0). Every
v1 field (the 33 MediaPipe points in `joints`) is kept so v1 readers work without changes; v2 adds:
- SMPL-X parameters in the contract's space (in the .npz: betas, transl, global_orient, body_pose,
  left_hand_pose, right_hand_pose) and `betas` in the JSON;
- 21 3D hand points per seen hand (`hands.left`, `hands.right` in the JSON; `hand_joints` [F, 2, 21, 3]
  and `hand_conf` [F, 2] in the .npz), matched to the subject's wrist in camera space;
- `contacts` (`left_foot`, `right_foot` in the JSON; `foot_contact` [F, 2] in the .npz).

When no `--hands` file is passed, `<video>.wilor.npz` is looked up next to `<video>.gvhmr.npz` and in
`hands/<video>.wilor.npz`. Without a hands file, `joints` is identical to the v1 bridge.

Two things differ from GVHMR's own world, and both are fixed here:
- Heading. GVHMR's world has gravity right but an arbitrary turn about the vertical (in our clips the
  person faced -z). The contract wants z toward the camera, so the clip is turned about y until the
  person's facing in the first frames matches their facing in the camera's view (GVHMR's in-camera
  output), as data/lift.py's clips are.
- Smoothing. data/lift.py smooths MediaPipe's points (body 0.4 s, trajectory 0.6 s, data/smooth.py);
  the same is done here so both captures are compared and retargeted alike. --raw skips it.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

# data/smooth.py only needs numpy, so it is imported straight from its folder (data/lift.py, and the
# data package, pull in MediaPipe, which GVHMR's environment does not have).
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from smooth import savgol, smooth_points  # noqa: E402

# The trajectory's own smoothing, the same as data/lift.py's ROOT_WINDOW_S and ROOT_ORDER (copied for
# the reason above; keep them equal).
ROOT_WINDOW_S = 0.6
ROOT_ORDER = 2

GVHMR = Path(__file__).resolve().parents[1] / "thirdparty" / "GVHMR"
SMPLX_DIR = GVHMR / "inputs" / "checkpoints" / "body_models"

# SMPL-X joint index (smplx library order, with its extra face and feet joints) for each of
# MediaPipe's 33 points. MediaPipe's "left" is the person's left, as SMPL-X's.
NOSE, R_EYE, L_EYE, R_EAR, L_EAR = 55, 56, 57, 58, 59
L_BIG_TOE, L_HEEL, R_BIG_TOE, R_HEEL = 60, 62, 63, 65
MEDIAPIPE_FROM_SMPLX = [
    NOSE,                                   # 0 nose
    L_EYE, L_EYE, L_EYE,                    # 1-3 left eye inner, eye, outer
    R_EYE, R_EYE, R_EYE,                    # 4-6 right eye inner, eye, outer
    L_EAR, R_EAR,                           # 7-8 ears
    NOSE, NOSE,                             # 9-10 mouth
    16, 17,                                 # 11-12 shoulders
    18, 19,                                 # 13-14 elbows
    20, 21,                                 # 15-16 wrists
    20, 21, 20, 21, 20, 21,                 # 17-22 pinky, index, thumb (the wrist when no hand model)
    1, 2,                                   # 23-24 hips
    4, 5,                                   # 25-26 knees
    7, 8,                                   # 27-28 ankles
    L_HEEL, R_HEEL,                         # 29-30 heels
    L_BIG_TOE, R_BIG_TOE,                   # 31-32 foot index (big toe)
]

# SMPL-X joint indices for the 21 hand landmarks per side (MediaPipe/MANO order:
# 0 wrist, 1-4 thumb, 5-8 index, 9-12 middle, 13-16 ring, 17-20 pinky).
SMPLX_HAND_JOINTS = {
    "left": [20, 37, 38, 39, 66, 25, 26, 27, 67, 28, 29, 30, 68, 34, 35, 36, 69, 31, 32, 33, 70],
    "right": [21, 52, 53, 54, 71, 40, 41, 42, 72, 43, 44, 45, 73, 49, 50, 51, 74, 46, 47, 48, 75],
}
# Parent chains from pelvis (0) to each elbow in SMPL-X, and the wrist's index in body_pose (joint - 1).
ARM_PARENTS = {"left": (3, 6, 9, 13, 16, 18), "right": (3, 6, 9, 14, 17, 19)}
WRIST_BODY_INDEX = {"left": 19, "right": 20}  # SMPL-X joints 20 and 21 -> body_pose indices 19 and 20
WRIST_MEDIAPIPE = {"left": 15, "right": 16}
# MediaPipe indices (pinky, index, thumb) updated from the 21 hand points (indices 20, 8, 4) when seen.
HAND_TIPS_MEDIAPIPE = {"left": (17, 19, 21), "right": (18, 20, 22)}

# Frames averaged to read the person's heading: 0.5 s at 30 fps, enough to ignore one bad frame and
# short enough that a person who turns early still faces the way they did at the start.
HEADING_FRAMES = 15

# Default 35 mm equivalent focal length used by gvhmr_mac.py when none is given (iPhone 1x main lens).
DEFAULT_F_MM = 24
# WiLoR's weak-perspective focal length ratio (cfg.EXTRA.FOCAL_LENGTH / cfg.MODEL.IMAGE_SIZE = 5000 / 256).
WILOR_FOCAL_RATIO = 5000.0 / 256.0
# Maximum distance (as a fraction of the image's long side) between GVHMR's wrist and WiLoR's wrist in
# the camera view for the hand to count as the subject's. Measured on the test set: the subject's hands
# sit at p50 0.01-0.08, p95 <= 0.13 and max 0.27 (waving fast in saludar-02); 0.30 keeps all of them
# while rejecting another person's hand across the frame.
MAX_WRIST_IMAGE_DIST = 0.30

# Foot contact thresholds (docs/contrato.md, matching physics/src/motion.js and training/balance.py):
# a foot is planted when its heel or big toe is within 2 cm of the floor and its horizontal speed <= 0.15 m/s.
CONTACT_HEIGHT_M = 0.02
CONTACT_SPEED_MPS = 0.15


def find_hands_npz(gvhmr_npz: Path, hands_arg: Path | None) -> Path | None:
    if hands_arg is not None:
        return hands_arg
    video = gvhmr_npz.name.split(".")[0]
    for candidate in (gvhmr_npz.parent / f"{video}.wilor.npz", gvhmr_npz.parent / "hands" / f"{video}.wilor.npz"):
        if candidate.exists():
            return candidate
    return None


# SMPL-X's neutral J_regressor places left_hip (joint 1, MediaPipe 23) 1.114 cm above right_hip
# (joint 2, MediaPipe 24) and left_shoulder (16, MP 11) 0.481 cm above right_shoulder (17, MP 12)
# in the zero T-pose, which shows as a 5.3-degree permanent hip tilt on the 3D skeleton.
SMPLX_HIP_Y_BIAS_M = 0.01114
SMPLX_SHOULDER_Y_BIAS_M = 0.00481
# Window (seconds) for the running lower-envelope of the feet: 1.0 s spans a full stride or jump
# cycle (~0.5-0.7 s) so flight phases stay airborne while camera-pitch vertical drift is removed.
FLOOR_ENVELOPE_WINDOW_S = 1.0
# Entry/exit margin (frames) when trimming frozen edge bounding boxes where a runner enters/leaves frame.
BBX_EDGE_MARGIN_FRAMES = 3


def _active_frame_slice(npz: Path, n_total: int, global_orient: np.ndarray | None = None) -> slice:
    """Trims padded leading/trailing frames where GVHMR's tracker froze or inverted the subject."""
    video = npz.name.split(".")[0]
    bbx_path = npz.parent / "gvhmr_work" / video / "preprocess" / "bbx.pt"
    start, end = 0, n_total
    b = None
    if bbx_path.exists():
        import torch

        b = torch.load(bbx_path, map_location="cpu")["bbx_xyxy"].numpy()
        if len(b) == n_total and n_total > 20:
            diff = np.linalg.norm(np.diff(b, axis=0), axis=1)
            active = np.where(diff > 1e-4)[0]
            if len(active):
                first, last = int(active[0]), int(active[-1] + 1)
                if first > 0:
                    start = min(n_total - 1, first + BBX_EDGE_MARGIN_FRAMES)
                if last < n_total - 1:
                    end = max(start + 1, last - BBX_EDGE_MARGIN_FRAMES)
    if global_orient is not None and end - start > 60:
        from scipy.spatial.transform import Rotation as R

        up_y = R.from_rotvec(global_orient[start:end]).apply([0.0, 1.0, 0.0])[:, 1]
        # If GVHMR's tracker inverted the pelvis near the end (up_y < 0, >90 deg tilt), cut before the
        # camera cut / severe tracking wobble in the second half.
        if (up_y < 0.0).any():
            bad_mask = up_y < 0.866
            if b is not None and len(b) == n_total:
                h = b[start:end, 3] - b[start:end, 1]
                bad_mask = bad_mask | (h < 0.65 * np.median(h))
            bad = np.where(bad_mask)[0]
            bad_tail = bad[bad >= (end - start) // 2]
            if len(bad_tail):
                end = start + max(60, int(bad_tail[0]) - 15)
    return slice(start, end)


def _floor_envelope(low_y: np.ndarray, fps: float, window_s: float = FLOOR_ENVELOPE_WINDOW_S) -> np.ndarray:
    """Smooth running minimum of the lowest foot height: tracks ground slope without eating jumps."""
    n = len(low_y)
    r = max(1, int(round(0.5 * window_s * fps)))
    env = np.array([low_y[max(0, i - r) : min(n, i + r + 1)].min() for i in range(n)], dtype=np.float64)
    pad = np.pad(env, r, mode="edge")
    return np.convolve(pad, np.ones(2 * r + 1) / (2 * r + 1), mode="valid")


def fuse_wilor_hands(
    d: dict | np.lib.npyio.NpzFile,
    incam_joints: np.ndarray,
    wilor_npz: Path | None,
    f_mm: int = DEFAULT_F_MM,
    frame_slice: slice = slice(None),
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Fuses WiLoR hands into SMPL-X body_pose (wrists) and left/right_hand_pose.

    Returns (body_pose [F, 63], left_hand_pose [F, 45], right_hand_pose [F, 45], hand_conf [F, 2]).
    Without WiLoR, body_pose is unchanged and hand poses/confidences are zero.
    """
    from scipy.spatial.transform import Rotation as R

    body_pose = d["global_body_pose"].astype(np.float32).copy()
    n = len(body_pose)
    hand_pose = {"left": np.zeros((n, 45), dtype=np.float32), "right": np.zeros((n, 45), dtype=np.float32)}
    hand_conf = np.zeros((n, 2), dtype=np.float32)
    if wilor_npz is None:
        return body_pose, hand_pose["left"], hand_pose["right"], hand_conf

    w_raw = np.load(wilor_npz)
    w = {k: (w_raw[k][frame_slice] if w_raw[k].ndim >= 1 else w_raw[k]) for k in w_raw.files}
    m = min(n, len(w["left_conf"]))
    incam_go = d["incam_global_orient"][:m]
    incam_bp = body_pose[:m].reshape(m, 21, 3)
    gvhmr_focal_ratio = f_mm / 36.0

    for side_idx, side in enumerate(("left", "right")):
        conf = w[f"{side}_conf"][:m].astype(np.float32)
        seen = conf > 0
        if not seen.any():
            continue
        j_wrist = 20 if side == "left" else 21
        gw = incam_joints[:m, j_wrist]
        ww = w[f"{side}_keypoints"][:m, 0]
        g_px = gw[:, :2] / np.maximum(gw[:, 2:3], 1e-4) * gvhmr_focal_ratio
        w_px = ww[:, :2] / np.maximum(ww[:, 2:3], 1e-4) * WILOR_FOCAL_RATIO
        keep = seen & (np.linalg.norm(g_px - w_px, axis=1) <= MAX_WRIST_IMAGE_DIST)
        if not keep.any():
            continue
        hand_conf[:m, side_idx] = np.where(keep, conf, 0.0)

        # WiLoR predicts every hand as a right hand on a mirrored crop: a left hand's rotation vector
        # is mirrored across the YZ plane (x -> -x), which negates its y and z components.
        mirror = np.array([1.0, -1.0, -1.0], dtype=np.float32) if side == "left" else np.ones(3, dtype=np.float32)
        idx = np.where(keep)[0]
        hp_rotvec = R.from_matrix(w[f"{side}_hand_pose"][idx].reshape(-1, 3, 3)).as_rotvec().reshape(len(idx), 15, 3)
        hand_pose[side][idx] = (hp_rotvec * mirror).reshape(len(idx), 45).astype(np.float32)

        # Wrist orientation in SMPL-X: R_elbow_incam^-1 * R_wrist_wilor (local to the elbow, so it is
        # the same in camera space and in world space).
        r_elbow = R.from_rotvec(incam_go[idx])
        for parent in ARM_PARENTS[side]:
            r_elbow = r_elbow * R.from_rotvec(incam_bp[idx, parent - 1])
        w_go_rotvec = R.from_matrix(w[f"{side}_global_orient"][idx]).as_rotvec() * mirror
        r_wrist_wilor = R.from_rotvec(w_go_rotvec)
        incam_bp[idx, WRIST_BODY_INDEX[side]] = (r_elbow.inv() * r_wrist_wilor).as_rotvec().astype(np.float32)

    body_pose[:m] = incam_bp.reshape(m, 63)
    return body_pose, hand_pose["left"], hand_pose["right"], hand_conf


def smplx_joints(
    global_orient: np.ndarray,
    body_pose: np.ndarray,
    betas: np.ndarray,
    transl: np.ndarray,
    left_hand_pose: np.ndarray | None = None,
    right_hand_pose: np.ndarray | None = None,
) -> np.ndarray:
    """[F, 127, 3] SMPL-X joints. Uses flat_hand_mean=True when hand poses are given (matches WiLoR's MANO)."""
    import smplx
    import torch

    n = len(transl)
    has_hands = left_hand_pose is not None and right_hand_pose is not None
    model = smplx.create(
        str(SMPLX_DIR),
        model_type="smplx",
        gender="neutral",
        use_pca=False,
        flat_hand_mean=has_hands,
        num_betas=betas.shape[1],
        batch_size=n,
    )
    t = lambda a: torch.as_tensor(a, dtype=torch.float32)  # noqa: E731
    kwargs = {"global_orient": t(global_orient), "body_pose": t(body_pose), "betas": t(betas), "transl": t(transl)}
    if has_hands:
        kwargs["left_hand_pose"] = t(left_hand_pose)
        kwargs["right_hand_pose"] = t(right_hand_pose)
    with torch.no_grad():
        return model(**kwargs).joints.numpy()


def facing_angle(points: np.ndarray) -> float:
    """Heading about y (radians, atan2(x, z)) of the first frames, from hips and shoulders, y up."""
    p = points[:HEADING_FRAMES]
    left = (p[:, 23] - p[:, 24] + p[:, 11] - p[:, 12]).mean(axis=0)  # the person's right -> left
    forward = np.cross(left, [0.0, 1.0, 0.0])  # left x up: with y up, x left gives +z forward
    return float(np.arctan2(forward[0], forward[2]))


def turn_y(points: np.ndarray, angle: float) -> np.ndarray:
    c, s = np.cos(angle), np.sin(angle)
    x, y, z = points[..., 0], points[..., 1], points[..., 2]
    return np.stack([c * x + s * z, y, -s * x + c * z], axis=-1)


def detect_foot_contacts(pos: np.ndarray, fps: float) -> np.ndarray:
    """[F, 2] bool (left, right): foot within CONTACT_HEIGHT_M of the floor and speed <= CONTACT_SPEED_MPS."""
    l_low = np.minimum(pos[:, 29, 1], pos[:, 31, 1])  # left heel, big toe
    r_low = np.minimum(pos[:, 30, 1], pos[:, 32, 1])  # right heel, big toe
    floor_y = float(np.percentile(np.minimum(l_low, r_low), 5))
    contacts = np.zeros((len(pos), 2), dtype=bool)
    for side_idx, (low, ankle) in enumerate(((l_low, 27), (r_low, 28))):
        xz = pos[:, ankle, [0, 2]]
        speed = np.linalg.norm(np.diff(xz, axis=0, prepend=xz[:1]), axis=1) * fps
        if len(speed) > 1:
            speed[0] = speed[1]
        contacts[:, side_idx] = ((low - floor_y) <= CONTACT_HEIGHT_M) & (speed <= CONTACT_SPEED_MPS)
    return contacts


def build_poseclip_v2(npz: Path, hands_npz: Path | None = None, raw: bool = False) -> dict:
    """Builds all PoseClip v2 arrays in the contract's space (y up, z toward camera, first hips at 0)."""
    from scipy.spatial.transform import Rotation as R

    d_raw = np.load(npz)
    fps = float(d_raw["fps"])
    static_cam = bool(d_raw["static_cam"]) if "static_cam" in d_raw else False
    frame_slice = _active_frame_slice(npz, len(d_raw["global_transl"]), d_raw["global_global_orient"])
    d = {k: (d_raw[k][frame_slice] if d_raw[k].ndim >= 1 and len(d_raw[k]) == len(d_raw["global_transl"]) else d_raw[k]) for k in d_raw.files}

    # 1. Unmodified body pass first: preserves the exact heading and 33 body points of v1.
    incam_all = smplx_joints(d["incam_global_orient"], d["incam_body_pose"], d["incam_betas"], d["incam_transl"])
    world_body_all = smplx_joints(d["global_global_orient"], d["global_body_pose"], d["global_betas"], d["global_transl"])
    seen = incam_all[:, MEDIAPIPE_FROM_SMPLX] * np.array([1, -1, -1])
    world_mp = world_body_all[:, MEDIAPIPE_FROM_SMPLX]
    angle = facing_angle(seen) - facing_angle(world_mp)
    pos = turn_y(world_mp, angle)
    # Remove SMPL-X's canonical T-pose vertical regressor asymmetry between left and right hips/shoulders.
    pos[:, 23, 1] -= 0.5 * SMPLX_HIP_Y_BIAS_M
    pos[:, 24, 1] += 0.5 * SMPLX_HIP_Y_BIAS_M
    pos[:, 11, 1] -= 0.5 * SMPLX_SHOULDER_Y_BIAS_M
    pos[:, 12, 1] += 0.5 * SMPLX_SHOULDER_Y_BIAS_M
    if not raw:
        hips = (pos[:, 23] + pos[:, 24]) / 2
        body = smooth_points(pos - hips[:, None], fps)
        root = savgol(hips, int(round(ROOT_WINDOW_S * fps)) | 1, ROOT_ORDER)
        pos = body + root[:, None]
        # Remove camera-pitch vertical drift so stance feet stay on a flat floor while jumps stay airborne.
        low_foot_y = pos[:, [27, 28, 29, 30, 31, 32], 1].min(axis=1)
        floor_env = _floor_envelope(low_foot_y, fps)
        pos[:, :, 1] -= (floor_env - floor_env[0])[:, None]
    origin = (pos[0, 23] + pos[0, 24]) / 2
    pos = pos - origin

    # 2. Fuse WiLoR hands (when available) into SMPL-X and extract the 21 hand joints per side.
    body_pose, left_hand_pose, right_hand_pose, hand_conf = fuse_wilor_hands(d, incam_all, hands_npz, frame_slice=frame_slice)
    has_hands = bool((hand_conf > 0).any())
    if has_hands:
        fused_all = smplx_joints(
            d["global_global_orient"], body_pose, d["global_betas"], d["global_transl"], left_hand_pose, right_hand_pose
        )
    else:
        fused_all = world_body_all
    fused_turned = turn_y(fused_all, angle)

    n = len(pos)
    hand_joints = np.zeros((n, 2, 21, 3), dtype=np.float32)
    for side_idx, side in enumerate(("left", "right")):
        raw_h = fused_turned[:, SMPLX_HAND_JOINTS[side]]
        rel_h = raw_h - raw_h[:, :1]  # relative to the SMPL-X wrist
        if not raw:
            rel_h = smooth_points(rel_h, fps)
        wrist_mp = pos[:, WRIST_MEDIAPIPE[side] : WRIST_MEDIAPIPE[side] + 1]
        hand_joints[:, side_idx] = (wrist_mp + rel_h).astype(np.float32)
        # Where WiLoR saw this hand, put the real pinky, index and thumb tips into MediaPipe's 17..22.
        seen_mask = hand_conf[:, side_idx] > 0
        if seen_mask.any():
            p_idx, i_idx, t_idx = HAND_TIPS_MEDIAPIPE[side]
            pos[seen_mask, p_idx] = hand_joints[seen_mask, side_idx, 20]
            pos[seen_mask, i_idx] = hand_joints[seen_mask, side_idx, 8]
            pos[seen_mask, t_idx] = hand_joints[seen_mask, side_idx, 4]

    # 3. Rotate and center the SMPL-X parameters into the contract's world space.
    ry = R.from_rotvec([0.0, angle, 0.0])
    smplx_go = (ry * R.from_rotvec(d["global_global_orient"])).as_rotvec().astype(np.float32)
    # Shift transl so the SMPL-X pelvis matches the turned, smoothed and origin-centered clip.
    pelvis_shift = (pos[:, 23] + pos[:, 24]) / 2 - ((turn_y(world_mp, angle)[:, 23] + turn_y(world_mp, angle)[:, 24]) / 2)
    smplx_transl = (turn_y(d["global_transl"], angle) - origin + pelvis_shift).astype(np.float32)
    smplx_betas = d["global_betas"].mean(axis=0).astype(np.float32)

    foot_contact = detect_foot_contacts(pos, fps)

    return {
        "points": pos,
        "fps": fps,
        "static_cam": static_cam,
        "has_hands": has_hands,
        "hand_joints": hand_joints,
        "hand_conf": hand_conf,
        "foot_contact": foot_contact,
        "smplx_betas": smplx_betas,
        "smplx_transl": smplx_transl,
        "smplx_global_orient": smplx_go,
        "smplx_body_pose": body_pose,
        "smplx_left_hand_pose": left_hand_pose,
        "smplx_right_hand_pose": right_hand_pose,
    }


def poseclip(npz: Path, raw: bool = False, hands_npz: Path | None = None) -> tuple[np.ndarray, float]:
    """[F, 33, 3] points in the contract's space (kept for callers that only want the 33 points)."""
    res = build_poseclip_v2(npz, hands_npz=hands_npz, raw=raw)
    return res["points"], res["fps"]


def write(data: dict, video: str, out_dir: Path) -> Path:
    """Saves PoseClip v2 clip_<video>-gvhmr.json and .npz; returns the JSON path."""
    out_dir.mkdir(parents=True, exist_ok=True)
    clip_id = f"clip_{video}-gvhmr"
    points = data["points"]
    fps = data["fps"]
    hand_joints = data["hand_joints"]
    hand_conf = data["hand_conf"]
    foot_contact = data["foot_contact"]
    has_hands = data["has_hands"]

    n = len(points)
    t = np.arange(n) / fps
    vis = np.ones((n, 33, 1))
    if has_hands:
        for side_idx, side in enumerate(("left", "right")):
            seen_mask = hand_conf[:, side_idx] > 0
            for mp_idx in HAND_TIPS_MEDIAPIPE[side]:
                vis[seen_mask, mp_idx, 0] = hand_conf[seen_mask, side_idx]
    joints = np.concatenate([points, vis], axis=2)

    frames = []
    for i in range(n):
        frame = {
            "t": round(float(t[i]), 4),
            "joints": joints[i].round(4).tolist(),
            "contacts": {"left_foot": bool(foot_contact[i, 0]), "right_foot": bool(foot_contact[i, 1])},
        }
        if has_hands:
            l_conf, r_conf = float(hand_conf[i, 0]), float(hand_conf[i, 1])
            frame["hands"] = {
                "left": hand_joints[i, 0].round(4).tolist() if l_conf > 0 else None,
                "right": hand_joints[i, 1].round(4).tolist() if r_conf > 0 else None,
            }
            frame["hands_conf"] = {"left": round(l_conf, 3), "right": round(r_conf, 3)}
        frames.append(frame)

    quality = {"valid_ratio": 1.0}
    if has_hands:
        quality["hands_ratio"] = {
            "left": round(float((hand_conf[:, 0] > 0).mean()), 3),
            "right": round(float((hand_conf[:, 1] > 0).mean()), 3),
        }

    clip = {
        "id": clip_id,
        "version": 2,
        "capture": "gvhmr+wilor" if has_hands else "gvhmr",
        "body_model": "smplx",
        "betas": data["smplx_betas"].round(4).tolist(),
        "camera": {"static": data["static_cam"], "f_mm": DEFAULT_F_MM},
        "source": "upload",
        "source_file": f"{video}.mp4",
        "fps": round(fps, 3),
        "skeleton": "mediapipe33",
        "units": "m",
        "origin": "hips",
        "subject": {"track_id": 0, "selected_by": "auto"},
        "frames": frames,
        "quality": quality,
    }
    path = out_dir / f"{clip_id}.json"
    path.write_text(json.dumps(clip, separators=(",", ":")))
    meta = {k: v for k, v in clip.items() if k != "frames"}
    np.savez_compressed(
        out_dir / f"{clip_id}.npz",
        joints=joints.astype(np.float32),
        t=t.astype(np.float32),
        valid=np.ones(n, bool),
        frame_index=np.arange(n),
        meta=json.dumps(meta),
        smplx_betas=data["smplx_betas"],
        smplx_transl=data["smplx_transl"],
        smplx_global_orient=data["smplx_global_orient"],
        smplx_body_pose=data["smplx_body_pose"],
        smplx_left_hand_pose=data["smplx_left_hand_pose"],
        smplx_right_hand_pose=data["smplx_right_hand_pose"],
        hand_joints=hand_joints,
        hand_conf=hand_conf,
        foot_contact=foot_contact,
    )
    return path


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("npz", type=Path, nargs="+")
    p.add_argument("--hands", type=Path, help="explicit .wilor.npz (default: auto-detected next to .gvhmr.npz or in hands/)")
    p.add_argument("--out-dir", type=Path, help="default: clips/ next to the .npz")
    p.add_argument("--raw", action="store_true", help="no smoothing (GVHMR as it comes)")
    args = p.parse_args()
    for npz in args.npz:
        video = npz.name.split(".")[0]
        hands_npz = find_hands_npz(npz, args.hands)
        data = build_poseclip_v2(npz, hands_npz=hands_npz, raw=args.raw)
        path = write(data, video, args.out_dir or npz.parent / "clips")
        hands_note = ""
        if data["has_hands"]:
            lr = (data["hand_conf"][:, 0] > 0).mean()
            rr = (data["hand_conf"][:, 1] > 0).mean()
            hands_note = f" (hands: left {lr:.0%}, right {rr:.0%})"
        print(f"{len(data['points'])} frames at {data['fps']:g} fps{hands_note} -> {path}")


if __name__ == "__main__":
    main()
