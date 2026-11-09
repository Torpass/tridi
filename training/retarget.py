"""A RobotMotion of one humanoid onto another, through their packages (robots/<id>.json).

The human -> G1 retargeting (physics/src/retarget.js) is tuned clip by clip against MediaPipe's noise.
Rather than redo that for every robot, a second robot takes the G1's motion, already clean (and
balanced, if it went through training.balance), and copies its body points:

1. Sizes. Every displacement is scaled by the legs' ratio (target leg / source leg, robot.measure):
   a taller robot takes a longer step, as RobotMotion scales the person to the G1.
2. Targets. Each point of robot.POINTS keeps its standing place on the target robot and moves from
   it as the source's point moves from its own, in the frame of the pelvis' heading; the pelvis
   travels the scaled path. A foot on the floor in the source is on the floor in the target, since
   heights move from each robot's own standing height. The pelvis, torso and feet also copy their
   turn away from standing. The arms are different: a scaled hand displacement leaves the reach of
   an arm of other proportions (on the H1 the hand's p95 error was 44 cm), so the upper arm and the
   forearm copy their directions instead, from the target's own shoulder, at their own lengths.
3. IK. Damped least squares on every degree of freedom (free pelvis and joints), warm-started from
   the previous frame, within the joint limits, with a small pull to the standing pose.

`python -m training.retarget <source motion.json> --to h1` writes training/references/<clip>-<to>.json
(then `python -m training.balance` on it, since balance depends on the robot's own mass)
and prints how well it copied: point errors, the sliding of feet planted in the source, how deep a
foot goes into the floor, and the share of frames with a joint at its limit.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import mujoco
import numpy as np

from .robot import POINTS, Robot, load, measure, sole_ends

REFERENCES = Path(__file__).resolve().parent / "references"

# How much each target counts, in meters of error (rotations in radians, which at these sizes is
# about as much). Feet first: a foot that slides or sinks is what physics punishes (C1, C2). The
# pelvis carries the path. Hands and head matter for how it looks, less for whether it can be done.
# Feet weigh 30 and their turn 1: on the H1 (one ankle joint, no roll) a foot that must also keep
# the source's roll fights its own position, and the planted foot slid 0.05 m/s; at 30 and 1 it
# slides 0.02. The pelvis gives way instead (its error grows from 4 to 5 cm, mostly sideways, which
# training.balance moves anyway).
W_POS = {
    "left_foot": 30.0, "right_foot": 30.0,
    "pelvis": 1.0,
    "left_knee": 1.0, "right_knee": 1.0,
    "left_hand": 2.0, "right_hand": 2.0,
    "left_elbow": 2.0, "right_elbow": 2.0,
    "torso": 1.0, "head": 0.5,
}
ARMS = {"left": ("left_shoulder", "left_elbow", "left_hand"), "right": ("right_shoulder", "right_elbow", "right_hand")}
W_ROT = {"left_foot": 1.0, "right_foot": 1.0, "pelvis": 3.0, "torso": 2.0}
# Pull toward the standing pose, per radian: small enough not to bend a reachable target (a 0.1 rad
# pull costs as much as 1 mm of foot error), large enough to choose the natural knee among the
# poses that reach the same point.
W_POSTURE = 0.01
DAMPING = 1e-4
# Iterations per frame: from the previous frame's answer, 12 bring the foot error under a millimeter
# where it is reachable (measured on the walk, G1 -> H1); more only cost time.
ITERATIONS = 12
# A source foot is planted while its ankle is within 1.5 cm of its standing height and moves under
# 0.1 m/s: the contact tolerance of training/checks.py (CONTACT_M) and a still foot.
PLANTED_M = 0.015
PLANTED_MPS = 0.1
# A joint is at its limit within 0.01 rad (half a degree) of it.
LIMIT_RAD = 0.01
# Balance, as training/checks.py C2 measures it: a sole end touches within 1.5 cm of the floor
# (CONTACT_M), and the ZMP is outside the support when more than 2 cm (ZMP_TOL_M) past its edge.
CONTACT_M = 0.015
ZMP_TOL_M = 0.02


def _yaw(quat: np.ndarray) -> float:
    w, x, y, z = quat
    return float(np.arctan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z)))


def _rz(angle: float) -> np.ndarray:
    c, s = np.cos(angle), np.sin(angle)
    return np.array([[c, -s, 0.0], [s, c, 0.0], [0.0, 0.0, 1.0]])


def _pose(robot: Robot, data: mujoco.MjData, qpos: np.ndarray) -> tuple[dict, dict]:
    """World position and rotation of every point at qpos."""
    data.qpos[:] = qpos
    mujoco.mj_kinematics(robot.model, data)
    pos = {k: p.pos(data).copy() for k, p in robot.points.items()}
    rot = {k: data.xmat[p.body].reshape(3, 3).copy() for k, p in robot.points.items()}
    return pos, rot


def targets(src: Robot, dst: Robot, qpos: np.ndarray, fps: float) -> tuple[np.ndarray, list[dict], list[dict]]:
    """The scaled path and, per frame, where each point of `dst` should be and how it should turn."""
    scale = measure(dst)["leg_m"] / measure(src)["leg_m"]
    ds, dd = mujoco.MjData(src.model), mujoco.MjData(dst.model)
    s_home_pos, s_home_rot = _pose(src, ds, src.home_qpos)
    d_home_pos, d_home_rot = _pose(dst, dd, dst.home_qpos)
    s_pel0, d_pel0 = s_home_pos["pelvis"], d_home_pos["pelvis"]
    s_yaw0, d_yaw0 = _yaw(src.home_qpos[3:7]), _yaw(dst.home_qpos[3:7])
    # Each point's standing place, in its robot's heading frame, around the pelvis' xy.
    local = lambda p, pel, yaw: _rz(-yaw) @ np.array([p[0] - pel[0], p[1] - pel[1], p[2]])
    s_local0 = {k: local(s_home_pos[k], s_pel0, s_yaw0) for k in POINTS}
    d_local0 = {k: local(d_home_pos[k], d_pel0, d_yaw0) for k in POINTS}
    pos_t, rot_t = [], []
    for q in qpos:
        sp, sr = _pose(src, ds, q)
        yaw = _yaw(q[3:7])
        pel_xy = d_pel0[:2] + scale * (sp["pelvis"][:2] - s_pel0[:2])
        frame = _rz(yaw)
        pos, rot = {}, {}
        for k in POINTS:
            moved = local(sp[k], sp["pelvis"], yaw) - s_local0[k]
            here = d_local0[k] + scale * moved
            world = frame @ np.array([here[0], here[1], 0.0])
            pos[k] = np.array([pel_xy[0] + world[0], pel_xy[1] + world[1], here[2]])
            if k in W_ROT:
                # The source point's turn away from standing, applied to the target's standing frame.
                rot[k] = sr[k] @ s_home_rot[k].T @ d_home_rot[k]
        # The arms: directions of the source's upper arm and forearm (unit vectors, world frame).
        for side, (sh, el, ha) in ARMS.items():
            up, fore = sp[el] - sp[sh], sp[ha] - sp[el]
            pos[f"{side}_dirs"] = (up / np.linalg.norm(up), fore / np.linalg.norm(fore))
        pos_t.append(pos)
        rot_t.append(rot)
    pin_planted(src, qpos, fps, pos_t, rot_t)
    return scale, pos_t, rot_t


def planted(src: Robot, qpos: np.ndarray, fps: float) -> np.ndarray:
    """[frames, 2]: the source's feet on the floor and still (PLANTED_M, PLANTED_MPS)."""
    ds = mujoco.MjData(src.model)
    home = _pose(src, ds, src.home_qpos)[0]
    feet = np.array([[p["left_foot"], p["right_foot"]] for p in (_pose(src, ds, q)[0] for q in qpos)])
    speed = np.zeros(feet.shape[:2])
    speed[1:] = np.linalg.norm(np.diff(feet[:, :, :2], axis=0), axis=2) * fps
    speed[0] = speed[min(1, len(speed) - 1)]
    low = feet[:, :, 2] - np.array([home["left_foot"][2], home["right_foot"][2]]) < PLANTED_M
    return low & (speed < PLANTED_MPS)


