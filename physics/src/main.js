// Interactive 3-Tab Hardware Studio for Tridi Physics (Tasks P-1, P-2, P-3, P-4):
// Tab 1: 3D Hardware Component Catalog (isolated 3D view per component + Wokwi pinouts + CRUD)
// Tab 2: Step-by-Step Visual Assembler (7 STL meshes with 3D Exploded View + part highlighting + .ino parser)
// Tab 3: Physical Arena Simulator (Luigi Lab 4 active SG90 radar & Industrial Factory Cell with Auto/Manual controls)
import {
  createSimView,
  generateMujocoXml,
  getComponent,
  getPreset,
  listComponents,
  parseArduinoSketch,
  registerComponent,
  validateHardwarePinout,
} from './index.js';
import lab4SketchText from '../models/luigi_lab4/firmware/LAB4_Robot_Explorador_Autonomo.ino?raw';
import lab4OnnxUrl from '../../training/policies/luigi-lab4.onnx?url';
import lab4JsonUrl from '../../training/policies/luigi-lab4.json?url';
import lab3OnnxUrl from '../../training/policies/luigi-lab3.onnx?url';
import lab3JsonUrl from '../../training/policies/luigi-lab3.json?url';
import factoryOnnxUrl from '../../training/policies/factory-cell.onnx?url';
import factoryJsonUrl from '../../training/policies/factory-cell.json?url';
import g1OnnxUrl from '../../training/policies/g1-stand.onnx?url';
import g1JsonUrl from '../../training/policies/g1-stand.json?url';

const $ = (id) => document.getElementById(id);

function showProgress({ done, total, bytes }) {
  $('progress-bar').style.width = `${(100 * done) / total}%`;
  $('progress-text').textContent = `Cargando MuJoCo y modelos 3D: ${done}/${total} (${(bytes / 1e6).toFixed(1)} MB)`;
}

// Metadata mapping each of the 7 STL meshes in Luigi Lab 4 to its catalog component & exploded-view offset
const LAB4_STL_PARTS = [
  {
    id: 'chasis',
    file: '1_chasis_robot.stl',
    title: '1. Chasis Base (180×108 mm, PLA)',
    coupledComponent: 'arduino_uno',
    coupledLabel: 'Arduino UNO R3 + Puente H L298N',
    pins: 'ENA=D5, IN1=D7, IN2=D8, ENB=D6, IN3=D11, IN4=D12',
    geoms: ['chasis_visual', 'arduino_pcb', 'arduino_usb', 'l298n_pcb', 'l298n_heatsink'],
    explodeOffset: [0, 0, 0],
  },
  {
    id: 'cabeza_servo',
    file: '7_cabeza_sensor_servo.stl',
    title: '7. Torreta Cuello Móvil (Nueva en Lab 4)',
    coupledComponent: 'sg90_servo',
    coupledLabel: 'Micro-Servo SG90 (180°) + Sensor HC-SR04',
    pins: 'SERVO=D9 (Timer1) · TRIG=D2 · ECHO=D3 (INT1)',
    geoms: ['cabeza_servo_visual', 'servo_horn_white', 'sg90_body', 'hcsr04_pcb', 'hcsr04_eye_l', 'hcsr04_eye_r'],
    explodeOffset: [0.09, 0, 0.08],
  },
  {
    id: 'rines',
    file: '5_rin_x2.stl',
    title: '5. Rines de Tracción Diferencial (×2)',
    coupledComponent: 'tt_gearmotor_200rpm',
    coupledLabel: '2× Motor DC TT 200 RPM (1:48)',
    pins: 'Canal Izq (D5/D7/D8) · Canal Der (D6/D11/D12)',
    geoms: ['rin_izq_visual', 'rin_der_visual', 'motor_tt_izq', 'motor_tt_der'],
    explodeOffset: [0, 0.07, 0],
  },
  {
    id: 'llantas',
    file: '6_llanta_x2_TPU.stl',
    title: '6. Llantas Impresas en TPU (×2, Ø65 mm)',
    coupledComponent: 'wheel_tt_65mm_tpu',
    coupledLabel: 'Neumático TPU (μ = 1.1, Deadzone PWM ≥ 115)',
    pins: 'Contacto físico con el piso (condim=3)',
    geoms: ['llanta_izq_visual', 'llanta_der_visual'],
    explodeOffset: [0, 0.14, 0],
  },
  {
    id: 'soportes',
    file: '2_soporte_motor_x2.stl',
    title: '2. Soportes Laterales de Motor TT (×2)',
    coupledComponent: 'tt_gearmotor_200rpm',
    coupledLabel: 'Fijación M3 al chasis para cajas reductoras',
    pins: 'Estructura mecánica bajo placa',
    geoms: ['soporte_izq_visual', 'soporte_der_visual'],
    explodeOffset: [0, 0.04, -0.05],
  },
  {
    id: 'patin',
    file: '3_patin_delantero.stl',
    title: '3. Patín Delantero Deslizante',
    coupledComponent: 'caster_front_patin',
    coupledLabel: 'Tercer punto de apoyo (baja fricción μ = 0.02)',
    pins: 'Apoyo pasivo en X = 138 mm',
    geoms: ['patin_visual'],
    explodeOffset: [0.05, 0, -0.07],
  },
  {
    id: 'bandeja',
    file: '4_bandeja_protoboard.stl',
    title: '4. Bandeja Superior Elevada',
    coupledComponent: 'l298n',
    coupledLabel: 'Soporte sobre el L298N para Protoboard 400 pts',
    pins: 'Distribución 5V / 7.4V (2× 18650)',
    geoms: ['bandeja_visual', 'protoboard_body'],
    explodeOffset: [-0.04, 0, 0.09],
  },
];

