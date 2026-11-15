// The simulation stage: the human skeleton of the selected clip next to the G1 from physics/,
// with one set of controls for both. The skeleton shows at once; the robot pane shows a dot
// robot until the real one has loaded (robot-pane.js).
//
// The robot repeats the clip (its RobotMotion: saved for the preloaded clips, computed here from the
// PoseClip for any other) in step with the
// skeleton, and has a trained policy loaded: "Empujar" drops the clip and shows the policy
// keeping the robot up. "Empezar de nuevo" puts both back at the start of the clip. "Mundo" puts
// the robot on another floor, grip, wind, mass and motor strength (physics/worlds); leaving the
// screen puts it back on flat ground, since the app shares one robot.
//
// For a clip with an imitation policy (policies.js IMITATIONS), "Robot entrenado con" also offers
// it: the robot then does the clip itself, with physics, from its first pose, and the skeleton
// follows the robot's clock (view.clipTime) instead of the other way around.
import * as THREE from 'three';
import { SCENES, WORLDS } from 'tridi-physics';

import { savedMotion } from './motions.js';
import { FINAL_LEVEL, IMITATIONS, imitationOf, policyUrls } from './policies.js';
import { dressWorld } from './looks/index.js';
import { clearStageProps, dressPlace, setFloor, syncSitChair, syncWashSink } from './props.js';
import { mountRobotPane } from './robot-pane.js';
import { SkeletonView } from './skeleton.js';
import { createVideoOverlay } from './video-overlay.js';
import { fmt, LANGS } from './i18n.js';
import { L, S, T } from './strings-stage.js';
import { levelName, sceneName, worldName } from './strings-names.js';

