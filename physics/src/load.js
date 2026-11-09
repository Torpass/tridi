// Browser loader: fetches the MuJoCo WASM build and every file of the G1 model,
// reporting progress, and returns a ready Simulation standing in its "stand" keyframe.
import loadMujoco from '@mujoco/mujoco';
import wasmUrl from '@mujoco/mujoco/mujoco.wasm?url';
import { Simulation } from './sim.js';

// URLs of the G1 and H1 MJCF and meshes. Vite serves them in dev and copies them on build.
const G1_ROOT = '../models/unitree_g1/';
const G1_FILES = import.meta.glob('../models/unitree_g1/**/*.{xml,STL,stl}', {
  query: '?url',
  import: 'default',
  eager: true,
});
const H1_ROOT = '../models/';
const H1_FILES = import.meta.glob('../models/unitree_h1/**/*.{xml,STL,stl}', {
  query: '?url',
  import: 'default',
  eager: true,
});
const LUIGI_FILES = import.meta.glob('../models/luigi_lab3/**/*.{xml,STL,stl}', {
  query: '?url',
  import: 'default',
  eager: true,
});

/**
 * @param onProgress called with { done, total, bytes } as each file arrives
 *   (the WASM build counts as one file).
 */
export async function loadG1(onProgress = () => {}) {
  const entries = [
    ...Object.entries(G1_FILES).map(([path, url]) => [path.slice(G1_ROOT.length), url]),
    ...Object.entries(H1_FILES).map(([path, url]) => [path.slice(H1_ROOT.length), url]),
    ...Object.entries(LUIGI_FILES).map(([path, url]) => [path.slice(H1_ROOT.length), url]),
  ];
  const progress = { done: 0, total: entries.length + 1, bytes: 0 };
  const advance = (bytes = 0) => {
    progress.done++;
    progress.bytes += bytes;
    onProgress({ ...progress });
  };
  onProgress({ ...progress });

  const mujocoReady = loadMujoco({ locateFile: () => wasmUrl }).then((mujoco) => {
    advance();
    return mujoco;
  });
  const files = {};
  await Promise.all(
    entries.map(async ([key, url]) => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`${key}: HTTP ${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      files[key] = bytes;
      advance(bytes.byteLength);
    }),
  );
  return new Simulation(await mujocoReady, files, 'scene.xml', 'stand');
}
