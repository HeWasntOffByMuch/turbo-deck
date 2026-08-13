// Dev-only: render every monster's rig (spec 152) to a PNG contact sheet so a
// human -- or an agent with no screen -- can check what the arena is actually
// full of. Not part of the app. `tsx scripts/preview-monsters.ts`
//
// It builds the rig **the way `scene.ts` builds it**: the look table for the
// body shape, the colours and the tuning overrides, spread onto
// `defaultMechTuning()`, handed to the real `MechRig`, and walked at the
// monster's own replicated move speed. So this checks the whole chain -- the
// monster table, the look table, the rig -- and not a second model of it.
//
// Two things it does deliberately differently from `preview-critters.ts`:
//
//   * **One frame for every cell.** Auto-framing each subject on its own extent
//     is the friendlier picture and useless here, because the thing being
//     checked is that a small enemy is small. A shared world-space window is
//     the only way a row of monsters answers that.
//   * **The collider is drawn**, as a ring on the ground at the monster's
//     `radius`. The drawn size lives in the look table and the collider lives
//     in the monster table, nothing forces the two to agree, and this is the
//     picture where a disagreement is obvious.
//
// `ONLY=small_spider` renders one row.
import { mkdirSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import * as THREE from 'three';
import { ALL_MONSTERS } from '../src/server/data/monsters.js';
import { MechRig, defaultMechTuning } from '../src/render/iso3d/rigs.js';
import { monsterLookFor } from '../src/render/iso3d/world/monster-look.js';

const BIG = Number(process.env.BIG ?? 256);
const SMALL = 64;
const SMALL_SCALE = 3;
const GAP = 8;
const BG: readonly [number, number, number] = [86, 118, 62]; // the arena's grass
const SHEET_BG: readonly [number, number, number] = [30, 31, 36];

/** The scene's isometric view direction, and a light roughly where its sun is. */
const VIEW_DIR = new THREE.Vector3(-1, -0.82, -1).normalize();
const LIGHT = new THREE.Vector3(0.45, 0.8, 0.38).normalize();
const AMBIENT = 0.6;

/**
 * Half the world-space window every cell is drawn through. Sized off the widest
 * body in the game with room around it, and shared by every cell -- see above.
 */
const HALF_EXTENT = 70;

const WARMUP_FRAMES = 150;
/** Straight-line walk, then a hard turn: the pose that shows what the legs do. */
const TURN_FRAMES = 60;

interface Tri {
  readonly a: THREE.Vector3;
  readonly b: THREE.Vector3;
  readonly c: THREE.Vector3;
  readonly color: THREE.Color;
}

/** Every triangle under `root`, in world space, with its material's colour. */
function collectTriangles(root: THREE.Object3D): Tri[] {
  const tris: Tri[] = [];
  root.updateMatrixWorld(true);
  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh || mesh.visible === false) return;
    const pos = mesh.geometry.getAttribute('position');
    const index = mesh.geometry.getIndex();
    const material = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as
      | THREE.MeshLambertMaterial
      | undefined;
    if (!material) return;
    const count = index ? index.count : pos.count;
    for (let i = 0; i < count; i += 3) {
      const corners = [0, 1, 2].map((k) => {
        const vi = index ? index.getX(i + k) : i + k;
        return new THREE.Vector3(pos.getX(vi), pos.getY(vi), pos.getZ(vi)).applyMatrix4(mesh.matrixWorld);
      });
      tris.push({
        a: corners[0] as THREE.Vector3,
        b: corners[1] as THREE.Vector3,
        c: corners[2] as THREE.Vector3,
        color: material.color,
      });
    }
  });
  return tris;
}

