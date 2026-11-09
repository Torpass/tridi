"""Can this clip be learned? The four controls before any long training (docs/plan-v2.md, section 3).

    uv run --project training python -m training.checks <clip id or RobotMotion.json> [--only c1,c2] [--steps-c3 2000000]

C1  reference feasible: diagnose_reference.py's four parts and verdict (feet, ranges, motors with
    the pelvis held). Seconds.
C2  physics feasible: motors at their torque limit with the pelvis held, and the reference's zero
    moment point against the feet on the floor (is the motion balanced at all?). Seconds.
C3  small overfit: train on the first second of the clip only. If it cannot learn 1 s, it will not
    learn 12: the problem is the reward or the observation, not the step count. Minutes.
C4  smoke: 1 M steps of the full clip: reward and episode length must go up. Minutes.

Writes training/runs/checks-<clip>/report.md and prints the verdict. C3 and C4 train with the guard
on, like any other run; they are not added to experiments.csv.
"""

from __future__ import annotations

import argparse
import csv
import json
import tempfile
from pathlib import Path

import mujoco
import numpy as np
import torch

from .imitate import CONTROL_DT, MIMIC_OBS_DIM, MimicEnv, motion_path

RUNS = Path(__file__).parent / "runs"

# C2. A motor at its torque limit in more than 2 % of the decisions (one in 50: ~0.25 s of a 12 s
# clip) with the pelvis held cannot follow that stretch once it also carries the body.
TORQUE_SHARE = 0.02
# ZMP outside the feet by more than 3 cm (the foot spheres' radius is about that: closer is within
# what the sole's real edge would still hold) in more than 10 % of the decisions.
ZMP_TOL_M = 0.03
ZMP_SHARE = 0.10
# The center of mass is smoothed over 0.2 s before its second derivative: a 30 fps video's jitter,
# differentiated twice, swamps the real accelerations of a walk (~1 m/s^2).
ZMP_SMOOTH_S = 0.2
# C3. Followed 90 % of the 1 s slice from its start.
C3_SECONDS = 1.0
C3_STEPS = 2_000_000
C3_PASS = 0.9
# C4. Mean episode length in the last fifth of the smoke run at least 10 % longer than in the first.
C4_STEPS = 1_000_000
C4_GAIN = 0.10


def c1(clip: str) -> dict:
    from .diagnose_reference import analyze

    a = analyze(clip)
    h = a["h"]
    led = a["led"]
    return {"ok": not a["problems"], "problems": a["problems"],
            "facts": [f"error de piernas con la pelvis sostenida {h['rms'][a['legs']].mean():.3f} rad "
                      f"({led['rms'][a['legs']].mean():.3f} apuntando adelante lo que atrasa cada motor)",
                      f"pies en el piso cuando la referencia lo dice {100 * h['contact_agree']:.0f} % "
                      f"({100 * led['contact_agree']:.0f} % apuntando adelante)",
                      f"pie apoyado que patina {a['k']['slip_speed']:.2f} m/s",
                      f"retraso máximo de un motor {1000 * h['delay_s'].max():.0f} ms"]}


