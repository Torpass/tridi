// Ver simulaciones: the gallery of preloaded clips and the stage with the person and the robot.
import { mountGallery } from '../gallery.js';
import { appHeaderHTML, mountAppHeader } from '../header.js';
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
  'clip_frente-correr-01-gvhmr',
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

const DIRECT_ROBOTS = {
  luigi_lab3: 'luigi-lab3',
  luigi_lab4: 'luigi-lab4',
  factory_cell: 'factory-cell',
};

export function mount(root, { api }, [clipId] = []) {
  const isCustomRobotLink = Boolean(DIRECT_ROBOTS[clipId]);
  const initRobot = isCustomRobotLink ? clipId : 'unitree_g1';
  const initPolicy = DIRECT_ROBOTS[clipId] ?? FINAL_LEVEL;
  root.innerHTML = `
    <section class="page sims">
      ${appHeaderHTML({ current: 'simulations' })}
      <div class="sims-grid">
        <div class="sims-main">
          <div id="stage" data-show="${isCustomRobotLink ? 'robot' : 'both'}">
            <section class="pane" id="human-pane">
              <canvas id="human"></canvas>
              <p class="pane-label" id="human-label">${T('personLabel')}</p>
            </section>
            ${robotPaneHTML('Robot')}
          </div>
          <div id="controls" class="controls">
            <section class="control-group" id="playback-group" aria-labelledby="ctl-play">
              <h3 id="ctl-play">${T('playback')}</h3>
              <div class="player">
                <button id="play" class="icon-btn primary" type="button" ${A({ 'aria-label': 'pause', title: 'pause' })}>${ICONS.pause}</button>
                <button id="reset" class="icon-btn" type="button" ${A({ 'aria-label': 'restart', title: 'restart' })}>${ICONS.restart}</button>
                <button id="speed" class="icon-btn speed" type="button" ${A({ 'aria-label': 'speed', title: 'speedTitle' })}>1×</button>
              </div>
              <div class="mode" id="physics-mode-group" role="group" ${A({ 'aria-label': 'how' })}>
                <button type="button" data-physics="on" aria-pressed="true">${T('physicsOn')}</button>
                <button type="button" data-physics="off" aria-pressed="false">${T('physicsOff')}</button>
              </div>
              <p class="mode-note" id="physics-mode-note">${T('modeNote')}</p>
            </section>
            <section class="control-group" id="conditions-group" aria-labelledby="ctl-world">
              <h3 id="ctl-world">${T('conditions')}</h3>
              <div class="fields">
                <label class="field wide">${T('robotModel')}
                  <select id="robot-model">
                    <optgroup ${A({ label: 'vertHumanoids' })}>
                      ${ROBOT_MODELS.filter((r) => r.vertical === 'humanoids').map(({ id, label }) => option(id, robotName(id, label), id === initRobot ? 'selected' : '')).join('')}
                    </optgroup>
                    <optgroup ${A({ label: 'vertRovers' })}>
                      ${ROBOT_MODELS.filter((r) => r.vertical === 'rovers').map(({ id, label }) => option(id, robotName(id, label), id === initRobot ? 'selected' : '')).join('')}
                    </optgroup>
                    <optgroup ${A({ label: 'vertIndustrial' })}>
                      ${ROBOT_MODELS.filter((r) => r.vertical === 'industrial').map(({ id, label }) => option(id, robotName(id, label), id === initRobot ? 'selected' : '')).join('')}
                    </optgroup>
                  </select>
                </label>
                <label class="field" id="world-field">${T('world')}
                  <select id="world">
                    ${WORLDS.map(({ id, title }) => option(id, worldName(id, title), id === 'plano' ? 'selected' : '')).join('')}
                  </select>
                </label>
                <label class="field" id="place-field">${T('place')}
                  <select id="place">
                    <option value="" selected ${X('noFurniture')}>${t('noFurniture')}</option>
                    ${SCENES.filter(({ id }) => id !== 'vereda').map(({ id, title }) => option(id, sceneName(id, title))).join('')}
                  </select>
                </label>
                <label class="field wide" id="policy-field" hidden>${T('trainedWith')}
                  <select id="policy">
                    ${LEVELS.map(({ id, label }) => option(id, levelName(id, label), id === initPolicy ? 'selected' : '')).join('')}
                    ${IMITATIONS.length ? `<optgroup ${A({ label: 'imitates' })}>${IMITATIONS.map(({ id, label }) => option(id, levelName(id, label), id === initPolicy ? 'selected' : 'disabled')).join('')}</optgroup>` : ''}
                  </select>
                </label>
              </div>
              <div class="grasp-box" id="grasp-box" hidden>
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
              <span class="card-badge trained" id="luigi-sim-badge"><span class="t" lang="es">Sim-to-Real · Lazo Cerrado</span><span class="t" lang="en">Sim-to-Real · Closed-Loop</span></span>
              <h2 id="luigi-sim-title"><span class="t" lang="es">Telemetría de Sensores en MuJoCo</span><span class="t" lang="en">Live Sensor Telemetry in MuJoCo</span></h2>
              <p class="train-text" id="luigi-sim-desc">
                <span class="t" lang="es">El robot diferencial simula el cono ultrasónico <code>HC-SR04</code> (±24°), el radar IR <code>APDS-9960 (0x9C)</code>, el cuello móvil <code>SG90</code> y colisiones sólidas en una arena de 3,4 m × 3,4 m.</span>
                <span class="t" lang="en">The differential robot simulates the <code>HC-SR04</code> ultrasonic cone (±24°), the <code>APDS-9960 (0x9C)</code> IR radar, the <code>SG90</code> pan neck, and solid collisions inside a 3.4 m × 3.4 m arena.</span>
              </p>
            </div>
            <div class="luigi-telemetry-grid">
              <div class="luigi-tel-card">
                <span id="sim-label-1">HC-SR04 (Trig D9 / Echo A1)</span>
                <strong id="sim-hcsr04">120 cm</strong>
              </div>
              <div class="luigi-tel-card">
                <span id="sim-label-2">APDS-9960 IR (Reg 0x9C)</span>
                <strong id="sim-apds">18 / 255</strong>
              </div>
              <div class="luigi-tel-card">
                <span id="sim-label-3"><span class="t" lang="es">Puente H L298N (Izq / Der)</span><span class="t" lang="en">L298N H-Bridge (L / R)</span></span>
                <strong id="sim-wheels">[15.5, 15.5] rad/s</strong>
              </div>
              <div class="luigi-tel-card">
                <span id="sim-label-4"><span class="t" lang="es">Estado de evasión (4 etapas)</span><span class="t" lang="en">Dodge state (4 stages)</span></span>
                <strong id="sim-dodge-state"><span class="t" lang="es">Crucero ONNX (50 Hz)</span><span class="t" lang="en">ONNX Cruise (50 Hz)</span></strong>
              </div>
            </div>
            <div class="luigi-drive-box" id="factory-fault-box" hidden>
              <span class="luigi-drive-label"><span class="t" lang="es">1. Modo de Control PLC (Studio 5000 / TIA Portal)</span><span class="t" lang="en">1. PLC Control Mode (Studio 5000 / TIA Portal)</span></span>
              <div class="luigi-drive-grid" role="group" style="grid-template-columns:minmax(0,1fr)">
                <button type="button" class="luigi-cmd-btn wrap-btn" id="factory-mode-sensor" aria-pressed="true">
                  <span class="t" lang="es">✅ Gemelo Tridi · Fotoceldas PE1..PE3 + Rampa VFD (0 % merma)</span><span class="t" lang="en">✅ Tridi Twin · PE1..PE3 Sensors + VFD Ramp (0% waste)</span>
                </button>
                <button type="button" class="luigi-cmd-btn wrap-btn" id="factory-fault-btn" aria-pressed="false">
                  <span class="t" lang="es">⚠️ Estresar Timer Fijo · 28 % Patinaje (Caja llega tarde → Mal sellada → Pistón Rojo la rechaza)</span><span class="t" lang="en">⚠️ Stress Fixed Timer · 28% Belt Slip (Box arrives late → Mis-sealed → Red Pusher rejects it)</span>
                </button>
              </div>
              <span class="luigi-drive-label" style="margin-top:8px"><span class="t" lang="es">2. Cambio de Formato HMI (Recetas ISA-88 / PackML)</span><span class="t" lang="en">2. HMI Format Change (ISA-88 / PackML Recipes)</span></span>
              <div class="luigi-drive-grid" role="group" style="grid-template-columns:repeat(3,minmax(0,1fr))">
                <button type="button" class="luigi-cmd-btn" data-factory-format="250g" aria-pressed="false">
                  <span class="t" lang="es">📦 250 g</span><span class="t" lang="en">📦 250 g</span>
                </button>
                <button type="button" class="luigi-cmd-btn" data-factory-format="500g" aria-pressed="true">
                  <span class="t" lang="es">📦 500 g</span><span class="t" lang="en">📦 500 g</span>
                </button>
                <button type="button" class="luigi-cmd-btn" data-factory-format="1000g" aria-pressed="false">
                  <span class="t" lang="es">📦 1 kg</span><span class="t" lang="en">📦 1 kg</span>
                </button>
              </div>
              <p class="mode-note factory-recipe-box" id="factory-recipe-readout">
                <span class="t" lang="es">Receta PLC (500 g): <code>VFD=50.0Hz · Rampa=0.35s · Prensa=95mm · Pistón=360mm</code></span>
                <span class="t" lang="en">PLC Recipe (500 g): <code>VFD=50.0Hz · Ramp=0.35s · Press=95mm · Pusher=360mm</code></span>
              </p>
              <p class="mode-note" id="factory-status-note">
                <span class="t" lang="es"><strong>🔵 Prensa Azul (PRESS-01):</strong> Sella el tope de la caja en el centro (PE-02). <strong>📦 Rampa y Palet (PALLET-01):</strong> Las cajas buenas bajan por la rampa y se van apilando (1 a 6). <strong>🔴 Pistón Rojo (PUSHER-01):</strong> Solo se activa si hay una caja mal sellada para sacarla a rechazo.</span>
                <span class="t" lang="en"><strong>🔵 Blue Press (PRESS-01):</strong> Seals the box top at center (PE-02). <strong>📦 Ramp &amp; Pallet (PALLET-01):</strong> Good boxes slide down the ramp and stack (1 to 6). <strong>🔴 Red Pusher (PUSHER-01):</strong> Only fires on mis-sealed boxes to push them into the reject tray.</span>
              </p>
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
            <div class="train-actions-stack">
              <button type="button" class="button primary" id="luigi-reset-arena">
                <span class="t" lang="es">Reiniciar rover en centro de arena</span><span class="t" lang="en">Reset rover at arena center</span>
              </button>
            </div>
          </section>
          ${trainBoxHTML()}
          <ul id="gallery"></ul>
        </aside>
      </div>
    </section>`;
  const unHeader = mountAppHeader(root);
  // The physics sliders are open on wide screens; on phones they fold under "Ajustar la física"
  // (style.css hides the toggle on wide screens), so the scene and the clips come first.
  root.querySelector('.tune').open = !matchMedia('(max-width: 720px)').matches;
  const stage = mountStage(root, { initialRobot: initRobot });
  const trainBox = mountTrainBox(root.querySelector('.train-box'), api);
  mountGallery(root, stage, isCustomRobotLink ? undefined : clipId, trainBox.show, { hide: HIDDEN_CLIPS });
  return () => {
    unHeader();
    trainBox.dispose();
    stage.dispose();
  };
}

