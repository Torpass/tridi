"""The world where the G1 learns: observations, actions, reward and falls, on top of MuJoCo.

MuJoCo solves contacts and joints; everything here is ours. One `G1Env` is one robot in its own
MuJoCo world. It has no dependency on gym: `reset()` and `step(action)` with numpy arrays.

The browser (physics/, MuJoCo WASM 3.16.0, same version as here) has to build exactly the same
observation and apply the policy's output the same way, so both are spelled out in `observe()` and
`apply()`. The layout is also in training/README.md.
"""

from __future__ import annotations

from dataclasses import dataclass

from pathlib import Path

import mujoco
import numpy as np

SCENE = Path(__file__).resolve().parent.parent / "physics" / "models" / "unitree_g1" / "scene_mjx.xml"
MJCF = "unitree_g1/scene_mjx.xml"  # as policy.json names it, relative to physics/models/

# The policy decides 50 times per second: 5 physics steps of 4 ms. Fast enough to catch a stumble
# (a fall takes ~0.5 s), slow enough that each decision moves the robot measurably. Another robot
# package keeps the 20 ms and takes as many of its own physics steps (the H1's are 2 ms: 10).
CONTROL_S = 0.02
DECIMATION = 5

# One action unit moves a joint target 0.25 rad from the standing pose. The usual scale for position
# actuators on humanoids (legged_gym, MuJoCo Playground): the policy outputs ~[-1, 1] and still
# reaches big corrections, and a random untrained policy only jitters around standing.
ACTION_SCALE = 0.25

# Observation scaling: keeps every input around [-1, 1] so no term dominates the first layer.
ANG_VEL_SCALE = 0.25  # rad/s -> a hard stumble is ~4 rad/s
JOINT_VEL_SCALE = 0.05  # rad/s -> joints swing at up to ~20 rad/s

# Standing height of the pelvis in the "home" keyframe, in meters.
STAND_HEIGHT = 0.7837

# A fall: pelvis below 0.5 m (knees on the ground, from 0.78 standing) or the torso tilted more than
# 60 degrees (the gravity vector seen from the pelvis has lost half its downward part). Past either
# the G1 cannot get back up with these motors, so the episode ends there.
FALL_HEIGHT = 0.5
FALL_UPRIGHT = 0.5

# 20 s episodes: long enough to take several pushes, short enough that every robot restarts often
# and the policy keeps seeing the first second after a reset.
EPISODE_STEPS = 1000

# The push of physics/ (the pitch's "Empujar" button) is 250 N for 0.1 s on the torso. Training uses
# up to 300 N, a bit more than the demo, so 250 N is inside what it learned and not its edge. A run
# that continues a trained policy can raise the floor (--push-min) to spend its time on hard pushes.
PUSH_N = (0.0, 300.0)
PUSH_STEPS = 5  # 0.1 s at 50 Hz
PUSH_EVERY_S = (2.0, 4.0)  # a new push every 2 to 4 s, at random

# Start each episode a little off the keyframe: the policy must stand from many nearby poses, not
# replay one. 0.05 rad per joint is a visible but harmless wobble.
INIT_JOINT_NOISE = 0.05
INIT_VEL_NOISE = 0.1

OBS_DIM = 3 + 3 + 29 + 29 + 29  # the G1's; a robot with nu motors has 6 + 3 nu (G1Env.obs_dim)
NU = 29
# Linear inverted pendulum time constant sqrt(h / g) at the G1's 0.7837 m pelvis height:
# sqrt(0.7837 / 9.81) = 0.2826 s. A pelvis moving horizontally at v m/s comes to rest over a foot
# placed at the Capture Point p_pelvis + CAPTURE_TAU_S * v_pelvis.
CAPTURE_TAU_S = 0.283


def stand_obs_dim(nu: int = NU, sense_velocity: bool = False) -> int:
    return 6 + 3 * nu + (3 if sense_velocity else 0)


def stand_senses(model) -> dict:
    """The G1Env options a trained standing model's input needs: {"sense_velocity": True} when it
    was trained with the 3D pelvis linear velocity (96 inputs on the G1), else {}."""
    if model is None or not hasattr(model, "norm"):
        return {}
    nu = model.log_std.shape[0]
    return {"sense_velocity": True} if model.norm.mean.shape[0] == stand_obs_dim(nu, True) else {}


