// Dev-only: render a run of each fence style (spec 056) to a PNG so a human --
// or an agent with no screen -- can check that a painted fence actually reads as
// a fence. Not part of the app. `tsx scripts/preview-fence.ts`
//
// It lays the run with the **real `fenceStroke`** and draws the **real
// `buildPropField`**, so what is rasterised here is exactly what the editor
// builds: if the tiles do not butt up, or a tile comes out mirrored, or the
// posts march down the wrong side, it is visible in this image.
//
// Three views per style: a straight run, a run turning a corner, and a run over
// a rise (the case where a tile standing upright on ground sampled at its centre
// could show daylight underneath).
import { mkdirSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import * as THREE from 'three';
import { Rng } from '../src/shared/prng.js';
import { buildPropField } from '../src/render/iso3d/props.js';
import {
  fenceStroke,
  NO_FENCE_PATH,
  type FencePath,
  type FenceSettings,
  type FenceStyle,
} from '../src/render/iso3d/editor/fence.js';
import {
  createLayer,
  createWorld,
  exportMap,
  loadMap,
  type LoadedMap,
  type Prop,
} from '../src/terrain/index.js';

const SIZE = Number(process.env.SIZE ?? 300);
const GAP = 8;
const BG: readonly [number, number, number] = [58, 60, 68];

/** Roughly the game's isometric bearing, and a light near where its sun is. */
const VIEW_DIR = new THREE.Vector3(-1, -0.6, -1).normalize();
const LIGHT = new THREE.Vector3(0.45, 0.8, 0.38).normalize();
const AMBIENT = 0.55;

const BOUNDS = { minX: -400, minZ: -400, maxX: 400, maxZ: 400 };
const LAYER = 'ground';

/** A world with a rise in the middle of it, so a run can be dragged over one. */
function world(amplitude: number): LoadedMap {
  return loadMap(
    exportMap({
      world: createWorld([
        createLayer({
          id: LAYER,
          bounds: BOUNDS,
          baseY: -100,
          waterLevel: null,
          seed: 11,
          features: [{ kind: 'rolling', amplitude }],
        }),
      ]),
      props: [],
      seed: 11,
      arena: { minX: -200, minZ: -200, maxX: 200, maxZ: 200 },
      options: { cellSize: 20, chunkCells: 8 },
    }),
  );
}

/** Drag through `corners`, sampled finely, exactly as the frame loop would. */
function run(map: LoadedMap, style: FenceStyle, corners: readonly (readonly [number, number])[]): Prop[] {
  const settings: FenceSettings = { style, fenceScale: 1 };
  let rng = Rng.fromSeed(4242);
  let path: FencePath = NO_FENCE_PATH;
  const added: Prop[] = [];
  for (let leg = 1; leg < corners.length; leg++) {
    const from = corners[leg - 1] as readonly [number, number];
    const to = corners[leg] as readonly [number, number];
    const steps = 40;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const out = fenceStroke(
        map.store,
        LAYER,
        settings,
        { x: from[0] + (to[0] - from[0]) * t, z: from[1] + (to[1] - from[1]) * t },
        path,
        rng,
      );
      path = out.path;
      rng = out.rng;
      added.push(...out.added);
    }
  }
  return added;
}

interface Tri {
  readonly a: THREE.Vector3;
  readonly b: THREE.Vector3;
  readonly c: THREE.Vector3;
  readonly color: THREE.Color;
}

/**
 * Every triangle under `root` in world space, expanding instanced meshes into
 * one copy of their geometry per instance -- which for a prop field is all of
 * them, and is also where the per-instance colour lives.
 */
function collectTriangles(root: THREE.Object3D): Tri[] {
  const tris: Tri[] = [];
  root.updateMatrixWorld(true);
  const matrix = new THREE.Matrix4();
  const point = new THREE.Vector3();
  root.traverse((node) => {
    const mesh = node as THREE.InstancedMesh;
    if (!mesh.isMesh) return;
    const pos = mesh.geometry.getAttribute('position');
    const index = mesh.geometry.getIndex();
    const count = index ? index.count : pos.count;
    const instances = mesh.isInstancedMesh ? mesh.count : 1;
    for (let n = 0; n < instances; n++) {
      if (mesh.isInstancedMesh) mesh.getMatrixAt(n, matrix);
      else matrix.identity();
      matrix.premultiply(mesh.matrixWorld);
      const color = new THREE.Color();
      if (mesh.isInstancedMesh && mesh.instanceColor) mesh.getColorAt(n, color);
      else color.copy((mesh.material as THREE.MeshLambertMaterial).color);
      for (let i = 0; i < count; i += 3) {
        const corners = [0, 1, 2].map((k) => {
          const vi = index ? index.getX(i + k) : i + k;
          return point.set(pos.getX(vi), pos.getY(vi), pos.getZ(vi)).applyMatrix4(matrix).clone();
        });
        tris.push({
          a: corners[0] as THREE.Vector3,
          b: corners[1] as THREE.Vector3,
          c: corners[2] as THREE.Vector3,
          color: color.clone(),
        });
      }
    }
  });
  return tris;
}

/** Linear-sRGB to sRGB, the transfer WebGL applies on the way to the screen. */
function encode(linear: number): number {
  const c = linear <= 0 ? 0 : linear >= 1 ? 1 : linear;
  return 255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
}

