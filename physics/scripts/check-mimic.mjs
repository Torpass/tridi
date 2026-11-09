// Headless check of an imitation policy, in Node with the same MuJoCo WASM and policy runtime the
// page uses (onnx-lite.js). training/browser_fixture.py recorded, for the first decisions of the clip, the robot's
// state, the observation Python built and the targets the network answered. Here the browser code
// (src/reference.js and src/policy.js) is put in each of those states and must build the same
// observation and get the same targets. If the observation differed, the robot would fall in the
// browser even though everything "runs".
// Run: npm run check
import { existsSync, readFileSync } from 'node:fs';
import * as ort from '../src/onnx-lite.js'; // the page's runtime (check-onnx compares it with onnxruntime)
import { createPolicy } from '../src/policy.js';
import { loadG1Node } from './node-model.mjs';

const POLICIES = new URL('../../training/policies/', import.meta.url);
const MOTIONS = new URL('../motions/', import.meta.url);
const REFERENCES = new URL('../../training/references/', import.meta.url);
const POLICY = 'g1-walk';
// The network reads float32, which keeps ~7 digits: inputs equal to 1e-4 are the same input. The
// fixture's states are rounded to 1e-9, so anything above that is a difference in how they are built.
const OBS_TOLERANCE = 1e-4;
// Targets in radians: 1e-3 rad is 0.06 degrees, far below what a motor of the G1 resolves.
const CTRL_TOLERANCE = 1e-3;
// A fall or a pelvis 0.6 m from the reference ends the run (training/imitate.py).
const FALL_HEIGHT = 0.5;
const MAX_ROOT_ERROR_M = 0.6;

const read = (url) => JSON.parse(readFileSync(url));
const meta = read(new URL(`${POLICY}.json`, POLICIES));
const fixture = read(new URL(`${POLICY}.fixture.json`, POLICIES));
const inMotions = new URL(`${meta.motion}.json`, MOTIONS);
const motion = read(existsSync(inMotions) ? inMotions : new URL(`${meta.motion}.json`, REFERENCES));

const { sim } = await loadG1Node();
sim.load('scene_mjx.xml', 'home'); // the scene the policy was trained on
const policy = await createPolicy(ort, sim, new Uint8Array(readFileSync(new URL(`${POLICY}.onnx`, POLICIES))), meta, { motion });
sim.policy = policy;
const failures = [];
const expect = (ok, what) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures.push(what);
};
const maxDiff = (a, b) => a.reduce((m, v, i) => Math.max(m, Math.abs(v - b[i])), 0);

console.log(`the imitation policy (${POLICY}, ${meta.obs_dim} inputs, clip ${meta.motion})`);
let worstObs = 0;
let worstCtrl = 0;
let worstAt = 0;
const dt = sim.model.opt.timestep;
for (const s of fixture.samples) {
  sim.data.qpos.set(s.qpos);
  sim.data.qvel.set(s.qvel);
  policy.setPrevious(s.previous);
  sim.steps = Math.round(s.t / dt); // the policy's clock: one decision every 5 steps of 4 ms
  const obs = Array.from(policy.observe(sim.data, sim.steps * dt));
  const diff = maxDiff(obs, s.obs);
  if (diff > worstObs) [worstObs, worstAt] = [diff, obs.findIndex((v, i) => Math.abs(v - s.obs[i]) === diff)];
  await policy.act(sim);
  worstCtrl = Math.max(worstCtrl, maxDiff(Array.from(sim.data.ctrl), s.ctrl));
}
expect(worstObs < OBS_TOLERANCE, `same observation as Python in ${fixture.samples.length} states (worst ${worstObs.toExponential(1)}, at input ${worstAt})`);
expect(worstCtrl < CTRL_TOLERANCE, `same motor targets as Python (worst ${worstCtrl.toExponential(1)} rad)`);

// The policy driving the robot from the clip's first pose, as the page does.
for (const id of ['g1-walk', 'g1-run', 'g1-jacks', 'g1-saludar', 'g1-dedos', 'g1-bailar', 'g1-frente', 'g1-sentarse', 'h1-walk']) {
  if (!existsSync(new URL(`${id}.onnx`, POLICIES))) continue;
  const m = read(new URL(`${id}.json`, POLICIES));
  const sceneFile = m.robot === 'unitree_h1' ? 'unitree_h1/scene.xml' : 'scene_mjx.xml';
  if (sim.loadedScene !== sceneFile) sim.load(sceneFile, 'home');
  const inM = new URL(`${m.motion}.json`, MOTIONS);
  const mot = read(existsSync(inM) ? inM : new URL(`${m.motion}.json`, REFERENCES));
  const p = await createPolicy(ort, sim, new Uint8Array(readFileSync(new URL(`${id}.onnx`, POLICIES))), m, { motion: mot });
  sim.policy = p;
  sim.reset();
  let followed = 0;
  for (let t = 0; t < p.duration; t += 0.02) {
    await sim.advance(0.02);
    const pelvis = sim.bodyPosition('pelvis');
    const reference = mot.qpos[Math.min(Math.round(p.time(sim) * mot.fps), mot.qpos.length - 1)];
    const fallHeight = Math.min(FALL_HEIGHT, reference[2] - 0.12);
    if (pelvis[2] < fallHeight || Math.hypot(pelvis[0] - reference[0], pelvis[1] - reference[1]) > MAX_ROOT_ERROR_M) break;
    followed = Math.max(followed, p.time(sim));
  }
  expect(followed >= p.duration - 0.1, `${id} follows the clip ${followed.toFixed(1)} s of ${p.duration.toFixed(1)} from its first pose`);
  p.dispose();
}

policy.dispose();
sim.delete();
if (failures.length) {
  console.error(`\ncheck-mimic failed: ${failures.length} of the checks above`);
  process.exit(1);
}
console.log('\ncheck-mimic passed');
