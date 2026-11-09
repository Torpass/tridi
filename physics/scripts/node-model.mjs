// Loads MuJoCo and the G1 in Node, from the same files and the same WASM build the page uses.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import loadMujoco from '@mujoco/mujoco';
import { Simulation } from '../src/sim.js';

const MODEL_DIR = new URL('../models/unitree_g1/', import.meta.url).pathname;
const H1_DIR = new URL('../models/unitree_h1/', import.meta.url).pathname;

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
  const files = { ...readTree(MODEL_DIR), ...readTree(H1_DIR, 'unitree_h1/') };
  return { mujoco, sim: new Simulation(mujoco, files, 'scene.xml', 'stand') };
}
