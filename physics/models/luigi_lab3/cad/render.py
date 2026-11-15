import sys, os
sys.path.insert(0, os.path.dirname(__file__))
import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from mpl_toolkits.mplot3d.art3d import Poly3DCollection
import modelo as M

def tri(obj, tol=0.4):
    v, f = obj.val().tessellate(tol, 0.3)
    v = np.array([(p.x, p.y, p.z) for p in v]); f = np.array(f)
    return v[f]

LUZ = np.array([0.4, 0.3, 0.85]); LUZ /= np.linalg.norm(LUZ)

def dibujar(ax, partes, elev, azim):
    T_all, C_all = [], []
    for tris, color in partes:
        n = np.cross(tris[:, 1] - tris[:, 0], tris[:, 2] - tris[:, 0])
        n /= (np.linalg.norm(n, axis=1, keepdims=True) + 1e-9)
        k = 0.45 + 0.55 * np.abs(n @ LUZ)
        T_all.append(tris); C_all.append(np.clip(np.array(color)[None, :] * k[:, None], 0, 1))
    T_all = np.concatenate(T_all); C_all = np.concatenate(C_all)
    pc = Poly3DCollection(T_all, facecolors=C_all, edgecolors=C_all, linewidths=0.1)
    ax.add_collection3d(pc)
    allv = np.concatenate([p[0].reshape(-1, 3) for p in partes])
    c = (allv.max(0) + allv.min(0)) / 2; r = (allv.max(0) - allv.min(0)).max() / 2
    ax.set_xlim(c[0] - r, c[0] + r); ax.set_ylim(c[1] - r, c[1] + r); ax.set_zlim(c[2] - r, c[2] + r)
    ax.set_box_aspect((1, 1, 1)); ax.view_init(elev, azim); ax.axis("off")

def figura(partes, vistas, nombre, titulos):
    fig = plt.figure(figsize=(6 * len(vistas), 6), facecolor="white")
    for i, ((e, a), t) in enumerate(zip(vistas, titulos)):
        ax = fig.add_subplot(1, len(vistas), i + 1, projection="3d")
        dibujar(ax, partes, e, a); ax.set_title(t, fontsize=13)
    plt.tight_layout(); plt.savefig(nombre, dpi=110); plt.close()

out = os.path.dirname(os.path.abspath(__file__))
ch = M.chasis()
comps = M.componentes()
naranja = (0.95, 0.45, 0.10)
col = {"rines": (0.98, 0.85, 0.05), "llantas": (0.15, 0.15, 0.15), "motores": (0.95, 0.80, 0.15), "portapilas": (0.2, 0.2, 0.2),
       "arduino": (0.0, 0.5, 0.7), "l298n": (0.75, 0.12, 0.12), "hcsr04": (0.2, 0.35, 0.8),
       "protoboard": (0.92, 0.92, 0.88), "apds9960": (0.5, 0.15, 0.6),
       "hc_conector": (0.12, 0.12, 0.12), "bandeja": (0.85, 0.35, 0.05)}
z0 = M.ALTURA_PLACA
piezas = ch.union(M.soporte_motor()).union(M.soporte_derecho()).union(M.patin())
partes = [(tri(piezas.translate((0, 0, z0))), naranja)] + [(tri(v), col[k]) for k, v in comps.items()]
figura(partes, [(25, -55), (25, 125), (-30, -60)], f"{out}/render_robot.png",
       ["Robot: vista frontal 3/4", "Vista trasera 3/4", "Vista inferior"])
figura([(tri(ch), naranja), (tri(M.bandeja().translate((0, 0, M.T + M.POSTE_H + 25))), (0.85, 0.35, 0.05)),
        (tri(M.soporte_motor().translate((0, 0, -15))), (0.85, 0.35, 0.05)),
        (tri(M.soporte_derecho().translate((0, 0, -15))), (0.85, 0.35, 0.05)), (tri(M.patin().translate((0, 0, -15))), (0.85, 0.35, 0.05))],
       [(35, -60), (-30, -60)], f"{out}/render_chasis.png",
       ["Piezas a imprimir (explosionado)", "Vista inferior"])
print("ok")
