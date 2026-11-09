"""Where in the clip does the policy fall? The failure map, per stretch of the clip.

`followed_s` says how far the robot gets from the start of the clip, and nothing about the rest: a
policy that falls at 3.5 s may also be unable to do 7-9 s, and no one would know. Here the clip is
cut into BIN_S stretches, the robot starts at the beginning of each one (in the reference pose, as
in training), and runs HORIZON_S with no exploration noise. For each stretch: did it get through,
and if not, where did it fall. The worst stretches are what to fix (reference, reward, curriculum)
and, later, where adaptive sampling sends more practice.

    uv run --project training python -m training.failmap training/runs/<run>/step_<N>.pt [--motion <clip>]
"""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
import torch

from .env import ACTION_SCALE
from .imitate import CONTROL_DT, DEFAULT_MOTION, MimicEnv

# Half a second: about one step of a walk (a stride is ~1 s), so a bin is "this step" or "that step".
BIN_S = 0.5
# Two seconds from each start: long enough to see a fall coming from that stretch (a lost balance
# takes ~1 s to reach the floor), short enough that the whole map costs a few seconds.
HORIZON_S = 2.0


def act(model, obs: np.ndarray, env: MimicEnv) -> np.ndarray:
    """The mean action of an ActorCritic, of an exported ONNX (which outputs motor targets), or none."""
    if model is None:
        return np.zeros(env.nu)
    if hasattr(model, "run"):  # onnxruntime session: ctrl = ref_next + ACTION_SCALE * action
        ctrl = model.run(None, {"obs": obs[None]})[0][0]
        return (ctrl - env.ref_next) / ACTION_SCALE
    with torch.no_grad():
        return model.actor(model.norm(torch.as_tensor(obs)[None]))[0].numpy()


def failure_map(model, motion: str = DEFAULT_MOTION, bin_s: float = BIN_S, horizon_s: float = HORIZON_S) -> dict:
    """model: an ActorCritic (ppo.py), an onnxruntime session, or None for the reference through the motors with no policy.

    Returns starts (s), survived (bool per start), fell_at (s in the clip, or nan), falls_per_bin
    (how many runs ended by falling inside each bin) and the clip's duration."""
    from .imitate import senses

    env = MimicEnv(seed=0, clips=(motion,), **senses(model))
    env.reset()
    duration = env.motion.duration
    starts = np.arange(0.0, max(bin_s, duration - bin_s), bin_s)
    survived, fell_at = [], []
    for start in starts:
        obs = env.reset_at(float(start))
        end = min(duration, start + horizon_s)
        fell = False
        while env.t < end - 1e-9:
            action = act(model, obs, env)
            obs, _, fell, done, _ = env.step(action)
            if fell or done:
                break
        survived.append(not fell)
        fell_at.append(env.t if fell else np.nan)
    bins = np.arange(0.0, duration + bin_s, bin_s)
    falls = np.histogram([f for f in fell_at if not np.isnan(f)], bins=bins)[0]
    return {"starts": starts, "survived": np.array(survived), "fell_at": np.array(fell_at), "bins": bins[:-1],
            "falls_per_bin": falls, "duration": duration, "dt": CONTROL_DT}


def worst(fmap: dict, n: int = 3) -> list[tuple[float, int]]:
    """The n stretches where most runs fell: [(start of the stretch in s, falls)], worst first."""
    order = np.argsort(-fmap["falls_per_bin"], kind="stable")[:n]
    return [(float(fmap["bins"][i]), int(fmap["falls_per_bin"][i])) for i in order if fmap["falls_per_bin"][i] > 0]


def text(fmap: dict) -> str:
    """One line per stretch, with a bar: readable in a terminal and in plateau.md."""
    lines = []
    for b, f, ok in zip(fmap["bins"], fmap["falls_per_bin"], np.append(fmap["survived"], [True] * len(fmap["bins"]))):
        lines.append(f"{b:5.1f}-{b + BIN_S:4.1f} s  {'#' * int(f):<8} {f} caídas" + ("" if ok else "  (arrancando acá, se cae)"))
    share = fmap["survived"].mean() if len(fmap["survived"]) else 0.0
    lines.append(f"aguanta {HORIZON_S:.0f} s desde {100 * share:.0f} % de los inicios")
    return "\n".join(lines)


def main() -> None:
    from .ppo import ActorCritic
    from .imitate import MIMIC_OBS_DIM

    p = argparse.ArgumentParser(prog="python -m training.failmap", description=__doc__.split("\n")[0])
    p.add_argument("checkpoint", type=Path, nargs="?", help="a step_<N>.pt or an exported .onnx; none: the reference with no policy")
    p.add_argument("--motion", help="clip id or RobotMotion .json (default: what the checkpoint learned)")
    args = p.parse_args()
    model, motion = None, args.motion
    if args.checkpoint and args.checkpoint.suffix == ".onnx":
        import json

        import onnxruntime as ort

        model = ort.InferenceSession(str(args.checkpoint))
        motion = motion or json.loads(args.checkpoint.with_suffix(".json").read_text()).get("motion")
    elif args.checkpoint:
        state = torch.load(args.checkpoint)
        model = ActorCritic.from_state(state["model"])
        model.eval()
        motion = motion or state.get("motion")
    print(text(failure_map(model, motion or DEFAULT_MOTION)))


if __name__ == "__main__":
    main()