def c2(clip: str) -> dict:
    """Two physical tests of the reference itself.

    Torque: the reference played with the pelvis held (diagnose_reference's part 4): which motors sit
    at their torque limit. Held up, they only carry the limbs; a motor saturated even then cannot
    follow that joint with the body's weight on it.

    Balance: the zero moment point (ZMP) of the reference's center of mass, against the support
    polygon of the feet the reference has on the floor. A ZMP outside it means the motion only
    stays up by a force that does not exist: the policy has to change the motion to balance, and
    imitation rewards fight it. (Inverse dynamics with mj_inverse was tried first: with soft
    contacts it cannot infer the floor's forces from a kinematic reference, and asked for the whole
    weight from outside even standing still.)"""
    from .diagnose_reference import CONTACT_M, analyze, foot_clearance
    from .imitate import FOOT_SPHERES

    a = analyze(clip)
    env, names = a["env"], a["names"]
    model, motion = env.model, env.motion
    sat = a["h"]["saturated"]
    data = mujoco.MjData(model)
    floor = model.geom("floor").id
    geoms = {s: [model.geom(n).id for n in ns] for s, ns in FOOT_SPHERES.items()}
    times = np.arange(0.0, motion.duration, CONTROL_DT)
    com, support = [], []
    for t in times:
        data.qpos[:] = motion.sample(t)[0]
        mujoco.mj_kinematics(model, data)
        mujoco.mj_comPos(model, data)
        com.append(data.subtree_com[0].copy())
        clearance = foot_clearance(model, data, floor, geoms)
        # Support: the capsule ends of the feet on the floor that are themselves within CONTACT_M of it
        # (a heel lifted at toe-off does not hold anything). Until 2026-11-03 this took the capsules'
        # centers, a 4 x 5 cm triangle at the front of the foot that left out the heel.
        pts = [p[:2].copy() for s in geoms if clearance[s] < CONTACT_M
               for p, r, _ in sole_points(model, data, s) if p[2] - r < CONTACT_M]
        support.append(np.array(pts))
    com = np.array(com)
    # Center of mass acceleration from a 30 fps video is noisy: smoothed over ZMP_SMOOTH_S first.
    from .imitate import smooth

    acc = np.gradient(np.gradient(smooth(com, max(1, int(round(ZMP_SMOOTH_S / CONTROL_DT)))), CONTROL_DT, axis=0),
                      CONTROL_DT, axis=0)
    zmp = com[:, :2] - com[:, 2:3] / 9.81 * acc[:, :2]
    outside = np.array([distance_outside(p, pts) for p, pts in zip(zmp, support)])
    finite = outside[np.isfinite(outside)]
    walking = "caminar" in clip or "walk" in clip
    # A walk has no flight phase (c1 checks float_share <= 5 %), so any frame with no foot down is out of
    # balance. Motions with flight (running, jumping jacks) have no floor support while airborne: their
    # ZMP is judged over the stance decisions (`finite`), when at least one foot is on the floor.
    off = float(np.mean(outside > ZMP_TOL_M)) if walking else (float(np.mean(finite > ZMP_TOL_M)) if len(finite) else 1.0)
    problems = []
    # Only motors that carry the body fail the check: legs and waist. On the walk the right wrist
    # pitch saturated 4-5 % with a reference that is 0 the whole clip: the held pelvis is dragged along
    # its path and shakes the hand, and its 5 N m motor gives out. A wrist cannot topple the robot.
    # Arms are listed in the facts; with manipulation (ladder step 4) they will carry loads and count.
    body = np.array([any(p in n for p in ("hip", "knee", "ankle", "waist")) for n in names])
    if (sat * body).max() > TORQUE_SHARE:
        j = int(np.argmax(sat * body))
        problems.append(f"{names[j]} está al límite de torque en {100 * sat[j]:.0f} % de las decisiones, aun con la pelvis sostenida")
    if off > ZMP_SHARE:
        problems.append(f"el ZMP queda fuera de los pies apoyados en {100 * off:.0f} % de las decisiones: "
                        "la referencia no está en equilibrio y la política tiene que cambiarla para no caerse")
    worst = np.argsort(-sat)[:3]
    return {"ok": not problems, "problems": problems,
            "facts": ["motores al límite (pelvis sostenida): " + ", ".join(f"{names[j]} {sat[j]:.0%}" for j in worst),
                      f"ZMP fuera del apoyo (> {100 * ZMP_TOL_M:.0f} cm): {off:.0%} de las decisiones; "
                      f"sin ningún pie apoyado: {np.mean(~np.isfinite(outside)):.0%}; "
                      f"distancia p95 {100 * (np.percentile(finite, 95) if len(finite) else 0):.0f} cm"]}


def sole_points(model: mujoco.MjModel, data: mujoco.MjData, side: str) -> list[tuple[np.ndarray, float, int]]:
    """The ends of a foot's collision capsules: (world position of the end's center, radius, geom id).
    The G1's sole is three capsules along the foot (the middle one from heel to toe); their ends, not
    their centers, bound where the foot can push on the floor. Needs kinematics."""
    from .imitate import FOOT_SPHERES

    out = []
    for n in FOOT_SPHERES[side]:
        g = model.geom(n)
        axis = data.geom_xmat[g.id].reshape(3, 3)[:, 2]
        half = g.size[1] if model.geom_type[g.id] == mujoco.mjtGeom.mjGEOM_CAPSULE else 0.0
        for sign in (-1, 1):
            out.append((data.geom_xpos[g.id] + sign * half * axis, float(g.size[0]), g.id))
    return out