/** Orthographic, z-buffered, flat-shaded -- the same three properties the game has. */
function render(tris: readonly Tri[], size: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    out[i * 4] = BG[0] as number;
    out[i * 4 + 1] = BG[1] as number;
    out[i * 4 + 2] = BG[2] as number;
    out[i * 4 + 3] = 255;
  }
  if (tris.length === 0) return out;

  const forward = VIEW_DIR;
  const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();
  const up = new THREE.Vector3().crossVectors(right, forward).normalize();
  const project = (p: THREE.Vector3): [number, number, number] => [p.dot(right), p.dot(up), p.dot(forward)];

  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
  for (const tri of tris) {
    for (const corner of [tri.a, tri.b, tri.c]) {
      const [u, v] = project(corner);
      minU = Math.min(minU, u);
      maxU = Math.max(maxU, u);
      minV = Math.min(minV, v);
      maxV = Math.max(maxV, v);
    }
  }
  const span = Math.max(maxU - minU, maxV - minV) * 1.06;
  const scale = size / span;
  const cu = (minU + maxU) / 2;
  const cv = (minV + maxV) / 2;
  const toPixel = (p: THREE.Vector3): [number, number, number] => {
    const [u, v, d] = project(p);
    return [size / 2 + (u - cu) * scale, size / 2 - (v - cv) * scale, d];
  };

  const depth = new Float64Array(size * size).fill(Infinity);
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  const normal = new THREE.Vector3();
  for (const tri of tris) {
    const [ax, ay, az] = toPixel(tri.a);
    const [bx, by, bz] = toPixel(tri.b);
    const [cx, cy, cz] = toPixel(tri.c);
    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (area === 0) return out;

    normal.crossVectors(ab.subVectors(tri.b, tri.a), ac.subVectors(tri.c, tri.a)).normalize();
    const lambert = Math.max(0, normal.dot(LIGHT));
    const shade = AMBIENT + (1 - AMBIENT) * lambert;

    const loX = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
    const hiX = Math.min(size - 1, Math.ceil(Math.max(ax, bx, cx)));
    const loY = Math.max(0, Math.floor(Math.min(ay, by, cy)));
    const hiY = Math.min(size - 1, Math.ceil(Math.max(ay, by, cy)));
    for (let y = loY; y <= hiY; y++) {
      for (let x = loX; x <= hiX; x++) {
        const px = x + 0.5;
        const py = y + 0.5;
        const w0 = ((bx - ax) * (py - ay) - (by - ay) * (px - ax)) / area;
        const w1 = ((px - ax) * (cy - ay) - (py - ay) * (cx - ax)) / area;
        if (w0 < 0 || w1 < 0 || w0 + w1 > 1) continue;
        const d = az + w1 * (bz - az) + w0 * (cz - az);
        const at = y * size + x;
        if (d >= (depth[at] as number)) continue;
        depth[at] = d;
        out[at * 4] = encode(tri.color.r * shade);
        out[at * 4 + 1] = encode(tri.color.g * shade);
        out[at * 4 + 2] = encode(tri.color.b * shade);
      }
    }
  }
  return out;
}

interface Shot {
  readonly style: FenceStyle;
  readonly corners: readonly (readonly [number, number])[];
  readonly amplitude: number;
}

const SHOTS: readonly Shot[] = [
  { style: 'wood', corners: [[-220, 0], [220, 0]], amplitude: 0 },
  { style: 'wood', corners: [[-200, -120], [120, -120], [120, 200]], amplitude: 0 },
  { style: 'wood', corners: [[-220, 0], [220, 0]], amplitude: 34 },
  { style: 'stone', corners: [[-220, 0], [220, 0]], amplitude: 0 },
  { style: 'stone', corners: [[-200, -120], [120, -120], [120, 200]], amplitude: 0 },
  { style: 'stone', corners: [[-220, 0], [220, 0]], amplitude: 34 },
];

const cols = 3;
const rows = Math.ceil(SHOTS.length / cols);
const sheet = new PNG({ width: cols * (SIZE + GAP), height: rows * (SIZE + GAP), colorType: 6 });
for (let i = 0; i < sheet.data.length; i += 4) {
  sheet.data[i] = 30;
  sheet.data[i + 1] = 31;
  sheet.data[i + 2] = 36;
  sheet.data[i + 3] = 255;
}

SHOTS.forEach((shot, i) => {
  const map = world(shot.amplitude);
  const props = run(map, shot.style, shot.corners);
  const field = buildPropField(props, (x, z) => map.world.heightAt(x, z));
  const pixels = render(collectTriangles(field.group), SIZE);
  field.dispose();
  const gx = (i % cols) * (SIZE + GAP);
  const gy = Math.floor(i / cols) * (SIZE + GAP);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const from = (y * SIZE + x) * 4;
      const to = ((gy + y) * sheet.width + gx + x) * 4;
      sheet.data[to] = pixels[from] as number;
      sheet.data[to + 1] = pixels[from + 1] as number;
      sheet.data[to + 2] = pixels[from + 2] as number;
      sheet.data[to + 3] = 255;
    }
  }
  process.stdout.write(`${shot.style} ${shot.corners.length - 1} leg(s), rise ${shot.amplitude}: ${props.length} tiles\n`);
});

mkdirSync('.claude/screenshots', { recursive: true });
const path = '.claude/screenshots/fences.png';
writeFileSync(path, PNG.sync.write(sheet));
process.stdout.write(`wrote ${path}\n`);
