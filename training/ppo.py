"""PPO for the G1: an MLP policy learns to stand and take pushes, saving checkpoints along the way.

    uv run --project training python -m training.ppo [--task stand|mimic] [--motion <clip>] [--steps 20000000] [--run stand]
        [--every 2000000] [--export-dir <dir>] [--policy-prefix <id>] [--resume] [--note "why this run"]

Checkpoints go to training/runs/<run>/ as step_<N>.pt plus a progress.csv, at 0, 10k, 100k, 1M,
3M, 10M... environment steps (and every --every steps): the pitch shows the same robot at several of
them side by side. Each one is also exported right away as <prefix>-step-<N>.onnx + .json (to
--export-dir, the run folder by default), so the web can load a checkpoint while training goes on.

Long runs on Juan's work Mac (docs/plan-v2.md, section 3):
- guard.py slows the training down while the Mac is in use and pauses it on battery or when hot.
- latest.pt is saved every few minutes and on Ctrl-C; --resume continues a run where it stopped.
- Every checkpoint is evaluated (evals.csv) and plateau.py stops the run when it stops learning,
  writing plateau.md with why. --no-plateau-stop keeps it going anyway.
- Each finished run adds a line to training/experiments.csv (versioned): what changed and what it gave.
"""

from __future__ import annotations

import argparse
import csv
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

import numpy as np
import torch
from torch import nn

from .env import EPISODE_STEPS, NU, OBS_DIM, PUSH_EVERY_S, PUSH_N, STANCE_V2, Stance, stand_obs_dim
from .guard import Guard
from .netlive import NetLive
from .failmap import failure_map, worst
from .plateau import MIN_STEPS, judge, judge_forecast
from .vec import VecEnv

RUNS = Path(__file__).parent / "runs"
REGISTRY = Path(__file__).parent / "experiments.csv"
# latest.pt this often: a crash, a reboot or a closed lid loses at most this much training.
LATEST_EVERY_S = 300
# A long run with no --every still gets enough evaluations for plateau.py to judge it: one every
# this share of the run (20 evaluations over the run), never closer than 1 M steps.
AUTO_EVALS = 20

# 64 robots x 64 steps = 4096 transitions per update. 64 robots fill the 8 cores of an M2 (11.8k
# steps/s measured); 64 steps (1.3 s of robot time) is long enough for GAE to see a stumble's cost.
NUM_ENVS = 64
WORKERS = 8
ROLLOUT = 64

# Standard PPO for continuous control (CleanRL, legged_gym), not tuned for this robot.
GAMMA = 0.99  # values ~2 s ahead (1 / (1 - 0.99) = 100 steps at 50 Hz): enough to feel a coming fall
LAMBDA = 0.95
CLIP = 0.2
EPOCHS = 5
MINIBATCHES = 4
LR = 3e-4
MAX_GRAD_NORM = 1.0
VALUE_COEF = 1.0
ENTROPY_COEF = 0.0  # exploration comes from the learned std, which starts at 0.5 (0.12 rad)
INIT_LOG_STD = np.log(0.5)
# Adaptive learning rate (rsl_rl, the legged_gym trainer): after each minibatch, the step size moves
# so the policy changes by about KL_TARGET per update. With a fixed 3e-4, the KL grew as the std
# narrowed (0.003 at the start of walk-balanced-v1, 0.087 at 10 M steps; 55 % of the batch clipped),
# and fine-tuning a learned walk swung between the whole clip and 1 s from one evaluation to the next.
KL_TARGET = 0.01
LR_STEP = 1.5  # how much the rate moves each time (rsl_rl's factor)
# rsl_rl's floor is 1e-5; fine-tuning the learned walk still changed the policy by KL 0.02 per update
# at 1e-5 (its std is 0.21-0.42 against 0.5 at the start), so the floor here is 10x lower.
LR_RANGE = (1e-6, 1e-2)

# Environment steps where a checkpoint is saved. 1k from the original plan is left out: it is less
# than one update (4096), so it would be the same untrained policy as step 0.
CHECKPOINTS = [0, 10_000, 100_000, 1_000_000, 3_000_000, 10_000_000, 30_000_000, 100_000_000]


