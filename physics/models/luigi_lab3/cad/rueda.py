"""
Rueda deportiva para motor TT (Laboratorio III).
Rin de 5 rayos divididos (PLA) + llanta con labrado (TPU). Unidades: mm.
Eje de la rueda = Z. z = 0 es la cara exterior (lado de los rayos); z = ANCHO es la cara hacia el motor.
"""
import math
import cadquery as cq

# ---------------- Medidas generales (iguales a la rueda del diseno) ----------------
DIAM_EXT = 65.0          # diametro exterior con llanta
ANCHO = 26.0             # ancho total

# ---------------- Hueco central del rin: igual al de la rueda anterior del diseno ----------------
HUECO_D = 20.0           # hueco redondo de 20 mm, abierto por la cara exterior
LARGO_EJE = 8.0          # tramo final de la maza (lado del motor) que se cierra con el encaje del eje

# ---------------- Eje del motor TT: 5,2 mm redondo y 3,2 mm entre caras planas ----------------
EJE_D = 5.2
EJE_PLANOS = 3.2
HOLGURA_EJE = 0.0        # sube a 0.1-0.2 si al imprimir el eje entra muy apretado

# ---------------- Rin ----------------
R_ASIENTO = 26.0         # radio donde apoya la llanta (rin de 52 mm)
R_PESTANA = 28.0         # pestanas que sujetan la llanta a los lados
PESTANA_T = 1.5
R_BARRIL_INT = 23.0      # radio interior del barril (pared de 3 mm)
R_MAZA = 13.0            # maza central: anillo de 3 mm de pared alrededor del hueco de 20 mm
MAZA_EXTRA = 2.0         # la maza sobresale hacia el motor para no rozar la caja reductora
RAYOS = 5
DISCO_Z0, DISCO_Z1 = 1.0, 5.0   # los rayos quedan 1 mm hundidos respecto al borde exterior

# ---------------- Llanta ----------------
LLANTA_DI = 51.6         # 0,4 mm menor que el asiento: queda ajustada al estirarla (TPU)
LLANTA_ANCHO = ANCHO - 3.0 - (PESTANA_T + 0.5)   # 21 mm: entre la pestana exterior y el chaflan interior
TACOS = 30               # bloques del labrado
PROF_LABRADO = 1.2


def agujero_eje(largo, z0):
    d = EJE_D + HOLGURA_EJE
    p = EJE_PLANOS + HOLGURA_EJE
    c = cq.Workplane("XY").workplane(offset=z0).circle(d / 2).extrude(largo)
    caja = cq.Workplane("XY").workplane(offset=z0).rect(p, d + 2).extrude(largo)
    return c.intersect(caja)            # circulo recortado por dos planos paralelos (eje "doble D")


