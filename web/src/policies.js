// The trained policies of training/ (policy.onnx + policy.json each), as the levels of the pitch's
// ladder: the same robot untrained, half trained and trained. Vite bundles the files and gives
// them their URLs; nothing downloads until createSimView's loadPolicy asks for one.
const URLS = import.meta.glob('../../training/policies/*.{onnx,json}', { query: '?url', import: 'default', eager: true });

// The ladder, in order: the first run's checkpoints (v1, 20 M steps), then the runs that continue
// it. Steps are the training's own count of decisions (training/README.md).
export const LEVELS = [
  { id: 'g1-stand-step-0', label: 'Sin entrenar' },
  { id: 'g1-stand-step-3000000', label: '3 millones de pasos' },
  { id: 'g1-stand-step-10000000', label: '10 millones de pasos' },
  { id: 'g1-stand-step-20000768', label: '20 millones de pasos' },
  { id: 'g1-stand-quiet', label: '48 millones de pasos, quieta (3 de 4 empujones)' },
  { id: 'g1-stand-step-100000000', label: '100 millones de pasos (4 de 4 empujones)' },
  { id: 'g1-stand-v2', label: '100 millones de pasos (stand v2)' },
  { id: 'g1-stand-step-300000000', label: '300 millones de pasos (4 mundos, 4 de 4 empujones)' },
  { id: 'g1-stand', label: '300 millones de pasos' },
].filter(({ id }) => URLS[`../../training/policies/${id}.onnx`]);

export const FINAL_LEVEL = 'g1-stand';

export const ROBOT_MODELS = [
  { id: 'unitree_g1', label: 'Unitree G1 (29 motores + manos 5 dedos)' },
  { id: 'luigi_lab3', label: 'Robot Explorador Lab III — Luigi (Arduino UNO + HC-SR04 + APDS-9960)' },
];

// Imitation policies (training/imitate.py): each learned one clip, and does it with physics instead
// of standing still. `clip` (or `clips`) is the PoseClip in the gallery; `motion` is the balanced
// RobotMotion reference the policy was trained on.
export const IMITATIONS = [
  {
    id: 'g1-walk',
    robot: 'unitree_g1',
    clip: 'clip_caminar-perfil-gvhmr',
    clips: ['clip_caminar-perfil-gvhmr', 'clip_caminar-01-gvhmr', 'clip_caminar-02-gvhmr', 'clip_2026-10-23_caminar-perfil_01'],
    motion: 'clip_caminar-perfil-gvhmr-balanced',
    label: 'Caminar imitando el video, con física (65 % de empujones)',
  },
  {
    id: 'g1-run',
    clip: 'clip_correr-perfil-gvhmr',
    clips: ['clip_correr-perfil-gvhmr', 'clip_frente-correr-01-gvhmr', 'clip_2026-10-23_correr-perfil_01'],
    motion: 'clip_correr-perfil-gvhmr-balanced',
    label: 'Correr imitando el video, con física',
  },
  {
    id: 'g1-jacks',
    clip: 'clip_jacks-01-gvhmr',
    clips: ['clip_jacks-01-gvhmr', 'clip_jacks-grupo-01-gvhmr', 'clip_2026-10-24_jumping-jacks-nasm_01'],
    motion: 'clip_jacks-01-gvhmr-balanced',
    label: 'Saltos de tijera imitando el video, con física',
  },
  {
    id: 'g1-saludar',
    clip: 'clip_saludar-02-gvhmr',
    clips: ['clip_saludar-02-gvhmr', 'clip_lavar-04-gvhmr'],
    motion: 'clip_saludar-02-gvhmr-balanced',
    label: 'Gestos imitando el video, con física',
  },
  {
    id: 'g1-dedos',
    clip: 'clip_dedos-01-gvhmr',
    motion: 'clip_dedos-01-gvhmr-balanced',
    label: 'Contar con los dedos imitando el video, con física',
  },
  {
    id: 'g1-bailar',
    clip: 'clip_bailar-01-gvhmr',
    clips: ['clip_bailar-01-gvhmr', 'clip_bailar-grupo-02-gvhmr'],
    motion: 'clip_bailar-01-gvhmr-balanced',
    label: 'Bailar imitando el video, con física',
  },
  {
    id: 'g1-frente',
    clip: 'clip_frente-04-gvhmr',
    motion: 'clip_frente-04-gvhmr-balanced',
    label: 'Caminar hacia la cámara imitando el video, con física',
  },
  {
    id: 'g1-sentarse',
    clip: 'clip_sentarse-02-gvhmr',
    motion: 'clip_sentarse-02-gvhmr-balanced',
    label: 'Sentarse y levantarse imitando el video, con física',
  },
  {
    id: 'luigi-lab3',
    robot: 'luigi_lab3',
    clip: '__luigi__',
    label: 'Robot Lab III (Luigi) · Exploración y evasión con física (5 M pasos, 200 RPM)',
  },
].filter(({ id }) => URLS[`../../training/policies/${id}.onnx`]);

export const imitationOf = (id) => IMITATIONS.find((imitation) => imitation.id === id) ?? null;

export const levelLabel = (id) => (LEVELS.find((level) => level.id === id) ?? imitationOf(id))?.label ?? id;

/** @returns {{ onnx: string, json: string }} URLs for createSimView's loadPolicy */
export function policyUrls(id) {
  return { onnx: URLS[`../../training/policies/${id}.onnx`], json: URLS[`../../training/policies/${id}.json`] };
}
