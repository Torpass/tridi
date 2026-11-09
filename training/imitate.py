"""Imitation: the G1 learns to move like a person by following a RobotMotion (DeepMimic style).

The RobotMotion (physics/motions/, from Pastor's retargeting of a PoseClip) says where every joint
and the pelvis should be at each instant. That pose is not physically guaranteed (feet can slide,
balance is not checked), so playing it back would fall; the policy learns to stay close to it while
the physics keeps it honest.

Same robot, actions and physics as env.G1Env, with three changes:
- the observation adds what the reference asks for next (joint angles, pelvis velocity and height);
- the action is a correction on top of the reference pose instead of the standing pose;
- the reward is how close the robot is to the reference.
"""

from __future__ import annotations

import json
from pathlib import Path

import mujoco
import numpy as np

from .env import ACTION_SCALE, CONTROL_S, NU, G1Env, gravity_in_body

MOTIONS = Path(__file__).resolve().parent.parent / "physics" / "motions"
DEFAULT_MOTION = "clip_2026-10-23_caminar-perfil_01"  # the walk, when no --motion is given
CONTROL_DT = CONTROL_S  # 20 ms

# A reference pelvis more than 0.6 m away, or a fall, ends the episode: past that the robot is
# doing something else, and every step spent there teaches nothing about the motion (DeepMimic's
# early termination).
MAX_ROOT_ERROR_M = 0.6

# Episodes start at a random instant of the clip (reference state initialization), so the policy
# practices every phase of the step, not only the first second.
MIN_REMAINING_S = 1.0
# With nudged starts (ppo.py --robust), this share of resets begins at the clip's first frame. The
# delivery and ladder step 1 always start there; with starts spread evenly (~1 in 10 inside the
# first second), walk-nudge-v2-seed1 held 2 s from 96 % of mid-clip starts and fell at 1.2 s from
# 95 % of first-frame starts, and got worse as it trained.
START_SHARE = 0.25
# follow (ppo.py --follow): once a push carries the robot more than FOLLOW_M off the reference path,
# the path slides with it (in the floor plane) so it stays FOLLOW_M away. A pushed robot should walk
# on from where it landed, not run back to where it was: with the path fixed, walk-push300-seed0 stayed
# upright in 18 of 20 pushed episodes and 17 of them were still cut for being 0.6 m off the path.
# 0.3 m is half that cut: inside it the path still pulls the robot back.
FOLLOW_M = 0.3
# recover (ppo.py --recover): for RECOVER_S after a push starts, the reward stops asking for the
# reference pose and asks to stay upright. To catch itself a pushed walker must step where the clip
# does not; with the copy reward, that step costs reward even when it saves the robot. Walk-long-seed0
# survived the web's 250 N push in 22 % of trials after 30 M steps, gaining 0.11 per 10x steps.
# 1 s: a recovery step is ~0.4 s in the clip (its step length), two steps and settling fit in 1 s.
# But walk-night-seed0 (strong pushes + recover, 0.42 on the web push) fell a median 1.1 s after the
# push, 61 % of falls after the window closed: --recover 2 tries a 2 s window.
RECOVER_S = 1.0
# During recovery: the share of the reward for copying the pose (some, so the gait is not forgotten),
# for staying upright, and for still being up at all. They add to 1, the copy reward's maximum, so
# being pushed is never better or worse than walking undisturbed.
RECOVER_POSE, RECOVER_UPRIGHT, RECOVER_ALIVE = 0.2, 0.4, 0.4

FEET = ("left_ankle_roll_link", "right_ankle_roll_link")

# The collision spheres of each foot: scene_mjx.xml pairs exactly these with the floor.
FOOT_SPHERES = {
    "left": ("left_foot1_collision", "left_foot2_collision", "left_foot3_collision"),
    "right": ("right_foot1_collision", "right_foot2_collision", "right_foot3_collision"),
}

# The retargeted pelvis path comes from video and jitters: its frame-to-frame speed jumps to 4 m/s
# in a 0.6 m/s walk. Velocities taken from it would launch the robot at every reset, so the path is
# smoothed over 0.3 s first (a step lasts ~0.5 s, so the gait survives).
SMOOTH_S = 0.3

