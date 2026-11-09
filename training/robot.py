"""A humanoid as a package: its MuJoCo model plus a small JSON that says where its parts are.

Tridi should work on any humanoid (docs/plan-v2.md, pillar D). The code must not know a robot by its
body names, so each robot is a file in robots/<id>.json:

- `mjcf`: the scene to load, relative to physics/models/ (as policy.json names it)
- `keyframe`: the standing pose
- `actuators`: "position" servos already (G1), or "torque" motors that the loader turns into PD
  servos with the package's gains, so every robot takes joint targets the same way
- `points`: pelvis, torso, head, feet and hands, each a body or a geom, with an optional offset
- `feet`: the collision geoms of each sole (names), or a body whose collision geoms are the sole

`python -m training.robot g1 h1` loads each package and checks it: the parts exist, it stands on
its own servos at the keyframe, and how fast its physics runs on this Mac. robots/README.md has the
format and the last results.
"""

from __future__ import annotations

import argparse
import json
import time
from dataclasses import dataclass, field
from pathlib import Path

import mujoco
import numpy as np

ROOT = Path(__file__).resolve().parent.parent
ROBOTS = ROOT / "robots"
MODELS = ROOT / "physics" / "models"

POINTS = ("pelvis", "torso", "head", "left_foot", "right_foot", "left_hand", "right_hand",
          "left_knee", "right_knee", "left_shoulder", "right_shoulder", "left_elbow", "right_elbow")

# The servo check: the pelvis held at the keyframe (as C1 holds it, training/checks.py) and the
# servos asked to keep the standing pose for HOLD_S. No robot here stands without a policy (the
# G1's training servos are soft on purpose: kp 75), so the check is that the servos hold the pose,
# not that the robot balances. 2 s is past the settling of the slowest servo (H1's 40 N m/rad
# ankle settles in under 1 s); errors count after SETTLE_S.
HOLD_S = 2.0
SETTLE_S = 1.0
# Passing: every joint within 0.1 rad (6 degrees) of its target while the feet carry the weight.
# A servo that misses by more than that under the robot's own weight leaves a policy no room.
HOLD_ERR_RAD = 0.1
# The keyframe must put the soles on the floor: within 2 cm (a robot spawned higher drops and
# bounces at every reset; lower, it starts inside the floor).
SOLE_GAP_M = 0.02
# How long it stands with no help and no policy, up to this: information, not a pass mark.
UNAIDED_S = 5.0
FALL_FRACTION = 0.6  # fallen once the pelvis is below 60 % of its standing height
# Physics speed: this many steps on one core, no policy, standing. Enough for a stable rate (about a
# second for the G1) without heating the Mac.
SPEED_STEPS = 4000


@dataclass
class Point:
    body: int
    offset: np.ndarray  # in the body's frame

    def pos(self, data: mujoco.MjData) -> np.ndarray:
        return data.xpos[self.body] + data.xmat[self.body].reshape(3, 3) @ self.offset


@dataclass
class Robot:
    id: str
    name: str
    mjcf: str
    model: mujoco.MjModel
    home_qpos: np.ndarray
    home_ctrl: np.ndarray  # joint targets of the standing pose
    points: dict[str, Point]
    feet: dict[str, list[int]]  # sole geom ids per side
    package: dict = field(repr=False)

    @property
    def nu(self) -> int:
        return self.model.nu

    def joint_names(self) -> list[str]:
        return [self.model.joint(self.model.actuator_trnid[i, 0]).name for i in range(self.model.nu)]


