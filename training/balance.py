"""Make a RobotMotion physically plausible before training on it: planted feet and a balanced body.

    uv run --project training python -m training.balance <clip id or RobotMotion.json> [--rounds 4]

Why (docs/plan-v2.md, block 3): the checks found the walk reference infeasible. With the pelvis held,
its planted foot slides 0.25 m/s, and its zero moment point (ZMP) is outside the feet on the floor in
93 % of the decisions. The policy then has to change the motion to stay up while the imitation reward
punishes every change: more steps never fixed that (the hackathon plateau).

What it does, all kinematic, on the training model:

1. Contacts. Each foot is on the floor where the reference has it low and slow, cleaned of blips
   shorter than MIN_CONTACT_S; a walk always has at least one foot down, while jumping jacks and
   running keep flight phases (both feet in the air) between stances.
2. Feet targets. A planted foot's toe stays where it landed (median of the stretch) on the floor,
   facing its median yaw; its heel may rise. A swinging foot follows the reference, shifted smoothly from where it
   lifted off to where it lands, and never below the sole height.
3. Balance. The center of mass is moved in the floor plane until the ZMP (cart-table model,
   ZMP = CoM - z/g * CoM'') is inside the support polygon of the planted feet; the shift is smoothed
   so it does not add accelerations of its own, and the loop repeats ITERS times.
4. Inverse kinematics per frame on the pelvis position and the 12 leg joints: feet on their targets,
   center of mass on its target, everything else as close to the reference as it can stay. Arms,
   waist and the pelvis orientation are untouched.

Writes training/references/<clip_id>-balanced.json, a RobotMotion with "balanced_by": "training.balance";
imitate.Motion skips its own smoothing for those (it would slide the feet again). Then run
`python -m training.checks training/references/<clip_id>-balanced.json`.

Any humanoid: the robot is a package (robots/<id>.json, training/robot.py), named by the motion's
"robot_package" (training.retarget writes it) or --robot; the G1 when neither says. Feet, soles and
legs come from the package. A G1 motion is first smoothed and grounded as training sees it
(imitate.Motion); another robot's comes from training.retarget, already clean.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import mujoco
import numpy as np

from .imitate import Motion, motion_path, smooth
from .robot import Robot, load, sole_ends

OUT = Path(__file__).parent / "references"
G = 9.81

# 1. Contacts. A foot within 3 cm of the floor (twice C1's 1.5 cm: MediaPipe's depth noise lifts a
# planted foot by about a centimeter, a real swing clears by 5+) and moving slower than 0.4 m/s (a
# swing moves at 1-3 m/s; a planted foot that "slides" 0.25 m/s is the error we are removing).
CONTACT_CLEAR_M = 0.03
CONTACT_SPEED = 0.4
SPEED_SMOOTH_S = 0.1  # foot speed over 3 frames: frame-to-frame jitter alone reads as 1 m/s
# A contact or a swing shorter than 0.1 s (3 frames) is noise: a real step lasts ~0.5 s.
MIN_CONTACT_S = 0.1
# In jumping jacks, both feet plant together when their speed relative to the pelvis drops below
# 0.85 m/s (lateral jump transitions peak at 1.2-2.0 m/s).
JACKS_REL_SPEED = 0.85
# In running, a foot is in stance when it sweeps backward relative to the pelvis faster than 0.20 m/s.
RUN_BACK_SPEED = -0.20
# Half-stride phase shift (0.25 s = 6 frames at 24 fps) used when one leg was occluded in profile video.
HALF_STRIDE_S = 0.25
# Window (0.4 s, ~1 stride) for smoothing pelvis velocity integrated from planted-foot odometry.
ODOM_SMOOTH_S = 0.4

# 3. Balance, as walking-pattern generators do (Kajita's cart-table / linear inverted pendulum):
# the desired ZMP sits at the center of the planted foot, moves to the next foot during double
# support, and the CoM path that produces it is solved by least squares.
# Double support of at least 0.12 s (human walking has ~0.1 s per step at 0.6 m/s): the trailing
# foot lifts later if the video's contacts give less. Without it the ZMP has to jump between feet.
DOUBLE_SUPPORT_S = 0.12
# How much the CoM may stay near the reference's own CoM (relative to producing the ZMP): small,
# because the reference's CoM is ~21 cm off its feet (median, the walk); the feet decide.
STAY_NEAR_REF = 1e-3
# Rounds of: solve CoM -> inverse kinematics -> measure the ZMP the robot really has -> correct.
ROUNDS = 4
ROUND_GAIN = 0.8
# Pelvis height target smoothed over 0.3 s (a step is ~0.5 s: the bob of the gait survives).
HEIGHT_SMOOTH_S = 0.3
# Polish: legs and pelvis smoothed over 0.1 s (3 frames at 30 fps), then held with weight 1 (20 times
# the plain posture weight) while the feet and CoM are put back.
POLISH_SMOOTH_S = 0.1
W_POLISH = 1.0
# The ZMP is measured as checks.C2 measures it (CoM resampled at 50 Hz and smoothed over 0.2 s before
# differentiating), so the fix is judged by the test that found the problem.
ACC_SMOOTH_S = 0.2
CONTROL_DT = 0.02  # 50 Hz policy step used by checks.C1/C2

# 4. Inverse kinematics. Feet first (weight 10: a sliding foot is what C1 failed on), then the CoM
# (10, as much as the feet: it is the balance), then the pelvis height (0.3, loose: the legs need to bend), then the leg angles of the
# reference (0.05: the style of the motion, when nothing else asks).
W_FOOT, W_COM, W_HEIGHT, W_POSTURE = 10.0, 10.0, 0.3, 0.05
# A swinging foot clears the floor by 5 mm minimum, and up to 2 cm (walk) or 4 cm (flight/run) when
# its ankle target is lifted so a long sole (H1's toe is 14 cm ahead of the ankle) or 50 Hz linear
# interpolation between stance and flight never dips below C1/C2's 1.5 cm contact threshold.
SWING_CLEAR_M = 0.005
SWING_SOLE_CLEAR_M = 0.02
FLIGHT_SOLE_CLEAR_M = 0.04
# A swing lifts the foot at least 5 cm at mid-step (people clear 1-2 cm at the toe and lift the foot
# 10-15 cm; the reference often drags it within 1.5 cm, which reads as a contact). Sine profile:
# zero speed at lift-off and landing.
SWING_LIFT_M = 0.05
# During a flight phase (both feet airborne), lift feet by at least 4.5 cm base + 4 cm sine arch so
# 50 Hz samples interpolated next to stance edges stay above 1.5 cm, and add a 2 cm apex boost to the
# ballistic pelvis trajectory so knees have room to clear the floor.
FLIGHT_BASE_M = 0.045
FLIGHT_ARCH_M = 0.04
FLIGHT_PELVIS_M = 0.02
# Wrists (and waist/pelvis tilt on flight clips) smoothed over 0.3 s. MediaPipe gives a hand only 3
# body landmarks, so the wrist angles are mostly noise, and the wrist pitch/yaw motors (5 N m, gain
# 20) saturate on 0.25 rad of it: 5 % of the walk with the pelvis held (checks.C2).
WRIST_SMOOTH_S = 0.3
# Which capsule ends hold a foot at toe-off: those within 3 cm of the most forward one (on the G1,
# the toe ends of the three capsules, 10-12 cm ahead of the ankle; the next ones back are at 5 cm).
TOE_BAND_M = 0.03
# The floor is a hard limit: 10 times the feet. Softer, a sphere 1-2 cm into the floor survived the IK,
# and imitate.Motion's grounding then lifted the whole body (and the planted foot) by as much.
W_FLOOR = 100.0
DAMPING = 1e-3
IK_STEPS = 20


def leg_dofs(model: mujoco.MjModel) -> tuple[np.ndarray, np.ndarray]:
    """dof and qpos indices of the 12 leg joints."""
    ids = [j for j in range(model.njnt) if any(p in model.joint(j).name for p in ("hip", "knee", "ankle"))]
    return model.jnt_dofadr[ids], model.jnt_qposadr[ids]


SIDES = ("left", "right")


def foot_bodies(robot: Robot) -> list[int]:
    return [robot.points[f"{side}_foot"].body for side in SIDES]


def sole_points(robot: Robot, data: mujoco.MjData, side: str) -> list[tuple[np.ndarray, float]]:
    return sole_ends(robot, data, side)


def sole_local(robot: Robot) -> dict[str, list[np.ndarray]]:
    """Capsule ends of each foot in its ankle body's frame (at the model's default pose)."""
    data = mujoco.MjData(robot.model)
    mujoco.mj_kinematics(robot.model, data)
    out = {}
    for side, b in zip(SIDES, foot_bodies(robot)):
        R, x = data.xmat[b].reshape(3, 3), data.xpos[b]
        out[side] = [R.T @ (p - x) for p, _ in sole_points(robot, data, side)]
    return out


def toe_ends(robot: Robot) -> list[int]:
    x = [e[0] for e in sole_local(robot)["left"]]
    return [j for j, v in enumerate(x) if v >= max(x) - TOE_BAND_M]


def sole_height(robot: Robot) -> float:
    """Height of the ankle body when its sole rests flat on the floor."""
    data = mujoco.MjData(robot.model)
    mujoco.mj_kinematics(robot.model, data)
    b = foot_bodies(robot)[0]
    return max(r - (p[2] - data.xpos[b][2]) for p, r in sole_points(robot, data, "left"))


def runs(mask: np.ndarray) -> list[tuple[int, int]]:
    """[start, end) of every stretch of True."""
    out, start = [], None
    for i, v in enumerate(list(mask) + [False]):
        if v and start is None:
            start = i
        elif not v and start is not None:
            out.append((start, i))
            start = None
    return out


def clean(mask: np.ndarray, min_len: int) -> np.ndarray:
    """Fill gaps and drop stretches shorter than min_len frames."""
    m = mask.copy()
    for a, b in runs(~m):
        if 0 < a and b < len(m) and b - a < min_len:
            m[a:b] = True
    for a, b in runs(m):
        if b - a < min_len:
            m[a:b] = False
    return m


def yaw_of(R: np.ndarray) -> float:
    return float(np.arctan2(R[1, 0], R[0, 0]))


def kinematics_foot_pos(robot: Robot, data, q: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Per frame and foot: ankle world position, ankle yaw, and sole-to-floor clearance."""
    model = robot.model
    feet = foot_bodies(robot)
    floor = model.geom("floor").id
    spheres = [robot.feet[s] for s in SIDES]
    pos = np.zeros((len(q), 2, 3))
    yaw = np.zeros((len(q), 2))
    clear = np.zeros((len(q), 2))
    for i in range(len(q)):
        data.qpos[:] = q[i]
        mujoco.mj_kinematics(model, data)
        for k in range(2):
            pos[i, k] = data.xpos[feet[k]]
            yaw[i, k] = yaw_of(data.xmat[feet[k]].reshape(3, 3))
            clear[i, k] = min(mujoco.mj_geomDistance(model, data, g, floor, 1.0, None) for g in spheres[k])
    return pos, yaw, clear


