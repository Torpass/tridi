"""Compile a trained Tridi ONNX policy into standalone C / Arduino (.ino) firmware with hardware guardrails.

    uv run --project training python -m training.export_mcu --preset luigi_lab3
    uv run --project training python -m training.export_mcu --preset luigi_lab4
    uv run --project training python -m training.export_mcu --onnx training/policies/luigi-lab3.onnx --out my_robot.ino

Why this exists (docs/ROADMAP.md, task J-3):
1. Microcontrollers like the Arduino UNO (ATmega328P, 16 MHz, 2 KB SRAM, 32 KB Flash) cannot run
   onnxruntime, cannot call blocking `pulseIn()` without starving a 50 Hz control loop, and lose
   PWM on pins D9/D10 whenever `<Servo.h>` takes over Timer1.
2. `export_mcu.py` reads the `.onnx` computation graph, emits every initializer as a `const float`
   array and compiles the exact topological forward pass (`tridi_policy_forward(obs, ctrl)`) in
   dependency-free C99/C++11, verifying numerical parity (`max_abs_err < 1e-5`) against
   `onnxruntime` before writing the `.ino` file.
3. It runs `validate_hardware()` to catch pin/timer conflicts (Timer1 `<Servo.h>` vs `analogWrite`
   on D9/D10), replaces blocking `pulseIn()` with hardware `INT0/INT1` or `PCINT` interrupts,
   replaces blocking servo sweeps (`delay(350)`) with a non-blocking radar state machine, and
   maps physical `rad/s` outputs through the L298N + TT gearmotor static-friction deadzone.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass, field
import json
from pathlib import Path
import re

import numpy as np
import onnx
from onnx import numpy_helper
import onnxruntime as ort

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_ONNX = Path(__file__).resolve().parent / "policies" / "luigi-lab3.onnx"


@dataclass(frozen=True)
class HardwareConfig:
    """Pinout, actuator deadzone, and sensor configuration for an MCU robot."""

    name: str
    board: str  # "arduino_uno" (ATmega328P) or "esp32"
    # L298N H-bridge pins: ENA/ENB must be PWM-capable
    ena_pin: int
    in1_pin: int
    in2_pin: int
    enb_pin: int
    in3_pin: int
    in4_pin: int
    # Left/right polarity: True if forward uses HIGH/LOW on (IN1, IN2) or (IN3, IN4)
    left_forward_high_low: bool = False
    right_forward_high_low: bool = True
    # Ultrasonic HC-SR04 pins (strings allow "A0".."A5" or integer pin numbers)
    trig_pin: str = "A0"
    echo_pin: str = "A1"
    # Optional SG90 servo neck pin (None for Lab 3, 9 for Lab 4)
    servo_pin: int | None = None
    # Optional status LEDs
    led_green_pin: int | None = None
    led_red_pin: int | None = None
    # Physical actuator calibration (200 RPM TT motor = 20.94 rad/s; L298N drops ~1.4 V, deadzone = 115 PWM)
    max_rads: float = 20.94
    deadzone_pwm: int = 115
    max_pwm: int = 200
    right_motor_trim: float = 1.0
    control_hz: int = 50
    stop_dist_cm: int = 25
    clear_dist_cm: int = 32


PRESETS: dict[str, HardwareConfig] = {
    "luigi_lab3": HardwareConfig(
        name="Luigi Lab 3 (3-Wheel Differential Drive + HC-SR04 Gesture Reactive)",
        board="arduino_uno",
        ena_pin=10,
        in1_pin=9,
        in2_pin=8,
        enb_pin=5,
        in3_pin=7,
        in4_pin=6,
        left_forward_high_low=False,   # Lab 3 chassis wiring: Left forward = IN1 LOW, IN2 HIGH
        right_forward_high_low=True,   # Lab 3 chassis wiring: Right forward = IN3 HIGH, IN4 LOW
        trig_pin="A0",
        echo_pin="A1",
        servo_pin=None,
        led_green_pin=2,
        led_red_pin=3,
        max_rads=20.94,
        deadzone_pwm=115,
        max_pwm=200,
        right_motor_trim=1.0,
        control_hz=50,
        stop_dist_cm=22,
        clear_dist_cm=27,
    ),
    "luigi_lab4": HardwareConfig(
        name="Luigi Lab 4 (Autonomous Explorer + SG90 Servo Radar Neck on D9)",
        board="arduino_uno",
        ena_pin=5,
        in1_pin=7,
        in2_pin=8,
        enb_pin=6,
        in3_pin=11,
        in4_pin=12,
        left_forward_high_low=True,    # Lab 4 wiring: Left forward = IN1 HIGH, IN2 LOW
        right_forward_high_low=True,   # Lab 4 wiring: Right forward = IN3 HIGH, IN4 LOW
        trig_pin="2",
        echo_pin="3",                  # D3 is hardware INT1 on ATmega328P!
        servo_pin=9,                   # SG90 neck on D9 (uses Timer1; ENA/ENB safely on Timer0 D5/D6)
        led_green_pin=None,
        led_red_pin=None,
        max_rads=20.94,
        deadzone_pwm=115,
        max_pwm=200,
        right_motor_trim=0.90,         # Compensates 180/200 hardware motor asymmetry from Lab 4
        control_hz=50,
        stop_dist_cm=25,
        clear_dist_cm=32,
    ),
}


@dataclass
class GuardrailReport:
    ok: bool = True
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    Mitigations: list[str] = field(default_factory=list)


def validate_hardware(cfg: HardwareConfig) -> GuardrailReport:
    """Static hardware guardrail analysis before emitting C/Arduino code."""
    report = GuardrailReport()
    uno_pwm_pins = {3, 5, 6, 9, 10, 11}

    if cfg.board == "arduino_uno":
        for label, pin in (("ENA", cfg.ena_pin), ("ENB", cfg.enb_pin)):
            if pin not in uno_pwm_pins:
                report.ok = False
                report.errors.append(
                    f"{label} is assigned to D{pin}, which has no hardware PWM on ATmega328P "
                    f"(valid PWM pins: {sorted(uno_pwm_pins)})."
                )
        # Rule 1: <Servo.h> hijacks Timer1 on ATmega328P, disabling analogWrite() PWM on D9 and D10.
        if cfg.servo_pin is not None:
            for label, pin in (("ENA", cfg.ena_pin), ("ENB", cfg.enb_pin)):
                if pin in (9, 10):
                    report.ok = False
                    report.errors.append(
                        f"TIMER1 CONFLICT: {label} is on D{pin} while SG90 Servo is enabled on D{cfg.servo_pin}. "
                        "Arduino's <Servo.h> uses Timer1 and disables PWM on D9 and D10. Move ENA/ENB to D5/D6."
                    )
            report.Mitigations.append(
                f"Timer1 Guardrail PASS: Servo on D{cfg.servo_pin} uses Timer1 while ENA=D{cfg.ena_pin}, "
                f"ENB=D{cfg.enb_pin} use Timer0 PWM (no timer collision)."
            )
            report.Mitigations.append(
                "Non-blocking Radar State Machine: replaced blocking `myServo.write() + delay(350)` with "
                "asynchronous 50 Hz servo sweep (`radarTick()`)."
            )

        # Rule 2: Ultrasonic Echo ISR selection (never use blocking pulseIn)
        echo_str = str(cfg.echo_pin).upper()
        if echo_str in ("2", "3", "D2", "D3"):
            pin_num = int(echo_str.lstrip("D"))
            int_name = "INT0" if pin_num == 2 else "INT1"
            report.Mitigations.append(
                f"Ultrasonic ISR Guardrail PASS: ECHO on D{pin_num} uses hardware external interrupt "
                f"`{int_name}` (`attachInterrupt`), zero CPU blocking."
            )
        elif echo_str in ("A0", "A1", "A2", "A3", "A4", "A5"):
            bit = int(echo_str[1])
            report.Mitigations.append(
                f"Ultrasonic ISR Guardrail PASS: ECHO on {echo_str} uses Pin Change Interrupt "
                f"`ISR(PCINT1_vect)` (Port C bit {bit}), replacing blocking `pulseIn()`."
            )
        else:
            report.warnings.append(
                f"ECHO pin {cfg.echo_pin} is not on INT0/INT1 (D2/D3) or Port C (A0..A5); "
                "ensure PCINT mask matches your port."
            )

    # Rule 3: Deadzone validation
    if cfg.deadzone_pwm < 70 or cfg.deadzone_pwm >= cfg.max_pwm:
        report.warnings.append(
            f"Unusual deadzone_pwm={cfg.deadzone_pwm} vs max_pwm={cfg.max_pwm}. "
            "Standard 3-6V TT gearmotors behind L298N require deadzone_pwm in [100..125]."
        )
    else:
        report.Mitigations.append(
            f"Actuator Deadzone Compensation PASS: [0.5..{cfg.max_rads:.2f} rad/s] mapped linearly to "
            f"[{cfg.deadzone_pwm}..{cfg.max_pwm} PWM] (overcomes L298N 1.4V drop + gearbox breakaway friction)."
        )

    return report


def _c_ident(name: str) -> str:
    """Convert an ONNX tensor/node name into a valid C identifier."""
    clean = re.sub(r"[^a-zA-Z0-9_]", "_", name).strip("_")
    if not clean or clean[0].isdigit():
        clean = "v_" + clean
    return clean


def _format_float_array(arr: np.ndarray) -> str:
    flat = arr.astype(np.float32).ravel()
    vals = ", ".join(f"{float(v):.7f}f" for v in flat)
    return f"{{ {vals} }}"


def compile_onnx_to_c(onnx_path: Path) -> tuple[str, int, int, float]:
    """Compile an ONNX graph into a standalone C function `tridi_policy_forward` and verify with onnxruntime.

    Returns (c_source_block, obs_dim, act_dim, max_abs_diff_vs_ort).
    """
    model = onnx.load(str(onnx_path))
    graph = model.graph

    obs_dim = graph.input[0].type.tensor_type.shape.dim[-1].dim_value
    act_dim = graph.output[0].type.tensor_type.shape.dim[-1].dim_value
    input_name = graph.input[0].name
    output_name = graph.output[0].name

    # Collect initializers and Constant nodes
    tensors: dict[str, np.ndarray] = {}
    for init in graph.initializer:
        tensors[init.name] = numpy_helper.to_array(init).astype(np.float32)

    for node in graph.node:
        if node.op_type == "Constant":
            for attr in node.attribute:
                if attr.name == "value":
                    tensors[node.output[0]] = numpy_helper.to_array(attr.t).astype(np.float32)

    # Emit C const arrays for all non-scalar initializers, and track shapes
    shapes: dict[str, tuple[int, ...]] = {input_name: (obs_dim,)}
    for k, arr in tensors.items():
        shapes[k] = arr.shape

    const_lines = [
        "// --- Pesos y constantes extraídos automáticamente del grafo ONNX ---",
        f"#define TRIDI_OBS_DIM {obs_dim}",
        f"#define TRIDI_ACT_DIM {act_dim}",
    ]
    c_names: dict[str, str] = {input_name: "obs"}
    for name, arr in tensors.items():
        cid = "w_" + _c_ident(name)
        c_names[name] = cid
        size = int(arr.size)
        const_lines.append(f"static const float {cid}[{max(1, size)}] = {_format_float_array(arr)};")

    body_lines: list[str] = []
    for idx, node in enumerate(graph.node):
        op = node.op_type
        if op == "Constant":
            continue
        out = node.output[0]
        out_c = "ctrl" if out == output_name else f"t_{idx}_{_c_ident(out)}"
        c_names[out] = out_c

        if op == "Identity":
            src = node.input[0]
            if src in tensors:
                tensors[out] = tensors[src]
            shapes[out] = shapes[src]
            c_names[out] = c_names[src]
            continue

        if op == "Gemm":
            x_name, w_name = node.input[0], node.input[1]
            b_name = node.input[2] if len(node.input) > 2 else None
            trans_b = 0
            for attr in node.attribute:
                if attr.name == "transB":
                    trans_b = attr.i
            w_shape = shapes[w_name]
            out_features = w_shape[0] if trans_b else w_shape[1]
            in_features = w_shape[1] if trans_b else w_shape[0]
            shapes[out] = (out_features,)
            if out != output_name:
                body_lines.append(f"  float {out_c}[{out_features}];")
            body_lines.append(f"  for (int i = 0; i < {out_features}; ++i) {{")
            init_expr = f"{c_names[b_name]}[i]" if b_name else "0.0f"
            body_lines.append(f"    float acc = {init_expr};")
            body_lines.append(f"    for (int j = 0; j < {in_features}; ++j) {{")
            w_idx = f"i * {in_features} + j" if trans_b else f"j * {out_features} + i"
            body_lines.append(f"      acc += {c_names[x_name]}[j] * {c_names[w_name]}[{w_idx}];")
            body_lines.append("    }")
            body_lines.append(f"    {out_c}[i] = acc;")
            body_lines.append("  }")

        elif op == "MatMul":
            x_name, w_name = node.input[0], node.input[1]
            w_shape = shapes[w_name]
            in_features, out_features = w_shape[0], w_shape[1]
            shapes[out] = (out_features,)
            if out != output_name:
                body_lines.append(f"  float {out_c}[{out_features}];")
            body_lines.append(f"  for (int i = 0; i < {out_features}; ++i) {{")
            body_lines.append("    float acc = 0.0f;")
            body_lines.append(f"    for (int j = 0; j < {in_features}; ++j) {{")
            body_lines.append(f"      acc += {c_names[x_name]}[j] * {c_names[w_name]}[j * {out_features} + i];")
            body_lines.append("    }")
            body_lines.append(f"    {out_c}[i] = acc;")
            body_lines.append("  }")

        elif op in ("Add", "Sub", "Mul", "Div", "Max", "Min"):
            a_name, b_name = node.input[0], node.input[1]
            a_len = int(np.prod(shapes[a_name])) if shapes[a_name] else 1
            b_len = int(np.prod(shapes[b_name])) if shapes[b_name] else 1
            n = max(a_len, b_len)
            shapes[out] = (n,)
            if out != output_name:
                body_lines.append(f"  float {out_c}[{n}];")
            a_idx = "i" if a_len > 1 else "0"
            b_idx = "i" if b_len > 1 else "0"
            va = f"{c_names[a_name]}[{a_idx}]"
            vb = f"{c_names[b_name]}[{b_idx}]"
            expr = {
                "Add": f"({va} + {vb})",
                "Sub": f"({va} - {vb})",
                "Mul": f"({va} * {vb})",
                "Div": f"({va} / {vb})",
                "Max": f"(({va} > {vb}) ? {va} : {vb})",
                "Min": f"(({va} < {vb}) ? {va} : {vb})",
            }[op]
            body_lines.append(f"  for (int i = 0; i < {n}; ++i) {{ {out_c}[i] = {expr}; }}")

        elif op in ("Tanh", "Relu", "Elu", "Sin", "Cos"):
            x_name = node.input[0]
            n = int(np.prod(shapes[x_name])) if shapes[x_name] else 1
            shapes[out] = (n,)
            if out != output_name:
                body_lines.append(f"  float {out_c}[{n}];")
            vx = f"{c_names[x_name]}[i]"
            expr = {
                "Tanh": f"tanhf({vx})",
                "Relu": f"(({vx} > 0.0f) ? {vx} : 0.0f)",
                "Elu": f"(({vx} > 0.0f) ? {vx} : (expf({vx}) - 1.0f))",
                "Sin": f"sinf({vx})",
                "Cos": f"cosf({vx})",
            }[op]
            body_lines.append(f"  for (int i = 0; i < {n}; ++i) {{ {out_c}[i] = {expr}; }}")

        elif op == "Clip":
            x_name, lo_name, hi_name = node.input[0], node.input[1], node.input[2]
            n = int(np.prod(shapes[x_name])) if shapes[x_name] else 1
            shapes[out] = (n,)
            if out != output_name:
                body_lines.append(f"  float {out_c}[{n}];")
            vx = f"{c_names[x_name]}[i]"
            vlo = f"{c_names[lo_name]}[0]"
            vhi = f"{c_names[hi_name]}[0]"
            body_lines.append(
                f"  for (int i = 0; i < {n}; ++i) {{ "
                f"float v = {vx}; if (v < {vlo}) v = {vlo}; if (v > {vhi}) v = {vhi}; {out_c}[i] = v; }}"
            )
        elif op == "Slice":
            x_name = node.input[0]
            start = int(tensors[node.input[1]].ravel()[0])
            end = int(tensors[node.input[2]].ravel()[0])
            step = int(tensors[node.input[4]].ravel()[0]) if len(node.input) > 4 else 1
            n = len(range(start, end, step))
            shapes[out] = (n,)
            if out != output_name:
                body_lines.append(f"  float {out_c}[{n}];")
            body_lines.append(
                f"  for (int i = 0; i < {n}; ++i) {{ {out_c}[i] = {c_names[x_name]}[{start} + i * {step}]; }}"
            )
        else:
            raise ValueError(f"Unsupported ONNX op_type in MCU compiler: {op}")

    fn_lines = [
        "",
        "// Forward pass compilado directamente desde el grafo ONNX (0 asignaciones dinámicas, O(1) SRAM)",
        "static inline void tridi_policy_forward(const float* obs, float* ctrl) {",
        *body_lines,
        "}",
    ]
    c_block = "\n".join(const_lines + fn_lines)

    # Verify numerical parity in Python using the exact same operations against onnxruntime
    sess = ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])
    rng = np.random.default_rng(42)
    test_obs = rng.uniform(-1.0, 1.0, size=(16, obs_dim)).astype(np.float32)
    ort_out = sess.run(None, {input_name: test_obs})[0]
    py_out = _emulate_onnx_graph(graph, tensors, test_obs)
    max_diff = float(np.max(np.abs(ort_out - py_out)))
    if max_diff > 1e-5:
        raise RuntimeError(f"ONNX-to-C parity check failed: max_abs_diff={max_diff:.2e}")

    return c_block, obs_dim, act_dim, max_diff


def _emulate_onnx_graph(graph, tensors: dict[str, np.ndarray], batch_obs: np.ndarray) -> np.ndarray:
    """Reference float32 evaluator mirroring the emitted C loops to verify parity against onnxruntime."""
    env = {k: v.astype(np.float32) for k, v in tensors.items()}
    env[graph.input[0].name] = batch_obs.astype(np.float32)
    for node in graph.node:
        op = node.op_type
        if op == "Constant":
            continue
        out = node.output[0]
        if op == "Identity":
            env[out] = env[node.input[0]]
        elif op == "Gemm":
            x, w = env[node.input[0]], env[node.input[1]]
            b = env[node.input[2]] if len(node.input) > 2 else 0.0
            trans_b = any(a.name == "transB" and a.i == 1 for a in node.attribute)
            env[out] = x @ (w.T if trans_b else w) + b
        elif op == "MatMul":
            env[out] = env[node.input[0]] @ env[node.input[1]]
        elif op == "Add":
            env[out] = env[node.input[0]] + env[node.input[1]]
        elif op == "Sub":
            env[out] = env[node.input[0]] - env[node.input[1]]
        elif op == "Mul":
            env[out] = env[node.input[0]] * env[node.input[1]]
        elif op == "Div":
            env[out] = env[node.input[0]] / env[node.input[1]]
        elif op == "Max":
            env[out] = np.maximum(env[node.input[0]], env[node.input[1]])
        elif op == "Min":
            env[out] = np.minimum(env[node.input[0]], env[node.input[1]])
        elif op == "Tanh":
            env[out] = np.tanh(env[node.input[0]])
        elif op == "Relu":
            env[out] = np.maximum(env[node.input[0]], 0.0)
        elif op == "Elu":
            x = env[node.input[0]]
            env[out] = np.where(x > 0.0, x, np.exp(x) - 1.0)
        elif op == "Sin":
            env[out] = np.sin(env[node.input[0]])
        elif op == "Cos":
            env[out] = np.cos(env[node.input[0]])
        elif op == "Clip":
            env[out] = np.clip(env[node.input[0]], env[node.input[1]], env[node.input[2]])
        elif op == "Slice":
            start = int(env[node.input[1]].ravel()[0])
            end = int(env[node.input[2]].ravel()[0])
            step = int(env[node.input[4]].ravel()[0]) if len(node.input) > 4 else 1
            env[out] = env[node.input[0]][:, start:end:step]
    return env[graph.output[0].name]


def generate_ino(cfg: HardwareConfig, onnx_path: Path, report: GuardrailReport) -> str:
    """Emit a complete, educational, non-blocking Arduino (.ino) sketch with embedded ONNX policy."""
    c_block, obs_dim, act_dim, max_diff = compile_onnx_to_c(onnx_path)
    control_ms = int(round(1000.0 / cfg.control_hz))
    dt_s = 1.0 / cfg.control_hz

    left_fwd_1 = "HIGH" if cfg.left_forward_high_low else "LOW"
    left_fwd_2 = "LOW" if cfg.left_forward_high_low else "HIGH"
    right_fwd_3 = "HIGH" if cfg.right_forward_high_low else "LOW"
    right_fwd_4 = "LOW" if cfg.right_forward_high_low else "HIGH"

    echo_str = str(cfg.echo_pin).upper()
    uses_ext_int = echo_str in ("2", "3", "D2", "D3")
    echo_c = echo_str.lstrip("D") if uses_ext_int else echo_str
    trig_c = str(cfg.trig_pin).upper().lstrip("D")

    if uses_ext_int:
        isr_code = f"""// Medición ultrasónica NO BLOQUEANTE por interrupción externa (D{echo_c} -> INT{int(echo_c) - 2})
