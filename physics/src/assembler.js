// Tridi Hardware Assembler Engine (Task P-3):
// 1. Deterministically parses Arduino (.ino) sketches to extract pinouts, hardware components,
//    blocking bottlenecks (pulseIn, delay) and Timer1/PWM conflicts.
// 2. Classifies uploaded CAD meshes (.stl) into kinematic roles (chassis, wheels, caster, turret).
// 3. Generates ready-to-run MuJoCo MJCF (robot.xml + scene.xml) calibrated with the P-1 catalog.
import { getComponent, getPreset, HARDWARE_CATALOG, validateHardwarePinout } from '../components/index.js';

/**
 * Deterministically parses an Arduino (.ino / C++) source file to extract pin assignments,
 * active peripherals, and real-time control loop bottlenecks.
 */
export function parseArduinoSketch(source = '') {
  const text = String(source);
  const clean = text.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

  const findPinConst = (names) => {
    for (const name of names) {
      const re = new RegExp(`(?:const\\s+int|int|#define)\\s+${name}\\s*(?:=\\s*|\\s+)(A\\d+|\\d+)`, 'i');
      const m = clean.match(re);
      if (m) return /^A\d+$/i.test(m[1]) ? m[1].toUpperCase() : Number(m[1]);
    }
    return null;
  };

  const hasServo = /#include\s*<\s*(?:ESP32)?Servo\.h\s*>/i.test(clean) || /\bServo\s+\w+/i.test(clean);
  const hasApds = /APDS9960|0x39|0x9C/i.test(clean);
  const hasUltrasonic = /pulseIn|TRIG|ECHO|HC-?SR04/i.test(text);
  const hasStepper = /STEP|DIR|Stepper|AccelStepper|NEMA/i.test(clean);
  const hasReflectiveIr = /CNY70|LINE_SENSOR|IR_OUT/i.test(clean);

  // Detect target MCU board from ESP32 / PLC / Arduino idioms
  const isEsp32 = /ledcAttach|ledcWrite|ESP32|WiFi\.h/i.test(clean);
  const isPlc = /CONVEYOR_PTO|VALVE_PUSHER|VALVE_SEALER|PLC_S7/i.test(clean);
  const board = isPlc ? 'plc_s7_1200' : isEsp32 ? 'esp32_devkit_v1' : 'arduino_uno';

  // Detect motor driver topology (TB6612FNG uses PWMA/AIN1/STBY; L298N uses ENA/IN1/ENB)
  const isTb6612 = /\b(?:PWMA|AIN1|STBY)\b/.test(clean) && !/\bENA\b/.test(clean);
  const driver = isTb6612 ? 'tb6612fng' : 'l298n';

  let servoPin = findPinConst(['PIN_SERVO', 'SERVO_PIN', 'SERVO']);
  if (servoPin === null && hasServo) {
    const attachMatch = clean.match(/\.attach\s*\(\s*(\d+)\s*\)/);
    if (attachMatch) servoPin = Number(attachMatch[1]);
  }

  const pinout = {
    ENA: findPinConst(['ENA', 'PIN_ENA', 'PWM_IZQ', 'PWMA']),
    IN1: findPinConst(['IN1', 'PIN_IN1', 'AIN1', 'STEP']),
    IN2: findPinConst(['IN2', 'PIN_IN2', 'AIN2', 'DIR']),
    ENB: findPinConst(['ENB', 'PIN_ENB', 'PWM_DER', 'PWMB']),
    IN3: findPinConst(['IN3', 'PIN_IN3', 'BIN1']),
    IN4: findPinConst(['IN4', 'PIN_IN4', 'BIN2']),
    TRIG: findPinConst(['PIN_TRIG', 'TRIG_PIN', 'TRIG']),
    ECHO: findPinConst(['PIN_ECHO', 'ECHO_PIN', 'ECHO']),
    SERVO: servoPin,
  };

  // Detect blocking pulseIn() and delay() calls that starve a 50 Hz (20 ms) control loop
  const pulseInMatches = [...clean.matchAll(/pulseIn\s*\([^)]*\)/g)];
  const delayMatches = [...clean.matchAll(/\bdelay\s*\(\s*(\d+)\s*\)/g)];
  const delayMsValues = delayMatches.map((m) => Number(m[1])).filter((n) => Number.isFinite(n) && n < 2500);
  const totalDelayMs = delayMsValues.reduce((a, b) => a + b, 0);

  const bottlenecks = [];
  if (pulseInMatches.length > 0) {
    bottlenecks.push({
      type: 'blocking_pulsein',
      count: pulseInMatches.length,
      worst_case_ms: 47.1,
      fix: pinout.ECHO === 2 || pinout.ECHO === 3
        ? `Hardware external interrupt on D${pinout.ECHO} (${pinout.ECHO === 2 ? 'INT0' : 'INT1'})`
        : 'Pin-Change Interrupt (PCINT) non-blocking echo timer',
    });
  }
  if (totalDelayMs > 0) {
    bottlenecks.push({
      type: 'blocking_delay',
      count: delayMsValues.length,
      worst_case_ms: totalDelayMs,
      fix: '50 Hz (20 ms) non-blocking state machine + continuous differential steering',
    });
  }

  const actuators = hasStepper ? ['nema17_stepper', 'nema17_stepper'] : ['tt_gearmotor_200rpm', 'tt_gearmotor_200rpm'];
  if (hasServo) actuators.push('sg90_servo');

  const sensors = [];
  if (hasUltrasonic) sensors.push('hcsr04_ultrasonic');
  if (hasApds) sensors.push('apds9960_optical');
  if (hasReflectiveIr) sensors.push('cny70_ir_reflective');

  const validation = validateHardwarePinout(board, pinout);

  return {
    board,
    driver,
    hasServo,
    hasUltrasonic,
    hasApds,
    hasStepper,
    pinout,
    actuators,
    sensors,
    bottlenecks,
    validation,
  };
}