def pin_planted(src: Robot, qpos: np.ndarray, fps: float, pos_t: list[dict], rot_t: list[dict]) -> None:
    """A foot planted in the source stays put in the target: through each planted stretch its target
    is the stretch's mean place, turned as at its first frame. Without this the targets themselves
    slid 0.018 m/s (median), since the pelvis' heading turns a little under a planted foot and the
    two robots' feet sit at different widths."""
    on = planted(src, qpos, fps)
    for k, name in enumerate(("left_foot", "right_foot")):
        i = 0
        while i < len(on):
            if not on[i, k]:
                i += 1
                continue
            j = i
            while j < len(on) and on[j, k]:
                j += 1
            xy = np.mean([pos_t[f][name][:2] for f in range(i, j)], axis=0)
            for f in range(i, j):
                pos_t[f][name] = np.array([xy[0], xy[1], pos_t[f][name][2]])
                rot_t[f][name] = rot_t[i][name]
            i = j


def arm_lengths(robot: Robot) -> dict:
    pos = _pose(robot, mujoco.MjData(robot.model), robot.home_qpos)[0]
    return {side: (np.linalg.norm(pos[el] - pos[sh]), np.linalg.norm(pos[ha] - pos[el])) for side, (sh, el, ha) in ARMS.items()}