def _servo(spec: mujoco.MjSpec, gains: list[dict]) -> None:
    """Torque motors -> PD position servos: force = kp (target - q) - kd q', clipped to the motor's own
    torque limit; the target range is the joint's range."""
    for act in spec.actuators:
        joint = spec.joint(act.target)
        gain = next((g for g in gains if g["match"] in act.target), None)
        if gain is None:
            raise ValueError(f"no PD gain matches actuator {act.name!r} (joint {act.target!r})")
        limit = np.array(act.ctrlrange, dtype=float)
        act.gaintype = mujoco.mjtGain.mjGAIN_FIXED
        act.biastype = mujoco.mjtBias.mjBIAS_AFFINE
        act.gainprm[0] = gain["kp"]
        act.biasprm[:3] = [0.0, -gain["kp"], -gain["kd"]]
        act.forcerange = limit
        act.forcelimited = mujoco.mjtLimited.mjLIMITED_TRUE
        act.ctrlrange = np.array(joint.range, dtype=float)
        act.ctrllimited = mujoco.mjtLimited.mjLIMITED_TRUE


def _point(model: mujoco.MjModel, entry: dict) -> Point:
    offset = np.array(entry.get("offset", [0.0, 0.0, 0.0]), dtype=float)
    if "geom" in entry:
        geom = model.geom(entry["geom"])
        return Point(int(geom.bodyid[0]), np.array(geom.pos, dtype=float) + offset)
    return Point(model.body(entry["body"]).id, offset)


def _sole(model: mujoco.MjModel, entry) -> list[int]:
    if isinstance(entry, list):
        return [model.geom(name).id for name in entry]
    body = model.body(entry).id
    return [g for g in range(model.ngeom) if model.geom_bodyid[g] == body and (model.geom_contype[g] or model.geom_conaffinity[g])]


def load(robot_id: str) -> Robot:
    package = json.loads((ROBOTS / f"{robot_id}.json").read_text())
    spec = mujoco.MjSpec.from_file(str(MODELS / package["mjcf"]))
    act = package["actuators"]
    if act["kind"] == "torque":
        _servo(spec, act["pd"])
    elif act["kind"] != "position":
        raise ValueError(f"{robot_id}: actuators.kind must be position or torque, not {act['kind']!r}")
    model = spec.compile()
    key = model.key(package["keyframe"])
    home_qpos = key.qpos.copy()
    # The standing targets are the keyframe's joint angles: a keyframe's own ctrl is only trusted
    # for position servos (a torque model's ctrl were torques).
    joints = [model.actuator_trnid[i, 0] for i in range(model.nu)]
    home_ctrl = np.array([home_qpos[model.jnt_qposadr[j]] for j in joints])
    if act["kind"] == "position" and np.any(key.ctrl):
        home_ctrl = key.ctrl.copy()
    points = {name: _point(model, package["points"][name]) for name in POINTS}
    feet = {side: _sole(model, package["feet"][side]) for side in ("left", "right")}
    for side, geoms in feet.items():
        if not geoms:
            raise ValueError(f"{robot_id}: no sole geoms for the {side} foot")
    return Robot(robot_id, package["name"], package["mjcf"], model, home_qpos, home_ctrl, points, feet, package)


def sole_ends(robot: Robot, data: mujoco.MjData, side: str) -> list[tuple[np.ndarray, float]]:
    """Where a foot can push on the floor: the ends of its sole capsules (a sphere is its own end),
    as (world center, radius). Needs kinematics. The generic form of checks.sole_points."""
    out = []
    for g in robot.feet[side]:
        center = data.geom_xpos[g]
        if robot.model.geom_type[g] == mujoco.mjtGeom.mjGEOM_CAPSULE:
            axis = data.geom_xmat[g].reshape(3, 3)[:, 2]
            half = robot.model.geom_size[g][1]
            out += [(center + half * axis, float(robot.model.geom_size[g][0])), (center - half * axis, float(robot.model.geom_size[g][0]))]
        else:
            out.append((center.copy(), float(robot.model.geom_size[g][0])))
    return out


def measure(robot: Robot) -> dict:
    """Sizes at the keyframe: what retargeting scales by (a short robot takes a shorter step)."""
    m = robot.model
    d = mujoco.MjData(m)
    d.qpos[:] = robot.home_qpos
    mujoco.mj_forward(m, d)
    p = {name: point.pos(d) for name, point in robot.points.items()}
    sole = min(d.geom_xpos[g][2] - m.geom_size[g][0] for side in robot.feet.values() for g in side)
    hip_z = d.xpos[robot.points["pelvis"].body][2]
    return {
        "height_m": float(p["head"][2] - sole),
        "pelvis_m": float(hip_z - sole),
        "leg_m": float(hip_z - np.mean([p["left_foot"][2], p["right_foot"][2]])),
        "arm_span_m": float(np.linalg.norm(p["left_hand"] - p["right_hand"])),
        "mass_kg": float(m.body_subtreemass[1]),
        "dof": int(m.nu),
    }


