// Models for the places of physics/scenes (kitchen, warehouse, sidewalk). The physics keeps its
// boxes and cylinders; here each one is drawn as a real object instead (a fridge, a shelf, a street
// light), scaled to fill exactly the shape the robot collides with, so what you see is what it hits.
// Models: Kenney's Furniture, Survival and City Roads kits, CC0 (public/models/kenney/*/License.txt).
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { dressFloor, dressStreet } from './landing/street.js';

const BASE = `${import.meta.env.BASE_URL}models/kenney/`;
// The label of a place object (physics/scenes/*.json) -> its model. `tile` repeats the model along
// the object's longest side (a run of kitchen cabinets, a row of shelves) instead of stretching one.
const MODELS = {
  mesada: { file: 'furniture/kitchenCabinet.glb', tile: true },
  cocina: { file: 'furniture/kitchenStove.glb' },
  heladera: { file: 'furniture/kitchenFridgeLarge.glb' },
  mesa: { file: 'furniture/table.glb' },
  silla: { file: 'furniture/chair.glb' },
  tacho: { file: 'furniture/trashcan.glb' },
  estante: { file: 'furniture/bookcaseOpen.glb', tile: true },
  caja: { file: 'furniture/cardboardBoxClosed.glb' },
  barril: { file: 'survival/barrel.glb' },
  banco: { file: 'furniture/bench.glb' },
  poste: { file: 'roads/light-square.glb' },
  maceta: { file: 'furniture/pottedPlant.glb' },
};

// Pieces without a model keep their shape but get a material that matches the street: the curb in
// concrete, the stones' height field in dark asphalt gray (their physics colors are light and wash
// out under the landing's lighting).
const SURFACES = {
  cordon: { color: '#5b5852', roughness: 0.95 },
  stones: { color: '#3a3833', roughness: 1 },
  pared: { color: '#6e6a63', roughness: 0.82, metalness: 0.04 },
  palet: { color: '#8a6236', roughness: 0.85, metalness: 0.02 },
  taza: { color: '#e85d3c', roughness: 0.28, metalness: 0.05 },
  agua: { color: '#38bdf8', roughness: 0.08, metalness: 0.1, transparent: true, opacity: 0.88 },
};

const loader = new GLTFLoader();
const rawGlbCache = new Map();
const cache = new Map();

/** Shared GLTFLoader cache by file path under `/models/kenney/` so props.js and city.js share one loader. */
export function loadKenneyGlb(file) {
  if (!rawGlbCache.has(file)) {
    rawGlbCache.set(
      file,
      loader.loadAsync(BASE + file).catch((err) => {
        rawGlbCache.delete(file);
        throw err;
      }),
    );
  }
  return rawGlbCache.get(file);
}

// Each model once, already turned z-up (Kenney models are y-up; MuJoCo and the viewer's geoms are
// z-up) and centered on its bounding box.
function loadModel(file) {
  if (!cache.has(file)) {
    cache.set(
      file,
      loadKenneyGlb(file).then(({ scene }) => {
        const cloned = scene.clone(true);
        const model = new THREE.Group();
        cloned.rotation.x = Math.PI / 2;
        model.add(cloned);
        model.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(model);
        cloned.position.sub(box.getCenter(new THREE.Vector3()));
        model.userData.size = box.getSize(new THREE.Vector3());
        model.traverse((o) => {
          if (o.isMesh) o.castShadow = o.receiveShadow = true;
        });
        return model;
      }),
    );
  }
  return cache.get(file);
}

const hidden = new THREE.MeshBasicMaterial({ visible: false });

/**
 * Puts models on the place's objects in the view (call after every setScene or setWorld: the
 * viewer rebuilds its geoms then). Objects without a model keep their colored shape.
 * @param options.dim  multiplies the models' colors (the landing's dark street uses less than 1)
 * @returns a promise that settles when every model is on
 */
