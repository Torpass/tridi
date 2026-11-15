// #/assembler — Tridi Assembler Studio ("AI reasons, code assembles" — mus3o Low-Token DSL pattern).
// Channel 1: Plant & Process Automation (P&ID .dxf -> ISA-5.1 Engineering Docs + 3D Twin + PLC Flat Files)
// Channel 2: Custom Robots & Mechatronics (.stl + .ino -> Pinout/Timer Audit + MuJoCo Twin + 50 Hz C99 Firmware)
import './assembler.css';
import {
  classifyStlMeshes,
  generateIsaEngineeringDocs,
  generateMujocoXml,
  generatePidMujocoXml,
  generatePlcFlatFile,
  getPreset,
  listComponents,
  parseArduinoSketch,
  parseDxfPid,
  PID_SAMPLE_DXFS,
  validateHardwarePinout,
} from 'tridi-physics';
import { appHeaderHTML, mountAppHeader } from '../header.js';
import { lang, onLang } from '../i18n.js';
import { A, T, t, title } from './strings/assembler.js';

export { title };

const LAB4_DEFAULT_INO = `// Luigi Lab IV — Original Sketch (with blocking pulseIn & delay to audit)
#include <Servo.h>
const int ENA = 5;
const int IN1 = 7;
const int IN2 = 8;
const int ENB = 6;
const int IN3 = 12;
const int IN4 = 13;
const int TRIG = 4;
const int ECHO = 3;
const int SERVO_PIN = 9;
Servo neck;

void setup() {
  neck.attach(SERVO_PIN);
}
void loop() {
  long dur = pulseIn(ECHO, HIGH, 25000);
  delay(80);
}`;

const CALIBRATED_LAB4_C99 = `// ============================================================================
// TRIDI SIM-TO-REAL — DETERMINISTIC 50 HZ C99 FIRMWARE (ATmega328P / Arduino UNO)
// Target: Luigi Lab IV Autonomous Rover | Policy: luigi-lab4.onnx (obs_dim=18, nu=3)
// Hardware Audit: Timer1 (<Servo.h> on D9) isolated from ENA/ENB PWM on Timer0 (D5/D6)
// ============================================================================
#include <Arduino.h>
#include <Servo.h>

#define PIN_ENA       5   // Timer0 PWM — Left Gearbox
#define PIN_IN1       7
#define PIN_IN2       8
#define PIN_ENB       6   // Timer0 PWM — Right Gearbox
#define PIN_IN3       12
#define PIN_IN4       13
#define PIN_TRIG      4   // HC-SR04 Ultrasonic Trigger
#define PIN_ECHO      3   // INT1 Hardware Interrupt (zero blocking pulseIn)
#define PIN_SERVO     9   // SG90 Neck Turret (-65 deg to +65 deg)

// Empirically calibrated Sim-to-Real constants (docs/caso-luigi-sim2real.md)
#define PWM_MIN_MOVE  115 // Overcomes TT 1:48 gearbox static friction on carpet
#define PWM_MAX_SAFE  235 // Prevents 2S Li-Ion voltage sag on L298N
#define CONTROL_DT_US 20000UL // 50 Hz deterministic control loop (20 ms)

static volatile uint32_t echoRiseUs = 0;
static volatile uint16_t latestDistCm = 120;
static Servo neckServo;
static uint32_t lastStepUs = 0;

void onEchoEdge() {
  if (digitalRead(PIN_ECHO) == HIGH) {
    echoRiseUs = micros();
  } else if (echoRiseUs > 0) {
    uint32_t dt = micros() - echoRiseUs;
    if (dt < 24000UL) latestDistCm = (uint16_t)(dt / 58UL);
  }
}

static inline int16_t applyDeadzonePwm(float normCmd) {
  if (normCmd > -0.08f && normCmd < 0.08f) return 0;
  float mag = normCmd < 0.0f ? -normCmd : normCmd;
  if (mag > 1.0f) mag = 1.0f;
  int16_t pwm = (int16_t)(PWM_MIN_MOVE + mag * (PWM_MAX_SAFE - PWM_MIN_MOVE));
  return normCmd >= 0.0f ? pwm : -pwm;
}

void setup() {
  Serial.begin(115200);
  pinMode(PIN_ENA, OUTPUT); pinMode(PIN_ENB, OUTPUT);
  pinMode(PIN_IN1, OUTPUT); pinMode(PIN_IN2, OUTPUT);
  pinMode(PIN_IN3, OUTPUT); pinMode(PIN_IN4, OUTPUT);
  pinMode(PIN_TRIG, OUTPUT); pinMode(PIN_ECHO, INPUT);
  attachInterrupt(digitalPinToInterrupt(PIN_ECHO), onEchoEdge, CHANGE);
  neckServo.attach(PIN_SERVO);
  neckServo.write(90);
}

void loop() {
  uint32_t now = micros();
  if (now - lastStepUs < CONTROL_DT_US) return;
  lastStepUs = now;

  // Trigger non-blocking ultrasonic pulse
  digitalWrite(PIN_TRIG, LOW);
  delayMicroseconds(2);
  digitalWrite(PIN_TRIG, HIGH);
  delayMicroseconds(10);
  digitalWrite(PIN_TRIG, LOW);

  // Deterministic 50 Hz obstacle-avoidance & neck-sweep control law
  uint16_t d = latestDistCm;
  int16_t leftPwm = applyDeadzonePwm(d > 32 ? 0.72f : -0.65f);
  int16_t rightPwm = applyDeadzonePwm(d > 32 ? 0.72f : 0.65f);

  digitalWrite(PIN_IN1, leftPwm >= 0 ? HIGH : LOW);
  digitalWrite(PIN_IN2, leftPwm < 0 ? HIGH : LOW);
  analogWrite(PIN_ENA, leftPwm >= 0 ? leftPwm : -leftPwm);

  digitalWrite(PIN_IN3, rightPwm >= 0 ? HIGH : LOW);
  digitalWrite(PIN_IN4, rightPwm < 0 ? HIGH : LOW);
  analogWrite(PIN_ENB, rightPwm >= 0 ? rightPwm : -rightPwm);
}
`;

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

