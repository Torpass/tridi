"""Acercamiento al frente del robot: HC-SR04 abajo, APDS-9960 arriba."""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np, matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from mpl_toolkits.mplot3d.art3d import Poly3DCollection
import modelo as M

def tri(o, tol=0.15):
    v, f = o.val().tessellate(tol, 0.2)
    v = np.array([(p.x, p.y, p.z) for p in v]); return v[np.array(f)]

L = np.array([0.6, -0.3, 0.75]); L /= np.linalg.norm(L)
def shade(T, c):
    n = np.cross(T[:, 1] - T[:, 0], T[:, 2] - T[:, 0]); n /= np.linalg.norm(n, axis=1, keepdims=True) + 1e-9
    k = 0.4 + 0.6 * np.abs(n @ L); return np.clip(np.array(c)[None, :] * k[:, None], 0, 1)

caja = M.cq.Workplane("XY").box(40, 70, 60, centered=(False, True, False)).translate((112, 0, -1))
ch = M.chasis().intersect(caja)
comps = M.componentes()
partes = [(tri(ch), (0.95, 0.45, 0.10))]
for k, c in (("hcsr04", (0.2, 0.35, 0.8)), ("apds9960", (0.5, 0.15, 0.6)), ("hc_conector", (0.15, 0.15, 0.15))):
    partes.append((tri(comps[k].translate((0, 0, -M.ALTURA_PLACA))), c))
fig = plt.figure(figsize=(14, 6.5))
for i, (e, a, t) in enumerate([(15, 25, "Frente visto por el operador"), (25, -140, "Por detras: ranura del APDS-9960")]):
    ax = fig.add_subplot(1, 2, i + 1, projection="3d")
    T = np.concatenate([p[0] for p in partes]); C = np.concatenate([shade(p[0], p[1]) for p in partes])
    ax.add_collection3d(Poly3DCollection(T, facecolors=C, edgecolors=C, linewidths=0.05))
    ax.set_xlim(115, 165); ax.set_ylim(-25, 25); ax.set_zlim(-2, 48)
    ax.set_box_aspect((1, 1, 1)); ax.view_init(e, a); ax.axis("off"); ax.set_title(t, fontsize=13)
plt.tight_layout(); plt.savefig(os.path.join(os.path.dirname(os.path.abspath(__file__)), "render_frente.png"), dpi=110)
print("ok")
