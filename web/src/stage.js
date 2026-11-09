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
import { SCENES, WORLDS } from 'tridi-physics';

import { savedMotion } from './motions.js';
import { FINAL_LEVEL, IMITATIONS, imitationOf, policyUrls } from './policies.js';
import { dressWorld } from './looks/index.js';
import { dressPlace, setFloor, syncSitChair } from './props.js';
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
  let playing = true;
  let speed = 1;
  let robotModel = initialRobot;
  let level = initialRobot === 'luigi_lab3' ? 'luigi-lab3' : $('policy').value;
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
  const withPhysics = () => physics && (robotModel === 'luigi_lab3' || imitationFor(current?.clip) !== null);

  // After any change (checkpoint, world, place): the puppet replay unless the clip moves with physics.
  function resume() {
    if (robotModel === 'luigi_lab3') {
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
    if (robotModel === 'luigi_lab3') return resume();
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
    if (imitating() && robotModel !== 'luigi_lab3' && robot.view) skeleton.time = robot.view.clipTime();
    else if (playing) skeleton.advance(wall * speed);
    if (copying && robot.view) robot.view.seek(skeleton.time);
    look?.update(wall);
    if (robotModel === 'luigi_lab3' && robot.view?.sim?.sensorReadout) {
      const sr = robot.view.sim.sensorReadout;
      const elHc = $('sim-hcsr04');
      const elApds = $('sim-apds');
      const elWh = $('sim-wheels');
      const elSt = $('sim-dodge-state');
      if (elHc) elHc.textContent = `${sr.distCm} cm`;
      if (elApds) elApds.textContent = `${sr.irProx} / 255`;
      if (elWh) {
        const c0 = (robot.view.sim.data.ctrl[0] ?? 0).toFixed(1);
        const c1 = (robot.view.sim.data.ctrl[1] ?? 0).toFixed(1);
        elWh.textContent = `[${c0}, ${c1}] rad/s`;
      }
      if (elSt && sr.dodgeStage !== lastDodgeStage) {
        lastDodgeStage = sr.dodgeStage;
        const stages = [
          { es: 'Crucero ONNX (50 Hz)', en: 'ONNX Cruise (50 Hz)' },
          { es: '1/4 · Freno (-20 rad/s)', en: '1/4 · Brake (-20 rad/s)' },
          { es: '2/4 · Reversa despeje', en: '2/4 · Reverse clear' },
          { es: '3/4 · Giro 90°', en: '3/4 · 90° Pivot' },
        ];
        const stObj = stages[sr.dodgeStage] ?? stages[0];
        elSt.innerHTML = `<span class="t" lang="es">${stObj.es}</span><span class="t" lang="en">${stObj.en}</span>`;
        elSt.style.color = sr.dodgeStage > 0 ? '#ff6a3d' : '#c8ff2e';
      }
    }
    overlay.sync(skeleton.time, playing, speed);
    skeleton.render();
    frameId = requestAnimationFrame(frame);
  });

  function syncRobotDependentUI() {
    const isLuigi = robotModel === 'luigi_lab3';
    if ($('arduino-box')) $('arduino-box').hidden = !isLuigi;
    if ($('grasp-box')) $('grasp-box').hidden = isLuigi;
    if ($('place-field')) $('place-field').hidden = isLuigi;
    if ($('policy-field')) $('policy-field').hidden = isLuigi;
    if ($('show')) $('show').hidden = isLuigi;
    if ($('physics-mode-group')) $('physics-mode-group').hidden = isLuigi;
    if ($('physics-mode-note')) $('physics-mode-note').hidden = isLuigi;
    if ($('luigi-sim-panel')) $('luigi-sim-panel').hidden = !isLuigi;
    if ($('pick-heading')) $('pick-heading').hidden = isLuigi;
    if ($('gallery')) $('gallery').hidden = isLuigi;
    const tBox = root.querySelector('.train-box');
    if (tBox) tBox.hidden = isLuigi || !current;
    if (isLuigi && $('stage')) {
      $('stage').dataset.show = 'robot';
      if ($('show')) $('show').value = 'robot';
    }
  }

  // Shows the current clip on the robot. Its RobotMotion comes from the saved ones if there is one;
  // otherwise it is computed in slices, with its progress on the label, so the page keeps working.
  async function copyCurrent() {
    const view = robot.view;
    if (!view || !current) return;
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
    if (!robot.view || !motion || imitating() || robotModel === 'luigi_lab3') return;
    robot.view.playClip(motion);
    robot.view.seek(skeleton.time);
    copying = true;
    setRobotLabel();
  }

  // Loads a training checkpoint. It ends the clip (the robot goes physical), so the clip resumes after.
  async function loadLevel(id) {
    const view = robot.view;
    if (!view) return;
    $('policy').disabled = true;
    root.querySelector('.push').disabled = true;
    setRobotLabel(T('loadingPolicy'));
    try {
      const { onnx, json } = policyUrls(id);
      // An imitation policy also needs the RobotMotion of the clip it learned.
      const imitation = imitationOf(id);
      const isLuigi = imitation?.robot === 'luigi_lab3';
      const activeClipId = current?.clip?.id;
      const clipBalancedId =
        imitation && !isLuigi && activeClipId && (imitation.robot ?? 'unitree_g1') === 'unitree_g1' && matchesImitation(imitation, activeClipId)
          ? `${activeClipId}-balanced`
          : null;
      const motionId = clipBalancedId ?? imitation?.motion ?? imitation?.clip;
      const learned =
        imitation &&
        !isLuigi &&
        (motions.get(motionId) ??
          (await savedMotion(motionId)) ??
          (imitation.motion ? await savedMotion(imitation.motion) : null));
      await view.loadPolicy(onnx, json, imitation && !isLuigi ? { motion: learned } : {});
      const [px, py] = view.sim.bodyPosition('pelvis');
      if (isLuigi) {
        view.viewer.targetHeight = 0.09;
        view.viewer.controls.minDistance = 0.25;
        view.viewer.controls.target.set(px, 0.09, -py);
        view.viewer.camera.position.set(px + 1.05, 0.72, -py - 0.95);
        view.viewer.controls.update();
      } else {
        view.viewer.targetHeight = 0.75;
        view.viewer.controls.minDistance = 0.65;
        view.viewer.controls.target.set(px, 0.75, -py);
        view.viewer.camera.position.set(px + 2.6, 1.5, -py - 1.6);
        view.viewer.controls.update();
      }
      if (learned?.qpos?.length) {
        const dx = Math.abs(learned.qpos.at(-1)[0] - learned.qpos[0][0]);
        const dy = Math.abs(learned.qpos.at(-1)[1] - learned.qpos[0][1]);
        if (dx + dy > 0.4) view._streetAlongX = dx > dy;
      }
      syncSitChair(view, !isLuigi && activeClipId === 'clip_sentarse-02-gvhmr');
      level = id;
      loadedClipId = imitation ? (activeClipId ?? imitation.clip) : null;
      robotModel = imitation?.robot ?? 'unitree_g1';
      if ($('robot-model')) $('robot-model').value = robotModel;
      syncRobotDependentUI();
      refreshLook();
      if (imitation) skeleton.time = 0; // the robot starts the clip from its first pose
    } catch (error) {
      console.error(error);
      $('policy').value = level;
      setRobotLabel(T('policyFailed'));
    } finally {
      $('policy').disabled = false;
      root.querySelector('.push').disabled = !robot.view; // never before the robot is there
    }
    // The user may have picked another clip while it loaded: an imitation is only for its own clip.
    if (imitating() && robotModel !== 'unitree_h1' && robotModel !== 'luigi_lab3' && !matchesImitation(imitationOf(level), current?.clip.id)) {
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
      setFloor(view, id); // and its floor: tiles, concrete or sidewalk
      refreshLook();
    } catch (error) {
      console.error(error);
      setRobotLabel(T('placeFailed'));
    } finally {
      $('place').disabled = false;
      root.querySelector('.push').disabled = !robot.view; // never before the robot is there
    }
    copying = false;
    resume();
  }

  robot.ready.then(async (view) => {
    if (!view) return;
    refreshLook();
    view.setSpeed(speed);
    if (!playing) view.pause();
    if (robotModel === 'luigi_lab3') {
      await loadLevel('luigi-lab3');
      return;
    }
    await loadLevel(FINAL_LEVEL); // standing with its policy: physics from the first frame
    if (current) await physicsFor(current.clip);
    copyCurrent(); // the puppet reference, ready for the "sin física" mode
  });

  $('show').onchange = (event) => ($('stage').dataset.show = event.target.value);
  $('policy').onchange = (event) => loadLevel(event.target.value);
  $('world').onchange = (event) => setWorld(event.target.value);
  if ($('robot-model')) {
    $('robot-model').onchange = async (event) => {
      robotModel = event.target.value;
      if (robotModel === 'unitree_h1' || robotModel === 'luigi_lab3') {
        const customIm = IMITATIONS.find((im) => im.robot === robotModel);
        if (customIm) {
          const opt = $('policy').querySelector(`option[value="${customIm.id}"]`);
          if (opt) opt.disabled = false;
          $('policy').value = customIm.id;
          physics = true;
          if (robotModel === 'luigi_lab3' && $('show')) {
            $('show').value = 'robot';
            $('stage').dataset.show = 'robot';
          }
          await loadLevel(customIm.id);
        }
      } else {
        if ($('show') && $('show').value === 'robot') {
          $('show').value = 'both';
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
    $('speed').innerHTML = `${decimal(speed, speed === 1 ? 0 : speed === 0.5 ? 1 : 2)}×`;
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
      if (option) option.disabled = imitation.robot !== 'unitree_h1' && imitation.robot !== 'luigi_lab3' && !matchesImitation(imitation, clip.id);
    }
    if (imitating() && robotModel !== 'unitree_h1' && robotModel !== 'luigi_lab3' && !matchesImitation(imitationOf(level), clip.id)) {
      $('policy').value = FINAL_LEVEL;
      loadLevel(FINAL_LEVEL);
    }
  }

  if ($('luigi-reset-arena')) {
    $('luigi-reset-arena').onclick = () => {
      if (robot.view?.sim) {
        robot.view.sim._usbLocked = false;
        robot.view.sim._serialCmd = null;
      }
      robot.view?.reset();
      if (robot.view?.viewer) {
        const [px, py] = robot.view.sim.bodyPosition('pelvis');
        robot.view.viewer.targetHeight = 0.09;
        robot.view.viewer.controls.target.set(px, 0.09, -py);
        robot.view.viewer.camera.position.set(px + 1.05, 0.72, -py - 0.95);
        robot.view.viewer.controls.update();
      }
      root.querySelectorAll('#arduino-box [data-cmd]').forEach((b) => {
        b.setAttribute('aria-pressed', String(b.dataset.cmd === 'AUTO'));
      });
    };
  }
  if ($('luigi-back-g1')) {
    $('luigi-back-g1').onclick = () => {
      if ($('robot-model')) {
        $('robot-model').value = 'unitree_g1';
        $('robot-model').dispatchEvent(new Event('change'));
      }
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
      if (robot.view) {
        robot.view._streetAlongX = clip.id.includes('frente') || clip.id === 'clip_caminar-01-gvhmr';
        syncSitChair(robot.view, clip.id === 'clip_sentarse-02-gvhmr');
      }
      const targetPlace = clip.id === 'clip_lavar-04-gvhmr' ? 'cocina' : '';
      if (robot.view && $('place') && (targetPlace === 'cocina' || autoPlaced) && $('place').value !== targetPlace) {
        $('place').value = targetPlace;
        autoPlaced = targetPlace !== '';
        setPlace(targetPlace);
      }
      offerImitations(clip);
      showMode(clip);
      overlay.show(clip.id).catch(console.error);
      motion = motions.get(clip.id) ?? null;
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
        setFloor(view, null); // the viewer's own floor again
        if (view.sim) {
          view.sim._usbLocked = false;
          view.sim._serialCmd = null;
          view.sim.sensorReadout = null;
        }
        view.viewer.targetHeight = 0.75;
        view.viewer.controls.minDistance = 0.65;
        const restoreRobot =
          view.sim?.policy?.robot && view.sim.policy.robot !== 'unitree_g1'
            ? (() => {
                const { onnx, json } = policyUrls(FINAL_LEVEL);
                return view.loadPolicy(onnx, json);
              })()
            : Promise.resolve();
        restoreRobot
          .then(() => (view.world() && view.world().id !== 'plano' ? view.setWorld(WORLDS.find((world) => world.id === 'plano')) : null))
          .then(() => view.scene() && view.setScene(null));
      }
      robot.dispose();
    },
  };
}