/**
 * Classifies uploaded STL mesh filenames into kinematic roles and maps them to catalog components.
 */
export function classifyStlMeshes(meshFiles = []) {
  return meshFiles.map((rawName) => {
    const file = String(rawName).split('/').pop();
    const lower = file.toLowerCase();
    if (/cabeza|servo|turret|neck|cuello/.test(lower)) {
      return { file, role: 'servo_turret', joint: 'neck_servo_joint', componentId: 'sg90_servo' };
    }
    if (/piston|pusher|empujador|cilindro/.test(lower)) {
      return { file, role: 'linear_pusher', joint: 'pusher_slide_joint', componentId: 'pneumatic_pusher_linear' };
    }
    if (/sealer|selladora|prensa|press/.test(lower)) {
      return { file, role: 'sealer_press', joint: 'sealer_press_joint', componentId: 'pneumatic_pusher_linear' };
    }
    if (/conveyor|cinta|banda|carrier/.test(lower)) {
      return { file, role: 'conveyor_carrier', joint: 'conveyor_feed_joint', componentId: 'nema17_stepper' };
    }
    if (/llanta|tire|tpu/.test(lower)) {
      return { file, role: 'wheel_tire', joint: 'wheel_hinge', componentId: 'wheel_tt_65mm_tpu' };
    }
    if (/rin|wheel|rueda/.test(lower)) {
      return { file, role: 'wheel_rim', joint: 'wheel_hinge', componentId: 'tt_gearmotor_200rpm' };
    }
    if (/patin|caster|skid/.test(lower)) {
      return { file, role: 'caster', joint: null, componentId: 'caster_front_patin' };
    }
    if (/bandeja|tray|proto/.test(lower)) {
      return { file, role: 'tray', joint: null, componentId: null };
    }
    if (/soporte|bracket|mount/.test(lower)) {
      return { file, role: 'motor_bracket', joint: null, componentId: 'tt_gearmotor_200rpm' };
    }
    return { file, role: 'chassis', joint: 'floating_base', componentId: 'arduino_uno' };
  });
}

/**
 * Generates a valid MuJoCo MJCF model (`robotXml` + `sceneXml`) from an assembly configuration
 * (either a preset like `luigi_lab4` or custom uploaded STL meshes + catalog selections).
 */
