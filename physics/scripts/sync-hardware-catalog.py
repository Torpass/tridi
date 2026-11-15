#!/usr/bin/env python3
"""Synchronize Tridi's Hardware Component Catalog (P-1) with public open-source hardware definitions
(wokwi/wokwi-elements pinouts + datasheet geometry) and generate standalone 3D MuJoCo XML models
(`physics/models/components/<id>.xml`) so every component can be inspected interactively in 3D.

Usage:
    python3 physics/scripts/sync-hardware-catalog.py
"""

from __future__ import annotations

import datetime
import json
from pathlib import Path
import re
import urllib.request

ROOT = Path(__file__).resolve().parent.parent.parent
CATALOG_JSON = ROOT / "physics" / "components" / "catalog.json"
COMPONENTS_XML_DIR = ROOT / "physics" / "models" / "components"

# Public upstream sources in wokwi/wokwi-elements (Apache-2.0) for real pinout extraction
WOKWI_SOURCES = {
    "hcsr04_ultrasonic": "https://raw.githubusercontent.com/wokwi/wokwi-elements/main/src/hc-sr04-element.ts",
    "sg90_servo": "https://raw.githubusercontent.com/wokwi/wokwi-elements/main/src/servo-element.ts",
    "nema17_stepper": "https://raw.githubusercontent.com/wokwi/wokwi-elements/main/src/stepper-motor-element.ts",
    "arduino_uno": "https://raw.githubusercontent.com/wokwi/wokwi-elements/main/src/arduino-uno-element.ts",
    "esp32_devkit_v1": "https://raw.githubusercontent.com/wokwi/wokwi-elements/main/src/esp32-devkit-v1-element.ts",
}


def fetch_wokwi_pins(url: str) -> list[dict]:
    """Extracts the `pinInfo` array from a wokwi-elements TypeScript source file."""
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Tridi-Hardware-Sync/1.0"})
        with urllib.request.urlopen(req, timeout=8) as resp:
            source = resp.read().decode("utf-8", errors="ignore")
        pins = []
        for match in re.finditer(r"\{\s*name:\s*['\"]([^'\"]+)['\"][^}]*?\}", source):
            block = match.group(0)
            name = match.group(1)
            desc_m = re.search(r"description:\s*['\"]([^'\"]+)['\"]", block)
            pins.append({"name": name, "description": desc_m.group(1) if desc_m else name})
        return pins
    except Exception as exc:
        print(f"  [warn] offline or failed fetching {url}: {exc}")
        return []


