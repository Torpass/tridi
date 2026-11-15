// Hardware Component Catalog & Deterministic Pin/Timer Guardrails (Task P-1).
// Bridges physical MuJoCo parameters (mass, damping, armature, kp/kv, ray cones) with
// real-world MCU electrical constraints (PWM deadzone, Timer1 <Servo.h> conflicts, ISR pins).
import baseCatalog from './catalog.json' with { type: 'json' };

const BUCKETS = ['mcus', 'drivers', 'actuators', 'sensors', 'structures'];

// Deep clone so runtime CRUD operations (registerComponent / removeComponent) can extend the catalog cleanly.
const state = structuredClone(baseCatalog);

function bucketForCategory(category) {
  if (category === 'mcu') return 'mcus';
  if (category === 'driver') return 'drivers';
  if (['dc_motor', 'servo', 'stepper', 'linear_actuator', 'actuator'].includes(category)) return 'actuators';
  if (['distance_sensor', 'optical_sensor', 'sensor'].includes(category)) return 'sensors';
  return 'structures';
}

export const HARDWARE_CATALOG = state;

/**
 * Lists hardware components, optionally filtered by bucket/category or search query.
 */
export function listComponents({ bucket, category, query } = {}) {
  const buckets = bucket && BUCKETS.includes(bucket) ? [bucket] : BUCKETS;
  const q = query ? String(query).trim().toLowerCase() : '';
  const items = [];
  for (const b of buckets) {
    for (const comp of Object.values(state[b] ?? {})) {
      if (category && comp.category !== category) continue;
      if (q && !`${comp.id} ${comp.name} ${comp.category}`.toLowerCase().includes(q)) continue;
      items.push({ ...comp, bucket: b });
    }
  }
  return items;
}

/**
 * Looks up a single component by ID across all catalog buckets.
 */
export function getComponent(id) {
  if (!id) return null;
  for (const b of BUCKETS) {
    if (state[b]?.[id]) return { ...state[b][id], bucket: b };
  }
  return null;
}

/**
 * Returns a complete robot hardware preset (e.g. 'luigi_lab3', 'luigi_lab4').
 */
export function getPreset(presetId) {
  return state.presets?.[presetId] ? structuredClone(state.presets[presetId]) : null;
}

/**
 * CRUD: Registers or updates a hardware component in the catalog after validating its required fields.
 */
export function registerComponent(component) {
  if (!component || typeof component !== 'object') {
    throw new Error('Component must be an object.');
  }
  const id = String(component.id ?? '').trim();
  const name = String(component.name ?? '').trim();
  const category = String(component.category ?? '').trim();
  if (!id || !/^[a-z0-9_]+$/.test(id)) {
    throw new Error('Component id must be a non-empty snake_case identifier.');
  }
  if (!name || !category) {
    throw new Error('Component requires both name and category.');
  }
  if (!component.mujoco || typeof component.mujoco !== 'object') {
    throw new Error(`Component ${id} requires a mujoco specification block.`);
  }
  const bucket = component.bucket && BUCKETS.includes(component.bucket)
    ? component.bucket
    : bucketForCategory(category);
  const entry = structuredClone({ ...component, id, name, category });
  delete entry.bucket;
  state[bucket][id] = entry;
  return { ...entry, bucket };
}

/**
 * CRUD: Removes a custom component by ID.
 */
export function removeComponent(id) {
  for (const b of BUCKETS) {
    if (state[b]?.[id]) {
      delete state[b][id];
      return true;
    }
  }
  return false;
}

/**
 * Deterministically validates an MCU pinout against hardware timers, PWM capabilities,
 * and interrupt lines (mirrors training/export_mcu.py's validate_hardware).
 *
 * @param boardId e.g. 'arduino_uno' or 'esp32_devkit_v1'
 * @param pinout  { ENA, IN1, IN2, ENB, IN3, IN4, TRIG, ECHO, SERVO }
 * @returns {{ valid: boolean, errors: string[], warnings: string[], interruptMode: string }}
 */
export function validateHardwarePinout(boardId, pinout = {}) {
  const board = state.mcus[boardId];
  const errors = [];
  const warnings = [];
  if (!board) {
    return { valid: false, errors: [`Unknown MCU board: ${boardId}`], warnings, interruptMode: 'none' };
  }

  const pwmSet = new Set(board.pwm_pins.map((p) => String(p)));
  const extIntSet = new Set((board.external_interrupt_pins ?? []).map((p) => String(p)));

  for (const pwmKey of ['ENA', 'ENB']) {
    if (pinout[pwmKey] !== undefined && pinout[pwmKey] !== null) {
      const p = String(pinout[pwmKey]);
      if (!pwmSet.has(p)) {
        errors.push(`${pwmKey} on pin ${p} is not PWM-capable on ${board.name} (valid PWM pins: ${board.pwm_pins.join(', ')}).`);
      }
    }
  }

  // Check Timer1 conflict when Servo.h is attached on ATmega328P
  if (pinout.SERVO !== undefined && pinout.SERVO !== null) {
    const timer1 = board.timers?.Timer1;
    if (timer1?.locked_by_libraries?.includes('Servo.h')) {
      const disabledPins = new Set(timer1.pins.map((p) => String(p)));
      for (const pwmKey of ['ENA', 'ENB']) {
        const p = String(pinout[pwmKey]);
        if (disabledPins.has(p)) {
          errors.push(
            `Timer1 conflict on ${board.name}: attaching SG90 Servo on D${pinout.SERVO} (<Servo.h>) disables PWM on D${timer1.pins.join('/D')}, breaking ${pwmKey} on D${p}. Move ${pwmKey} to D5 or D6 (Timer0).`,
          );
        }
      }
    }
  }

  // Check duplicate pin assignments
  const seen = new Map();
  for (const [role, rawPin] of Object.entries(pinout)) {
    if (rawPin === undefined || rawPin === null || rawPin === '') continue;
    const norm = String(rawPin).toUpperCase();
    if (seen.has(norm)) {
      errors.push(`Pin collision: ${role} and ${seen.get(norm)} are both assigned to pin ${norm}.`);
    } else {
      seen.set(norm, role);
    }
  }

  // Determine ultrasonic ECHO non-blocking interrupt strategy
  let interruptMode = 'polling';
  if (pinout.ECHO !== undefined && pinout.ECHO !== null) {
    const echoPin = String(pinout.ECHO).toUpperCase();
    if (extIntSet.has(echoPin)) {
      interruptMode = echoPin === '2' ? 'INT0_hardware_isr' : echoPin === '3' ? 'INT1_hardware_isr' : 'GPIO_hardware_isr';
    } else if (board.pcint_capable) {
      interruptMode = 'PCINT_pin_change_isr';
      warnings.push(
        `ECHO on pin ${echoPin} uses Pin-Change Interrupt (PCINT). Moving ECHO to D2 (INT0) or D3 (INT1) gives dedicated external interrupt vectors.`,
      );
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    interruptMode,
  };
}
