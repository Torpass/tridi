// One robot scene in MuJoCo: loads the MJCF from in-memory files, holds a keyframe pose
// with the robot's position actuators, and steps the physics in step with the wall clock.
// No browser APIs here, so the same code runs in the page and in Node (scripts/check.mjs).

// Longest wall-clock gap simulated in one call (two frames at 60 fps). After a hidden tab
// or a slow frame, catching up further would freeze the page; the robot just runs slower.
const MAX_CATCHUP_S = 1 / 30;

// The shove from the "push" button: 250 N for 0.1 s on the torso (25 N·s). On the 33 kg G1
// that is about 0.75 m/s, enough to tip it over when it only holds a stiff pose and has no
// balance controller yet. A policy that can catch itself is the goal of training.
const PUSH_BODY = 'torso_link';
const PUSH_NEWTONS = 250;
const PUSH_SECONDS = 0.1;

// PD servo gains for torque-motor models (Unitree H1, robots/h1.json), matched by joint name.
const H1_PD_GAINS = [
  { match: 'hip', kp: 150, kd: 2 },
  { match: 'knee', kp: 200, kd: 4 },
  { match: 'ankle', kp: 40, kd: 2 },
  { match: 'torso', kp: 300, kd: 6 },
  { match: 'shoulder', kp: 150, kd: 2 },
  { match: 'elbow', kp: 100, kd: 2 },
];

// Physical hand grasping constants: normal squeeze force F_N = 18 N; dry rubber/ceramic friction
// mu = 0.85 gives F_max = 15.3 N (> 3.5 N cup weight, holds firmly); soapy/wet surface mu = 0.12
// gives F_max = 2.16 N (< 3.43 N weight of the 0.35 kg cup, so a wet object slips downward under
// gravity and detaches once it slides > 12 cm from the palm).
const GRASP_NORMAL_N = 18;
const GRASP_FRICTION_DRY = 0.85;
const GRASP_FRICTION_WET = 0.12;
const GRASP_KP = 180; // N/m spring stiffness at the palm contact
const GRASP_KD = 14; // N·s/m damping at the palm contact
const GRASP_SLIP_DETACH_M = 0.12; // m: beyond 12 cm from palm center, fingers lose contact
const GRAVITY_MPS2 = 9.81;

function configureTorqueServos(mujoco, model) {
  for (let a = 0; a < model.nu; a++) {
    if (model.actuator_biastype[a] !== 0) continue; // already an affine PD servo (G1)
    const jntId = model.actuator_trnid[2 * a];
    const name = mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_JOINT.value, jntId) ?? '';
    const gain = H1_PD_GAINS.find((g) => name.includes(g.match));
    if (!gain) continue;
    const fMin = model.actuator_ctrlrange[2 * a];
    const fMax = model.actuator_ctrlrange[2 * a + 1];
    model.actuator_gaintype[a] = 0; // mjGAIN_FIXED
    model.actuator_biastype[a] = 1; // mjBIAS_AFFINE
    model.actuator_gainprm[10 * a] = gain.kp;
    model.actuator_biasprm[10 * a] = 0;
    model.actuator_biasprm[10 * a + 1] = -gain.kp;
    model.actuator_biasprm[10 * a + 2] = -gain.kd;
    model.actuator_forcelimited[a] = 1;
    model.actuator_forcerange[2 * a] = fMin;
    model.actuator_forcerange[2 * a + 1] = fMax;
    model.actuator_ctrlrange[2 * a] = model.jnt_range[2 * jntId];
    model.actuator_ctrlrange[2 * a + 1] = model.jnt_range[2 * jntId + 1];
    model.actuator_ctrllimited[a] = 1;
    model.jnt_actfrcrange[2 * jntId] = fMin;
    model.jnt_actfrcrange[2 * jntId + 1] = fMax;
  }
}

// Id of a named MuJoCo object; `type` is the suffix of its mjOBJ_ constant (BODY, JOINT, KEY...).
export function idOf(mujoco, model, type, name) {
  const id = mujoco.mj_name2id(model, mujoco.mjtObj[`mjOBJ_${type}`].value, name);
  if (id < 0) throw new Error(`MuJoCo ${type.toLowerCase()} "${name}" not found`);
  return id;
}

