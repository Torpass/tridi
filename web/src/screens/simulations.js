// Ver simulaciones: the gallery of preloaded clips and the stage with the person and the robot.
import { mountGallery } from '../gallery.js';
import { SCENES, WORLDS } from 'tridi-physics';
import { FINAL_LEVEL, IMITATIONS, LEVELS, ROBOT_MODELS } from '../policies.js';
import { robotPaneHTML } from '../robot-pane.js';
import { ICONS, mountStage } from '../stage.js';
import { mountTrainBox, trainBoxHTML } from '../training.js';
import { option } from '../i18n.js';
import { A, T, X, t } from '../strings-stage.js';
import { levelName, robotName, sceneName, worldName } from '../strings-names.js';

export const title = { es: 'Simulaciones', en: 'Simulations' };

// Clips left out of this gallery; they stay in preloaded.json because the landing, the delivery
// and the trained walking policy still use them. The walk and the run are MediaPipe captures: this
// branch shows capture 2.0 (GVHMR, data/capture2) instead, which reads clearly better side by side
// (Juan, 2026-11-05). Group jumping jacks and jumps-and-squats are also hidden per Juan's review.
const HIDDEN_CLIPS = [
  'clip_2026-10-23_caminar-perfil_01',
  'clip_2026-10-23_correr-perfil_01',
  'clip_synthetic_march_01',
  'clip_jacks-grupo-01-gvhmr',
  'clip_caminar-02-gvhmr',
];

// The conditions you can set by hand (view.setConditions in physics/). Ranges cover every world in
// physics/worlds and a bit beyond: grip from wet tile (0.2) to rough concrete (1.2); wind up to
// 20 m/s, a gale of about 60 N on the torso; mass and motors ±20 % (below 0.7 the motors cannot
// hold the robot up even still).
export const CONDITIONS = [
  // label: a key of strings-stage.js
  { key: 'friction', label: 'friction', min: 0.2, max: 1.2, step: 0.05 },
  { key: 'wind_mps', label: 'wind_mps', min: 0, max: 20, step: 1 },
  { key: 'mass_scale', label: 'mass_scale', min: 0.8, max: 1.2, step: 0.05 },
  { key: 'motor_scale', label: 'motor_scale', min: 0.7, max: 1.2, step: 0.05 },
];