def _rot_error(want: np.ndarray, have: np.ndarray) -> np.ndarray:
    """Rotation vector that turns `have` into `want`, in the world frame."""
    qw, qh, e = np.zeros(4), np.zeros(4), np.zeros(3)
    mujoco.mju_mat2Quat(qw, want.ravel())
    mujoco.mju_mat2Quat(qh, have.ravel())
    mujoco.mju_subQuat(e, qw, qh)  # in have's frame
    return have @ e


def solve(dst: Robot, pos_t: list[dict], rot_t: list[dict]) -> np.ndarray:
    m, d = dst.model, mujoco.MjData(dst.model)
    nv = m.nv
    hinge = [j for j in range(m.njnt) if m.jnt_type[j] == mujoco.mjtJoint.mjJNT_HINGE]
    qadr = np.array([m.jnt_qposadr[j] for j in hinge])
    vadr = np.array([m.jnt_dofadr[j] for j in hinge])
    lo, hi = m.jnt_range[hinge].T
    jacp, jacr = np.zeros((3, nv)), np.zeros((3, nv))
    q = dst.home_qpos.copy()
    lengths = arm_lengths(dst)
    out, pos_t_final = [], []
    for pos, rot in zip(pos_t, rot_t):
        pos = dict(pos)
        for _ in range(ITERATIONS):
            d.qpos[:] = q
            mujoco.mj_kinematics(m, d)
            mujoco.mj_comPos(m, d)
            # Elbow and hand from where this robot's shoulder is now (see the module docstring).
            for side, (sh, el, ha) in ARMS.items():
                up, fore = pos[f"{side}_dirs"]
                pos[el] = dst.points[sh].pos(d) + lengths[side][0] * up
                pos[ha] = pos[el] + lengths[side][1] * fore
            rows, errs, ws = [], [], []
            for k, w in W_POS.items():
                p = dst.points[k]
                here = p.pos(d)
                mujoco.mj_jac(m, d, jacp, None, here, p.body)
                rows.append(jacp.copy())
                errs.append(pos[k] - here)
                ws.append(np.full(3, w))
            for k, w in W_ROT.items():
                body = dst.points[k].body
                mujoco.mj_jacBody(m, d, None, jacr, body)
                rows.append(jacr.copy())
                errs.append(_rot_error(rot[k], d.xmat[body].reshape(3, 3)))
                ws.append(np.full(3, w))
            posture = np.zeros((len(hinge), nv))
            posture[np.arange(len(hinge)), vadr] = 1.0
            rows.append(posture)
            errs.append(dst.home_qpos[qadr] - q[qadr])
            ws.append(np.full(len(hinge), W_POSTURE))
            J, e, w = np.vstack(rows), np.concatenate(errs), np.concatenate(ws)
            dq = np.linalg.solve(J.T @ (w[:, None] * J) + DAMPING * np.eye(nv), J.T @ (w * e))
            mujoco.mj_integratePos(m, q, dq, 1.0)
            q[qadr] = np.clip(q[qadr], lo, hi)
        out.append(q.copy())
        pos_t_final.append(pos)
    return np.array(out), pos_t_final