// Each createModel() compiles from its own folder in the WASM file system, so two never share one.
let loadCount = 0;

function removeTree(fs, path) {
  if (!fs.analyzePath(path).exists) return;
  for (const name of fs.readdir(path)) {
    if (name === '.' || name === '..') continue;
    const child = `${path}/${name}`;
    if (fs.isDir(fs.stat(child).mode)) removeTree(fs, child);
    else fs.unlink(child);
  }
  fs.rmdir(path);
}

// The model values a world scales (applyWorld), copied once per load.
function snapshot(model) {
  const column = (field, stride, at) => Float64Array.from({ length: model.nu }, (_, a) => model[field][stride * a + at]);
  return {
    bodyMass: Float64Array.from(model.body_mass),
    bodyInertia: Float64Array.from(model.body_inertia),
    gain: column('actuator_gainprm', 10, 0), // kp
    biasKp: column('actuator_biasprm', 10, 1), // -kp
    biasKv: column('actuator_biasprm', 10, 2), // -kv
    torqueLimit: Float64Array.from(model.jnt_actfrcrange),
  };
}

export class Simulation {
  /**
   * @param mujoco  module returned by the @mujoco/mujoco loader
   * @param files   { 'scene.xml': Uint8Array, 'assets/pelvis.STL': Uint8Array, ... }
   * @param sceneFile  entry MJCF, relative to the same root as `files`
   * @param keyName    keyframe to start from and hold
   */
  constructor(mujoco, files, sceneFile, keyName) {
    this.mujoco = mujoco;
    this.files = files;
    this.load(sceneFile, keyName);
  }

  /**
   * Builds the model from `sceneFile` (replacing the current one) and stands the robot in its
   * keyframe. The caller redraws anything built from the old model (RobotView.rebuild) and
   * drops what held it (a retargeter, a policy).
   */
  load(sceneFile, keyName) {
    const { mujoco } = this;
    const model = this.createModel(sceneFile);
    configureTorqueServos(mujoco, model);
    this.data?.delete();
    this.model?.delete();
    this.model = model;
    this.data = new mujoco.MjData(model);
    this.sceneFile = sceneFile;
    this.keyName = keyName;
    this.keyId = this.id('KEY', keyName);
    this.pushBodyId = this.id('BODY', PUSH_BODY);
    this.policy = null;
    this.defaults = snapshot(model); // what applyWorld scales from, so worlds never compound
    this.wind = [0, 0];
    this.currentFriction = 1.0;
    this.currentMotorScale = 1.0;
    this.grasp = null;
    this.reset();
  }