class RunningNorm(nn.Module):
    """Running mean and std of the observations, so the network sees inputs near N(0, 1).
    Stored as buffers: the exported ONNX normalizes by itself and the browser sends raw obs."""

    def __init__(self, dim: int):
        super().__init__()
        self.register_buffer("mean", torch.zeros(dim))
        self.register_buffer("var", torch.ones(dim))
        self.register_buffer("count", torch.tensor(1e-4))

    def update(self, x: torch.Tensor) -> None:
        batch_mean, batch_var, n = x.mean(0), x.var(0, unbiased=False), x.shape[0]
        delta = batch_mean - self.mean
        total = self.count + n
        self.mean += delta * n / total
        self.var = (self.var * self.count + batch_var * n + delta**2 * self.count * n / total) / total
        self.count = total

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        # Clipped at 5 std: one strange reading (a contact spike) cannot saturate the network.
        return torch.clamp((x - self.mean) / torch.sqrt(self.var + 1e-8), -5, 5)


def mlp(inp: int, out: int, hidden=(256, 128, 64)) -> nn.Sequential:
    layers, last = [], inp
    for h in hidden:
        layers += [nn.Linear(last, h), nn.ELU()]
        last = h
    layers.append(nn.Linear(last, out))
    return nn.Sequential(*layers)


class ActorCritic(nn.Module):
    """Small enough to run every 20 ms in a phone's browser: ~70k parameters per network."""

    def __init__(self, obs_dim: int = OBS_DIM, nu: int = NU):
        super().__init__()
        self.norm = RunningNorm(obs_dim)
        self.actor = mlp(obs_dim, nu)
        self.critic = mlp(obs_dim, 1)
        self.log_std = nn.Parameter(torch.full((nu,), float(INIT_LOG_STD)))
        # The critic learns returns in units of their running std (value-target normalization). Raw
        # returns reach ~50 (0.5 per step over a 100-step horizon); their squared error dominated the
        # loss and every minibatch's gradient was ~22 against MAX_GRAD_NORM = 1, so it was always
        # clipped and the real step size was unknown (health warning on the walk, 2026-11-03).
        self.ret_norm = RunningNorm(1)
        # Small last layer: the untrained policy starts near the standing pose instead of random.
        nn.init.orthogonal_(self.actor[-1].weight, 0.01)
        nn.init.zeros_(self.actor[-1].bias)

    def dist(self, obs: torch.Tensor) -> torch.distributions.Normal:
        return torch.distributions.Normal(self.actor(self.norm(obs)), self.log_std.exp())

    def value(self, obs: torch.Tensor) -> torch.Tensor:
        """Value in return units."""
        return self.value_normalized(obs) * torch.sqrt(self.ret_norm.var + 1e-8) + self.ret_norm.mean

    def value_normalized(self, obs: torch.Tensor) -> torch.Tensor:
        return self.critic(self.norm(obs)).squeeze(-1)

    def normalize_returns(self, ret: torch.Tensor) -> torch.Tensor:
        return (ret - self.ret_norm.mean) / torch.sqrt(self.ret_norm.var + 1e-8)

    @staticmethod
    def widen(state: dict, extra: int) -> dict:
        """A checkpoint's weights with `extra` new inputs at the end of the observation, wired with
        zero weights: the widened network acts exactly as the old one until training uses them. New
        inputs are normalized as N(0, 1) (pelvis velocity, the one use, is ~0-1 m/s)."""
        state = dict(state)
        state["norm.mean"] = torch.cat([state["norm.mean"], torch.zeros(extra)])
        state["norm.var"] = torch.cat([state["norm.var"], torch.ones(extra)])
        for net in ("actor", "critic"):
            w = state[f"{net}.0.weight"]
            state[f"{net}.0.weight"] = torch.cat([w, torch.zeros(w.shape[0], extra)], dim=1)
        return state

    @classmethod
    def from_state(cls, state: dict) -> "ActorCritic":
        """A network sized as a checkpoint's weights say (any robot), with them loaded."""
        model = cls(state["norm.mean"].shape[0], state["log_std"].shape[0])
        model.load_state_dict(state)
        return model

    def load_state_dict(self, state, strict: bool = True):
        # Checkpoints from before value normalization: identity stats, so their critic means the same.
        state = dict(state)
        for k, v in (("mean", torch.zeros(1)), ("var", torch.ones(1)), ("count", torch.tensor(1e-4))):
            state.setdefault(f"ret_norm.{k}", v)
        return super().load_state_dict(state, strict)


def obs_size(task: str) -> int:
    if task == "mimic":
        from .imitate import MIMIC_OBS_DIM

        return MIMIC_OBS_DIM
    return OBS_DIM


