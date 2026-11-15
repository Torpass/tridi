"""
Laboratorio III - Robot explorador controlado por gestos
Modelo parametrico (CadQuery). Unidades: mm.
Ejes del robot: X hacia adelante, Y hacia la izquierda, Z hacia arriba.
Origen: borde trasero de la placa, linea central, cara inferior de la placa.
"""
import cadquery as cq
from cadquery import exporters
import os
import sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import rueda as RUEDA

OUT = os.path.dirname(os.path.abspath(__file__))

# ---------------- Parametros de componentes (medidas tipicas) ----------------
RUEDA_D, RUEDA_W = 65.0, 26.0          # rueda amarilla para motor TT
MOTOR_L, MOTOR_H, MOTOR_T = 70.0, 22.5, 18.8   # motor TT (largo, alto, espesor)
EJE_A_EXTREMO = 11.0                    # eje a 11 mm del extremo de la caja reductora
UNO_L, UNO_W = 68.6, 53.3
UNO_HOLES = [(14.0, 2.5), (15.3, 50.7), (66.1, 7.6), (66.1, 35.5)]
L298_S, L298_HOLE_PITCH = 43.0, 37.0
PORTAPILA = (77.0, 41.0, 21.0)          # 2 x 18650
HC_W, HC_H, HC_CAN_D, HC_CAN_SEP = 45.0, 20.0, 16.0, 26.0
PROTO_L, PROTO_W, PROTO_H = 83.0, 55.0, 9.5   # protoboard 400 puntos (largo, ancho, alto)
APDS_L, APDS_W = 20.0, 15.5             # modulo GY-9960 (APDS-9960)

# ---------------- Parametros del chasis ----------------
T = 3.5                  # espesor de la placa
L = 150.0                # largo total
HW_TRAS = 46.0           # semiancho zona trasera (pasos de rueda)
HW_DEL = 54.0            # semiancho zona delantera
X_EJE = 40.0             # posicion del eje de las ruedas
MOTOR_CARA_EXT = 50.0    # cara exterior del motor (y)
PARED_T = 4.0
Z_EJE = -MOTOR_H / 2     # el eje queda a media altura del motor
ALTURA_PLACA = RUEDA_D / 2 - Z_EJE      # altura de la cara inferior al suelo = 43.75
X_UNO = 82.0
X_SENSOR = 144.0         # cara trasera del frente (HC-SR04 apoyado detras)
FRENTE_T = 5.5           # espesor del frente
FRENTE_ALTO = 42.5       # alto del frente = tope de la placa del APDS (su header queda encima)
APDS_Z0 = 22.5           # altura (sobre la placa) donde apoya la placa del APDS
APDS_RANURA = 1.9        # ancho de la ranura para la placa de 1,6 mm
# L298N atornillado sobre la placa (atras), protoboard en una bandeja elevada encima de el
X_L298 = 30.0            # borde trasero de la placa del L298N (lado de bornera de alimentacion y pines)
L298_STANDOFF = 5.0      # alto de las torres del L298N
L298_ALETAS = 6.0        # el disipador sobresale este tanto del borde delantero de la placa
L298_ALTO_DISIP = 25.0   # alto del disipador sobre la placa del modulo
POSTE_H = 30.0           # alto de los postes de la bandeja sobre la placa
BANDEJA_T = 2.5          # espesor de la bandeja
BANDEJA_X1 = 57.5        # borde delantero de la bandeja (detras del disipador)
POSTES_TRAS = [(10.0, 36.0), (10.0, -36.0)]   # postes con pasador (bajo la protoboard)
POSTES_DEL = [(61.0, 36.0), (61.0, -36.0)]    # postes con tornillo (en las orejas de la bandeja)
X_PROTO0 = 1.0           # borde trasero de la protoboard sobre la bandeja (55 en X, 83 en Y)


