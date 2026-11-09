// Copy for #/milestones (#/avances): Tridi's real-world Sim-to-Real case study (Luigi's robot)
// and the Platanus Hack 26 Caracas origin story + live pitch video.
import { dict } from '../../i18n.js';

export const title = { es: 'Avances y casos reales', en: 'Milestones & Field Notes' };

export const { T, t, A } = dict({
  back: { es: 'Volver al inicio', en: 'Back to home' },
  head: { es: 'Avances y casos reales', en: 'Milestones & Field Notes' },
  lede: {
    es: 'De las 48 horas en Platanus Hack 26 Caracas al primer robot físico controlado en el suelo por una política entrenada en Tridi.',
    en: 'From 48 hours at Platanus Hack 26 Caracas to the first physical robot driven on the floor by a policy trained in Tridi.',
  },
  tabSim2Real: {
    es: '02 · Caso Real Sim-to-Real (Nov 2026)',
    en: '02 · Physical Sim-to-Real Case (Nov 2026)',
  },
  tabHackathon: {
    es: '01 · Origen en Platanus Hack 26 (Oct 2026)',
    en: '01 · Platanus Hack 26 Origin (Oct 2026)',
  },

  // Milestone 02 — Sim-to-Real with Luigi's robot
  'm2.badge': { es: 'Hito 02 · Noviembre 2026 · Primer Sim-to-Real físico', en: 'Milestone 02 · November 2026 · First physical Sim-to-Real' },
  'm2.title': {
    es: 'Del CAD y MuJoCo al piso de la sala: primer robot físico corriendo una política de Tridi a 50 Hz',
    en: 'From CAD & MuJoCo to the living-room floor: first physical robot running a 50 Hz Tridi policy',
  },
  'm2.intro': {
    es: 'Antes de tocar un humanoide físico de miles de dólares, validamos el ciclo completo de Tridi de punta a punta en una sola noche sobre el robot explorador diferencial de Luigi D’Aquaro (Lab 3): importamos sus 6 piezas CAD STL a MuJoCo, exportamos la política ONNX, conectamos el gemelo digital por WebSerial USB y embebimos la red a 50 Hz directamente en su microcontrolador.',
    en: 'Before touching a multi-thousand-dollar physical humanoid, we validated Tridi’s end-to-end pipeline in a single evening on Luigi D’Aquaro’s differential explorer robot (Lab 3): importing its 6 CAD STL meshes into MuJoCo, exporting the ONNX policy, linking the digital twin over WebSerial USB, and embedding the 50 Hz network directly onto its microcontroller.',
  },
  'm2.vidFloorLabel': {
    es: 'Prueba real en piso (2:19) · Política Tridi 50 Hz + evasión en lazo cerrado',
    en: 'Real floor test (2:19) · 50 Hz Tridi policy + closed-loop obstacle evasion',
  },
  'm2.vidFloorCap': {
    es: 'El robot rueda desconectado de la computadora, ejecutando las curvas diferenciales de Tridi a 50 Hz y esquivando zapatos, muebles, el sofá y cables sin un solo choque.',
    en: 'Unplugged from any computer, the robot executes Tridi’s smooth 50 Hz differential curves and dodges shoes, furniture, the couch and floor cables without a single collision.',
  },
  'm2.vidHwLabel': {
    es: 'Inspección del hardware (1:29) · Chasis STL + Arduino UNO + L298N + Radar IR 0x9E',
    en: 'Inside the hardware (1:29) · 3D-printed STL chassis + Arduino UNO + L298N + 0x9E IR Radar',
  },
  'm2.vidHwCap': {
    es: 'Dos motores TT con reductora (200 RPM, llantas de TPU), batería 2S 18650 (7,4 V), puente H L298N, ultrasónico HC-SR04 y sensor óptico I2C APDS-9960.',
    en: 'Dual TT gearmotors (200 RPM, TPU tires), 2S 18650 battery pack (7.4 V), L298N H-bridge, HC-SR04 ultrasonic sensor and APDS-9960 I2C optical sensor.',
  },
  'm2.ctaSim': { es: 'Abrir el robot de Luigi en Simulaciones →', en: 'Open Luigi’s robot in Simulations →' },

  'm2.galleryTitle': {
    es: 'Arquitectura física: del diseño paramétrico al montaje real',
    en: 'Physical architecture: from parametric blueprint to real assembly',
  },
  'm2.g1.tag': { es: 'Ensamble 3D', en: '3D Assembly' },
  'm2.g1.cap': {
    es: 'Modelo paramétrico completo (frente, atrás y planta inferior) exportado a 6 mallas STL para MuJoCo.',
    en: 'Full parametric CAD assembly (front, rear & bottom views) exported to 6 STL meshes for MuJoCo.',
  },
  'm2.g2.tag': { es: 'Plano en planta', en: 'Top Blueprint' },
  'm2.g2.cap': {
    es: 'Distribución real de masas: puente H L298N atrás, Arduino UNO al centro, protoboard y cabezal de sensores al frente.',
    en: 'Mass distribution blueprint: L298N H-bridge at rear, Arduino UNO center, breadboard & sensor head at front.',
  },
  'm2.g3.tag': { es: 'Soporte frontal', en: 'Front Bracket' },
  'm2.g3.cap': {
    es: 'Soporte frontal con ojos ultrasónicos HC-SR04 (Trig D9 / Echo A1) y ranura para el radar IR APDS-9960.',
    en: 'Front bracket housing the HC-SR04 ultrasonic eyes (Trig D9 / Echo A1) and APDS-9960 IR radar slot.',
  },
  'm2.g4.tag': { es: 'Sensores HC-SR04 + IR', en: 'HC-SR04 + IR Sensors' },
  'm2.g4.cap': {
    es: 'Montaje del HC-SR04 y el módulo APDS-9960 (Chip ID 0x9E) sobresaliendo al frente con arnés Dupont.',
    en: 'Front mount of the HC-SR04 and APDS-9960 module (Chip ID 0x9E) cantilevered ahead with Dupont harness.',
  },
  'm2.g5.tag': { es: 'Arduino UNO + L298N', en: 'Arduino UNO + L298N' },
  'm2.g5.cap': {
    es: 'Cableado sobre el chasis: Arduino UNO (ATmega328P), driver L298N con disipador y bus I2C en protoboard.',
    en: 'Chassis wiring: Arduino UNO (ATmega328P), heatsinked L298N driver, and I2C bus on mini breadboard.',
  },
  'm2.g6.tag': { es: 'Motores TT + Baterías', en: 'TT Motors + Battery' },
  'm2.g6.cap': {
    es: 'Vista inferior: 2 baterías IMR18650B (7,4 V), 2 motores TT amarillos (200 RPM), llantas TPU y patín delantero.',
    en: 'Underside view: 2× IMR18650B cells (7.4 V), dual yellow TT gearmotors (200 RPM), TPU tires & front skid.',
  },

  'm2.stepsTitle': {
    es: 'Cómo resolvimos cada etapa (y los 4 problemas reales de hardware)',
    en: 'How we solved each stage (and the 4 real hardware bottlenecks)',
  },
  'm2.s1.title': { es: '01 · Del CAD (6 STLs) al Gemelo Digital en MuJoCo y ONNX', en: '01 · From CAD (6 STLs) to MuJoCo Digital Twin & ONNX' },
  'm2.s1.body': {
    es: 'Reconstruimos el robot en physics/models/luigi_lab3/luigi.xml con sus 6 mallas STL reales, masa de componentes y actuadores diferenciales a 20,94 rad/s (200 RPM). Exportamos training/policies/luigi-lab3.onnx (15 observaciones, 2 motores) y conectamos el robot físico en vivo al navegador mediante WebSerial USB a 9600 baud.',
    en: 'We rebuilt the robot in physics/models/luigi_lab3/luigi.xml using its 6 real STL meshes, component masses and differential actuators at 20.94 rad/s (200 RPM), exported training/policies/luigi-lab3.onnx (15 observations, 2 actuators), and linked the physical robot live to the browser over 9600-baud WebSerial USB.',
  },
  'm2.s2.title': { es: '02 · Caber en 2 KB de RAM y vencer la fricción estática del piso', en: '02 · Fitting in 2 KB of RAM & overcoming floor static friction' },
  'm2.s2.body': {
    es: 'El ATmega328P del Arduino UNO solo tiene 2 KB de RAM. Transpilamos el grafo matemático de luigi-lab3.onnx a C nativo (usando solo 461 bytes de RAM, 22 %) corriendo cada 20 ms (50 Hz), y mapeamos la salida de rad/s a PWM [115..200] para vencer la zona muerta de fricción de las llantas de TPU.',
    en: 'The Arduino UNO’s ATmega328P has only 2 KB of RAM. We transpiled luigi-lab3.onnx’s math graph into native C (using just 461 bytes of RAM, 22%) running every 20 ms (50 Hz), and mapped rad/s targets to PWM [115..200] to overcome the TPU tires’ static friction deadzone.',
  },
  'm2.s3.title': { es: '03 · Interrupción PCINT1 para eliminar el bloqueo de 47,1 ms del HC-SR04', en: '03 · PCINT1 hardware interrupt to eliminate HC-SR04’s 47.1 ms block' },
  'm2.s3.body': {
    es: 'Con diagnóstico por USB medimos que cuando el HC-SR04 no recibe eco mantiene el pin ECHO en HIGH durante 47.136 µs (47,1 ms), congelando pulseIn() por más de dos ciclos de la red. Lo reemplazamos por una interrupción de hardware (ISR(PCINT1_vect) en A1) que mide el eco en segundo plano en 0,01 ms sin frenar jamás el control de 50 Hz.',
    en: 'Live USB diagnostics revealed that when the HC-SR04 receives no echo, it holds ECHO HIGH for 47,136 µs (47.1 ms), freezing pulseIn() for over two policy cycles. We replaced it with a hardware pin-change interrupt (ISR(PCINT1_vect) on A1) that measures echoes in 0.01 ms without ever stalling the 50 Hz loop.',
  },
  'm2.s4.title': { es: '04 · El hallazgo del clon APDS-9960 (Chip ID 0x9E) y esquive en 4 etapas', en: '04 · The APDS-9960 clone discovery (Chip ID 0x9E) & 4-stage dodge' },
  'm2.s4.body': {
    es: 'En las primeras pruebas el robot no veía las manos ni el sofá: al escanear el bus I2C (0x39) descubrimos que el sensor físico tenía Chip ID = 0x9E (rechazado por la librería SparkFun_APDS9960, que apagaba el sensor). Escribimos un driver I2C directo sobre los registros 0x80–0x9C en modo Radar Infrarrojo continuo (40 Hz) con auto-calibración al encender y maniobra de esquive en 4 fases (freno en seco -230 PWM → reversa → giro de 90° → verificación de despeje).',
    en: 'In early floor runs the robot missed hands and couches: scanning I2C (0x39) revealed the physical sensor had Chip ID = 0x9E (rejected by SparkFun_APDS9960, which silently disabled it). We wrote a direct register-level I2C driver (0x80–0x9C) running continuous 40 Hz IR radar with power-on auto-calibration and a 4-stage closed-loop dodge (active brake -230 PWM → reverse → 90° pivot → clear-path check).',
  },

  // Milestone 01 — Platanus Hack 26 Caracas
  'm1.badge': { es: 'Hito 01 · Octubre 2026 · Platanus Hack 26 Caracas', en: 'Milestone 01 · October 2026 · Platanus Hack 26 Caracas' },
  'm1.title': {
    es: 'Dónde nació Tridi: demo y presentación en vivo en Platanus Hack 26 Caracas',
    en: 'Where Tridi was born: live demo & pitch at Platanus Hack 26 Caracas',
  },
  'm1.intro': {
    es: 'Del 23 al 25 de octubre de 2026, justo saliendo del Startup Venezuela Summit, nos encerramos 48 horas en las oficinas de Yummy en Caracas para la edición venezolana de Platanus Hack 26. Ahí construimos la primera versión de Tridi (Juan Villa, Pastor Jiménez, César Martínez y Alejandro Hernández, con la mentoría de Sebastián Alcalá) bajo una premisa clara: ChatGPT tuvo todo internet para entrenarse, pero los robots no tienen datos de movimiento físico.',
    en: 'From October 23 to 25, 2026, straight out of the Startup Venezuela Summit, we locked in for 48 hours at Yummy’s offices in Caracas for Platanus Hack 26. There we built the first version of Tridi (Juan Villa, Pastor Jiménez, César Martínez and Alejandro Hernández, mentored by Sebastián Alcalá) on a simple premise: ChatGPT had the whole internet to train on, but robots have no physical motion data.',
  },
  'm1.vidLabel': {
    es: 'Pitch y demo en vivo en Platanus Hack 26 Caracas (2:53 · sin ronda de preguntas)',
    en: 'Live pitch & demo at Platanus Hack 26 Caracas (2:53 · before Q&A)',
  },
  'm1.vidCap': {
    es: 'Transmisión oficial del pitch final en Caracas (domingo 25 de octubre de 2026), mostrando la captura en vivo, el humanoide Unitree G1 en MuJoCo y la red neuronal entrenando en tiempo real en la Mac.',
    en: 'Official stream of the final pitch in Caracas (Sunday, October 25, 2026), showing live capture, the Unitree G1 humanoid in MuJoCo, and the neural network training live on the Mac.',
  },
  'm1.evolTitle': {
    es: 'Qué evolucionó desde ese fin de semana hasta hoy',
    en: 'What evolved from that weekend to today',
  },
  'm1.e1.title': { es: 'Captura 2.0 (GVHMR + WiLoR + 5 dedos)', en: 'Capture 2.0 (GVHMR + WiLoR + 5-finger hands)' },
  'm1.e1.body': {
    es: 'Pasamos del esqueleto básico de MediaPipe en la hackathon a reconstrucción SMPL-X en coordenadas del mundo (41 puntos anatómicos + 21 puntos por mano con < 2 cm de error en puntas de dedos) y despegue aéreo real en saltos y carrera.',
    en: 'We upgraded from the hackathon’s MediaPipe skeleton to world-grounded SMPL-X reconstruction (41 body landmarks + 21 keypoints per hand with < 2 cm fingertip error) and true aerial flight phases in jumps and running.',
  },
  'm1.e2.title': { es: 'De 60 M a 300 M de pasos y 9 políticas completas', en: 'From 60M to 300M steps & 9 full imitation policies' },
  'm1.e2.body': {
    es: 'En la hackathon la caminata seguía 3,5 s de 11,8 s. Hoy las 9 políticas de imitación (caminar, correr, jumping jacks, saludar, contar con los dedos, bailar, caminar de frente, sentarse y Unitree H1) completan el 100 % del clip, y la política de equilibrio de 300 M de pasos resiste 4 de 4 empujones de hasta 320 N.',
    en: 'At the hackathon our walk followed 3.5 s of 11.8 s. Today all 9 imitation policies (walk, run, jumping jacks, wave, finger counting, dance, walk forward, sit and Unitree H1) complete 100% of their clips, and our 300M-step balance policy holds 4 of 4 pushes up to 320 N.',
  },
  'm1.e3.title': { es: 'De la simulación en navegador al hardware físico (Sim-to-Real)', en: 'From browser simulation to physical hardware (Sim-to-Real)' },
  'm1.e3.body': {
    es: 'Cerramos el eslabón que faltaba en la hackathon: conectar Tridi por WebSerial a un robot real y compilar la política ONNX a 50 Hz dentro del microcontrolador para que navegue y esquive obstáculos en el mundo físico.',
    en: 'We closed the link missing at the hackathon: connecting Tridi over WebSerial to a physical robot and compiling the 50 Hz ONNX policy onto its microcontroller to navigate and dodge obstacles in the physical world.',
  },
});