/** A flat ring on the ground at `radius`: the circle the sim collides with. */
function colliderRing(radius: number): Tri[] {
  const color = new THREE.Color(0x1a1a1a);
  const tris: Tri[] = [];
  const segments = 48;
  const inner = radius - 1.2;
  const at = (angle: number, r: number): THREE.Vector3 =>
    new THREE.Vector3(Math.cos(angle) * r, 0.4, Math.sin(angle) * r);
  for (let i = 0; i < segments; i++) {
    const a0 = (i / segments) * Math.PI * 2;
    const a1 = ((i + 1) / segments) * Math.PI * 2;
    const o0 = at(a0, radius);
    const o1 = at(a1, radius);
    const i0 = at(a0, inner);
    const i1 = at(a1, inner);
    // Wound so the normal points *up*. The rasteriser culls back faces like the
    // real renderer does, and the first version of this ring was wound the other
    // way -- so it was drawn, culled, and looked exactly like a ring nobody had
    // asked for.
    tris.push({ a: i0, b: o1, c: o0, color }, { a: i0, b: i1, c: o1, color });
  }
  return tris;
}

// --- Rasteriser -----------------------------------------------------------

/** Linear-sRGB to sRGB, the transfer WebGL applies on the way to the screen. */
function encode(linear: number): number {
  const c = linear <= 0 ? 0 : linear >= 1 ? 1 : linear;
  return 255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
}

/**
 * Orthographic, z-buffered, flat-shaded and back-face culled: the four
 * properties the game's renderer has that decide whether a silhouette reads.
 * The window is fixed rather than fitted, so a cell's subject is drawn at the
 * size it really is relative to every other cell.
 */
function render(tris: readonly Tri[], size: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    out[i * 4] = BG[0];
    out[i * 4 + 1] = BG[1];
    out[i * 4 + 2] = BG[2];
    out[i * 4 + 3] = 255;
  }

  const forward = VIEW_DIR;
  const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();
  const up = new THREE.Vector3().crossVectors(right, forward).normalize();
  const project = (p: THREE.Vector3): [number, number, number] => [
    p.dot(right),
    p.dot(up),
    p.dot(forward),
  ];
  // Centred on the body's own standing height rather than on its feet, so the
  // window holds the same piece of world for a tall body and a short one.
  const midV = new THREE.Vector3(0, 26, 0).dot(up);

  const depth = new Float64Array(size * size).fill(Infinity);
  const normal = new THREE.Vector3();
  const e1 = new THREE.Vector3();
  const e2 = new THREE.Vector3();

  for (const t of tris) {
    const [ax, ay, az] = project(t.a);
    const [bx, by, bz] = project(t.b);
    const [cx, cy, cz] = project(t.c);

    e1.subVectors(t.b, t.a);
    e2.subVectors(t.c, t.a);
    normal.crossVectors(e1, e2).normalize();
    if (normal.dot(forward) > 0) continue;
    const lambert = AMBIENT + (1 - AMBIENT) * Math.max(0, normal.dot(LIGHT));
    const r = encode(t.color.r * lambert);
    const g = encode(t.color.g * lambert);
    const b = encode(t.color.b * lambert);

    const px = (u: number): number => (u / (2 * HALF_EXTENT) + 0.5) * size;
    const py = (v: number): number => (0.5 - (v - midV) / (2 * HALF_EXTENT)) * size;
    const p0 = [px(ax), py(ay)] as const;
    const p1 = [px(bx), py(by)] as const;
    const p2 = [px(cx), py(cy)] as const;

    const minX = Math.max(0, Math.floor(Math.min(p0[0], p1[0], p2[0])));
    const maxX = Math.min(size - 1, Math.ceil(Math.max(p0[0], p1[0], p2[0])));
    const minY = Math.max(0, Math.floor(Math.min(p0[1], p1[1], p2[1])));
    const maxY = Math.min(size - 1, Math.ceil(Math.max(p0[1], p1[1], p2[1])));

    const area = (p1[0] - p0[0]) * (p2[1] - p0[1]) - (p2[0] - p0[0]) * (p1[1] - p0[1]);
    if (Math.abs(area) < 1e-9) continue;

    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const sx = x + 0.5;
        const sy = y + 0.5;
        const w0 = ((p1[0] - sx) * (p2[1] - sy) - (p2[0] - sx) * (p1[1] - sy)) / area;
        const w1 = ((p2[0] - sx) * (p0[1] - sy) - (p0[0] - sx) * (p2[1] - sy)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        const z = w0 * az + w1 * bz + w2 * cz;
        const d = y * size + x;
        if (z >= (depth[d] as number)) continue;
        depth[d] = z;
        out[d * 4] = r;
        out[d * 4 + 1] = g;
        out[d * 4 + 2] = b;
        out[d * 4 + 3] = 255;
      }
    }
  }
  return out;
}