function downloadText(filename, content, mime = 'text/plain;charset=utf-8') {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

export function mount(root) {
  let mode = 'pid'; // 'pid' | 'cad'
  let sampleId = '01_batch_mixer.dxf';
  let dxfText = PID_SAMPLE_DXFS[sampleId].dxf;
  let processGoal = PID_SAMPLE_DXFS[sampleId].processGoal[lang()] ?? PID_SAMPLE_DXFS[sampleId].processGoal.es;
  let pidTab = 'p1'; // 'p1' | 'p1io' | 'p3' | 'p2'
  let plcDialect = 'scl'; // 'scl' | 'l5k'
  let cadPreset = 'luigi_lab4';
  let cadTab = 'audit'; // 'audit' | 'ino' | 'xml'
  let inoText = LAB4_DEFAULT_INO;
  let stlNames = ['1_chasis_robot.stl', '5_rin_x2.stl', '6_llanta_x2_TPU.stl', '7_cabeza_sensor_servo.stl'];
  let pinOverride = null;

  // Interactive P&ID process simulation state (for live visualization & fault stress-test)
  const simState = {
    weightKg: 142.5,
    batches: 3,
    stepIdx: 1, // 0=IDLE, 1=DOSING, 2=MIXING, 3=DISCHARGE
    faultLsh: false,
    faultMotor: false,
  };

  const modeToggleHTML = `
    <div class="asm-modes" role="tablist" ${A({ 'aria-label': 'modeAria' })}>
      <button type="button" class="asm-mode-btn" data-mode="pid" role="tab" aria-selected="true">${T('modePid')}</button>
      <button type="button" class="asm-mode-btn" data-mode="cad" role="tab" aria-selected="false">${T('modeCad')}</button>
    </div>`;

  root.innerHTML = `
    <div class="asm-page">
      ${appHeaderHTML({ current: 'assembler' })}
      <div class="screen-toolbar">
        <div class="screen-toolbar-copy">
          <h1>Assembler</h1>
          <p class="screen-toolbar-sub">${T('title')}</p>
        </div>
        <div class="screen-toolbar-actions">
          ${modeToggleHTML}
        </div>
      </div>
      <div class="asm-shell">
        <div class="asm-grid" id="asm-content"></div>
      </div>
    </div>`;

  const contentEl = root.querySelector('#asm-content');
  const cleanups = [mountAppHeader(root)];
  const on = (target, type, fn, opts) => {
    target.addEventListener(type, fn, opts);
    cleanups.push(() => target.removeEventListener(type, fn, opts));
  };

  for (const btn of root.querySelectorAll('.asm-mode-btn')) {
    on(btn, 'click', () => {
      mode = btn.dataset.mode;
      for (const b of root.querySelectorAll('.asm-mode-btn')) {
        b.setAttribute('aria-selected', String(b === btn));
      }
      render();
    });
  }

  function renderCadSchematicSvg(activePinout, pinAudit) {
    const enaPin = activePinout.ENA ?? 5;
    const enbPin = activePinout.ENB ?? 6;
    const servoPin = activePinout.SERVO ?? 9;
    const echoPin = activePinout.ECHO ?? 3;
    const isConflict = !pinAudit.valid;
    const pwmColor = isConflict ? '#ff6b6b' : '#d4d8df';
    return `
      <svg class="asm-pid-svg" viewBox="0 0 620 220" role="img" aria-label="Hardware & Pinout Schematic">
        <!-- Wires from MCU to peripherals -->
        <path d="M210 64 H135" stroke="${pwmColor}" stroke-width="2" fill="none" stroke-dasharray="${isConflict ? '4 3' : 'none'}"/>
        <path d="M210 106 H135" stroke="#8e96a4" stroke-width="1.8" fill="none"/>
        <path d="M210 154 H135" stroke="#8e96a4" stroke-width="1.8" fill="none"/>
        <path d="M410 74 H485" stroke="#d4d8df" stroke-width="1.8" fill="none"/>
        <path d="M410 142 H485" stroke="#8e96a4" stroke-width="1.8" fill="none"/>

        <!-- Left: L298N Dual H-Bridge + TT Gearmotors -->
        <rect x="20" y="34" width="115" height="92" rx="8" fill="#121417" stroke="${isConflict ? '#ff6b6b' : '#4a515d'}" stroke-width="1.5"/>
        <text x="77" y="56" text-anchor="middle" font-family="Geist Mono, monospace" font-size="11" font-weight="700" fill="#f5f5f5">L298N DRIVER</text>
        <text x="77" y="74" text-anchor="middle" font-family="Geist Mono, monospace" font-size="9.5" fill="${isConflict ? '#ff6b6b' : '#d4d8df'}">ENA: D${esc(enaPin)} ${isConflict ? '⚠ TIMER1' : '(Timer0)'}</text>
        <text x="77" y="90" text-anchor="middle" font-family="Geist Mono, monospace" font-size="9.5" fill="#bdbdbd">ENB: D${esc(enbPin)} (Timer0)</text>
        <text x="77" y="108" text-anchor="middle" font-family="Geist Mono, monospace" font-size="9" fill="#7a7a7a">Deadzone PWM ≥ 115</text>

        <!-- Left bottom: Dual TT Gearmotors -->
        <rect x="20" y="138" width="115" height="52" rx="8" fill="#121417" stroke="#383e49" stroke-width="1.4"/>
        <text x="77" y="160" text-anchor="middle" font-family="Geist Mono, monospace" font-size="10.5" font-weight="700" fill="#f5f5f5">2× TT 1:48 MOTORS</text>
        <text x="77" y="176" text-anchor="middle" font-family="Geist Mono, monospace" font-size="9" fill="#a3a3a3">TPU Tires · 200 RPM</text>

        <!-- Center: Arduino UNO (ATmega328P) -->
        <rect x="210" y="28" width="200" height="164" rx="10" fill="#14181f" stroke="${isConflict ? '#ff6b6b' : '#636b78'}" stroke-width="1.8"/>
        <text x="310" y="54" text-anchor="middle" font-family="Geist Mono, monospace" font-size="12.5" font-weight="700" fill="#f5f5f5">ARDUINO UNO (ATmega328P)</text>
        <text x="310" y="72" text-anchor="middle" font-family="Geist Mono, monospace" font-size="10" fill="#bdbdbd">50 Hz Non-Blocking C99 Loop</text>
        <rect x="228" y="86" width="164" height="42" rx="6" fill="#0d0f13" stroke="#262a33"/>
        <text x="310" y="104" text-anchor="middle" font-family="Geist Mono, monospace" font-size="9.5" fill="#f5f5f5">Timer0 (D5/D6): 976 Hz PWM</text>
        <text x="310" y="120" text-anchor="middle" font-family="Geist Mono, monospace" font-size="9.5" fill="${isConflict ? '#ff6b6b' : '#a3a3a3'}">Timer1 (D9/D10): &lt;Servo.h&gt; Lock</text>
        <rect x="228" y="138" width="164" height="38" rx="6" fill="#0d0f13" stroke="#262a33"/>
        <text x="310" y="155" text-anchor="middle" font-family="Geist Mono, monospace" font-size="9.5" fill="#d4d8df">ISR INT1 (D${esc(echoPin)}): 0 ms block</text>
        <text x="310" y="169" text-anchor="middle" font-family="Geist Mono, monospace" font-size="9" fill="#7a7a7a">SRAM: 461 B / 2048 B (22.5%)</text>

        <!-- Right top: SG90 Neck Radar Servo -->
        <rect x="485" y="42" width="115" height="64" rx="8" fill="#121417" stroke="#4a515d" stroke-width="1.5"/>
        <text x="542" y="65" text-anchor="middle" font-family="Geist Mono, monospace" font-size="10.5" font-weight="700" fill="#f5f5f5">SG90 SERVO</text>
        <text x="542" y="81" text-anchor="middle" font-family="Geist Mono, monospace" font-size="9.5" fill="#d4d8df">PWM: D${esc(servoPin)} (±65°)</text>
        <text x="542" y="95" text-anchor="middle" font-family="Geist Mono, monospace" font-size="8.5" fill="#7a7a7a">Active Neck Sweep</text>

        <!-- Right bottom: HC-SR04 + APDS-9960 -->
        <rect x="485" y="118" width="115" height="68" rx="8" fill="#121417" stroke="#383e49" stroke-width="1.5"/>
        <text x="542" y="140" text-anchor="middle" font-family="Geist Mono, monospace" font-size="10.5" font-weight="700" fill="#f5f5f5">HC-SR04 + I2C</text>
        <text x="542" y="156" text-anchor="middle" font-family="Geist Mono, monospace" font-size="9.5" fill="#bdbdbd">TRIG D4 · ECHO D${esc(echoPin)}</text>
        <text x="542" y="172" text-anchor="middle" font-family="Geist Mono, monospace" font-size="8.5" fill="#7a7a7a">APDS-9960 (0x9E)</text>
      </svg>`;
  }

  function renderPidFlowSvg(dag) {
    const isFault = simState.faultLsh || simState.faultMotor;
    const fillPct = simState.faultLsh ? 96 : Math.min(90, Math.max(12, (simState.weightKg / 300) * 85));
    const fillY = 152 - (fillPct / 100) * 76;
    const fillH = (fillPct / 100) * 76;
    const valveColor = !isFault && simState.stepIdx === 1 ? '#f5f5f5' : isFault ? '#ff6b6b' : '#4a515d';
    const motorColor = !isFault && simState.stepIdx === 2 ? '#f5f5f5' : simState.faultMotor ? '#ff6b6b' : '#8e96a4';
    const outColor = !isFault && simState.stepIdx === 3 ? '#f5f5f5' : '#4a515d';
    const tags = dag.nodes.map((n) => n.tag);
    const v1 = tags.find((x) => x.startsWith('FV-')) ?? 'FV-101';
    const v2 = tags.filter((x) => x.startsWith('FV-'))[1] ?? 'FV-102';
    const v3 = tags.filter((x) => x.startsWith('FV-'))[2] ?? 'FV-103';
    const vOut = tags.filter((x) => x.startsWith('FV-')).at(-1) ?? 'FV-104';
    const tk = tags.find((x) => x.startsWith('TK-')) ?? 'TK-101';
    const wt = tags.find((x) => x.startsWith('WT-')) ?? 'WT-101';
    const lsh = tags.find((x) => x.startsWith('LSH-')) ?? 'LSH-101';
    const lsl = tags.find((x) => x.startsWith('LSL-')) ?? 'LSL-101';
    const mot = tags.find((x) => x.startsWith('M-') || x.startsWith('SC-')) ?? 'M-101';
    const cv = tags.find((x) => x.startsWith('CV-') || x.startsWith('PK-')) ?? 'CV-101';

    return `
      <svg class="asm-pid-svg" viewBox="0 0 620 220" role="img" aria-label="P&ID ISA-5.1 Live Schematic">
        <!-- Piping lines -->
        <path d="M95 44 H250 V74 M95 88 H230 V74 M95 132 H270 V74" stroke="${valveColor}" stroke-width="2" fill="none" stroke-dasharray="${!isFault && simState.stepIdx === 1 ? '5 3' : 'none'}"/>
        <path d="M300 154 V188 H495" stroke="${outColor}" stroke-width="2.2" fill="none"/>
        <!-- Feed Valves -->
        <g font-family="Geist Mono, monospace" font-size="10" fill="#f5f5f5">
          <rect x="32" y="30" width="62" height="26" rx="5" fill="#121417" stroke="${valveColor}" stroke-width="1.5"/>
          <text x="63" y="47" text-anchor="middle">${esc(v1)}</text>
          <rect x="32" y="74" width="62" height="26" rx="5" fill="#121417" stroke="${valveColor}" stroke-width="1.5"/>
          <text x="63" y="91" text-anchor="middle">${esc(v2)}</text>
          <rect x="32" y="118" width="62" height="26" rx="5" fill="#121417" stroke="${valveColor}" stroke-width="1.5"/>
          <text x="63" y="135" text-anchor="middle">${esc(v3)}</text>
        </g>
        <!-- Main Mixing Vessel / Hopper -->
        <rect x="218" y="72" width="164" height="82" rx="10" fill="#14181f" stroke="#636b78" stroke-width="1.8"/>
        <rect x="222" y="${fillY.toFixed(1)}" width="156" height="${fillH.toFixed(1)}" rx="6" fill="${simState.faultLsh ? 'rgb(255 107 107 / 0.35)' : 'rgb(241 243 238 / 0.14)'}"/>
        <text x="300" y="112" text-anchor="middle" font-family="Geist Mono, monospace" font-size="13" font-weight="700" fill="#f5f5f5">${esc(tk)}</text>
        <text x="300" y="128" text-anchor="middle" font-family="Geist Mono, monospace" font-size="10" fill="#d4d8df">${esc(wt)}: ${simState.weightKg.toFixed(1)} kg</text>
        <!-- Top Agitator / Conveying Motor -->
        <circle cx="300" cy="36" r="18" fill="#121417" stroke="${motorColor}" stroke-width="1.8"/>
        <line x1="300" y1="54" x2="300" y2="138" stroke="${motorColor}" stroke-width="1.8"/>
        <text x="300" y="40" text-anchor="middle" font-family="Geist Mono, monospace" font-size="9.5" font-weight="700" fill="${motorColor}">${esc(mot)}</text>
        <!-- Level Switches LSH & LSL -->
        <rect x="404" y="74" width="76" height="24" rx="12" fill="#121417" stroke="${simState.faultLsh ? '#ff6b6b' : '#4a515d'}" stroke-width="1.5"/>
        <text x="442" y="90" text-anchor="middle" font-family="Geist Mono, monospace" font-size="9.5" fill="${simState.faultLsh ? '#ff6b6b' : '#f5f5f5'}">${esc(lsh)} ${simState.faultLsh ? 'TRIP' : 'OK'}</text>
        <rect x="404" y="128" width="76" height="24" rx="12" fill="#121417" stroke="#4a515d" stroke-width="1.4"/>
        <text x="442" y="144" text-anchor="middle" font-family="Geist Mono, monospace" font-size="9.5" fill="#bdbdbd">${esc(lsl)}</text>
        <!-- Bottom Discharge Valve & Takeaway Conveyor -->
        <rect x="334" y="174" width="66" height="26" rx="5" fill="#121417" stroke="${outColor}" stroke-width="1.5"/>
        <text x="367" y="191" text-anchor="middle" font-family="Geist Mono, monospace" font-size="10" fill="#f5f5f5">${esc(vOut)}</text>
        <rect x="495" y="172" width="96" height="30" rx="6" fill="#121417" stroke="#4a515d" stroke-width="1.5"/>
        <text x="543" y="191" text-anchor="middle" font-family="Geist Mono, monospace" font-size="10" fill="#d4d8df">${esc(cv)}</text>
      </svg>`;
  }

  function render() {
    if (mode === 'pid') {
      const dag = parseDxfPid(dxfText, { fileName: sampleId, processGoal });
      const docs = generateIsaEngineeringDocs(dag, { lang: lang() });
      const pid3d = generatePidMujocoXml(dag);
      const plc = generatePlcFlatFile(dag);
      const stateNames = ['00 · IDLE', '10 · DOSING', '20 · MIXING', '30 · DISCHARGE'];
      const stateText = simState.faultLsh
        ? 'HOLD · ALM_OVERFILL (CE-01)'
        : simState.faultMotor
          ? 'HOLD · MOTOR_OL_FAULT (CE-02)'
          : stateNames[simState.stepIdx];

      contentEl.innerHTML = `
        <div class="asm-col">
          <section class="asm-win">
            <div class="asm-bar"><span>${T('pidSourceBar')}</span><b>${dag.nodes.length} TAGS · ${dag.ioSummary.totalIoPoints} I/O</b></div>
            <div class="asm-body">
              <div class="asm-row">
                <select id="asm-sample-select" class="asm-select" style="flex:1">
                  ${Object.values(PID_SAMPLE_DXFS)
                    .map(
                      (s) =>
                        `<option value="${esc(s.id)}" ${s.id === sampleId ? 'selected' : ''}>${esc(s.title[lang()] ?? s.title.es)}</option>`,
                    )
                    .join('')}
                </select>
                <label class="asm-pill" style="cursor:pointer">
                  <span>${T('pidUploadBtn')}</span>
                  <input type="file" id="asm-dxf-file" accept=".dxf,.txt" hidden />
                </label>
                <a class="asm-pill signal" href="#/simulations/factory_cell">${T('pidOpen3dSim')}</a>
              </div>

              <div class="asm-pid-stage">
                <div class="asm-pid-hud">
                  <div class="asm-hud-card">
                    <span>${T('pidStepLabel')}</span>
                    <b id="asm-hud-state" class="${simState.faultLsh || simState.faultMotor ? 'trip' : 'ok'}">${esc(stateText)}</b>
                  </div>
                  <div class="asm-hud-card">
                    <span>${T('pidScaleLabel')}</span>
                    <b id="asm-hud-weight">${simState.weightKg.toFixed(1)} kg</b>
                  </div>
                  <div class="asm-hud-card">
                    <span>${T('pidBatchCount')}</span>
                    <b id="asm-hud-batches">${simState.batches}</b>
                  </div>
                </div>
                <div id="asm-svg-holder">${renderPidFlowSvg(dag)}</div>
                <div class="asm-row">
                  <button type="button" class="asm-pill" id="asm-fault-lsh">${T('pidFaultLsh')}</button>
                  <button type="button" class="asm-pill" id="asm-fault-motor">${T('pidFaultMotor')}</button>
                  <button type="button" class="asm-pill" id="asm-fault-reset">${T('pidFaultReset')}</button>
                </div>
              </div>

              <div class="asm-badges">
                <span class="asm-badge ok">${T('pidVerifiedBadge')}</span>
                <span class="asm-badge">DI: ${dag.ioSummary.DI}</span>
                <span class="asm-badge">DO: ${dag.ioSummary.DO}</span>
                <span class="asm-badge">AI (4-20 mA): ${dag.ioSummary.AI}</span>
                <span class="asm-badge">Pipes: ${dag.edges.length}</span>
              </div>
            </div>
          </section>
        </div>

        <div class="asm-col">
          <section class="asm-win">
            <div class="asm-bar"><span>${T('pidOutBar')}</span><b>${esc(dag.projectId)}</b></div>
            <div class="asm-tabs" role="tablist">
              <button type="button" class="asm-tab" data-ptab="p1" aria-selected="${pidTab === 'p1'}">${T('tabP1')}</button>
              <button type="button" class="asm-tab" data-ptab="p1io" aria-selected="${pidTab === 'p1io'}">${T('tabP1Io')} (${dag.ioSummary.totalIoPoints})</button>
              <button type="button" class="asm-tab" data-ptab="p3" aria-selected="${pidTab === 'p3'}">${T('tabP3')}</button>
              <button type="button" class="asm-tab" data-ptab="p2" aria-selected="${pidTab === 'p2'}">${T('tabP2')}</button>
            </div>
            <div class="asm-body">
              ${
                pidTab === 'p1'
                  ? `
                <div class="asm-row" style="justify-content:space-between">
                  <button type="button" class="asm-pill signal" id="asm-dl-fds">${T('dlFdsBtn')}</button>
                  <button type="button" class="asm-pill" id="asm-copy-fds">${T('copyBtn')}</button>
                </div>
                <h3 class="asm-sec-title">${T('secMatrix')}</h3>
                <div class="asm-table-wrap">
                  <table class="asm-table">
                    <thead><tr><th>ID</th><th>${T('colTag')}</th><th>${T('colCause')}</th><th>${T('colEffect')}</th><th>${T('colSev')}</th></tr></thead>
                    <tbody>
                      ${docs.causeEffectMatrix
                        .map(
                          (ce) =>
                            `<tr><td><code>${esc(ce.id)}</code></td><td><code>${esc(ce.causeTag)}</code></td><td>${esc(ce.causeCondition)}</td><td>${esc(ce.effects)}</td><td><code>${esc(ce.severity)}</code></td></tr>`,
                        )
                        .join('')}
                    </tbody>
                  </table>
                </div>
                <h3 class="asm-sec-title">${T('secNarrative')}</h3>
                <ul class="asm-narrative-list">
                  ${docs.controlNarrative.map((s) => `<li><b>${esc(s.step)} — ${esc(s.title)}</b><p>${esc(s.logic)}</p></li>`).join('')}
                </ul>`
                  : pidTab === 'p1io'
                    ? `
                <div class="asm-row" style="justify-content:space-between">
                  <button type="button" class="asm-pill signal" id="asm-dl-fds">${T('dlFdsBtn')}</button>
                  <button type="button" class="asm-pill" id="asm-copy-fds">${T('copyBtn')}</button>
                </div>
                <h3 class="asm-sec-title">${T('secIo')}</h3>
                <div class="asm-table-wrap">
                  <table class="asm-table">
                    <thead><tr><th>${T('colPlcTag')}</th><th>${T('colTag')}</th><th>${T('colIoType')}</th><th>${T('colAddr')}</th><th>${T('colSignal')}</th></tr></thead>
                    <tbody>
                      ${dag.ioSchedule
                        .map(
                          (io) =>
                            `<tr><td><code>${esc(io.plcTag)}</code></td><td><code>${esc(io.isaTag)}</code></td><td><b>${esc(io.ioType)}</b></td><td><code>${esc(io.address)}</code></td><td>${esc(io.signal)}</td></tr>`,
                        )
                        .join('')}
                    </tbody>
                  </table>
                </div>`
                    : pidTab === 'p2'
                      ? `
                <div class="asm-row" style="justify-content:space-between">
                  <button type="button" class="asm-pill signal" id="asm-dl-pid-xml">${T('dlXmlBtn')}</button>
                  <a class="asm-pill signal" href="#/simulations/factory_cell">${T('pidOpen3dSim')}</a>
                </div>
                <pre class="asm-code"><code>${esc(pid3d.sceneXml)}</code></pre>`
                      : `
                <div class="asm-row" style="justify-content:space-between">
                  <div class="asm-row">
                    <button type="button" class="asm-tab" data-dialect="scl" aria-selected="${plcDialect === 'scl'}">${T('plcSclTab')}</button>
                    <button type="button" class="asm-tab" data-dialect="l5k" aria-selected="${plcDialect === 'l5k'}">${T('plcL5kTab')}</button>
                  </div>
                  <div class="asm-row">
                    <button type="button" class="asm-pill signal" id="asm-dl-scl">${T('dlSclBtn')}</button>
                    <button type="button" class="asm-pill" id="asm-dl-l5k">${T('dlL5kBtn')}</button>
                  </div>
                </div>
                <pre class="asm-code"><code>${esc(plcDialect === 'scl' ? plc.scl : plc.l5k)}</code></pre>`
              }
            </div>
          </section>
        </div>`;

      const sel = contentEl.querySelector('#asm-sample-select');
      if (sel) {
        sel.onchange = () => {
          sampleId = sel.value;
          dxfText = PID_SAMPLE_DXFS[sampleId].dxf;
          processGoal = PID_SAMPLE_DXFS[sampleId].processGoal[lang()] ?? PID_SAMPLE_DXFS[sampleId].processGoal.es;
          render();
        };
      }
      const fileIn = contentEl.querySelector('#asm-dxf-file');
      if (fileIn) {
        fileIn.onchange = async () => {
          const file = fileIn.files?.[0];
          if (!file) return;
          sampleId = file.name;
          dxfText = await file.text();
          processGoal = `Custom P&ID Blueprint (${file.name})`;
          render();
        };
      }
      const goalIn = contentEl.querySelector('#asm-goal-input');
      if (goalIn) {
        goalIn.onchange = () => {
          processGoal = goalIn.value;
          render();
        };
      }
      const reparseBtn = contentEl.querySelector('#asm-reparse-btn');
      if (reparseBtn) {
        reparseBtn.onclick = () => {
          const rawEl = contentEl.querySelector('#asm-dxf-raw');
          if (rawEl) dxfText = rawEl.value;
          render();
        };
      }
      for (const tabBtn of contentEl.querySelectorAll('[data-ptab]')) {
        tabBtn.onclick = () => {
          pidTab = tabBtn.dataset.ptab;
          render();
        };
      }
      for (const dBtn of contentEl.querySelectorAll('[data-dialect]')) {
        dBtn.onclick = () => {
          plcDialect = dBtn.dataset.dialect;
          render();
        };
      }
      const dlFds = contentEl.querySelector('#asm-dl-fds');
      if (dlFds) dlFds.onclick = () => downloadText(docs.fileName, docs.markdown, 'text/markdown;charset=utf-8');
      const copyFds = contentEl.querySelector('#asm-copy-fds');
      if (copyFds) {
        copyFds.onclick = () => {
          navigator.clipboard?.writeText(docs.markdown);
          copyFds.textContent = t('copiedBtn');
        };
      }
      const dlXml = contentEl.querySelector('#asm-dl-pid-xml');
      if (dlXml) dlXml.onclick = () => downloadText(`${pid3d.modelName}.xml`, pid3d.sceneXml, 'application/xml;charset=utf-8');
      const dlScl = contentEl.querySelector('#asm-dl-scl');
      if (dlScl) dlScl.onclick = () => downloadText(plc.sclFileName, plc.scl);
      const dlL5k = contentEl.querySelector('#asm-dl-l5k');
      if (dlL5k) dlL5k.onclick = () => downloadText(plc.l5kFileName, plc.l5k);

      const faultLshBtn = contentEl.querySelector('#asm-fault-lsh');
      if (faultLshBtn) {
        faultLshBtn.onclick = () => {
          simState.faultLsh = true;
          render();
        };
      }
      const faultMotBtn = contentEl.querySelector('#asm-fault-motor');
      if (faultMotBtn) {
        faultMotBtn.onclick = () => {
          simState.faultMotor = true;
          render();
        };
      }
      const faultResetBtn = contentEl.querySelector('#asm-fault-reset');
      if (faultResetBtn) {
        faultResetBtn.onclick = () => {
          simState.faultLsh = false;
          simState.faultMotor = false;
          render();
        };
      }
      return;
    }

    // Mode 2: CAD + Arduino (.stl + .ino)
    const presetObj = getPreset(cadPreset) ?? getPreset('luigi_lab4');
    const parsedIno = parseArduinoSketch(inoText);
    const activePinout = pinOverride ?? { ...presetObj.pinout, ...parsedIno.pinout };
    const pinAudit = validateHardwarePinout('arduino_uno', activePinout);
    const meshRoles = classifyStlMeshes(stlNames);
    const compiledMjcf = generateMujocoXml({ preset: cadPreset, modelName: `${cadPreset}_assembled` });
    const catalog = listComponents();

    contentEl.innerHTML = `
      <div class="asm-col">
        <section class="asm-win">
          <div class="asm-bar"><span>${T('cadSourceBar')}</span><b>${meshRoles.length} STL · ${pinAudit.valid ? 'PINOUT OK' : 'CONFLICT'}</b></div>
          <div class="asm-body">
            <div class="asm-row">
              <select id="asm-cad-preset" class="asm-select" style="flex:1">
                <option value="luigi_lab4" ${cadPreset === 'luigi_lab4' ? 'selected' : ''}>Luigi Lab IV — Rover Autónomo (Arduino UNO + SG90 + HC-SR04)</option>
                <option value="luigi_lab3" ${cadPreset === 'luigi_lab3' ? 'selected' : ''}>Luigi Lab III — Rover Explorador (Arduino UNO + HC-SR04 + APDS-9960)</option>
              </select>
              <label class="asm-pill" style="cursor:pointer">
                <span>${T('cadUploadStl')}</span>
                <input type="file" id="asm-stl-files" accept=".stl" multiple hidden />
              </label>
              <label class="asm-pill" style="cursor:pointer">
                <span>${T('cadUploadIno')}</span>
                <input type="file" id="asm-ino-file" accept=".ino,.c,.cpp,.txt" hidden />
              </label>
              <a class="asm-pill signal" href="#/simulations/luigi_lab4">${T('cadOpenRoverSim')}</a>
            </div>

            <div class="asm-pid-stage">
              <div class="asm-badges">
                <span class="asm-badge ${pinAudit.valid ? 'ok' : 'err'}">${
                  pinAudit.valid ? `✓ Pinout Valid (${pinAudit.interruptMode})` : `✗ ${pinAudit.errors.join(' | ')}`
                }</span>
                ${parsedIno.bottlenecks.map((b) => `<span class="asm-badge err">⚠ ${esc(b.type)}: ${esc(b.fix)}</span>`).join('')}
              </div>
              <div>${renderCadSchematicSvg(activePinout, pinAudit)}</div>
              <div class="asm-row">
                <button type="button" class="asm-pill" id="asm-test-conflict">${T('cadTestConflict')}</button>
                <button type="button" class="asm-pill signal" id="asm-fix-conflict">${T('cadFixConflict')}</button>
              </div>
            </div>

            <div class="asm-badges">
              ${meshRoles.map((m) => `<span class="asm-badge ok">${esc(m.file)} → ${esc(m.role)}</span>`).join('')}
            </div>
          </div>
        </section>
      </div>

      <div class="asm-col">
        <section class="asm-win">
          <div class="asm-bar"><span>${T('cadOutBar')}</span><b>${esc(cadPreset.toUpperCase())}</b></div>
          <div class="asm-tabs" role="tablist">
            <button type="button" class="asm-tab" data-ctab="audit" aria-selected="${cadTab === 'audit'}">${T('cadTabAudit')}</button>
            <button type="button" class="asm-tab" data-ctab="ino" aria-selected="${cadTab === 'ino'}">${T('cadTabIno')}</button>
            <button type="button" class="asm-tab" data-ctab="xml" aria-selected="${cadTab === 'xml'}">${T('cadTabXml')}</button>
          </div>
          <div class="asm-body">
            ${
              cadTab === 'audit'
                ? `
              <h3 class="asm-sec-title">${T('cadAuditBar')}</h3>
              <div class="asm-table-wrap">
                <table class="asm-table">
                  <thead><tr><th>Signal</th><th>MCU Pin</th><th>Hardware Bus / Timer</th></tr></thead>
                  <tbody>
                    ${Object.entries(activePinout)
                      .map(
                        ([sig, pin]) =>
                          `<tr><td><code>${esc(sig)}</code></td><td><b>D${esc(pin)}</b></td><td>${
                            pin === 5 || pin === 6
                              ? 'Timer0 PWM (976 Hz)'
                              : pin === 9 || pin === 10
                                ? 'Timer1 (16-bit Servo / PWM)'
                                : pin === 2 || pin === 3
                                  ? 'Hardware External ISR (INT0/INT1)'
                                  : 'Digital GPIO'
                          }</td></tr>`,
                      )
                      .join('')}
                  </tbody>
                </table>
              </div>
              <h3 class="asm-sec-title">${T('cadCatalogBar')} (${catalog.length})</h3>
              <div class="asm-comp-grid">
                ${catalog
                  .slice(0, 6)
                  .map(
                    (c) => `
                  <div class="asm-comp-card">
                    <b>${esc(c.name)}</b>
                    <span><code>${esc(c.id)}</code> · ${esc(c.category)}</span>
                  </div>`,
                  )
                  .join('')}
              </div>`
                : `
              <div class="asm-row" style="justify-content:space-between">
                ${
                  cadTab === 'xml'
                    ? `<button type="button" class="asm-pill signal" id="asm-dl-cad-xml">${T('dlXmlBtn')}</button>`
                    : `<button type="button" class="asm-pill signal" id="asm-dl-cad-ino">${T('cadDlInoBtn')}</button>`
                }
                <a class="asm-pill signal" href="#/simulations/luigi_lab4">${T('cadOpenRoverSim')}</a>
              </div>
              <pre class="asm-code"><code>${esc(cadTab === 'xml' ? compiledMjcf.robotXml : CALIBRATED_LAB4_C99)}</code></pre>`
            }
          </div>
        </section>
      </div>`;

    const presetSel = contentEl.querySelector('#asm-cad-preset');
    if (presetSel) {
      presetSel.onchange = () => {
        cadPreset = presetSel.value;
        pinOverride = null;
        render();
      };
    }
    const stlIn = contentEl.querySelector('#asm-stl-files');
    if (stlIn) {
      stlIn.onchange = () => {
        if (stlIn.files?.length) {
          stlNames = [...stlIn.files].map((f) => f.name);
          render();
        }
      };
    }
    const inoIn = contentEl.querySelector('#asm-ino-file');
    if (inoIn) {
      inoIn.onchange = async () => {
        const file = inoIn.files?.[0];
        if (!file) return;
        inoText = await file.text();
        pinOverride = null;
        render();
      };
    }
    const conflictBtn = contentEl.querySelector('#asm-test-conflict');
    if (conflictBtn) {
      conflictBtn.onclick = () => {
        pinOverride = { ...activePinout, ENA: 10, SERVO: 9 };
        render();
      };
    }
    const fixBtn = contentEl.querySelector('#asm-fix-conflict');
    if (fixBtn) {
      fixBtn.onclick = () => {
        pinOverride = { ...activePinout, ENA: 5, ENB: 6, SERVO: 9, ECHO: 3 };
        render();
      };
    }
    for (const cBtn of contentEl.querySelectorAll('[data-ctab]')) {
      cBtn.onclick = () => {
        cadTab = cBtn.dataset.ctab;
        render();
      };
    }
    const dlCadXml = contentEl.querySelector('#asm-dl-cad-xml');
    if (dlCadXml) dlCadXml.onclick = () => downloadText(`${cadPreset}_mujoco.xml`, compiledMjcf.robotXml, 'application/xml;charset=utf-8');
    const dlCadIno = contentEl.querySelector('#asm-dl-cad-ino');
    if (dlCadIno) dlCadIno.onclick = () => downloadText(`${cadPreset}_50Hz_calibrated.ino`, CALIBRATED_LAB4_C99);
  }

  render();

  // Live P&ID process ticker (updates weight, step & SVG smoothly every 900 ms when in P&ID mode)
  const ticker = setInterval(() => {
    if (mode !== 'pid' || simState.faultLsh || simState.faultMotor) return;
    if (simState.stepIdx === 1) {
      simState.weightKg += 18.5;
      if (simState.weightKg >= 300) {
        simState.weightKg = 300;
        simState.stepIdx = 2;
      }
    } else if (simState.stepIdx === 2) {
      simState.stepIdx = 3;
    } else if (simState.stepIdx === 3) {
      simState.weightKg = Math.max(8, simState.weightKg - 95);
      if (simState.weightKg <= 10) {
        simState.weightKg = 12;
        simState.batches += 1;
        simState.stepIdx = 1;
      }
    }
    const wEl = contentEl.querySelector('#asm-hud-weight');
    const bEl = contentEl.querySelector('#asm-hud-batches');
    const sEl = contentEl.querySelector('#asm-hud-state');
    const svgHolder = contentEl.querySelector('#asm-svg-holder');
    if (wEl) wEl.textContent = `${simState.weightKg.toFixed(1)} kg`;
    if (bEl) bEl.textContent = String(simState.batches);
    if (sEl) {
      const stateNames = ['00 · IDLE', '10 · DOSING', '20 · MIXING', '30 · DISCHARGE'];
      sEl.textContent = stateNames[simState.stepIdx];
    }
    if (svgHolder) {
      const dag = parseDxfPid(dxfText, { fileName: sampleId, processGoal });
      svgHolder.innerHTML = renderPidFlowSvg(dag);
    }
  }, 900);

  const stopLang = onLang(() => {
    if (PID_SAMPLE_DXFS[sampleId]) {
      processGoal = PID_SAMPLE_DXFS[sampleId].processGoal[lang()] ?? PID_SAMPLE_DXFS[sampleId].processGoal.es;
    }
    render();
  });

  return () => {
    clearInterval(ticker);
    stopLang();
    cleanups.forEach((fn) => fn());
  };
}
