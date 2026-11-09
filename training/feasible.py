"""Can a robot do this motion? The physical half of checks C1 and C2, for any robot package.

    uv run --project training python -m training.feasible <RobotMotion.json> [--robot h1]

training.checks runs C1-C4 on the G1's training environment. Before a second robot trains, the same
questions are asked of it here, with the package (robots/<id>.json) instead of the G1's names:

- Kinematics: feet sunk in the floor, both feet up in a walk, joints asked past their range.
- Balance (C2): the ZMP of the motion's center of mass against the soles on the floor.
- Held replay (C1): the pelvis is carried along the reference (as if on a crane) while the servos
  aim at its joints, LEAD_S ahead (the policy sees 250 ms ahead, imitate.LOOKAHEAD_S, so it can
  lead its motors too). With the balance taken care of, can the legs follow, do the feet touch the
  floor when the reference says they do, and does a planted foot stay put?

Thresholds are C1's and C2's own (diagnose_reference.py, checks.py), so a robot passes here what
the G1 passes there.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import mujoco
import numpy as np

from .balance import zmp_of
from .checks import ZMP_SHARE, ZMP_TOL_M, distance_outside
from .diagnose_reference import CONTACT_AGREE, CONTACT_M, FLOAT_M, FLOAT_SHARE, RANGE_SHARE, RANGE_TOL_RAD, SUNK_M, SUNK_SHARE, TRACK_RAD
from .robot import Robot, load, sole_ends

# The servos may aim ahead of the reference by up to the policy's lookahead; the best lead for the
# legs is the one reported (C1's "led" pass does the same per motor).
LEADS_S = (0.0, 0.05, 0.1, 0.15, 0.2, 0.25)
# Slip, as C1 measures it: how far the lowest foot moves over 0.3 s while on the floor at both
# ends (diagnose_reference.SLIP_WINDOW_S), in the reference. Reported, not judged (C1 does not either).
from .diagnose_reference import SLIP_WINDOW_S  # noqa: E402


def _sample(qpos: np.ndarray, fps: float, t: float) -> np.ndarray:
    """The reference at time t: linear between frames, the pelvis turn renormalized."""
    x = min(max(t * fps, 0.0), len(qpos) - 1.0)
    i = int(x)
    j = min(i + 1, len(qpos) - 1)
    a, b = qpos[i], qpos[j].copy()
    if np.dot(a[3:7], b[3:7]) < 0:
        b[3:7] = -b[3:7]
    q = a + (b - a) * (x - i)
    q[3:7] /= np.linalg.norm(q[3:7])
    return q


def _clearance(robot: Robot, data: mujoco.MjData, floor: int) -> list[float]:
    return [min(mujoco.mj_geomDistance(robot.model, data, g, floor, 1.0, None) for g in robot.feet[s]) for s in ("left", "right")]


def kinematic(robot: Robot, qpos: np.ndarray, fps: float, walking: bool) -> dict:
    """Also each frame's feet on the floor (`contact_ref`, within CONTACT_M, as C1 reads the
    reference) and the slip of a planted foot."""
    m, d = robot.model, mujoco.MjData(robot.model)
    feet = [robot.points["left_foot"].body, robot.points["right_foot"].body]
    contact_ref, feet_xy, lowest = [], [], []
    floor = m.geom("floor").id
    hinge = [j for j in range(m.njnt) if m.jnt_type[j] == mujoco.mjtJoint.mjJNT_HINGE]
    qadr = np.array([m.jnt_qposadr[j] for j in hinge])
    lo, hi = m.jnt_range[hinge].T
    sunk, floating, past, com, support = 0, 0, 0, [], []
    for q in qpos:
        d.qpos[:] = q
        mujoco.mj_kinematics(m, d)
        mujoco.mj_comPos(m, d)
        clear = _clearance(robot, d, floor)
        contact_ref.append([c < CONTACT_M for c in clear])
        feet_xy.append([d.xpos[b][:2].copy() for b in feet])
        lowest.append(int(np.argmin(clear)))
        sunk += min(clear) < -SUNK_M
        floating += min(clear) > FLOAT_M
        past += bool(np.any((q[qadr] < lo - RANGE_TOL_RAD) | (q[qadr] > hi + RANGE_TOL_RAD)))
        com.append(d.subtree_com[1].copy())
        support.append(np.array([p[:2] for k, s in enumerate(("left", "right")) if clear[k] < CONTACT_M
                                 for p, r in sole_ends(robot, d, s) if p[2] - r < CONTACT_M]))
    zmp = zmp_of(np.array(com), fps)
    outside = np.array([distance_outside(zmp[i], support[i]) for i in range(len(qpos))])
    finite = outside[np.isfinite(outside)]
    zmp_out = float(np.mean(outside > ZMP_TOL_M)) if walking else (float(np.mean(finite > ZMP_TOL_M)) if len(finite) else 1.0)
    n = len(qpos)
    w = max(1, int(round(SLIP_WINDOW_S * fps)))
    slip = [np.linalg.norm(feet_xy[i + w][s] - feet_xy[i][s]) / SLIP_WINDOW_S for i in range(n - w)
            if (s := lowest[i]) == lowest[i + w] and contact_ref[i][s] and contact_ref[i + w][s]]
    return {"sunk_share": sunk / n, "float_share": floating / n if walking else 0.0, "range_share": past / n,
            "zmp_out_share": zmp_out, "contact_ref": np.array(contact_ref),
            "slip_mps": float(np.median(slip)) if slip else None}


def held(robot: Robot, qpos: np.ndarray, fps: float, contacts: np.ndarray | None, lead: float) -> dict:
    """The reference with the pelvis carried along it and the servos aiming `lead` seconds ahead."""
    m, d = robot.model, mujoco.MjData(robot.model)
    floor = m.geom("floor").id
    dt = m.opt.timestep
    joints = [m.actuator_trnid[i, 0] for i in range(m.nu)]
    qadr = np.array([m.jnt_qposadr[j] for j in joints])
    legs = np.array([any(p in m.joint(j).name for p in ("hip", "knee", "ankle")) for j in joints])
    duration = (len(qpos) - 1) / fps
    d.qpos[:] = qpos[0]
    mujoco.mj_forward(m, d)
    err2, agree, n = np.zeros(m.nu), [], 0
    carried = np.zeros(m.nv)
    every = max(1, int(round(1 / (fps * dt))))  # measure once per reference frame
    for k in range(int(duration / dt)):
        t = k * dt
        ref, ref_next = _sample(qpos, fps, t), _sample(qpos, fps, t + dt)
        # Only the pelvis is carried (position and velocity); the joints keep their own state.
        mujoco.mj_differentiatePos(m, carried, dt, np.concatenate([ref[:7], d.qpos[7:]]), np.concatenate([ref_next[:7], d.qpos[7:]]))
        d.qpos[:7] = ref[:7]
        d.qvel[:6] = carried[:6]
        d.ctrl[:] = np.clip(_sample(qpos, fps, t + lead)[qadr], *m.actuator_ctrlrange.T)
        mujoco.mj_step(m, d)
        if k % every:
            continue
        n += 1
        err2 += (d.qpos[qadr] - _sample(qpos, fps, t + dt)[qadr]) ** 2
        # "On the floor" within CONTACT_M, as the reference is read (with the pelvis carried, a foot
        # never bears weight and never settles: C1 learned that requiring real contact misreads it).
        touching = np.array(_clearance(robot, d, floor)) < CONTACT_M
        frame = min(int(round((t + dt) * fps)), len(qpos) - 1)
        agree.extend(touching == contacts[frame])
    rms = np.sqrt(err2 / max(n, 1))
    return {"lead_s": lead, "legs_rms": float(rms[legs].mean()), "contact_agree": float(np.mean(agree))}


def check(path: Path, robot_id: str | None = None) -> dict:
    motion = json.loads(path.read_text())
    robot = load(robot_id or motion.get("robot_package", "g1"))
    qpos, fps = np.array(motion["qpos"], dtype=float), float(motion["fps"])
    walking = any(w in motion["clip_id"] for w in ("caminar", "walk"))
    kin = kinematic(robot, qpos, fps, walking)
    best = min((held(robot, qpos, fps, kin["contact_ref"], lead) for lead in LEADS_S), key=lambda h: h["legs_rms"])
    problems = []
    if kin["sunk_share"] > SUNK_SHARE:
        problems.append(f"feet sunk > {100 * SUNK_M:.0f} cm in {100 * kin['sunk_share']:.0f} % of frames")
    if kin["float_share"] > FLOAT_SHARE:
        problems.append(f"both feet up in a walk in {100 * kin['float_share']:.0f} % of frames")
    if kin["range_share"] > RANGE_SHARE:
        problems.append(f"joints past their range in {100 * kin['range_share']:.0f} % of frames")
    if kin["zmp_out_share"] > ZMP_SHARE:
        problems.append(f"ZMP outside the soles in {100 * kin['zmp_out_share']:.0f} % of frames: not in balance")
    if best["legs_rms"] > TRACK_RAD:
        problems.append(f"legs {best['legs_rms']:.3f} rad off the reference with the pelvis held")
    if best["contact_agree"] < CONTACT_AGREE:
        problems.append(f"feet touch the floor as the reference says only {100 * best['contact_agree']:.0f} % of the time")
    return {"robot": robot.name, "clip": motion["clip_id"], "kinematic": kin, "held": best, "problems": problems}


def main() -> None:
    p = argparse.ArgumentParser(prog="python -m training.feasible", description=__doc__.split("\n\n")[0])
    p.add_argument("motion", type=Path, help="a RobotMotion .json")
    p.add_argument("--robot", help="robot package; default: the motion's robot_package, else g1")
    args = p.parse_args()
    r = check(args.motion, args.robot)
    k, h = r["kinematic"], r["held"]
    print(f"{r['robot']} · {r['clip']}")
    print(f"  sunk {100 * k['sunk_share']:.0f} % · both feet up {100 * k['float_share']:.0f} % · past range {100 * k['range_share']:.0f} % · "
          f"ZMP outside {100 * k['zmp_out_share']:.0f} %")
    slip = "—" if k["slip_mps"] is None else f"{k['slip_mps']:.3f} m/s"
    print(f"  planted foot slides {slip} (reference, over {1000 * SLIP_WINDOW_S:.0f} ms)")
    print(f"  held, aiming {1000 * h['lead_s']:.0f} ms ahead: legs {h['legs_rms']:.3f} rad · feet on the floor as the reference {100 * h['contact_agree']:.0f} %")
    print("  OK: feasible" if not r["problems"] else "  NO: " + "; ".join(r["problems"]))


if __name__ == "__main__":
    main()