def report(src: Robot, dst: Robot, src_q: np.ndarray, dst_q: np.ndarray, pos_t: list[dict], fps: float) -> dict:
    ds, dd = mujoco.MjData(src.model), mujoco.MjData(dst.model)
    s_home = _pose(src, ds, src.home_qpos)[0]
    errors = {k: [] for k in W_POS}
    slip, sink, at_limit = [], [], 0
    prev = None
    m = dst.model
    hinge = [j for j in range(m.njnt) if m.jnt_type[j] == mujoco.mjtJoint.mjJNT_HINGE]
    qadr = np.array([m.jnt_qposadr[j] for j in hinge])
    lo, hi = m.jnt_range[hinge].T
    for i, (sq, dq) in enumerate(zip(src_q, dst_q)):
        sp = _pose(src, ds, sq)[0]
        dp = _pose(dst, dd, dq)[0]
        for k in W_POS:
            errors[k].append(np.linalg.norm(dp[k] - pos_t[i][k]))
        feet = np.array([dp["left_foot"], dp["right_foot"]])
        src_feet = np.array([sp["left_foot"], sp["right_foot"]])
        if prev is not None:
            sv = np.linalg.norm(src_feet[:, :2] - prev[1][:, :2], axis=1) * fps
            dv = np.linalg.norm(feet[:, :2] - prev[0][:, :2], axis=1) * fps
            for side, name in enumerate(("left_foot", "right_foot")):
                if src_feet[side, 2] - s_home[name][2] < PLANTED_M and sv[side] < PLANTED_MPS:
                    slip.append(dv[side])
        prev = (feet, src_feet)
        sole = min(dd.geom_xpos[g][2] - m.geom_size[g][0] for side in dst.feet.values() for g in side)
        sink.append(max(0.0, -sole))
        at_limit += bool(np.any((dq[qadr] - lo < LIMIT_RAD) | (hi - dq[qadr] < LIMIT_RAD)))
    return {
        "error_cm": {k: 100 * float(np.median(v)) for k, v in errors.items()},
        "error_p95_cm": {k: 100 * float(np.percentile(v, 95)) for k, v in errors.items()},
        "planted_slip_mps": float(np.median(slip)) if slip else None,
        "planted_slip_p95_mps": float(np.percentile(slip, 95)) if slip else None,
        "sink_max_cm": 100 * float(max(sink)),
        "at_limit_share": at_limit / len(dst_q),
        "zmp_outside_share": zmp_outside_share(dst, dst_q, fps),
    }


def zmp_outside_share(robot: Robot, qs: np.ndarray, fps: float) -> float:
    """Share of frames whose ZMP (cart-table, from the CoM's path) is past the support polygon of the
    soles on the floor: what training.balance fixes, measured on any robot."""
    from .balance import zmp_of
    from .checks import distance_outside

    m, d = robot.model, mujoco.MjData(robot.model)
    com, support = [], []
    for q in qs:
        d.qpos[:] = q
        mujoco.mj_kinematics(m, d)
        mujoco.mj_comPos(m, d)
        com.append(d.subtree_com[1].copy())
        support.append(np.array([p[:2] for side in ("left", "right") for p, r in sole_ends(robot, d, side) if p[2] - r < CONTACT_M]))
    zmp = zmp_of(np.array(com), fps)
    out = [distance_outside(zmp[i], support[i]) if len(support[i]) else np.inf for i in range(len(qs))]
    return float(np.mean(np.array(out) > ZMP_TOL_M))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("motion", help="source RobotMotion (.json)")
    parser.add_argument("--from", dest="src", default="g1", help="source robot package (default g1)")
    parser.add_argument("--to", dest="dst", required=True, help="target robot package, e.g. h1")
    args = parser.parse_args()
    src, dst = load(args.src), load(args.dst)
    motion = json.loads(Path(args.motion).read_text())
    src_q = np.array(motion["qpos"], dtype=float)
    fps = float(motion["fps"])
    scale, pos_t, rot_t = targets(src, dst, src_q, fps)
    dst_q, pos_t = solve(dst, pos_t, rot_t)
    stats = report(src, dst, src_q, dst_q, pos_t, fps)
    # The id names the robot: training.balance writes <clip_id>-balanced.json, and the G1's own
    # balanced walk already has that name. The target balances on its own (its mass is its own).
    clip = f'{motion["clip_id"].removesuffix("-balanced")}-{dst.id}'
    out = REFERENCES / f"{clip}.json"
    out.write_text(json.dumps({
        "clip_id": clip,
        "robot": dst.mjcf.split("/")[0],
        "robot_package": dst.id,
        "fps": fps,
        "retargeted_from": {"robot": src.id, "motion": Path(args.motion).name, "scale": round(scale, 4)},
        "qpos": np.round(dst_q, 5).tolist(),
    }))
    print(f"{src.name} -> {dst.name}: scale x{scale:.3f}, {len(dst_q)} frames -> {out.relative_to(REFERENCES.parent.parent)}")
    print("point error, median / p95 (cm):")
    for k in W_POS:
        print(f"  {k:<12}{stats['error_cm'][k]:>6.1f}{stats['error_p95_cm'][k]:>7.1f}")
    if stats["planted_slip_mps"] is not None:
        print(f"planted feet slide: median {stats['planted_slip_mps']:.3f} m/s, p95 {stats['planted_slip_p95_mps']:.3f} m/s")
    print(f"deepest foot into the floor: {stats['sink_max_cm']:.1f} cm")
    print(f"frames with a joint at its limit: {100 * stats['at_limit_share']:.0f} %")
    print(f"ZMP outside the support: {100 * stats['zmp_outside_share']:.0f} % of frames")


if __name__ == "__main__":
    main()