export function generateMujocoXml(config = {}) {
  const preset = config.preset ? getPreset(config.preset) : null;
  const modelName = config.modelName || preset?.id || 'tridi_assembled_robot';
  const boardId = config.board || preset?.board || 'arduino_uno';
  const pinout = { ...(preset?.pinout ?? {}), ...(config.pinout ?? {}) };
  const meshScale = config.scale ?? '0.002 0.002 0.002';

  const meshes = config.meshes?.length
    ? classifyStlMeshes(config.meshes)
    : classifyStlMeshes([
        '1_chasis_robot.stl',
        '2_soporte_motor_x2.stl',
        '3_patin_delantero.stl',
        '4_bandeja_protoboard.stl',
        '5_rin_x2.stl',
        '6_llanta_x2_TPU.stl',
        ...(pinout.SERVO || (config.actuators ?? preset?.actuators ?? []).includes('sg90_servo')
          ? ['7_cabeza_sensor_servo.stl']
          : []),
      ]);

  const hasTurret = meshes.some((m) => m.role === 'servo_turret') || Boolean(pinout.SERVO);
  const motorSpec = getComponent('tt_gearmotor_200rpm')?.mujoco ?? HARDWARE_CATALOG.actuators.tt_gearmotor_200rpm.mujoco;
  const servoSpec = getComponent('sg90_servo')?.mujoco ?? HARDWARE_CATALOG.actuators.sg90_servo.mujoco;
  const wheelSpec = getComponent('wheel_tt_65mm_tpu')?.mujoco ?? HARDWARE_CATALOG.structures.wheel_tt_65mm_tpu.mujoco;
  const casterSpec = getComponent('caster_front_patin')?.mujoco ?? HARDWARE_CATALOG.structures.caster_front_patin.mujoco;
  const validation = validateHardwarePinout(boardId, pinout);

  const findMesh = (role, fallback) => meshes.find((m) => m.role === role)?.file ?? fallback;
  const chasisFile = findMesh('chassis', '1_chasis_robot.stl');
  const soporteFile = findMesh('motor_bracket', '2_soporte_motor_x2.stl');
  const patinFile = findMesh('caster', '3_patin_delantero.stl');
  const bandejaFile = findMesh('tray', '4_bandeja_protoboard.stl');
  const rinFile = findMesh('wheel_rim', '5_rin_x2.stl');
  const llantaFile = findMesh('wheel_tire', '6_llanta_x2_TPU.stl');
  const cabezaFile = findMesh('servo_turret', '7_cabeza_sensor_servo.stl');

  const turretAssetXml = hasTurret
    ? `\n    <mesh name="cabeza_servo_mesh" file="${cabezaFile}" scale="${meshScale}"/>`
    : '';

  const sensorOrTurretBodyXml = hasTurret
    ? `        <geom name="sg90_body" type="box" pos="0.330 -0.0108 0.004" size="0.0126 0.0232 0.022" group="2" contype="0" conaffinity="0" rgba="0.10 0.38 0.82 1"/>
        <body name="head_neck_link" pos="0.330 0 0.025">
          <inertial pos="0.004 0 0.025" mass="0.028" diaginertia="0.00002 0.00002 0.00003"/>
          <joint name="neck_servo_joint" type="hinge" axis="0 0 1" range="${servoSpec.range_rad[0]} ${servoSpec.range_rad[1]}" damping="${servoSpec.damping}" armature="${servoSpec.armature}"/>
          <geom name="cabeza_servo_visual" type="mesh" mesh="cabeza_servo_mesh" pos="0 0 0" group="2" contype="0" conaffinity="0" rgba="0.95 0.45 0.10 1"/>
          <geom name="hcsr04_pcb" type="box" pos="0.008 0 0.026" size="0.003 0.045 0.020" group="2" contype="0" conaffinity="0" rgba="0.08 0.34 0.78 1"/>
          <geom name="hcsr04_eye_l" type="cylinder" pos="0.020 0.026 0.026" quat="0.7071068 0 0.7071068 0" size="0.016 0.012" group="2" contype="0" conaffinity="0" rgba="0.78 0.80 0.84 1"/>
          <geom name="hcsr04_eye_r" type="cylinder" pos="0.020 -0.026 0.026" quat="0.7071068 0 0.7071068 0" size="0.016 0.012" group="2" contype="0" conaffinity="0" rgba="0.78 0.80 0.84 1"/>
          <site name="hcsr04_origin" pos="0.025 0 0.026" size="0.004"/>
        </body>`
    : `        <geom name="hcsr04_pcb" type="box" pos="0.285 0 0.038" size="0.003 0.045 0.020" group="2" contype="0" conaffinity="0" rgba="0.08 0.34 0.78 1"/>
        <geom name="hcsr04_eye_l" type="cylinder" pos="0.299 0.026 0.038" quat="0.7071068 0 0.7071068 0" size="0.016 0.012" group="2" contype="0" conaffinity="0" rgba="0.78 0.80 0.84 1"/>
        <geom name="hcsr04_eye_r" type="cylinder" pos="0.299 -0.026 0.038" quat="0.7071068 0 0.7071068 0" size="0.016 0.012" group="2" contype="0" conaffinity="0" rgba="0.78 0.80 0.84 1"/>`;

  const neckActuatorXml = hasTurret
    ? `\n    <position name="neck_servo_motor" joint="neck_servo_joint" kp="${servoSpec.kp}" ctrlrange="${servoSpec.ctrlrange[0]} ${servoSpec.ctrlrange[1]}" ctrllimited="true" forcerange="${servoSpec.forcerange[0]} ${servoSpec.forcerange[1]}" forcelimited="true"/>`
    : '';

  const robotXml = `<mujoco model="${modelName}">
  <compiler angle="radian" meshdir="assets"/>
  <option timestep="0.002" iterations="50" ls_iterations="10"/>

  <asset>
    <mesh name="chasis_mesh" file="${chasisFile}" scale="${meshScale}"/>
    <mesh name="soporte_motor_mesh" file="${soporteFile}" scale="${meshScale}"/>
    <mesh name="patin_mesh" file="${patinFile}" scale="${meshScale}"/>
    <mesh name="bandeja_mesh" file="${bandejaFile}" scale="${meshScale}"/>
    <mesh name="rin_mesh" file="${rinFile}" scale="${meshScale}"/>
    <mesh name="llanta_mesh" file="${llantaFile}" scale="${meshScale}"/>${turretAssetXml}
  </asset>

  <worldbody>
    <body name="pelvis" pos="0 0 0.0875">
      <freejoint name="floating_base"/>
      <inertial pos="0.015 0 0.01" mass="2.25" diaginertia="0.013 0.019 0.025"/>
      <body name="torso_link" pos="0 0 0.03">
        <inertial pos="0 0 0" mass="0.2" diaginertia="0.001 0.001 0.001"/>
      </body>
      <body name="cad_origin" pos="-0.15 0 0">
        <geom name="chasis_visual" type="mesh" mesh="chasis_mesh" group="2" contype="0" conaffinity="0" rgba="0.95 0.45 0.10 1"/>
        <geom name="chasis_collision" type="box" pos="0.165 0 0.03" size="0.175 0.112 0.032" group="3" contype="1" conaffinity="1" friction="0.3 0.01 0.005"/>
        <geom name="soporte_izq_visual" type="mesh" mesh="soporte_motor_mesh" quat="0.7071068 0.7071068 0 0" group="2" contype="0" conaffinity="0" rgba="0.88 0.40 0.08 1"/>
        <geom name="soporte_der_visual" type="mesh" mesh="soporte_motor_mesh" quat="0.7071068 -0.7071068 0 0" group="2" contype="0" conaffinity="0" rgba="0.88 0.40 0.08 1"/>
        <geom name="patin_visual" type="mesh" mesh="patin_mesh" pos="0.552 0 0" quat="0 0 1 0" group="2" contype="0" conaffinity="0" rgba="0.90 0.42 0.09 1"/>
        <geom name="patin_collision" type="sphere" pos="0.276 0 -0.0675" size="${casterSpec.radius_m}" group="3" contype="1" conaffinity="1" friction="${casterSpec.friction.join(' ')}"/>
        <geom name="rear_skid_collision" type="sphere" pos="0.020 0 -0.0675" size="0.018" group="3" contype="1" conaffinity="1" friction="${casterSpec.friction.join(' ')}"/>
        <geom name="bandeja_visual" type="mesh" mesh="bandeja_mesh" pos="0 0 0.067" group="2" contype="0" conaffinity="0" rgba="0.95 0.45 0.10 1"/>
        <body name="left_wheel_link" pos="0.080 0.132 -0.0225">
          <inertial pos="0 0 0" mass="${wheelSpec.mass_kg}" diaginertia="${wheelSpec.diaginertia.join(' ')}"/>
          <joint name="left_wheel_joint" type="hinge" axis="0 1 0" damping="${motorSpec.damping}" armature="${motorSpec.armature}"/>
          <geom name="rin_izq_visual" type="mesh" mesh="rin_mesh" pos="0 0.026 0" quat="0.7071068 0.7071068 0 0" group="2" contype="0" conaffinity="0" rgba="0.98 0.85 0.05 1"/>
          <geom name="llanta_izq_visual" type="mesh" mesh="llanta_mesh" pos="0 0.026 0" quat="0.7071068 0.7071068 0 0" group="2" contype="0" conaffinity="0" rgba="0.12 0.12 0.14 1"/>
          <geom name="left_wheel_collision" type="cylinder" quat="0.7071068 0.7071068 0 0" size="${wheelSpec.radius_m} ${wheelSpec.half_width_m}" group="3" contype="1" conaffinity="1" friction="${wheelSpec.friction.join(' ')}"/>
        </body>
        <body name="right_wheel_link" pos="0.080 -0.132 -0.0225">
          <inertial pos="0 0 0" mass="${wheelSpec.mass_kg}" diaginertia="${wheelSpec.diaginertia.join(' ')}"/>
          <joint name="right_wheel_joint" type="hinge" axis="0 1 0" damping="${motorSpec.damping}" armature="${motorSpec.armature}"/>
          <geom name="rin_der_visual" type="mesh" mesh="rin_mesh" pos="0 -0.026 0" quat="0.7071068 -0.7071068 0 0" group="2" contype="0" conaffinity="0" rgba="0.98 0.85 0.05 1"/>
          <geom name="llanta_der_visual" type="mesh" mesh="llanta_mesh" pos="0 -0.026 0" quat="0.7071068 -0.7071068 0 0" group="2" contype="0" conaffinity="0" rgba="0.12 0.12 0.14 1"/>
          <geom name="right_wheel_collision" type="cylinder" quat="0.7071068 0.7071068 0 0" size="${wheelSpec.radius_m} ${wheelSpec.half_width_m}" group="3" contype="1" conaffinity="1" friction="${wheelSpec.friction.join(' ')}"/>
        </body>
${sensorOrTurretBodyXml}
      </body>
    </body>
  </worldbody>

  <contact>
    <pair geom1="left_wheel_collision" geom2="floor" condim="3" friction="1.1 1.1 0.01"/>
    <pair geom1="right_wheel_collision" geom2="floor" condim="3" friction="1.1 1.1 0.01"/>
    <pair geom1="patin_collision" geom2="floor" condim="3" friction="0.02 0.02 0.001"/>
    <pair geom1="rear_skid_collision" geom2="floor" condim="3" friction="0.02 0.02 0.001"/>
    <pair geom1="chasis_collision" geom2="floor" condim="3" friction="0.3 0.3 0.01"/>
  </contact>

  <actuator>
    <velocity name="left_wheel_motor" joint="left_wheel_joint" kv="${motorSpec.kv}" ctrlrange="${motorSpec.ctrlrange[0]} ${motorSpec.ctrlrange[1]}" ctrllimited="true" forcerange="${motorSpec.forcerange[0]} ${motorSpec.forcerange[1]}" forcelimited="true"/>
    <velocity name="right_wheel_motor" joint="right_wheel_joint" kv="${motorSpec.kv}" ctrlrange="${motorSpec.ctrlrange[0]} ${motorSpec.ctrlrange[1]}" ctrllimited="true" forcerange="${motorSpec.forcerange[0]} ${motorSpec.forcerange[1]}" forcelimited="true"/>${neckActuatorXml}
  </actuator>
</mujoco>`;

  const qposHome = hasTurret ? '0 0 0.0875 1 0 0 0 0 0 0' : '0 0 0.0875 1 0 0 0 0 0';
  const ctrlHome = hasTurret ? '0 0 0' : '0 0';

  const sceneXml = `<mujoco model="${modelName} scene">
  <include file="${modelName}.xml"/>
  <worldbody>
    <light pos="2 0 2.5" dir="-0.8 0 -0.6"/>
    <geom name="floor" size="0 0 0.05" type="plane" contype="1" conaffinity="1"/>
    <geom name="arena_wall_n" type="box" pos="1.75 0 0.14" size="0.06 1.75 0.14" group="2" contype="1" conaffinity="1" rgba="0.26 0.28 0.32 1"/>
    <geom name="arena_wall_s" type="box" pos="-1.75 0 0.14" size="0.06 1.75 0.14" group="2" contype="1" conaffinity="1" rgba="0.26 0.28 0.32 1"/>
    <geom name="arena_wall_e" type="box" pos="0 1.75 0.14" size="1.75 0.06 0.14" group="2" contype="1" conaffinity="1" rgba="0.26 0.28 0.32 1"/>
    <geom name="arena_wall_w" type="box" pos="0 -1.75 0.14" size="1.75 0.06 0.14" group="2" contype="1" conaffinity="1" rgba="0.26 0.28 0.32 1"/>
  </worldbody>
  <keyframe>
    <key name="home" qpos="${qposHome}" ctrl="${ctrlHome}"/>
    <key name="stand" qpos="${qposHome}" ctrl="${ctrlHome}"/>
  </keyframe>
</mujoco>`;

  return {
    modelName,
    hasTurret,
    nq: hasTurret ? 10 : 9,
    nu: hasTurret ? 3 : 2,
    meshes,
    validation,
    robotXml,
    sceneXml,
  };
}