def contorno():
    pts = [(0, -HW_TRAS), (80, -HW_TRAS), (88, -HW_DEL), (L, -HW_DEL),
           (L, HW_DEL), (88, HW_DEL), (80, HW_TRAS), (0, HW_TRAS)]
    return pts


def placa_base(h):
    s = cq.Workplane("XY").polyline(contorno()).close().extrude(h)
    s = s.edges("|Z").edges(cq.selectors.BoxSelector((L - 1, -60, -1), (L + 1, 60, 20))).fillet(30)
    s = s.edges("|Z").edges(cq.selectors.BoxSelector((-1, -60, -1), (1, 60, 20))).fillet(10)
    s = s.edges("|Z").edges(cq.selectors.BoxSelector((79, -60, -1), (89, 60, 20))).fillet(4)
    return s


def chasis():
    placa = placa_base(T)
    # Reborde perimetral (rigidez + estetica)
    exterior = placa_base(T + 3.0)
    interior = placa_base(T + 3.0).faces(">Z").wires().toPending().offset2D(-2.2).extrude(-(T + 3.0), combine=False)
    reborde = exterior.cut(interior).cut(cq.Workplane("XY").box(400, 400, T, centered=(True, True, False)))
    s = placa.union(reborde)

    # ---- Standoffs Arduino UNO (conectores USB hacia el lado izquierdo, +Y)
    for bx, by in UNO_HOLES:
        x, y = X_UNO + by, UNO_L / 2 - bx
        s = s.union(cq.Workplane("XY").workplane(offset=T).center(x, y).circle(3.25).extrude(6))
        s = s.cut(cq.Workplane("XY").center(x, y).circle(1.35).extrude(30))

    # ---- Torres del L298N (agujeros del modulo: cuadrado de 37 mm), tornillo M3 autorroscante
    xlc = X_L298 + L298_S / 2
    for dx in (-1, 1):
        for dy in (-1, 1):
            x, y = xlc + dx * L298_HOLE_PITCH / 2, dy * L298_HOLE_PITCH / 2
            s = s.union(cq.Workplane("XY").workplane(offset=T).center(x, y).circle(3.5).extrude(L298_STANDOFF))
            s = s.cut(cq.Workplane("XY").center(x, y).circle(1.35).extrude(30))
    # ---- Postes de la bandeja de la protoboard
    for x, y in POSTES_TRAS + POSTES_DEL:
        poste = cq.Workplane("XY").workplane(offset=T).center(x, y).circle(4.0).extrude(POSTE_H)
        s = s.union(poste)
    for x, y in POSTES_TRAS:   # pasador de 2,8 mm que entra en la bandeja
        s = s.union(cq.Workplane("XY").workplane(offset=T + POSTE_H).center(x, y).circle(1.4).extrude(BANDEJA_T - 0.3))
    for x, y in POSTES_DEL:    # agujero para tornillo M3 autorroscante
        s = s.cut(cq.Workplane("XY").workplane(offset=T + POSTE_H - 12).center(x, y).circle(1.35).extrude(13))

    # ---- Frente ("cara" del robot): HC-SR04 abajo, APDS-9960 arriba, ambos mirando hacia adelante
    alto = FRENTE_ALTO
    frente = (cq.Workplane("YZ").workplane(offset=X_SENSOR)
              .center(0, T + alto / 2).rect(54, alto).extrude(FRENTE_T))
    frente = frente.edges("|X").edges(">Z").fillet(7)
    zc = T + 1.5 + HC_H / 2
    for sy in (-1, 1):
        ojo = (cq.Workplane("YZ").workplane(offset=X_SENSOR - 1)
               .center(sy * HC_CAN_SEP / 2, zc).slot2D(HC_CAN_D + 0.8 + 2.0, HC_CAN_D + 0.8).extrude(FRENTE_T + 2))
        frente = frente.cut(ojo)
    # Ranura vertical para el APDS-9960: la placa entra desde arriba con el header hacia arriba.
    # Labios traseros de 1 mm la retienen; ventana al frente para el sensor.
    x_lab, x_ran = X_SENSOR + 1.0, X_SENSOR + 1.0 + APDS_RANURA
    z_apo = T + APDS_Z0                              # apoyo inferior de la placa del APDS
    frente = frente.cut(cq.Workplane("XY").box(x_ran - x_lab, APDS_W + 0.7, 60, centered=(False, True, False))
                        .translate((x_lab, 0, z_apo)))
    frente = frente.cut(cq.Workplane("XY").box(1.2, APDS_W - 2.8, 60, centered=(False, True, False))
                        .translate((X_SENSOR - 0.1, 0, z_apo + 1.0)))
    frente = frente.cut(cq.Workplane("YZ").workplane(offset=x_ran - 0.5)
                        .center(0, z_apo + APDS_L / 2).rect(12.0, 11.0).extrude(FRENTE_T))
    s = s.union(frente)
    # Nervios de refuerzo del frente
    for sy in (-1, 1):
        nervio = (cq.Workplane("XZ").workplane(offset=-(sy * 25.5) - 1.25)
                  .polyline([(X_SENSOR - 10, T), (X_SENSOR, T), (X_SENSOR, T + 30)]).close().extrude(2.5))
        s = s.union(nervio)

    # ---- Paredes de sujecion de motores (bajo la placa)
    # ---- Agujeros pasantes M3 para fijar soportes de motor y patin desde arriba
    for x, y in [(x, sy * (BOSS_Y - 1.0)) for x in BOSS_X for sy in (-1, 1)] + [(X_PATIN, 0)]:
        s = s.cut(cq.Workplane("XY").center(x, y).circle(1.7).extrude(30).translate((0, 0, -10)))
        # avellanado para tornillo M3 cabeza plana: queda al ras (la protoboard se apoya encima)
        s = s.cut(cq.Solid.makeCone(1.7, 3.4, 1.7, cq.Vector(x, y, T - 1.7)))

    # ---- Ranuras para bridas (portapilas bajo la placa)
    for x in (62, 100):
        for sy in (-1, 1):
            s = s.cut(cq.Workplane("XY").center(x, sy * 23.8).rect(6, 3.2).extrude(30).translate((0, 0, -10)))

    # ---- Pasacables
    s = s.cut(cq.Workplane("XY").center(20, 0).slot2D(14, 8).extrude(30).translate((0, 0, -10)))   # cables de bateria
    for sy in (-1, 1):
        s = s.cut(cq.Workplane("XY").center(100, sy * 42).slot2D(11, 7).extrude(30).translate((0, 0, -10)))
    # ---- Nombres de los autores en relieve (franja libre delantera derecha, -Y; se leen desde ese lado)
    if CON_NOMBRES:
        s = s.union(nombres())
    return s


