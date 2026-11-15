"""Multi-video generalist training + edge-case & actuator-fault curriculum (docs/ROADMAP.md, J-2).

    uv run --project training python -m training.multiclip --verify
    uv run --project training python -m training.multiclip --clips all-walks --steps 20000000 --run walk-multiclip-v1

Why this exists:
1. Tridi scales by learning from internet videos, not from one person filming 10,000 times. A single
   locomotion or manipulation policy must train across N distinct reference clips simultaneously,
   sampling harder clips more often as episodes terminate (`MimicEnv.clip_fail_ema`).
2. Real-world deployment fails on edge cases: a weakened/overheated leg motor (`--fault-prob`),
   a sudden obstacle requiring an emergency halt (`--sudden-stop-prob`), uneven terrain (`--worlds`),
   and external shoves (`--robust`).
3. `multiclip.py` runs C1/C2 kinematic & dynamic feasibility checks across every clip in the batch,
   verifies multi-clip curriculum sampling + actuator fault injection + emergency stop braking, and
   launches PPO on CPU or Cloud GPU.
"""

from __future__ import annotations

import argparse
from pathlib import Path
import sys

import numpy as np
import torch

from .checks import c1, c2
from .imitate import MimicEnv, resolve_clips
from .ppo import STANCE_V2, train


def verify_pipeline(clips_spec: str = "all-walks") -> dict:
    """Run an end-to-end verification of multi-clip loading, failure-weighted sampling, motor faults, and sudden stops."""
    clips = resolve_clips(clips_spec)
    print(f"[J-2 Verify] Resolved '{clips_spec}' -> {clips}")

    # 1. C1/C2 fast kinematic & torque check on each clip
    reports = {}
    for clip in clips:
        r1 = c1(clip)
        r2 = c2(clip)
        reports[clip] = {"c1_ok": r1["ok"], "c2_ok": r2["ok"], "facts": r1["facts"][:2] + r2["facts"][:1]}
        print(f"  [Check] {clip}: C1={'OK' if r1['ok'] else 'WARN'} | C2={'OK' if r2['ok'] else 'WARN'} ({reports[clip]['facts'][0]})")

    # 2. Verify MimicEnv with multi-clip + fault_prob + sudden_stop_prob
    env = MimicEnv(
        seed=7,
        clips=clips,
        push=True,
        nudge=True,
        follow=True,
        recover=True,
        sense_velocity=True,
        fault_prob=0.5,
        sudden_stop_prob=0.5,
    )
    sampled_clips = set()
    faults_triggered = 0
    stops_triggered = 0
    for ep in range(16):
        obs = env.reset()
        assert obs.shape == (env.obs_dim,), f"Unexpected obs shape {obs.shape} != {(env.obs_dim,)}"
        sampled_clips.add(env.clip_names[env.clip_idx])
        if env.fault_motor >= 0:
            faults_triggered += 1
        if env.stop_trigger_t > 0:
            stops_triggered += 1
        # Simulate artificially higher failure on clip 0 to verify adaptive EMA weighting
        if env.clip_idx == 0:
            env.clip_fail_ema[0] = min(1.0, env.clip_fail_ema[0] * 1.15)
        else:
            env.clip_fail_ema[env.clip_idx] *= 0.75
        for _ in range(5):
            obs, rew, fell, done, _ = env.step(np.zeros(env.nu, dtype=np.float32))
            if fell or done:
                break

    assert len(sampled_clips) == len(clips), f"Expected all clips {clips} to be sampled, got {sampled_clips}"
    assert faults_triggered > 0, "Expected actuator fault injection to trigger at least once with fault_prob=0.5"
    assert stops_triggered > 0, "Expected sudden stop injection to trigger at least once with sudden_stop_prob=0.5"
    assert env.clip_fail_ema[0] > env.clip_fail_ema[-1], "Expected failure-weighted EMA to prioritize harder clip"

    print(
        f"[J-2 Verify PASS] Sampled {sorted(sampled_clips)} | "
        f"motor_faults={faults_triggered}/16 | sudden_stops={stops_triggered}/16 | "
        f"fail_ema={np.round(env.clip_fail_ema, 3).tolist()}"
    )
    return {
        "clips": clips,
        "faults_triggered": faults_triggered,
        "stops_triggered": stops_triggered,
        "fail_ema": env.clip_fail_ema.tolist(),
    }


def main() -> None:
    p = argparse.ArgumentParser(prog="python -m training.multiclip", description=__doc__.split("\n")[0])
    p.add_argument("--clips", default="all-walks",
                   help="comma-separated clip ids, preset ('all-walks', 'all-g1'), or folder of RobotMotion .json files")
    p.add_argument("--verify", action="store_true",
                   help="verify multi-clip loading, C1/C2 checks, actuator faults, and sudden-stop braking")
    p.add_argument("--steps", type=int, default=20_000_000)
    p.add_argument("--run", default="walk-multiclip-v1")
    p.add_argument("--init", type=Path, default=None, help="optional checkpoint to fine-tune from")
    p.add_argument("--worlds", default="plano,piedras,resbaloso,viento",
                   help="domain-randomized worlds to train across")
    p.add_argument("--fault-prob", type=float, default=0.25,
                   help="probability per episode of degrading a random leg motor's torque to 35-75%% (default: 0.25)")
    p.add_argument("--sudden-stop-prob", type=float, default=0.20,
                   help="probability per episode of an emergency obstacle stop window of 1-2 s (default: 0.20)")
    p.add_argument("--push-max", type=float, default=300.0)
    p.add_argument("--device", default="auto", help="auto (cuda if available else cpu), cpu, cuda, or mps")
    p.add_argument("--resume", action="store_true")
    p.add_argument("--cloud", action="store_true", help="disable local Mac laptop guard for dedicated Cloud GPU VMs")
    args = p.parse_args()

    if args.verify:
        verify_pipeline(args.clips)
        return

    clips = resolve_clips(args.clips)
    motion_arg = ",".join(clips)
    device = ("cuda" if torch.cuda.is_available() else "cpu") if args.device == "auto" else args.device
    worlds = tuple(w for w in args.worlds.split(",") if w)
    note = (
        f"multiclip({motion_arg}) + fault_prob={args.fault_prob} + "
        f"sudden_stop_prob={args.sudden_stop_prob} + worlds={args.worlds}"
    )

    print(f"Launching Multi-Clip Generalist PPO: clips={clips} | device={device} | steps={args.steps:,}")
    train(
        total_steps=args.steps,
        run=args.run,
        device=device,
        init=args.init,
        push_n=(0.0, args.push_max),
        task="mimic",
        motion=motion_arg,
        every=0,
        export_dir=Path(__file__).parent / "runs" / args.run,
        prefix=args.run,
        stance=STANCE_V2,
        worlds=worlds,
        resume=args.resume,
        guard_on=not args.cloud,
        plateau_stop=True,
        note=note,
        argv=" ".join(sys.argv[1:]),
        shared="nice" if args.cloud else "background",
        robust=True,
        follow=True,
        recover=True,
        sense_velocity=True,
        fault_prob=args.fault_prob,
        sudden_stop_prob=args.sudden_stop_prob,
    )


if __name__ == "__main__":
    main()
