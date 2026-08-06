// Dev-only: photograph the world's tree species (spec 045, spec 076) so a human --
// or an agent with no screen -- can see whether a silhouette actually reads.
// Not part of the app. `npx tsx scripts/preview-trees.ts`
//
// It draws the **real `buildPropField`**, so what is rasterised is exactly the
// geometry the game builds: the same instanced batches, the same per-instance
// colours, the same variant hashed from where the tree stands. The only thing
// faked is the rasteriser, which is here because there is no GPU in a container.
//
// Two rows. The top is every species at every slab/tier count it can grow, from
// the game's own isometric bearing. The bottom is the lobed tree alone, from
// four bearings a turning camera would pass through and from straight above --
// the check that its canopy is real geometry rather than something facing the
// viewer, which is the one claim a single frame cannot make.
import { mkdirSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import * as THREE from 'three';
import {
  buildPropField,
  speciesHeight,
  speciesTierCounts,
  treeVariant,
  TREE_SPECIES,
  type TreeSpecies,
} from '../src/render/iso3d/props.js';
import type { Prop } from '../src/terrain/vegetation.js';

const SIZE = Number(process.env['SIZE'] ?? 260);
const GAP = 8;
const BG: readonly [number, number, number] = [58, 60, 68];

/** Roughly the game's isometric bearing, and a light near where its sun is. */
const VIEW_DIR = new THREE.Vector3(-1, -0.6, -1).normalize();
const LIGHT = new THREE.Vector3(0.45, 0.8, 0.38).normalize();
const AMBIENT = 0.55;

/**
 * A prop whose hashed variant is the species and count asked for.
 *
 * `treeVariant` is a hash of position, so a shape is *found* rather than asked
 * for -- which is the point: what gets drawn here is a tree the world could
 * actually grow, not one assembled by hand for the photograph.
 */
function find(species: TreeSpecies, tierCount: number): Prop | null {
  for (let i = 0; i < 40000; i++) {
    const prop: Prop = { kind: 'tree', x: i * 37, y: i * 53, scale: 1, rotation: 0, tint: 0 };
    const variant = treeVariant(prop);
    if (variant.species === species && variant.tierCount === tierCount) return prop;
  }
  return null;
}

interface Tri {
  readonly a: THREE.Vector3;
  readonly b: THREE.Vector3;
  readonly c: THREE.Vector3;
  readonly color: THREE.Color;
}

/** Every triangle of a built field in world space, one copy per instance. */
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
function render(tris: readonly Tri[], size: number, forward: THREE.Vector3, fit: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    out[i * 4] = BG[0] as number;
    out[i * 4 + 1] = BG[1] as number;
    out[i * 4 + 2] = BG[2] as number;
    out[i * 4 + 3] = 255;
  }
  if (tris.length === 0) return out;

  const worldUp = Math.abs(forward.y) > 0.99 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0);
  const right = new THREE.Vector3().crossVectors(forward, worldUp).normalize();
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
  // A fixed span rather than one fitted per panel, so two species photographed
  // side by side are actually the same scale and can be compared.
  const scale = size / fit;
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
    if (area === 0) continue;

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

/** One tree, drawn from one bearing. */
function panel(prop: Prop, forward: THREE.Vector3, fit: number): Uint8ClampedArray {
  const field = buildPropField([prop], () => 0);
  const tris = collectTriangles(field.group);
  const pixels = render(tris, SIZE, forward, fit);
  field.dispose();
  return pixels;
}

const cells: { row: number; column: number; pixels: Uint8ClampedArray; label: string }[] = [];

// Row 0: every shape the world can grow, at one scale, from the game's bearing.
const shapes: { species: TreeSpecies; count: number }[] = [];
for (const species of TREE_SPECIES) {
  for (const count of [...new Set(speciesTierCounts(species))].sort((a, b) => a - b)) {
    shapes.push({ species, count });
  }
}
const FIT = Math.max(...TREE_SPECIES.map(speciesHeight)) * 1.12;
shapes.forEach((shape, column) => {
  const prop = find(shape.species, shape.count);
  if (!prop) {
    console.warn(`no ${shape.species} with ${shape.count} tiers found -- skipped`);
    return;
  }
  cells.push({
    row: 0,
    column,
    pixels: panel(prop, VIEW_DIR, FIT),
    label: `${shape.species} x${shape.count}`,
  });
});

// Row 1: the lobed tree turned under a camera that is turning. Real geometry
// keeps its orientation; a billboard would look identical in all five.
const lobed = find('lobed', 5);
if (lobed) {
  const bearings: { label: string; dir: THREE.Vector3 }[] = [0, 90, 180, 270].map((deg) => {
    const a = (deg * Math.PI) / 180;
    return { label: `lobed ${deg}deg`, dir: new THREE.Vector3(-Math.cos(a), -0.6, -Math.sin(a)).normalize() };
  });
  bearings.push({ label: 'lobed, from above', dir: new THREE.Vector3(0, -1, 0) });
  bearings.forEach((bearing, column) => {
    cells.push({ row: 1, column, pixels: panel(lobed, bearing.dir, FIT), label: bearing.label });
  });
}

const columns = Math.max(...cells.map((c) => c.column)) + 1;
const rows = Math.max(...cells.map((c) => c.row)) + 1;
const width = columns * SIZE + (columns + 1) * GAP;
const height = rows * SIZE + (rows + 1) * GAP;
const sheet = new PNG({ width, height });
for (let i = 0; i < width * height; i++) {
  sheet.data[i * 4] = 30;
  sheet.data[i * 4 + 1] = 31;
  sheet.data[i * 4 + 2] = 36;
  sheet.data[i * 4 + 3] = 255;
}
for (const cell of cells) {
  const x0 = GAP + cell.column * (SIZE + GAP);
  const y0 = GAP + cell.row * (SIZE + GAP);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const from = (y * SIZE + x) * 4;
      const to = ((y0 + y) * width + x0 + x) * 4;
      sheet.data[to] = cell.pixels[from] as number;
      sheet.data[to + 1] = cell.pixels[from + 1] as number;
      sheet.data[to + 2] = cell.pixels[from + 2] as number;
      sheet.data[to + 3] = 255;
    }
  }
}

mkdirSync('.claude/screenshots', { recursive: true });
writeFileSync('.claude/screenshots/trees.png', PNG.sync.write(sheet));
console.log(`.claude/screenshots/trees.png  ${width}x${height}`);
console.log(cells.map((c) => `  (${c.row},${c.column}) ${c.label}`).join('\n'));