def rin():
    # Barril con pestanas (perfil revolucionado). La pestana interior tiene chaflan a 45 grados
    # para que se imprima sin soportes con la cara de los rayos sobre la cama.
    perfil = [(R_BARRIL_INT, 0), (R_PESTANA, 0), (R_PESTANA, PESTANA_T), (R_ASIENTO, PESTANA_T),
              (R_ASIENTO, ANCHO - 3.0), (R_PESTANA, ANCHO - 1.0), (R_PESTANA, ANCHO), (R_BARRIL_INT, ANCHO)]
    barril = cq.Workplane("XZ").polyline(perfil).close().revolve(360, (0, 0, 0), (0, 1, 0))

    # Disco de rayos: 5 ventanas grandes + 5 ranuras finas = 5 rayos en "Y"
    disco = (cq.Workplane("XY").workplane(offset=DISCO_Z0).circle(R_BARRIL_INT + 0.5).circle(R_MAZA - 0.5)
             .extrude(DISCO_Z1 - DISCO_Z0))
    paso = 360.0 / RAYOS

    def pt(r, a):
        return (r * math.cos(math.radians(a)), r * math.sin(math.radians(a)))

    def ventana(a0, a1, r0, r1):
        am = (a0 + a1) / 2
        w = (cq.Workplane("XY").moveTo(*pt(r0, a0)).lineTo(*pt(r1, a0))
             .threePointArc(pt(r1, am), pt(r1, a1)).lineTo(*pt(r0, a1))
             .threePointArc(pt(r0, am), pt(r0, a0)).close().extrude(20).translate((0, 0, -5)))
        return w.edges("|Z").fillet(1.8)

    for k in range(RAYOS):
        a = k * paso
        disco = disco.cut(ventana(a + 9, a + paso - 9, 14.8, 21.3))
        # ranura fina en el centro de cada rayo: lo divide en "Y"
        ranura = (cq.Workplane("XY").center(*pt(18.6, a)).slot2D(5.2, 2.0, angle=a)
                  .extrude(20).translate((0, 0, -5)))
        disco = disco.cut(ranura)

    # Maza: atraviesa todo el ancho y sobresale hacia el motor
    maza = cq.Workplane("XY").workplane(offset=0.5).circle(R_MAZA).extrude(ANCHO - 0.5 + MAZA_EXTRA)
    r = barril.union(disco).union(maza)

    # Detalle deportivo: 5 "tuercas" hexagonales en la cara de la maza, entre los rayos
    rt = (HUECO_D / 2 + R_MAZA) / 2
    for k in range(RAYOS):
        a = math.radians(k * paso + paso / 2)
        r = r.cut(cq.Workplane("XY").center(rt * math.cos(a), rt * math.sin(a)).polygon(6, 1.8)
                  .extrude(1.0).translate((0, 0, 0.5)))

    # Hueco central de 20 mm (como la rueda anterior), abierto por fuera, con chaflan en la boca.
    # No es pasante: llega hasta el tramo final de la maza.
    fondo = ANCHO + MAZA_EXTRA - LARGO_EJE          # z = 20
    r = r.cut(cq.Workplane("XY").workplane(offset=-1).circle(HUECO_D / 2).extrude(fondo + 1))
    r = r.cut(cq.Solid.makeCone(HUECO_D / 2 + 0.8, HUECO_D / 2, 0.8, cq.Vector(0, 0, 0.5)))
    # Tramo final (lado del motor, z 20 a 28): encaje doble D del eje TT, 5,2 x 3,2 mm
    r = r.cut(agujero_eje(LARGO_EJE + 2, fondo - 1))
    return r


def llanta():
    z0 = PESTANA_T + 0.5
    ri, re = LLANTA_DI / 2, DIAM_EXT / 2
    # perfil con hombros redondeados
    t = (cq.Workplane("XY").workplane(offset=z0).circle(re).circle(ri).extrude(LLANTA_ANCHO))
    t = t.faces(">Z").edges("not %LINE").edges(cq.selectors.RadiusNthSelector(1)).fillet(2.0)
    t = t.faces("<Z").edges("not %LINE").edges(cq.selectors.RadiusNthSelector(1)).fillet(2.0)
    # canal central
    canal = (cq.Workplane("XY").workplane(offset=z0 + LLANTA_ANCHO / 2 - 1.0)
             .circle(re + 1).circle(re - PROF_LABRADO).extrude(2.0))
    t = t.cut(canal)
    # tacos: ranuras en diagonal, alternadas a cada lado del canal
    paso = 360.0 / TACOS
    largo = LLANTA_ANCHO / 2 - 1.0
    for k in range(TACOS):
        for lado in (0, 1):
            ang = k * paso + (paso / 2 if lado else 0)
            zc = z0 + (largo / 2 if lado == 0 else LLANTA_ANCHO - largo / 2)
            g = (cq.Workplane("XY").box(PROF_LABRADO * 2, 1.4, largo + 0.5)
                 .rotate((0, 0, 0), (1, 0, 0), 18 if lado == 0 else -18)
                 .translate((re, 0, zc)).rotate((0, 0, 0), (0, 0, 1), ang))
            t = t.cut(g)
    return t


if __name__ == "__main__":
    from cadquery import exporters
    import os
    out = os.path.dirname(os.path.abspath(__file__))
    rn, ll = rin(), llanta()
    for nombre, obj in (("rin", rn), ("llanta", ll)):
        bb = obj.val().BoundingBox()
        print(nombre, round(bb.xlen, 1), round(bb.ylen, 1), round(bb.zlen, 2), "vol", round(obj.val().Volume() / 1000, 2),
              "valido", obj.val().isValid())
    print("interferencia rin-llanta mm3:", round(rn.intersect(ll).val().Volume(), 3) if rn.intersect(ll).vals() else 0)