export async function dressPlace(view, { dim = 1 } = {}) {
  const { sim } = view;
  const { mujoco, model } = sim;
  const jobs = [];
  for (const { id, object } of view.viewer.geoms) {
    const name = mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_GEOM.value, id) ?? '';
    const match = /^place_\d+_(.+)$/.exec(name);
    const surface = SURFACES[match?.[1] ?? name];
    if (surface && !object.userData.dressed) {
      object.userData.dressed = true;
      object.material?.dispose?.();
      object.material = new THREE.MeshStandardMaterial(surface);
      continue;
    }
    const spec = match && MODELS[match[1]];
    if (!spec || object.userData.dressed) continue;
    object.userData.dressed = true;
    // The shape's full size in its own frame (x, y, z up): a box from its half sizes, a cylinder
    // from its radius and half height.
    const [a, b, c] = model.geom_size.slice(3 * id, 3 * id + 3);
    const isCylinder = model.geom_type[id] === mujoco.mjtGeom.mjGEOM_CYLINDER.value;
    const size = isCylinder ? new THREE.Vector3(2 * a, 2 * a, 2 * b) : new THREE.Vector3(2 * a, 2 * b, 2 * c);
    jobs.push(
      loadModel(spec.file).then((template) => {
        const along = size.x >= size.y ? 'x' : 'y';
        const count = spec.tile ? Math.max(1, Math.round(size[along] / Math.min(size.x, size.y))) : 1;
        const piece = size.clone();
        piece[along] /= count;
        for (let k = 0; k < count; k++) {
          const copy = template.clone();
          const s = template.userData.size;
          copy.scale.set(piece.x / s.x, piece.y / s.y, piece.z / s.z);
          copy.position[along] = -size[along] / 2 + piece[along] * (k + 0.5);
          if (dim !== 1) {
            // Darker copies for a dark scene: materials are cloned so other screens keep the originals.
            copy.traverse((o) => {
              if (!o.isMesh) return;
              o.material = o.material.clone();
              o.material.color.multiplyScalar(dim);
              o.material.userData.ownedByClone = true;
            });
          }
          object.add(copy);
        }
        object.material?.dispose?.();
        object.material = hidden; // the collision shape stays, unseen, under the model
      }),
    );
  }
  await Promise.allSettled(jobs);
}

// Floors for the places, drawn in code like the landing's street (no image files).
const PX_PER_M = 128;

let cachedKitchenFloor = null;
let cachedWarehouseFloor = null;

// Kitchen: light 30 cm tiles with dark grout.
function kitchenFloor() {
  if (cachedKitchenFloor) return cachedKitchenFloor;
  const tile = 0.3;
  const canvas = Object.assign(document.createElement('canvas'), { width: 4 * tile * PX_PER_M, height: 4 * tile * PX_PER_M });
  const ctx = canvas.getContext('2d');
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      ctx.fillStyle = (i + j) % 2 ? '#8d8a84' : '#a39f97';
      ctx.fillRect(i * tile * PX_PER_M, j * tile * PX_PER_M, tile * PX_PER_M, tile * PX_PER_M);
    }
  }
  ctx.fillStyle = '#3c3a36';
  for (let k = 0; k <= 4; k++) {
    ctx.fillRect(k * tile * PX_PER_M - 2, 0, 4, canvas.height);
    ctx.fillRect(0, k * tile * PX_PER_M - 2, canvas.width, 4);
  }
  cachedKitchenFloor = { canvas, period: 4 * tile };
  return cachedKitchenFloor;
}

