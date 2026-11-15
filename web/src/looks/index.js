// What each world of physics/worlds looks like in Simulaciones, so the conditions read at a glance:
// flat ground is the landing's sidewalk at dusk, the stones a rocky field, the slippery floor a
// lobby just mopped, and the wind an open meadow. Only looks: the physics of each world is the
// same as before, and nothing drawn here can be touched by the robot. A place (a kitchen, a
// warehouse, a sidewalk; props.js) brings its own floor, so with one the world shows only through
// the wind's currents, which follow the physics' wind in every world.
import * as THREE from 'three';
import { dressCity } from '../landing/city.js';
import { hideViewerFloor } from './common.js';
import { createCurrents, windNow } from './currents.js';
import { dressMeadow } from './meadow.js';
import { dressRocks } from './rocks.js';
import { dressWet } from './wet.js';

/**
 * 3D Factory Plant Map surrounding the Industrial Cell (factory_cell):
 * OSHA safety yellow floor bay markings, bollards, storage racks, S7-1200 MCC cabinet,
 * and pallet staging bays over the open studio floor.
 */
function dressIndustrialPlant(view) {
  const { scene, renderer } = view.viewer;
  const group = new THREE.Group();
  group.name = 'industrial-plant-map';
  const disposables = [];
  const mat = (opts) => {
    const m = new THREE.MeshStandardMaterial(opts);
    disposables.push(m);
    return m;
  };
  const box = (w, h, d, m, x, y, z) => {
    const g = new THREE.BoxGeometry(w, h, d);
    disposables.push(g);
    const mesh = new THREE.Mesh(g, m);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    return mesh;
  };
  const cyl = (rt, rb, h, m, x, y, z) => {
    const g = new THREE.CylinderGeometry(rt, rb, h, 16);
    disposables.push(g);
    const mesh = new THREE.Mesh(g, m);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    group.add(mesh);
    return mesh;
  };

  const mYellow = mat({ color: 0xeab308, roughness: 0.42, metalness: 0.15 });
  const mDarkSteel = mat({ color: 0x161d27, roughness: 0.58, metalness: 0.52 });
  const mCardboard = mat({ color: 0xc58b4e, roughness: 0.78, metalness: 0.05 });
  const mWood = mat({ color: 0x8c6239, roughness: 0.82, metalness: 0.05 });
  const mBlueTote = mat({ color: 0x0284c7, roughness: 0.4, metalness: 0.2 });
  const mCabinet = mat({ color: 0x334155, roughness: 0.45, metalness: 0.5 });
  const mGlow = mat({ color: 0xc8ff2e, emissive: 0xc8ff2e, emissiveIntensity: 0.9, roughness: 0.2 });

  // 1. Inner OSHA safety yellow zone around the active packaging cell
  const stripeY = 0.003;
  box(3.9, 0.004, 0.038, mYellow, 0.1, stripeY, -0.95);
  box(3.9, 0.004, 0.038, mYellow, 0.1, stripeY, 0.95);
  box(0.038, 0.004, 1.94, mYellow, -1.85, stripeY, 0);
  box(0.038, 0.004, 1.94, mYellow, 2.05, stripeY, 0);

  // Inner safety bollards protecting the cell corners
  for (const [bx, bz] of [[-1.78, -0.88], [-1.78, 0.88], [1.98, -0.88], [1.98, 0.88]]) {
    cyl(0.034, 0.038, 0.42, mYellow, bx, 0.21, bz);
    cyl(0.05, 0.05, 0.02, mDarkSteel, bx, 0.01, bz);
  }

  // 2. Background industrial racking (z = +1.48m) with cartons & blue totes
  for (const rx of [-1.05, 1.15]) {
    box(1.25, 1.28, 0.38, mDarkSteel, rx, 0.64, 1.48);
    box(1.22, 0.03, 0.36, mYellow, rx, 0.46, 1.48);
    box(1.22, 0.03, 0.36, mYellow, rx, 0.92, 1.48);
    box(0.3, 0.24, 0.28, mCardboard, rx - 0.34, 0.6, 1.48);
    box(0.3, 0.24, 0.28, mCardboard, rx + 0.04, 0.6, 1.48);
    box(0.28, 0.2, 0.26, mBlueTote, rx + 0.38, 0.58, 1.48);
    box(0.28, 0.2, 0.26, mBlueTote, rx - 0.28, 1.04, 1.48);
    box(0.32, 0.26, 0.28, mCardboard, rx + 0.18, 1.07, 1.48);
  }

  // 3. Left-side MCC / S7-1200 Control Cabinet & Raw Carton Stack (x = -2.18m)
  box(0.42, 1.18, 0.48, mCabinet, -2.18, 0.59, 0.55);
  box(0.02, 0.07, 0.07, mGlow, -1.96, 0.98, 0.55); // Green PLC RUN beacon
  box(0.62, 0.06, 0.52, mWood, -2.18, 0.03, -0.35);
  box(0.26, 0.22, 0.22, mCardboard, -2.28, 0.17, -0.42);
  box(0.26, 0.22, 0.22, mCardboard, -2.04, 0.17, -0.28);
  box(0.26, 0.22, 0.22, mCardboard, -2.16, 0.39, -0.35);

  // 4. Right-side Finished Pallet Staging Bay (x = +2.32m)
  box(0.68, 0.06, 0.56, mWood, 2.32, 0.03, 0.48);
  box(0.28, 0.23, 0.23, mCardboard, 2.2, 0.175, 0.38);
  box(0.28, 0.23, 0.23, mCardboard, 2.44, 0.175, 0.56);
  box(0.28, 0.23, 0.23, mCardboard, 2.32, 0.405, 0.47);

  scene.add(group);
  const prevExposure = renderer.toneMappingExposure;
  renderer.toneMappingExposure = 1.18;

  return {
    update() {},
    undo() {
      renderer.toneMappingExposure = prevExposure;
      scene.remove(group);
      disposables.forEach((d) => d.dispose());
    },
  };
}