STANDALONE_COMPONENT_XMLS: dict[str, str] = {
    "sg90_servo": """<mujoco model="component_sg90_servo">
  <compiler angle="radian"/>
  <option timestep="0.002" gravity="0 0 -9.81"/>
  <worldbody>
    <light pos="0.4 -0.4 0.6" dir="-0.5 0.5 -0.7"/>
    <light pos="-0.3 0.3 0.5" dir="0.4 -0.4 -0.8"/>
    <geom name="floor" type="plane" size="0.5 0.5 0.01" rgba="0.12 0.16 0.22 1" contype="0" conaffinity="0"/>
    <body name="pelvis" pos="0 0 0.06">
      <body name="torso_link" pos="0 0 0.02"/>
      <!-- Translucent blue SG90 casing (23.2 x 12.6 x 22 mm, scaled 3x for clear 3D inspection) -->
      <geom name="sg90_case" type="box" pos="0 -0.016 0" size="0.019 0.035 0.033" group="2" rgba="0.10 0.42 0.88 0.92"/>
      <geom name="sg90_ears" type="box" pos="0 -0.016 0.012" size="0.019 0.048 0.004" group="2" rgba="0.08 0.36 0.78 1"/>
      <geom name="sg90_gear_housing" type="cylinder" pos="0 0 0.038" size="0.017 0.009" group="2" rgba="0.10 0.42 0.88 1"/>
      <geom name="sg90_wire_jr" type="capsule" fromto="0 -0.050 -0.020 0 -0.095 -0.020" size="0.004" group="2" rgba="0.92 0.48 0.12 1"/>
      <!-- Rotating output shaft & white servo horn (±90 deg = ±1.5708 rad) -->
      <body name="horn_link" pos="0 0 0.050">
        <inertial pos="0 0 0" mass="0.009" diaginertia="0.0001 0.0001 0.0001"/>
        <joint name="demo_joint" type="hinge" axis="0 0 1" range="-1.5708 1.5708" damping="0.04" armature="0.002"/>
        <geom name="brass_shaft" type="cylinder" pos="0 0 -0.003" size="0.007 0.005" group="2" rgba="0.88 0.72 0.22 1"/>
        <geom name="horn_hub" type="cylinder" pos="0 0 0.003" size="0.012 0.004" group="2" rgba="0.96 0.96 0.96 1"/>
        <geom name="horn_arm_main" type="capsule" fromto="0 0 0.003 0.052 0 0.003" size="0.006" group="2" rgba="0.96 0.96 0.96 1"/>
        <geom name="horn_tip_marker" type="sphere" pos="0.050 0 0.006" size="0.005" group="2" rgba="0.98 0.32 0.18 1"/>
      </body>
    </body>
  </worldbody>
  <actuator>
    <position name="demo_actuator" joint="demo_joint" kp="4.5" ctrlrange="-1.5708 1.5708" ctrllimited="true" forcerange="-0.6 0.6" forcelimited="true"/>
  </actuator>
  <keyframe>
    <key name="home" qpos="0" ctrl="0"/>
    <key name="stand" qpos="0" ctrl="0"/>
  </keyframe>
</mujoco>""",
    "tt_gearmotor_200rpm": """<mujoco model="component_tt_gearmotor_200rpm">
  <compiler angle="radian"/>
  <option timestep="0.002" gravity="0 0 -9.81"/>
  <worldbody>
    <light pos="0.4 -0.4 0.6" dir="-0.5 0.5 -0.7"/>
    <geom name="floor" type="plane" size="0.5 0.5 0.01" rgba="0.12 0.16 0.22 1" contype="0" conaffinity="0"/>
    <body name="pelvis" pos="0 0 0.08">
      <body name="torso_link" pos="0 0 0.02"/>
      <!-- Yellow 1:48 plastic gearbox + brushed 130 DC motor can -->
      <geom name="gearbox_yellow" type="box" pos="-0.025 0 0" size="0.065 0.024 0.028" group="2" rgba="0.96 0.80 0.10 1"/>
      <geom name="motor_can_steel" type="cylinder" pos="0.062 0 0" quat="0.7071068 0 0.7071068 0" size="0.022 0.028" group="2" rgba="0.76 0.78 0.82 1"/>
      <geom name="motor_endcap" type="cylinder" pos="0.090 0 0" quat="0.7071068 0 0.7071068 0" size="0.018 0.004" group="2" rgba="0.18 0.20 0.24 1"/>
      <!-- Rotating output shaft + indicator wheel -->
      <body name="shaft_link" pos="-0.062 0 0">
        <inertial pos="0 0 0" mass="0.028" diaginertia="0.0002 0.0004 0.0002"/>
        <joint name="demo_joint" type="hinge" axis="0 1 0" damping="0.08" armature="0.005"/>
        <geom name="white_shaft" type="cylinder" pos="0 0 0" quat="0.7071068 0.7071068 0 0" size="0.006 0.042" group="2" rgba="0.95 0.95 0.95 1"/>
        <geom name="test_hub" type="cylinder" pos="0 0.038 0" quat="0.7071068 0.7071068 0 0" size="0.048 0.012" group="2" rgba="0.98 0.85 0.05 1"/>
        <geom name="test_tire" type="cylinder" pos="0 0.038 0" quat="0.7071068 0.7071068 0 0" size="0.062 0.010" group="2" rgba="0.14 0.15 0.18 1"/>
        <geom name="spoke_marker" type="box" pos="0.032 0.049 0" size="0.022 0.003 0.006" group="2" rgba="0.95 0.28 0.18 1"/>
      </body>
    </body>
  </worldbody>
  <actuator>
    <velocity name="demo_actuator" joint="demo_joint" kv="0.8" ctrlrange="-20.94 20.94" ctrllimited="true" forcerange="-3.5 3.5" forcelimited="true"/>
  </actuator>
  <keyframe>
    <key name="home" qpos="0" ctrl="0"/>
    <key name="stand" qpos="0" ctrl="0"/>
  </keyframe>
</mujoco>""",
    "hcsr04_ultrasonic": """<mujoco model="component_hcsr04_ultrasonic">
  <compiler angle="radian"/>
  <option timestep="0.002" gravity="0 0 -9.81"/>
  <worldbody>
    <light pos="0.4 -0.4 0.6" dir="-0.5 0.5 -0.7"/>
    <geom name="floor" type="plane" size="0.5 0.5 0.01" rgba="0.12 0.16 0.22 1" contype="0" conaffinity="0"/>
    <body name="pelvis" pos="0 0 0.075">
      <body name="torso_link" pos="0 0 0.02"/>
      <body name="sensor_turret" pos="0 0 0">
        <inertial pos="0 0 0" mass="0.015" diaginertia="0.0001 0.0001 0.0001"/>
        <joint name="demo_joint" type="hinge" axis="0 0 1" range="-1.2 1.2" damping="0.05" armature="0.002"/>
        <!-- Blue PCB (45 x 20 x 1.6 mm, scaled 2.5x for inspection) -->
        <geom name="hcsr04_pcb" type="box" pos="0 0 0" size="0.004 0.056 0.025" group="2" rgba="0.08 0.36 0.82 1"/>
        <geom name="eye_left" type="cylinder" pos="0.018 0.032 0" quat="0.7071068 0 0.7071068 0" size="0.020 0.015" group="2" rgba="0.80 0.82 0.86 1"/>
        <geom name="eye_right" type="cylinder" pos="0.018 -0.032 0" quat="0.7071068 0 0.7071068 0" size="0.020 0.015" group="2" rgba="0.80 0.82 0.86 1"/>
        <geom name="mesh_left" type="cylinder" pos="0.0335 0.032 0" quat="0.7071068 0 0.7071068 0" size="0.016 0.0015" group="2" rgba="0.16 0.18 0.22 1"/>
        <geom name="mesh_right" type="cylinder" pos="0.0335 -0.032 0" quat="0.7071068 0 0.7071068 0" size="0.016 0.0015" group="2" rgba="0.16 0.18 0.22 1"/>
        <geom name="xtal_osc" type="box" pos="-0.006 0 0.012" size="0.003 0.012 0.005" group="2" rgba="0.82 0.84 0.88 1"/>
        <!-- 4 Header pins: VCC, TRIG, ECHO, GND -->
        <geom name="pin_vcc" type="cylinder" pos="0 0.012 -0.035" size="0.002 0.010" group="2" rgba="0.92 0.78 0.20 1"/>
        <geom name="pin_trig" type="cylinder" pos="0 0.004 -0.035" size="0.002 0.010" group="2" rgba="0.92 0.78 0.20 1"/>
        <geom name="pin_echo" type="cylinder" pos="0 -0.004 -0.035" size="0.002 0.010" group="2" rgba="0.92 0.78 0.20 1"/>
        <geom name="pin_gnd" type="cylinder" pos="0 -0.012 -0.035" size="0.002 0.010" group="2" rgba="0.92 0.78 0.20 1"/>
      </body>
    </body>
  </worldbody>
  <actuator>
    <position name="demo_actuator" joint="demo_joint" kp="4.0" ctrlrange="-1.2 1.2" ctrllimited="true"/>
  </actuator>
  <keyframe>
    <key name="home" qpos="0" ctrl="0"/>
    <key name="stand" qpos="0" ctrl="0"/>
  </keyframe>
</mujoco>""",
    "nema17_stepper": """<mujoco model="component_nema17_stepper">
  <compiler angle="radian"/>
  <option timestep="0.002" gravity="0 0 -9.81"/>
  <worldbody>
    <light pos="0.4 -0.4 0.6" dir="-0.5 0.5 -0.7"/>
    <geom name="floor" type="plane" size="0.5 0.5 0.01" rgba="0.12 0.16 0.22 1" contype="0" conaffinity="0"/>
    <body name="pelvis" pos="0 0 0.07">
      <body name="torso_link" pos="0 0 0.02"/>
      <geom name="nema_flange_front" type="box" pos="0 0 0.032" size="0.042 0.042 0.008" group="2" rgba="0.78 0.80 0.84 1"/>
      <geom name="nema_stator_stack" type="box" pos="0 0 0" size="0.041 0.041 0.024" group="2" rgba="0.16 0.18 0.22 1"/>
      <geom name="nema_flange_rear" type="box" pos="0 0 -0.032" size="0.042 0.042 0.008" group="2" rgba="0.78 0.80 0.84 1"/>
      <geom name="nema_pilot_ring" type="cylinder" pos="0 0 0.042" size="0.022 0.003" group="2" rgba="0.82 0.84 0.88 1"/>
      <body name="rotor_link" pos="0 0 0.055">
        <inertial pos="0 0 0" mass="0.08" diaginertia="0.0002 0.0002 0.0003"/>
        <joint name="demo_joint" type="hinge" axis="0 0 1" damping="0.15" armature="0.012"/>
        <geom name="rotor_shaft" type="cylinder" pos="0 0 0.01" size="0.005 0.022" group="2" rgba="0.88 0.90 0.92 1"/>
        <geom name="pulley_disc" type="cylinder" pos="0 0 0.022" size="0.026 0.006" group="2" rgba="0.95 0.52 0.12 1"/>
        <geom name="index_pin" type="sphere" pos="0.020 0 0.029" size="0.005" group="2" rgba="0.98 0.98 0.98 1"/>
      </body>
    </body>
  </worldbody>
  <actuator>
    <velocity name="demo_actuator" joint="demo_joint" kv="2.5" ctrlrange="-31.4 31.4" ctrllimited="true" forcerange="-8 8" forcelimited="true"/>
  </actuator>
  <keyframe>
    <key name="home" qpos="0" ctrl="0"/>
    <key name="stand" qpos="0" ctrl="0"/>
  </keyframe>
</mujoco>""",
    "pneumatic_pusher_linear": """<mujoco model="component_pneumatic_pusher_linear">
  <compiler angle="radian"/>
  <option timestep="0.002" gravity="0 0 -9.81"/>
  <worldbody>
    <light pos="0.4 -0.4 0.6" dir="-0.5 0.5 -0.7"/>
    <geom name="floor" type="plane" size="0.5 0.5 0.01" rgba="0.12 0.16 0.22 1" contype="0" conaffinity="0"/>
    <body name="pelvis" pos="0 0 0.06">
      <body name="torso_link" pos="0 0 0.02"/>
      <geom name="cylinder_barrel" type="cylinder" pos="-0.06 0 0" quat="0.7071068 0 0.7071068 0" size="0.024 0.085" group="2" rgba="0.74 0.77 0.82 1"/>
      <geom name="cap_front" type="box" pos="0.025 0 0" size="0.012 0.028 0.028" group="2" rgba="0.22 0.25 0.30 1"/>
      <geom name="cap_rear" type="box" pos="-0.145 0 0" size="0.012 0.028 0.028" group="2" rgba="0.22 0.25 0.30 1"/>
      <geom name="valve_port_a" type="cylinder" pos="0.018 0 0.032" size="0.006 0.008" group="2" rgba="0.10 0.55 0.90 1"/>
      <geom name="valve_port_b" type="cylinder" pos="-0.138 0 0.032" size="0.006 0.008" group="2" rgba="0.10 0.55 0.90 1"/>
      <body name="piston_link" pos="0.04 0 0">
        <inertial pos="0.04 0 0" mass="0.25" diaginertia="0.001 0.001 0.001"/>
        <joint name="demo_joint" type="slide" axis="1 0 0" range="0.0 0.16" damping="4.0" armature="0.05"/>
        <geom name="piston_rod" type="cylinder" pos="0.02 0 0" quat="0.7071068 0 0.7071068 0" size="0.009 0.075" group="2" rgba="0.90 0.92 0.95 1"/>
        <geom name="pusher_head" type="box" pos="0.095 0 0" size="0.010 0.048 0.038" group="2" rgba="0.92 0.26 0.18 1"/>
      </body>
    </body>
  </worldbody>
  <actuator>
    <position name="demo_actuator" joint="demo_joint" kp="120.0" ctrlrange="0.0 0.16" ctrllimited="true" forcerange="-85 85" forcelimited="true"/>
  </actuator>
  <keyframe>
    <key name="home" qpos="0" ctrl="0"/>
    <key name="stand" qpos="0" ctrl="0"/>
  </keyframe>
</mujoco>""",
    "arduino_uno": """<mujoco model="component_arduino_uno">
  <compiler angle="radian"/>
  <option timestep="0.002" gravity="0 0 -9.81"/>
  <worldbody>
    <light pos="0.4 -0.4 0.6" dir="-0.5 0.5 -0.7"/>
    <geom name="floor" type="plane" size="0.5 0.5 0.01" rgba="0.12 0.16 0.22 1" contype="0" conaffinity="0"/>
    <body name="pelvis" pos="0 0 0.04">
      <body name="torso_link" pos="0 0 0.02"/>
      <body name="board_turntable" pos="0 0 0">
        <inertial pos="0 0 0" mass="0.025" diaginertia="0.0001 0.0001 0.0001"/>
        <joint name="demo_joint" type="hinge" axis="0 0 1" range="-3.14 3.14" damping="0.05" armature="0.002"/>
        <geom name="uno_pcb" type="box" pos="0 0 0" size="0.0686 0.0533 0.0032" group="2" rgba="0.04 0.44 0.70 1"/>
        <geom name="usb_b_port" type="box" pos="-0.058 0.018 0.014" size="0.016 0.012 0.011" group="2" rgba="0.82 0.84 0.88 1"/>
        <geom name="dc_barrel" type="box" pos="-0.055 -0.032 0.013" size="0.014 0.011 0.010" group="2" rgba="0.12 0.12 0.15 1"/>
        <geom name="atmega328p_dip" type="box" pos="0.018 -0.012 0.006" size="0.035 0.009 0.004" group="2" rgba="0.10 0.11 0.14 1"/>
        <geom name="header_digital" type="box" pos="0.008 0.046 0.009" size="0.052 0.0035 0.006" group="2" rgba="0.10 0.10 0.12 1"/>
        <geom name="header_analog" type="box" pos="0.012 -0.046 0.009" size="0.045 0.0035 0.006" group="2" rgba="0.10 0.10 0.12 1"/>
        <geom name="reset_btn" type="cylinder" pos="-0.052 0.040 0.006" size="0.004 0.003" group="2" rgba="0.90 0.25 0.20 1"/>
      </body>
    </body>
  </worldbody>
  <actuator>
    <position name="demo_actuator" joint="demo_joint" kp="3.0" ctrlrange="-3.14 3.14" ctrllimited="true"/>
  </actuator>
  <keyframe>
    <key name="home" qpos="0" ctrl="0"/>
    <key name="stand" qpos="0" ctrl="0"/>
  </keyframe>
</mujoco>""",
    "l298n": """<mujoco model="component_l298n">
  <compiler angle="radian"/>
  <option timestep="0.002" gravity="0 0 -9.81"/>
  <worldbody>
    <light pos="0.4 -0.4 0.6" dir="-0.5 0.5 -0.7"/>
    <geom name="floor" type="plane" size="0.5 0.5 0.01" rgba="0.12 0.16 0.22 1" contype="0" conaffinity="0"/>
    <body name="pelvis" pos="0 0 0.04">
      <body name="torso_link" pos="0 0 0.02"/>
      <body name="board_turntable" pos="0 0 0">
        <inertial pos="0 0 0" mass="0.026" diaginertia="0.0001 0.0001 0.0001"/>
        <joint name="demo_joint" type="hinge" axis="0 0 1" range="-3.14 3.14" damping="0.05" armature="0.002"/>
        <geom name="l298n_pcb" type="box" pos="0 0 0" size="0.054 0.054 0.0032" group="2" rgba="0.82 0.12 0.12 1"/>
        <geom name="heatsink_black" type="box" pos="0.010 0 0.028" size="0.022 0.032 0.025" group="2" rgba="0.12 0.13 0.16 1"/>
        <geom name="term_out_a" type="box" pos="0 0.044 0.012" size="0.012 0.008 0.010" group="2" rgba="0.10 0.45 0.85 1"/>
        <geom name="term_out_b" type="box" pos="0 -0.044 0.012" size="0.012 0.008 0.010" group="2" rgba="0.10 0.45 0.85 1"/>
        <geom name="term_pwr" type="box" pos="-0.042 -0.018 0.012" size="0.008 0.018 0.010" group="2" rgba="0.10 0.45 0.85 1"/>
        <geom name="cap_1" type="cylinder" pos="-0.022 0.020 0.014" size="0.008 0.011" group="2" rgba="0.18 0.20 0.24 1"/>
        <geom name="cap_2" type="cylinder" pos="-0.022 -0.002 0.014" size="0.008 0.011" group="2" rgba="0.18 0.20 0.24 1"/>
      </body>
    </body>
  </worldbody>
  <actuator>
    <position name="demo_actuator" joint="demo_joint" kp="3.0" ctrlrange="-3.14 3.14" ctrllimited="true"/>
  </actuator>
  <keyframe>
    <key name="home" qpos="0" ctrl="0"/>
    <key name="stand" qpos="0" ctrl="0"/>
  </keyframe>
</mujoco>""",
    "wheel_tt_65mm_tpu": """<mujoco model="component_wheel_tt_65mm_tpu">
  <compiler angle="radian" meshdir="../luigi_lab4/assets"/>
  <option timestep="0.002" gravity="0 0 -9.81"/>
  <asset>
    <mesh name="rin_mesh" file="5_rin_x2.stl" scale="0.002 0.002 0.002"/>
    <mesh name="llanta_mesh" file="6_llanta_x2_TPU.stl" scale="0.002 0.002 0.002"/>
  </asset>
  <worldbody>
    <light pos="0.4 -0.4 0.6" dir="-0.5 0.5 -0.7"/>
    <geom name="floor" type="plane" size="0.5 0.5 0.01" rgba="0.12 0.16 0.22 1" contype="0" conaffinity="0"/>
    <body name="pelvis" pos="0 0 0.08">
      <body name="torso_link" pos="0 0 0.02"/>
      <body name="wheel_body" pos="0 0 0">
        <inertial pos="0 0 0" mass="0.35" diaginertia="0.0008 0.0014 0.0008"/>
        <joint name="demo_joint" type="hinge" axis="0 1 0" damping="0.08" armature="0.005"/>
        <geom name="rin_visual" type="mesh" mesh="rin_mesh" pos="0 0.026 0" quat="0.7071068 0.7071068 0 0" group="2" rgba="0.98 0.85 0.05 1"/>
        <geom name="llanta_visual" type="mesh" mesh="llanta_mesh" pos="0 0.026 0" quat="0.7071068 0.7071068 0 0" group="2" rgba="0.12 0.12 0.14 1"/>
      </body>
    </body>
  </worldbody>
  <actuator>
    <velocity name="demo_actuator" joint="demo_joint" kv="0.8" ctrlrange="-20.94 20.94" ctrllimited="true"/>
  </actuator>
  <keyframe>
    <key name="home" qpos="0" ctrl="0"/>
    <key name="stand" qpos="0" ctrl="0"/>
  </keyframe>
</mujoco>""",
    "esp32_devkit_v1": """<mujoco model="component_esp32_devkit_v1">
  <compiler angle="radian"/>
  <option timestep="0.002" gravity="0 0 -9.81"/>
  <worldbody>
    <light pos="0.4 -0.4 0.6" dir="-0.5 0.5 -0.7"/>
    <geom name="floor" type="plane" size="0.5 0.5 0.01" rgba="0.12 0.16 0.22 1" contype="0" conaffinity="0"/>
    <body name="pelvis" pos="0 0 0.045">
      <body name="torso_link" pos="0 0 0.02"/>
      <body name="board_turntable" pos="0 0 0">
        <inertial pos="0 0 0" mass="0.015" diaginertia="0.0001 0.0001 0.0001"/>
        <joint name="demo_joint" type="hinge" axis="0 0 1" range="-3.14 3.14" damping="0.05" armature="0.002"/>
        <!-- Matte dark ESP32 DevKit V1 PCB (55 x 28 mm, scaled 2x for 3D inspection) -->
        <geom name="esp32_pcb" type="box" pos="0 0 0" size="0.055 0.028 0.0028" group="2" rgba="0.10 0.12 0.15 1"/>
        <geom name="wroom32_shield" type="box" pos="0.018 0 0.006" size="0.018 0.016 0.0032" group="2" rgba="0.82 0.84 0.88 1"/>
        <geom name="pcb_antenna" type="box" pos="0.044 0 0.003" size="0.008 0.016 0.001" group="2" rgba="0.85 0.72 0.22 1"/>
        <geom name="micro_usb" type="box" pos="-0.052 0 0.005" size="0.006 0.008 0.003" group="2" rgba="0.78 0.80 0.84 1"/>
        <geom name="cp2102_uart" type="box" pos="-0.026 0 0.004" size="0.006 0.006 0.0015" group="2" rgba="0.08 0.08 0.10 1"/>
        <geom name="btn_en" type="cylinder" pos="-0.042 0.018 0.005" size="0.0035 0.0025" group="2" rgba="0.85 0.85 0.85 1"/>
        <geom name="btn_boot" type="cylinder" pos="-0.042 -0.018 0.005" size="0.0035 0.0025" group="2" rgba="0.85 0.85 0.85 1"/>
        <geom name="hdr_left" type="box" pos="-0.004 0.024 0.006" size="0.046 0.0025 0.004" group="2" rgba="0.12 0.12 0.14 1"/>
        <geom name="hdr_right" type="box" pos="-0.004 -0.024 0.006" size="0.046 0.0025 0.004" group="2" rgba="0.12 0.12 0.14 1"/>
      </body>
    </body>
  </worldbody>
  <actuator>
    <position name="demo_actuator" joint="demo_joint" kp="3.0" ctrlrange="-3.14 3.14" ctrllimited="true"/>
  </actuator>
  <keyframe>
    <key name="home" qpos="0" ctrl="0"/>
    <key name="stand" qpos="0" ctrl="0"/>
  </keyframe>
</mujoco>""",
    "plc_s7_1200": """<mujoco model="component_plc_s7_1200">
  <compiler angle="radian"/>
  <option timestep="0.002" gravity="0 0 -9.81"/>
  <worldbody>
    <light pos="0.4 -0.4 0.6" dir="-0.5 0.5 -0.7"/>
    <geom name="floor" type="plane" size="0.5 0.5 0.01" rgba="0.12 0.16 0.22 1" contype="0" conaffinity="0"/>
    <body name="pelvis" pos="0 0 0.075">
      <body name="torso_link" pos="0 0 0.02"/>
      <body name="board_turntable" pos="0 0 0">
        <inertial pos="0 0 0" mass="0.38" diaginertia="0.001 0.001 0.001"/>
        <joint name="demo_joint" type="hinge" axis="0 0 1" range="-3.14 3.14" damping="0.08" armature="0.004"/>
        <!-- DIN-rail Industrial PLC Housing (24V DC DI/DO + PROFINET RJ45) -->
        <geom name="din_rail" type="box" pos="-0.038 0 0" size="0.005 0.095 0.018" group="2" rgba="0.72 0.75 0.80 1"/>
        <geom name="plc_body" type="box" pos="0 0 0" size="0.036 0.065 0.052" group="2" rgba="0.22 0.27 0.32 1"/>
        <geom name="plc_faceplate" type="box" pos="0.034 0 0" size="0.005 0.062 0.046" group="2" rgba="0.28 0.34 0.40 1"/>
        <geom name="plc_teal_strip" type="box" pos="0.0395 0 0.018" size="0.001 0.060 0.006" group="2" rgba="0.00 0.62 0.65 1"/>
        <geom name="led_run" type="sphere" pos="0.040 0.042 0.004" size="0.0035" group="2" rgba="0.18 0.92 0.38 1"/>
        <geom name="led_diag" type="sphere" pos="0.040 0.032 0.004" size="0.0035" group="2" rgba="0.98 0.75 0.12 1"/>
        <geom name="rj45_port" type="box" pos="0.018 -0.032 -0.048" size="0.012 0.012 0.010" group="2" rgba="0.78 0.80 0.84 1"/>
        <geom name="terminal_top" type="box" pos="0.012 0 0.055" size="0.015 0.055 0.006" group="2" rgba="0.14 0.16 0.18 1"/>
        <geom name="terminal_bot" type="box" pos="0.012 0 -0.055" size="0.015 0.055 0.006" group="2" rgba="0.14 0.16 0.18 1"/>
      </body>
    </body>
  </worldbody>
  <actuator>
    <position name="demo_actuator" joint="demo_joint" kp="3.5" ctrlrange="-3.14 3.14" ctrllimited="true"/>
  </actuator>
  <keyframe>
    <key name="home" qpos="0" ctrl="0"/>
    <key name="stand" qpos="0" ctrl="0"/>
  </keyframe>
</mujoco>""",
    "tb6612fng": """<mujoco model="component_tb6612fng">
  <compiler angle="radian"/>
  <option timestep="0.002" gravity="0 0 -9.81"/>
  <worldbody>
    <light pos="0.4 -0.4 0.6" dir="-0.5 0.5 -0.7"/>
    <geom name="floor" type="plane" size="0.5 0.5 0.01" rgba="0.12 0.16 0.22 1" contype="0" conaffinity="0"/>
    <body name="pelvis" pos="0 0 0.045">
      <body name="torso_link" pos="0 0 0.02"/>
      <body name="board_turntable" pos="0 0 0">
        <inertial pos="0 0 0" mass="0.006" diaginertia="0.0001 0.0001 0.0001"/>
        <joint name="demo_joint" type="hinge" axis="0 0 1" range="-3.14 3.14" damping="0.05" armature="0.002"/>
        <!-- Compact red/crimson TB6612FNG Dual MOSFET Breakout (20 x 20 mm, scaled 2.5x) -->
        <geom name="tb_pcb" type="box" pos="0 0 0" size="0.038 0.038 0.0028" group="2" rgba="0.78 0.10 0.16 1"/>
        <geom name="ssop24_ic" type="box" pos="0 0 0.005" size="0.016 0.012 0.0025" group="2" rgba="0.10 0.11 0.14 1"/>
        <geom name="smd_cap_1" type="box" pos="-0.020 0.012 0.005" size="0.005 0.003 0.0025" group="2" rgba="0.82 0.68 0.32 1"/>
        <geom name="smd_cap_2" type="box" pos="-0.020 -0.012 0.005" size="0.005 0.003 0.0025" group="2" rgba="0.82 0.68 0.32 1"/>
        <geom name="pins_left" type="box" pos="0 0.032 -0.008" size="0.032 0.0025 0.009" group="2" rgba="0.90 0.76 0.20 1"/>
        <geom name="pins_right" type="box" pos="0 -0.032 -0.008" size="0.032 0.0025 0.009" group="2" rgba="0.90 0.76 0.20 1"/>
      </body>
    </body>
  </worldbody>
  <actuator>
    <position name="demo_actuator" joint="demo_joint" kp="3.0" ctrlrange="-3.14 3.14" ctrllimited="true"/>
  </actuator>
  <keyframe>
    <key name="home" qpos="0" ctrl="0"/>
    <key name="stand" qpos="0" ctrl="0"/>
  </keyframe>
</mujoco>""",
    "apds9960_optical": """<mujoco model="component_apds9960_optical">
  <compiler angle="radian"/>
  <option timestep="0.002" gravity="0 0 -9.81"/>
  <worldbody>
    <light pos="0.4 -0.4 0.6" dir="-0.5 0.5 -0.7"/>
    <geom name="floor" type="plane" size="0.5 0.5 0.01" rgba="0.12 0.16 0.22 1" contype="0" conaffinity="0"/>
    <body name="pelvis" pos="0 0 0.065">
      <body name="torso_link" pos="0 0 0.02"/>
      <body name="sensor_turret" pos="0 0 0">
        <inertial pos="0 0 0" mass="0.005" diaginertia="0.0001 0.0001 0.0001"/>
        <joint name="demo_joint" type="hinge" axis="0 0 1" range="-1.2 1.2" damping="0.05" armature="0.002"/>
        <!-- Purple GY-9960 / APDS-9960 I2C Breakout (0x39, IR Proximity Reg 0x9C) -->
        <geom name="apds_pcb" type="box" pos="0 0 0" size="0.004 0.042 0.032" group="2" rgba="0.48 0.14 0.62 1"/>
        <geom name="apds_die_package" type="box" pos="0.006 0 0.004" size="0.0035 0.014 0.010" group="2" rgba="0.12 0.12 0.15 1"/>
        <geom name="ir_led_aperture" type="cylinder" pos="0.0095 0.005 0.004" quat="0.7071068 0 0.7071068 0" size="0.0035 0.001" group="2" rgba="0.88 0.18 0.35 1"/>
        <geom name="photodiode_window" type="cylinder" pos="0.0095 -0.005 0.004" quat="0.7071068 0 0.7071068 0" size="0.0035 0.001" group="2" rgba="0.20 0.75 0.95 1"/>
        <geom name="i2c_header" type="box" pos="0 0 -0.036" size="0.003 0.028 0.008" group="2" rgba="0.90 0.76 0.20 1"/>
      </body>
    </body>
  </worldbody>
  <actuator>
    <position name="demo_actuator" joint="demo_joint" kp="4.0" ctrlrange="-1.2 1.2" ctrllimited="true"/>
  </actuator>
  <keyframe>
    <key name="home" qpos="0" ctrl="0"/>
    <key name="stand" qpos="0" ctrl="0"/>
  </keyframe>
</mujoco>""",
    "cny70_ir_reflective": """<mujoco model="component_cny70_ir_reflective">
  <compiler angle="radian"/>
  <option timestep="0.002" gravity="0 0 -9.81"/>
  <worldbody>
    <light pos="0.4 -0.4 0.6" dir="-0.5 0.5 -0.7"/>
    <geom name="floor" type="plane" size="0.5 0.5 0.01" rgba="0.12 0.16 0.22 1" contype="0" conaffinity="0"/>
    <body name="pelvis" pos="0 0 0.065">
      <body name="torso_link" pos="0 0 0.02"/>
      <body name="sensor_turret" pos="0 0 0">
        <inertial pos="0 0 0" mass="0.004" diaginertia="0.0001 0.0001 0.0001"/>
        <joint name="demo_joint" type="hinge" axis="0 0 1" range="-1.2 1.2" damping="0.05" armature="0.002"/>
        <!-- Cube CNY70 Reflective Optical Sensor (7x7x6 mm, scaled 4x for inspection) -->
        <geom name="cny70_housing" type="box" pos="0 0 0" size="0.016 0.018 0.018" group="2" rgba="0.12 0.13 0.16 1"/>
        <geom name="emitter_eye" type="cylinder" pos="0.0165 0.007 0" quat="0.7071068 0 0.7071068 0" size="0.0055 0.002" group="2" rgba="0.28 0.55 0.92 1"/>
        <geom name="detector_eye" type="cylinder" pos="0.0165 -0.007 0" quat="0.7071068 0 0.7071068 0" size="0.0055 0.002" group="2" rgba="0.18 0.18 0.24 1"/>
        <geom name="lead_1" type="cylinder" pos="-0.008 0.008 -0.028" size="0.0015 0.012" group="2" rgba="0.82 0.84 0.88 1"/>
        <geom name="lead_2" type="cylinder" pos="-0.008 -0.008 -0.028" size="0.0015 0.012" group="2" rgba="0.82 0.84 0.88 1"/>
        <geom name="lead_3" type="cylinder" pos="0.008 0.008 -0.028" size="0.0015 0.012" group="2" rgba="0.82 0.84 0.88 1"/>
        <geom name="lead_4" type="cylinder" pos="0.008 -0.008 -0.028" size="0.0015 0.012" group="2" rgba="0.82 0.84 0.88 1"/>
      </body>
    </body>
  </worldbody>
  <actuator>
    <position name="demo_actuator" joint="demo_joint" kp="4.0" ctrlrange="-1.2 1.2" ctrllimited="true"/>
  </actuator>
  <keyframe>
    <key name="home" qpos="0" ctrl="0"/>
    <key name="stand" qpos="0" ctrl="0"/>
  </keyframe>
</mujoco>""",
    "caster_front_patin": """<mujoco model="component_caster_front_patin">
  <compiler angle="radian" meshdir="../luigi_lab4/assets"/>
  <option timestep="0.002" gravity="0 0 -9.81"/>
  <asset>
    <mesh name="patin_mesh" file="3_patin_delantero.stl" scale="0.002 0.002 0.002"/>
  </asset>
  <worldbody>
    <light pos="0.4 -0.4 0.6" dir="-0.5 0.5 -0.7"/>
    <geom name="floor" type="plane" size="0.5 0.5 0.01" rgba="0.12 0.16 0.22 1" contype="0" conaffinity="0"/>
    <body name="pelvis" pos="0 0 0.065">
      <body name="torso_link" pos="0 0 0.02"/>
      <body name="caster_turntable" pos="0 0 0">
        <inertial pos="0 0 0" mass="0.02" diaginertia="0.0001 0.0001 0.0001"/>
        <joint name="demo_joint" type="hinge" axis="0 0 1" range="-3.14 3.14" damping="0.04" armature="0.002"/>
        <geom name="patin_visual" type="mesh" mesh="patin_mesh" pos="0.276 0 0.02" quat="0 0 1 0" group="2" rgba="0.95 0.45 0.10 1"/>
        <geom name="contact_ball" type="sphere" pos="0 0 -0.038" size="0.020" group="2" rgba="0.82 0.85 0.90 0.85"/>
      </body>
    </body>
  </worldbody>
  <actuator>
    <position name="demo_actuator" joint="demo_joint" kp="3.0" ctrlrange="-3.14 3.14" ctrllimited="true"/>
  </actuator>
  <keyframe>
    <key name="home" qpos="0" ctrl="0"/>
    <key name="stand" qpos="0" ctrl="0"/>
  </keyframe>
</mujoco>""",
}


