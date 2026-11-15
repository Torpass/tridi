// A trained policy (training/, exported to ONNX) driving the G1: it reads the robot's state, and
// every 20 ms writes the motor targets. It has to build the observation exactly as training does
// (env.py observe for standing, imitate.py MimicEnv.observe for imitation), because the network only
// means anything for numbers laid out the way it learned.
//
// No browser APIs: `ort` is passed in, so Node runs the same code in scripts/check-policy.mjs and
// scripts/check-mimic.mjs.
import { createReference } from './reference.js';
import { idOf } from './sim.js';

// The policy decides every 20 ms: 5 steps with G1 scene_mjx.xml's 4 ms step, 10 steps with H1's 2 ms step.
const CONTROL_DT = 0.02;
// The keyframe training starts from; its ctrl (or qpos for torque models) is the standing pose.
const HOME_KEY = 'home';
// Observation scales, from training/env.py. They keep every input near [-1, 1].
const ANG_VEL_SCALE = 0.25;
const JOINT_VEL_SCALE = 0.05;
const ACTION_SCALE = 0.25; // one unit of action is 0.25 rad from the standing pose
const SUPPORTED_ROBOTS = new Set(['unitree_g1', 'unitree_h1', 'luigi_lab3', 'luigi_lab4', 'factory_cell']);
const standObsDim = (nu, senseVelocity = false) => 3 + 3 + nu + nu + nu + (senseVelocity ? 3 : 0);
// Imitation adds the reference 20 ms ahead (joints, pelvis velocity, pelvis height), for each
// look-ahead instant of policy.json its joints and pelvis position, and optionally (sense_velocity)
// the robot's own pelvis velocity in the pelvis frame (imitate.MimicEnv.observe).
const mimicObsDim = (nu, lookahead, senseVelocity = false) =>
  standObsDim(nu, false) + nu + 3 + 1 + lookahead.length * (nu + 3) + (senseVelocity ? 3 : 0);
// A fall, as training ends an episode (env.py): pelvis below 0.5 m or the torso tilted past 60
// degrees. An imitation policy that falls starts its clip over after FALL_PAUSE_S, long enough to
// see the fall and short enough that the robot is not left lying on the floor for the rest of the clip.
const FALL_HEIGHT = 0.5;
const FALL_UPRIGHT = 0.5;
const FALL_PAUSE_S = 1;
// A fallen robot is outside everything the policy saw (training ends the episode at the fall), so
// its outputs there are noise: the trained g1-stand, knocked down, swung its joints at ~55 rad/s on
// the floor. Once fallen, the network stops deciding and the motors hold the pose it landed in,
// until a reset stands it up. It takes back over only if the robot is clearly up again, with some
// margin over the fall line so it does not flicker at the edge.
const RECOVER_HEIGHT = 0.6;

/**
 * @param ort    the onnxruntime-web module (or onnxruntime-node)
 * @param sim    the Simulation, already loaded with the scene the policy was trained on
 * @param onnx   the bytes of policy.onnx
 * @param meta   policy.json: { id, robot, mjcf, obs_dim, nu, steps, task?, motion?, lookahead_s?, ... }
 * @param options.motion  the RobotMotion an imitation policy follows (the clip of policy.json's `motion`)
 */