def prepare_flight_clip(robot: Robot, data, q_ref: np.ndarray, fps: float, jumping: bool, running: bool) -> tuple[np.ndarray, np.ndarray]:
    """Detect contacts (with flight phases) for jumping jacks or running, and fix monocular root drift."""
    model = robot.model
    n = len(q_ref)
    feet = foot_bodies(robot)
    _, qadr = leg_dofs(model)
    min_len = max(1, round(MIN_CONTACT_S * fps))
    if jumping:
        # Jumping jacks are bilateral: symmetrize the two arms and keep the pelvis/waist upright so
        # vertical landing forces and overhead arm swings do not roll-saturate the waist.
        pos, _, _ = kinematics_foot_pos(robot, data, q_ref)
        rel = pos[:, :, :2] - q_ref[:, None, :2]
        rel_s = smooth(rel.reshape(n, 4), max(1, round(SPEED_SMOOTH_S * fps))).reshape(n, 2, 2)
        rel_speed = np.linalg.norm(np.gradient(rel_s, 1 / fps, axis=0), axis=-1)
        both = clean((rel_speed < JACKS_REL_SPEED).all(axis=1), min_len)
        both[0] = both[-1] = True
        arm_signs = np.array([1.0, -1.0, -1.0, 1.0, -1.0, 1.0, -1.0])
        sym_arm = smooth(0.5 * (q_ref[:, 22:29] + q_ref[:, 29:36] * arm_signs), max(1, round(WRIST_SMOOTH_S * fps)))
        q_ref[:, 22:29] = sym_arm
        q_ref[:, 29:36] = sym_arm * arm_signs
        q_ref[:, 19:22] = 0.0
        q_ref[:, 4:6] = 0.0
        q_ref[:, 3:7] /= np.linalg.norm(q_ref[:, 3:7], axis=1, keepdims=True)
        return q_ref, np.stack([both, both], axis=1)

    assert running
    # Profile running clips can lose MediaPipe visibility on the far leg at the start of the video
    # (all 6 leg angles exactly zero); fill those frames from the opposite leg shifted by half a stride.
    L_idx, R_idx = qadr[:6], qadr[6:]
    mirror = np.array([1.0, -1.0, -1.0, 1.0, 1.0, -1.0])
    dead_L = np.all(np.abs(q_ref[:, L_idx]) < 1e-3, axis=1)
    if dead_L.any():
        shift = max(1, round(HALF_STRIDE_S * fps))
        for i in np.where(dead_L)[0]:
            q_ref[i, L_idx] = q_ref[min(n - 1, i + shift), R_idx] * mirror

    rel = np.zeros((n, 2, 3))
    for i in range(n):
        data.qpos[:] = q_ref[i]
        data.qpos[:2] = 0.0
        mujoco.mj_kinematics(model, data)
        for k in range(2):
            rel[i, k] = data.xpos[feet[k]]

    fwd = q_ref[-1, :2] - q_ref[0, :2]
    fwd = fwd / (np.linalg.norm(fwd) + 1e-8)
    v_rel = np.gradient(smooth(rel[:, :, :2].reshape(n, 4), max(1, round(SPEED_SMOOTH_S * fps))).reshape(n, 2, 2), 1 / fps, axis=0)
    v_fwd = np.einsum("nik,k->ni", v_rel, fwd)

    on = v_fwd < RUN_BACK_SPEED
    both = on.all(axis=1)
    on[both, np.argmax(v_fwd[both], axis=1)] = False
    on = np.stack([clean(on[:, k], min_len) for k in range(2)], axis=1)
    for idx in [0, 1, 2, n - 3, n - 2, n - 1]:
        if not on[idx].any():
            on[idx, int(np.argmin(v_fwd[idx]))] = True
    # Every switch between Left and Right stances in running goes through a >= 2-frame flight phase
    # so 50 Hz samples in between are airborne rather than jumping ZMP 35 cm in one control step.
    for i in range(1, n):
        if (on[i - 1, 0] and on[i, 1]) or (on[i - 1, 1] and on[i, 0]):
            on[max(3, i - 1)] = False
            if i < n - 3:
                on[i] = False
    for a, b in runs(~on.any(axis=1)):
        if b - a == 1 and a > 3 and b < n - 3:
            on[a - 1] = False

    # Foot odometry: integrate pelvis translation from the planted foot's backward velocity (-v_rel)
    # so world root speed matches the legs' actual stride reach instead of monocular lens distortion.
    v_pelvis = np.zeros((n, 2))
    stance_mask = on.any(axis=1)
    for i in range(n):
        if on[i, 0]:
            v_pelvis[i] = -v_rel[i, 0]
        elif on[i, 1]:
            v_pelvis[i] = -v_rel[i, 1]
    v_pelvis[~stance_mask] = v_pelvis[stance_mask].mean(axis=0)
    v_pelvis = smooth(v_pelvis, max(1, round(ODOM_SMOOTH_S * fps)))
    q_ref[:, :2] = q_ref[0, :2] + np.cumsum(v_pelvis / fps, axis=0)
    return q_ref, on