@dataclass(frozen=True)
class Stance:
    """What a quiet stance is worth, on top of the base reward. All zero (the default) is the reward
    g1-stand learned with: it balances and takes pushes, but it learned to do so pivoting on one foot
    at 57 deg/s, because nothing below cared. ppo.py --reward sets these (training/README.md).

    Penalties are quadratic, not exp(-x^2/s): a saturated exp has no gradient once the robot is
    far from still (stand-v4 kept its feet moving 1 m for that reason). The foot terms only count
    when calm, i.e. no push in the last calm_s: a step is how a 250 N push is survived (its 25 N s
    move the pelvis 0.7 m/s, past the edge of the foot), and stand-v5 never learned to step because
    it was charged for it from step 0.
    """

    turn: float = 0.0  # per (rad/s)^2 of yaw rate: 0.3 makes today's 1 rad/s pivot cost a third of the reward
    feet: float = 0.0  # per (m/s)^2 of both ankles' horizontal speed, when calm: 0.5 charges a 0.47 m/s tap 0.11
    planted: float = 0.0  # bonus when calm with both feet on the floor (a tap lifts a foot 2-4 cm)
    rate: float = 0.005  # per unit of squared action change: 0.005 is what g1-stand learned with (0.5 % of its reward); 0.02 is the usual share
    calm_s: float = 1.0  # a push's recovery takes 1.0-1.8 s (measured on g1-stand); the first second is free
    capture: float = 0.0  # bonus for placing the support / stepping foot under the Capture Point p + tau * v (0.25 in stand v2)


# Stand v2 default reward preset (--reward v2): Capture-Point stepping recovery during a shove +
# quiet two-foot planted stance when calm.
STANCE_V2 = Stance(turn=0.3, feet=0.5, planted=0.1, rate=0.02, calm_s=1.0, capture=0.05)


# A foot is planted when its ankle is within this of where it rests when standing: a tap lifts it
# 2 to 4.5 cm, a planted foot rolling on its sole moves its ankle less than 1 cm.
PLANTED_M = 0.01
FEET = ("left_ankle_roll_link", "right_ankle_roll_link")