# Joint angles carry MediaPipe's frame-to-frame jitter too, which the motors chase (0.12 rad of leg
# error with the pelvis held, diagnose_reference.py) and which shakes the grounded pelvis height.
# 0.1 s is 3 frames at 30 fps: it removes the jitter and keeps a swing (~0.4 s) intact.
JOINT_SMOOTH_S = 0.1

# How far ahead the policy also sees the reference. Hips and ankles follow it 60 to 100 ms late
# (diagnose_reference.py: soft position motors act like a slow filter), so seeing only the next
# 20 ms leaves the policy no way to step in time. 0.1 s covers that lag; 0.25 s is half a step.
LOOKAHEAD_S = (0.1, 0.25)

def mimic_obs_dim(nu: int, sense_velocity: bool = False) -> int:
    return 6 + 3 * nu + nu + 3 + 1 + len(LOOKAHEAD_S) * (nu + 3) + (3 if sense_velocity else 0)


def senses(model) -> dict:
    """The MimicEnv options a trained model's input needs: {"sense_velocity": True} when it was
    trained with the pelvis velocity (3 more inputs than mimic_obs_dim), else {}. None (no policy): {}."""
    if model is None or not hasattr(model, "norm"):
        return {}
    nu = model.log_std.shape[0]
    return {"sense_velocity": True} if model.norm.mean.shape[0] == mimic_obs_dim(nu, True) else {}


MIMIC_OBS_DIM = mimic_obs_dim(NU)  # the G1's


class Motion:
    """A RobotMotion sampled at any time, with velocities and foot positions precomputed."""

    def __init__(self, path: Path, model: mujoco.MjModel, feet: tuple[str, str] | None = None, soles: list[int] | None = None):
        """feet: the foot bodies; soles: the sole geom ids. The G1's when not given."""
        m = json.loads(path.read_text())
        self.id = m["clip_id"]
        self.fps = float(m["fps"])
        self.qpos = np.array(m["qpos"], dtype=np.float64)
        # Keep adjacent pelvis quaternions in the same hemisphere so linear blending between frames
        # follows the short arc instead of crossing near zero when yaw wraps past +-pi.
        for i in range(1, len(self.qpos)):
            if np.dot(self.qpos[i - 1, 3:7], self.qpos[i, 3:7]) < 0:
                self.qpos[i, 3:7] = -self.qpos[i, 3:7]
        self.duration = (len(self.qpos) - 1) / self.fps
        dt = 1 / self.fps
        window = max(1, int(round(SMOOTH_S * self.fps)))
        # The reference is cleaned for this model before anything is taken from it:
        # 1. joints lightly smoothed (JOINT_SMOOTH_S);
        # 2. pelvis path smoothed on the floor plane only: smoothing its height too left a foot 1 cm
        #    inside the floor in 10% of the walk and both feet in the air in 7%;
        # 3. pelvis height set frame by frame so the lowest foot sphere of this model touches the
        #    floor (the retargeting grounded it with the mesh feet of the display model);
        # 4. feet targets taken from that final pose. They used to come from the pose before
        #    smoothing, 2 cm (up to 13 cm) away from it, so feet and pelvis rewards disagreed.
        # A reference already made plausible by training.balance skips 1 and 2: its feet are planted
        # by inverse kinematics, and smoothing the pelvis alone would slide them again.
        self.balanced = "balanced_by" in m
        if not self.balanced:
            self.qpos[:, 7:] = smooth(self.qpos[:, 7:], max(1, int(round(JOINT_SMOOTH_S * self.fps))))
            self.qpos[:, :2] = smooth(self.qpos[:, :2], window)
        d = mujoco.MjData(model)
        feet_ids = [model.body(n).id for n in (feet or FEET)]
        spheres = soles if soles is not None else [model.geom(n).id for side in FOOT_SPHERES.values() for n in side]
        floor = model.geom("floor").id
        contacts = m.get("contacts")
        self.feet = np.zeros((len(self.qpos), 2, 3))
        for i in range(len(self.qpos)):
            d.qpos[:] = self.qpos[i]
            mujoco.mj_kinematics(model, d)
            if contacts is None or any(contacts[i]):
                self.qpos[i, 2] -= min(mujoco.mj_geomDistance(model, d, g, floor, 1.0, None) for g in spheres)
                d.qpos[2] = self.qpos[i, 2]
                mujoco.mj_kinematics(model, d)
            self.feet[i] = d.xpos[feet_ids]
        # Velocities by finite differences of smoothed signals: pelvis in the world, joints in rad/s.
        # The grounded height still wobbles a little, and its raw velocity would bounce the robot.
        path = np.column_stack([self.qpos[:, :2], smooth(self.qpos[:, 2:3], window)])
        self.root_vel = np.gradient(path, dt, axis=0)
        self.joint_vel = np.gradient(smooth(self.qpos[:, 7:], window), dt, axis=0)

    def sample(self, t: float):
        """Pose, pelvis velocity, joint velocities and feet at time t (linear between frames)."""
        x = np.clip(t * self.fps, 0, len(self.qpos) - 1)
        i = min(int(x), len(self.qpos) - 2)
        w = x - i
        a, b = self.qpos[i], self.qpos[i + 1].copy()
        if np.dot(a[3:7], b[3:7]) < 0:
            b[3:7] = -b[3:7]
        q = (1 - w) * a + w * b
        q[3:7] /= np.linalg.norm(q[3:7])  # interpolated quaternion, renormalized
        lerp = lambda a: (1 - w) * a[i] + w * a[i + 1]  # noqa: E731
        return q, lerp(self.root_vel), lerp(self.joint_vel), lerp(self.feet)