def contacts(robot: Robot, data, q: np.ndarray, fps: float, walking: bool) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Per frame and foot: on the floor (bool), ankle position, ankle yaw."""
    pos, yaw, clear = kinematics_foot_pos(robot, data, q)
    xy = smooth(pos[..., :2].reshape(len(q), 4), max(1, round(SPEED_SMOOTH_S * fps))).reshape(len(q), 2, 2)
    speed = np.linalg.norm(np.gradient(xy, 1 / fps, axis=0), axis=-1)
    on = (clear < CONTACT_CLEAR_M) & (speed < CONTACT_SPEED)
    if walking:  # no flight in a walk: the lower foot is down
        none = ~on.any(axis=1)
        on[none, np.argmin(clear[none], axis=1)] = True
    min_len = max(1, round(MIN_CONTACT_S * fps))
    on = np.stack([clean(on[:, k], min_len) for k in range(2)], axis=1)
    if walking:
        none = ~on.any(axis=1)
        on[none, np.argmin(clear[none], axis=1)] = True
    return on, pos, yaw


def feet_targets(on: np.ndarray, pos: np.ndarray, yaw: np.ndarray, sole: float, fps: float, has_flight: bool = False):
    """Target ankle position and yaw per frame and foot (see the module docstring, step 2)."""
    n = len(on)
    tgt = pos.copy()
    tyaw = yaw.copy()
    for k in range(2):
        stretches = runs(on[:, k])
        for a, b in stretches:
            tgt[a:b, k, :2] = np.median(pos[a:b, k, :2], axis=0)
            tgt[a:b, k, 2] = sole
            tyaw[a:b, k] = np.median(np.unwrap(yaw[a:b, k]))
        # Swings: the reference path, shifted from lift-off to landing so it starts and ends on the
        # planted spots.
        for (a0, b0), (a1, b1) in zip([(0, 0)] + stretches, stretches + [(n, n)]):
            s, e = b0, a1  # swing is [s, e)
            if e <= s:
                continue
            if has_flight:
                p0 = tgt[s - 1, k, :2] if s > 0 else pos[s, k, :2]
                p1 = tgt[e, k, :2] if e < n else pos[e - 1, k, :2]
                u = np.clip((np.arange(s, e) - s) / max(1, e - s - 1), 0.0, 1.0)
                u = u * u * (3 - 2 * u)
                tgt[s:e, k, :2] = (1 - u)[:, None] * p0 + u[:, None] * p1
                lift = sole + FLIGHT_BASE_M + FLIGHT_ARCH_M * np.sin(np.pi * (np.arange(s, e) - s + 1) / (e - s + 1))
                tgt[s:e, k, 2] = np.maximum(pos[s:e, k, 2], lift)
            else:
                start = tgt[s - 1, k] - pos[s - 1, k] if s > 0 else np.zeros(3)
                end = tgt[e, k] - pos[e, k] if e < n else start
                u = (np.arange(s, e) - s + 1) / (e - s + 1)
                u = u * u * (3 - 2 * u)  # smoothstep: no jump in velocity at either end
                tgt[s:e, k] = pos[s:e, k] + (1 - u)[:, None] * start + u[:, None] * end
                lift = sole + SWING_CLEAR_M + SWING_LIFT_M * np.sin(np.pi * (np.arange(s, e) - s + 1) / (e - s + 1))
                tgt[s:e, k, 2] = np.maximum(tgt[s:e, k, 2], lift)
    return tgt, tyaw


def ik_frame(robot: Robot, data, q: np.ndarray, q_ref: np.ndarray, feet_pos, feet_yaw, planted, com_xy, dofs, qadr,
             w_posture: float = W_POSTURE, local_ends=None, front=None, sole_h: float | None = None,
             max_swing_clear: float = SWING_SOLE_CLEAR_M) -> np.ndarray:
    """Pelvis position + leg joints so the feet and the CoM reach their targets (damped least squares)."""
    model = robot.model
    feet = foot_bodies(robot)
    local_ends = local_ends if local_ends is not None else sole_local(robot)
    front = front if front is not None else toe_ends(robot)
    sole_h = sole_h if sole_h is not None else sole_height(robot)
    cols = np.concatenate([[0, 1, 2], dofs])  # pelvis translation + legs, in qvel space
    lo, hi = model.jnt_range[[model.dof_jntid[d] for d in dofs]].T
    jp, jr = np.zeros((3, model.nv)), np.zeros((3, model.nv))
    for _ in range(IK_STEPS):
        data.qpos[:] = q
        mujoco.mj_kinematics(model, data)
        mujoco.mj_comPos(model, data)
        rows, errs, ws = [], [], []
        for k, side in enumerate(("left", "right")):
            ends = sole_points(robot, data, side)
            if planted[k]:
                # Planted flat (1): every capsule end on the floor, where the foot landed, facing its
                # yaw. Toe-off (2, the trailing foot in double support): only the two front ends stay;
                # the heel may rise. Flat all the way left the trailing foot 5-6 cm up: a human stride
                # is too long for the G1 to reach flat-footed.
                R = np.array([[np.cos(feet_yaw[k]), -np.sin(feet_yaw[k]), 0], [np.sin(feet_yaw[k]), np.cos(feet_yaw[k]), 0], [0, 0, 1]])
                for j, (p, r) in enumerate(ends):
                    if planted[k] == 2 and j not in front:
                        continue
                    want = feet_pos[k] + R @ local_ends[side][j]
                    want[2] = r
                    mujoco.mj_jac(model, data, jp, jr, p, feet[k])
                    rows.append(jp[:, cols].copy())
                    errs.append(want - p)
                    ws += [W_FOOT] * 3
            else:
                mujoco.mj_jacBody(model, data, jp, jr, feet[k])
                rows.append(jp[:, cols].copy())
                errs.append(feet_pos[k] - data.xpos[feet[k]])
                ws += [W_FOOT] * 3
            # No capsule end of either foot below the floor (a swinging toe dipping in lifted the whole
            # body when imitate.Motion grounded it); when the ankle target is lifted in swing, keep
            # all sole ends (including long toes like H1's, 14 cm ahead of the ankle) above C1's 1.5 cm
            # contact threshold using the swinging leg's own joints so the planted foot stays flat.
            swing_clear = max(SWING_CLEAR_M, min(max_swing_clear, float(feet_pos[k][2] - sole_h)))
            for p, r in ends:
                low = r + (0.0 if planted[k] else swing_clear)
                if p[2] < low:
                    mujoco.mj_jac(model, data, jp, jr, p, feet[k])
                    row = jp[2:3, cols].copy()
                    if any(planted) and not planted[k]:
                        row[:, :3] = 0.0
                    rows.append(row)
                    errs.append([low - p[2]])
                    ws += [W_FLOOR]
        jc = np.zeros((3, model.nv))
        mujoco.mj_jacSubtreeCom(model, data, jc, 1)
        rows.append(jc[:2, cols])
        errs.append(com_xy - data.subtree_com[1][:2])
        ws += [W_COM] * 2
        h = np.zeros((1, len(cols)))
        h[0, 2] = 1
        rows.append(h)
        errs.append([q_ref[2] - q[2]])
        ws += [W_HEIGHT]
        post = np.zeros((len(dofs), len(cols)))
        post[:, 3:] = np.eye(len(dofs))
        rows.append(post)
        errs.append(q_ref[qadr] - q[qadr])
        ws += [w_posture] * len(dofs)
        J = np.vstack(rows)
        e = np.concatenate([np.atleast_1d(x) for x in errs])
        w = np.array(ws)
        dq = np.linalg.solve(J.T @ (w[:, None] * J) + DAMPING * np.eye(len(cols)), J.T @ (w * e))
        q = q.copy()
        q[:3] += dq[:3]
        q[qadr] = np.clip(q[qadr] + dq[3:], lo, hi)
    return q


def support_points(robot: Robot, data, q: np.ndarray, planted) -> np.ndarray:
    """Capsule ends of the planted feet that are on the floor (as checks.C2 counts them)."""
    data.qpos[:] = q
    mujoco.mj_kinematics(robot.model, data)
    return np.array([p[:2].copy() for k, s in enumerate(SIDES) if planted[k]
                     for p, r in sole_points(robot, data, s) if p[2] - r < CONTACT_CLEAR_M / 2])


def com_of(model, data, qs: np.ndarray) -> np.ndarray:
    out = np.zeros((len(qs), 3))
    for i, q in enumerate(qs):
        data.qpos[:] = q
        mujoco.mj_kinematics(model, data)
        mujoco.mj_comPos(model, data)
        out[i] = data.subtree_com[1]
    return out


def zmp_of(com: np.ndarray, fps: float) -> np.ndarray:
    dt = 1 / fps
    acc = np.gradient(np.gradient(smooth(com, max(1, round(ACC_SMOOTH_S * fps))), dt, axis=0), dt, axis=0)
    return com[:, :2] - com[:, 2:3] / G * acc[:, :2]


def double_support(on: np.ndarray, fps: float) -> np.ndarray:
    """Delay each lift-off until the other foot has been down DOUBLE_SUPPORT_S."""
    on = on.copy()
    ds = max(1, round(DOUBLE_SUPPORT_S * fps))
    for k in range(2):
        for a, b in runs(on[:, k]):
            # The other foot lands at the end of this stance (or before): keep this one down until ds
            # frames after that landing.
            landings = [a2 for a2, _ in runs(on[:, 1 - k]) if a < a2 <= b + 1]
            if landings:
                on[b:min(len(on), landings[-1] + ds), k] = True
    return on


def foot_modes(on: np.ndarray) -> np.ndarray:
    """0 swinging, 1 planted flat, 2 toe-off: in double support, the foot whose stance ends first."""
    mode = on.astype(int)
    ends = np.full(on.shape, len(on))
    for k in range(2):
        for a, b in runs(on[:, k]):
            ends[a:b, k] = b
    both = on.all(axis=1)
    trailing = np.argmin(ends, axis=1)
    for i in np.where(both)[0]:
        if ends[i, 0] != ends[i, 1]:
            mode[i, trailing[i]] = 2
    return mode


def desired_zmp(robot: Robot, data, qs: np.ndarray, on: np.ndarray, fps: float) -> np.ndarray:
    """Center of the planted foot; in double support, moving from the foot that lifts next to the
    one that stays; in flight, interpolating between take-off and landing support centers."""
    centers = np.zeros((len(qs), 2, 2))
    toes = np.zeros((len(qs), 2, 2))
    front = toe_ends(robot)
    for i, q in enumerate(qs):
        data.qpos[:] = q
        mujoco.mj_kinematics(robot.model, data)
        for k, s in enumerate(SIDES):
            ends = sole_points(robot, data, s)
            centers[i, k] = np.mean([p[:2] for p, _ in ends], axis=0)
            toes[i, k] = np.mean([ends[j][0][:2] for j in front], axis=0)
    p = np.zeros((len(qs), 2))
    both = on.all(axis=1)
    none = ~on.any(axis=1)
    for i in range(len(qs)):
        if both[i]:
            p[i] = 0.5 * (centers[i, 0] + centers[i, 1])
        elif not none[i]:
            p[i] = centers[i, int(np.argmax(on[i]))]
    for a, b in runs(both):
        after = on[min(b, len(on) - 1)]
        before = on[max(a - 1, 0)]
        # Symmetric two-foot stance (e.g. jumping jacks): keep desired ZMP centered between both feet.
        if (not after.any() or after.all()) and (not before.any() or before.all()):
            continue
        stay = int(np.argmax(after)) if not after.all() else 0
        start = int(np.argmax(before)) if not before.all() else 1 - stay
        u = (np.arange(a, b) - a + 0.5) / (b - a)
        # It leaves from the trailing foot's toe: that foot's heel is up (toe-off).
        p[a:b] = (1 - u)[:, None] * toes[a:b, start] + u[:, None] * centers[a:b, stay]
    for a, b in runs(none):
        p0 = p[max(0, a - 1)]
        p1 = p[min(len(qs) - 1, b)]
        u = (np.arange(a, b) - a + 1) / (b - a + 1)
        p[a:b] = (1 - u)[:, None] * p0 + u[:, None] * p1
    return p


def com_for_zmp(p: np.ndarray, height: float, fps: float, near: np.ndarray) -> np.ndarray:
    """CoM path whose cart-table ZMP is p: minimize |c - h/g c'' - p|^2 + STAY_NEAR_REF |c - near|^2."""
    n = len(p)
    k = height / G * fps * fps
    A = np.zeros((n, n))
    for i in range(1, n - 1):
        A[i, i - 1], A[i, i], A[i, i + 1] = -k, 1 + 2 * k, -k
    A[0, 0] = A[-1, -1] = 1  # ends: ZMP = CoM (standing still)
    lhs = A.T @ A + STAY_NEAR_REF * np.eye(n)
    return np.linalg.solve(lhs, A.T @ p + STAY_NEAR_REF * near)


def solve_ik(robot: Robot, data, q_ref, tgt, tyaw, on, com_xy, dofs, qadr, w_posture: float = W_POSTURE,
             max_swing_clear: float = SWING_SOLE_CLEAR_M) -> np.ndarray:
    qs = q_ref.copy()
    local_ends, front, sole_h = sole_local(robot), toe_ends(robot), sole_height(robot)
    for i in range(len(q_ref)):
        # Warm start from the previous frame's solution, with this frame's arms, waist and pelvis turn.
        start = q_ref[i].copy()
        if i:
            start[:3] = qs[i - 1][:3] + (q_ref[i][:3] - q_ref[i - 1][:3])
            start[qadr] = qs[i - 1][qadr]
        qs[i] = ik_frame(robot, data, start, q_ref[i], tgt[i], tyaw[i], on[i], com_xy[i], dofs, qadr,
                         w_posture, local_ends, front, sole_h, max_swing_clear)
    return qs


def zmp_outside(robot: Robot, data, qs, on, zmp) -> np.ndarray:
    from .checks import distance_outside

    return np.array([distance_outside(zmp[i], support_points(robot, data, qs[i], on[i])) for i in range(len(qs))])


def balance(clip: str, rounds: int = ROUNDS, log=print, robot_id: str | None = None) -> tuple[dict, dict]:
    raw = json.loads(motion_path(clip).read_text())
    robot = load(robot_id or raw.get("robot_package", "g1"))
    model = robot.model
    data = mujoco.MjData(model)
    if robot.id == "g1":
        motion = Motion(motion_path(clip), model)  # smoothed and grounded, as training would see it
        q_ref, fps = motion.qpos.copy(), motion.fps
    else:
        q_ref, fps = np.array(raw["qpos"], dtype=float), float(raw["fps"])
        for i in range(1, len(q_ref)):
            if np.dot(q_ref[i - 1, 3:7], q_ref[i, 3:7]) < 0:
                q_ref[i, 3:7] = -q_ref[i, 3:7]
    jumping = "jumping-jacks" in clip or "jacks" in clip or "jump" in clip
    running = "correr" in clip or "run" in clip
    has_flight = jumping or running
    dofs, qadr = leg_dofs(model)
    if has_flight:
        q_ref, on = prepare_flight_clip(robot, data, q_ref, fps, jumping, running)
        pos, yaw, _ = kinematics_foot_pos(robot, data, q_ref)
    else:
        on, pos, yaw = contacts(robot, data, q_ref, fps, walking=True)
        on = double_support(on, fps)
    tgt, tyaw = feet_targets(on, pos, yaw, sole_height(robot), fps, has_flight=has_flight)
    mode = foot_modes(on)
    com_ref = com_of(model, data, q_ref)
    height = float(np.mean(com_ref[:, 2]))
    # The pelvis height asked for is the reference's, smoothed over HEIGHT_SMOOTH_S: grounding it frame
    # by frame left a 3 m/s^2 median pelvis acceleration in a 0.6 m/s walk (~1 is a real walk's).
    q_ref[:, 2] = smooth(q_ref[:, 2:3], max(1, round(HEIGHT_SMOOTH_S * fps)))[:, 0]
    if has_flight:
        for a, b in runs(~on.any(axis=1)):
            dt_f = (b - a + 1) / fps
            t_f = (np.arange(a, b) - a + 1) / (b - a + 1)
            q_ref[a:b, 2] += 0.5 * G * (dt_f ** 2) * t_f * (1.0 - t_f) + FLIGHT_PELVIS_M * np.sin(np.pi * t_f)
        q_ref[:, 3:7] = smooth(q_ref[:, 3:7], max(1, round(WRIST_SMOOTH_S * fps)))
        q_ref[:, 3:7] /= np.linalg.norm(q_ref[:, 3:7], axis=1, keepdims=True)
    smooth_jnts = [model.jnt_qposadr[j] for j in range(model.njnt)
                   if "wrist" in model.joint(j).name or (has_flight and "waist" in model.joint(j).name)]
    if smooth_jnts:
        q_ref[:, smooth_jnts] = smooth(q_ref[:, smooth_jnts], max(1, round(WRIST_SMOOTH_S * fps)))
    max_swing_clear = FLIGHT_SOLE_CLEAR_M if has_flight else SWING_SOLE_CLEAR_M
    # First pass: feet planted, CoM where the reference has it; it gives the feet's real spots.
    qs = solve_ik(robot, data, q_ref, tgt, tyaw, mode, com_ref[:, :2], dofs, qadr, max_swing_clear=max_swing_clear)
    p = desired_zmp(robot, data, qs, on, fps)
    history = []
    if has_flight:
        # Solve on the exact 50 Hz grid used by checks.C2, weighting stance steps (where a foot is on
        # the floor) so flight intervals remain free to curve the CoM smoothly between stances.
        n = len(q_ref)
        duration = (n - 1) / fps
        steps50 = int(duration / CONTROL_DT)
        P = np.zeros((steps50, n))
        stance50 = np.zeros(steps50, dtype=bool)
        for i in range(steps50):
            t = min(i * CONTROL_DT, duration)
            f = t * fps
            i0 = min(int(f), n - 2)
            a = f - i0
            P[i, i0] = 1.0 - a
            P[i, i0 + 1] = a
            stance50[i] = bool(on[i0].any() or on[i0 + 1].any())
        win = max(1, round(ACC_SMOOTH_S / CONTROL_DT))
        I_s = np.eye(steps50)
        S = np.column_stack([smooth(I_s[:, j:j + 1], win)[:, 0] for j in range(steps50)])
        G1 = np.gradient(np.eye(steps50), CONTROL_DT, axis=0)
        G2 = G1 @ G1
        A50 = (S - (height / G) * (G2 @ S)) @ P
        w50 = np.where(stance50, 1.0, 0.02)
        D2 = np.gradient(np.gradient(np.eye(n), 1 / fps, axis=0), 1 / fps, axis=0)
        lhs = A50.T @ (w50[:, None] * A50) + 1e-4 * (D2.T @ D2) + 5e-4 * np.eye(n)
        p50 = P @ p
        aim50 = p50.copy()
        flight_rounds = max(rounds, 8)
        for r in range(flight_rounds + 1):
            target = np.column_stack([np.linalg.solve(lhs, A50.T @ (w50 * aim50[:, j]) + 5e-4 * com_ref[:, j]) for j in range(2)])
            qs = solve_ik(robot, data, q_ref, tgt, tyaw, mode, target, dofs, qadr, max_swing_clear=max_swing_clear)
            com = com_of(model, data, qs)
            com50_s = S @ (P @ com)
            zmp50 = com50_s[:, :2] - com50_s[:, 2:3] / G * (G2 @ com50_s)[:, :2]
            zmp = zmp_of(com, fps)
            out = zmp_outside(robot, data, qs, on, zmp)
            finite = out[np.isfinite(out)]
            feet_err = max(np.linalg.norm(foot_positions(robot, data, qs[i]) - tgt[i], axis=1).max() for i in range(len(qs)))
            history.append({"round": r, "zmp_out_share": float(np.mean(finite > 0.03)) if len(finite) else 0.0,
                            "zmp_out_p95_cm": float(100 * np.percentile(finite, 95)) if len(finite) else 0.0,
                            "com_err_cm": float(100 * np.percentile(np.linalg.norm(com[:, :2] - target, axis=1), 95)),
                            "feet_err_cm": float(100 * feet_err)})
            h = history[-1]
            log(f"round {r}: ZMP > 3 cm outside the feet in {100 * h['zmp_out_share']:.0f} % of stance frames (p95 {h['zmp_out_p95_cm']:.1f} cm); "
                f"CoM off its target p95 {h['com_err_cm']:.1f} cm; feet off target ≤ {h['feet_err_cm']:.1f} cm")
            if r == flight_rounds:
                break
            aim50 += ROUND_GAIN * (p50 - zmp50)
    else:
        aim = p.copy()
        for r in range(rounds + 1):
            target = np.column_stack([com_for_zmp(aim[:, j], height, fps, com_ref[:, j]) for j in range(2)])
            qs = solve_ik(robot, data, q_ref, tgt, tyaw, mode, target, dofs, qadr, max_swing_clear=max_swing_clear)
            com = com_of(model, data, qs)
            zmp = zmp_of(com, fps)
            out = zmp_outside(robot, data, qs, on, zmp)
            feet_err = max(np.linalg.norm(foot_positions(robot, data, qs[i]) - tgt[i], axis=1).max() for i in range(len(qs)))
            history.append({"round": r, "zmp_out_share": float(np.mean(out > 0.03)), "zmp_out_p95_cm": float(100 * np.percentile(out, 95)),
                            "com_err_cm": float(100 * np.percentile(np.linalg.norm(com[:, :2] - target, axis=1), 95)),
                            "feet_err_cm": float(100 * feet_err)})
            h = history[-1]
            log(f"round {r}: ZMP > 3 cm outside the feet in {100 * h['zmp_out_share']:.0f} % of frames (p95 {h['zmp_out_p95_cm']:.1f} cm); "
                f"CoM off its target p95 {h['com_err_cm']:.1f} cm; feet off target ≤ {h['feet_err_cm']:.1f} cm")
            if r == rounds:
                break
            aim += ROUND_GAIN * (p - zmp)  # ask for more where the robot fell short
        # Polish: frame-by-frame IK leaves jitter in the legs (joint acceleration p95 68 rad/s^2 against
        # the reference's 49). Smooth, then solve once more with the smoothed legs as the posture to keep,
        # so the feet and the CoM are back on target.
        smoothed = qs.copy()
        smoothed[:, :3] = smooth(qs[:, :3], max(1, round(POLISH_SMOOTH_S * fps)))
        smoothed[:, qadr] = smooth(qs[:, qadr], max(1, round(POLISH_SMOOTH_S * fps)))
        qs = solve_ik(robot, data, smoothed, tgt, tyaw, mode, target, dofs, qadr, W_POLISH, max_swing_clear=max_swing_clear)
    com = com_of(model, data, qs)
    zmp = zmp_of(com, fps)
    out = zmp_outside(robot, data, qs, on, zmp)
    finite = out[np.isfinite(out)]
    log(f"polished: ZMP > 3 cm outside the feet in {100 * np.mean(finite > 0.03):.0f} % of stance frames (p95 {100 * np.percentile(finite, 95):.1f} cm)")
    out_motion = {**raw, "clip_id": f"{raw['clip_id']}-balanced", "qpos": qs.round(5).tolist(),
                  "balanced_by": "training.balance", "contacts": on.astype(int).tolist()}
    shift = com[:, :2] - com_ref[:, :2]
    return out_motion, {"history": history, "contact_share": on.mean(axis=0).tolist(),
                        "com_shift_cm_p95": float(100 * np.percentile(np.linalg.norm(shift, axis=1), 95))}


def foot_positions(robot: Robot, data, q) -> np.ndarray:
    data.qpos[:] = q
    mujoco.mj_kinematics(robot.model, data)
    return data.xpos[foot_bodies(robot)].copy()


def main() -> None:
    p = argparse.ArgumentParser(prog="python -m training.balance", description=__doc__.split("\n")[0])
    p.add_argument("clip", help="clip id in physics/motions/ or a RobotMotion .json")
    p.add_argument("--rounds", type=int, default=ROUNDS)
    p.add_argument("--robot", help="robot package (robots/<id>.json); default: the motion's robot_package, else g1")
    args = p.parse_args()
    motion, info = balance(args.clip, args.rounds, robot_id=args.robot)
    OUT.mkdir(exist_ok=True)
    path = OUT / f"{motion['clip_id']}.json"
    path.write_text(json.dumps(motion))
    print(f"feet on the floor: left {100 * info['contact_share'][0]:.0f} %, right {100 * info['contact_share'][1]:.0f} %; "
          f"CoM moved up to {info['com_shift_cm_p95']:.1f} cm (p95)")
    print(f"-> {path}")


if __name__ == "__main__":
    main()