class G1Env:
    """Named for the G1, which it was written for; `robot` takes any package (robots/<id>.json,
    training/robot.py): sizes, feet, torso and the standing pose come from it, and the fall line
    scales with its standing height."""

    def __init__(self, seed: int = 0, push: bool = True, push_n: tuple[float, float] = PUSH_N,
                 push_every: tuple[float, float] = PUSH_EVERY_S, stance: Stance | None = None,
                 robot: str = "g1", sense_velocity: bool = False):
        if robot == "g1":
            self.model = mujoco.MjModel.from_xml_path(str(SCENE))
            feet, torso = FEET, "torso_link"
            self.mjcf = MJCF
        else:
            from .robot import load

            package = load(robot)
            self.model = package.model
            feet = tuple(package.model.body(package.points[f"{s}_foot"].body).name for s in ("left", "right"))
            torso = package.model.body(package.points["torso"].body).name
            self.mjcf = package.mjcf
        self.robot_id = robot
        self.nu = self.model.nu
        self.sense_velocity = sense_velocity
        self.obs_dim = stand_obs_dim(self.nu, sense_velocity)
        self.decimation = max(1, int(round(CONTROL_S / self.model.opt.timestep)))
        self.data = mujoco.MjData(self.model)
        self.rng = np.random.default_rng(seed)
        self.push_enabled = push
        self.push_n = push_n
        self.push_every = push_every
        self.stance = stance or Stance()
        self.feet = [self.model.body(name).id for name in feet]
        self.feet_rest = np.zeros(2)  # ankle heights when standing, set at reset
        self.prev_feet = np.zeros((2, 2))  # ankle xy at the previous decision
        self.last_push = -10**9  # decision when the last push started
        key = self.model.key("home")
        self.home_qpos = key.qpos.copy()
        if robot == "g1":
            self.default = key.ctrl.copy()  # joint targets of the standing pose
            self.stand_height = STAND_HEIGHT
        else:
            self.default = package.home_ctrl.copy()
            self.stand_height = float(self.home_qpos[2])
        # The fall line keeps the G1's proportion: 0.5 m of a 0.78 m stance.
        self.fall_height = FALL_HEIGHT * self.stand_height / STAND_HEIGHT
        self.ctrl_low, self.ctrl_high = self.model.actuator_ctrlrange.T.copy()
        self.torso = self.model.body(torso).id
        self.prev_ctrl = self.default.copy()
        self.steps = 0
        self.next_push = 0
        self.push_left = 0
        self.push_force = np.zeros(3)

    # --- What the policy sees and does (mirrored in the browser) ---------------------------------

    def _base_observe(self) -> np.ndarray:
        """The 6 + 3*nu base proprioceptive numbers (93 on the G1):

        - [0:3]   pelvis angular velocity in its own frame (qvel[3:6]) x 0.25
        - [3:6]   gravity direction seen from the pelvis (unit vector; (0, 0, -1) when upright)
        - [6:35]  joint angles minus the standing pose (qpos[7:] - default)
        - [35:64] joint velocities (qvel[6:]) x 0.05
        - [64:93] previous motor targets as actions: (prev_ctrl - default) / 0.25
        """
        qpos, qvel = self.data.qpos, self.data.qvel
        return np.concatenate([
            qvel[3:6] * ANG_VEL_SCALE,
            gravity_in_body(qpos[3:7]),
            qpos[7:] - self.default,
            qvel[6:] * JOINT_VEL_SCALE,
            (self.prev_ctrl - self.default) / ACTION_SCALE,
        ]).astype(np.float32)

    def observe(self) -> np.ndarray:
        """93 base numbers (or 96 with --sense-velocity, adding the 3D pelvis linear velocity in
        the pelvis frame at the end so the policy feels a shove on the very first decision step)."""
        base = self._base_observe()
        if not self.sense_velocity:
            return base
        rot = np.zeros(9)
        mujoco.mju_quat2Mat(rot, self.data.qpos[3:7])
        vel_body = (rot.reshape(3, 3).T @ self.data.qvel[:3]).astype(np.float32)
        return np.concatenate([base, vel_body])

    def apply(self, action: np.ndarray) -> np.ndarray:
        """Policy output -> motor targets (ctrl): the standing pose plus 0.25 rad per unit, clipped
        to each motor's range. The exported ONNX already does this and outputs ctrl directly."""
        ctrl = np.clip(self.default + ACTION_SCALE * action, self.ctrl_low, self.ctrl_high)
        self.data.ctrl[:] = ctrl
        return ctrl

    # --- Episode ---------------------------------------------------------------------------------

    def reset(self) -> np.ndarray:
        d = self.data
        mujoco.mj_resetData(self.model, d)
        d.qpos[:] = self.home_qpos
        d.qpos[7:] += self.rng.normal(0, INIT_JOINT_NOISE, self.nu)
        d.qvel[:] = self.rng.normal(0, INIT_VEL_NOISE, self.model.nv)
        mujoco.mj_forward(self.model, d)
        self.prev_ctrl = self.default.copy()
        self.feet_rest = d.xpos[self.feet, 2].copy()
        self.prev_feet = d.xpos[self.feet, :2].copy()
        self.last_push = -10**9
        self.steps = 0
        self.push_left = 0
        self.next_push = self._draw_push_time()
        return self.observe()

    def step(self, action: np.ndarray) -> tuple[np.ndarray, float, bool, bool, dict]:
        """Returns obs, reward, terminated (fell), truncated (time up), info."""
        ctrl = self.apply(action)
        self._push()
        for _ in range(self.decimation):
            mujoco.mj_step(self.model, self.data)
        self.steps += 1
        reward, info = self.reward(ctrl)
        self.prev_ctrl = ctrl
        self.prev_feet = self.data.xpos[self.feet, :2].copy()
        fell = self.fallen()
        return self.observe(), reward, fell, self.steps >= EPISODE_STEPS and not fell, info

    def fallen(self) -> bool:
        up = -gravity_in_body(self.data.qpos[3:7])[2]
        return self.data.qpos[2] < self.fall_height or up < FALL_UPRIGHT

    def reward(self, ctrl: np.ndarray) -> tuple[float, dict]:
        """About 1 per step when standing still and upright; less when tilted, sagging or twitching.

        Every term is positive and the total never goes below 0, so falling (which ends the episode
        and its future rewards) is the worst outcome without a separate penalty.
        """
        qpos, qvel = self.data.qpos, self.data.qvel
        g = gravity_in_body(qpos[3:7])
        w = self.stance
        calm = self.steps - self.last_push >= w.calm_s * 50
        terms = {
            # Upright: tilt of 0.2 rad (11 degrees) already halves it.
            "upright": 0.4 * np.exp(-(g[0] ** 2 + g[1] ** 2) / 0.04),
            # Height: 5 cm of sag halves it, so it learns to keep its knees, not to crouch.
            "height": 0.3 * np.exp(-((qpos[2] - self.stand_height) ** 2) / 0.0036),
            # Near the standing pose: keeps arms and waist calm instead of flailing to balance.
            "pose": 0.2 * np.exp(-np.sum((qpos[7:] - self.default) ** 2) / 1.0),
            # Still: pelvis drifting at 0.5 m/s halves it.
            "still": 0.1 * np.exp(-np.sum(qvel[:2] ** 2) / 0.25),
        }
        if w.capture:
            # Capture Point x_cp = x_pelvis + sqrt(h/g) * v_pelvis: when shoved (!calm), reward
            # placing the stepping foot under x_cp; when calm, reward keeping the midpoint of both
            # feet centered under x_cp.
            cp = qpos[:2] + CAPTURE_TAU_S * qvel[:2]
            feet_xy = self.data.xpos[self.feet, :2]
            mid_err2 = float(np.sum((feet_xy.mean(axis=0) - cp) ** 2))
            if calm:
                terms["capture"] = w.capture * float(np.exp(-mid_err2 / 0.02))
            else:
                step_err2 = float(np.min(np.sum((feet_xy - cp) ** 2, axis=1)))
                terms["capture"] = w.capture * float(np.exp(-(0.5 * step_err2 + 0.5 * mid_err2) / 0.04))
        if w.planted:
            down = np.all(self.data.xpos[self.feet, 2] - self.feet_rest < PLANTED_M)
            terms["planted"] = w.planted * float(calm and down)
        # Smoothness: big jumps between consecutive targets shake the robot (and a real one's gears).
        rate = np.sum(((ctrl - self.prev_ctrl) / ACTION_SCALE) ** 2)
        terms["rate"] = -w.rate * rate
        if w.turn:
            terms["turn"] = -w.turn * qvel[5] ** 2  # qvel[5]: the pelvis' angular velocity about its own z, the yaw rate while upright
        if w.feet:
            dt = self.decimation * self.model.opt.timestep
            speed2 = np.sum((self.data.xpos[self.feet, :2] - self.prev_feet) ** 2) / dt**2
            terms["feet"] = -w.feet * speed2 * float(calm)
        total = max(sum(terms.values()), 0.0)
        return float(total), terms

    # --- Pushes ----------------------------------------------------------------------------------

    def _draw_push_time(self) -> int:
        return self.steps + int(self.rng.uniform(*self.push_every) * 50)

    def _push(self) -> None:
        f = self.data.xfrc_applied
        # Random pushes only when enabled; a push_now() push runs its 0.1 s either way.
        if self.push_enabled and self.push_left == 0 and self.steps >= self.next_push:
            angle = self.rng.uniform(0, 2 * np.pi)
            self.push_force = self.rng.uniform(*self.push_n) * np.array([np.cos(angle), np.sin(angle), 0])
            self.push_left = PUSH_STEPS
            self.last_push = self.steps
            self.next_push = self._draw_push_time()
        if self.push_left > 0:
            f[self.torso, :3] = self.push_force
            self.push_left -= 1
        else:
            f[self.torso, :3] = 0

    def push_now(self, force_n: float, angle: float) -> None:
        """A push like the web's button, for evaluation."""
        self.push_force = force_n * np.array([np.cos(angle), np.sin(angle), 0])
        self.push_left = PUSH_STEPS
        self.last_push = self.steps


def gravity_in_body(quat: np.ndarray) -> np.ndarray:
    """World gravity direction (0, 0, -1) rotated into the pelvis frame. quat is MuJoCo's (w, x, y, z)."""
    w, x, y, z = quat
    # Third row of the rotation matrix body->world, negated: R^T @ (0, 0, -1).
    return -np.array([2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)])