/**
 * 3D Sim-to-Real Robotics Test Lab surrounding the 3.4m x 3.4m Rover Arena (luigi_lab3 & luigi_lab4):
 * Calibrated metric perimeter border, 4 corner motion-capture / UWB telemetry beacons, and lab bench.
 */
function dressRoboticsBay(view, robot) {
  const { scene, renderer } = view.viewer;
  const group = new THREE.Group();
  group.name = 'robotics-lab-bay';
  const disposables = [];
  const mat = (opts) => {
    const m = new THREE.MeshStandardMaterial(opts);
    disposables.push(m);
    return m;
  };
  const box = (w, h, d, m, x, y, z) => {
    const g = new THREE.BoxGeometry(w, h, d);
    disposables.push(g);
    const mesh = new THREE.Mesh(g, m);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    return mesh;
  };
  const cyl = (rt, rb, h, m, x, y, z) => {
    const g = new THREE.CylinderGeometry(rt, rb, h, 16);
    disposables.push(g);
    const mesh = new THREE.Mesh(g, m);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    group.add(mesh);
    return mesh;
  };

  const accentHex = robot === 'luigi_lab4' ? 0xfb923c : 0xc8ff2e;
  const mAccent = mat({ color: accentHex, emissive: accentHex, emissiveIntensity: 0.45, roughness: 0.3 });
  const mDark = mat({ color: 0x161920, roughness: 0.55, metalness: 0.6 });
  const mBench = mat({ color: 0x222731, roughness: 0.5, metalness: 0.45 });
  const mScreen = mat({ color: 0x0f172a, emissive: 0x38bdf8, emissiveIntensity: 0.35, roughness: 0.25 });

  // Outer perimeter calibration frame around the 3.4m x 3.4m arena walls (±1.8m)
  const py = 0.003;
  box(3.66, 0.012, 0.045, mAccent, 0, py, -1.81);
  box(3.66, 0.012, 0.045, mAccent, 0, py, 1.81);
  box(0.045, 0.012, 3.66, mAccent, -1.81, py, 0);
  box(0.045, 0.012, 3.66, mAccent, 1.81, py, 0);

  // 4 corner Sim-to-Real motion-capture / optical tracking towers
  const beacons = [];
  for (const [bx, bz] of [[-1.88, -1.88], [-1.88, 1.88], [1.88, -1.88], [1.88, 1.88]]) {
    cyl(0.07, 0.09, 0.04, mDark, bx, 0.02, bz);
    cyl(0.018, 0.022, 0.72, mDark, bx, 0.38, bz);
    box(0.11, 0.08, 0.11, mBench, bx, 0.76, bz);
    const beacon = cyl(0.028, 0.028, 0.04, mAccent, bx, 0.82, bz);
    beacons.push(beacon);
  }

  // Back Sim-to-Real Hardware Calibration Bench (z = 2.28m)
  box(1.5, 0.58, 0.48, mBench, 0, 0.29, 2.28);
  box(0.38, 0.26, 0.04, mScreen, -0.32, 0.72, 2.28); // Telemetry monitor
  box(0.28, 0.16, 0.22, mDark, 0.32, 0.66, 2.28); // Bench power supply

  scene.add(group);
  const prevExposure = renderer.toneMappingExposure;
  renderer.toneMappingExposure = 1.16;
  let t = 0;

  return {
    update(dt) {
      t += dt;
      mAccent.emissiveIntensity = 0.45 + 0.25 * Math.sin(t * 3.5);
    },
    undo() {
      renderer.toneMappingExposure = prevExposure;
      scene.remove(group);
      disposables.forEach((d) => d.dispose());
    },
  };
}

