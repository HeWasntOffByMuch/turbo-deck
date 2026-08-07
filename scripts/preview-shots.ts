// Dev-only: photograph the projectiles in flight (spec 081) so a human -- or an
// agent with no screen -- can see whether an arrow reads as an arrow at the size
// it crosses the frame at. Not part of the app. `npx tsx scripts/preview-shots.ts`
//
// It builds the **real `ShotRig`** and drives its real `update()` along a real
// flight: the arc is `arcHeightAt`, the same parabola the server flies, sampled
// at 60Hz. So the pitch in these frames is the pitch the rig computes, not a
// pose set by hand for the photograph. The only thing faked is the rasteriser,
// which is here because there is no GPU in a container.
//
// Three rows: every look side by side, the arrow through its arc, and the
// shuriken through a turn.
import { mkdirSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import * as THREE from 'three';
import { abilityById, type ProjectileLook } from '../src/server/data/abilities.js';
import { arcHeightAt } from '../src/server/sim/abilities.js';
import { ShotRig } from '../src/render/iso3d/world/shot.js';

const SIZE = Number(process.env['SIZE'] ?? 240);
const GAP = 8;
const BG: readonly [number, number, number] = [58, 60, 68];
const STEP = 1 / 60;

/** Roughly the game's isometric bearing, and a light near where its sun is. */
const VIEW_DIR = new THREE.Vector3(-1, -0.6, -1).normalize();
const LIGHT = new THREE.Vector3(0.45, 0.8, 0.38).normalize();
const AMBIENT = 0.55;

interface Tri {
  readonly a: THREE.Vector3;
  readonly b: THREE.Vector3;
  readonly c: THREE.Vector3;
  readonly color: THREE.Color;
}

function collectTriangles(root: THREE.Object3D): Tri[] {
  const tris: Tri[] = [];
  root.updateMatrixWorld(true);
  const point = new THREE.Vector3();
  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;
    const pos = mesh.geometry.getAttribute('position');
    const index = mesh.geometry.getIndex();
    const count = index ? index.count : pos.count;
    const color = new THREE.Color().copy((mesh.material as THREE.MeshBasicMaterial).color);
    for (let i = 0; i < count; i += 3) {
      const corners = [0, 1, 2].map((k) => {
        const vi = index ? index.getX(i + k) : i + k;
        return point.set(pos.getX(vi), pos.getY(vi), pos.getZ(vi)).applyMatrix4(mesh.matrixWorld).clone();
      });
      tris.push({
        a: corners[0] as THREE.Vector3,
        b: corners[1] as THREE.Vector3,
        c: corners[2] as THREE.Vector3,
        color: color.clone(),
      });
    }
  });
  return tris;
}

/** Linear-sRGB to sRGB, the transfer WebGL applies on the way to the screen. */
function encode(linear: number): number {
  const c = linear <= 0 ? 0 : linear >= 1 ? 1 : linear;
  return 255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
}

/** Orthographic, z-buffered, flat-shaded. */
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
  // A fixed span rather than one fitted per panel, so two shots photographed
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
    const lambert = Math.abs(normal.dot(LIGHT));
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

/**
 * One shot, flown to `progress` along a real arc, then photographed.
 *
 * The whole flight is stepped rather than jumped to, because both things the
 * rig owns -- the arrow's chased pitch and the shuriken's spin -- are integrated
 * over frames. Jumping to the sample would photograph neither of them.
 */
function flown(abilityId: string, progress: number): { rig: ShotRig; tris: Tri[] } {
  const ability = abilityById(abilityId);
  const spec = ability?.projectile;
  if (!ability || !spec) throw new Error(`no projectile on ${abilityId}`);

  const rig = new ShotRig(spec.look ?? 'orb', spec.radius);
  // Along +x at the ability's own range, rising on its own arc. The group's yaw
  // is the caller's job in the game; here the flight is along +x, so it is 0.
  const steps = Math.max(1, Math.round(progress * 90));
  for (let i = 0; i <= steps; i++) {
    const t = (i / 90) || 0;
    const x = t * ability.range;
    const z = arcHeightAt(t, spec.arcHeight);
    rig.update(STEP, x, 0, z);
    rig.group.position.set(x, z, 0);
  }
  rig.group.position.set(0, 0, 0);
  return { rig, tris: collectTriangles(rig.group) };
}

function panel(abilityId: string, progress: number, fit: number): Uint8ClampedArray {
  const { rig, tris } = flown(abilityId, progress);
  const pixels = render(tris, SIZE, VIEW_DIR, fit);
  rig.dispose();
  return pixels;
}

const cells: { row: number; column: number; pixels: Uint8ClampedArray; label: string }[] = [];

// A span wide enough for the longest shot, so every panel is the same scale and
// the arrow is visibly bigger than the star rather than fitted to the frame.
const FIT = 44;

// Row 0: every look the table grows, from the game's bearing, at mid-flight.
const LOOKS: { id: string; look: ProjectileLook }[] = [
  { id: 'ranged.shot', look: 'arrow' },
  { id: 'ranged.star', look: 'shuriken' },
  { id: 'bolt.arcane', look: 'orb' },
  { id: 'bolt.lob', look: 'orb' },
];
LOOKS.forEach((entry, column) => {
  cells.push({
    row: 0,
    column,
    pixels: panel(entry.id, 0.5, FIT),
    label: `${entry.id} (${entry.look})`,
  });
});

// Row 1: the arrow through its own arc -- the claim a single frame cannot make,
// since a nose that never moves would look identical at every sample.
[0.06, 0.28, 0.5, 0.72, 0.96].forEach((progress, column) => {
  cells.push({
    row: 1,
    column,
    pixels: panel('ranged.shot', progress, FIT),
    label: `arrow @ ${progress}`,
  });
});

// Row 2: the shuriken through a turn, for the same reason.
[0.5, 0.52, 0.54, 0.56, 0.58].forEach((progress, column) => {
  cells.push({
    row: 2,
    column,
    pixels: panel('ranged.star', progress, FIT * 0.6),
    label: `star @ ${progress}`,
  });
});

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
writeFileSync('.claude/screenshots/shots.png', PNG.sync.write(sheet));
console.log(`.claude/screenshots/shots.png  ${width}x${height}`);
console.log(cells.map((c) => `  (${c.row},${c.column}) ${c.label}`).join('\n'));
