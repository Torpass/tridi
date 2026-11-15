"""Vista en planta del robot con la ubicacion de cada componente (mm)."""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np, matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.collections import PolyCollection
from matplotlib.patches import Rectangle
import modelo as M

ch = M.chasis()
v, f = ch.val().tessellate(0.05, 0.1)
V = np.array([(p.x, p.y, p.z) for p in v]); T = V[np.array(f)]
zt = T[:, :, 2].mean(1)
fig, ax = plt.subplots(figsize=(11, 8))
for zmin, zmax, c in [(3.4, 3.6, "#f0a467"), (3.9, 4.2, "#8a3a08"), (4.3, 80, "#c45a12")]:
    sel = (zt > zmin) & (zt < zmax)
    ax.add_collection(PolyCollection(T[sel][:, :, :2], facecolors=c, edgecolors=c, linewidths=0.05))

def caja(x0, y0, w, h, color, texto, alpha=0.55, fs=9, tc="black"):
    ax.add_patch(Rectangle((x0, y0), w, h, facecolor=color, edgecolor="black", lw=1, alpha=alpha))
    ax.text(x0 + w / 2, y0 + h / 2, texto, ha="center", va="center", fontsize=fs, color=tc, weight="bold")

from matplotlib.patches import Rectangle as R2
xlc = M.X_L298 + M.L298_S / 2
caja(M.X_L298, -M.L298_S / 2, M.L298_S, M.L298_S, "#c0392b", "", alpha=0.8)
caja(58.5, -14.5, M.X_L298 + M.L298_S + M.L298_ALETAS - 58.5, 29, "#555555", "disip.", fs=7, tc="white", alpha=0.85)
ax.text(44, 0, "L298N\n(4 torres)", ha="center", va="center", fontsize=8.5, color="white", weight="bold")
ax.add_patch(R2((M.X_PROTO0, -M.PROTO_L / 2), M.PROTO_W, M.PROTO_L, fill=False, ls="--", lw=1.6, ec="#222"))
ax.text(30, -31, "Protoboard en bandeja\nelevada 30 mm", ha="center", va="center", fontsize=8, color="#222")
for x, y in M.POSTES_TRAS + M.POSTES_DEL:
    ax.add_patch(matplotlib.patches.Circle((x, y), 4, fc="#7a3307", ec="black", lw=0.8))
caja(M.X_UNO, -M.UNO_L / 2, M.UNO_W, M.UNO_L, "#1f77b4", "Arduino UNO", tc="white", alpha=0.6)
caja(M.X_SENSOR - 2.3, -M.HC_W / 2, 1.6, M.HC_W, "#2c3e90", "", alpha=0.9)
caja(M.X_SENSOR + 1.15, -M.APDS_W / 2, 1.6, M.APDS_W, "#7d3c98", "", alpha=0.95)
ax.text(M.X_SENSOR + 13, 0, "Frente: APDS-9960 arriba\nHC-SR04 abajo", rotation=90, ha="center", va="center", fontsize=8.5, weight="bold", color="#5b2c6f")
for sy in (-1, 1):
    caja(M.X_EJE - 32.5, sy * (M.MOTOR_CARA_EXT + 3 + M.RUEDA_W / 2) - 13, 65, 26, "#333333", "rueda", fs=8, tc="white", alpha=0.35)
ax.annotate("adelante", xy=(165, -60), xytext=(135, -60), arrowprops=dict(arrowstyle="->", lw=1.5), va="center", fontsize=9)
ax.set_xlim(-5, 175); ax.set_ylim(-82, 82); ax.set_aspect("equal")
ax.set_xlabel("X (mm)"); ax.set_ylabel("Y (mm)")
ax.set_title("Robot explorador: vista en planta (portapilas y motores van debajo de la placa)")
plt.tight_layout(); plt.savefig(os.path.join(os.path.dirname(os.path.abspath(__file__)), "render_planta.png"), dpi=120)
print("ok")
