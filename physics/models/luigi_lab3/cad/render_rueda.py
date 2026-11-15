"""Render de la rueda deportiva: rin, llanta y conjunto."""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np, matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from mpl_toolkits.mplot3d.art3d import Poly3DCollection
import rueda as R

def tri(o, tol=0.08):
    v, f = o.val().tessellate(tol, 0.15)
    v = np.array([(p.x, p.y, p.z) for p in v]); return v[np.array(f)]

L = np.array([0.4, -0.5, -0.75]); L /= np.linalg.norm(L)
def shade(T, c):
    n = np.cross(T[:, 1] - T[:, 0], T[:, 2] - T[:, 0]); n /= np.linalg.norm(n, axis=1, keepdims=True) + 1e-9
    k = 0.35 + 0.65 * np.abs(n @ L); return np.clip(np.array(c)[None, :] * k[:, None], 0, 1)

rn, ll = R.rin(), R.llanta()
amarillo, negro = (0.98, 0.84, 0.05), (0.2, 0.2, 0.2)
escenas = [([(rn, amarillo)], (-55, -60), "Rin (cara exterior)"),
           ([(rn, amarillo), (ll, negro)], (-50, -60), "Rueda armada"),
           ([(rn, amarillo), (ll, negro)], (50, -60), "Lado del motor (eje doble D)"),
           ([(rn.cut(R.cq.Workplane("XY").box(80, 40, 80, centered=(True, False, True))), amarillo)], (8, 90),
            "Corte: hueco de 20 mm y encaje del eje")]
fig = plt.figure(figsize=(22, 6.3))
for i, (partes, (e, a), t) in enumerate(escenas):
    ax = fig.add_subplot(1, 4, i + 1, projection="3d")
    T = np.concatenate([tri(o) for o, _ in partes]); C = np.concatenate([shade(tri(o), c) for o, c in partes])
    ax.add_collection3d(Poly3DCollection(T, facecolors=C, edgecolors=C, linewidths=0.05))
    ax.set_xlim(-34, 34); ax.set_ylim(-34, 34); ax.set_zlim(-21, 47)
    ax.set_box_aspect((1, 1, 1)); ax.view_init(e, a); ax.axis("off"); ax.set_title(t, fontsize=13)
plt.tight_layout(); plt.savefig(os.path.join(os.path.dirname(os.path.abspath(__file__)), "render_rueda.png"), dpi=110)
print("ok")