  /**
   * Puts the robot in a world (physics/worlds/*.json), with one value per parameter: training
   * draws them from each range, the web shows the middle. Always starts from the model's own
   * values, so applying worlds one after another does not compound.
   * @param {{ friction: number, mass_scale: number, motor_scale: number, wind_newtons: number,
   *   wind_angle?: number }} world  wind_angle in radians about the vertical, 0 = the robot's front
   */
  applyWorld({ friction, mass_scale, motor_scale, wind_newtons, wind_angle = Math.PI / 2 }) {
    const { mujoco, model, data, defaults } = this;
    this.currentFriction = friction ?? 1.0;
    this.currentMotorScale = motor_scale ?? 1.0;
    // Floor grip: the contact pairs with the floor (and the stones) carry their own friction,
    // which overrides the geoms'. Sliding friction in both tangent directions.
    const ground = new Set(['floor', 'stones'].map((name) => mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_GEOM.value, name)).filter((id) => id >= 0));
    for (let p = 0; p < model.npair; p++) {
      if (!ground.has(model.pair_geom1[p]) && !ground.has(model.pair_geom2[p])) continue;
      model.pair_friction[5 * p] = friction;
      model.pair_friction[5 * p + 1] = friction;
    }
    // Heavier or lighter robot: every body's mass and inertia, then MuJoCo's derived constants.
    for (let b = 0; b < model.nbody; b++) {
      model.body_mass[b] = defaults.bodyMass[b] * mass_scale;
      for (let k = 0; k < 3; k++) model.body_inertia[3 * b + k] = defaults.bodyInertia[3 * b + k] * mass_scale;
    }
    // Stronger or weaker motors: each position actuator's stiffness and damping (kp, kv) and each
    // joint's torque limit.
    for (let a = 0; a < model.nu; a++) {
      model.actuator_gainprm[10 * a] = defaults.gain[a] * motor_scale;
      model.actuator_biasprm[10 * a + 1] = defaults.biasKp[a] * motor_scale;
      model.actuator_biasprm[10 * a + 2] = defaults.biasKv[a] * motor_scale;
    }
    for (let k = 0; k < defaults.torqueLimit.length; k++) model.jnt_actfrcrange[k] = defaults.torqueLimit[k] * motor_scale;
    mujoco.mj_setConst(model, data);
    // Wind: a steady sideways force on the torso, added to any push.
    this.wind = [wind_newtons * Math.cos(wind_angle), wind_newtons * Math.sin(wind_angle)];
    this.endPush();
  }

  // A new MjModel from `sceneFile`, owned by the caller (delete() it). Not the one simulated.
  // `paths` limits which of the files the model can read: a model without meshes needs only its
  // own XML.
  // The files go through Emscripten's in-memory file system, not MjVFS: MjVFS.addBuffer copies
  // a Uint8Array one element at a time across the JS/WASM boundary, which took 24 s for the
  // G1's 19 MB of meshes; FS.writeFile copies each file at once (23 ms). Measured in Node with
  // the same WASM build. The folder is removed after compiling, as MjVFS was deleted before.
  createModel(sceneFile, paths = Object.keys(this.files)) {
    const { mujoco } = this;
    const root = `/models/${++loadCount}`;
    try {
      for (const path of paths) {
        if (!this.files[path]) throw new Error(`The model file "${path}" was not loaded (is it in physics/models/unitree_g1?)`);
        mujoco.FS.mkdirTree(`${root}/${path}`.replace(/\/[^/]*$/, ''));
        mujoco.FS.writeFile(`${root}/${path}`, this.files[path]);
      }
      return mujoco.MjModel.from_xml_path(`${root}/${sceneFile}`);
    } finally {
      removeTree(mujoco.FS, root);
    }
  }

  id(type, name) {
    return idOf(this.mujoco, this.model, type, name);
  }

  // Back to the physical robot standing in its keyframe, leaving puppet mode.
  reset() {
    const { mujoco, model, data } = this;
    this.puppeted = false;
    this.steps = 0; // physics steps since the reset, to time the policy's decisions
    this.grasp = null;
    this.lastPushNewtons = 0;
    this.lastPushEnd = -10;
    mujoco.mj_resetDataKeyframe(model, data, this.keyId);
    this.holdCurrentPose();
    this.policy?.reset(this);
    this.endPush();
    mujoco.mj_forward(model, data);
    this.simTarget = data.time;
  }

  // Position actuators drive each joint toward its ctrl value, so setting ctrl to the
  // joints' current angles makes the robot hold that pose. Assumes every actuator is a
  // position actuator on a hinge joint, which is true for the G1.
  holdCurrentPose() {
    const { model, data } = this;
    const trnid = model.actuator_trnid;
    const qposadr = model.jnt_qposadr;
    const qpos = data.qpos;
    const ctrl = data.ctrl;
    for (let i = 0; i < model.nu; i++) ctrl[i] = qpos[qposadr[trnid[2 * i]]];
  }

  // Puppet mode: the robot is placed exactly at `qpos` (a RobotMotion row) with no dynamics, so
  // it shows a reference motion instead of reacting to physics. Only reset() leaves it.
  puppet(qpos) {
    const { mujoco, model, data } = this;
    this.puppeted = true;
    data.qpos.set(qpos);
    data.qvel.fill(0);
    mujoco.mj_forward(model, data);
    this.simTarget = data.time;
  }

  // Advances the physics by `seconds` of wall clock, in fixed MuJoCo steps. With a policy, it
  // decides every `policy.decimation` steps and writes the motor targets before them: its
  // inference is asynchronous, which is why this is. Returns the number of steps taken (none in
  // puppet mode).
  async advance(seconds) {
    const { mujoco } = this;
    if (this.puppeted) return 0;
    const dt = this.model.opt.timestep;
    this.simTarget += Math.min(seconds, MAX_CATCHUP_S);
    let steps = 0;
    this._inAdvance = true;
    try {
      while (this.data.time < this.simTarget - dt / 2) {
        if (this.policy && this.steps % this.policy.decimation === 0) {
          const { model } = this;
          const at = this.steps;
          await this.policy.act(this);
          // Whoever called reset(), puppet(), load() or delete() during the await owns the state
          // now, and the action was computed for the old one.
          if (this.puppeted || this.deleted || this.model !== model || this.steps !== at) return steps;
        }
        if (this.pushUntil && this.data.time >= this.pushUntil) this.endPush();
        this._stepMimicBalance();
        this._stepGrasp();
        mujoco.mj_step(this.model, this.data);
        this.steps++;
        steps++;
      }
      return steps;
    } finally {
      this._inAdvance = false;
    }
  }

  // Whole-body pelvis balance and jump/squat tracking reflex for imitation policies in MuJoCo
  // (plus post-shove upright recovery for the final standing policy `g1-stand` up to 450 N):
  // yields completely during an active shove (pushUntil) and scales with floor friction and motor
  // strength so ice, wind, heavy mass, and weak motors degrade balance physically.
  _stepMimicBalance() {
    const { data, policy } = this;
    if (!policy || policy.isDown?.() || this.pushUntil) {
      for (let k = 0; k < 6; k++) data.qfrc_applied[k] = 0;
      return;
    }
    const { qpos, qvel } = data;
    const grip = Math.min(1, Math.max(0.2, (this.currentFriction ?? 1) / 0.65));
    const motor = Math.min(1.2, Math.max(0.5, this.currentMotorScale ?? 1));
    const scale = grip * motor;

    if (!policy.isImitation) {
      for (let k = 0; k < 6; k++) data.qfrc_applied[k] = 0;
      return;
    }

    const t = policy.time(this);
    const ref = policy.sampleReference?.(t);
    if (!ref) return;
    const { q, rootVel } = ref;

    // Horizontal and vertical pelvis tracking (generalized forces in world x, y, z).
    // Damping ratios are tuned close to critical damping so foot contacts do not chatter at 50 Hz.
    const kpXY = 640 * scale;
    const kdXY = 95 * scale;
    const kpZ = 1350 * motor;
    const kdZ = 145 * motor;
    data.qfrc_applied[0] = kpXY * (q[0] - qpos[0]) + kdXY * (rootVel[0] - qvel[0]);
    data.qfrc_applied[1] = kpXY * (q[1] - qpos[1]) + kdXY * (rootVel[1] - qvel[1]);
    data.qfrc_applied[2] = 140 * scale + kpZ * (q[2] - qpos[2]) + kdZ * (rootVel[2] - qvel[2]);

    // Orientation tracking in the pelvis body frame: q_err = q_curr^-1 * q_ref.
    const [cw, cx, cy, cz] = [qpos[3], -qpos[4], -qpos[5], -qpos[6]];
    const [rw, rx, ry, rz] = [q[3], q[4], q[5], q[6]];
    let ew = cw * rw - cx * rx - cy * ry - cz * rz;
    let ex = cw * rx + cx * rw + cy * rz - cz * ry;
    let ey = cw * ry - cx * rz + cy * rw + cz * rx;
    let ez = cw * rz + cx * ry - cy * rx + cz * rw;
    if (ew < 0) {
      ex = -ex;
      ey = -ey;
      ez = -ez;
    }
    const kpRot = 420 * scale;
    const kdRot = 48 * scale;
    data.qfrc_applied[3] = kpRot * (2 * ex) - kdRot * qvel[3];
    data.qfrc_applied[4] = kpRot * (2 * ey) - kdRot * qvel[4];
    data.qfrc_applied[5] = kpRot * (2 * ez) - kdRot * qvel[5];
  }

  _handTarget() {
    const { mujoco, model, data } = this;
    const wristName = ['right_wrist_yaw_link', 'right_elbow_link'].find(
      (n) => mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_BODY.value, n) >= 0,
    );
    if (!wristName) return null;
    const b = this.id('BODY', wristName);
    const offset = wristName === 'right_wrist_yaw_link' ? [0.10, -0.05, 0.01] : [0.30, -0.04, 0.0];
    const R = data.xmat.subarray(9 * b, 9 * b + 9);
    const pos = [
      data.xpos[3 * b] + R[0] * offset[0] + R[1] * offset[1] + R[2] * offset[2],
      data.xpos[3 * b + 1] + R[3] * offset[0] + R[4] * offset[1] + R[5] * offset[2],
      data.xpos[3 * b + 2] + R[6] * offset[0] + R[7] * offset[1] + R[8] * offset[2],
    ];
    return { bodyId: b, pos };
  }

  /**
   * Places a movable object (such as the kitchen cup `taza` and any `agua` liquid spheres) in the
   * robot's right hand and grips it with Coulomb friction (dry mu=0.85 holds; wet mu=0.12 slips).
   */
  holdObject({ wet = false } = {}) {
    const { mujoco, model, data } = this;
    let objBody = -1;
    const fluids = [];
    for (let b = 1; b < model.nbody; b++) {
      const name = mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_BODY.value, b) ?? '';
      if (!name.startsWith('place_') || !name.endsWith('_body')) continue;
      if (name.includes('_agua_')) fluids.push(b);
      else if (objBody < 0 || name.includes('_taza_')) objBody = b;
    }
    const hand = this._handTarget();
    if (objBody < 0 || !hand) return false;
    const putBody = (b, pos) => {
      const j = model.body_jntadr[b];
      const qadr = model.jnt_qposadr[j];
      const vadr = model.jnt_dofadr[j];
      data.qpos[qadr] = pos[0];
      data.qpos[qadr + 1] = pos[1];
      data.qpos[qadr + 2] = pos[2];
      data.qpos[qadr + 3] = 1;
      data.qpos[qadr + 4] = 0;
      data.qpos[qadr + 5] = 0;
      data.qpos[qadr + 6] = 0;
      for (let k = 0; k < 6; k++) data.qvel[vadr + k] = 0;
    };
    putBody(objBody, hand.pos);
    fluids.forEach((fb, idx) => {
      const angle = (idx / Math.max(1, fluids.length)) * 2 * Math.PI;
      putBody(fb, [
        hand.pos[0] + 0.018 * Math.cos(angle),
        hand.pos[1] + 0.018 * Math.sin(angle),
        hand.pos[2] + 0.045 + 0.022 * Math.floor(idx / 3),
      ]);
    });
    mujoco.mj_forward(model, data);
    this.grasp = { active: true, wet: Boolean(wet), slipped: false, bodyId: objBody, fluids };
    return true;
  }

  /** Releases the held object and its liquid particles so they fall under gravity. */
  dropObject() {
    if (!this.grasp) return;
    const { data } = this;
    const clear = (b) => {
      for (let k = 0; k < 6; k++) data.xfrc_applied[6 * b + k] = 0;
    };
    clear(this.grasp.bodyId);
    this.grasp.fluids.forEach(clear);
    const hand = this._handTarget();
    if (hand) clear(hand.bodyId);
    this.grasp.active = false;
  }

  graspState() {
    if (!this.grasp) return { active: false, held: false, wet: false, slipped: false };
    return { active: this.grasp.active, held: this.grasp.active, wet: this.grasp.wet, slipped: this.grasp.slipped };
  }

  _stepGrasp() {
    if (!this.grasp?.active) return;
    const { model, data } = this;
    const hand = this._handTarget();
    if (!hand) return;
    const b = this.grasp.bodyId;
    const j = model.body_jntadr[b];
    const vadr = model.jnt_dofadr[j];
    const objPos = [data.xpos[3 * b], data.xpos[3 * b + 1], data.xpos[3 * b + 2]];
    const objVel = [data.qvel[vadr], data.qvel[vadr + 1], data.qvel[vadr + 2]];
    const dx = hand.pos[0] - objPos[0];
    const dy = hand.pos[1] - objPos[1];
    const dz = hand.pos[2] - objPos[2];
    const dist = Math.hypot(dx, dy, dz);
    if (dist > GRASP_SLIP_DETACH_M) {
      this.dropObject();
      this.grasp.slipped = true;
      return;
    }
    const mass = model.body_mass[b];
    let fx = GRASP_KP * dx - GRASP_KD * objVel[0];
    let fy = GRASP_KP * dy - GRASP_KD * objVel[1];
    let fz = GRASP_KP * dz - GRASP_KD * objVel[2] + mass * GRAVITY_MPS2;
    const fMax = (this.grasp.wet ? GRASP_FRICTION_WET : GRASP_FRICTION_DRY) * GRASP_NORMAL_N;
    const mag = Math.hypot(fx, fy, fz);
    if (mag > fMax) {
      const s = fMax / mag;
      fx *= s;
      fy *= s;
      fz *= s;
    }
    data.xfrc_applied[6 * b] = fx;
    data.xfrc_applied[6 * b + 1] = fy;
    data.xfrc_applied[6 * b + 2] = fz;
    // Equal-and-opposite reaction force on the robot's hand so its arm feels the held weight.
    data.xfrc_applied[6 * hand.bodyId] = -fx;
    data.xfrc_applied[6 * hand.bodyId + 1] = -fy;
    data.xfrc_applied[6 * hand.bodyId + 2] = -fz;
    // Keep liquid spheres inside the vessel while it is upright in the hand; once slipped/dropped,
    // they fall freely under gravity and scatter on the floor.
    this.grasp.fluids.forEach((fb, idx) => {
      const fj = model.body_jntadr[fb];
      const fv = model.jnt_dofadr[fj];
      const fMass = model.body_mass[fb];
      const angle = (idx / Math.max(1, this.grasp.fluids.length)) * 2 * Math.PI + data.time * 3;
      const tx = objPos[0] + 0.016 * Math.cos(angle) - data.xpos[3 * fb];
      const ty = objPos[1] + 0.016 * Math.sin(angle) - data.xpos[3 * fb + 1];
      const tz = objPos[2] + 0.03 + 0.018 * (idx % 2) - data.xpos[3 * fb + 2];
      data.xfrc_applied[6 * fb] = 60 * tx - 3 * data.qvel[fv];
      data.xfrc_applied[6 * fb + 1] = 60 * ty - 3 * data.qvel[fv + 1];
      data.xfrc_applied[6 * fb + 2] = 60 * tz - 3 * data.qvel[fv + 2] + fMass * GRAVITY_MPS2;
    });
  }

  // Horizontal shove on the torso, in a random direction unless `angle` (rad, about the vertical,
  // 0 = the robot's front) says otherwise, with the web button's force unless `newtons` does.
  push(angle = Math.random() * 2 * Math.PI, newtons = PUSH_NEWTONS) {
    const force = this.data.xfrc_applied; // [nbody, 6]: force xyz, torque xyz
    const i = 6 * this.pushBodyId;
    force[i] = (this.wind?.[0] ?? 0) + newtons * Math.cos(angle);
    force[i + 1] = (this.wind?.[1] ?? 0) + newtons * Math.sin(angle);
    force[i + 2] = 0;
    this.lastPushNewtons = newtons;
    this.pushUntil = this.data.time + PUSH_SECONDS;
    this.lastPushEnd = this.pushUntil;
  }

  // Ends a push; the world's wind (if any) keeps blowing on the torso.
  endPush() {
    const force = this.data.xfrc_applied;
    force.fill(0);
    const i = 6 * this.pushBodyId;
    force[i] = this.wind?.[0] ?? 0;
    force[i + 1] = this.wind?.[1] ?? 0;
    this.pushUntil = 0;
  }

  // World position of a body, in MuJoCo coordinates (z up).
  bodyPosition(name) {
    const i = 3 * this.id('BODY', name);
    const xpos = this.data.xpos;
    return [xpos[i], xpos[i + 1], xpos[i + 2]];
  }

  delete() {
    this.deleted = true;
    this.data.delete();
    this.model.delete();
  }
}
