"""Does a walk survive the web's push? The delivery's test for a motion, not just for standing.

    uv run --project training python -m training.pushwalk training/runs/<run>/latest.pt [more .pt] [--sweep]

The web's "Empujar" button pushes the torso with 250 N for 0.1 s (physics/src/sim.js, the same push
training/evaluate.py gives a standing policy). Here the policy walks its clip from the first frame
and gets one such push, from each of 4 sides (front, left, back, right in the world), at each of
MOMENTS. A trial passes if the robot reaches the end of the clip. The reference path slides with the
pushed robot (imitate.FOLLOW_M), so only a fall fails, not landing off the path.

Score: the share of trials passed, 0 to 1, higher is better: ppo.py --metric pushwalk trains
against it and plateau.py judges and forecasts it. --sweep also reports random pushes of 0 to F N
every 2-4 s (as training pushes) for several F, which shows how far a policy is from the goal.

Deterministic (no exploration noise, fixed seeds): the same checkpoint always scores the same.
"""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
import torch

from .imitate import MimicEnv, senses
from .ppo import ActorCritic

PUSH_N = 250.0  # physics/src/sim.js, as training/evaluate.py
SIDES = ("front", "left", "back", "right")
# 10 moments over the 11.85 s walk, the last 1.85 s before its end so it has time to fall. 40 trials:
# a score's standard error is at most 0.08 (binomial, p = 0.5), enough to tell 0.25 from 0.5.
MOMENTS = tuple(np.round(np.linspace(1.0, 10.0, 10), 2))
SWEEP_N = (50, 100, 150, 200, 300)
SWEEP_EPISODES = 20


def _act(model: ActorCritic, obs: np.ndarray) -> np.ndarray:
    with torch.no_grad():
        return model.actor(model.norm(torch.as_tensor(obs)[None]))[0].numpy()


def trial(model: ActorCritic, motion: str, side: int, at: float, seed: int = 0) -> bool:
    env = MimicEnv(seed=seed, clips=(motion,), push=False, follow=True, **senses(model))
    env.reset()
    obs = env.reset_at(0.0)
    pushed = False
    while True:
        if not pushed and env.t >= at - 1e-9:
            env.push_now(PUSH_N, side * np.pi / 2)
            pushed = True
        obs, _, fell, done, _ = env.step(_act(model, obs))
        if fell:
            return False
        if done:
            return True


def score(model: ActorCritic, motion: str) -> dict:
    """The share of trials passed, overall and per side."""
    model.eval()
    by_side = {name: [trial(model, motion, k, at, seed=j) for j, at in enumerate(MOMENTS)] for k, name in enumerate(SIDES)}
    total = [ok for oks in by_side.values() for ok in oks]
    return {"score": float(np.mean(total)), "sides": {k: float(np.mean(v)) for k, v in by_side.items()}, "trials": len(total)}


def sweep(model: ActorCritic, motion: str) -> dict[int, float]:
    """Random pushes of 0 to F N every 2-4 s from the clip start: the share reaching the end, per F."""
    out = {}
    for f in SWEEP_N:
        ok = 0
        for k in range(SWEEP_EPISODES):
            env = MimicEnv(seed=1000 + k, clips=(motion,), push=True, push_n=(0.0, float(f)), follow=True, **senses(model))
            env.reset()
            obs = env.reset_at(0.0)
            while True:
                obs, _, fell, done, _ = env.step(_act(model, obs))
                if fell or done:
                    ok += done and not fell
                    break
        out[f] = ok / SWEEP_EPISODES
    return out


def main() -> None:
    p = argparse.ArgumentParser(prog="python -m training.pushwalk", description=__doc__.split("\n\n")[0])
    p.add_argument("checkpoints", nargs="+", type=Path)
    p.add_argument("--sweep", action="store_true", help="also random pushes of 0 to F N")
    args = p.parse_args()
    for path in args.checkpoints:
        state = torch.load(path)
        model = ActorCritic.from_state(state["model"])
        r = score(model, state["motion"])
        sides = " ".join(f"{k} {100 * v:.0f}%" for k, v in r["sides"].items())
        line = f"{path.parent.name}/{path.name}: web push {100 * r['score']:.0f} % of {r['trials']} ({sides})"
        if args.sweep:
            line += " · random 0-F N: " + " ".join(f"{f}N {100 * v:.0f}%" for f, v in sweep(model, state["motion"]).items())
        print(line, flush=True)


if __name__ == "__main__":
    main()