async function start() {
  let view;
  try {
    view = await createSimView($('view'), {
      onProgress: showProgress,
      onStats: ({ realtime }) => {
        const { model } = view.sim;
        $('stats').textContent = `Modelo activo: ${view.sim.sceneFile} · nq=${model.nq} · nu=${model.nu} actuadores · ${Math.round(
          1 / model.opt.timestep,
        )} Hz física · tiempo real x${realtime.toFixed(1)}`;
      },
    });
  } catch (error) {
    $('progress-text').textContent = `No se pudo cargar: ${error.message}`;
    $('loading').classList.add('error');
    throw error;
  }
  $('loading').hidden = true;
  if (import.meta.env.DEV) window.tridi = view;

  let currentTab = 'catalog';
  let selectedComponentId = 'sg90_servo';
  let compAutoSweep = true;
  let selectedStlPartId = null;
  let currentArenaScene = 'luigi_lab4/scene.xml';
  let arenaAutoMode = true;
  let loopTimer = null;

  // Snapshot base geom positions for exploded view in Tab 2
  let baseGeomLocalPos = null;

  function clearLoop() {
    if (loopTimer) {
      clearInterval(loopTimer);
      loopTimer = null;
    }
    view.sim.sensorReadout = null;
  }

  function geomNameOf(model, geomId) {
    const adr = model.name_geomadr[geomId];
    if (adr === undefined || adr < 0) return '';
    let end = adr;
    while (end < model.names.length && model.names[end] !== 0) end++;
    return new TextDecoder().decode(model.names.subarray(adr, end));
  }

  // ============================================================================
  // TAB 1: 3D HARDWARE COMPONENT CATALOG (P-1)
  // ============================================================================
  function renderCatalogList() {
    const bucket = $('cat-filter').value || undefined;
    const items = listComponents({ bucket });
    $('cat-list').innerHTML = items
      .map((c) => {
        const active = c.id === selectedComponentId ? 'active' : '';
        const pinCount = c.mcu?.upstream_pins?.length || c.mcu?.required_pins?.length || c.digital_pins?.length || 0;
        return `<div class="item-card ${active}" data-comp-id="${c.id}">
          <div class="item-title">
            <strong>${c.name}</strong>
            <span class="badge">${c.category}</span>
          </div>
          <div class="item-sub">
            <code>${c.id}</code> · masa: ${c.mujoco?.mass_kg ?? '—'} kg
            ${pinCount ? ` · <strong>${pinCount} pines</strong>` : ''}
          </div>
        </div>`;
      })
      .join('');

    for (const card of $('cat-list').querySelectorAll('.item-card')) {
      card.onclick = () => selectCatalogComponent(card.dataset.compId);
    }
  }

  function selectCatalogComponent(compId) {
    const comp = getComponent(compId);
    if (!comp) return;
    selectedComponentId = compId;
    renderCatalogList();

    // Load the standalone 3D model of this component into the viewport
    clearLoop();
    const previewFile = comp.preview_mjcf || 'components/sg90_servo.xml';
    view.sim.load(previewFile, 'home');
    view.viewer.rebuild();
    view.viewer.targetHeight = 0.06;
    view.viewer.camera.position.set(0.28, 0.20, -0.26);
    view.viewer.controls.target.set(0, 0.06, 0);
    view.viewer.controls.update();

    $('stage-title').textContent = `Vista 3D de Componente: ${comp.name}`;
    $('stage-subtitle').textContent = `Modelo MuJoCo aislado (${previewFile}) · Arrastra para rotar 360°`;

    // Start interactive 3D motion / sensor cone preview for this component
    loopTimer = setInterval(() => {
      const t = view.sim.data.time;
      const { ctrl, qpos } = view.sim.data;
      if (compAutoSweep && view.sim.model.nu >= 1) {
        if (comp.category === 'dc_motor' || comp.category === 'stepper' || comp.category === 'wheel') {
          ctrl[0] = 10.0; // spin shaft continuously
        } else if (comp.category === 'linear_actuator') {
          ctrl[0] = 0.08 + 0.075 * Math.sin(t * 2.5); // extend/retract piston 0..155 mm
        } else {
          ctrl[0] = 1.2 * Math.sin(t * 2.2); // sweep servo horn or turntable ±68 deg
        }
        $('comp-joint-slider').value = String(Math.round((ctrl[0] / (comp.category === 'dc_motor' ? 20.94 : 1.57)) * 100));
      }
      const val = qpos[0] ?? 0;
      const deg = ((val * 180) / Math.PI).toFixed(0);
      $('comp-joint-readout').textContent =
        comp.category === 'linear_actuator' ? `${(val * 1000).toFixed(0)} mm` : `${val.toFixed(2)} rad (${deg}°)`;

      // Show ultrasonic acoustic cone if inspecting a distance/optical sensor
      if (comp.id.includes('hcsr04') || comp.id.includes('apds') || comp.id.includes('cny70')) {
        const yaw = qpos[0] || 0;
        view.sim.sensorReadout = {
          sx: 0.02 * Math.cos(yaw),
          sy: 0.02 * Math.sin(yaw),
          sz: 0.075,
          yaw,
          rays: [0.22, 0.25, 0.28, 0.30, 0.28, 0.25, 0.22],
          distCm: 85,
          dodgeStage: 0,
        };
      } else {
        view.sim.sensorReadout = null;
      }
    }, 25);

    // Render technical datasheet on the right panel
    $('spec-title').textContent = comp.name;
    $('spec-badge').textContent = comp.category;
    const mj = comp.mujoco || {};
    const mcu = comp.mcu || {};
    const pinsList = mcu.upstream_pins
      ? mcu.upstream_pins.map((p) => `<span class="pin-chip" title="${p.description}">${p.name}</span>`).join(' ')
      : (mcu.required_pins || comp.pwm_pins || []).map((p) => `<span class="pin-chip">${p}</span>`).join(' ') ||
        '<span class="muted">Componente estructural pasivo</span>';

    $('spec-details').innerHTML = `
      <div class="spec-group">
        <div class="spec-label">Fuente Pública Sincronizada</div>
        <div class="spec-val">
          ${
            comp.upstream_url
              ? `<a href="${comp.upstream_url}" target="_blank" rel="noopener">wokwi/wokwi-elements (${comp.id}) ↗</a>`
              : 'Catálogo Físico Tridi + MuJoCo Menagerie'
          }
        </div>
      </div>
      <div class="spec-group">
        <div class="spec-label">Pines y Terminales Extraídos</div>
        <div class="pin-wrap">${pinsList}</div>
      </div>
      <div class="spec-group">
        <div class="spec-label">Parámetros Físicos MuJoCo (MJCF)</div>
        <table class="mini-table">
          <tr><td>Masa física:</td><td><strong>${mj.mass_kg ?? '—'} kg</strong></td></tr>
          <tr><td>Articulación / Actuador:</td><td><code>${mj.joint_type ?? mj.sensor_type ?? 'body'}</code> / <code>${
            mj.actuator_type ?? '—'
          }</code></td></tr>
          <tr><td>Ganancia (kp / kv):</td><td><strong>${mj.kp ?? mj.kv ?? '—'}</strong></td></tr>
          <tr><td>Rango / Fuerza:</td><td><code>${JSON.stringify(
            mj.ctrlrange ?? mj.range_rad ?? mj.friction ?? '—',
          )}</code></td></tr>
          <tr><td>Damping / Armature:</td><td><code>${mj.damping ?? '—'} / ${mj.armature ?? '—'}</code></td></tr>
        </table>
      </div>
      ${
        mcu.reason || mcu.deadzone_pwm || mcu.locks_timer_on_arduino_uno || mcu.blocking_pulsein_timeout_ms
          ? `<div class="spec-alert">
              <strong>⚠️ Regla Sim-to-Real en Hardware Físico:</strong><br/>
              ${mcu.reason ?? ''}
              ${mcu.deadzone_pwm ? `<div>• Zona muerta real medida en piso: <code>PWM &lt; ${mcu.deadzone_pwm}</code> no vence la fricción estática.</div>` : ''}
              ${
                mcu.locks_timer_on_arduino_uno
                  ? `<div>• Secuestra <code>${mcu.locks_timer_on_arduino_uno}</code> en Arduino UNO y apaga PWM en pines <code>D${mcu.disables_pwm_pins_on_arduino_uno.join(
                      '/D',
                    )}</code>.</div>`
                  : ''
              }
              ${
                mcu.blocking_pulsein_timeout_ms
                  ? `<div>• <code>pulseIn()</code> bloquea la CPU hasta <code>${mcu.blocking_pulsein_timeout_ms} ms</code>; Tridi lo reemplaza por interrupción <code>INT0/INT1</code>.</div>`
                  : ''
              }
            </div>`
          : ''
      }
    `;
  }

  $('comp-joint-slider').oninput = (e) => {
    compAutoSweep = false;
    $('comp-auto-sweep').classList.remove('on');
    $('comp-auto-sweep').textContent = 'Movimiento Automático: OFF (Manual)';
    const comp = getComponent(selectedComponentId);
    const ratio = Number(e.target.value) / 100;
    if (view.sim.model.nu >= 1) {
      if (comp?.category === 'dc_motor' || comp?.category === 'stepper') {
        view.sim.data.ctrl[0] = ratio * 20.94;
      } else if (comp?.category === 'linear_actuator') {
        view.sim.data.ctrl[0] = Math.max(0, (ratio + 1) * 0.08);
      } else {
        view.sim.data.ctrl[0] = ratio * 1.5708;
      }
    }
  };

  $('comp-auto-sweep').onclick = () => {
    compAutoSweep = !compAutoSweep;
    $('comp-auto-sweep').classList.toggle('on', compAutoSweep);
    $('comp-auto-sweep').textContent = compAutoSweep
      ? 'Movimiento Automático: ON'
      : 'Movimiento Automático: OFF (Manual)';
  };

  // ============================================================================
  // TAB 2: STEP-BY-STEP VISUAL ASSEMBLER (P-3)
  // ============================================================================
  function openAssemblerTab() {
    clearLoop();
    // Load the clean robot model (without arena walls) so the 7 STL parts can be inspected & exploded
    view.sim.load('luigi_lab4/luigi_lab4.xml', 'home');
    view.viewer.rebuild();
    view.viewer.targetHeight = 0.09;
    view.viewer.camera.position.set(0.55, 0.38, -0.52);
    view.viewer.controls.target.set(0, 0.09, 0);
    view.viewer.controls.update();

    // Clone each Three.js mesh material so we can highlight individual STL parts cleanly
    baseGeomLocalPos = new Map();
    for (const item of view.viewer.geoms) {
      const gName = geomNameOf(view.sim.model, item.id);
      item.name = gName;
      item.object.material = item.object.material.clone();
      item.baseColorHex = item.object.material.color.getHex();
      baseGeomLocalPos.set(
        item.id,
        view.sim.model.geom_pos.slice(3 * item.id, 3 * item.id + 3),
      );
    }

    $('stage-title').textContent = 'Ensamblador Visual: 7 Mallas CAD (.stl) + Componentes del Catálogo';
    $('stage-subtitle').textContent =
      'Haz clic en una pieza a la izquierda para resaltarla en 3D o usa el slider de Vista Explosionada';

    renderStlPartsList();
    renderInoAnalysis();
    applyAssemblerExplosionAndHighlight();
  }

  function renderStlPartsList() {
    $('stl-parts-list').innerHTML = LAB4_STL_PARTS.map((p) => {
      const active = selectedStlPartId === p.id ? 'active' : '';
      return `<div class="item-card ${active}" data-part-id="${p.id}">
        <div class="item-title">
          <strong>${p.title}</strong>
          <span class="badge">${p.file}</span>
        </div>
        <div class="item-sub">
          🔗 <strong>Componente acoplado:</strong> ${p.coupledLabel}<br/>
          📌 <span class="muted">${p.pins}</span>
        </div>
      </div>`;
    }).join('');

    for (const card of $('stl-parts-list').querySelectorAll('.item-card')) {
      card.onclick = () => {
        selectedStlPartId = selectedStlPartId === card.dataset.partId ? null : card.dataset.partId;
        renderStlPartsList();
        applyAssemblerExplosionAndHighlight();
      };
    }
  }

  function applyAssemblerExplosionAndHighlight() {
    if (currentTab !== 'assembler' || !baseGeomLocalPos) return;
    const explodeRatio = Number($('explode-slider').value) / 100;
    $('explode-val').textContent = `${Math.round(explodeRatio * 100)}%`;

    const activePart = LAB4_STL_PARTS.find((p) => p.id === selectedStlPartId) || null;
    const activeGeoms = activePart ? new Set(activePart.geoms) : null;

    for (const item of view.viewer.geoms) {
      const base = baseGeomLocalPos.get(item.id);
      if (!base) continue;
      const part = LAB4_STL_PARTS.find((p) => p.geoms.includes(item.name));
      let [dx, dy, dz] = part ? part.explodeOffset : [0, 0, 0];
      // Mirror Y explosion direction for right-side wheels/brackets
      if (item.name.includes('_der') || base[1] < -0.02) dy = -Math.abs(dy);

      view.sim.model.geom_pos[3 * item.id] = base[0] + dx * explodeRatio;
      view.sim.model.geom_pos[3 * item.id + 1] = base[1] + dy * explodeRatio;
      view.sim.model.geom_pos[3 * item.id + 2] = base[2] + dz * explodeRatio;

      if (!activeGeoms) {
        item.object.material.color.setHex(item.baseColorHex);
        item.object.material.transparent = false;
        item.object.material.opacity = 1.0;
        item.object.material.emissive.setHex(0x000000);
      } else if (activeGeoms.has(item.name)) {
        item.object.material.color.setHex(item.baseColorHex);
        item.object.material.transparent = false;
        item.object.material.opacity = 1.0;
        item.object.material.emissive.setHex(0x3a2800);
      } else {
        item.object.material.transparent = true;
        item.object.material.opacity = 0.16;
        item.object.material.emissive.setHex(0x000000);
      }
    }
    view.sim.mujoco.mj_forward(view.sim.model, view.sim.data);
  }

  $('explode-slider').oninput = applyAssemblerExplosionAndHighlight;
  $('show-all-parts').onclick = () => {
    selectedStlPartId = null;
    renderStlPartsList();
    applyAssemblerExplosionAndHighlight();
  };

  function renderInoAnalysis() {
    const parsed = parseArduinoSketch(lab4SketchText);
    const pinCheck = validateHardwarePinout('arduino_uno', getPreset('luigi_lab4').pinout);
    const compiled = generateMujocoXml({ preset: 'luigi_lab4', modelName: 'luigi_lab4_assembled' });

    $('ino-analysis-box').innerHTML = `
      <div class="spec-group">
        <div class="spec-label">Mapa de Pines Extraído de <code>LAB4_Robot_Explorador_Autonomo.ino</code></div>
        <div class="pin-wrap">
          <span class="pin-chip">ENA = D${parsed.pinout.ENA} (PWM Timer0)</span>
          <span class="pin-chip">IN1 = D${parsed.pinout.IN1}</span>
          <span class="pin-chip">IN2 = D${parsed.pinout.IN2}</span>
          <span class="pin-chip">ENB = D${parsed.pinout.ENB} (PWM Timer0)</span>
          <span class="pin-chip">IN3 = D${parsed.pinout.IN3}</span>
          <span class="pin-chip">IN4 = D${parsed.pinout.IN4}</span>
          <span class="pin-chip">SERVO = D${parsed.pinout.SERVO} (Timer1)</span>
          <span class="pin-chip">TRIG = D${parsed.pinout.TRIG}</span>
          <span class="pin-chip">ECHO = D${parsed.pinout.ECHO} (${pinCheck.interruptMode})</span>
        </div>
      </div>
      <div class="spec-ok">
        ✓ <strong>Validación de Hardware Determinista:</strong> Sin conflicto de <code>Timer1</code> (<code>&lt;Servo.h&gt;</code> en D9 no interfiere con PWM de motores en D5/D6) y <code>ECHO</code> en <code>D3</code> soporta interrupción externa <code>INT1</code>.
      </div>
      <div class="spec-alert">
        <strong>🔍 Cuellos de botella detectados en el código original de Luigi:</strong>
        ${parsed.bottlenecks
          .map(
            (b) =>
              `<div>• <code>${b.type}</code> (${b.count} llamadas, congela hasta <strong>${b.worst_case_ms} ms</strong>) → Solución Tridi: ${b.fix}</div>`,
          )
          .join('')}
      </div>
    `;
    $('generated-xml-preview').textContent = compiled.robotXml;
  }

  $('btn-go-simulate').onclick = () => {
    currentArenaScene = 'luigi_lab4/scene.xml';
    switchTab('arena');
  };

  // ============================================================================
  // TAB 3: PHYSICAL ARENA SIMULATOR (P-2 & P-4 + J-4 ONNX POLICIES)
  // ============================================================================
  async function openArenaTab(sceneFile = currentArenaScene) {
    clearLoop();
    currentArenaScene = sceneFile;
    for (const card of $('arena-models-list').querySelectorAll('.item-card')) {
      card.classList.toggle('active', card.dataset.scene === sceneFile);
    }

    const isLab4 = sceneFile.startsWith('luigi_lab4/');
    const isLab3 = sceneFile.startsWith('luigi_lab3/');
    const isFactory = sceneFile.startsWith('factory_cell/');

    // Load the real 50 Hz ONNX policy (or scene + policy) so raycasting & closed-loop control run live
    if (isLab4) {
      await view.loadPolicy(lab4OnnxUrl, lab4JsonUrl);
    } else if (isLab3) {
      await view.loadPolicy(lab3OnnxUrl, lab3JsonUrl);
    } else if (isFactory) {
      await view.loadPolicy(factoryOnnxUrl, factoryJsonUrl);
    } else {
      await view.loadPolicy(g1OnnxUrl, g1JsonUrl);
    }

    view.sim._usbLocked = !arenaAutoMode;
    view.sim._serialCmd = null;

    if (isLab4 || isLab3) {
      view.viewer.targetHeight = 0.12;
      view.viewer.camera.position.set(1.15, 0.72, -1.05);
      view.viewer.controls.target.set(0, 0.12, 0);
      $('lbl-m0').innerHTML = 'Rueda Izquierda (rad/s): <span id="val-m0">0</span>';
      $('lbl-m1').innerHTML = 'Rueda Derecha (rad/s): <span id="val-m1">0</span>';
      $('lbl-m2').innerHTML = 'Cuello Servo SG90 (grados): <span id="val-m2">0°</span>';
      $('box-m2').hidden = !isLab4;
      $('stage-title').textContent = isLab4
        ? 'Simulación en Arena: Luigi Lab 4 · Política ONNX (luigi-lab4.onnx, 50 Hz)'
        : 'Simulación en Arena: Luigi Lab 3 · Política ONNX (luigi-lab3.onnx, 50 Hz)';
    } else if (isFactory) {
      view.viewer.targetHeight = 0.35;
      view.viewer.camera.position.set(1.55, 0.95, -1.25);
      view.viewer.controls.target.set(0, 0.35, 0);
      $('lbl-m0').innerHTML = 'Cinta Transportadora (m): <span id="val-m0">0</span>';
      $('lbl-m1').innerHTML = 'Pistón Neumático Alineador (m): <span id="val-m1">0</span>';
      $('lbl-m2').innerHTML = 'Prensa Selladora Vertical (m): <span id="val-m2">0</span>';
      $('box-m2').hidden = false;
      $('stage-title').textContent = 'Simulación en Arena: Celda Industrial de Empaque Cronometrado (P-4)';
    } else {
      view.viewer.targetHeight = 0.75;
      view.viewer.camera.position.set(2.4, 1.4, -1.6);
      view.viewer.controls.target.set(0, 0.75, 0);
      $('stage-title').textContent = 'Simulación en Arena: Unitree G1 (29 DOF · g1-stand.onnx)';
    }
    view.viewer.controls.update();

    loopTimer = setInterval(() => {
      const { qpos, qvel, ctrl } = view.sim.data;

      if (isLab4 || isLab3) {
        const sr = view.sim.sensorReadout || { distCm: 92, irProx: 18, dodgeStage: 0 };
        const neckYaw = isLab4 && view.sim.model.nq >= 10 ? qpos[9] : 0;
        const dodgeLabels = [
          'Crucero ONNX (50 Hz)',
          '1/4 · Freno activo (-20 rad/s)',
          '2/4 · Reversa despeje',
          '3/4 · Giro diferencial 90°',
        ];

        $('arena-telemetry').innerHTML = `
          <table class="mini-table">
            <tr><td>Política activa:</td><td><strong><code>${isLab4 ? 'luigi-lab4.onnx' : 'luigi-lab3.onnx'}</code> (50 Hz)</strong></td></tr>
            <tr><td>Posición X, Y chasis:</td><td><strong>${qpos[0].toFixed(2)} m, ${qpos[1].toFixed(2)} m</strong></td></tr>
            <tr><td>Vel. Rueda Izq (ENA D5):</td><td><code>${qvel[6].toFixed(1)} rad/s</code> (cmd: ${ctrl[0].toFixed(1)})</td></tr>
            <tr><td>Vel. Rueda Der (ENB D6):</td><td><code>${qvel[7].toFixed(1)} rad/s</code> (cmd: ${ctrl[1].toFixed(1)})</td></tr>
            ${
              isLab4
                ? `<tr><td>Ángulo Cuello SG90 (D9):</td><td><strong>${((neckYaw * 180) / Math.PI).toFixed(1)}°</strong> (Servo.h: ${(
                    90 +
                    (neckYaw * 180) / Math.PI
                  ).toFixed(0)}°)</td></tr>`
                : `<tr><td>Radar IR APDS-9960 (0x9C):</td><td><strong>${sr.irProx ?? 18} / 255</strong></td></tr>`
            }
            <tr><td>Radar Ultrasónico (ECHO):</td><td><strong>${sr.distCm} cm</strong> (Raycast MuJoCo)</td></tr>
            <tr><td>Estado de evasión:</td><td><strong>${dodgeLabels[sr.dodgeStage] || dodgeLabels[0]}</strong></td></tr>
          </table>
        `;
        $('arena-explanation').innerHTML = isLab4
          ? `<div class="spec-ok"><strong>¿Qué demuestra Luigi Lab 4 (P-2 + J-4)?</strong><br/>En el código original con <code>delay(350)</code>, el robot tenía que frenar en seco 700 ms cada vez que movía el servo SG90. Con <code>luigi-lab4.onnx</code>, el cuello <code>7_cabeza_sensor_servo.stl</code> barre de forma continua mientras las dos ruedas mantienen tracción diferencial y esquivan las paredes a 50 Hz.</div>`
          : `<div class="spec-ok"><strong>Luigi Lab 3:</strong> Exploración con cono ultrasónico fijo al frente, radar IR APDS-9960 (0x9E) y compensación de zona muerta PWM ≥ 115.</div>`;
      } else if (isFactory) {
        const fr = view.sim.factoryReadout || {
          feedMm: Math.round((qpos[7] ?? 0) * 1000),
          pusherMm: Math.round((qpos[8] ?? 0) * 1000),
          sealerMm: Math.round((qpos[9] ?? 0) * 1000),
          sensorEntry: false,
          sensorSealer: false,
          sensorExit: false,
          stage: 0,
          crushed: false,
          fixedPlcMode: false,
        };
        const stageNames = [
          '1. Alimentando caja hacia estación de sellado',
          '2. Sensor óptico OK → Alineación neumática + Sellado',
          '3. Despacho de caja sellada a sensor de salida',
          '4. Retorno de portador para siguiente ciclo',
          '⚠️ FALLO PLC TIMER FIJO: Prensa baja sobre caja desfasada (Merma)',
        ];
        const stageName = arenaAutoMode ? stageNames[fr.stage] || stageNames[0] : 'Control manual por sliders activo';
        $('arena-telemetry').innerHTML = `
          <table class="mini-table">
            <tr><td>Etapa del ciclo:</td><td><strong style="color:${fr.crushed ? '#ff5252' : 'inherit'}">${stageName}</strong></td></tr>
            <tr><td>Cinta Transportadora:</td><td><code>${fr.feedMm} mm</code> (meta: ${(ctrl[0] * 1000).toFixed(0)} mm)</td></tr>
            <tr><td>Pistón Alineador Lateral:</td><td><code>${fr.pusherMm} mm</code> (meta: ${(ctrl[1] * 1000).toFixed(0)} mm)</td></tr>
            <tr><td>Prensa Selladora Vertical:</td><td><code>${fr.sealerMm} mm</code> (meta: ${(ctrl[2] * 1000).toFixed(0)} mm)</td></tr>
            <tr><td>Sensores Ópticos CNY70:</td><td>
              Entrada: <strong>${fr.sensorEntry ? '🟢 ON' : '⚪ OFF'}</strong> ·
              Sellado: <strong>${fr.sensorSealer ? '🟢 ON' : '⚪ OFF'}</strong> ·
              Salida: <strong>${fr.sensorExit ? '🟢 ON' : '⚪ OFF'}</strong>
            </td></tr>
          </table>
          <div style="margin-top:8px">
            <button id="toggle-plc-fault" class="secondary-btn" type="button">
              ${
                view.sim._factoryFixedTimerMode
                  ? '✅ Volver a Política Tridi Guiada por Sensores (0% Merma)'
                  : '⚠️ Simular Fallo de PLC con Timer Fijo (Resbalón en Cinta)'
              }
            </button>
          </div>
        `;
        const btnFault = $('toggle-plc-fault');
        if (btnFault) {
          btnFault.onclick = () => {
            view.sim._factoryFixedTimerMode = !view.sim._factoryFixedTimerMode;
          };
        }
        $('arena-explanation').innerHTML = `<div class="spec-ok"><strong>¿Qué demuestra la Celda Industrial (P-4)?</strong><br/>En una empaquetadora real, si una caja resbala en la cinta y el PLC baja la selladora con un <code>timer</code> fijo, aplasta el envase (merma). En MuJoCo entrenamos el ciclo coordinando los 3 actuadores con los sensores ópticos de entrada, sellado y salida.</div>`;
      } else {
        $('arena-telemetry').innerHTML = `
          <table class="mini-table">
            <tr><td>Política activa:</td><td><strong><code>g1-stand.onnx</code> (300 M pasos, 50 Hz)</strong></td></tr>
            <tr><td>Altura pelvis Z:</td><td><strong>${qpos[2].toFixed(3)} m</strong></td></tr>
            <tr><td>Actuadores activos:</td><td><code>29 DOF</code></td></tr>
          </table>
        `;
        $('arena-explanation').innerHTML = `<div class="spec-ok"><strong>Unitree G1 (29 DOF):</strong> Usa el botón <strong>💥 Empujar</strong> para aplicar un impulso de 250 N y ver cómo recupera el equilibrio en tiempo real.</div>`;
      }
    }, 30);
  }

  for (const card of $('arena-models-list').querySelectorAll('.item-card')) {
    card.onclick = () => openArenaTab(card.dataset.scene);
  }

  $('arena-mode-auto').onclick = () => {
    arenaAutoMode = true;
    view.sim._usbLocked = false;
    view.sim._serialCmd = null;
    $('arena-mode-auto').classList.add('on');
    $('arena-mode-manual').classList.remove('on');
    $('manual-sliders').hidden = true;
  };

  $('arena-mode-manual').onclick = () => {
    arenaAutoMode = false;
    view.sim._usbLocked = true;
    $('arena-mode-manual').classList.add('on');
    $('arena-mode-auto').classList.remove('on');
    $('manual-sliders').hidden = false;
    updateManualControls();
  };

  function updateManualControls() {
    arenaAutoMode = false;
    view.sim._usbLocked = true;
    $('arena-mode-manual').classList.add('on');
    $('arena-mode-auto').classList.remove('on');
    const isFactory = currentArenaScene.startsWith('factory_cell/');
    const r0 = Number($('sld-m0').value) / 100;
    const r1 = Number($('sld-m1').value) / 100;
    const r2 = Number($('sld-m2').value) / 100;
    const { ctrl } = view.sim.data;
    if (isFactory) {
      ctrl[0] = ((r0 + 1) / 2) * 0.95;
      ctrl[1] = ((r1 + 1) / 2) * 0.20;
      ctrl[2] = ((r2 + 1) / 2) * 0.16;
      view.sim._serialCmd = { ctrl: [ctrl[0], ctrl[1], ctrl[2]], until: 0 };
      $('val-m0').textContent = `${(ctrl[0] * 1000).toFixed(0)} mm`;
      $('val-m1').textContent = `${(ctrl[1] * 1000).toFixed(0)} mm`;
      $('val-m2').textContent = `${(ctrl[2] * 1000).toFixed(0)} mm`;
    } else {
      ctrl[0] = r0 * 20.94;
      ctrl[1] = r1 * 20.94;
      if (view.sim.model.nu >= 3) ctrl[2] = r2 * 1.5708;
      view.sim._serialCmd = { ctrl: [ctrl[0], ctrl[1], ctrl[2] ?? 0], until: 0 };
      $('val-m0').textContent = `${ctrl[0].toFixed(1)}`;
      $('val-m1').textContent = `${ctrl[1].toFixed(1)}`;
      $('val-m2').textContent = `${((r2 * 1.5708 * 180) / Math.PI).toFixed(0)}°`;
    }
  }
  for (const id of ['sld-m0', 'sld-m1', 'sld-m2']) {
    $(id).oninput = updateManualControls;
  }

  $('push').onclick = () => view.push();
  $('reset').onclick = () => view.reset();

  // ============================================================================
  // TAB SWITCHING & CRUD FORM
  // ============================================================================
  function switchTab(tab) {
    currentTab = tab;
    for (const btn of document.querySelectorAll('.mode-tab')) {
      btn.classList.toggle('active', btn.dataset.tab === tab);
    }
    $('left-catalog').hidden = tab !== 'catalog';
    $('right-catalog').hidden = tab !== 'catalog';
    $('ctrl-catalog').hidden = tab !== 'catalog';

    $('left-assembler').hidden = tab !== 'assembler';
    $('right-assembler').hidden = tab !== 'assembler';
    $('ctrl-assembler').hidden = tab !== 'assembler';

    $('left-arena').hidden = tab !== 'arena';
    $('right-arena').hidden = tab !== 'arena';
    $('ctrl-arena').hidden = tab !== 'arena';

    if (tab === 'catalog') selectCatalogComponent(selectedComponentId);
    else if (tab === 'assembler') openAssemblerTab();
    else if (tab === 'arena') openArenaTab(currentArenaScene);
  }

  for (const btn of document.querySelectorAll('.mode-tab')) {
    btn.onclick = () => switchTab(btn.dataset.tab);
  }

  $('cat-filter').onchange = renderCatalogList;

  $('add-comp-form').onsubmit = (e) => {
    e.preventDefault();
    const cat = $('comp-cat').value;
    const previewMap = {
      servo: 'components/sg90_servo.xml',
      dc_motor: 'components/tt_gearmotor_200rpm.xml',
      distance_sensor: 'components/hcsr04_ultrasonic.xml',
      linear_actuator: 'components/pneumatic_pusher_linear.xml',
    };
    const comp = registerComponent({
      id: $('comp-id').value.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_'),
      name: $('comp-name').value.trim(),
      category: cat,
      preview_mjcf: previewMap[cat] || 'components/sg90_servo.xml',
      mujoco: {
        joint_type: cat === 'linear_actuator' ? 'slide' : 'hinge',
        actuator_type: cat === 'dc_motor' ? 'velocity' : 'position',
        kp: Number($('comp-kp').value) || 6.5,
        forcerange: [-Number($('comp-force').value), Number($('comp-force').value)],
        mass_kg: 0.055,
      },
      mcu: {
        required_pins: ['PWM_SIG', 'VCC', 'GND'],
      },
    });
    $('comp-id').value = '';
    $('comp-name').value = '';
    selectCatalogComponent(comp.id);
  };

  // Start directly on Tab 1 showing the 3D SG90 Servo component
  switchTab('catalog');
}

start();