CON_NOMBRES = False      # False = version sin los nombres de los autores
NOMBRES = ("Luigi D'Aquaro", "Jorge Younes")
TXT_ALTO, TXT_RELIEVE = 4.2, 0.6
TXT_CX, TXT_Y1, TXT_Y2 = 121.0, -38.2, -43.6   # centro x y centro de cada linea (mm)


def nombres():
    out = None
    for texto, yc in zip(NOMBRES, (TXT_Y1, TXT_Y2)):
        t = cq.Workplane("XY").text(texto, TXT_ALTO, TXT_RELIEVE, kind="bold", halign="left", valign="baseline")
        bb = t.val().BoundingBox()
        t = t.translate((TXT_CX - (bb.xmin + bb.xmax) / 2, yc - (bb.ymin + bb.ymax) / 2, T - bb.zmin))
        out = t if out is None else out.union(t)
    return out


BOSS_X = (30.0, 78.0)
BOSS_Y = MOTOR_CARA_EXT - MOTOR_T - PARED_T - 1.5 + 1.5   # = cara interior de la pared (27.2)
X_PATIN = 138.0


def soporte_motor():
    """Soporte del motor IZQUIERDO en coordenadas del robot (z=0 = cara inferior de la placa).
    El derecho es la misma pieza girada 180 grados (es simetrica)."""
    y_ext = MOTOR_CARA_EXT - MOTOR_T          # 31.2: aqui apoya el motor
    pared = (cq.Workplane("XY").box(60, PARED_T, MOTOR_H, centered=(False, False, False))
             .translate((26, y_ext - PARED_T, -MOTOR_H)))
    for x in BOSS_X:
        pared = pared.union(cq.Workplane("XY").center(x, BOSS_Y - 1.0).circle(3.6).extrude(MOTOR_H)
                            .translate((0, 0, -MOTOR_H)))
    pared = pared.clean()
    # eje doble del motor
    pared = pared.cut(cq.Workplane("XZ").workplane(offset=-y_ext - 5).center(X_EJE, Z_EJE).circle(5.5).extrude(20))
    # 2 ranuras para los tornillos M3x30 que atraviesan el motor
    for dz in (-8.75, 8.75):
        pared = pared.cut(cq.Workplane("XZ").workplane(offset=-y_ext - 5)
                          .center(59, Z_EJE + dz).slot2D(13, 4.0).extrude(20))
    # agujeros para tornillo autorroscante M3 (desde arriba de la placa)
    for x in BOSS_X:
        pared = pared.cut(cq.Workplane("XY").center(x, BOSS_Y - 1.0).circle(1.35).extrude(40).translate((0, 0, -30)))
    return pared