def dims(task: str, motion: str | None, sense_velocity: bool = False) -> tuple[int, int]:
    """Observation and action sizes for this task's robot: the G1's, or the package a mimic motion
    names (training.retarget writes "robot_package")."""
    if task == "mimic":
        from .imitate import DEFAULT_MOTION, mimic_obs_dim, motion_robot

        robot = motion_robot(motion or DEFAULT_MOTION)
        nu = NU
        if robot != "g1":
            from .robot import load

            nu = load(robot).nu
        return mimic_obs_dim(nu, sense_velocity), nu
    return stand_obs_dim(NU, sense_velocity), NU


def save(model: ActorCritic, run_dir: Path, step: int, meta: dict, export_dir: Path | None = None,
         prefix: str = "") -> None:
    """A checkpoint also says what it learned (task and motion), so export and evaluation need no flags.
    With export_dir it is exported to ONNX at once (export.py): every checkpoint is usable by the web
    as soon as it exists, not only the last one."""
    path = run_dir / f"step_{step}.pt"
    torch.save({"model": model.state_dict(), "step": step, **meta}, path)
    if export_dir is not None:
        from .export import export

        print()  # off the \r progress line
        export(path, f"{prefix}-step-{step}", export_dir)


def train(total_steps: int, run: str, device: str, init: Path | None, push_n: tuple[float, float], task: str,
          motion: str | None = None, every: int = 0, export_dir: Path | None = None, prefix: str | None = None,
          push_every: tuple[float, float] = PUSH_EVERY_S, stance: Stance | None = None, std: float | None = None,
          seed: int = 0, worlds: tuple[str, ...] = (), wind_max: float | None = None, resume: bool = False,
          guard_on: bool = True, plateau_stop: bool = True, note: str = "", argv: str = "", shared: str = "background",
          register_run: bool = True, robust: bool = False, adaptive_lr: bool = True, follow: bool = False,
          metric: str = "follow", goal: float = 0.9, budget_steps: float = 100_000_000, recover: bool | float = False,
          sense_velocity: bool = False) -> None:
    run_dir = RUNS / run
    run_dir.mkdir(parents=True, exist_ok=True)
    torch.manual_seed(seed)
    if every <= 0 and total_steps >= 10 * MIN_STEPS:
        every = max(1_000_000, total_steps // AUTO_EVALS // 1_000_000 * 1_000_000)
    obs_dim, nu = dims(task, motion, sense_velocity)
    model = ActorCritic(obs_dim, nu)
    if init:  # continue from an earlier run (its steps are not counted again)
        state = torch.load(init)["model"]
        extra = obs_dim - state["norm.mean"].shape[0]
        if extra > 0:  # an earlier run without the new inputs (--sense-velocity)
            state = ActorCritic.widen(state, extra)
        model.load_state_dict(state)
    if std is not None:
        # A continued run inherits a narrowed std (0.5 -> 0.2 after 40 M steps), and with no entropy
        # bonus it only narrows further: a changed reward needs the exploration opened again.
        model.log_std.data.fill_(np.log(std))
    opt = torch.optim.Adam(model.parameters(), lr=LR, eps=1e-5)
    # Mimic pushes and nudges only with --robust: older mimic runs trained without them.
    envs = VecEnv(NUM_ENVS, WORKERS, seed=seed, push=robust if task == "mimic" else True, push_n=push_n, task=task,
                  motion=motion, push_every=push_every, stance=stance, worlds=worlds, wind_max=wind_max,
                  follow=follow, recover=recover, sense_velocity=sense_velocity)
    obs = envs.reset()
    meta = {"task": task, "motion": motion} if task == "mimic" else {"task": task}
    meta["worlds"] = list(worlds) or ["plano"]
    extra = range(every, total_steps + 1, every) if every > 0 else []
    pending = sorted({c for c in CHECKPOINTS if c <= total_steps} | set(extra))
    out = (export_dir, prefix or run)
    step, elapsed = 0, 0.0
    latest = run_dir / "latest.pt"
    if resume and latest.exists():
        state = torch.load(latest)
        model.load_state_dict(state["model"])
        opt.load_state_dict(state["opt"])
        if not adaptive_lr:
            for g in opt.param_groups:
                g["lr"] = LR
        if std is not None:
            model.log_std.data.fill_(np.log(std))
        step, elapsed = state["step"], state["seconds"]
        pending = [c for c in pending if c > step]
        print(f"resuming {run} at {step:,} steps ({elapsed / 3600:.1f} h trained so far)")
    else:
        save(model, run_dir, 0, meta, *out)
        pending.remove(0)

    # The metric plateau.py judges, higher is better: seconds of the clip followed from its start
    # (imitation, evaluate_walk.run), or mean episode seconds (standing, from training itself).
    ceiling = None
    if task == "mimic":
        from .evaluate_walk import run as follow

        ceiling = follow(None, motion or _default_motion())[1]  # the clip's duration
    else:
        ceiling = EPISODE_STEPS / 50
    evals_path = run_dir / "evals.csv"
    evals: list[tuple[int, float]] = []
    if resume and evals_path.exists():
        with open(evals_path) as f:
            evals = [(int(r["step"]), float(r["metric"])) for r in csv.DictReader(f)]
    else:
        with open(evals_path, "w", newline="") as f:
            csv.writer(f).writerow(["step", "metric", "verdict"])
    recent_eps: list[float] = []

    if metric == "pushwalk":
        from .pushwalk import score as pushwalk_score

        ceiling = 1.0

    def evaluate(at: int) -> float:
        if task == "mimic" and metric == "pushwalk":
            value = pushwalk_score(model, motion or _default_motion())["score"]
            model.train()
            return value
        if task == "mimic":
            model.eval()
            value = follow(model, motion or _default_motion())[0]
            model.train()
            return value
        return float(np.mean(recent_eps[-20:])) if recent_eps else 0.0

    appending = resume and (run_dir / "progress.csv").exists()
    log = open(run_dir / "progress.csv", "a" if appending else "w", newline="")
    writer = csv.writer(log)
    if not appending:
        writer.writerow(["step", "seconds", "reward_per_step", "episode_s", "falls", "steps_per_s", "mode",
                         *HEALTH_COLUMNS])
    ep_len = np.zeros(NUM_ENVS)
    start = time.time() - elapsed
    net = NetLive(run_dir, task, total_steps)  # what the web draws while this trains (netlive.py)
    guard = Guard([os.getpid(), *(p.pid for p in envs.procs)], run_dir, enabled=guard_on, shared=shared)
    saved_at = time.time()
    stopped = {"why": ""}

    def save_latest() -> None:
        torch.save({"model": model.state_dict(), "opt": opt.state_dict(), "step": step,
                    "seconds": time.time() - start - guard.paused_s, **meta}, latest)

    def on_signal(signum, _frame) -> None:
        stopped["why"] = "interrupted"
        raise KeyboardInterrupt

    # Both, set by hand: a run started in the background inherits SIGINT ignored, and Ctrl-C would
    # then do nothing at all. Workers ignore SIGINT (vec.py), so only this process decides.
    signal.signal(signal.SIGTERM, on_signal)
    signal.signal(signal.SIGINT, on_signal)
    verdict = None
    health = Health(run_dir)

    try:
      while step < total_steps:
          guard.checkpoint()
          t0 = time.time()
          buf_obs = np.zeros((ROLLOUT, NUM_ENVS, obs_dim), np.float32)
          buf_act = np.zeros((ROLLOUT, NUM_ENVS, nu), np.float32)
          buf_logp = np.zeros((ROLLOUT, NUM_ENVS), np.float32)
          buf_rew = np.zeros((ROLLOUT, NUM_ENVS), np.float32)
          buf_done = np.zeros((ROLLOUT, NUM_ENVS), np.float32)
          buf_val = np.zeros((ROLLOUT + 1, NUM_ENVS), np.float32)
          finished, falls = [], 0

          # Rollouts run the policy on CPU: 64 observations per call is too small for the GPU to pay
          # off its transfer cost.
          with torch.no_grad():
              for t in range(ROLLOUT):
                  o = torch.as_tensor(obs)
                  d = model.dist(o)
                  a = d.sample()
                  buf_obs[t], buf_act[t] = obs, a.numpy()
                  buf_logp[t] = d.log_prob(a).sum(-1).numpy()
                  buf_val[t] = model.value(o).numpy()
                  obs, rew, term, trunc, final, _ = envs.step(a.numpy())
                  if trunc.any():
                      # Time ran out, the robot did not fall: count the future it would still have had.
                      rew = rew + GAMMA * trunc * model.value(torch.as_tensor(final)).numpy()
                  buf_rew[t], buf_done[t] = rew, term | trunc
                  ep_len += 1
                  for i in np.flatnonzero(term | trunc):
                      finished.append(ep_len[i] / 50)
                      ep_len[i] = 0
                  falls += int(term.sum())
              buf_val[ROLLOUT] = model.value(torch.as_tensor(obs)).numpy()
          model.norm.update(torch.as_tensor(buf_obs.reshape(-1, obs_dim)))

          # Generalized advantage estimation.
          adv = np.zeros_like(buf_rew)
          last = np.zeros(NUM_ENVS, np.float32)
          for t in reversed(range(ROLLOUT)):
              nonterminal = 1.0 - buf_done[t]
              delta = buf_rew[t] + GAMMA * buf_val[t + 1] * nonterminal - buf_val[t]
              last = delta + GAMMA * LAMBDA * nonterminal * last
              adv[t] = last
          ret = adv + buf_val[:ROLLOUT]

          # PPO update, in minibatches of 1024.
          model.to(device)
          b_obs = torch.as_tensor(buf_obs.reshape(-1, obs_dim), device=device)
          b_act = torch.as_tensor(buf_act.reshape(-1, nu), device=device)
          b_logp = torch.as_tensor(buf_logp.reshape(-1), device=device)
          b_adv = torch.as_tensor(adv.reshape(-1), device=device)
          if task != "stand":
              model.ret_norm.update(torch.as_tensor(ret.reshape(-1, 1), dtype=torch.float32, device=device))
          b_ret = model.normalize_returns(torch.as_tensor(ret.reshape(-1), dtype=torch.float32, device=device))
          b_adv = (b_adv - b_adv.mean()) / (b_adv.std() + 1e-8)
          n = b_obs.shape[0]
          mb = n // MINIBATCHES
          kls, clips, norms = [], [], []
          for _ in range(EPOCHS):
              perm = torch.randperm(n, device=device)
              for k in range(MINIBATCHES):
                  idx = perm[k * mb : (k + 1) * mb]
                  d = model.dist(b_obs[idx])
                  logp = d.log_prob(b_act[idx]).sum(-1)
                  ratio = (logp - b_logp[idx]).exp()
                  with torch.no_grad():
                      log_ratio = logp - b_logp[idx]
                      kls.append(float(((ratio - 1) - log_ratio).mean()))  # the low-variance KL estimate (Schulman)
                      clips.append(float(((ratio - 1).abs() > CLIP).float().mean()))
                  pg = -torch.min(ratio * b_adv[idx], ratio.clamp(1 - CLIP, 1 + CLIP) * b_adv[idx]).mean()
                  v_loss = ((model.value_normalized(b_obs[idx]) - b_ret[idx]) ** 2).mean()
                  loss = pg + VALUE_COEF * v_loss - ENTROPY_COEF * d.entropy().sum(-1).mean()
                  opt.zero_grad()
                  loss.backward()
                  norms.append(float(nn.utils.clip_grad_norm_(model.parameters(), MAX_GRAD_NORM)))
                  opt.step()
          if adaptive_lr and kls:
              kl = float(np.mean(kls))
              lr = opt.param_groups[0]["lr"]
              if kl > 2 * KL_TARGET:
                  lr = max(LR_RANGE[0], lr / LR_STEP)
              elif kl < KL_TARGET / 2:
                  lr = min(LR_RANGE[1], lr * LR_STEP)
              for g in opt.param_groups:
                  g["lr"] = lr
          model.to("cpu")
          # How well the critic predicts the returns (1 perfect, 0 no better than the mean).
          returns = ret.reshape(-1)
          explained = 1 - np.var(returns - buf_val[:ROLLOUT].reshape(-1)) / (np.var(returns) + 1e-8)
          health_now = {"kl": float(np.mean(kls)), "clip_frac": float(np.mean(clips)), "explained_var": float(explained),
                        "std": float(model.log_std.detach().exp().mean()), "grad_norm": float(np.mean(norms)), "lr": opt.param_groups[0]["lr"]}

          step += ROLLOUT * NUM_ENVS
          sps = ROLLOUT * NUM_ENVS / (time.time() - t0)
          ep = float(np.mean(finished)) if finished else float("nan")
          if finished:
              recent_eps.append(ep)
          writer.writerow([step, round(time.time() - start, 1), round(float(buf_rew.mean()), 4), round(ep, 2), falls, int(sps),
                           guard.mode, *(float(f"{health_now[c]:.4g}") for c in HEALTH_COLUMNS)])
          for warning in health.check(step, health_now):
              print(f"\n[health] {warning}", flush=True)
          log.flush()
          net.record(step, float(buf_rew.mean()), ep)
          if net.due():
              net.write(model, buf_obs[:, 0], step)
          print(f"\rstep {step:>10,} / {total_steps:,} ({100 * step / total_steps:4.1f}%)  reward/step {buf_rew.mean():.3f}  "
                f"episode {ep:5.1f} s  falls {falls:3d}  {sps:,.0f} steps/s  [{guard.mode}]", end="", flush=True)
          while pending and step >= pending[0]:
              at = pending.pop(0)
              save(model, run_dir, at, meta, *out)
              value = evaluate(at)
              evals.append((step, value))
              verdict = judge_forecast(evals, goal, budget_steps) if metric == "pushwalk" else judge(evals, ceiling)
              with open(evals_path, "a", newline="") as f:
                  csv.writer(f).writerow([step, round(value, 3), verdict.text])
              print(f"\n[eval] {step:,} steps: {value:.2f} (ceiling {ceiling:.1f}) · {verdict.text}", flush=True)
              if task == "mimic":
                  model.eval()
                  fmap = failure_map(model, motion or _default_motion())
                  model.train()
                  write_failmap(run_dir, step, fmap)
                  falls = ", ".join(f"{b:.1f} s ({n})" for b, n in worst(fmap))
                  print(f"[eval] holds 2 s from {100 * fmap['survived'].mean():.0f} % of starts; falls most at {falls or 'nowhere'}",
                        flush=True)
              if verdict.stop and plateau_stop:
                  stopped["why"] = verdict.rule
                  write_report(run_dir, evals, verdict, ceiling)
                  break
          if stopped["why"]:
              break
          if time.time() - saved_at > LATEST_EVERY_S:
              save_latest()
              saved_at = time.time()
    except KeyboardInterrupt:
        stopped["why"] = stopped["why"] or "interrupted"
        print(f"\nstopped at {step:,} steps; continue with --resume")
    finally:
        save_latest()
        guard.close()
    if stopped["why"] != "interrupted":
        save(model, run_dir, step, meta, *out)
    minutes = (time.time() - start) / 60
    print(f"\n{stopped['why'] or 'done'}: {step:,} steps in {minutes:.1f} min -> {run_dir}")
    envs.close()
    if stopped["why"] != "interrupted" and register_run:
        register(run, task, motion, step, minutes, init, evals, stopped["why"] or "done", note, argv, seed, guard.paused_s)


# Learning health, logged every update. Each range is where PPO is known to be working; outside it
# for HEALTH_PATIENCE updates in a row, the run warns (once per HEALTH_EVERY_S) and health.txt keeps it.
HEALTH_COLUMNS = ["kl", "clip_frac", "explained_var", "std", "grad_norm", "lr"]
HEALTH_RULES = [
    # 0.05: PPO's usual target is ~0.01-0.02; at 0.05 one update moves the policy far enough to undo
    # what it had learned (the reason for CLIP in the first place).
    ("kl", lambda v: v > 0.05, "KL {v:.3f} > 0.05: updates too big; lower LR or EPOCHS"),
    ("clip_frac", lambda v: v > 0.3, "clip fraction {v:.2f} > 0.3: most of the batch is clipped, the update is fighting itself"),
    # After the first 1 M steps the critic should explain at least a fifth of the returns; below
    # that the advantages are noise and the policy learns nothing from them.
    ("explained_var", lambda v: v < 0.2, "critic explains {v:.2f} of the returns (< 0.2): advantages are noise"),
    # 0.05 rad x ACTION_SCALE: the robot no longer tries anything new; std collapsed (walk-v4 risk:
    # no entropy bonus, so std only narrows). Reopen with --std or add entropy.
    ("std", lambda v: v < 0.05, "action std {v:.3f} < 0.05: exploration collapsed; reopen with --std 0.3"),
    # Gradient norm over 3x the clip on average: the loss scale is off and the real step size unknown.
    # Clipping by up to ~3x is ordinary PPO (advantages are normalized, so the policy term alone sits
    # around 1-2). Before value normalization the walk ran at ~22x; after it, 1-2.4x (2026-11-03).
    ("grad_norm", lambda v: v > 3 * MAX_GRAD_NORM, "gradient norm {v:.2f} > 3x the clip: loss scale is off"),
]
HEALTH_PATIENCE = 20  # updates (~80 k steps): one bad update is noise, twenty in a row is a trend
HEALTH_FROM = 1_000_000  # the first million steps are allowed to be messy
HEALTH_EVERY_S = 600


class Health:
    def __init__(self, run_dir: Path):
        self.path = run_dir / "health.txt"
        self.streak = {name: 0 for name, _, _ in HEALTH_RULES}
        self.said = {name: 0.0 for name, _, _ in HEALTH_RULES}

    def check(self, step: int, values: dict) -> list[str]:
        out = []
        for name, bad, message in HEALTH_RULES:
            self.streak[name] = self.streak[name] + 1 if step >= HEALTH_FROM and bad(values[name]) else 0
            if self.streak[name] >= HEALTH_PATIENCE and time.time() - self.said[name] > HEALTH_EVERY_S:
                self.said[name] = time.time()
                line = f"{step:,} steps: " + message.format(v=values[name])
                with open(self.path, "a") as f:
                    f.write(f"- {line}\n")
                out.append(line)
        return out


def write_failmap(run_dir: Path, step: int, fmap: dict) -> None:
    """failmap.csv: falls per stretch at every evaluation (one row per evaluation), and failmap.txt:
    the last one, readable."""
    from .failmap import text

    path = run_dir / "failmap.csv"
    new = not path.exists()
    with open(path, "a", newline="") as f:
        w = csv.writer(f)
        if new:
            w.writerow(["step", "held_share", *(f"{b:.1f}" for b in fmap["bins"])])
        w.writerow([step, round(float(fmap["survived"].mean()), 3), *fmap["falls_per_bin"].tolist()])
    (run_dir / "failmap.txt").write_text(f"{step:,} steps\n" + text(fmap) + "\n")


def _default_motion() -> str:
    from .imitate import DEFAULT_MOTION

    return DEFAULT_MOTION


def write_report(run_dir: Path, evals: list[tuple[int, float]], verdict, ceiling: float | None) -> None:
    """plateau.md: why the run was stopped, with the curve, so the next run changes the right thing."""
    lines = [f"# {run_dir.name}: stopped ({verdict.rule})", "", verdict.text, "", "| steps | metric |", "| ---: | ---: |"]
    lines += [f"| {s:,} | {v:.2f} |" for s, v in evals]
    if verdict.rule != "done":
        lines += ["", "## What to look at before training more", "",
                  "- Is the reference feasible? `python -m training.diagnose_reference <clip>` (control C1).",
                  "- Where does it fall? The failure map per stretch of the clip (control in docs/plan-v2.md, section 3).",
                  "- Is it still exploring? The action std in the checkpoints: a collapsed std learns nothing new.",
                  "- Change one thing (reward, observation, curriculum, network) and compare against this run."]
    if (run_dir / "failmap.txt").exists():
        lines += ["", "## Where it falls (last evaluation)", "", "```", (run_dir / "failmap.txt").read_text().rstrip(), "```"]
    if (run_dir / "health.txt").exists():
        lines += ["", "## Learning health warnings", "", (run_dir / "health.txt").read_text().rstrip()]
    if ceiling:
        lines.insert(3, f"Ceiling: {ceiling:.2f}")
    (run_dir / "plateau.md").write_text("\n".join(lines) + "\n")


def register(run: str, task: str, motion: str | None, steps: int, minutes: float, init: Path | None,
             evals: list[tuple[int, float]], why: str, note: str, argv: str, seed: int, paused_s: float) -> None:
    """One line per finished run in training/experiments.csv: the lab notebook, versioned."""
    try:
        commit = subprocess.run(["git", "rev-parse", "--short", "HEAD"], capture_output=True, text=True,
                                cwd=Path(__file__).parent).stdout.strip()
    except OSError:
        commit = ""
    new = not REGISTRY.exists()
    with open(REGISTRY, "a", newline="") as f:
        w = csv.writer(f)
        if new:
            w.writerow(["date", "run", "commit", "task", "motion", "seed", "steps", "minutes", "paused_min", "init",
                        "final", "best", "stopped", "note", "command"])
        best = max((v for _, v in evals), default=float("nan"))
        final = evals[-1][1] if evals else float("nan")
        w.writerow([time.strftime("%Y-%m-%d %H:%M"), run, commit, task, motion or "", seed, steps, round(minutes, 1),
                    round(paused_s / 60, 1), str(init or ""), round(final, 3), round(best, 3), why, note, argv])


def main() -> None:
    p = argparse.ArgumentParser(prog="python -m training.ppo", description=__doc__.split("\n")[0])
    p.add_argument("--steps", type=int, default=20_000_000)
    p.add_argument("--run", default="stand")
    p.add_argument("--task", choices=["stand", "mimic", "walk"], default="stand",
                   help="stand: balance and pushes (env.py); mimic: imitate a RobotMotion (imitate.py); walk: old name of mimic")
    p.add_argument("--motion", help="mimic: a RobotMotion .json, or a clip id in physics/motions/ (default: the walk)")
    p.add_argument("--init", type=Path, help="checkpoint to continue from")
    p.add_argument("--every", type=int, default=0, help="also save a checkpoint every this many steps")
    p.add_argument("--export-dir", type=Path, help="export each checkpoint to ONNX here (default: the run folder)")
    p.add_argument("--no-export", action="store_true", help="save .pt checkpoints only")
    p.add_argument("--policy-prefix", help="policy id prefix of the exports (default: the run name)")
    p.add_argument("--push-min", type=float, default=PUSH_N[0], help="weakest random push, N")
    p.add_argument("--push-max", type=float, default=PUSH_N[1], help="strongest random push, N")
    p.add_argument("--push-every", default=f"{PUSH_EVERY_S[0]},{PUSH_EVERY_S[1]}",
                   help="seconds between random pushes, min,max (default 2,4; a quiet stance needs 4,8 to settle between them)")
    p.add_argument("--reward", default="", help="stance terms (env.py Stance), e.g. turn=0.3,feet=0.5,planted=0.1,rate=0.02,calm_s=1")
    p.add_argument("--worlds", default="",
                   help="train in these worlds of physics/worlds/, e.g. plano,piedras,resbaloso,viento (training/worlds.py); "
                        "empty: the flat floor, as before. Pushes then come from each world, capped by --push-max")
    p.add_argument("--wind-max", type=float,
                   help="--worlds: cap every world's wind at this many m/s (a curriculum: e.g. 6, then 10, then none)")
    p.add_argument("--follow", action="store_true",
                   help="mimic: the reference path slides with a pushed robot past 0.3 m instead of cutting the episode at 0.6 m")
    p.add_argument("--metric", choices=["follow", "pushwalk"], default="follow",
                   help="mimic: what decides when to stop: seconds of the clip followed, or the web push test (pushwalk.py), "
                        "judged by its learning-curve forecast")
    p.add_argument("--goal", type=float, default=0.9, help="pushwalk: the score that counts as done")
    p.add_argument("--budget-steps", type=float, default=100_000_000,
                   help="pushwalk: stop when the forecast reaches the goal only past this many steps")
    p.add_argument("--recover", nargs="?", const=True, default=False, type=float, metavar="SECONDS",
                   help="mimic: for RECOVER_S (or SECONDS) after a push, reward staying up over copying the pose (imitate.py)")
    p.add_argument("--sense-velocity", action="store_true",
                   help="the policy also observes its 3D pelvis velocity in the pelvis frame (3 more inputs; env.py / imitate.py)")
    p.add_argument("--fixed-lr", action="store_true", help=f"keep the learning rate at {LR} (runs before the adaptive rate)")
    p.add_argument("--std", type=float, help="reset the action std to this (e.g. 0.3) when continuing with --init")
    p.add_argument("--seed", type=int, default=0, help="torch and environment seed (every run replays seed 0 otherwise)")
    # CPU by default: measured on an M2, 11.2k steps/s on CPU vs 10.1k on MPS. This network is so small
    # that moving each minibatch to the GPU costs more than the GPU saves. --device mps to compare.
    p.add_argument("--device", default="cpu")
    p.add_argument("--resume", action="store_true", help="continue this run from its latest.pt (after Ctrl-C, a crash or a reboot)")
    p.add_argument("--no-guard", action="store_true", help="train flat out: no slowing down while the Mac is in use, no pauses")
    p.add_argument("--shared", choices=["background", "nice"], default="background",
                   help="while the Mac is in use: background (cool and quiet, ~8x slower) or nice (fast, warm)")
    p.add_argument("--no-plateau-stop", action="store_true", help="keep training even if plateau.py says it stopped learning")
    p.add_argument("--robust", action="store_true",
                   help="mimic: nudged starts and random pushes (--push-min/--push-max), so the motion survives both")
    p.add_argument("--note", default="", help="what this run changes and why (goes to training/experiments.csv)")
    args = p.parse_args()
    task = "mimic" if args.task == "walk" else args.task
    export_dir = None if args.no_export else (args.export_dir or RUNS / args.run)
    if args.reward == "v2":
        stance = STANCE_V2
    elif args.reward:
        stance = Stance(**{k: float(v) for k, v in (kv.split("=") for kv in args.reward.split(",") if kv)})
    else:
        stance = None
    push_every = tuple(float(v) for v in args.push_every.split(","))
    train(args.steps, args.run, args.device, args.init, (args.push_min, args.push_max), task, args.motion,
          args.every, export_dir, args.policy_prefix, push_every, stance, args.std, args.seed,
          tuple(w for w in args.worlds.split(",") if w), args.wind_max, args.resume, not args.no_guard,
          not args.no_plateau_stop, args.note, " ".join(sys.argv[1:]), args.shared, robust=args.robust, adaptive_lr=not args.fixed_lr, follow=args.follow,
          metric=args.metric, goal=args.goal, budget_steps=args.budget_steps, recover=args.recover,
          sense_velocity=args.sense_velocity)


if __name__ == "__main__":
    main()