def main() -> None:
    COMPONENTS_XML_DIR.mkdir(parents=True, exist_ok=True)
    catalog = json.loads(CATALOG_JSON.read_text())
    catalog["synced_at"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    catalog["upstream_sources"] = [
        {"repo": "wokwi/wokwi-elements", "license": "Apache-2.0", "url": "https://github.com/wokwi/wokwi-elements"},
        {"repo": "google-deepmind/mujoco_menagerie", "license": "BSD-3-Clause", "url": "https://github.com/google-deepmind/mujoco_menagerie"},
    ]

    # 1. Sync upstream pin metadata from wokwi/wokwi-elements
    for comp_id, url in WOKWI_SOURCES.items():
        pins = fetch_wokwi_pins(url)
        for bucket in ("mcus", "drivers", "actuators", "sensors", "structures"):
            if comp_id in catalog.get(bucket, {}):
                entry = catalog[bucket][comp_id]
                entry["upstream_url"] = url
                if pins:
                    entry.setdefault("mcu", {})["upstream_pins"] = pins
                print(f"  [sync] {comp_id}: {len(pins)} pins extracted from wokwi/wokwi-elements")

    # 2. Write standalone 3D MuJoCo XML models for interactive 3D inspection
    for comp_id, xml_content in STANDALONE_COMPONENT_XMLS.items():
        xml_path = COMPONENTS_XML_DIR / f"{comp_id}.xml"
        xml_path.write_text(xml_content.strip() + "\n")
        for bucket in ("mcus", "drivers", "actuators", "sensors", "structures"):
            if comp_id in catalog.get(bucket, {}):
                catalog[bucket][comp_id]["preview_mjcf"] = f"components/{comp_id}.xml"
        print(f"  [3d-xml] wrote {xml_path.relative_to(ROOT)}")

    CATALOG_JSON.write_text(json.dumps(catalog, indent=2, ensure_ascii=False) + "\n")
    print(f"Done. Updated {CATALOG_JSON.relative_to(ROOT)} and {len(STANDALONE_COMPONENT_XMLS)} 3D component scenes.")


if __name__ == "__main__":
    main()