// --- Sheet ----------------------------------------------------------------

/** Exactly how `scene.ts` builds a monster's rig. */
function rigFor(typeId: string): MechRig {
  const look = monsterLookFor(typeId);
  return new MechRig(typeId, undefined, {
    tuning: { ...defaultMechTuning(), ...look?.tuning },
    ...(look === null ? {} : { appearance: look.appearance }),
  });
}

/** Walk the body at its own replicated speed, optionally turning at the end. */
function posed(typeId: string, moveSpeed: number, turning: boolean): Tri[] {
  const rig = rigFor(typeId);
  const step = Math.max(20, moveSpeed) / 60;
  let x = 0;
  let z = 0;
  let ry = 0;
  for (let i = 0; i < WARMUP_FRAMES; i++) {
    x += step;
    rig.update(1 / 60, { x, y: z }, ry);
  }
  if (turning) {
    for (let i = 0; i < TURN_FRAMES; i++) {
      ry += 0.06;
      x += Math.cos(ry) * step;
      z += Math.sin(ry) * step;
      rig.update(1 / 60, { x, y: z }, ry);
    }
  }
  // Park the group back at the origin. The walk only ever moves the group,
  // which the scene owns, so this keeps every cell framed identically.
  rig.group.position.set(0, 0, 0);
  rig.group.rotation.y = turning ? ry : 0;
  return collectTriangles(rig.group);
}

const ONLY = process.env.ONLY?.split(',');
const MONSTERS = ALL_MONSTERS.filter((m) => (ONLY ? ONLY.includes(m.id) : true));

const cellW = BIG + GAP;
const rowH = BIG + GAP;
const sheetW = 2 * cellW + SMALL * SMALL_SCALE + GAP;
const sheetH = MONSTERS.length * rowH;
const img = new PNG({ width: sheetW, height: sheetH, colorType: 6 });
for (let i = 0; i < img.data.length; i += 4) {
  img.data[i] = SHEET_BG[0];
  img.data[i + 1] = SHEET_BG[1];
  img.data[i + 2] = SHEET_BG[2];
  img.data[i + 3] = 255;
}

function blit(rgba: Uint8ClampedArray, w: number, gx: number, gy: number, scale = 1): void {
  for (let y = 0; y < w; y++) {
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 4;
      for (let sy = 0; sy < scale; sy++) {
        for (let sx = 0; sx < scale; sx++) {
          const X = gx + x * scale + sx;
          const Y = gy + y * scale + sy;
          if (X < 0 || Y < 0 || X >= img.width || Y >= img.height) continue;
          const d = (Y * img.width + X) * 4;
          img.data[d] = rgba[s] as number;
          img.data[d + 1] = rgba[s + 1] as number;
          img.data[d + 2] = rgba[s + 2] as number;
          img.data[d + 3] = 255;
        }
      }
    }
  }
}

MONSTERS.forEach((monster, row) => {
  const ring = colliderRing(monster.radius);
  const walking = posed(monster.id, monster.stats.moveSpeed, false);
  const turning = posed(monster.id, monster.stats.moveSpeed, true);
  blit(render([...ring, ...walking], BIG), BIG, 0, row * rowH);
  blit(render([...ring, ...turning], BIG), BIG, cellW, row * rowH);
  // And at the size it actually ships at, upscaled so a person can see it.
  blit(render([...ring, ...walking], SMALL), SMALL, 2 * cellW, row * rowH, SMALL_SCALE);
  const look = monsterLookFor(monster.id);
  process.stdout.write(
    `${monster.name}: radius ${monster.radius}, speed ${monster.stats.moveSpeed}, ` +
      `${look ? `${look.appearance.shape} body at ${look.tuning.sizeScale ?? 1}x` : 'no look row (box body at 1x)'}, ` +
      `${walking.length} triangles\n`,
  );
});

mkdirSync('.claude/screenshots', { recursive: true });
const path = '.claude/screenshots/monsters.png';
writeFileSync(path, PNG.sync.write(img));
process.stdout.write(`wrote ${path} (${sheetW}x${sheetH})\n`);