/**
 * The landing's street (city.js), turned so it runs the way the clips walk here: the landing films
 * the walk along +x, Simulaciones along -z (MuJoCo +y). Its shops stand on the robot's right.
 */
function dressSidewalk(view) {
  const robot = view.sim?.policy?.robot;
  if (robot === 'factory_cell') {
    return dressIndustrialPlant(view);
  }
  if (robot === 'luigi_lab3' || robot === 'luigi_lab4') {
    return dressRoboticsBay(view, robot);
  }
  const { scene, renderer } = view.viewer;
  // city.js misses the grid (see hideViewerFloor): hidden first, so undoing in reverse order puts
  // floor and grid back as they were.
  const showGrid = hideViewerFloor(view);
  const undo = dressCity(scene, renderer);
  const city = scene.getObjectByName('landing-city');
  const syncCityRotation = () => {
    if (city) city.rotation.y = view._streetAlongX ? 0 : Math.PI / 2;
  };
  syncCityRotation();
  // The city at dusk is dark: the landing lights it brighter (home.js); here a little less.
  const exposure = renderer.toneMappingExposure;
  renderer.toneMappingExposure = 1.25;
  return {
    update() {
      syncCityRotation();
    },
    undo() {
      renderer.toneMappingExposure = exposure;
      undo();
      showGrid();
    },
  };
}

const LOOKS = { plano: dressSidewalk, piedras: dressRocks, resbaloso: dressWet, viento: dressMeadow };

/**
 * Dresses the viewer for the robot's current world and place.
 * @param options.wind  () => { dir, mps }: the wind the grass and the currents show. By default the
 *   physics' own (windNow); a replay passes the wind each recorded episode had.
 * @returns {{ update(dt: number): void, undo(): void }} update every frame; undo before the next
 */
export function dressWorld(view, { wind = () => windNow(view) } = {}) {
  const worldId = view.world()?.id ?? 'plano';
  const look = view.scene() ? null : LOOKS[worldId]?.(view, wind);
  const currents = createCurrents(view, wind);
  return {
    update(dt) {
      look?.update(dt);
      currents.update(dt);
    },
    undo() {
      currents.dispose();
      look?.undo();
    },
  };
}