// Player icons (24 px, currentColor): the playback buttons carry only an icon and a tooltip.
export const ICONS = {
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l10.5-6.5z" fill="currentColor"/></svg>',
  pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" fill="currentColor"/></svg>',
  restart: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12a7 7 0 1 0 2.1-5M5 4v4h4" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};
// The speed button cycles through these (1 = real time).
const SPEEDS = [1, 0.5, 0.25];

// A hidden tab or a shader compile can stall a frame; past this the skeleton skips ahead
// instead of jumping, as physics/ does for the robot.
const MAX_FRAME_S = 1 / 30;

/**
 * @param root  element holding the stage markup of screens/simulations.js
 */
export function mountStage(root, { initialRobot = 'unitree_g1' } = {}) {
  const $ = (id) => root.querySelector(`#${id}`);
  const skeleton = new SkeletonView($('human'));
  const label = root.querySelector('.robot-pane .pane-label');
  // The robot is physical (policy in control) after a push; otherwise it plays the clip.
  const robot = mountRobotPane(root.querySelector('.robot-pane'), {
    beforePush() {
      copying = false;
      setRobotLabel();
    },
  });
  const CUSTOM_ROBOT_POLICY = {
    luigi_lab3: 'luigi-lab3',
    luigi_lab4: 'luigi-lab4',
    factory_cell: 'factory-cell',
  };
  const isCustomRobot = (r = robotModel) => Boolean(CUSTOM_ROBOT_POLICY[r]);

  // Factory I/O style 3D component labels + live 4-step narrator bar inside .robot-pane for ALL models
  const robotPaneEl = root.querySelector('.robot-pane');
  const factoryOverlay = document.createElement('div');
  factoryOverlay.className = 'fio-overlay';
  if (robotPaneEl) robotPaneEl.appendChild(factoryOverlay);

  const OVERLAY_CONFIGS = {
    factory_cell: {
      baseY: 0.35,
      anchors: [
        {
          key: 'hopper', body: 'pelvis', lx: -0.64, ly: 0.0, lz: 0.36, defLeft: 26, defTop: 36, cls: '',
          title: 'HOPPER-01',
          sub: 'PE-01',
        },
        {
          key: 'press', body: 'sealer_head_link', lx: 0.0, ly: 0.0, lz: 0.16, defLeft: 50, defTop: 26, cls: 'fio-tag-blue',
          title: 'PRESS-01',
          sub: 'PE-02',
        },
        {
          key: 'pusher', body: 'pusher_gate_link', lx: 0.0, ly: -0.06, lz: 0.15, defLeft: 66, defTop: 46, cls: 'fio-tag-red',
          title: 'PUSHER-01',
          sub: 'PE-03',
        },
        {
          key: 'pallet', body: 'pelvis', lx: 1.25, ly: 0.0, lz: 0.02, defLeft: 82, defTop: 54, cls: '',
          title: 'PALLET-01',
          subId: 'fio-pallet-count',
          sub: '0/6',
        },
      ],
      steps: [
        { es: '1. Tolva y Pesaje (PE-01)', en: '1. Hopper & Weigh (PE-01)' },
        { es: '2. Prensa Azul Sella (PE-02)', en: '2. Blue Press Seals (PE-02)' },
        { es: '3. Inspección Salida (PE-03)', en: '3. Exit Check (PE-03)' },
        { es: '4. Rampa y Apilado en Palet', en: '4. Ramp & Stack on Pallet', id: 'fio-step-4' },
      ],
      explain: {
        es: 'Paso 1/4: Sale una caja nueva de la Tolva (HOPPER-01), pasa por la báscula (PE-01) y avanza a velocidad constante hacia el centro.',
        en: 'Step 1/4: A new box enters from the Hopper (HOPPER-01), crosses the scale (PE-01), and glides at constant speed toward the center.',
      },
    },
    luigi_lab3: {
      baseY: 0.09,
      anchors: [
        {
          key: 'hc', body: 'pelvis', rotate: true, lx: 0.15, ly: 0.0, lz: 0.08, defLeft: 56, defTop: 40, cls: 'fio-tag-blue',
          title: 'HC-SR04',
          subId: 'fio-rover-hc',
          sub: '120 cm',
        },
        {
          key: 'l298n', body: 'pelvis', rotate: true, lx: -0.14, ly: 0.0, lz: 0.07, defLeft: 38, defTop: 50, cls: '',
          title: 'L298N · 50 Hz',
          subId: 'fio-rover-wh',
          sub: '15.5 rad/s',
        },
      ],
      steps: [
        { es: '1. Crucero ONNX (50 Hz)', en: '1. ONNX Cruise (50 Hz)' },
        { es: '2. Freno (-20 rad/s)', en: '2. Brake (-20 rad/s)' },
        { es: '3. Reversa Despeje', en: '3. Reverse Clear' },
        { es: '4. Giro a Lado Libre', en: '4. Pivot to Clear Side' },
      ],
      explain: {
        es: 'Rover Luigi v1 (Sensores Fijos): Avanza a 50 Hz leyendo el ultrasónico frontal HC-SR04 y el sensor óptico APDS-9960.',
        en: 'Luigi Rover v1 (Fixed Sensors): Cruises at 50 Hz reading the front HC-SR04 ultrasonic cone and top APDS-9960 IR sensor.',
      },
    },
    luigi_lab4: {
      baseY: 0.09,
      anchors: [
        {
          key: 'hc', body: 'head_neck_link', rotate: true, lx: 0.04, ly: 0.0, lz: 0.07, defLeft: 56, defTop: 36, cls: 'fio-tag-blue',
          title: 'SG90 + HC-SR04',
          subId: 'fio-rover-hc',
          sub: '120 cm',
        },
        {
          key: 'l298n', body: 'pelvis', rotate: true, lx: -0.14, ly: 0.0, lz: 0.07, defLeft: 38, defTop: 50, cls: '',
          title: 'L298N · 50 Hz',
          subId: 'fio-rover-wh',
          sub: '15.5 rad/s',
        },
      ],
      steps: [
        { es: '1. Barrido SG90 (±63°)', en: '1. SG90 Sweep (±63°)' },
        { es: '2. Freno (-20 rad/s)', en: '2. Brake (-20 rad/s)' },
        { es: '3. Reversa Despeje', en: '3. Reverse Clear' },
        { es: '4. Evasión Continua', en: '4. Continuous Dodge' },
      ],
      explain: {
        es: 'Rover Luigi v2 (Radar Servo SG90): La torreta barre ±63° en movimiento continuo a 50 Hz para esquivar sin detenerse.',
        en: 'Luigi Rover v2 (SG90 Servo Radar): The turret sweeps ±63° while driving at 50 Hz to dodge obstacles without stopping.',
      },
    },
    unitree_g1: {
      baseY: 0.78,
      anchors: [
        {
          key: 'torso', body: 'torso_link', rotate: true, lx: 0.0, ly: 0.18, lz: 0.16, defLeft: 62, defTop: 34, cls: 'fio-tag-blue',
          title: 'ONNX · 50 Hz',
          subId: 'fio-g1-policy',
          sub: '29 DOF',
        },
        {
          key: 'feet', body: 'pelvis', rotate: true, lx: 0.0, ly: -0.22, lz: -0.18, defLeft: 38, defTop: 54, cls: '',
          title: 'MUJOCO · 250 Hz',
          subId: 'fio-g1-world',
          sub: '33.3 kg',
        },
      ],
      steps: [
        { es: '1. Video a Esqueleto 3D', en: '1. Video to 3D Skeleton' },
        { es: '2. Retargeting 29 DOF', en: '2. 29-DOF Retargeting' },
        { es: '3. Política ONNX (50 Hz)', en: '3. ONNX Policy (50 Hz)' },
        { es: '4. Física MuJoCo (250 Hz)', en: '4. MuJoCo Physics (250 Hz)' },
      ],
      explain: {
        es: 'Unitree G1 (33,3 kg): La red neuronal ONNX coordina los 29 motores del cuerpo y las manos a 50 Hz manteniendo el equilibrio.',
        en: 'Unitree G1 (33.3 kg): The 50 Hz ONNX neural network coordinates all 29 body and hand actuators while maintaining balance.',
      },
    },
  };

  function getOverlayConfig(m = robotModel) {
    return OVERLAY_CONFIGS[m] ?? OVERLAY_CONFIGS.unitree_g1;
  }

  function renderOverlayForModel(m = robotModel) {
    if (m !== 'factory_cell') {
      factoryOverlay.dataset.model = m;
      factoryOverlay.innerHTML = '';
      factoryOverlay.hidden = true;
      return;
    }
    const key = 'factory_cell';
    if (factoryOverlay.dataset.model === key && factoryOverlay.innerHTML) {
      factoryOverlay.hidden = false;
      return;
    }
    factoryOverlay.dataset.model = key;
    const cfg = OVERLAY_CONFIGS[key];
    factoryOverlay.innerHTML = `
      <div class="fio-tags">
        ${cfg.anchors
          .map(
            (a) => `
          <div class="fio-tag ${a.cls || ''}" data-fio="${a.key}" data-active="true" style="left:${a.defLeft}%;top:${a.defTop}%">
            <span class="fio-dot"></span>
            <div class="fio-tag-body">
              <strong>${a.title}</strong>
              <span ${a.subId ? `id="${a.subId}"` : ''}>${a.sub}</span>
            </div>
          </div>`,
          )
          .join('')}
      </div>
    `;
    factoryOverlay.hidden = false;
  }
  renderOverlayForModel(initialRobot);

  let lastFactoryStage = -1;
  let lastFactorySealQuality = null;
  let loadSeq = 0;
  const scratchVec = new THREE.Vector3();
  let playing = true;
  let speed = 1;
  let robotModel = initialRobot;
  let level = CUSTOM_ROBOT_POLICY[initialRobot] ?? $('policy').value;
  let current = null; // { clip, title }: what the gallery selected
  let motion = null; // the RobotMotion of `current`
  let copying = false; // the robot is playing `motion`
  const motions = new Map(); // clip id -> RobotMotion, so a clip is retargeted once

  const imitating = () => imitationOf(level) !== null;
  const matchesImitation = (imitation, clipId) =>
    Boolean(imitation && clipId && (imitation.clips ? imitation.clips.includes(clipId) : imitation.clip === clipId));
  // With physics (default) the robot moves by itself: the imitation policy of the clip if there is
  // one, or standing with its policy if it has not learned this movement yet. Without physics it
  // replays the movement as a puppet, as a reference: what it would look like, not what it can do.
  let physics = true;
  const imitationFor = (clip, rModel = robotModel) =>
    IMITATIONS.find((imitation) => (imitation.robot ?? 'unitree_g1') === rModel && matchesImitation(imitation, clip?.id)) ??
    IMITATIONS.find((imitation) => matchesImitation(imitation, clip?.id)) ??
    null;
  const overlay = createVideoOverlay(root.querySelector('#human-pane'));

  // A clip moves with physics only if a policy learned it (an imitation); any other clip is shown
  // as before, the robot replaying its movement without physics.
  const withPhysics = () => physics && (isCustomRobot() || imitationFor(current?.clip) !== null);

  // After any change (checkpoint, world, place): the puppet replay unless the clip moves with physics.
  function resume() {
    if (isCustomRobot()) {
      copying = false;
      setRobotLabel();
      return;
    }
    if (!withPhysics() && motion && !imitating()) startMotion();
    else {
      copying = false;
      setRobotLabel();
    }
  }

  let loadedClipId = null;

  // With physics, a clip with an imitation policy is shown with it.
  function physicsFor(clip) {
    if (isCustomRobot()) return resume();
    const imitation = imitationFor(clip);
    if (physics && imitation && (level !== imitation.id || loadedClipId !== clip?.id)) {
      $('policy').value = imitation.id;
      return loadLevel(imitation.id);
    }
    resume();
  }

  // What the world looks like (looks/): redone after every change of world or place.
  let look = null;
  function refreshLook() {
    look?.undo();
    look = robot.view ? dressWorld(robot.view) : null;
  }

  /** The robot pane's caption: `markup` (from T()) while something loads, else what the robot does. */
  function setRobotLabel(markup) {
    if (markup) return void (label.innerHTML = markup);
    const world = robot.view?.world();
    const place = robot.view?.scene();
    const names = [world && world.id !== 'plano' ? worldName(world.id, world.title) : null, place ? sceneName(place.id, place.title) : null].filter(Boolean);
    label.innerHTML = LANGS.map((l) => {
      const where = names.map((name) => ` · ${name[l].toLowerCase()}`).join('');
      const doing = imitating()
        ? L('doingImitate', {}, l)
        : copying
          ? L('doingCopy', {}, l)
          : L('doingBalance', { level: levelName(level)[l].toLowerCase() }, l);
      return `<span class="t" lang="${l}">${L('robotLine', { doing, where }, l)}</span>`;
    }).join('');
  }

  let last = performance.now();
  let lastDodgeStage = -1;
  let frameId = requestAnimationFrame(function frame(now) {
    const wall = Math.min(MAX_FRAME_S, Math.max(0, (now - last) / 1000));
    last = now;
    // Imitating, the robot's physics sets the time and the skeleton follows it. Otherwise the
    // skeleton's clock is the stage's and the robot follows it, so the two never drift apart.
    if (imitating() && !isCustomRobot() && robot.view) skeleton.time = robot.view.clipTime();
    else if (playing) skeleton.advance(wall * speed);
    if (copying && robot.view) robot.view.seek(skeleton.time);
    look?.update(wall);
    // Project 3D component callout tags onto .robot-pane for ALL models on every frame using live MuJoCo body pose & rotation
    if (robot.view?.viewer?.camera && robot.view?.sim) {
      const viewer = robot.view.viewer;
      const sim = robot.view.sim;
      const { mujoco, model, data } = sim;
      viewer.camera.updateMatrixWorld();
      const [px, py] = sim.bodyPosition('pelvis');
      const cfg = getOverlayConfig(robotModel);
      for (const anchor of cfg.anchors) {
        const tagEl = factoryOverlay.querySelector(`[data-fio="${anchor.key}"]`);
        if (!tagEl) continue;
        let wx = px + anchor.lx;
        let wy = py + anchor.ly;
        let wz = cfg.baseY + anchor.lz;
        if (anchor.body) {
          const bId = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_BODY.value, anchor.body);
          if (bId >= 0) {
            const bx = data.xpos[3 * bId];
            const by = data.xpos[3 * bId + 1];
            const bz = data.xpos[3 * bId + 2];
            if (anchor.rotate) {
              const m = 9 * bId;
              const xmat = data.xmat;
              wx = bx + xmat[m] * anchor.lx + xmat[m + 1] * anchor.ly + xmat[m + 2] * anchor.lz;
              wy = by + xmat[m + 3] * anchor.lx + xmat[m + 4] * anchor.ly + xmat[m + 5] * anchor.lz;
              wz = bz + xmat[m + 6] * anchor.lx + xmat[m + 7] * anchor.ly + xmat[m + 8] * anchor.lz;
            } else {
              wx = bx + anchor.lx;
              wy = by + anchor.ly;
              wz = bz + anchor.lz;
            }
          }
        }
        scratchVec.set(wx, wz, -wy).project(viewer.camera);
        if (scratchVec.z > 1) {
          tagEl.style.opacity = '0';
        } else {
          const xPct = Math.max(8, Math.min(92, (scratchVec.x * 0.5 + 0.5) * 100));
          const yPct = Math.max(8, Math.min(72, (-scratchVec.y * 0.5 + 0.5) * 100));
          tagEl.style.opacity = '1';
          tagEl.style.left = `${xPct.toFixed(1)}%`;
          tagEl.style.top = `${yPct.toFixed(1)}%`;
        }
      }
    }

    if ((robotModel === 'luigi_lab3' || robotModel === 'luigi_lab4') && robot.view?.sim?.sensorReadout) {
      const sr = robot.view.sim.sensorReadout;
      const elHc = $('sim-hcsr04');
      const elApds = $('sim-apds');
      const elWh = $('sim-wheels');
      const elSt = $('sim-dodge-state');
      const c0 = (robot.view.sim.data.ctrl[0] ?? 0).toFixed(1);
      const c1 = (robot.view.sim.data.ctrl[1] ?? 0).toFixed(1);
      if (elHc) elHc.textContent = `${sr.distCm} cm`;
      if (elApds) {
        elApds.textContent = robotModel === 'luigi_lab4'
          ? `${sr.neckDeg >= 0 ? '+' : ''}${sr.neckDeg.toFixed(1)}°`
          : `${sr.irProx} / 255`;
      }
      if (elWh) {
        elWh.textContent = `[${c0}, ${c1}] rad/s`;
      }
      // Update compact 3D floating tag readouts on the rover
      const tagHc = factoryOverlay.querySelector('#fio-rover-hc');
      if (tagHc) {
        tagHc.textContent = robotModel === 'luigi_lab4'
          ? `${sr.distCm} cm · ${sr.neckDeg >= 0 ? '+' : ''}${sr.neckDeg.toFixed(0)}°`
          : `${sr.distCm} cm`;
      }
      const tagWh = factoryOverlay.querySelector('#fio-rover-wh');
      if (tagWh) tagWh.textContent = `${c0} / ${c1} rad/s`;

      const hcTagEl = factoryOverlay.querySelector('[data-fio="hc"]');
      if (hcTagEl) hcTagEl.dataset.fault = String(sr.distCm < 26);

      if (sr.dodgeStage !== lastDodgeStage) {
        lastDodgeStage = sr.dodgeStage;
        const stages = [
          { es: robotModel === 'luigi_lab4' ? 'Escaneo activo SG90 (50 Hz)' : 'Crucero ONNX (50 Hz)', en: robotModel === 'luigi_lab4' ? 'Active SG90 sweep (50 Hz)' : 'ONNX Cruise (50 Hz)' },
          { es: '1/4 · Freno (-20 rad/s)', en: '1/4 · Brake (-20 rad/s)' },
          { es: '2/4 · Reversa despeje', en: '2/4 · Reverse clear' },
          { es: '3/4 · Giro hacia lado libre', en: '3/4 · Pivot to clear side' },
        ];
        const stObj = stages[sr.dodgeStage] ?? stages[0];
        if (elSt) {
          elSt.innerHTML = `<span class="t" lang="es">${stObj.es}</span><span class="t" lang="en">${stObj.en}</span>`;
          elSt.style.color = sr.dodgeStage > 0 ? '#ff6a3d' : '#c8ff2e';
        }
        factoryOverlay.querySelectorAll('[data-fio-step]').forEach((stepEl) => {
          const sIdx = Number(stepEl.dataset.fioStep);
          stepEl.dataset.active = String(sIdx === sr.dodgeStage);
          stepEl.dataset.fault = String(sr.dodgeStage > 0 && sIdx === sr.dodgeStage);
        });
        const explainEl = factoryOverlay.querySelector('#fio-explain-text');
        if (explainEl) {
          const explainStages = [
            {
              es: robotModel === 'luigi_lab4'
                ? 'Paso 1/4: El servo SG90 barre ±63° a 50 Hz mientras el rover avanza despejado.'
                : 'Paso 1/4: Crucero autónomo ONNX a 50 Hz leyendo el cono ultrasónico HC-SR04 y el sensor IR 0x9E.',
              en: robotModel === 'luigi_lab4'
                ? 'Step 1/4: The SG90 servo sweeps ±63° at 50 Hz while the rover drives along a clear path.'
                : 'Step 1/4: 50 Hz ONNX autonomous cruise polling the HC-SR04 ultrasonic cone and 0x9E IR sensor.',
            },
            {
              es: `Paso 2/4: Obstáculo detectado a ${sr.distCm} cm — el puente H L298N aplica freno dinámico (-20 rad/s).`,
              en: `Step 2/4: Obstacle detected at ${sr.distCm} cm — L298N H-bridge applies dynamic braking (-20 rad/s).`,
            },
            {
              es: 'Paso 3/4: Reversa controlada para abrir radio de giro libre sin colisionar el chasis STL.',
              en: 'Step 3/4: Controlled reverse to open turning clearance without colliding the STL chassis.',
            },
            {
              es: 'Paso 4/4: Giro diferencial sobre su eje hacia el sector con mayor distancia libre.',
              en: 'Step 4/4: Differential pivot toward the sector with the longest clear distance.',
            },
          ];
          const exp = explainStages[sr.dodgeStage] ?? explainStages[0];
          explainEl.innerHTML = `<span class="t" lang="es">${exp.es}</span><span class="t" lang="en">${exp.en}</span>`;
        }
      }
    } else if (robotModel === 'factory_cell' && robot.view?.sim?.factoryReadout) {
      const fr = robot.view.sim.factoryReadout;
      const elHc = $('sim-hcsr04');
      const elApds = $('sim-apds');
      const elWh = $('sim-wheels');
      const elSt = $('sim-dodge-state');
      if (elHc) elHc.textContent = `${fr.vfdHz} Hz · C:${fr.conveyorMm} · P:${fr.pusherMm} mm`;
      if (elApds) elApds.textContent = `${fr.sealerMm} mm · [PE1:${fr.sensorEntry ? 1 : 0} PE2:${fr.sensorSealer ? 1 : 0} PE3:${fr.sensorExit ? 1 : 0}]`;
      if (elWh) {
        elWh.innerHTML = `<span class="t" lang="es">${fr.completedCycles} OK · ${fr.crushedCount} merma</span><span class="t" lang="en">${fr.completedCycles} OK · ${fr.crushedCount} waste</span>`;
      }
      if (elSt && fr.stage !== lastFactoryStage) {
        elSt.innerHTML = `<span class="t" lang="es">${fr.modeLabelEs || fr.modeLabel}</span><span class="t" lang="en">${fr.modeLabelEn || fr.modeLabel}</span>`;
        elSt.style.color = fr.crushedBox ? '#ff6a5a' : '#c8ff2e';
      }
      for (const anchor of getOverlayConfig('factory_cell').anchors) {
        const tagEl = factoryOverlay.querySelector(`[data-fio="${anchor.key}"]`);
        if (!tagEl) continue;
        let isActive = false;
        let isFault = false;
        if (anchor.key === 'hopper') isActive = fr.stage === 0 || fr.sensorEntry;
        else if (anchor.key === 'cam') isActive = fr.stage === 0 || fr.stage === 1;
        else if (anchor.key === 'press') {
          isActive = fr.stage === 1 || fr.sealerMm > 15;
          isFault = fr.stage === 4;
        } else if (anchor.key === 'pusher') {
          isActive = fr.pusherMm > 15;
          isFault = fr.fixedPlcMode && fr.stage === 3;
        } else if (anchor.key === 'pallet') {
          isActive = !fr.fixedPlcMode && fr.stage === 3;
        } else if (anchor.key === 'plc') {
          isActive = true;
        }
        tagEl.dataset.active = String(isActive);
        tagEl.dataset.fault = String(isFault);
      }
      const palletCountEl = factoryOverlay.querySelector('#fio-pallet-count');
      if (palletCountEl) {
        palletCountEl.textContent = `${fr.stackedBoxes ?? 0}/6`;
      }
      if (fr.stage !== lastFactoryStage) {
        lastFactoryStage = fr.stage;
        const narrator = factoryOverlay.querySelector('#fio-narrator');
        if (narrator) narrator.dataset.fault = String(fr.crushedBox);
        const step4El = factoryOverlay.querySelector('#fio-step-4');
        if (step4El) {
          step4El.innerHTML = fr.fixedPlcMode
            ? '<span class="t" lang="es">4. Pistón Rojo Rechaza (PE-03)</span><span class="t" lang="en">4. Red Pusher Rejects (PE-03)</span>'
            : '<span class="t" lang="es">4. Rampa y Apilado en Palet</span><span class="t" lang="en">4. Ramp &amp; Stack on Pallet</span>';
        }
        factoryOverlay.querySelectorAll('[data-fio-step]').forEach((stepEl) => {
          const sIdx = Number(stepEl.dataset.fioStep);
          const active = fr.stage === 4 ? sIdx === 1 : sIdx === fr.stage;
          stepEl.dataset.active = String(active);
          stepEl.dataset.fault = String((fr.stage === 4 && sIdx === 1) || (fr.fixedPlcMode && fr.stage === 3 && sIdx === 3));
        });
        const explainEl = factoryOverlay.querySelector('#fio-explain-text');
        if (explainEl) {
          explainEl.innerHTML = `<span class="t" lang="es">${fr.stepExplainEs}</span><span class="t" lang="en">${fr.stepExplainEn}</span>`;
        }
      }
      // Color the top seal (package_label) white when properly sealed, or red-orange when mis-sealed in Fixed-Timer mode
      if (fr.sealQuality !== lastFactorySealQuality) {
        lastFactorySealQuality = fr.sealQuality;
        const { mujoco, model } = robot.view.sim;
        const labelGeomId = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_GEOM.value, 'package_label');
        const labelEntry = robot.view.viewer?.geoms?.find((g) => g.id === labelGeomId);
        if (labelEntry?.object?.material?.color) {
          if (fr.sealQuality === 'bad') {
            labelEntry.object.material.color.setRGB(0.95, 0.24, 0.18);
          } else {
            labelEntry.object.material.color.setRGB(0.96, 0.96, 0.94);
          }
        }
      }
    }
    overlay.sync(skeleton.time, playing, speed);
    skeleton.render();
    frameId = requestAnimationFrame(frame);
  });

  function syncRobotDependentUI() {
    const custom = isCustomRobot();
    const isRover = robotModel === 'luigi_lab3' || robotModel === 'luigi_lab4';
    const isCell = robotModel === 'factory_cell';
    const currentPlace = $('place')?.value ?? '';
    const pushBtn = root.querySelector('.push');
    const pushGroup = root.querySelector('.push-group');
    if (pushBtn) pushBtn.hidden = custom || !physics;
    if (pushGroup) pushGroup.hidden = custom || !physics;
    renderOverlayForModel(robotModel);
    if (label) label.hidden = custom;
    if ($('arduino-box')) $('arduino-box').hidden = !isRover;
    if ($('factory-fault-box')) $('factory-fault-box').hidden = !isCell;
    if ($('grasp-box')) $('grasp-box').hidden = custom || currentPlace !== 'cocina';
    if ($('world-field')) $('world-field').hidden = isCell;
    const tuneEl = root.querySelector('.tune');
    if (tuneEl) tuneEl.hidden = isCell;
    if ($('place-field')) $('place-field').hidden = custom;
    if ($('policy-field')) $('policy-field').hidden = true;
    if ($('physics-mode-group')) $('physics-mode-group').hidden = custom;
    if ($('physics-mode-note')) $('physics-mode-note').hidden = custom;
    if ($('luigi-sim-panel')) $('luigi-sim-panel').hidden = !custom;
    if ($('pick-heading')) $('pick-heading').hidden = custom;
    if ($('gallery')) $('gallery').hidden = custom;
    const tBox = root.querySelector('.train-box');
    if (tBox) tBox.hidden = custom || !current;
    if ($('stage')) {
      $('stage').dataset.show = custom ? 'robot' : 'both';
    }
    if ($('luigi-reset-arena')) {
      $('luigi-reset-arena').innerHTML = isCell
        ? '<span class="t" lang="es">Reiniciar ciclo de celda industrial</span><span class="t" lang="en">Reset industrial cell cycle</span>'
        : '<span class="t" lang="es">Reiniciar rover en centro de arena</span><span class="t" lang="en">Reset rover at arena center</span>';
    }
    lastDodgeStage = -1;
    if (robotModel === 'luigi_lab4') {
      if ($('luigi-sim-badge')) {
        $('luigi-sim-badge').innerHTML = '<span class="t" lang="es">Caso Luigi · Rover v2 con Radar Servo SG90 (50 Hz)</span><span class="t" lang="en">Luigi Case · Rover v2 with SG90 Servo Radar (50 Hz)</span>';
      }
      if ($('luigi-sim-title')) {
        $('luigi-sim-title').innerHTML = '<span class="t" lang="es">Rover de Luigi (v2) · Torreta Móvil SG90 + HC-SR04</span><span class="t" lang="en">Luigi’s Rover (v2) · SG90 Pan Turret + HC-SR04</span>';
      }
      if ($('luigi-sim-desc')) {
        $('luigi-sim-desc').innerHTML = '<span class="t" lang="es">Segunda versión del robot móvil de Luigi D’Aquaro (chasis naranja de 180 mm, 7 piezas STL) con torreta móvil sobre servo <code>SG90</code> (±63°): barre izquierda-centro-derecha en movimiento continuo a 50 Hz sin frenar el robot.</span><span class="t" lang="en">Second version of Luigi D’Aquaro’s mobile rover (180 mm orange chassis, 7 STL parts) with pan turret on an <code>SG90</code> servo (±63°): sweeps left-center-right while driving at 50 Hz without stopping.</span>';
      }
      if ($('sim-label-1')) $('sim-label-1').textContent = 'HC-SR04 en Torreta (D7 / D4)';
      if ($('sim-label-2')) $('sim-label-2').textContent = 'Cuello Servo SG90 (Pin D13)';
      if ($('sim-label-3')) $('sim-label-3').innerHTML = '<span class="t" lang="es">Puente H L298N (ENA D5 / ENB D6)</span><span class="t" lang="en">L298N H-Bridge (ENA D5 / ENB D6)</span>';
      if ($('sim-label-4')) $('sim-label-4').innerHTML = '<span class="t" lang="es">Evasión continua (Rover v2)</span><span class="t" lang="en">Continuous dodge (Rover v2)</span>';
    } else if (robotModel === 'luigi_lab3') {
      if ($('luigi-sim-badge')) {
        $('luigi-sim-badge').innerHTML = '<span class="t" lang="es">Caso Luigi · Rover v1 Sim-to-Real Físico (50 Hz)</span><span class="t" lang="en">Luigi Case · Rover v1 Physical Sim-to-Real (50 Hz)</span>';
      }
      if ($('luigi-sim-title')) {
        $('luigi-sim-title').innerHTML = '<span class="t" lang="es">Rover de Luigi (v1) · HC-SR04 Fijo + Radar IR APDS-9960</span><span class="t" lang="en">Luigi’s Rover (v1) · Fixed HC-SR04 + APDS-9960 IR Radar</span>';
      }
      if ($('luigi-sim-desc')) {
        $('luigi-sim-desc').innerHTML = '<span class="t" lang="es">Primera versión del robot físico de Luigi D’Aquaro (chasis negro de 150 mm, 6 piezas STL) con ultrasónico frontal fijo <code>HC-SR04</code>, radar infrarrojo <code>APDS-9960 (0x9E)</code> sobre soporte superior y arnés Dupont completo.</span><span class="t" lang="en">First version of Luigi D’Aquaro’s physical rover (150 mm matte-black chassis, 6 STL parts) with fixed front <code>HC-SR04</code>, overhead <code>APDS-9960 (0x9E)</code> IR radar, and full Dupont wire harness.</span>';
      }
      if ($('sim-label-1')) $('sim-label-1').textContent = 'HC-SR04 (Trig D9 / Echo A1)';
      if ($('sim-label-2')) $('sim-label-2').textContent = 'APDS-9960 IR (Reg 0x9C)';
      if ($('sim-label-3')) $('sim-label-3').innerHTML = '<span class="t" lang="es">Puente H L298N (Izq / Der)</span><span class="t" lang="en">L298N H-Bridge (L / R)</span>';
      if ($('sim-label-4')) $('sim-label-4').innerHTML = '<span class="t" lang="es">Estado de evasión (4 etapas)</span><span class="t" lang="en">Dodge state (4 stages)</span>';
    } else if (robotModel === 'factory_cell') {
      lastFactoryStage = -1;
      if ($('luigi-sim-badge')) {
        $('luigi-sim-badge').innerHTML = '<span class="t" lang="es">Línea PackML / ISA-88 · 4 Estaciones + Recetas HMI</span><span class="t" lang="en">PackML / ISA-88 Line · 4 Stations + HMI Recipes</span>';
      }
      if ($('luigi-sim-title')) {
        $('luigi-sim-title').innerHTML = '<span class="t" lang="es">Línea Industrial · Pesaje + Visión Cognex + Sellado + Paletizado</span><span class="t" lang="en">Industrial Line · Weigher + Cognex Vision + Sealer + Palletizer</span>';
      }
      if ($('luigi-sim-desc')) {
        $('luigi-sim-desc').innerHTML = '<span class="t" lang="es">Flujo de izquierda a derecha: <strong>1. Tolva (HOPPER-01)</strong> alimenta la caja; <strong>2. Prensa Azul (PRESS-01)</strong> baja en el centro para sellar la tapa; <strong>3. Avance</strong> lleva la caja al final; <strong>4. Pistón Rojo (PUSHER-01)</strong> la descarga al palet.</span><span class="t" lang="en">Left-to-right flow: <strong>1. Hopper (HOPPER-01)</strong> feeds the box; <strong>2. Blue Press (PRESS-01)</strong> descends at center to seal the lid; <strong>3. Belt</strong> carries box to exit; <strong>4. Red Pusher (PUSHER-01)</strong> discharges it to the pallet.</span>';
      }
      if ($('sim-label-1')) $('sim-label-1').innerHTML = '<span class="t" lang="es">Variador VFD + Cinta / Pistón</span><span class="t" lang="en">VFD Drive + Belt / Pusher</span>';
      if ($('sim-label-2')) $('sim-label-2').innerHTML = '<span class="t" lang="es">Prensa Azul + Sensores PE1..PE3</span><span class="t" lang="en">Blue Press + Sensors PE1..PE3</span>';
      if ($('sim-label-3')) $('sim-label-3').innerHTML = '<span class="t" lang="es">Lotes OK / Merma</span><span class="t" lang="en">Batches OK / Waste</span>';
      if ($('sim-label-4')) $('sim-label-4').innerHTML = '<span class="t" lang="es">Etapa Actual (PackML)</span><span class="t" lang="en">Current Stage (PackML)</span>';
    }
  }
  syncRobotDependentUI();

  // Shows the current clip on the robot. Its RobotMotion comes from the saved ones if there is one;
  // otherwise it is computed in slices, with its progress on the label, so the page keeps working.
  async function copyCurrent() {
    const view = robot.view;
    if (!view || !current || isCustomRobot()) return;
    const { clip } = current;
    if (!motions.has(clip.id)) {
      const saved = await savedMotion(clip.id);
      if (saved) motions.set(clip.id, saved);
      else {
        setRobotLabel(T('computing'));
        const computed = await view.retarget(clip, {
          onProgress: (done) => current?.clip === clip && setRobotLabel(T('computingPct', { pct: Math.round(100 * done) })),
        });
        if (!computed) return; // the user left the screen
        motions.set(clip.id, computed.motion);
      }
    }
    if (current?.clip !== clip) return; // the user chose another clip meanwhile
    motion = motions.get(clip.id);
    if (motion?.qpos?.length && robot.view) {
      const dx = Math.abs(motion.qpos.at(-1)[0] - motion.qpos[0][0]);
      const dy = Math.abs(motion.qpos.at(-1)[1] - motion.qpos[0][1]);
      if (dx + dy > 0.4) robot.view._streetAlongX = dx > dy;
    }
    resume();
  }

  function startMotion() {
    if (!robot.view || !motion || imitating() || isCustomRobot()) return;
    robot.view.playClip(motion);
    robot.view.seek(skeleton.time);
    copying = true;
    setRobotLabel();
  }

  // Loads a training checkpoint. It ends the clip (the robot goes physical), so the clip resumes after.
  async function loadLevel(id) {
    const view = robot.view;
    if (!view) return;
    const seq = ++loadSeq;
    $('policy').disabled = true;
    root.querySelector('.push').disabled = true;
    setRobotLabel(T('loadingPolicy'));
    try {
      const { onnx, json } = policyUrls(id);
      // An imitation policy also needs the RobotMotion of the clip it learned.
      const imitation = imitationOf(id);
      const isCustom = isCustomRobot(imitation?.robot);
      const activeClipId = current?.clip?.id;
      const clipBalancedId =
        imitation && !isCustom && activeClipId && (imitation.robot ?? 'unitree_g1') === 'unitree_g1' && matchesImitation(imitation, activeClipId)
          ? `${activeClipId}-balanced`
          : null;
      const motionId = clipBalancedId ?? imitation?.motion ?? imitation?.clip;
      const learned =
        imitation &&
        !isCustom &&
        (motions.get(motionId) ??
          (await savedMotion(motionId)) ??
          (imitation.motion ? await savedMotion(imitation.motion) : null));
      if (seq !== loadSeq) return;
      await view.loadPolicy(onnx, json, imitation && !isCustom ? { motion: learned } : {});
      if (seq !== loadSeq) return;
      const [px, py] = view.sim.bodyPosition('pelvis');
      if (imitation?.robot === 'factory_cell') {
        view.viewer.targetHeight = 0.42;
        view.viewer.controls.minDistance = 0.35;
        view.viewer.controls.target.set(px + 0.1, 0.42, -py + 0.12);
        view.viewer.camera.position.set(px + 0.15, 1.38, -py - 2.55);
        view.viewer.controls.update();
      } else if (isCustom) {
        view.viewer.targetHeight = 0.09;
        view.viewer.controls.minDistance = 0.25;
        view.viewer.controls.target.set(px, 0.09, -py);
        view.viewer.camera.position.set(px + 1.05, 0.72, -py - 0.95);
        view.viewer.controls.update();
      } else if (activeClipId === 'clip_lavar-04-gvhmr') {
        view.viewer.targetHeight = 0.78;
        view.viewer.controls.minDistance = 0.65;
        view.viewer.controls.target.set(px, 0.78, -py + 0.18);
        view.viewer.camera.position.set(px + 2.1, 1.55, -py + 1.85);
        view.viewer.controls.update();
      } else {
        view.viewer.targetHeight = 0.75;
        view.viewer.controls.minDistance = 0.65;
        view.viewer.controls.target.set(px, 0.75, -py);
        view.viewer.camera.position.set(px + 2.05, 1.25, -py - 1.35);
        view.viewer.controls.update();
      }
      if (learned?.qpos?.length) {
        const dx = Math.abs(learned.qpos.at(-1)[0] - learned.qpos[0][0]);
        const dy = Math.abs(learned.qpos.at(-1)[1] - learned.qpos[0][1]);
        if (dx + dy > 0.4) view._streetAlongX = dx > dy;
      }
      syncSitChair(view, !isCustom && activeClipId === 'clip_sentarse-02-gvhmr');
      syncWashSink(view, !isCustom && activeClipId === 'clip_lavar-04-gvhmr');
      level = id;
      loadedClipId = imitation ? (activeClipId ?? imitation.clip) : null;
      robotModel = imitation?.robot ?? 'unitree_g1';
      if ($('robot-model')) $('robot-model').value = robotModel;
      syncRobotDependentUI();
      refreshLook();
      if (imitation) skeleton.time = 0; // the robot starts the clip from its first pose
    } catch (error) {
      if (seq !== loadSeq) return;
      console.error(error);
      $('policy').value = level;
      setRobotLabel(T('policyFailed'));
    } finally {
      if (seq === loadSeq) {
        $('policy').disabled = false;
        root.querySelector('.push').disabled = !robot.view; // never before the robot is there
      }
    }
    if (seq !== loadSeq) return;
    // The user may have picked another clip while it loaded: an imitation is only for its own clip.
    if (imitating() && robotModel !== 'unitree_h1' && !isCustomRobot() && !matchesImitation(imitationOf(level), current?.clip.id)) {
      $('policy').value = FINAL_LEVEL;
      return loadLevel(FINAL_LEVEL);
    }
    copying = false;
    resume();
  }

  // Another world: a world on the stones scene reloads the model (a moment), and the clip resumes after.
  async function setWorld(id) {
    const view = robot.view;
    if (!view) return;
    $('world').disabled = true;
    root.querySelector('.push').disabled = true;
    setRobotLabel(T('changingWorld'));
    try {
      await view.setWorld(WORLDS.find((world) => world.id === id));
      await dressPlace(view); // a new world rebuilds the drawn geoms: dress the place again
      syncSitChair(view, current?.clip?.id === 'clip_sentarse-02-gvhmr');
      syncWashSink(view, current?.clip?.id === 'clip_lavar-04-gvhmr');
      refreshLook();
    } catch (error) {
      console.error(error);
      setRobotLabel(T('worldFailed'));
    } finally {
      $('world').disabled = false;
      root.querySelector('.push').disabled = !robot.view; // never before the robot is there
    }
    copying = false;
    syncSliders(); // the new world's own values
    resume();
  }

  // Another place (a kitchen, a warehouse, a sidewalk): its furniture is solid and its loose objects
  // can be knocked over. It rebuilds the model (a moment), and the clip resumes after.
  async function setPlace(id) {
    const view = robot.view;
    if (!view) return;
    $('place').disabled = true;
    root.querySelector('.push').disabled = true;
    setRobotLabel(T('buildingPlace'));
    try {
      await view.setScene(SCENES.find((scene) => scene.id === id) ?? null);
      await dressPlace(view); // real models over the place's boxes and cylinders
      syncSitChair(view, current?.clip?.id === 'clip_sentarse-02-gvhmr');
      syncWashSink(view, current?.clip?.id === 'clip_lavar-04-gvhmr');
      setFloor(view, id); // and its floor: tiles, concrete or sidewalk
      refreshLook();
    } catch (error) {
      console.error(error);
      setRobotLabel(T('placeFailed'));
    } finally {
      $('place').disabled = false;
      root.querySelector('.push').disabled = !robot.view; // never before the robot is there
    }
    syncRobotDependentUI();
    copying = false;
    resume();
  }

  robot.ready.then(async (view) => {
    if (!view) return;
    view.setSpeed(speed);
    if (!playing) view.pause();
    if (isCustomRobot()) {
      await loadLevel(CUSTOM_ROBOT_POLICY[robotModel]);
      return;
    }
    refreshLook();
    await loadLevel(FINAL_LEVEL); // standing with its policy: physics from the first frame
    if (current) {
      const targetPlace = current.clip.id === 'clip_lavar-04-gvhmr' ? 'cocina' : '';
      if ($('place') && targetPlace === 'cocina' && $('place').value !== 'cocina') {
        $('place').value = 'cocina';
        autoPlaced = true;
        await setPlace('cocina');
      }
      await physicsFor(current.clip);
    }
    copyCurrent(); // the puppet reference, ready for the "sin física" mode
  });

  root.querySelectorAll('[data-quick-robot]').forEach((btn) => {
    btn.onclick = () => {
      const nextRobot = btn.dataset.quickRobot;
      if ($('robot-model') && nextRobot) {
        $('robot-model').value = nextRobot;
        $('robot-model').dispatchEvent(new Event('change'));
        history.replaceState(null, '', `#/simulations/${nextRobot}`);
      }
    };
  });

  $('policy').onchange = (event) => loadLevel(event.target.value);
  $('world').onchange = (event) => setWorld(event.target.value);
  if ($('robot-model')) {
    $('robot-model').onchange = async (event) => {
      robotModel = event.target.value;
      const nextHash = robotModel === 'unitree_g1' ? '#/simulations' : `#/simulations/${robotModel}`;
      if (location.hash !== nextHash) history.replaceState(null, '', nextHash);
      if (robotModel === 'unitree_h1' || isCustomRobot()) {
        const customIm = IMITATIONS.find((im) => im.robot === robotModel);
        if (customIm) {
          const opt = $('policy').querySelector(`option[value="${customIm.id}"]`);
          if (opt) opt.disabled = false;
          $('policy').value = customIm.id;
          physics = true;
          if (isCustomRobot() && $('stage')) {
            $('stage').dataset.show = 'robot';
          }
          await loadLevel(customIm.id);
        }
      } else {
        if ($('stage')) {
          $('stage').dataset.show = 'both';
        }
        const g1Im = imitationFor(current?.clip, 'unitree_g1');
        const nextId = physics && g1Im ? g1Im.id : FINAL_LEVEL;
        $('policy').value = nextId;
        await loadLevel(nextId);
      }
    };
  }

  // Live Arduino UNO WebSerial bridge + gesture command buttons (robot_gestos.ino @ 9600 baud).
  let serialWriter = null;
  let onnxPatrolTimer = null;
  let lastHwDistCm = 999;
  const CMD_SPECS = {
    F: { ctrl: [15.5, 15.5], ms: 1500, es: 'F · Avanzar (PWM 190, 1,5 s)', en: 'F · Forward (PWM 190, 1.5 s)' },
    B: { ctrl: [-12.5, -12.5], ms: 1000, es: 'B · Retroceder (PWM 150, 1,0 s)', en: 'B · Reverse (PWM 150, 1.0 s)' },
    L: { ctrl: [-13.0, 13.0], ms: 450, es: 'L · Giro Izquierda (PWM 160, 0,45 s)', en: 'L · Turn Left (PWM 160, 0.45 s)' },
    R: { ctrl: [13.0, -13.0], ms: 450, es: 'R · Giro Derecha (PWM 160, 0,45 s)', en: 'R · Turn Right (PWM 160, 0.45 s)' },
    S: { ctrl: [0, 0], ms: 2000, es: 'S · Detenido (Modo Manual)', en: 'S · Stopped (Manual Mode)' },
  };
  function stopOnnxPatrolStream() {
    if (onnxPatrolTimer) {
      clearInterval(onnxPatrolTimer);
      onnxPatrolTimer = null;
    }
  }
  function startOnnxPatrolStream() {
    stopOnnxPatrolStream();
    if (!robot.view?.sim) return;
    robot.view.sim._usbLocked = false;
    robot.view.sim._serialCmd = null;
    onnxPatrolTimer = setInterval(() => {
      const sim = robot.view?.sim;
      if (!sim || sim._usbLocked) return;
      const st = $('arduino-status');
      // If the real HC-SR04 ultrasonic sensor on the physical robot sees an obstacle < 22 cm,
      // inject a closed-loop escape impulse into both MuJoCo and the physical Arduino!
      if (lastHwDistCm < 22) {
        sim.data.ctrl[0] = -14.0;
        sim.data.ctrl[1] = -6.0;
        if (serialWriter) serialWriter.write(new TextEncoder().encode('B')).catch(() => {});
        if (st) {
          st.innerHTML = `<span class="t" lang="es">🤖 <strong>ONNX + HC-SR04 Físico (${lastHwDistCm} cm &lt; 22 cm)</strong> → ⚠️ Evasión: <strong>Reversa + Giro (B)</strong></span><span class="t" lang="en">🤖 <strong>ONNX + Physical HC-SR04 (${lastHwDistCm} cm &lt; 22 cm)</strong> → ⚠️ Dodge: <strong>Reverse + Turn (B)</strong></span>`;
        }
        return;
      }
      const cL = sim.data.ctrl[0] ?? 0;
      const cR = sim.data.ctrl[1] ?? 0;
      const avg = 0.5 * (cL + cR);
      const diff = cR - cL;
      let hwCmd = 'F';
      if (avg < -2) hwCmd = 'B';
      else if (diff > 4.5) hwCmd = 'L';
      else if (diff < -4.5) hwCmd = 'R';
      else if (Math.abs(avg) < 1) hwCmd = 'S';
      if (serialWriter) {
        serialWriter.write(new TextEncoder().encode(hwCmd)).catch(() => {});
      }
      if (st) {
        const distInfo = lastHwDistCm < 900 ? ` · HC-SR04: <strong>${lastHwDistCm} cm</strong>` : '';
        st.innerHTML = `<span class="t" lang="es">🤖 <strong>Red ONNX al volante</strong> → Ruedas: <code>[${cL.toFixed(1)}, ${cR.toFixed(1)}] rad/s</code> → USB: <strong>${hwCmd}</strong>${distInfo}</span><span class="t" lang="en">🤖 <strong>ONNX Policy driving</strong> → Wheels: <code>[${cL.toFixed(1)}, ${cR.toFixed(1)}] rad/s</code> → USB: <strong>${hwCmd}</strong>${distInfo}</span>`;
      }
    }, 320);
  }
  function applyArduinoCmd(cmd, fromHw = false, distCm = null, safety = false) {
    if (!robot.view?.sim) return;
    if (distCm !== null) lastHwDistCm = distCm;
    if (cmd === 'AUTO') {
      if (serialWriter) serialWriter.write(new TextEncoder().encode('A')).catch(() => {});
      startOnnxPatrolStream();
      return;
    }
    // When ONNX patrol is active, do not let idle 'S' telemetry from the Arduino cancel the neural network!
    if (fromHw && onnxPatrolTimer) {
      if (safety || (distCm !== null && distCm < 22)) {
        robot.view.sim.data.ctrl[0] = -14.0;
        robot.view.sim.data.ctrl[1] = -6.0;
      }
      return;
    }
    // In manual/gesture mode, ignore periodic 'S' status prints while a button command is still running
    if (fromHw && cmd === 'S' && robot.view.sim._serialCmd && performance.now() < robot.view.sim._serialCmd.until) {
      return;
    }
    stopOnnxPatrolStream();
    const spec = CMD_SPECS[cmd];
    if (!spec) return;
    robot.view.sim._usbLocked = true;
    robot.view.sim._serialCmd = {
      ctrl: spec.ctrl,
      until: cmd === 'S' ? 0 : fromHw ? performance.now() + 500 : performance.now() + spec.ms,
    };
    const st = $('arduino-status');
    if (st) {
      const distTxt = distCm !== null ? ` · HC-SR04: <strong>${distCm} cm</strong>` : '';
      const safeEs = safety ? ' · ⚠️ <strong>SEGURIDAD (&lt;20 cm)</strong>' : '';
      const safeEn = safety ? ' · ⚠️ <strong>SAFETY (&lt;20 cm)</strong>' : '';
      st.innerHTML = `<span class="t" lang="es">${fromHw ? '🔌 Arduino UNO en vivo' : '🎮 Comando manual'}: <strong>${spec.es}</strong>${distTxt}${safeEs}</span><span class="t" lang="en">${fromHw ? '🔌 Live Arduino UNO' : '🎮 Manual command'}: <strong>${spec.en}</strong>${distTxt}${safeEn}</span>`;
    }
    if (!fromHw && serialWriter) {
      serialWriter.write(new TextEncoder().encode(cmd)).catch(() => {});
    }
  }
  root.querySelectorAll('#arduino-box [data-cmd]').forEach((btn) => {
    btn.onclick = () => {
      root.querySelectorAll('#arduino-box [data-cmd]').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
      applyArduinoCmd(btn.dataset.cmd, false);
    };
  });
  if ($('arduino-connect')) {
    $('arduino-connect').onclick = async () => {
      const st = $('arduino-status');
      if (!('serial' in navigator)) {
        if (st) {
          st.innerHTML = `<span class="t" lang="es">Abre este link en Google Chrome para usar WebSerial con el cable USB del Arduino.</span><span class="t" lang="en">Open this page in Google Chrome to use WebSerial with the Arduino USB cable.</span>`;
        }
        return;
      }
      try {
        const port = await navigator.serial.requestPort();
        await port.open({ baudRate: 9600 });
        if (robot.view?.sim) {
          robot.view.sim._usbLocked = true;
          robot.view.sim._serialCmd = null;
          robot.view.reset();
        }
        $('arduino-connect').setAttribute('aria-pressed', 'true');
        $('arduino-connect').innerHTML = `<span class="t" lang="es">✅ USB Conectado (9600)</span><span class="t" lang="en">✅ USB Connected (9600)</span>`;
        if (st) {
          st.innerHTML = `<span class="t" lang="es">Conectado a 9600 baud. Pasa la mano frente al APDS-9960 o acerca un objeto al HC-SR04.</span><span class="t" lang="en">Connected at 9600 baud. Wave your hand over the APDS-9960 or bring an object near the HC-SR04.</span>`;
        }
        if (port.writable) serialWriter = port.writable.getWriter();
        const reader = port.readable.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        (async () => {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            const lines = buf.split(/\r?\n/);
            buf = lines.pop() ?? '';
            for (const line of lines) {
              const gMatch = line.match(/Gesto\s*->\s*([FBLRS])/);
              if (gMatch) applyArduinoCmd(gMatch[1], true);
              const dMatch = line.match(/Dist:\s*(\d+)\s*cm\s*\|\s*Accion:\s*([FBLRS])/);
              if (dMatch) {
                const dist = Number(dMatch[1]);
                const act = dMatch[2];
                const safe = line.includes('SEGURIDAD');
                applyArduinoCmd(act, true, dist, safe);
              }
            }
          }
        })().catch((err) => console.warn('Serial read ended:', err));
      } catch (err) {
        if (st) st.textContent = `No se pudo abrir el puerto USB: ${err.message}`;
      }
    };
  }

  // Physical object grasping, soapy/wet slip, and gravity release with dynamic liquid spheres.
  const graspButtons = [root.querySelector('#hold-dry'), root.querySelector('#hold-wet'), root.querySelector('#drop-obj')].filter(Boolean);
  const setGraspStatus = (key, activeBtn) => {
    graspButtons.forEach((b) => b.setAttribute('aria-pressed', String(b === activeBtn)));
    const status = $('grasp-status');
    if (!status) return;
    if (!key) {
      status.hidden = true;
      return;
    }
    status.hidden = false;
    status.innerHTML = T(key);
  };
  if ($('hold-dry')) {
    $('hold-dry').onclick = async () => {
      if (!robot.view) return;
      copying = false;
      await robot.view.holdObject({ wet: false });
      await dressPlace(robot.view);
      refreshLook();
      setRobotLabel();
      setGraspStatus('graspHoldingDry', $('hold-dry'));
    };
  }
  if ($('hold-wet')) {
    $('hold-wet').onclick = async () => {
      if (!robot.view) return;
      copying = false;
      await robot.view.holdObject({ wet: true });
      await dressPlace(robot.view);
      refreshLook();
      setRobotLabel();
      setGraspStatus('graspHoldingWet', $('hold-wet'));
    };
  }
  if ($('drop-obj')) {
    $('drop-obj').onclick = () => {
      if (!robot.view) return;
      robot.view.dropObject();
      setGraspStatus('graspDropped', $('drop-obj'));
    };
  }

  // Conditions by hand: each slider sets one value at once (view.setConditions), over the world.
  const sliders = [...root.querySelectorAll('input[data-condition]')];
  // Each language with its own decimal mark: "0,85" / "0.85".
  const decimal = (value, digits) => LANGS.map((l) => `<span class="t" lang="${l}">${fmt(value, digits)(l)}</span>`).join('');
  const showValue = (key, value) => {
    const out = root.querySelector(`output[data-condition="${key}"]`);
    if (key === 'friction') out.innerHTML = decimal(value, 2);
    // The force comes from physics/ (view.conditions), so the drag formula lives in one place.
    else if (key === 'wind_mps') out.innerHTML = value ? `${decimal(value, 0)} m/s · ${decimal(robot.view?.conditions().wind_newtons ?? 0, 0)} N` : T('noWind');
    else out.innerHTML = `×${decimal(value, 2)}`;
  };
  function syncSliders() {
    const view = robot.view;
    if (!view) return;
    const current = view.conditions();
    for (const slider of sliders) {
      slider.value = current[slider.dataset.condition];
      slider.disabled = false;
      showValue(slider.dataset.condition, Number(slider.value));
    }
  }
  for (const slider of sliders) {
    slider.oninput = () => {
      const value = Number(slider.value);
      robot.view?.setConditions({ [slider.dataset.condition]: value });
      showValue(slider.dataset.condition, value);
    };
  }
  robot.ready.then(syncSliders);
  let autoPlaced = false;
  $('place').onchange = (event) => {
    autoPlaced = false;
    setPlace(event.target.value);
  };
  $('play').onclick = () => {
    playing = !playing;
    if (robot.view) playing ? robot.view.play() : robot.view.pause();
    $('play').innerHTML = playing ? ICONS.pause : ICONS.play;
    S($('play'), { 'aria-label': playing ? 'pause' : 'play', title: playing ? 'pause' : 'play' });
  };
  $('speed').onclick = () => {
    speed = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length];
    robot.view?.setSpeed(speed);
    const digits = speed === 1 ? 0 : speed === 0.5 ? 1 : 2;
    $('speed').innerHTML = LANGS.map((l) => `<span class="t" lang="${l}">${fmt(speed, digits)(l)}×</span>`).join('');
  };
  // The physics switch only means something for a clip a policy learned: elsewhere it says so.
  function showMode(clip) {
    const learned = imitationFor(clip) !== null;
    root.querySelector('[data-physics="on"]').disabled = !learned;
    // Each note has a short phone version (.only-narrow, style.css).
    root.querySelector('.mode-note').innerHTML = learned
      ? `<span class="only-wide">${T('modeLearnedWide')}</span><span class="only-narrow">${T('modeLearnedNarrow')}</span>`
      : `<span class="only-wide">${T('modeNoneWide')}</span><span class="only-narrow">${T('modeNoneNarrow')}</span>`;
    root.querySelectorAll('[data-physics]').forEach((b) => b.setAttribute('aria-pressed', String((b.dataset.physics === 'on') === (learned && physics))));
  }

  // Physics on or off (see `physics`).
  for (const button of root.querySelectorAll('[data-physics]')) {
    button.onclick = async () => {
      physics = button.dataset.physics === 'on';
      root.querySelectorAll('[data-physics]').forEach((b) => b.setAttribute('aria-pressed', String(b === button)));
      syncRobotDependentUI();
      if (!robot.view) return;
      if (physics) {
        robot.view.stop(); // the puppet stands back up, on its own motors
        copying = false;
        await physicsFor(current?.clip);
      } else if (imitating()) {
        $('policy').value = FINAL_LEVEL;
        await loadLevel(FINAL_LEVEL); // ends with resume(): the puppet replay
      } else resume();
    };
  }
  $('reset').onclick = () => {
    skeleton.time = 0;
    if (!withPhysics() && motion && !imitating()) startMotion();
    else robot.view?.reset(); // the policy puts the robot back in its first pose (standing or the clip's)
  };

  // An imitation option is only for the clip it learned; leaving that clip goes back to standing.
  function offerImitations(clip) {
    for (const imitation of IMITATIONS) {
      const option = $('policy').querySelector(`option[value="${imitation.id}"]`);
      if (option) option.disabled = imitation.robot !== 'unitree_h1' && !isCustomRobot(imitation.robot) && !matchesImitation(imitation, clip.id);
    }
    if (imitating() && robotModel !== 'unitree_h1' && !isCustomRobot() && !matchesImitation(imitationOf(level), clip.id)) {
      $('policy').value = FINAL_LEVEL;
      loadLevel(FINAL_LEVEL);
    }
  }

  function setFactoryMode(fixedTimer) {
    const sim = robot.view?.sim;
    if (!sim) return;
    sim._factoryFixedTimerMode = Boolean(fixedTimer);
    lastFactoryStage = -1;
    if ($('factory-mode-sensor')) $('factory-mode-sensor').setAttribute('aria-pressed', String(!sim._factoryFixedTimerMode));
    if ($('factory-fault-btn')) $('factory-fault-btn').setAttribute('aria-pressed', String(sim._factoryFixedTimerMode));
    if ($('factory-status-note')) {
      $('factory-status-note').innerHTML = sim._factoryFixedTimerMode
        ? `<span class="t" lang="es"><strong>⚠️ Modo Timer Fijo:</strong> La banda patina 28 %, la caja llega tarde y la <strong>Prensa Azul (PRESS-01)</strong> le pone el sello torcido en el borde; luego el <strong>Pistón Rojo (PUSHER-01)</strong> la expulsa a la bandeja de rechazo.</span><span class="t" lang="en"><strong>⚠️ Fixed-Timer Mode:</strong> Belt slips 28%, the box arrives late so the <strong>Blue Press (PRESS-01)</strong> stamps the seal crooked on the edge; then the <strong>Red Pusher (PUSHER-01)</strong> pushes it into the reject tray.</span>`
        : `<span class="t" lang="es"><strong>🔵 Prensa Azul (PRESS-01):</strong> Sella el tope de la caja en el centro (PE-02). <strong>📦 Rampa y Palet (PALLET-01):</strong> Las cajas buenas bajan por la rampa y se van apilando (1 a 6). <strong>🔴 Pistón Rojo (PUSHER-01):</strong> Solo se activa si hay una caja mal sellada para sacarla a rechazo.</span><span class="t" lang="en"><strong>🔵 Blue Press (PRESS-01):</strong> Seals the box top at center (PE-02). <strong>📦 Ramp &amp; Pallet (PALLET-01):</strong> Good boxes slide down the ramp and stack (1 to 6). <strong>🔴 Red Pusher (PUSHER-01):</strong> Only fires on mis-sealed boxes to push them into the reject tray.</span>`;
    }
  }
  if ($('factory-mode-sensor')) {
    $('factory-mode-sensor').onclick = () => setFactoryMode(false);
  }
  if ($('factory-fault-btn')) {
    $('factory-fault-btn').onclick = () => setFactoryMode(true);
  }

  const FACTORY_FORMAT_SPECS = {
    '250g': {
      scale: [0.78, 0.82, 0.76],
      es: 'Receta PLC (250 g): <code>VFD=58.5Hz · Rampa=0.24s · Prensa=109mm · Pistón=140mm</code>',
      en: 'PLC Recipe (250 g): <code>VFD=58.5Hz · Ramp=0.24s · Press=109mm · Pusher=140mm</code>',
    },
    '500g': {
      scale: [1.0, 1.0, 1.0],
      es: 'Receta PLC (500 g): <code>VFD=50.0Hz · Rampa=0.35s · Prensa=97mm · Pistón=130mm</code>',
      en: 'PLC Recipe (500 g): <code>VFD=50.0Hz · Ramp=0.35s · Press=97mm · Pusher=130mm</code>',
    },
    '1000g': {
      scale: [1.26, 1.18, 1.24],
      es: 'Receta PLC (1 kg): <code>VFD=41.5Hz · Rampa=0.52s · Prensa=84mm · Pistón=120mm</code>',
      en: 'PLC Recipe (1 kg): <code>VFD=41.5Hz · Ramp=0.52s · Press=84mm · Pusher=120mm</code>',
    },
  };
  root.querySelectorAll('[data-factory-format]').forEach((btn) => {
    btn.onclick = () => {
      const fmtKey = btn.dataset.factoryFormat;
      const spec = FACTORY_FORMAT_SPECS[fmtKey] || FACTORY_FORMAT_SPECS['500g'];
      root.querySelectorAll('[data-factory-format]').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
      if (robot.view?.sim) {
        robot.view.sim._factoryFormat = fmtKey;
        lastFactoryStage = -1;
        const { mujoco, model } = robot.view.sim;
        const boxGeomId = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_GEOM.value, 'package_box');
        const gEntry = robot.view.viewer?.geoms?.find((g) => g.id === boxGeomId);
        if (gEntry?.object) {
          gEntry.object.scale.set(...spec.scale);
        }
      }
      if ($('factory-recipe-readout')) {
        $('factory-recipe-readout').innerHTML = `<span class="t" lang="es">${spec.es}</span><span class="t" lang="en">${spec.en}</span>`;
      }
    };
  });

  if ($('luigi-reset-arena')) {
    $('luigi-reset-arena').onclick = () => {
      if (robot.view?.sim) {
        robot.view.sim._usbLocked = false;
        robot.view.sim._serialCmd = null;
        robot.view.sim._factoryCrushedCount = 0;
        robot.view.sim._factoryCycles = 0;
        robot.view.sim._lastFactoryCycleIdx = undefined;
      }
      lastFactoryStage = -1;
      robot.view?.reset();
      if (robot.view?.viewer) {
        const [px, py] = robot.view.sim.bodyPosition('pelvis');
        const h = robotModel === 'factory_cell' ? 0.42 : 0.09;
        robot.view.viewer.targetHeight = h;
        robot.view.viewer.controls.target.set(px + (robotModel === 'factory_cell' ? 0.1 : 0), h, -py + (robotModel === 'factory_cell' ? 0.12 : 0));
        robot.view.viewer.camera.position.set(px + (robotModel === 'factory_cell' ? 0.15 : 1.05), robotModel === 'factory_cell' ? 1.38 : 0.72, -py - (robotModel === 'factory_cell' ? 2.55 : 0.95));
        robot.view.viewer.controls.update();
      }
      root.querySelectorAll('#arduino-box [data-cmd]').forEach((b) => {
        b.setAttribute('aria-pressed', String(b.dataset.cmd === 'AUTO'));
      });
    };
  }
  syncRobotDependentUI();

  return {
    /** @param {import('./contract.js').PoseClip} clip  @param {string} title */
    showClip(clip, title) {
      skeleton.setClip(clip);
      $('human-label').innerHTML = T('person', { title }); // title: markup, one span per language
      current = { clip, title };
      syncRobotDependentUI();
      showMode(clip);
      overlay.show(clip.id).catch(console.error);
      motion = motions.get(clip.id) ?? null;
      if (isCustomRobot()) return;
      if (robot.view) {
        robot.view._streetAlongX = clip.id.includes('frente') || clip.id === 'clip_caminar-01-gvhmr';
        syncSitChair(robot.view, clip.id === 'clip_sentarse-02-gvhmr');
        syncWashSink(robot.view, clip.id === 'clip_lavar-04-gvhmr');
      }
      offerImitations(clip);
      const targetPlace = clip.id === 'clip_lavar-04-gvhmr' ? 'cocina' : '';
      if (robot.view && $('place') && (targetPlace === 'cocina' || autoPlaced) && $('place').value !== targetPlace) {
        $('place').value = targetPlace;
        autoPlaced = targetPlace !== '';
        setPlace(targetPlace).then(() => {
          physicsFor(clip);
          if (!motion) copyCurrent();
        });
        return;
      }
      physicsFor(clip);
      if (!motion) copyCurrent();
    },
    dispose() {
      stopOnnxPatrolStream();
      cancelAnimationFrame(frameId);
      skeleton.dispose();
      overlay.dispose();
      const view = robot.view;
      // The app shares one robot: the next screen starts on flat, empty ground with the Unitree G1.
      if (view) {
        look?.undo();
        look = null;
        clearStageProps(view); // removes chair, sink, and custom floor so nothing leaks to landing/#live
        if (view.sim) {
          view.sim._usbLocked = false;
          view.sim._serialCmd = null;
          view.sim.sensorReadout = null;
        }
        view.viewer.targetHeight = 0.75;
        view.viewer.controls.minDistance = 0.65;
        if (view.world() && view.world().id !== 'plano') {
          view.setWorld(WORLDS.find((world) => world.id === 'plano'));
        }
        if (view.scene()) {
          view.setScene(null);
        }
      }
      robot.dispose();
    },
  };
}
