"""Ladder step 1 (docs/plan-v2.md, section 6): does the walk reach the end of its clip?

    uv run --project training python -m training.rung1 training/runs/walk-balanced-v1/latest.pt [more .pt]

"Ready" is: at least 90 % of episodes reach the end of the clip, for policies trained with 2 seeds.
evaluate_walk.py runs one episode, from the clip's first pose with no noise, which a policy can pass
by luck of that single start. Here every checkpoint walks EPISODES episodes from the start of the
clip, each one nudged as training/env.py nudges its stand resets (every joint off by up to
INIT_JOINT_NOISE, every speed by up to INIT_VEL_NOISE), the policy without exploration noise.

Two conditions:
- calm: the nudge only, on the flat floor. This is the step's measure.
- pushed: plus the random pushes the stand policies trained with (env.py: 0-300 N for 0.1 s on the
  torso every 2-4 s), with the path sliding along with the pushed robot (imitate.FOLLOW_M): here an
  episode ends only on a real fall. With the path fixed, 17 of 20 pushed episodes of
  walk-push300-seed0 were cut for being 0.6 m off the path with the robot still upright. This says how
  far it is from the delivery's test (which pushes), not whether step 1 passes.
"""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
import torch

from .env import INIT_JOINT_NOISE, INIT_VEL_NOISE
from .imitate import MIMIC_OBS_DIM, MimicEnv, senses
from .ppo import ActorCritic

# 20 episodes per condition and checkpoint: a 90 % pass is then 18 of 20, and one unlucky start
# moves the share by 5 points, not 10. Each episode is ~12 s of simulated time (~0.3 s of compute).
EPISODES = 20
PASS_SHARE = 0.9


def episode(model: ActorCritic, motion: str, seed: int, push: bool) -> float:
    """Seconds of the clip followed, from its start, with a nudged first pose."""
    env = MimicEnv(seed=seed, clips=(motion,), push=push, follow=push, **senses(model))
    env.reset()
    obs = env.reset_at(0.0)
    rng = np.random.default_rng(seed)
    d = env.data
    d.qpos[7:] += rng.uniform(-INIT_JOINT_NOISE, INIT_JOINT_NOISE, len(d.qpos) - 7)
    d.qvel[6:] += rng.uniform(-INIT_VEL_NOISE, INIT_VEL_NOISE, len(d.qvel) - 6)
    obs = env.observe()
    while True:
        with torch.no_grad():
            action = model.actor(model.norm(torch.as_tensor(obs)[None]))[0].numpy()
        obs, _, fell, done, _ = env.step(action)
        if fell or done:
            return env.t if fell else env.motion.duration


def evaluate(path: Path, episodes: int = EPISODES) -> dict:
    state = torch.load(path)
    model = ActorCritic.from_state(state["model"])
    model.eval()
    motion = state.get("motion")
    out = {}
    for name, push in (("calm", False), ("pushed", True)):
        seconds = [episode(model, motion, 1000 + k, push) for k in range(episodes)]
        duration = MimicEnv(seed=0, clips=(motion,)).motion.duration
        reached = [s >= duration - 1e-6 for s in seconds]
        out[name] = {"reached": float(np.mean(reached)), "seconds": seconds, "duration": duration}
    return out


def main() -> None:
    p = argparse.ArgumentParser(prog="python -m training.rung1", description=__doc__.split("\n\n")[0])
    p.add_argument("checkpoints", nargs="+", type=Path)
    p.add_argument("--episodes", type=int, default=EPISODES)
    args = p.parse_args()
    passed = {}  # per run (one seed each): its last checkpoint on the command line counts
    for path in args.checkpoints:
        r = evaluate(path, args.episodes)
        c, pu = r["calm"], r["pushed"]
        ok = c["reached"] >= PASS_SHARE
        passed[path.parent.name] = ok
        print(f"{path.parent.name}/{path.name}: calm {100 * c['reached']:.0f} % reach the end "
              f"(shortest {min(c['seconds']):.1f} of {c['duration']:.1f} s) · pushed {100 * pu['reached']:.0f} % "
              f"(median {np.median(pu['seconds']):.1f} s) -> {'pass' if ok else 'not yet'}")
    if len(passed) >= 2:
        print("step 1: " + ("PASSED" if all(passed.values()) else "not passed")
              + f" ({sum(passed.values())} of {len(passed)} runs at >= {100 * PASS_SHARE:.0f} %, each judged by its last checkpoint listed)")


if __name__ == "__main__":
    main()