// Warehouse: troweled concrete with a yellow aisle line every 4 m.
function warehouseFloor() {
  if (cachedWarehouseFloor) return cachedWarehouseFloor;
  const period = 4;
  const canvas = Object.assign(document.createElement('canvas'), { width: period * PX_PER_M, height: period * PX_PER_M });
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#4a4946';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  for (let i = 0; i < 9000; i++) {
    ctx.fillStyle = Math.random() < 0.5 ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.1)';
    ctx.fillRect(Math.random() * canvas.width, Math.random() * canvas.height, 2, 2);
  }
  ctx.fillStyle = '#b8932c';
  ctx.fillRect(canvas.width / 2 - 8, 0, 16, canvas.height); // the aisle line, 12 cm wide
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.fillRect(0, 0, canvas.width, 3); // slab joints every 4 m
  ctx.fillRect(0, 0, 3, canvas.height);
  cachedWarehouseFloor = { canvas, period };
  return cachedWarehouseFloor;
}

const FLOORS = {
  // The texture's curb lines up with the place's real one (its "cordon" object), so the robot's
  // sidewalk is on this side of it and the road beyond.
  vereda: (scene, renderer, place) => {
    const curb = place?.objects.find((o) => o.label === 'cordon');
    return dressStreet(scene, renderer, curb ? { curbX: curb.pos[0] - curb.size[0] / 2 } : {});
  },
  cocina: (scene, renderer) => {
    const { canvas, period } = kitchenFloor();
    return dressFloor(scene, renderer, canvas, period);
  },
  deposito: (scene, renderer) => {
    const { canvas, period } = warehouseFloor();
    return dressFloor(scene, renderer, canvas, period);
  },
};

let undoFloor = () => {};
let wantChair = false;
let wantSink = false;

/** The floor of the place `id` (a key of FLOORS), or the viewer's own floor for any other. */
export function setFloor(view, id) {
  undoFloor();
  undoFloor = FLOORS[id]?.(view?.viewer?.scene, view?.viewer?.renderer, view?.scene?.()) ?? (() => {});
}

/**
 * Places a 3D chair (`furniture/chair.glb`) with a full backrest right behind the robot's legs
 * when viewing a sitting clip (`clip_sentarse-02-gvhmr`), so the robot sits on a real chair seat
 * with its backrest behind the torso instead of floating in empty air.
 */
export async function syncSitChair(view, show) {
  wantChair = Boolean(show);
  if (!view?.viewer?.world) return;
  const world = view.viewer.world;
  const existing = world.getObjectByName('tridi-sit-bench');
  if (!wantChair) {
    if (existing) world.remove(existing);
    return;
  }
  if (existing) return;
  try {
    const template = await loadModel('furniture/chair.glb');
    if (!wantChair || !view?.viewer?.world || world.getObjectByName('tridi-sit-bench')) return;
    const copy = template.clone();
    copy.name = 'tridi-sit-bench';
    const s = template.userData.size;
    // In chair.glb (after loadModel's z-up turn), the backrest is at +y and seat height is 0.511 of total z.
    // Rotating +90 deg around Z puts the backrest at -x (behind the robot) and seat at z = 0.43 m.
    copy.scale.set(0.52 / s.x, 0.50 / s.y, 0.84 / s.z);
    copy.rotation.z = Math.PI / 2;
    copy.position.set(-0.25, -0.03, 0.42);
    world.add(copy);
  } catch (err) {
    console.error(err);
  }
}

function disposeOwnedPropChildren(root) {
  root.traverse((o) => {
    if (o.userData.ownedGeometry) o.geometry?.dispose();
    if (o.material?.userData?.ownedByClone) o.material.dispose();
  });
}

/**
 * Places a 3D kitchen sink counter (`furniture/kitchenCabinet.glb` + stainless basin, faucet, and dishes)
 * directly in front of the robot's hands when viewing `clip_lavar-04-gvhmr` ("Washing dishes").
 */
