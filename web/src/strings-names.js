// Names that come from data files in Spanish (physics/worlds, physics/scenes, policies.js levels,
// preloaded clips), in every language. Each maps an id to { es, en }; an id missing here keeps its
// own title in both, so a new world shows up untranslated rather than not at all.
const WORLDS = {
  plano: { es: 'Piso plano', en: 'Flat floor' },
  resbaloso: { es: 'Piso resbaloso', en: 'Slippery floor' },
  piedras: { es: 'Piedras', en: 'Stones' },
  viento: { es: 'Viento', en: 'Wind' },
};
const SCENES = {
  cocina: { es: 'Cocina', en: 'Kitchen' },
  deposito: { es: 'Depósito', en: 'Warehouse' },
  vereda: { es: 'Vereda', en: 'Sidewalk' },
};
const ROBOTS = {
  unitree_g1: { es: 'Humanoide Unitree G1 (29 motores + manos 5 dedos)', en: 'Unitree G1 Humanoid (29 motors + 5-finger hands)' },
  luigi_lab3: {
    es: 'Rover Luigi v1 — Sensores Fijos (Arduino UNO + HC-SR04 + APDS-9960)',
    en: 'Luigi Rover v1 — Fixed Sensors (Arduino UNO + HC-SR04 + APDS-9960)',
  },
  luigi_lab4: {
    es: 'Rover Luigi v2 — Radar Servo Móvil (Arduino UNO + SG90 + HC-SR04)',
    en: 'Luigi Rover v2 — Pan Servo Radar (Arduino UNO + SG90 + HC-SR04)',
  },
  factory_cell: {
    es: 'Celda Industrial — Empaquetadora Cronometrada (PLC S7-1200 / PackML)',
    en: 'Industrial Cell — Timed Packaging Line (S7-1200 PLC / PackML)',
  },
  unitree_h1: { es: 'Unitree H1 (19 motores, open-source)', en: 'Unitree H1 (19 motors, open-source)' },
};
const LEVELS = {
  'luigi-lab3': {
    es: 'Robot Lab III (Luigi) · Exploración y evasión con física (5 M pasos, 200 RPM)',
    en: 'Lab III Robot (Luigi) · Physics exploration & obstacle avoidance (5M steps, 200 RPM)',
  },
  'luigi-lab4': {
    es: 'Robot Lab IV (Luigi) · Escaneo activo SG90 + evasión continua 50 Hz (10 M pasos)',
    en: 'Lab IV Robot (Luigi) · Active SG90 radar sweep + 50 Hz continuous avoidance (10M steps)',
  },
  'factory-cell': {
    es: 'Celda Industrial · Sincronización por sensores ópticos (0 % merma frente a falla de cinta)',
    en: 'Industrial Cell · Optical-sensor synchronization (0% waste under belt slip fault)',
  },
  'g1-stand-step-0': { es: 'Sin entrenar', en: 'Untrained' },
  'g1-stand-step-3000000': { es: '3 millones de pasos', en: '3 million steps' },
  'g1-stand-step-10000000': { es: '10 millones de pasos', en: '10 million steps' },
  'g1-stand-step-20000768': { es: '20 millones de pasos', en: '20 million steps' },
  'g1-stand-step-100000000': { es: '100 millones de pasos (4 de 4 empujones)', en: '100 million steps (4 of 4 pushes)' },
  'g1-stand-v2': { es: '40 millones de pasos (4 de 4 empujones, girando)', en: '40 million steps (4 of 4 pushes, turning)' },
  'g1-stand-quiet': { es: '48 millones de pasos, quieta (3 de 4 empujones)', en: '48 million steps, still (3 of 4 pushes)' },
  'g1-stand-step-300000000': {
    es: '300 millones de pasos (4 mundos, 4 de 4 empujones)',
    en: '300 million steps (4 worlds, 4 of 4 pushes)',
  },
  'g1-stand': { es: '60 millones de pasos', en: '60 million steps' },
  'g1-walk': {
    es: 'Caminar imitando el video, con física (65 % de empujones)',
    en: 'Walking imitating the video, with physics (65% of pushes)',
  },
  'h1-walk': {
    es: 'Unitree H1 · Caminar imitando el video, con física',
    en: 'Unitree H1 · Walking imitating the video, with physics',
  },
  'g1-run': {
    es: 'Correr imitando el video, con física',
    en: 'Running imitating the video, with physics',
  },
  'g1-jacks': {
    es: 'Saltos de tijera imitando el video, con física',
    en: 'Jumping jacks imitating the video, with physics',
  },
  'g1-saludar': {
    es: 'Gestos imitando el video, con física',
    en: 'Gestures imitating the video, with physics',
  },
  'g1-dedos': {
    es: 'Contar con los dedos imitando el video, con física',
    en: 'Counting on fingers imitating the video, with physics',
  },
  'g1-bailar': {
    es: 'Bailar imitando el video, con física',
    en: 'Dancing imitating the video, with physics',
  },
  'g1-frente': {
    es: 'Caminar hacia la cámara imitando el video, con física',
    en: 'Walking toward the camera imitating the video, with physics',
  },
  'g1-sentarse': {
    es: 'Sentarse y levantarse imitando el video, con física',
    en: 'Sitting down and standing up imitating the video, with physics',
  },
};

const pick = (table) => (id, fallback) => table[id] ?? { es: fallback ?? id, en: fallback ?? id };
export const worldName = pick(WORLDS);
export const sceneName = pick(SCENES);
export const robotName = pick(ROBOTS);
export const levelName = pick(LEVELS);

/** { es, en } as T() would write it: one span per language. */
export const spans = (byLang) => Object.entries(byLang).map(([l, text]) => `<span class="t" lang="${l}">${text}</span>`).join('');

// Preloaded clips (preloaded.json): title and credit. A clip made on this visit keeps its own.
const CLIPS = {
  'clip_2026-10-23_caminar-perfil_01': {
    title: { es: 'Caminar', en: 'Walking' },
    credit: { es: 'Video: Mixkit 4855, hombre caminando de perfil', en: 'Video: Mixkit 4855, man walking, side view' },
  },
  'clip_2026-10-23_correr-perfil_01': {
    title: { es: 'Correr', en: 'Running' },
    credit: { es: 'Video: Mixkit 4831, mujer corriendo en un parque', en: 'Video: Mixkit 4831, woman running in a park' },
  },
  clip_synthetic_march_01: {
    title: { es: 'Marcha sintética', en: 'Synthetic march' },
    credit: { es: 'Generada por código, para pruebas', en: 'Generated by code, for tests' },
  },
};
const esc = (text) => String(text ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;');

/** { title, credit }, each { es, en }, for a gallery item ({ clip, title, credit }). */
export const clipName = (item) => CLIPS[item.clip] ?? { title: both(item.title), credit: both(item.credit) };
const both = (value) => (value && typeof value === 'object' ? { es: esc(value.es), en: esc(value.en ?? value.es) } : { es: esc(value), en: esc(value) });