def patin():
    """Patin delantero (tercer apoyo). Altura = 43,75 mm, igual que la placa al suelo."""
    h = ALTURA_PLACA - 8.0
    perfil = (cq.Workplane("XZ").moveTo(0, 0).lineTo(11, 0).lineTo(8, -h)
              .threePointArc((5.657, -h - 5.657), (2.0, -h - 7.746)).lineTo(0, -h - 7.746).close())
    p = perfil.revolve(360, (0, 0, 0), (0, 1, 0))
    p = p.cut(cq.Workplane("XY").circle(1.35).extrude(-16))
    return p.translate((X_PATIN, 0, 0))


def bandeja():
    """Bandeja de la protoboard (pieza aparte). z=0 = cara inferior; se imprime acostada."""
    b = cq.Workplane("XY").box(BANDEJA_X1, 88.0, BANDEJA_T, centered=(False, True, False))
    b = b.edges("|Z").edges("<X").fillet(8).edges("|Z").edges(">X").fillet(2)
    for sy in (-1, 1):   # orejas para los tornillos delanteros
        oreja = (cq.Workplane("XY").box(10.0, 12.0, BANDEJA_T, centered=(False, True, False))
                 .translate((BANDEJA_X1 - 2, sy * 36.0, 0)).edges("|Z").edges(">X").fillet(4))
        b = b.union(oreja)
    for x, y in POSTES_TRAS:
        b = b.cut(cq.Workplane("XY").center(x, y).circle(1.65).extrude(10).translate((0, 0, -1)))
    for x, y in POSTES_DEL:
        b = b.cut(cq.Workplane("XY").center(x, y).circle(1.7).extrude(10).translate((0, 0, -1)))
    # bordes que ubican la protoboard (atras y a los lados); adelante queda libre para los cables
    b = b.union(cq.Workplane("XY").box(1.0, 50.0, 2.0, centered=(False, True, False)).translate((0, 0, BANDEJA_T)))
    for sy in (-1, 1):
        b = b.union(cq.Workplane("XY").box(36.0, 1.2, 2.0, centered=(False, True, False))
                    .translate((14.0, sy * (PROTO_L / 2 + 0.4 + 0.6), BANDEJA_T)))
    # ventana para ahorrar material y ver el L298N
    b = b.cut(cq.Workplane("XY").center(30, 0).rect(30, 40).extrude(10).translate((0, 0, -1)).edges("|Z").fillet(5))
    return b