def distance_outside(p: np.ndarray, pts: np.ndarray) -> float:
    """How far point p is outside the convex hull of pts (0 inside), in the floor plane."""
    if len(pts) == 0:
        return float("inf")
    if len(pts) < 3:
        # One foot sphere or two: the support is a point or a segment.
        if len(pts) == 1:
            return float(np.linalg.norm(p - pts[0]))
        a, b = pts[0], pts[1]
        t = np.clip(np.dot(p - a, b - a) / max(np.dot(b - a, b - a), 1e-12), 0, 1)
        return float(np.linalg.norm(p - (a + t * (b - a))))
    hull = convex_hull(pts)
    inside = all(cross2(hull[(i + 1) % len(hull)] - hull[i], p - hull[i]) >= 0 for i in range(len(hull)))
    if inside:
        return 0.0
    best = np.inf
    for i in range(len(hull)):
        a, b = hull[i], hull[(i + 1) % len(hull)]
        t = np.clip(np.dot(p - a, b - a) / max(np.dot(b - a, b - a), 1e-12), 0, 1)
        best = min(best, float(np.linalg.norm(p - (a + t * (b - a)))))
    return best


def cross2(a: np.ndarray, b: np.ndarray) -> float:
    """z of the cross product of two floor-plane vectors (numpy 2 no longer takes 2D in np.cross)."""
    return float(a[0] * b[1] - a[1] * b[0])


def convex_hull(pts: np.ndarray) -> np.ndarray:
    """Monotone chain, counter-clockwise."""
    pts = np.unique(pts.round(6), axis=0)
    pts = pts[np.lexsort((pts[:, 1], pts[:, 0]))]
    if len(pts) < 3:
        return pts
    def half(points):
        out = []
        for q in points:
            while len(out) >= 2 and cross2(out[-1] - out[-2], q - out[-2]) <= 0:
                out.pop()
            out.append(q)
        return out
    lower, upper = half(pts), half(pts[::-1])
    return np.array(lower[:-1] + upper[:-1])


def slice_motion(clip: str, seconds: float, out: Path) -> Path:
    """The first `seconds` of a RobotMotion, as a new RobotMotion file."""
    m = json.loads(motion_path(clip).read_text())
    frames = int(round(seconds * float(m["fps"]))) + 1
    m = {**m, "clip_id": f"{m['clip_id']}-first-{seconds:g}s", "qpos": m["qpos"][:frames]}
    out.write_text(json.dumps(m))
    return out


SHARED = "nice"  # set by --shared


def _train(run: str, motion: str, steps: int, stop_when_done: bool = False) -> Path:
    from .ppo import train

    # C3 stops as soon as the slice is learned (plateau.py's "done"); C4 always runs its full million.
    train(steps, run, "cpu", None, (0.0, 0.0), "mimic", motion, export_dir=None, prefix=run, plateau_stop=stop_when_done,
          register_run=False, note="training.checks", shared=SHARED)
    return RUNS / run


def c3(clip: str, steps: int) -> dict:
    from .evaluate_walk import run as follow
    from .ppo import ActorCritic

    tmp = slice_motion(clip, C3_SECONDS, Path(tempfile.mkdtemp()) / "slice.json")
    run_dir = _train(f"checks-c3-{Path(clip).stem}", str(tmp), steps, stop_when_done=True)
    last = max(run_dir.glob("step_*.pt"), key=lambda p: int(p.stem.split("_")[1]))
    model = ActorCritic.from_state(torch.load(last)["model"])
    model.eval()
    followed, duration, _, _ = follow(model, str(tmp))
    ok = followed >= C3_PASS * duration
    return {"ok": ok, "problems": [] if ok else [f"en {steps:,} pasos no aprende ni el primer segundo ({followed:.2f} de {duration:.2f} s): "
                                                 "revisar recompensa y observación antes de entrenar más"],
            "facts": [f"sigue {followed:.2f} s de {duration:.2f} s"]}


