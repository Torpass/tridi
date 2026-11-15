// #/assembler copy in Spanish and English (src/i18n.js).
import { dict } from '../../i18n.js';

export const title = { es: 'Factory Assembler', en: 'Factory Assembler' };

export const { T, t, A } = dict({
  kicker: {
    es: '// TRIDI FACTORY ASSEMBLER · LA IA RAZONA Y EL CÓDIGO ENSAMBLA',
    en: '// TRIDI FACTORY ASSEMBLER · AI REASONS, CODE ASSEMBLES',
  },
  title: {
    es: 'De planos P&ID (.dxf) o piezas CAD (.stl + .ino) a gemelo físico, docs ISA-5.1 y código determinista',
    en: 'From P&ID blueprints (.dxf) or CAD parts (.stl + .ino) to physics twin, ISA-5.1 docs & deterministic code',
  },
  lede: {
    es: 'Arquitectura determinista sin cajas negras: parsea tus etiquetas ISA-5.1 o tu pinout de microcontrolador, verifica el 100 % de las fuentes sin alucinar componentes y genera la ingeniería completa lista para campo.',
    en: 'Deterministic architecture with zero black boxes: parses your ISA-5.1 tags or microcontroller pinout, verifies 100% of sources without hallucinating components, and generates field-ready engineering.',
  },
  backHome: { es: '← Inicio', en: '← Home' },
  goSims: { es: 'Simulaciones', en: 'Simulations' },

  modeAria: { es: 'Canal de ensamblaje', en: 'Assembly channel' },
  modePid: {
    es: '01 · Planta Industrial P&ID (.dxf)',
    en: '01 · Industrial Plant P&ID (.dxf)',
  },
  modeCad: {
    es: '02 · Robot CAD (.stl + .ino)',
    en: '02 · Robot CAD (.stl + .ino)',
  },

  // 3-step visual pipeline banner
  step1Pid: { es: 'Plano P&ID (.dxf)', en: 'P&ID Blueprint (.dxf)' },
  step1PidSub: { es: 'Detecta válvulas, tanques y lazos ISA-5.1', en: 'Detects valves, tanks & ISA-5.1 loops' },
  step2Pid: { es: 'Gemelo de Proceso', en: 'Live Process Twin' },
  step2PidSub: { es: 'Simula llenado S88 e inyecta fallas', en: 'Simulates S88 batch & fault trips' },
  step3Pid: { es: 'Docs ISA + Código PLC', en: 'ISA Docs + PLC Code' },
  step3PidSub: { es: 'Exporta FDS .md, .scl, .L5K y MuJoCo .xml', en: 'Exports FDS .md, .scl, .L5K & MuJoCo .xml' },

  step1Cad: { es: 'Piezas CAD + Sketch', en: 'CAD Parts + Sketch' },
  step1CadSub: { es: 'Clasifica mallas .stl y pines del .ino', en: 'Classifies .stl meshes & .ino pinout' },
  step2Cad: { es: 'Auditoría de Hardware', en: 'Hardware Pinout Audit' },
  step2CadSub: { es: 'Detecta choques Timer1, pulseIn y deadzones', en: 'Detects Timer1 conflicts, pulseIn & deadzones' },
  step3Cad: { es: 'Gemelo 3D + Firmware C99', en: '3D Twin + C99 Firmware' },
  step3CadSub: { es: 'Exporta MuJoCo .xml y lazo a 50 Hz (.ino)', en: 'Exports MuJoCo .xml & 50 Hz loop (.ino)' },

  // Mode 1: P&ID (.dxf)
  pidSourceBar: { es: '01 · plano p&id (.dxf) y gemelo interactivo del proceso', en: '01 · p&id blueprint (.dxf) & interactive process twin' },
  pidPickSample: { es: 'Plano P&ID (.dxf)', en: 'P&ID Blueprint (.dxf)' },
  pidUploadBtn: { es: '+ Subir .dxf', en: '+ Upload .dxf' },
  pidGoalLabel: { es: 'Objetivo operativo del proceso (ISA-88)', en: 'Operational process objective (ISA-88)' },
  pidRawToggle: { es: 'Ver / editar entidades .dxf crudas', en: 'View / edit raw .dxf entities' },
  pidReparseBtn: { es: 'Re-analizar P&ID', en: 'Re-parse P&ID' },
  pidVerifiedBadge: { es: '✓ 100 % tags verificados en el .dxf', en: '✓ 100% tags verified in .dxf' },

  pidTwinBar: { es: 'prioridad 2 — gemelo interactivo del proceso y prueba de fallas', en: 'priority 2 — interactive process twin & fault stress-test' },
  pidStepLabel: { es: 'Fase ISA-88', en: 'ISA-88 Phase' },
  pidScaleLabel: { es: 'Báscula (WT)', en: 'Scale (WT)' },
  pidBatchCount: { es: 'Lotes listos', en: 'Batches done' },
  pidFaultLsh: { es: '⚡ Falla: Sobrellenado LSH', en: '⚡ Fault: LSH Overfill' },
  pidFaultMotor: { es: '⚡ Falla: Relé Motor', en: '⚡ Fault: Motor Overload' },
  pidFaultReset: { es: '↺ Rearmar planta', en: '↺ Reset plant' },
  pidOpen3dSim: { es: 'Ver Celda en 3D →', en: 'Open 3D Cell →' },

  pidOutBar: { es: '02 · entregables generados (docs isa-5.1 + código plc + 3d)', en: '02 · generated deliverables (isa-5.1 docs + plc code + 3d)' },
  tabP1: { es: '1 · Enclavamientos y S88', en: '1 · Interlocks & S88' },
  tabP1Io: { es: '2 · Tabla Equipos e I/O', en: '2 · Equipment & I/O Table' },
  tabP3: { es: '3 · Código PLC (.scl / .L5K)', en: '3 · PLC Code (.scl / .L5K)' },
  tabP2: { es: '4 · Escena 3D (.xml)', en: '4 · 3D Scene (.xml)' },

  dlFdsBtn: { es: 'Descargar FDS ISA-5.1 (.md) ↓', en: 'Download ISA-5.1 FDS (.md) ↓' },
  dlXmlBtn: { es: 'Descargar MuJoCo MJCF (.xml) ↓', en: 'Download MuJoCo MJCF (.xml) ↓' },
  dlSclBtn: { es: 'Descargar Siemens TIA Portal (.scl) ↓', en: 'Download Siemens TIA Portal (.scl) ↓' },
  dlL5kBtn: { es: 'Descargar Rockwell Studio 5000 (.L5K) ↓', en: 'Download Rockwell Studio 5000 (.L5K) ↓' },
  copyBtn: { es: 'Copiar al portapapeles', en: 'Copy to clipboard' },
  copiedBtn: { es: '✓ Copiado', en: '✓ Copied' },

  secEquip: { es: '1. Cédula de Equipos e Instrumentación (ISA-5.1)', en: '1. Equipment & Instrument Schedule (ISA-5.1)' },
  secIo: { es: '2. Lista de Entradas y Salidas del PLC (I/O Schedule)', en: '2. PLC I/O Assignment Schedule' },
  secNarrative: { es: '3. Filosofía de Operación Paso a Paso (ISA-88)', en: '3. Step-by-Step Control Narrative (ISA-88)' },
  secMatrix: { es: '4. Matriz Causa-Efecto de Enclavamientos (Safety Interlocks)', en: '4. Cause & Effect Safety Interlock Matrix' },

  colTag: { es: 'Tag ISA', en: 'ISA Tag' },
  colCat: { es: 'Categoría', en: 'Category' },
  colFunc: { es: 'Función ISA-5.1', en: 'ISA-5.1 Function' },
  colBlock: { es: 'Bloque PLC', en: 'PLC Block' },
  colFailSafe: { es: 'Estado Fail-Safe', en: 'Fail-Safe State' },
  colPlcTag: { es: 'Tag Simbólico', en: 'Symbolic Tag' },
  colIoType: { es: 'Tipo', en: 'Type' },
  colAddr: { es: 'Dirección', en: 'Address' },
  colSignal: { es: 'Señal Eléctrica', en: 'Electrical Signal' },
  colCause: { es: 'Causa (Condición de Disparo)', en: 'Cause (Trip Condition)' },
  colEffect: { es: 'Efecto Determinista en PLC', en: 'Deterministic PLC Effect' },
  colSev: { es: 'Severidad', en: 'Severity' },

  plcDialectLabel: { es: 'Estándar de exportación PLC', en: 'PLC export dialect' },
  plcSclTab: { es: 'Siemens TIA Portal (.scl — IEC 61131-3)', en: 'Siemens TIA Portal (.scl — IEC 61131-3)' },
  plcL5kTab: { es: 'Rockwell Studio 5000 (.L5K — Logix AOI)', en: 'Rockwell Studio 5000 (.L5K — Logix AOI)' },

  // Mode 2: CAD + Arduino (.stl + .ino)
  cadSourceBar: { es: '01 · esquema de hardware (.stl + .ino) y auditoría de pines', en: '01 · hardware schematic (.stl + .ino) & pinout audit' },
  cadPresetLabel: { es: 'Preset de robot físico (o sube tus archivos .stl y .ino)', en: 'Physical robot preset (or upload your .stl & .ino files)' },
  cadUploadStl: { es: '+ Subir .stl', en: '+ Upload .stl' },
  cadUploadIno: { es: '+ Subir .ino', en: '+ Upload .ino' },
  cadTestConflict: { es: '⚡ Simular choque Timer1 (ENA=D10 + Servo=D9)', en: '⚡ Simulate Timer1 conflict (ENA=D10 + Servo=D9)' },
  cadFixConflict: { es: '✓ Restaurar pinout válido (D5/D6 Timer0)', en: '✓ Restore valid pinout (D5/D6 Timer0)' },
  cadAuditBar: { es: 'auditoría determinista de pinout, timers y cuellos de botella', en: 'deterministic pinout, timer & bottleneck audit' },
  cadCatalogBar: { es: 'catálogo cerrado de componentes mecatrónicos calibrados', en: 'closed catalog of calibrated mechatronic components' },
  cadOutBar: { es: '02 · entregables generados (auditoría + firmware c99 + mujoco 3d)', en: '02 · generated deliverables (audit + c99 firmware + 3d mujoco)' },
  cadTabAudit: { es: '1 · Tabla Pinout y Catálogo', en: '1 · Pinout Table & Catalog' },
  cadTabIno: { es: '2 · Firmware C99 (50 Hz .ino)', en: '2 · C99 Firmware (50 Hz .ino)' },
  cadTabXml: { es: '3 · Modelo 3D MuJoCo (.xml)', en: '3 · 3D MuJoCo Model (.xml)' },
  cadOpenRoverSim: { es: 'Ver Rover en 3D →', en: 'Open 3D Rover →' },
  cadDlInoBtn: { es: 'Descargar Firmware C99 (.ino) ↓', en: 'Download C99 Firmware (.ino) ↓' },
});