# ---------------- Componentes de referencia (solo para ver el ensamble) ----------------
def componentes():
    comps = {}
    z0 = ALTURA_PLACA
    ruedas, motores = [], []
    for sy in (-1, 1):
        yc = sy * (MOTOR_CARA_EXT + 3 + RUEDA_W / 2)
        m = (cq.Workplane("XY").box(MOTOR_L, MOTOR_T, MOTOR_H, centered=False)
             .translate((X_EJE - EJE_A_EXTREMO, 0, z0 - MOTOR_H)))
        motores.append(m.translate((0, (MOTOR_CARA_EXT - MOTOR_T) if sy > 0 else -MOTOR_CARA_EXT, 0)))
    rn, ll = RUEDA.rin(), RUEDA.llanta()
    y_ext = MOTOR_CARA_EXT + 3 + RUEDA_W          # cara exterior de la rueda (79 mm)

    def colocar(obj, sy):
        o = obj.rotate((0, 0, 0), (1, 0, 0), 90 if sy > 0 else -90)
        return o.translate((X_EJE, sy * y_ext, z0 + Z_EJE))
    comps["rines"] = colocar(rn, 1).union(colocar(rn, -1))
    comps["llantas"] = colocar(ll, 1).union(colocar(ll, -1))
    comps["motores"] = motores[0].union(motores[1])
    comps["portapilas"] = (cq.Workplane("XY").box(*PORTAPILA, centered=(False, True, False))
                           .translate((35, 0, z0 - PORTAPILA[2])))
    comps["arduino"] = (cq.Workplane("XY").box(UNO_W, UNO_L, 1.6, centered=False)
                        .translate((X_UNO, -UNO_L / 2, z0 + T + 6))
                        .union(cq.Workplane("XY").box(12, 16, 11, centered=False)
                               .translate((X_UNO + 32.2, UNO_L / 2 - 10, z0 + T + 7.6))))
    # L298N sobre sus torres; disipador hacia adelante con las aletas sobresaliendo
    zl = z0 + T + L298_STANDOFF
    xlc = X_L298 + L298_S / 2
    comps["l298n"] = (cq.Workplane("XY").box(L298_S, L298_S, 1.6, centered=(True, True, False)).translate((xlc, 0, zl))
                      .union(cq.Workplane("XY").box(X_L298 + L298_S + L298_ALETAS - 58.5, 29, L298_ALTO_DISIP,
                                                    centered=(False, True, False)).translate((58.5, 0, zl + 1.6)))
                      .union(cq.Workplane("XY").box(8, 43, 10, centered=(False, True, False)).translate((X_L298, 0, zl + 1.6))))
    # Bandeja con la protoboard 400 puntos encima del L298N
    zb = z0 + T + POSTE_H
    comps["bandeja"] = bandeja().translate((0, 0, zb))
    comps["protoboard"] = (cq.Workplane("XY").box(PROTO_W, PROTO_L, PROTO_H, centered=(False, True, False))
                           .translate((X_PROTO0, 0, zb + BANDEJA_T)))
    # APDS-9960 vertical en la ranura del frente, mirando hacia adelante, header hacia arriba
    xa = X_SENSOR + 1.0 + 0.15
    comps["apds9960"] = (cq.Workplane("XY").box(1.6, APDS_W, APDS_L, centered=(False, True, False))
                         .translate((xa, 0, z0 + T + APDS_Z0))
                         .union(cq.Workplane("XY").box(2.5, 15.2, 8.5, centered=(False, True, False))
                                .translate((xa - 0.45, 0, z0 + T + APDS_Z0 + APDS_L))))
    # Conectores dupont del HC-SR04 (pines hacia arriba, detras de la placa del sensor)
    comps["hc_conector"] = (cq.Workplane("XY").box(2.5, 10.2, 14, centered=(False, True, False))
                            .translate((X_SENSOR - 2.3 - 1.3 - 1.25, 0, z0 + T + 1.5 + HC_H)))
    hc = cq.Workplane("XY").box(1.6, HC_W, HC_H).translate((X_SENSOR - 1.5, 0, z0 + T + 1.5 + HC_H / 2))
    for sy in (-1, 1):
        hc = hc.union(cq.Workplane("YZ").workplane(offset=X_SENSOR - 0.7)
                      .center(sy * HC_CAN_SEP / 2, z0 + T + 1.5 + HC_H / 2).circle(HC_CAN_D / 2).extrude(12))
    comps["hcsr04"] = hc
    return comps


