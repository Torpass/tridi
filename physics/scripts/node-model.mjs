// Loads MuJoCo and the G1 in Node, from the same files and the same WASM build the page uses.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import loadMujoco from '@mujoco/mujoco';
import { Simulation } from '../src/sim.js';

const MODEL_DIR = new URL('../models/unitree_g1/', import.meta.url).pathname;
const H1_DIR = new URL('../models/unitree_h1/', import.meta.url).pathname;
const LUIGI_LAB3_DIR = new URL('../models/luigi_lab3/', import.meta.url).pathname;
const LUIGI_LAB4_DIR = new URL('../models/luigi_lab4/', import.meta.url).pathname;
const FACTORY_CELL_DIR = new URL('../models/factory_cell/', import.meta.url).pathname;
const COMPONENTS_DIR = new URL('../models/components/', import.meta.url).pathname;

function readTree(dir, prefix = '') {
  const files = {};
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    files[`${prefix}${relative(dir, path)}`] = new Uint8Array(readFileSync(path));
  }
  return files;
}

/** @returns { mujoco, sim } the module and a Simulation standing in the "stand" keyframe */
export async function loadG1Node() {
  const mujoco = await loadMujoco();
  const files = {
    ...readTree(MODEL_DIR),
    ...readTree(H1_DIR, 'unitree_h1/'),
    ...readTree(LUIGI_LAB3_DIR, 'luigi_lab3/'),
    ...readTree(LUIGI_LAB4_DIR, 'luigi_lab4/'),
    ...readTree(FACTORY_CELL_DIR, 'factory_cell/'),
    ...readTree(COMPONENTS_DIR, 'components/'),
  };
  return { mujoco, sim: new Simulation(mujoco, files, 'scene.xml', 'stand') };
}