def smooth(x: np.ndarray, window: int) -> np.ndarray:
    """Centered moving average along time, repeating the edges."""
    if window < 2:
        return x
    pad = window // 2
    padded = np.pad(x, ((pad, window - 1 - pad), (0, 0)), mode="edge")
    kernel = np.ones(window) / window
    return np.stack([np.convolve(padded[:, j], kernel, mode="valid") for j in range(x.shape[1])], axis=1)


def motion_path(motion: str) -> Path:
    """A RobotMotion file: any path ending in .json (a user's clip, written with retarget --out), or
    the clip id of a preloaded one in physics/motions/ or training/references/."""
    if motion.endswith(".json"):
        return Path(motion)
    p = MOTIONS / f"{motion}.json"
    return p if p.exists() else Path(__file__).parent / "references" / f"{motion}.json"


def load_motions(model: mujoco.MjModel, motions: list[str], feet=None, soles=None) -> list[Motion]:
    return [Motion(motion_path(m), model, feet, soles) for m in motions]


def motion_robot(motion: str) -> str:
    """The robot package a RobotMotion is for: its "robot_package" (training.retarget), else the G1."""
    return json.loads(motion_path(motion).read_text()).get("robot_package", "g1")


class MimicEnv(G1Env):
    def __init__(self, seed: int = 0, clips: tuple[str, ...] = (DEFAULT_MOTION,), push: bool = False,
                 push_n: tuple[float, float] | None = None, push_every: tuple[float, float] | None = None,
                 nudge: bool = False, follow: bool = False, recover: bool | float = False,
                 sense_velocity: bool = False):
        """nudge: every reset starts off the reference pose as G1Env's resets do (each joint
        N(0, INIT_JOINT_NOISE), each speed N(0, INIT_VEL_NOISE)). Without it the walk learned from
        exact starts only: one seed reached the end from 90 % of nudged starts, the other 25 %."""
        robot = motion_robot(clips[0])
        extra = {k: v for k, v in (("push_n", push_n), ("push_every", push_every)) if v is not None}
        super().__init__(seed=seed, push=push, robot=robot, **extra)
        self.nudge = nudge
        self.follow = follow
        # recover: True for RECOVER_S, or the window in seconds
        self.recover_s = (RECOVER_S if recover is True else float(recover)) if recover else 0.0
        self.shift = np.zeros(2)  # how far the path has slid with the robot (follow)
        if robot == "g1":
            feet, soles = None, None
        else:
            from .robot import load

            package = load(robot)
            feet = tuple(self.model.body(i).name for i in self.feet)
            soles = [g for side in ("left", "right") for g in package.feet[side]]
        # sense_velocity (ppo.py --sense-velocity): the observation ends with the pelvis's own velocity
        # in its frame (3, m/s). Without it the policy cannot feel a push until it tilts: the web's
        # 250 N push (~0.76 m/s on the G1) knocked walks down ~1 s later, and no reward change took
        # walk-night-seed0 past ~0.45 on training.pushwalk. legged_gym's policies observe it too
        # (on a real robot it is estimated).
        self.sense_velocity = sense_velocity
        self.obs_dim = mimic_obs_dim(self.nu, sense_velocity)
        self.motions = load_motions(self.model, list(clips), feet, soles)
        self.feet_ids = list(self.feet)
        self.floor = self.model.geom("floor").id
        self.motion = self.motions[0]
        self.t = 0.0
        self.ref_next = self.default

    # --- Observation and action ------------------------------------------------------------------

    def observe(self) -> np.ndarray:
        """The 93 numbers of G1Env.observe(), then what the reference asks for in the next 20 ms:

        - [93:122]  reference joint angles minus the standing pose
        - [122:125] reference pelvis velocity, in the pelvis frame (m/s)
        - [125]     reference pelvis height minus the current one (m)

        and, for each instant in LOOKAHEAD_S (0.1 s, then 0.25 s), 32 more:

        - 29: reference joint angles minus the standing pose
        - 3:  reference pelvis position minus the current one, in the pelvis frame (m). It also tells
              the policy how far it has drifted from the path, which ends the episode at 0.6 m.
        """
        q, root_vel, _, _ = self.sample(self.t + CONTROL_DT)
        self.ref_next = q[7:]
        rot = np.zeros(9)
        mujoco.mju_quat2Mat(rot, self.data.qpos[3:7])
        to_body = rot.reshape(3, 3).T
        ahead = []
        for s in LOOKAHEAD_S:
            q_ahead = self.sample(self.t + s)[0]
            ahead += [q_ahead[7:] - self.default, to_body @ (q_ahead[:3] - self.data.qpos[:3])]
        return np.concatenate([
            self._base_observe(),
            self.ref_next - self.default,
            to_body @ root_vel,
            [q[2] - self.data.qpos[2]],
            *ahead,
            *([to_body @ self.data.qvel[:3]] if self.sense_velocity else []),
        ]).astype(np.float32)

    def apply(self, action: np.ndarray) -> np.ndarray:
        """Targets = the reference pose for the next step + 0.25 rad per action unit, clipped.
        The policy only learns the correction that keeps the motion balanced."""
        ctrl = np.clip(self.ref_next + ACTION_SCALE * action, self.ctrl_low, self.ctrl_high)
        self.data.ctrl[:] = ctrl
        return ctrl

    # --- Episode ---------------------------------------------------------------------------------

    def reset(self) -> np.ndarray:
        self.motion = self.motions[self.rng.integers(len(self.motions))]
        start = self.rng.uniform(0, max(0.0, self.motion.duration - MIN_REMAINING_S))
        if self.nudge and self.rng.random() < START_SHARE:
            start = 0.0
        obs = self.reset_at(start)
        if self.nudge:
            from .env import INIT_JOINT_NOISE, INIT_VEL_NOISE

            self.data.qpos[7:] += self.rng.normal(0, INIT_JOINT_NOISE, self.nu)
            self.data.qvel[:] += self.rng.normal(0, INIT_VEL_NOISE, self.model.nv)
            mujoco.mj_forward(self.model, self.data)
            obs = self.observe()
        return obs

    def sample(self, t: float):
        """The reference at time t, slid by `shift` in the floor plane (follow)."""
        q, root_vel, joint_vel, feet = self.motion.sample(t)
        if self.shift.any():
            q, feet = q.copy(), feet.copy()
            q[:2] += self.shift
            feet[:, :2] += self.shift
        return q, root_vel, joint_vel, feet

    def reset_at(self, t: float) -> np.ndarray:
        """Start the episode at second t of the current clip, in its reference pose."""
        self.t = t
        self.shift = np.zeros(2)
        q, root_vel, joint_vel, _ = self.motion.sample(self.t)
        d = self.data
        mujoco.mj_resetData(self.model, d)
        d.qpos[:] = q
        d.qvel[:] = 0
        d.qvel[:3] = root_vel
        d.qvel[6:] = joint_vel
        self._touch_ground()
        self.prev_ctrl = q[7:].copy()
        self.steps = 0
        self.push_left = 0
        self.next_push = self._draw_push_time()
        return self.observe()

    def _touch_ground(self) -> None:
        """Moves the pelvis up or down so the lowest foot rests on the floor. The reference was put on
        the floor with the mesh model; the training model's foot capsules sit a few cm differently,
        and a robot that starts in the air or inside the floor falls or bounces."""
        d = self.data
        for _ in range(40):
            mujoco.mj_forward(self.model, d)
            # Only contacts with the floor: the robot touching itself (a hand on a thigh) does not count.
            dist = min((d.contact[i].dist for i in range(d.ncon) if self.floor in d.contact[i].geom), default=None)
            if dist is None:
                d.qpos[2] -= 0.005  # in the air: lower 5 mm
            elif dist < -0.002:
                d.qpos[2] -= dist  # sunk into the floor: lift by the penetration
            else:
                return

    def step(self, action: np.ndarray):
        ctrl = self.apply(action)
        self._push()
        for _ in range(self.decimation):
            mujoco.mj_step(self.model, self.data)
        self.steps += 1
        self.t += CONTROL_DT
        reward, info = self.reward(ctrl)
        self.prev_ctrl = ctrl
        q_ref = self.sample(self.t)[0]
        if self.follow:
            gap = self.data.qpos[:2] - q_ref[:2]
            dist = np.linalg.norm(gap)
            if dist > FOLLOW_M:
                self.shift += gap * (1 - FOLLOW_M / dist)
                q_ref = self.sample(self.t)[0]
        off_track = np.linalg.norm(self.data.qpos[:2] - q_ref[:2]) > MAX_ROOT_ERROR_M
        fell = self.fallen() or off_track
        done = self.t >= self.motion.duration
        return self.observe(), reward, fell, done and not fell, info

    def reward(self, ctrl: np.ndarray) -> tuple[float, dict]:
        """DeepMimic's terms and weights (Peng et al. 2018), each exp(-k * error) in [0, 1]:
        pose 0.5, velocity 0.05, feet 0.15, pelvis position 0.2, pelvis orientation 0.1.

        Plus pelvis speed (0.15): without it the policy learned to move its legs like the clip while
        staying behind (0.5 m back when the episode is cut at 0.6 m), and the position term gives
        almost nothing that far away, so nothing pushed it to catch up. Only the floor plane counts:
        the reference's vertical speed is noise. A speed error of 0.37 m/s halves it."""
        q_ref, root_vel_ref, joint_vel_ref, feet_ref = self.sample(self.t)
        qpos, qvel = self.data.qpos, self.data.qvel
        feet = self.data.xpos[self.feet_ids]
        quat_err = np.zeros(3)
        mujoco.mju_subQuat(quat_err, q_ref[3:7], qpos[3:7])
        terms = {
            "pose": 0.5 * np.exp(-2.0 * np.sum((qpos[7:] - q_ref[7:]) ** 2)),
            "velocity": 0.05 * np.exp(-0.1 * np.sum((qvel[6:] - joint_vel_ref) ** 2)),
            "feet": 0.15 * np.exp(-40.0 * np.sum((feet - feet_ref) ** 2)),
            "pelvis": 0.2 * np.exp(-10.0 * np.sum((qpos[:3] - q_ref[:3]) ** 2)),
            "orientation": 0.1 * np.exp(-2.0 * np.sum(quat_err**2)),
            "pelvis_speed": 0.15 * np.exp(-5.0 * np.sum((qvel[:2] - root_vel_ref[:2]) ** 2)),
        }
        if self.recover_s and self.steps - self.last_push < self.recover_s / CONTROL_DT:
            copy = sum(terms.values())  # 0..1
            upright = terms["orientation"] / 0.1  # 0..1
            return float(RECOVER_POSE * copy + RECOVER_UPRIGHT * upright + RECOVER_ALIVE), {**terms, "recovering": 1.0}
        return float(sum(terms.values())), terms


__all__ = ["MimicEnv", "MIMIC_OBS_DIM", "gravity_in_body"]