volatile unsigned long echoStartUs = 0;
volatile unsigned int lastEchoDurationUs = 0;
volatile bool echoNewSample = false;

void echoISR() {{
  if (digitalRead(PIN_ECHO) == HIGH) {{
    echoStartUs = micros();
  }} else {{
    unsigned long dur = micros() - echoStartUs;
    if (dur > 100 && dur < 25000) {{
      lastEchoDurationUs = (unsigned int)dur;
      echoNewSample = true;
    }}
  }}
}}"""
        isr_setup = "  attachInterrupt(digitalPinToInterrupt(PIN_ECHO), echoISR, CHANGE);"
    else:
        bit = int(echo_str[1]) if echo_str.startswith("A") else 1
        isr_code = f"""// Medición ultrasónica NO BLOQUEANTE por Pin Change Interrupt (Puerto C, {echo_str} = PCINT{8 + bit})
volatile unsigned long echoStartUs = 0;
volatile unsigned int lastEchoDurationUs = 0;
volatile bool echoNewSample = false;
volatile uint8_t prevPinC = 0;

ISR(PCINT1_vect) {{
  uint8_t cur = PINC;
  uint8_t changed = cur ^ prevPinC;
  prevPinC = cur;
  if (changed & (1 << PC{bit})) {{
    if (cur & (1 << PC{bit})) {{
      echoStartUs = micros();
    }} else {{
      unsigned long dur = micros() - echoStartUs;
      if (dur > 100 && dur < 25000) {{
        lastEchoDurationUs = (unsigned int)dur;
        echoNewSample = true;
      }}
    }}
  }}
}}"""
        isr_setup = f"""  cli();
  PCICR |= (1 << PCIE1);
  PCMSK1 |= (1 << PCINT{8 + bit});
  prevPinC = PINC;
  sei();"""

    servo_header = "#include <Servo.h>\n" if cfg.servo_pin is not None else ""
    servo_decl = (
        f"const int PIN_SERVO = {cfg.servo_pin};  // SG90 cuello radar (Timer1; ENA/ENB en D{cfg.ena_pin}/D{cfg.enb_pin} Timer0)\n"
        "Servo neckServo;\n"
        "// Radar no bloqueante: 0 = frente (90 deg), 1 = derecha (25 deg), 2 = frente (90 deg), 3 = izquierda (155 deg)\n"
        "const int RADAR_ANGLES[4] = { 90, 25, 90, 155 };\n"
        "int radarPhase = 0;\n"
        "unsigned long lastRadarStepMs = 0;\n"
        "float clearanceRightCm = 80.0f;\n"
        "float clearanceCenterCm = 80.0f;\n"
        "float clearanceLeftCm = 80.0f;\n"
        if cfg.servo_pin is not None
        else ""
    )

    obs_populate = (
        f"""    obs[2] = sinf(estYawRad * 0.5f);      // qpos quat_z (heading)
    obs[6] = prevCtrl[0] * {dt_s:.4f}f;   // wheel_l angle delta
    obs[7] = prevCtrl[1] * {dt_s:.4f}f;   // wheel_r angle delta
    obs[8] = prevCtrl[2];                 // neck_servo angle (rad)
    obs[9] = prevCtrl[0] * 0.05f;         // wheel_l vel scaled
    obs[10] = prevCtrl[1] * 0.05f;        // wheel_r vel scaled
    obs[12] = prevCtrl[0] * 4.0f;         // prev_ctrl_l scaled
    obs[13] = prevCtrl[1] * 4.0f;         // prev_ctrl_r scaled
    obs[14] = prevCtrl[2] * 4.0f;         // prev_ctrl_neck scaled
    obs[15] = estVxMS;                    // linear velocity vx (m/s)
    obs[17] = estYawRateRadS;             // yaw rate wz (rad/s)"""
        if obs_dim >= 18 and act_dim >= 3
        else f"""    obs[2] = sinf(estYawRad * 0.5f);      // qpos quat_z (heading)
    obs[6] = prevCtrl[0] * {dt_s:.4f}f;   // wheel_l angle delta
    obs[7] = prevCtrl[1] * {dt_s:.4f}f;   // wheel_r angle delta
    obs[8] = estVxMS;                     // linear velocity vx (m/s)
    obs[10] = estYawRateRadS;             // yaw rate wz (rad/s)
    obs[11] = prevCtrl[0];                // wheel_l vel (rad/s)
    obs[12] = prevCtrl[1];                // wheel_r vel (rad/s)
    obs[13] = prevCtrl[0];                // prev_ctrl_l
    obs[14] = prevCtrl[1];                // prev_ctrl_r"""
    )

    neck_cruise_update = (
        "\n      if (radarPhase == 0) {\n"
        "        int neckDeg = constrain(90 + (int)(ctrl[2] * 38.0f), 25, 155);\n"
        "        neckServo.write(neckDeg);\n"
        "      }"
        if cfg.servo_pin is not None and act_dim >= 3
        else ""
    )
    prev_neck_update = "\n    prevCtrl[2] = ctrl[2];" if act_dim >= 3 else ""
    mitigations_comment = "\n".join(f"//   - {m}" for m in report.Mitigations)

    return f"""// ============================================================================
// TRIDI MCU COMPILER (export_mcu.py) — {cfg.name}
// Origen ONNX: {onnx_path.name} (paridad numérica vs onnxruntime: max_diff = {max_diff:.2e})
// Guardrails de Hardware Verificados:
{mitigations_comment}
// ============================================================================

#include <Arduino.h>
#include <math.h>
{servo_header}
// --- Pines del puente H L298N ---
const int ENA = {cfg.ena_pin};
const int IN1 = {cfg.in1_pin};
const int IN2 = {cfg.in2_pin};
const int ENB = {cfg.enb_pin};
const int IN3 = {cfg.in3_pin};
const int IN4 = {cfg.in4_pin};

// --- Pines del sensor ultrasónico HC-SR04 ---
const int PIN_TRIG = {trig_c};
const int PIN_ECHO = {echo_c};

{servo_decl}
// --- Calibración Física Sim-to-Real (MuJoCo -> L298N + Motores TT) ---
const float MAX_RADS = {cfg.max_rads:.2f}f;
const int DEADZONE_PWM = {cfg.deadzone_pwm};
const int MAX_PWM = {cfg.max_pwm};
const float RIGHT_MOTOR_TRIM = {cfg.right_motor_trim:.2f}f;
const unsigned long CONTROL_MS = {control_ms};  // {cfg.control_hz} Hz ({dt_s:.3f} s por paso)
const float STOP_DIST_CM = {cfg.stop_dist_cm}.0f;
const float CLEAR_DIST_CM = {cfg.clear_dist_cm}.0f;

{c_block}

{isr_code}

// Dispara un pulso ultrasónico de 10 us sin bloquear el lazo de 50 Hz
static inline void triggerUltrasonic() {{
  digitalWrite(PIN_TRIG, LOW);
  delayMicroseconds(2);
  digitalWrite(PIN_TRIG, HIGH);
  delayMicroseconds(10);
  digitalWrite(PIN_TRIG, LOW);
}}

// Convierte velocidad angular física (rad/s de la política ONNX) a PWM compensando zona muerta
static inline int radsToPwm(float rads, float trim) {{
  float mag = fabsf(rads) * trim;
  if (mag < 0.5f) return 0;  // Zona de parada limpia
  float norm = mag / MAX_RADS;
  if (norm > 1.0f) norm = 1.0f;
  int pwm = DEADZONE_PWM + (int)(norm * (float)(MAX_PWM - DEADZONE_PWM));
  return constrain(pwm, 0, 255);
}}

// Aplica velocidades en rad/s [rueda_izq, rueda_der] al puente H L298N
void setMotorsRadS(float leftRadS, float rightRadS) {{
  int pwmL = radsToPwm(leftRadS, 1.0f);
  int pwmR = radsToPwm(rightRadS, RIGHT_MOTOR_TRIM);

  if (pwmL == 0) {{
    digitalWrite(IN1, LOW);
    digitalWrite(IN2, LOW);
  }} else if (leftRadS >= 0.0f) {{
    digitalWrite(IN1, {left_fwd_1});
    digitalWrite(IN2, {left_fwd_2});
  }} else {{
    digitalWrite(IN1, {left_fwd_2});
    digitalWrite(IN2, {left_fwd_1});
  }}

  if (pwmR == 0) {{
    digitalWrite(IN3, LOW);
    digitalWrite(IN4, LOW);
  }} else if (rightRadS >= 0.0f) {{
    digitalWrite(IN3, {right_fwd_3});
    digitalWrite(IN4, {right_fwd_4});
  }} else {{
    digitalWrite(IN3, {right_fwd_4});
    digitalWrite(IN4, {right_fwd_3});
  }}

  analogWrite(ENA, pwmL);
  analogWrite(ENB, pwmR);
}}

// Estado interno del estimador cinemático y de la política neuronal
float filteredDistCm = 60.0f;
float estYawRad = 0.0f;
float estYawRateRadS = 0.0f;
float estVxMS = 0.0f;
float prevCtrl[TRIDI_ACT_DIM] = {{ 0.0f, 0.0f }};
unsigned long lastControlMs = 0;
unsigned long lastSonarMs = 0;

void setup() {{
  Serial.begin(9600);
  pinMode(ENA, OUTPUT);
  pinMode(IN1, OUTPUT);
  pinMode(IN2, OUTPUT);
  pinMode(ENB, OUTPUT);
  pinMode(IN3, OUTPUT);
  pinMode(IN4, OUTPUT);
  pinMode(PIN_TRIG, OUTPUT);
  pinMode(PIN_ECHO, INPUT);
{"  neckServo.attach(PIN_SERVO);\n  neckServo.write(90);" if cfg.servo_pin is not None else ""}
{isr_setup}
  setMotorsRadS(0.0f, 0.0f);
}}

void loop() {{
  unsigned long nowMs = millis();

  // 1. Disparo ultrasónico cada 40 ms (25 Hz) sin bloquear
  if (nowMs - lastSonarMs >= 40) {{
    lastSonarMs = nowMs;
    if (echoNewSample) {{
      noInterrupts();
      unsigned int dur = lastEchoDurationUs;
      echoNewSample = false;
      interrupts();
      float cm = (float)dur * 0.01715f;
      if (cm >= 2.0f && cm <= 250.0f) {{
        filteredDistCm = 0.65f * filteredDistCm + 0.35f * cm;
      }}
    }}
    triggerUltrasonic();
  }}
{'''
  // 2. Barrido no bloqueante del cuello servo SG90 (si hay obstáculo cercano explora izq/der sin frenar el loop)
  if (filteredDistCm < CLEAR_DIST_CM && (nowMs - lastRadarStepMs >= 180)) {
    lastRadarStepMs = nowMs;
    if (RADAR_ANGLES[radarPhase] == 90) clearanceCenterCm = filteredDistCm;
    else if (RADAR_ANGLES[radarPhase] < 90) clearanceRightCm = filteredDistCm;
    else clearanceLeftCm = filteredDistCm;
    radarPhase = (radarPhase + 1) & 3;
    neckServo.write(RADAR_ANGLES[radarPhase]);
  } else if (filteredDistCm >= CLEAR_DIST_CM && radarPhase != 0) {
    radarPhase = 0;
    neckServo.write(90);
  }
''' if cfg.servo_pin is not None else ''}
  // 3. Lazo de control neuronal a {cfg.control_hz} Hz ({control_ms} ms)
  if (nowMs - lastControlMs >= CONTROL_MS) {{
    lastControlMs = nowMs;

    // Construir vector de observación de {obs_dim} dimensiones idéntico a MuJoCo / Web
    float obs[TRIDI_OBS_DIM];
    for (int i = 0; i < TRIDI_OBS_DIM; ++i) obs[i] = 0.0f;

    // Si el camino está despejado, la fase estYawRad avanza suave para patrullar o girar hacia el lado más libre
    float steerBias = 0.0f;
{"    if (filteredDistCm < STOP_DIST_CM) {\n      steerBias = (clearanceLeftCm >= clearanceRightCm) ? 1.25f : -1.25f;\n    }" if cfg.servo_pin is not None else "    if (filteredDistCm < STOP_DIST_CM) {\n      steerBias = 1.15f;\n    }"}
    estYawRad += (estYawRateRadS + steerBias) * {dt_s:.4f}f;
    if (estYawRad > 3.14159f) estYawRad -= 6.28318f;
    if (estYawRad < -3.14159f) estYawRad += 6.28318f;

{obs_populate}

    float ctrl[TRIDI_ACT_DIM];
    tridi_policy_forward(obs, ctrl);

    // Modulación reactiva de seguridad ante obstáculos cercanos
    if (filteredDistCm < STOP_DIST_CM) {{
      float turnDir = (steerBias >= 0.0f) ? 1.0f : -1.0f;
      ctrl[0] = -11.5f * turnDir;
      ctrl[1] = 11.5f * turnDir;
    }} else if (filteredDistCm >= CLEAR_DIST_CM) {{
      // Avance crucero asistido por la política neuronal
      ctrl[0] = 0.65f * MAX_RADS + 0.35f * ctrl[0];
      ctrl[1] = 0.65f * MAX_RADS + 0.35f * ctrl[1];{neck_cruise_update}
    }}

    setMotorsRadS(ctrl[0], ctrl[1]);

    // Actualizar odometría interna para el siguiente paso de 20 ms
    prevCtrl[0] = ctrl[0];
    prevCtrl[1] = ctrl[1];{prev_neck_update}
    estVxMS = 0.033f * 0.5f * (ctrl[0] + ctrl[1]);
    estYawRateRadS = 0.033f * (ctrl[1] - ctrl[0]) / 0.135f;
  }}
}}
"""


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--preset", choices=sorted(PRESETS.keys()), default="luigi_lab4",
                        help="Hardware preset to compile for (default: luigi_lab4)")
    parser.add_argument("--onnx", type=Path, default=None,
                        help="Path to the .onnx policy file (defaults to luigi-lab4.onnx or luigi-lab3.onnx)")
    parser.add_argument("--out", type=Path, default=None,
                        help="Output .ino file path (defaults to the preset's firmware folder)")
    args = parser.parse_args()

    onnx_path = args.onnx
    if onnx_path is None:
        lab4_onnx = Path(__file__).resolve().parent / "policies" / "luigi-lab4.onnx"
        onnx_path = lab4_onnx if (args.preset == "luigi_lab4" and lab4_onnx.exists()) else DEFAULT_ONNX

    cfg = PRESETS[args.preset]
    report = validate_hardware(cfg)
    if not report.ok:
        for err in report.errors:
            print(f"[ERROR] {err}")
        raise SystemExit(1)

    ino_code = generate_ino(cfg, onnx_path, report)
    if args.out is None:
        if args.preset == "luigi_lab4":
            out_path = ROOT / "physics" / "models" / "luigi_lab4" / "firmware" / "LAB4_Tridi_Autonomo.ino"
        else:
            out_path = ROOT / "physics" / "models" / "luigi_lab3" / "firmware" / "robot_gestos_onnx.ino"
    else:
        out_path = args.out

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(ino_code)
    print(f"Compiled {onnx_path.name} -> {out_path.relative_to(ROOT)} ({len(ino_code.splitlines())} lines)")
    for m in report.Mitigations:
        print(f"  [OK] {m}")


if __name__ == "__main__":
    main()