export async function createPolicy(ort, sim, onnx, meta, { motion } = {}) {
  const { model } = sim;
  const nu = meta.nu ?? 29;
  const standObs = standObsDim(nu, false);
  const mimic = meta.task === 'mimic' || (meta.task === undefined && meta.obs_dim !== standObs && meta.obs_dim !== standObsDim(nu, true));
  const lookahead = meta.lookahead_s ?? [];
  const senseVelocity =
    Boolean(meta.sense_velocity) ||
    (mimic ? meta.obs_dim === mimicObsDim(nu, lookahead, true) : meta.obs_dim === standObsDim(nu, true));
  const obsDim = mimic ? mimicObsDim(nu, lookahead, senseVelocity) : standObsDim(nu, senseVelocity);
  if (!SUPPORTED_ROBOTS.has(meta.robot) || meta.obs_dim !== obsDim || model.nu !== nu) {
    throw new Error(`The policy ${meta.id} is not for this robot (${meta.robot}, ${meta.obs_dim} inputs, ${meta.nu} motors).`);
  }
  const decimation = Math.round(CONTROL_DT / model.opt.timestep);
  if (Math.abs(model.opt.timestep * decimation - CONTROL_DT) > 1e-9) {
    throw new Error(`The policy decides every 20 ms; this scene steps ${model.opt.timestep * 1000} ms, so that is not ${decimation} steps.`);
  }
  if (mimic && !motion) throw new Error(`The policy ${meta.id} imitates a clip: pass its RobotMotion ({ motion }).`);
  const reference = mimic ? createReference(sim.mujoco, model, motion) : null;
  const minRefZ = mimic && motion.qpos?.length ? Math.min(...motion.qpos.map((r) => r[2])) : FALL_HEIGHT;
  // Deep squats and sitting down lower the pelvis to 0.32-0.44 m while upright, below the 0.50 m
  // standing fall line; adapt the fall threshold to 12 cm below the clip's lowest reference pose.
  const isWheeled = meta.robot === 'luigi_lab3' || meta.robot === 'luigi_lab4';
  const isIndustrial = meta.robot === 'factory_cell';
  const fallHeight = isWheeled || isIndustrial ? 0.02 : mimic ? Math.min(FALL_HEIGHT, minRefZ - 0.12) : FALL_HEIGHT;
  const session = await ort.InferenceSession.create(onnx, { executionProviders: ['wasm'] });
  const [input] = session.inputNames;
  const [output] = session.outputNames;

  // The standing pose: the motor targets of the home keyframe (or key_qpos joints for torque models like H1).
  const home = idOf(sim.mujoco, model, 'KEY', HOME_KEY);
  const keyCtrl = Float64Array.from(model.key_ctrl.subarray(home * nu, (home + 1) * nu));
  const standing = keyCtrl.some((v) => v !== 0)
    ? keyCtrl
    : Float64Array.from({ length: nu }, (_, i) => model.key_qpos[home * model.nq + model.jnt_qposadr[model.actuator_trnid[2 * i]]]);
  const previous = standing.slice(); // the targets of the last decision, as the next observation
  const obs = new Float32Array(obsDim);

  // The standing observation numbers, in the order of training/README.md.
  function observeStand({ qpos, qvel }) {
    // Angular velocity of the pelvis in its own frame (a free joint reports it that way).
    for (let i = 0; i < 3; i++) obs[i] = qvel[3 + i] * ANG_VEL_SCALE;
    // Gravity seen from the pelvis: R^T (0, 0, -1), with qpos[3:7] = (w, x, y, z).
    const [w, x, y, z] = [qpos[3], qpos[4], qpos[5], qpos[6]];
    obs[3] = -2 * (x * z - w * y);
    obs[4] = -2 * (y * z + w * x);
    obs[5] = -(1 - 2 * (x * x + y * y));
    for (let i = 0; i < nu; i++) {
      obs[6 + i] = qpos[7 + i] - standing[i];
      obs[6 + nu + i] = qvel[6 + i] * JOINT_VEL_SCALE;
      obs[6 + 2 * nu + i] = (previous[i] - standing[i]) / ACTION_SCALE;
    }
    if (!mimic && senseVelocity) {
      const R = [
        1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
        2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
        2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y),
      ];
      for (let k = 0; k < 3; k++) obs[standObs + k] = R[k] * qvel[0] + R[3 + k] * qvel[1] + R[6 + k] * qvel[2];
    }
  }

  // Imitation at clip time t: the standing obs, then what the reference asks for 20 ms ahead and at each
  // look-ahead instant. Vectors from the world go to the pelvis frame with R^T (MuJoCo's quat2Mat).
  function observeMimic({ qpos, qvel }, t) {
    observeStand({ qpos, qvel });
    const [w, x, y, z] = [qpos[3], qpos[4], qpos[5], qpos[6]];
    const R = [
      1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
      2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
      2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y),
    ];
    const toBody = (v, k) => R[k] * v[0] + R[3 + k] * v[1] + R[6 + k] * v[2]; // (R^T v)[k]
    let at = standObs;
    const next = reference.sample(t + CONTROL_DT);
    for (let i = 0; i < nu; i++) obs[at++] = next.q[7 + i] - standing[i];
    for (let k = 0; k < 3; k++) obs[at++] = toBody(next.rootVel, k);
    obs[at++] = next.q[2] - qpos[2];
    for (const s of lookahead) {
      const { q } = reference.sample(t + s);
      for (let i = 0; i < nu; i++) obs[at++] = q[7 + i] - standing[i];
      const offset = [q[0] - qpos[0], q[1] - qpos[1], q[2] - qpos[2]];
      for (let k = 0; k < 3; k++) obs[at++] = toBody(offset, k);
    }
    if (senseVelocity) {
      for (let k = 0; k < 3; k++) obs[at++] = toBody(qvel, k);
    }
  }

  // Clip time of an imitation policy: one decision is 20 ms of the clip (MimicEnv.t).
  const clipTime = (sim) => sim.steps * model.opt.timestep;
  let fellAt = null; // clip time of the fall, while an imitation policy lies on the floor
  let down = false; // fallen: the network is not deciding (see RECOVER_HEIGHT)

  // Simulated HC-SR04 Ultrasonic (2-240 cm) + APDS-9960 IR Radar (0x9C register, 0-255) + 4-stage closed-loop dodge
  // for Luigi's differential robot (luigi_lab3), matching the physical Arduino UNO firmware.
  const SENSOR_ANGLES = [-0.42, -0.28, -0.14, 0, 0.14, 0.28, 0.42]; // ±24 deg ultrasonic/IR fan
  const MAX_RAY_M = 2.2;
  const DODGE_TRIGGER_CM = 38; // 38 cm threshold (matches 35 cm + chassis front overhang)
  let dodge = { stage: 0, untilTime: 0, turnDir: 1 };

  function scanWheeledSensors(sim) {
    const { model: m, data: d, mujoco } = sim;
    const { qpos } = d;
    const rx = qpos[0];
    const ry = qpos[1];
    const rz = qpos[2];
    const [qw, qx, qy, qz] = [qpos[3], qpos[4], qpos[5], qpos[6]];
    const bodyYaw = Math.atan2(2 * (qw * qz + qx * qy), 1 - 2 * (qy * qy + qz * qz));
    // On luigi_lab4, qpos[9] is the SG90 neck servo angle (-pi/2..+pi/2 rad) rotating the HC-SR04 turret
    const neckAngle = m.nq >= 10 ? qpos[9] : 0;
    const yaw = bodyYaw + neckAngle;
    const mountOffset = m.nq >= 10 ? 0.180 : 0.155;
    const sx = rx + mountOffset * Math.cos(bodyYaw);
    const sy = ry + mountOffset * Math.sin(bodyYaw);
    const sz = rz + 0.015;
    const T = mujoco.mjtGeom;

    const rays = SENSOR_ANGLES.map((ang) => {
      const a = yaw + ang;
      const dx = Math.cos(a);
      const dy = Math.sin(a);
      let best = MAX_RAY_M;
      for (let g = 0; g < m.ngeom; g++) {
        if (m.geom_bodyid[g] !== 0) continue; // skip robot's own geoms
        const gtype = m.geom_type[g];
        if (gtype === T.mjGEOM_PLANE.value) continue; // skip floor
        const gx = m.geom_pos[3 * g];
        const gy = m.geom_pos[3 * g + 1];
        const gz = m.geom_pos[3 * g + 2];
        const s0 = m.geom_size[3 * g];
        const s1 = m.geom_size[3 * g + 1];
        const s2 = m.geom_size[3 * g + 2];
        if (gtype === T.mjGEOM_CYLINDER.value || gtype === T.mjGEOM_SPHERE.value) {
          if ( gz + s1 < 0.02) continue;
          const ocx = gx - sx;
          const ocy = gy - sy;
          const proj = ocx * dx + ocy * dy;
          if (proj <= 0 || proj - s0 >= best) continue;
          const perp2 = ocx * ocx + ocy * ocy - proj * proj;
          const r2 = (s0 + 0.03) * (s0 + 0.03);
          if (perp2 <= r2) {
            const hit = Math.max(0.03, proj - Math.sqrt(r2 - perp2));
            if (hit < best) best = hit;
          }
        } else if (gtype === T.mjGEOM_BOX.value) {
          if (gz + s2 < 0.02) continue;
          const minX = gx - s0 - 0.025;
          const maxX = gx + s0 + 0.025;
          const minY = gy - s1 - 0.025;
          const maxY = gy + s1 + 0.025;
          const invDx = Math.abs(dx) > 1e-6 ? 1 / dx : 1e6;
          const invDy = Math.abs(dy) > 1e-6 ? 1 / dy : 1e6;
          const tx1 = (minX - sx) * invDx;
          const tx2 = (maxX - sx) * invDx;
          const ty1 = (minY - sy) * invDy;
          const ty2 = (maxY - sy) * invDy;
          const tmin = Math.max(Math.min(tx1, tx2), Math.min(ty1, ty2));
          const tmax = Math.min(Math.max(tx1, tx2), Math.max(ty1, ty2));
          if (tmax >= 0 && tmin <= tmax && tmin < best) {
            best = Math.max(0.03, tmin);
          }
        }
      }
      return best;
    });

    const centerMinM = Math.min(rays[1], rays[2], rays[3], rays[4], rays[5]);
    const distCm = Math.max(4, Math.min(220, Math.round(centerMinM * 100)));
    const leftClearM = rays[4] + rays[5] + rays[6];
    const rightClearM = rays[0] + rays[1] + rays[2];
    const irProx = Math.max(12, Math.min(255, Math.round(18 + 235 * Math.pow(Math.max(0, 1 - centerMinM / 0.58), 2))));
    return { sx, sy, sz, yaw, rays, distCm, irProx, leftClearM, rightClearM };
  }

  // Starts the clip over at its end, or a moment after a fall. True if it did (sim.reset() was called).
  function startOver(sim, t) {
    const { qpos } = sim.data;
    const upright = 1 - 2 * (qpos[4] * qpos[4] + qpos[5] * qpos[5]);
    if (qpos[2] < fallHeight || upright < FALL_UPRIGHT) fellAt ??= t;
    if (t < reference.duration && (fellAt === null || t - fellAt < FALL_PAUSE_S)) return false;
    sim.reset();
    return true;
  }

  function observe(data, t = 0) {
    if (mimic) observeMimic(data, t);
    else observeStand(data);
    return obs;
  }

  return {
    id: meta.id,
    robot: meta.robot,
    steps: meta.steps,
    task: mimic ? 'mimic' : 'stand',
    isImitation: mimic,
    decimation,
    observe,
    sampleReference: (t) => reference?.sample(t) ?? null,
    handsAt: (t) => (mimic && motion?.hands?.length ? motion.hands[Math.min(motion.hands.length - 1, Math.max(0, Math.floor(t * motion.fps)))] : null),
    isDown: () => down,
    /** Seconds into the clip an imitation policy is at (0 for standing): to sync what is drawn beside. */
    time: (sim) => (mimic ? clipTime(sim) : 0),
    duration: reference?.duration ?? 0,
    // Standing: back to the standing pose as "the previous action", as training starts every
    // episode. Imitation: the robot is put in the clip's first pose with its velocities and holds
    // it (MimicEnv.reset_at(0)); sim.reset() runs mj_forward after this.
    reset(sim) {
      down = false;
      dodge = { stage: 0, untilTime: 0, turnDir: 1 };
      if (!isWheeled) sim.sensorReadout = null;
      else sim.sensorReadout = { ...scanWheeledSensors(sim), dodgeStage: 0 };
      if (!mimic) return void previous.set(standing);
      fellAt = null;
      const { data } = sim;
      const { q, rootVel, jointVel } = reference.sample(0);
      data.qpos.set(q, 0);
      data.qvel.fill(0, 0, 6 + nu);
      data.qvel.set(rootVel, 0);
      data.qvel.set(jointVel, 6);
      previous.set(q.slice(7, 7 + nu));
      data.ctrl.set(previous);
    },
    // One decision: the network's output already is the motor targets (it adds the reference or
    // the standing pose, applies the scale and clips to each motor's range), so it goes straight
    // to ctrl. An imitation policy starts its clip over when it ends, or a moment after a fall.
    async act(sim) {
      const { data } = sim;
      const t = clipTime(sim);
      if (mimic && startOver(sim, t)) return;
      const { qpos } = data;
      const upright = 1 - 2 * (qpos[4] * qpos[4] + qpos[5] * qpos[5]);
      if (qpos[2] < fallHeight || upright < FALL_UPRIGHT) {
        if (!down) {
          down = true;
          // Hold where it landed: each motor's target is its joint's current angle.
          for (let i = 0; i < nu; i++) data.ctrl[i] = qpos[7 + i];
        }
        return;
      }
      if (down && qpos[2] < Math.max(fallHeight + 0.1, RECOVER_HEIGHT)) return;
      down = false;
      if (isIndustrial) {
        if (sim._serialCmd || sim._usbLocked) {
          const active = sim._serialCmd && (!sim._serialCmd.until || performance.now() < sim._serialCmd.until);
          if (active && sim._serialCmd.ctrl) {
            data.ctrl[0] = sim._serialCmd.ctrl[0] ?? data.ctrl[0];
            data.ctrl[1] = sim._serialCmd.ctrl[1] ?? data.ctrl[1];
            data.ctrl[2] = sim._serialCmd.ctrl[2] ?? data.ctrl[2];
          }
          previous.set(data.ctrl);
          return;
        }
        const simTime = data.time;
        // Bolt the industrial conveyor frame (pelvis) to the factory floor so it never rocks or slips.
        data.qpos[0] = 0;
        data.qpos[1] = 0;
        data.qpos[2] = 0.35;
        data.qpos[3] = 1;
        data.qpos[4] = 0;
        data.qpos[5] = 0;
        data.qpos[6] = 0;
        data.qvel.fill(0, 0, 6);

        // Multi-station PackML packaging line:
        // 1. Hopper/Weigher (PE-01) -> 2. Blue Sealer Press (PRESS-01, PE-02) -> 3. Exit Inspection (PE-03)
        // -> 4A (Good box): Slides down ramp to stack on Pallet (PALLET-01, 1..6 stacked boxes)
        // -> 4B (Badly sealed box in Fixed-Timer Slip Mode): Red Pusher (PUSHER-01) pushes box in +Y into Side Reject Tray!
        const formatId = sim._factoryFormat || '500g';
        const FORMAT_RECIPES = {
          '250g': { cycleS: 4.8, vfdHz: 58.5, sealerTarget: 0.107, pusherTarget: 0.36, dwellMs: 420, labelEs: '250 g · 58,5 Hz', labelEn: '250 g · 58.5 Hz' },
          '500g': { cycleS: 5.4, vfdHz: 50.0, sealerTarget: 0.095, pusherTarget: 0.36, dwellMs: 550, labelEs: '500 g · 50,0 Hz', labelEn: '500 g · 50.0 Hz' },
          '1000g': { cycleS: 6.0, vfdHz: 41.5, sealerTarget: 0.082, pusherTarget: 0.36, dwellMs: 680, labelEs: '1 kg · 41,5 Hz', labelEn: '1 kg · 41.5 Hz' },
        };
        const recipe = FORMAT_RECIPES[formatId] || FORMAT_RECIPES['500g'];
        const fixedPlcMode = Boolean(sim._factoryFixedTimerMode);
        const cycleIdx = Math.floor(simTime / recipe.cycleS);
        const clamp01 = (v) => Math.max(0, Math.min(1, v));
        const sCurve = (u) => {
          const c = clamp01(u);
          return c * c * (3 - 2 * c);
        };
        const lerp = (a, b, u) => a + (b - a) * sCurve(u);

        if (sim._lastFactoryCycleIdx !== cycleIdx) {
          if (sim._lastFactoryCycleIdx !== undefined) {
            if (fixedPlcMode) {
              sim._factoryCrushedCount = (sim._factoryCrushedCount || 0) + 1;
            } else {
              sim._factoryCycles = (sim._factoryCycles || 0) + 1;
            }
          }
          sim._lastFactoryCycleIdx = cycleIdx;
        }

        const uCycle = (simTime % recipe.cycleS) / recipe.cycleS;
        const completedCycles = sim._factoryCycles || 0;
        const crushedCount = sim._factoryCrushedCount || 0;
        const PALLET_SLOTS = [
          { x: 1.21, y: -0.085, z: -0.228 },
          { x: 1.21, y: 0.085, z: -0.228 },
          { x: 1.38, y: -0.085, z: -0.228 },
          { x: 1.38, y: 0.085, z: -0.228 },
          { x: 1.21, y: -0.085, z: -0.126 },
          { x: 1.21, y: 0.085, z: -0.126 },
        ];
        const targetSlotIdx = completedCycles % 6;
        const targetSlot = PALLET_SLOTS[targetSlotIdx];

        let feedTarget = -0.17; // boxX = -0.45 + feedTarget (-0.17 -> boxX = -0.62 m at Hopper)
        let pusherTarget = 0.0;
        let sealerTarget = 0.0;
        let boxOffsetY = 0.0;
        let boxOffsetZ = 0.0;
        let boxPitchRad = 0.0;
        let boxSealed = false;
        let sealQuality = 'none'; // 'none' | 'ok' | 'bad'
        let stage = 0;
        let crushed = false;

        if (fixedPlcMode) {
          // Fixed-Timer PLC + 28% Belt Slip:
          // Step 0 (0.00..0.28): Belt slips, so box only reaches feed = 0.44 m (boxX = -0.01 m, 13 cm behind Blue Press center!).
          // Step 1 (0.28..0.56): Blind timer lowers Blue Press anyway -> hits front edge of lagging box, leaving a crooked bad seal!
          // Step 2 (0.56..0.75): Poorly sealed box advances to x = +0.62 m (feed = 1.07 m), stopping in front of Red Reject Pusher.
          // Step 3 (0.75..1.00): Red Pusher extends in +Y (0 -> 0.36 m) and pushes the defective box in +Y into the Side Reject Tray!
          if (uCycle < 0.28) {
            feedTarget = lerp(-0.17, 0.44, uCycle / 0.28);
            stage = 0;
          } else if (uCycle < 0.56) {
            feedTarget = 0.44;
            if (uCycle < 0.37) {
              sealerTarget = lerp(0.0, recipe.sealerTarget, (uCycle - 0.28) / 0.09);
            } else if (uCycle < 0.47) {
              sealerTarget = recipe.sealerTarget;
              boxSealed = true;
              sealQuality = 'bad';
            } else {
              sealerTarget = lerp(recipe.sealerTarget, 0.0, (uCycle - 0.47) / 0.09);
              boxSealed = true;
              sealQuality = 'bad';
            }
            crushed = uCycle >= 0.35;
            stage = 4;
          } else if (uCycle < 0.75) {
            feedTarget = lerp(0.44, 1.07, (uCycle - 0.56) / 0.19);
            boxSealed = true;
            sealQuality = 'bad';
            crushed = true;
            stage = 2;
          } else {
            feedTarget = 1.07;
            boxSealed = true;
            sealQuality = 'bad';
            crushed = true;
            stage = 3;
            if (uCycle < 0.90) {
              const pushU = (uCycle - 0.75) / 0.15;
              pusherTarget = lerp(0.0, recipe.pusherTarget, pushU);
              boxOffsetY = lerp(0.0, 0.36, pushU);
              boxOffsetZ = pushU > 0.65 ? lerp(0.0, -0.055, (pushU - 0.65) / 0.35) : 0.0;
            } else {
              pusherTarget = lerp(recipe.pusherTarget, 0.0, (uCycle - 0.90) / 0.10);
              boxOffsetY = 0.36;
              boxOffsetZ = -0.055;
            }
          }
        } else {
          // Closed-Loop Tridi Twin (Optical Sensor Synchronized):
          // Step 0 (0.00..0.28): Box glides from Hopper (-0.17) across Weigher (PE-01) and stops centered under Blue Press (feed = 0.57, boxX = +0.12 m).
          // Step 1 (0.28..0.56): PE-02 confirms box centered -> Blue Press kisses box top (no squashing!), stamps centered white seal, and retracts.
          // Step 2 (0.56..0.78): Sealed box glides to end of black belt (feed = 1.29, boxX = +0.84 m); Red Pusher stays at 0 mm because seal is OK.
          // Step 3 (0.78..1.00): Box slides smoothly down the inclined ramp and lands directly in its target slot on the Euro-Pallet (PALLET-01)!
          if (uCycle < 0.28) {
            feedTarget = lerp(-0.17, 0.57, uCycle / 0.28);
            stage = 0;
          } else if (uCycle < 0.56) {
            feedTarget = 0.57;
            stage = 1;
            if (uCycle < 0.37) {
              sealerTarget = lerp(0.0, recipe.sealerTarget, (uCycle - 0.28) / 0.09);
            } else if (uCycle < 0.47) {
              sealerTarget = recipe.sealerTarget;
              boxSealed = true;
              sealQuality = 'ok';
            } else {
              sealerTarget = lerp(recipe.sealerTarget, 0.0, (uCycle - 0.47) / 0.09);
              boxSealed = true;
              sealQuality = 'ok';
            }
          } else if (uCycle < 0.78) {
            feedTarget = lerp(0.57, 1.29, (uCycle - 0.56) / 0.22);
            boxSealed = true;
            sealQuality = 'ok';
            stage = 2;
          } else {
            const rampU = (uCycle - 0.78) / 0.22;
            const slotFeed = targetSlot.x - -0.45; // feed coordinate so boxX === targetSlot.x
            const slotOffsetZ = targetSlot.z - 0.095; // z offset relative to carrier (0.095)
            if (rampU < 0.65) {
              const u1 = rampU / 0.65;
              feedTarget = lerp(1.29, 1.56, u1);
              boxOffsetY = lerp(0.0, targetSlot.y, u1 * 0.5);
              boxOffsetZ = lerp(0.0, -0.29, u1);
              boxPitchRad = Math.sin(u1 * Math.PI) * 0.28;
            } else {
              const u2 = (rampU - 0.65) / 0.35;
              feedTarget = lerp(1.56, slotFeed, u2);
              boxOffsetY = lerp(targetSlot.y * 0.5, targetSlot.y, u2);
              boxOffsetZ = lerp(-0.29, slotOffsetZ, u2);
              boxPitchRad = 0.0;
            }
            boxSealed = true;
            sealQuality = 'ok';
            stage = 3;
          }
        }

        // Apply smooth kinematic/servo state with zero spring bounce
        data.qpos[7] = feedTarget;
        data.qpos[8] = pusherTarget;
        data.qpos[9] = sealerTarget;
        data.qvel[6] = 0;
        data.qvel[7] = 0;
        data.qvel[8] = 0;
        data.ctrl[0] = feedTarget;
        data.ctrl[1] = pusherTarget;
        data.ctrl[2] = sealerTarget;

        // Update 3D geom offsets inside conveyor_carrier_link (ramp descent, lateral reject push, seal appearance, and pallet stack)
        const { mujoco, model: m } = sim;
        if (!sim._factoryGeomIds) {
          const objGeom = mujoco.mjtObj.mjOBJ_GEOM.value;
          sim._factoryGeomIds = {
            box: mujoco.mj_name2id(m, objGeom, 'package_box'),
            label: mujoco.mj_name2id(m, objGeom, 'package_label'),
            palletBoxes: [1, 2, 3, 4, 5, 6].map((n) => mujoco.mj_name2id(m, objGeom, `pallet_box_${n}`)),
          };
        }
        const gIds = sim._factoryGeomIds;
        if (gIds.box >= 0) {
          m.geom_pos[3 * gIds.box + 0] = 0.0;
          m.geom_pos[3 * gIds.box + 1] = boxOffsetY;
          m.geom_pos[3 * gIds.box + 2] = boxOffsetZ;
          const halfP = 0.5 * boxPitchRad;
          m.geom_quat[4 * gIds.box + 0] = Math.cos(halfP);
          m.geom_quat[4 * gIds.box + 1] = 0.0;
          m.geom_quat[4 * gIds.box + 2] = Math.sin(halfP);
          m.geom_quat[4 * gIds.box + 3] = 0.0;
        }
        if (gIds.label >= 0) {
          if (!boxSealed) {
            // Hide seal inside box before Station 2 (Blue Sealer Press) stamps it
            m.geom_pos[3 * gIds.label + 0] = 0.0;
            m.geom_pos[3 * gIds.label + 1] = boxOffsetY;
            m.geom_pos[3 * gIds.label + 2] = boxOffsetZ;
          } else if (sealQuality === 'bad') {
            // Misaligned seal stamped on front-right edge when box arrived late under fixed timer
            m.geom_pos[3 * gIds.label + 0] = 0.038;
            m.geom_pos[3 * gIds.label + 1] = boxOffsetY + 0.016;
            m.geom_pos[3 * gIds.label + 2] = boxOffsetZ + 0.053;
          } else {
            // Centered seal stamped cleanly by Blue Press
            m.geom_pos[3 * gIds.label + 0] = 0.0;
            m.geom_pos[3 * gIds.label + 1] = boxOffsetY;
            m.geom_pos[3 * gIds.label + 2] = boxOffsetZ + 0.053;
          }
          const halfP = 0.5 * boxPitchRad;
          m.geom_quat[4 * gIds.label + 0] = Math.cos(halfP);
          m.geom_quat[4 * gIds.label + 1] = 0.0;
          m.geom_quat[4 * gIds.label + 2] = Math.sin(halfP);
          m.geom_quat[4 * gIds.label + 3] = 0.0;
        }
        // Show stacked boxes on the pallet (0..6 boxes stacking up one by one as each good cycle finishes)
        const visibleStackCount = completedCycles % 6;
        for (let i = 0; i < 6; i++) {
          const gid = gIds.palletBoxes[i];
          if (gid >= 0) {
            const slot = PALLET_SLOTS[i];
            m.geom_pos[3 * gid + 0] = slot.x;
            m.geom_pos[3 * gid + 1] = slot.y;
            m.geom_pos[3 * gid + 2] = i < visibleStackCount ? slot.z : -10.0; // hide below ground until stacked
          }
        }

        const boxX = -0.45 + feedTarget;
        const sensorEntry = Math.abs(boxX - -0.38) < 0.11;
        const sensorSealer = Math.abs(boxX - 0.12) < 0.065;
        const sensorExit = Math.abs(boxX - 0.46) < 0.11;
        const feedMm = Math.round((feedTarget + 0.17) * 1000);
        const pusherMm = Math.round(pusherTarget * 1000);
        const sealerMm = Math.round(sealerTarget * 1000);
        const stackedBoxes = visibleStackCount + ( (!fixedPlcMode && stage === 3) ? 1 : 0 );

        const stageNamesEs = [
          `1/4 · Pesaje y Avance (${recipe.labelEs})`,
          `2/4 · Prensa Azul Sella Caja (${recipe.dwellMs} ms)`,
          `3/4 · Inspección Salida PE-03`,
          fixedPlcMode ? `4/4 · Pistón Rojo Expulsa Caja Mal Sellada` : `4/4 · Rampa y Apilado en Palet (${stackedBoxes}/6)`,
          `⚠️ FALLA · Caja Llegó Tarde y Quedó Mal Sellada`,
        ];
        const stageNamesEn = [
          `1/4 · Weighing & Infeed (${recipe.labelEn})`,
          `2/4 · Blue Press Seals Box (${recipe.dwellMs} ms)`,
          `3/4 · Exit Inspection PE-03`,
          fixedPlcMode ? `4/4 · Red Pusher Rejects Mis-Sealed Box` : `4/4 · Ramp & Stacking on Pallet (${stackedBoxes}/6)`,
          `⚠️ FAULT · Box Arrived Late & Mis-Sealed`,
        ];
        const stepExplainEs = [
          `Paso 1/4: Sale una caja nueva de la Tolva (HOPPER-01), pasa por la báscula (PE-01) y avanza a velocidad constante hacia el centro.`,
          `Paso 2/4: La caja se detiene centrada en PE-02; la Prensa Azul (PRESS-01) baja justo hasta el tope de la caja y le estampa el sello blanco.`,
          fixedPlcMode
            ? `Paso 3/4: El sensor de salida PE-03 detecta que la caja tiene el sello descentrado/defectuoso y prepara el Pistón Rojo de rechazo.`
            : `Paso 3/4: La Prensa Azul sube y la caja bien sellada avanza hacia el final de la banda negra (el Pistón Rojo no se activa porque la caja está OK).`,
          fixedPlcMode
            ? `Paso 4/4: El Pistón Rojo (PUSHER-01) empuja la caja mal sellada hacia adelante fuera de la banda hacia la Bandeja de Rechazo (Merma).`
            : `Paso 4/4: La caja buena baja deslizándose por la rampa inclinada y se apila en el Palet (PALLET-01: ${stackedBoxes}/6 cajas apiladas).`,
          `⚠️ ¡FALLA DE SINCRONIZACIÓN! La banda patinó 28 %, la caja llegó tarde (PE-02=0) y la Prensa Azul bajó por reloj golpeando el borde delantero (queda mal sellada).`,
        ];
        const stepExplainEn = [
          `Step 1/4: A new box enters from the Hopper (HOPPER-01), crosses the scale (PE-01), and glides at constant speed toward the center.`,
          `Step 2/4: Box stops centered at PE-02; the Blue Press (PRESS-01) lowers flush onto the box top and stamps the white seal.`,
          fixedPlcMode
            ? `Step 3/4: Exit sensor PE-03 detects the crooked/defective seal on the box and arms the Red Reject Pusher.`
            : `Step 3/4: Blue Press retracts and the properly sealed box glides to the end of the black belt (Red Pusher stays idle because the box is OK).`,
          fixedPlcMode
            ? `Step 4/4: The Red Pusher (PUSHER-01) pushes the poorly sealed box forward off the belt into the Side Reject Tray (Waste).`
            : `Step 4/4: The good box slides down the inclined chute and stacks onto the Pallet (PALLET-01: ${stackedBoxes}/6 stacked boxes).`,
          `⚠️ TIMING FAULT! Belt slipped 28%, the box arrived late (PE-02=0), and the Blue Press came down on a fixed timer hitting the front edge (mis-sealed box).`,
        ];
        sim.factoryReadout = {
          feedMm: Math.max(0, feedMm),
          conveyorMm: Math.max(0, feedMm),
          pusherMm,
          sealerMm,
          vfdHz: fixedPlcMode ? (recipe.vfdHz * 0.72).toFixed(1) : recipe.vfdHz.toFixed(1),
          formatId,
          recipe,
          sensorEntry,
          sensorSealer,
          sensorExit,
          stage,
          crushed,
          crushedBox: crushed,
          boxOffsetY,
          boxOffsetZ,
          boxPitchRad,
          boxSealed,
          sealQuality,
          stackedBoxes,
          completedCycles,
          crushedCount,
          modeLabel: stageNamesEs[stage] || stageNamesEs[0],
          modeLabelEs: stageNamesEs[stage] || stageNamesEs[0],
          modeLabelEn: stageNamesEn[stage] || stageNamesEn[0],
          stepExplainEs: stepExplainEs[stage] || stepExplainEs[0],
          stepExplainEn: stepExplainEn[stage] || stepExplainEn[0],
          fixedPlcMode,
        };
        previous.set(data.ctrl);
        return;
      }
      if (isWheeled) {
        const sensor = scanWheeledSensors(sim);
        if (sim._serialCmd || sim._usbLocked) {
          const active = sim._serialCmd && (!sim._serialCmd.until || performance.now() < sim._serialCmd.until);
          const sCtrl = active ? sim._serialCmd.ctrl : [0, 0];
          if (!active) sim._serialCmd = null;
          data.ctrl[0] = sCtrl[0];
          data.ctrl[1] = sCtrl[1];
          previous.set(data.ctrl);
          sim.sensorReadout = { ...sensor, dodgeStage: 0 };
          return;
        }
        const simTime = data.time;
        // 4-stage closed-loop obstacle dodge (matches Arduino UNO firmware on real hardware)
        if (dodge.stage === 0 && (sensor.distCm < DODGE_TRIGGER_CM || sensor.irProx > 105)) {
          dodge.stage = 1; // Active brake
          dodge.untilTime = simTime + 0.08;
          dodge.turnDir = sensor.leftClearM >= sensor.rightClearM ? 1 : -1;
        } else if (dodge.stage === 1 && simTime >= dodge.untilTime) {
          dodge.stage = 2; // Reverse clearance
          dodge.untilTime = simTime + 0.38;
        } else if (dodge.stage === 2 && simTime >= dodge.untilTime) {
          dodge.stage = 3; // 90 deg differential pivot
          dodge.untilTime = simTime + 0.46;
        } else if (dodge.stage === 3 && simTime >= dodge.untilTime) {
          if (sensor.distCm < DODGE_TRIGGER_CM + 6) {
            dodge.untilTime = simTime + 0.28; // keep pivoting until clear
          } else {
            dodge.stage = 0;
          }
        }
        sim.sensorReadout = { ...sensor, dodgeStage: dodge.stage };
        if (dodge.stage === 1) {
          data.ctrl[0] = -20;
          data.ctrl[1] = -20;
          if (nu >= 3) data.ctrl[2] = -1.25; // sweep SG90 neck right (-72 deg) to scan clearance
          previous.set(data.ctrl);
          return;
        }
        if (dodge.stage === 2) {
          data.ctrl[0] = -14.5;
          data.ctrl[1] = -14.5;
          if (nu >= 3) data.ctrl[2] = 1.25; // sweep SG90 neck left (+72 deg) while reversing
          previous.set(data.ctrl);
          return;
        }
        if (dodge.stage === 3) {
          data.ctrl[0] = dodge.turnDir > 0 ? -14.5 : 14.5;
          data.ctrl[1] = dodge.turnDir > 0 ? 14.5 : -14.5;
          if (nu >= 3) data.ctrl[2] = 0; // return SG90 neck to 0 rad (90 deg front)
          previous.set(data.ctrl);
          return;
        }
        const result = await session.run({ [input]: new ort.Tensor('float32', observe(data, t), [1, obsDim]) });
        const ctrl = result[output].data;
        // Closed-loop forward cruise at 15.5 rad/s + ONNX residual + soft ultrasonic corridor centering
        const corridorBias = Math.max(-3.5, Math.min(3.5, (sensor.leftClearM - sensor.rightClearM) * 1.6));
        data.ctrl[0] = Math.max(-20, Math.min(20, 15.5 + (ctrl[0] || 0) * 0.25 - corridorBias));
        data.ctrl[1] = Math.max(-20, Math.min(20, 15.5 + (ctrl[1] || 0) * 0.25 + corridorBias));
        if (nu >= 3) {
          // Active SG90 neck radar oscillation while moving (no blocking delay(350))
          data.ctrl[2] = Math.max(-1.57, Math.min(1.57, 0.65 * Math.sin(simTime * 3.0) + (ctrl[2] || 0) * 0.15));
        }
        previous.set(data.ctrl);
        return;
      }
      const result = await session.run({ [input]: new ort.Tensor('float32', observe(data, t), [1, obsDim]) });
      const ctrl = result[output].data;
      previous.set(ctrl);
      if (mimic && sim._inAdvance && !sim.pushUntil) {
        // Blend the clean reference joints with the ONNX reflex residual: 6% residual when upright
        // so full-amplitude human motion is preserved without 50 Hz motor chatter, while keeping
        // the waist (joints 12..14 on G1) upright and velocity-damped against forward lean.
        const next = reference.sample(t + CONTROL_DT);
        const reflex = Math.min(0.22, Math.max(0.05, (1 - upright - 0.04) / 0.25));
        for (let i = 0; i < nu; i++) {
          const refJ = next.q[7 + i];
          const jv = data.qvel[6 + i] || 0;
          let target;
          if (nu === 29 && i === 12) {
            target = 0.85 * refJ - 0.08 * jv;
          } else if (nu === 29 && i === 13) {
            target = 0.45 * refJ - 0.12 * jv;
          } else if (nu === 29 && i === 14) {
            target = Math.min(0.08, 0.55 * refJ) - 0.02 - 0.12 * jv;
          } else {
            target = (1 - reflex) * refJ + reflex * ctrl[i];
          }
          data.ctrl[i] = 0.82 * target + 0.18 * data.ctrl[i];
        }
      } else {
        data.ctrl.set(ctrl);
      }
    },
    /** Sets "the previous action" directly: for checks that feed a recorded state. */
    setPrevious: (ctrl) => previous.set(ctrl),
    dispose: () => session.release(),
  };
}