def exportar(obj, nombre, rot=None):
    exporters.export(obj, f"{OUT}/{nombre}.step")
    o = obj
    if rot:
        o = obj.rotate((0, 0, 0), (1, 0, 0), rot)
    exporters.export(o, f"{OUT}/{nombre}.stl", tolerance=0.05, angularTolerance=0.15)


def soporte_derecho():
    return soporte_motor().rotate((0, 0, Z_EJE), (1, 0, Z_EJE), 180)


if __name__ == "__main__":
    ch = chasis(); sop = soporte_motor(); pat = patin()
    exportar(ch, "1_chasis_robot")
    exportar(sop, "2_soporte_motor_x2", rot=-90)
    exportar(pat, "3_patin_delantero", rot=180)
    exportar(bandeja(), "4_bandeja_protoboard")
    exportar(RUEDA.rin(), "5_rin_x2")
    exportar(RUEDA.llanta(), "6_llanta_x2_TPU")

    comps = componentes()
    z0 = ALTURA_PLACA
    asm = cq.Assembly(name="Robot_Explorador_LabIII")
    asm.add(ch.translate((0, 0, z0)), name="Chasis", color=cq.Color(0.95, 0.45, 0.10))
    asm.add(sop.translate((0, 0, z0)), name="Soporte_izq", color=cq.Color(0.95, 0.45, 0.10))
    asm.add(soporte_derecho().translate((0, 0, z0)), name="Soporte_der", color=cq.Color(0.95, 0.45, 0.10))
    asm.add(pat.translate((0, 0, z0)), name="Patin", color=cq.Color(0.95, 0.45, 0.10))
    colores = {"rines": (0.98, 0.85, 0.05), "llantas": (0.12, 0.12, 0.12), "motores": (0.95, 0.85, 0.2), "portapilas": (0.15, 0.15, 0.15),
               "arduino": (0.0, 0.45, 0.65), "l298n": (0.8, 0.1, 0.1), "hcsr04": (0.1, 0.3, 0.8),
               "protoboard": (0.93, 0.93, 0.9), "apds9960": (0.45, 0.1, 0.55),
               "hc_conector": (0.1, 0.1, 0.1), "bandeja": (0.95, 0.45, 0.10)}
    for k, v in comps.items():
        asm.add(v, name=k, color=cq.Color(*colores[k]))
    asm.export(f"{OUT}/ensamble_robot.step")

    for nombre, obj in (("chasis", ch), ("soporte", sop), ("patin", pat)):
        bb = obj.val().BoundingBox()
        print(nombre, "bbox mm:", round(bb.xlen, 1), round(bb.ylen, 1), round(bb.zlen, 1),
              "vol cm3:", round(obj.val().Volume() / 1000, 1), "valido:", obj.val().isValid(),
              "zmin:", round(bb.zmin, 2))
    # verificacion de interferencias en el ensamble
    piezas = {"chasis": ch, "sop_izq": sop, "sop_der": soporte_derecho(), "patin": pat}
    piezas.update({k: v.translate((0, 0, -z0)) for k, v in comps.items()})
    lista = list(piezas)
    for i in range(len(lista)):
        for j in range(i + 1, len(lista)):
            a, b = piezas[lista[i]], piezas[lista[j]]
            try:
                v = a.intersect(b).val().Volume()
            except Exception:
                v = 0
            if v > 1 and {lista[i], lista[j]} != {"rines", "llantas"}:   # rin-llanta: ajuste a presion intencional
                print("INTERFERENCIA", lista[i], lista[j], round(v, 1), "mm3")