export function mount(root, { api }, [clipId] = []) {
  const isLuigiLink = clipId === 'luigi_lab3';
  const initRobot = isLuigiLink ? 'luigi_lab3' : 'unitree_g1';
  const initPolicy = isLuigiLink ? 'luigi-lab3' : FINAL_LEVEL;
  root.innerHTML = `
    <section class="page sims">
      <header class="page-head">
        <a class="back" href="#/" ${A({ 'aria-label': 'back' })}>←<span class="only-wide">&nbsp;${T('back')}</span></a>
        <h1>${T('title')}</h1>
      </header>
      <div class="sims-grid">
        <div class="sims-main">
          <div id="stage" data-show="${isLuigiLink ? 'robot' : 'both'}">
            <section class="pane" id="human-pane">
              <canvas id="human"></canvas>
              <p class="pane-label" id="human-label">${T('personLabel')}</p>
            </section>
            ${robotPaneHTML('Robot')}
          </div>
          <div id="controls" class="controls">
            <section class="control-group" aria-labelledby="ctl-play">
              <h3 id="ctl-play">${T('playback')}</h3>
              <div class="player">
                <button id="play" class="icon-btn primary" type="button" ${A({ 'aria-label': 'pause', title: 'pause' })}>${ICONS.pause}</button>
                <button id="reset" class="icon-btn" type="button" ${A({ 'aria-label': 'restart', title: 'restart' })}>${ICONS.restart}</button>
                <button id="speed" class="icon-btn speed" type="button" ${A({ 'aria-label': 'speed', title: 'speedTitle' })}>1×</button>
                <select id="show" ${A({ 'aria-label': 'what' })}>
                  <option value="both" ${isLuigiLink ? '' : 'selected'} ${X('both')}>${t('both')}</option>
                  <option value="human" ${X('onlyHuman')}>${t('onlyHuman')}</option>
                  <option value="robot" ${isLuigiLink ? 'selected' : ''} ${X('onlyRobot')}>${t('onlyRobot')}</option>
                </select>
              </div>
              <div class="mode" id="physics-mode-group" role="group" ${A({ 'aria-label': 'how' })}>
                <button type="button" data-physics="on" aria-pressed="true">${T('physicsOn')}</button>
                <button type="button" data-physics="off" aria-pressed="false">${T('physicsOff')}</button>
              </div>
              <p class="mode-note" id="physics-mode-note">${T('modeNote')}</p>
            </section>
            <section class="control-group" aria-labelledby="ctl-world">
              <h3 id="ctl-world">${T('conditions')}</h3>
              <div class="fields">
                <label class="field wide">${T('robotModel')}
                  <select id="robot-model">
                    ${ROBOT_MODELS.map(({ id, label }) => option(id, robotName(id, label), id === initRobot ? 'selected' : '')).join('')}
                  </select>
                </label>
                <label class="field">${T('world')}
                  <select id="world">
                    ${WORLDS.map(({ id, title }) => option(id, worldName(id, title), id === 'plano' ? 'selected' : '')).join('')}
                  </select>
                </label>
                <label class="field" id="place-field">${T('place')}
                  <select id="place">
                    <option value="" selected ${X('noFurniture')}>${t('noFurniture')}</option>
                    ${SCENES.map(({ id, title }) => option(id, sceneName(id, title))).join('')}
                  </select>
                </label>
                <label class="field wide" id="policy-field">${T('trainedWith')}
                  <select id="policy">
                    ${LEVELS.map(({ id, label }) => option(id, levelName(id, label), id === initPolicy ? 'selected' : '')).join('')}
                    ${IMITATIONS.length ? `<optgroup ${A({ label: 'imitates' })}>${IMITATIONS.map(({ id, label }) => option(id, levelName(id, label), id === initPolicy ? 'selected' : 'disabled')).join('')}</optgroup>` : ''}
                  </select>
                </label>
              </div>
              <div class="grasp-box" id="grasp-box">
                <p class="mode-note">${T('objectsHead')}</p>
                <div class="mode grasp-actions" role="group" ${A({ 'aria-label': 'objectsHead' })}>
                  <button type="button" id="hold-dry" aria-pressed="false">${T('holdDry')}</button>
                  <button type="button" id="hold-wet" aria-pressed="false">${T('holdWet')}</button>
                  <button type="button" id="drop-obj" aria-pressed="false">${T('dropObj')}</button>
                </div>
                <p class="mode-note" id="grasp-status" hidden></p>
              </div>
              <details class="tune">
              <summary>${T('tune')}</summary>
              <div class="sliders">
                ${CONDITIONS.map(({ key, label, min, max, step }) => `
                <label class="slider">
                  <span class="slider-head"><span>${T(label)}</span><output data-condition="${key}"></output></span>
                  <input type="range" data-condition="${key}" min="${min}" max="${max}" step="${step}" disabled />
                </label>`).join('')}
              </div>
              <p class="conditions-note">${T('conditionsNote')}</p>
              </details>
            </section>
          </div>
        </div>
        <aside class="sims-list">
          <section class="luigi-sim-panel" id="luigi-sim-panel" hidden>
            <div class="luigi-sim-head">
              <span class="card-badge trained"><span class="t" lang="es">Sim-to-Real · Lazo Cerrado</span><span class="t" lang="en">Sim-to-Real · Closed-Loop</span></span>
              <h2><span class="t" lang="es">Telemetría de Sensores en MuJoCo</span><span class="t" lang="en">Live Sensor Telemetry in MuJoCo</span></h2>
              <p class="train-text">
                <span class="t" lang="es">El robot diferencial simula el cono ultrasónico <code>HC-SR04</code> (±24°), el radar IR <code>APDS-9960 (0x9C)</code>, el arnés de cables Dupont y colisiones sólidas en una arena de 3,4 m × 3,4 m.</span>
                <span class="t" lang="en">The differential robot simulates the <code>HC-SR04</code> ultrasonic cone (±24°), the <code>APDS-9960 (0x9C)</code> IR radar, Dupont jumper harness, and solid collisions inside a 3.4 m × 3.4 m arena.</span>
              </p>
            </div>
            <div class="luigi-telemetry-grid">
              <div class="luigi-tel-card">
                <span>HC-SR04 (Trig D9 / Echo A1)</span>
                <strong id="sim-hcsr04">120 cm</strong>
              </div>
              <div class="luigi-tel-card">
                <span>APDS-9960 IR (Reg 0x9C)</span>
                <strong id="sim-apds">18 / 255</strong>
              </div>
              <div class="luigi-tel-card">
                <span><span class="t" lang="es">Puente H L298N (Izq / Der)</span><span class="t" lang="en">L298N H-Bridge (L / R)</span></span>
                <strong id="sim-wheels">[15.5, 15.5] rad/s</strong>
              </div>
              <div class="luigi-tel-card">
                <span><span class="t" lang="es">Estado de evasión (4 etapas)</span><span class="t" lang="en">Dodge state (4 stages)</span></span>
                <strong id="sim-dodge-state"><span class="t" lang="es">Crucero ONNX (50 Hz)</span><span class="t" lang="en">ONNX Cruise (50 Hz)</span></strong>
              </div>
            </div>
            <div class="luigi-drive-box" id="arduino-box">
              <span class="luigi-drive-label"><span class="t" lang="es">Control de Marcha y Política ONNX</span><span class="t" lang="en">Drive &amp; ONNX Policy Control</span></span>
              <div class="luigi-drive-grid" role="group">
                <button type="button" class="luigi-cmd-btn" data-cmd="AUTO" aria-pressed="true">
                  <span class="t" lang="es">🤖 Patrulla ONNX</span><span class="t" lang="en">🤖 ONNX Patrol</span>
                </button>
                <button type="button" class="luigi-cmd-btn" data-cmd="F" aria-pressed="false">
                  <span class="t" lang="es">⬆️ Avanzar</span><span class="t" lang="en">⬆️ Forward</span>
                </button>
                <button type="button" class="luigi-cmd-btn" data-cmd="B" aria-pressed="false">
                  <span class="t" lang="es">⬇️ Reversa</span><span class="t" lang="en">⬇️ Reverse</span>
                </button>
                <button type="button" class="luigi-cmd-btn" data-cmd="L" aria-pressed="false">
                  <span class="t" lang="es">⬅️ Giro Izq</span><span class="t" lang="en">⬅️ Turn Left</span>
                </button>
                <button type="button" class="luigi-cmd-btn" data-cmd="R" aria-pressed="false">
                  <span class="t" lang="es">➡️ Giro Der</span><span class="t" lang="en">➡️ Turn Right</span>
                </button>
                <button type="button" class="luigi-cmd-btn" data-cmd="S" aria-pressed="false">
                  <span class="t" lang="es">⏹ Detener</span><span class="t" lang="en">⏹ Stop</span>
                </button>
              </div>
              <p class="mode-note" id="arduino-status">
                <span class="t" lang="es">Modo activo: <strong>Crucero autónomo ONNX (50 Hz) + evasión en 4 etapas</strong>.</span>
                <span class="t" lang="en">Active mode: <strong>Autonomous 50 Hz ONNX cruise + 4-stage obstacle evasion</strong>.</span>
              </p>
            </div>
            <div class="train-actions-row">
              <button type="button" class="button primary" id="luigi-reset-arena">
                <span class="t" lang="es">Reiniciar en centro de arena</span><span class="t" lang="en">Reset at arena center</span>
              </button>
              <button type="button" class="button" id="luigi-back-g1">
                <span class="t" lang="es">Volver a Unitree G1 (Humanoide)</span><span class="t" lang="en">Switch back to Unitree G1</span>
              </button>
            </div>
          </section>
          ${trainBoxHTML()}
          <h2 id="pick-heading">${T('pick')}</h2>
          <ul id="gallery"></ul>
        </aside>
      </div>
    </section>`;
  // The physics sliders are open on wide screens; on phones they fold under "Ajustar la física"
  // (style.css hides the toggle on wide screens), so the scene and the clips come first.
  root.querySelector('.tune').open = !matchMedia('(max-width: 720px)').matches;
  const stage = mountStage(root, { initialRobot: initRobot });
  const trainBox = mountTrainBox(root.querySelector('.train-box'), api);
  mountGallery(root, stage, isLuigiLink ? undefined : clipId, trainBox.show, { hide: HIDDEN_CLIPS });
  return () => {
    trainBox.dispose();
    stage.dispose();
  };
}