def _start(robot: Robot) -> mujoco.MjData:
    d = mujoco.MjData(robot.model)
    d.qpos[:] = robot.home_qpos
    d.ctrl[:] = robot.home_ctrl
    mujoco.mj_forward(robot.model, d)
    return d


def hold(robot: Robot) -> dict:
    """The servo check (HOLD_S with the pelvis held), the sole gap at the keyframe, and how long the
    robot stands with no help."""
    m = robot.model
    d = _start(robot)
    sole = min(d.geom_xpos[g][2] - m.geom_size[g][0] for side in robot.feet.values() for g in side)
    qadr = np.array([m.jnt_qposadr[m.actuator_trnid[i, 0]] for i in range(m.nu)])
    limits = np.abs(m.actuator_forcerange[:, 1])
    err = 0.0
    torque = 0.0
    for k in range(int(HOLD_S / m.opt.timestep)):
        d.qpos[:7] = robot.home_qpos[:7]  # the pelvis, held
        d.qvel[:6] = 0.0
        mujoco.mj_step(m, d)
        if k * m.opt.timestep < SETTLE_S:
            continue
        err = max(err, float(np.abs(d.qpos[qadr] - robot.home_ctrl).max()))
        if np.any(limits > 0):
            torque = max(torque, float((np.abs(d.actuator_force) / np.where(limits > 0, limits, np.inf)).max()))

    d = _start(robot)
    pelvis = robot.points["pelvis"].body
    z0 = d.xpos[pelvis][2]
    unaided = UNAIDED_S
    for k in range(int(UNAIDED_S / m.opt.timestep)):
        mujoco.mj_step(m, d)
        if d.xpos[pelvis][2] < FALL_FRACTION * z0:
            unaided = k * m.opt.timestep
            break
    ok = err <= HOLD_ERR_RAD and abs(sole) <= SOLE_GAP_M
    return {"ok": ok, "err_rad": err, "torque_frac": torque if np.any(limits > 0) else None, "sole_gap_m": float(sole), "unaided_s": unaided}


def speed(robot: Robot) -> float:
    """Physics steps per second on one core, standing (no policy, no Python per step but the loop)."""
    m = robot.model
    d = _start(robot)
    start = time.perf_counter()
    for _ in range(SPEED_STEPS):
        mujoco.mj_step(m, d)
    return SPEED_STEPS / (time.perf_counter() - start)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("robots", nargs="*", help="robot ids (robots/<id>.json); all of them if none")
    args = parser.parse_args()
    ids = args.robots or sorted(p.stem for p in ROBOTS.glob("*.json"))
    print(f"{'robot':<12}{'dof':>4}{'height':>8}{'pelvis':>8}{'leg':>7}{'mass':>7}  servos  error  sole gap  torque  alone  steps/s")
    for robot_id in ids:
        robot = load(robot_id)
        size = measure(robot)
        held = hold(robot)
        rate = speed(robot)
        torque = "—" if held["torque_frac"] is None else f"{held['torque_frac'] * 100:.0f}%"
        print(
            f"{robot.name:<12}{size['dof']:>4}{size['height_m']:>7.2f}m{size['pelvis_m']:>7.2f}m{size['leg_m']:>6.2f}m"
            f"{size['mass_kg']:>6.1f}k  {'ok' if held['ok'] else 'FAIL':<6}{held['err_rad']:>6.3f}r{held['sole_gap_m'] * 100:>8.1f}cm"
            f"{torque:>8}{held['unaided_s']:>6.1f}s{rate:>9,.0f}"
        )


if __name__ == "__main__":
    main()