def c4(clip: str) -> dict:
    run_dir = _train(f"checks-c4-{Path(clip).stem}", clip, C4_STEPS)
    with open(run_dir / "progress.csv") as f:
        rows = [r for r in csv.DictReader(f) if r["episode_s"] not in ("nan", "")]
    fifth = max(1, len(rows) // 5)
    ep = lambda part: float(np.mean([float(r["episode_s"]) for r in part]))  # noqa: E731
    rew = lambda part: float(np.mean([float(r["reward_per_step"]) for r in part]))  # noqa: E731
    first, last = rows[:fifth], rows[-fifth:]
    gain = ep(last) / ep(first) - 1
    ok = gain >= C4_GAIN and rew(last) > rew(first)
    return {"ok": ok, "problems": [] if ok else [f"en {C4_STEPS:,} pasos el episodio crece {gain:+.0%} y la recompensa "
                                                 f"{rew(first):.3f} → {rew(last):.3f}: no está aprendiendo"],
            "facts": [f"episodio {ep(first):.2f} → {ep(last):.2f} s ({gain:+.0%}), recompensa {rew(first):.3f} → {rew(last):.3f}"]}


def main() -> None:
    p = argparse.ArgumentParser(prog="python -m training.checks", description=__doc__.split("\n")[0])
    p.add_argument("clip", help="clip id in physics/motions/ or a RobotMotion .json")
    p.add_argument("--only", default="c1,c2,c3,c4", help="which controls, e.g. c1,c2 (the fast ones)")
    p.add_argument("--steps-c3", type=int, default=C3_STEPS)
    # nice by default: the checks take minutes, and in background priority (~500 steps/s with the
    # Mac in use) C3 alone took over an hour. Apps still come first at nice 10.
    p.add_argument("--shared", choices=["background", "nice"], default="nice")
    args = p.parse_args()
    global SHARED
    SHARED = args.shared
    wanted = args.only.split(",")
    names = {"c1": "C1 referencia factible", "c2": "C2 física factible", "c3": f"C3 sobreajuste de {C3_SECONDS:g} s",
             "c4": f"C4 humo de {C4_STEPS / 1e6:g} M pasos"}
    runs = {"c1": lambda: c1(args.clip), "c2": lambda: c2(args.clip), "c3": lambda: c3(args.clip, args.steps_c3),
            "c4": lambda: c4(args.clip)}
    out = RUNS / f"checks-{Path(args.clip).stem}"
    out.mkdir(parents=True, exist_ok=True)
    # Results of every control ever run on this clip: --only c3,c4 must not erase a failed C1 from
    # the verdict (it did once, and the report said "ready" with C1 and C2 failing).
    store = out / "results.json"
    results = json.loads(store.read_text()) if store.exists() else {}
    for key in wanted:
        r = runs[key]()
        results[key] = {k: r[k] for k in ("ok", "facts", "problems")}
        print(f"\n{'✅' if r['ok'] else '❌'} {names[key]}")
        for fact in r["facts"]:
            print(f"   {fact}")
        for problem in r["problems"]:
            print(f"   ✗ {problem}")
    store.write_text(json.dumps(results, ensure_ascii=False, indent=1))
    lines = [f"# Controles de {args.clip}", ""]
    for key in sorted(results):
        r = results[key]
        lines += [f"## {'✅' if r['ok'] else '❌'} {names[key]}", ""]
        lines += [f"- {fact}" for fact in r["facts"]] + [f"- **{p}**" for p in r["problems"]] + [""]
    missing = [names[k] for k in names if k not in results]
    passed = all(r["ok"] for r in results.values()) and not missing
    verdict = ("Listo para entrenar largo." if passed else
               "No entrenar largo todavía: " + ("arreglar lo marcado ❌ primero." if not all(r["ok"] for r in results.values())
                                               else "faltan " + ", ".join(missing) + "."))
    print(f"\n{verdict}")
    lines.append(f"**{verdict}**")
    (out / "report.md").write_text("\n".join(lines) + "\n")
    print(f"-> {out / 'report.md'}")


if __name__ == "__main__":
    main()