export async function syncWashSink(view, show) {
  wantSink = Boolean(show);
  if (!view?.viewer?.world) return;
  const world = view.viewer.world;
  const existing = world.getObjectByName('tridi-wash-sink');
  if (!wantSink) {
    if (existing) {
      disposeOwnedPropChildren(existing);
      world.remove(existing);
    }
    return;
  }
  if (existing) return;
  try {
    const template = await loadModel('furniture/kitchenCabinet.glb');
    if (!wantSink || !view?.viewer?.world || world.getObjectByName('tridi-wash-sink')) return;
    const group = new THREE.Group();
    group.name = 'tridi-wash-sink';

    // Two tiled kitchen cabinet units forming a 1.05 m wide counter in front of the robot (which faces -y)
    const s = template.userData.size;
    for (const dx of [-0.26, 0.26]) {
      const cab = template.clone();
      cab.scale.set(0.52 / s.x, 0.48 / s.y, 0.84 / s.z);
      cab.position.set(dx, 0, 0.42);
      group.add(cab);
    }

    // Stainless steel sink rim & soapy water basin on top of the counter (z = 0.84..0.88 m)
    const steelMat = new THREE.MeshStandardMaterial({ color: 0xcbd5e1, metalness: 0.65, roughness: 0.25 });
    steelMat.userData.ownedByClone = true;
    const basinRim = new THREE.Mesh(new THREE.BoxGeometry(0.48, 0.36, 0.03), steelMat);
    basinRim.userData.ownedGeometry = true;
    basinRim.position.set(0, 0.02, 0.855);
    const waterMat = new THREE.MeshStandardMaterial({ color: 0x7dd3fc, roughness: 0.12, metalness: 0.05, transparent: true, opacity: 0.85 });
    waterMat.userData.ownedByClone = true;
    const water = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.30, 0.02), waterMat);
    water.userData.ownedGeometry = true;
    water.position.set(0, 0.02, 0.865);

    // Gooseneck faucet at the back of the sink
    const faucetPost = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.016, 0.22, 12), steelMat);
    faucetPost.userData.ownedGeometry = true;
    faucetPost.rotation.x = Math.PI / 2;
    faucetPost.position.set(0, -0.14, 0.96);
    const faucetSpout = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.14, 12), steelMat);
    faucetSpout.userData.ownedGeometry = true;
    faucetSpout.position.set(0, -0.08, 1.05);

    // Ceramic plates and mug in the scrubbing zone right under the robot's hands
    const plateMat = new THREE.MeshStandardMaterial({ color: 0xf8fafc, roughness: 0.2 });
    plateMat.userData.ownedByClone = true;
    const plate1 = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.08, 0.022, 20), plateMat);
    plate1.userData.ownedGeometry = true;
    plate1.rotation.x = Math.PI / 2 - 0.35;
    plate1.position.set(-0.02, 0.08, 0.92);
    const plate2 = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.08, 0.022, 20), plateMat);
    plate2.userData.ownedGeometry = true;
    plate2.rotation.x = Math.PI / 2;
    plate2.position.set(0.32, 0.02, 0.86);
    const mugMat = new THREE.MeshStandardMaterial({ color: 0xe85d3c, roughness: 0.28 });
    mugMat.userData.ownedByClone = true;
    const mug = new THREE.Mesh(new THREE.CylinderGeometry(0.042, 0.04, 0.095, 16), mugMat);
    mug.userData.ownedGeometry = true;
    mug.rotation.x = Math.PI / 2;
    mug.position.set(-0.34, 0.04, 0.89);

    group.add(basinRim, water, faucetPost, faucetSpout, plate1, plate2, mug);
    // Robot stands at (0, 0) facing -y with hands at (-0.05, -0.23, 0.96)
    group.position.set(-0.05, -0.42, 0);
    world.add(group);
  } catch (err) {
    console.error(err);
  }
}

/** Removes any clip-specific 3D props (chair, sink) and custom floor when leaving #/simulations. */
export function clearStageProps(view) {
  wantChair = false;
  wantSink = false;
  if (!view) return;
  syncSitChair(view, false);
  syncWashSink(view, false);
  setFloor(view, null);
}
