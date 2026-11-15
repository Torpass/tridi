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
const LUIGI_LAB4_FILES = import.meta.glob('../models/luigi_lab4/**/*.{xml,STL,stl}', {
  query: '?url',
  import: 'default',
  eager: true,
});
const FACTORY_CELL_FILES = import.meta.glob('../models/factory_cell/**/*.{xml,STL,stl}', {
  query: '?url',
  import: 'default',
  eager: true,
});
const COMPONENT_FILES = import.meta.glob('../models/components/**/*.xml', {
  query: '?url',
  import: 'default',
  eager: true,
});

const MODEL_BUNDLES = {
  'unitree_h1/': H1_FILES,
  'luigi_lab3/': LUIGI_FILES,
  'luigi_lab4/': LUIGI_LAB4_FILES,
  'factory_cell/': FACTORY_CELL_FILES,
};

// Shared URL -> Promise<Uint8Array> cache across startup and on-demand robot loads so byte-identical
// STL meshes (such as the 4 shared STLs between luigi_lab3 and luigi_lab4) are fetched only once.
const urlBytesCache = new Map();

function fetchModelBytes(key, url) {
  if (!urlBytesCache.has(url)) {
    urlBytesCache.set(
      url,
      fetch(url)
        .then(async (response) => {
          if (!response.ok) throw new Error(`${key}: HTTP ${response.status}`);
          return new Uint8Array(await response.arrayBuffer());
        })
        .catch((err) => {
          urlBytesCache.delete(url);
          throw err;
        }),
    );
  }
  return urlBytesCache.get(url);
}

/**
 * Lazily fetches and populates `files` for non-default robots (`unitree_h1/`, `luigi_lab3/`,
 * `luigi_lab4/`, `factory_cell/`) only when a policy or scene for that prefix is requested.
 */
export async function ensureModelFiles(files, sceneFile = '') {
  const prefix = Object.keys(MODEL_BUNDLES).find((p) => sceneFile.startsWith(p));
  if (!prefix) return;
  const entries = Object.entries(MODEL_BUNDLES[prefix])
    .map(([path, url]) => [path.slice(H1_ROOT.length), url])
    .filter(([key]) => !files[key]);
  if (!entries.length) return;
  await Promise.all(
    entries.map(async ([key, url]) => {
      files[key] = await fetchModelBytes(key, url);
    }),
  );
}

/**
 * @param onProgress called with { done, total, bytes } as each file arrives
 *   (the WASM build counts as one file).
 */
export async function loadG1(onProgress = () => {}) {
  // First Paint of `#/` needs only the default Unitree G1 model + shared component XMLs.
  // Non-G1 robots (`unitree_h1/`, `luigi_lab3/`, `luigi_lab4/`, `factory_cell/`) are fetched
  // on demand via `ensureModelFiles()` when selected.
  const entries = [
    ...Object.entries(G1_FILES).map(([path, url]) => [path.slice(G1_ROOT.length), url]),
    ...Object.entries(COMPONENT_FILES).map(([path, url]) => [path.slice(H1_ROOT.length), url]),
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
      const bytes = await fetchModelBytes(key, url);
      files[key] = bytes;
      advance(bytes.byteLength);
    }),
  );
  return new Simulation(await mujocoReady, files, 'scene.xml', 'stand');
}
