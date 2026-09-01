// Dev-only: what an emergence actually looks like (spec 263), frame by frame,
// with the ground drawn. Not part of the app.
// `npx tsx scripts/preview-emergence.ts`
//
// It exists because the one thing this feature has to get right is not a number
// anybody can read off a test. `rigs-burrow.test.ts` proves the feet do not move
// when the body drops -- which is the mechanism -- and says nothing about
// whether the result reads as a body climbing out of a hole. That is a picture,
// and this environment has no screen, so the picture is rasterised in software:
// `preview-aim.ts`'s reason, one system over.
//
// Three things it does that `preview-monsters.ts` does not, and each is the
// point rather than a flourish:
//
//   * **The ground is drawn, and it is opaque.** Being underground in this game
//     is not a material or a clip plane, it is the terrain being in front of
//     you -- so a preview without a floor would show the whole rig hanging in
//     the air at every phase and prove nothing at all. The rasteriser is
//     z-buffered like the renderer, so the floor occludes exactly what the game
//     would occlude.
//   * **It is driven through the real staging.** `buriedAt`/`bodyDropAt` and
//     `MechRig.hiddenDepth`, not a curve retyped here -- a preview that agreed
//     with itself would be a picture of this file.
//   * **It measures as well as photographs.** What fraction of the body and of
//     the legs is above the ground at each phase is the whole claim ("the feet
//     come out first"), and it is three numbers a thumbnail is bad at. The
//     table is the instrument; the sheet is the sanity check.
//
// `ONLY=warden` renders one row.
import { mkdirSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import * as THREE from 'three';
import { MechRig, defaultMechTuning } from '../src/render/iso3d/rigs.js';
import { monsterLookFor } from '../src/render/iso3d/world/monster-look.js';
import {
  BURROW_TICKS,
  DIG_DROP,
  DIG_UNTIL,
  FEET_OUT,
  bodyDropAt,
  buriedAt,
} from '../src/render/iso3d/world/spawn-presentation.js';

const CELL = Number(process.env.CELL ?? 190);
const GAP = 6;
const GRASS: readonly [number, number, number] = [86, 118, 62];
const SHEET_BG: readonly [number, number, number] = [30, 31, 36];
const DIRT = new THREE.Color(0x6b5334);

const VIEW_DIR = new THREE.Vector3(-1, -0.82, -1).normalize();
const LIGHT = new THREE.Vector3(0.45, 0.8, 0.38).normalize();
const AMBIENT = 0.6;
const HALF_EXTENT = 62;
/** Long enough for the springs and the gait to be somewhere believable. */
const WARMUP_FRAMES = 120;

/** The phases photographed. The two staging boundaries are in it on purpose. */
const PHASES = (process.env.PHASES ?? '')
  .split(',')
  .filter((v) => v !== '')
  .map(Number)
  .concat([]) as readonly number[];
const SHOTS: readonly number[] =
  PHASES.length > 0 ? PHASES : [0, 0.15, FEET_OUT, 0.36, 0.46, DIG_UNTIL, 0.75, 1];
const ROWS = (process.env.ONLY ?? 'small_spider,warden').split(',');

interface Tri {
  readonly a: THREE.Vector3;
  readonly b: THREE.Vector3;
  readonly c: THREE.Vector3;
  readonly color: THREE.Color;
}

function rigFor(typeId: string): MechRig {
  const look = monsterLookFor(typeId);
  return new MechRig(typeId, undefined, {
    tuning: { ...defaultMechTuning(), ...look?.tuning },
    ...(look === null ? {} : { appearance: look.appearance }),
    ...(look?.lowerBodyTurns === undefined ? {} : { lowerBodyTurns: look.lowerBodyTurns }),
  });
}

function collectTriangles(root: THREE.Object3D, sink: Tri[]): void {
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
        return new THREE.Vector3(pos.getX(vi), pos.getY(vi), pos.getZ(vi)).applyMatrix4(
          mesh.matrixWorld,
        );
      });
      sink.push({
        a: corners[0] as THREE.Vector3,
        b: corners[1] as THREE.Vector3,
        c: corners[2] as THREE.Vector3,
        color: material.color,
      });
    }
  });
}

/**
 * The floor, as one big opaque quad at y = 0.
 *
 * Wound so its normal points up, for `preview-monsters.ts`'s stated reason: the
 * rasteriser culls back faces like the renderer does, and the first version of
 * its collider ring was wound the other way -- drawn, culled, and indingishable
 * from a ring nobody had asked for.
 */
function groundPlane(): Tri[] {
  const r = HALF_EXTENT * 3;
  const color = new THREE.Color(GRASS[0] / 255, GRASS[1] / 255, GRASS[2] / 255);
  const a = new THREE.Vector3(-r, 0, -r);
  const b = new THREE.Vector3(r, 0, -r);
  const c = new THREE.Vector3(r, 0, r);
  const d = new THREE.Vector3(-r, 0, r);
  return [
    { a, b: c, c: b, color },
    { a, b: d, c, color },
  ];
}

/** A ring of turned earth on the floor, so the hole reads as a hole. */
function moundRing(radius: number): Tri[] {
  const tris: Tri[] = [];
  const segments = 40;
  const at = (angle: number, r: number, y: number): THREE.Vector3 =>
    new THREE.Vector3(Math.cos(angle) * r, y, Math.sin(angle) * r);
  for (let i = 0; i < segments; i += 1) {
    const a0 = (i / segments) * Math.PI * 2;
    const a1 = ((i + 1) / segments) * Math.PI * 2;
    tris.push(
      { a: at(a0, radius * 0.72, 0.5), b: at(a1, radius, 0.5), c: at(a0, radius, 0.5), color: DIRT },
      {
        a: at(a0, radius * 0.72, 0.5),
        b: at(a1, radius * 0.72, 0.5),
        c: at(a1, radius, 0.5),
        color: DIRT,
      },
    );
  }
  return tris;
}

function encode(linear: number): number {
  const c = linear <= 0 ? 0 : linear >= 1 ? 1 : linear;
  return 255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
}

/** Orthographic, z-buffered, flat-shaded, back-face culled. The game's four. */
function render(tris: readonly Tri[], size: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < size * size; i += 1) {
    out[i * 4] = SHEET_BG[0];
    out[i * 4 + 1] = SHEET_BG[1];
    out[i * 4 + 2] = SHEET_BG[2];
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
  const midV = new THREE.Vector3(0, 20, 0).dot(up);
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
    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
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

/**
 * How much of a set of triangles sits above the floor, by vertex count.
 *
 * The number the picture is bad at and the whole claim: at the start neither
 * the body nor the legs is showing, by `FEET_OUT` the legs are up and the body
 * is not, and at the end both are entirely up.
 */
function aboveGround(tris: readonly Tri[]): number {
  let above = 0;
  let total = 0;
  for (const t of tris) {
    for (const v of [t.a, t.b, t.c]) {
      total += 1;
      if (v.y > 0) above += 1;
    }
  }
  return total === 0 ? 0 : above / total;
}

/** The rig's triangles, split into the body meshes and the leg bones. */
function partsOf(rig: MechRig): { body: Tri[]; legs: Tri[] } {
  const body: Tri[] = [];
  const legs: Tri[] = [];
  for (const child of rig.group.children) {
    // The carriage is the one `Group` under the rig's root; every leg bone is a
    // mesh parented directly to it.
    if (child instanceof THREE.Group) collectTriangles(child, body);
    else collectTriangles(child, legs);
  }
  return { body, legs };
}

function blit(
  img: PNG,
  rgba: Uint8ClampedArray,
  size: number,
  gx: number,
  gy: number,
): void {
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const src = (y * size + x) * 4;
      const dx = gx + x;
      const dy = gy + y;
      if (dx < 0 || dy < 0 || dx >= img.width || dy >= img.height) continue;
      const dst = (dy * img.width + dx) * 4;
      img.data[dst] = rgba[src] as number;
      img.data[dst + 1] = rgba[src + 1] as number;
      img.data[dst + 2] = rgba[src + 2] as number;
      img.data[dst + 3] = 255;
    }
  }
}

const width = SHOTS.length * (CELL + GAP) + GAP;
const height = ROWS.length * (CELL + GAP) + GAP;
const img = new PNG({ width, height });
for (let i = 0; i < width * height; i += 1) {
  img.data[i * 4] = SHEET_BG[0];
  img.data[i * 4 + 1] = SHEET_BG[1];
  img.data[i * 4 + 2] = SHEET_BG[2];
  img.data[i * 4 + 3] = 255;
}

console.log(`emergence, ${BURROW_TICKS} ticks (${(BURROW_TICKS / 60).toFixed(2)}s)`);
console.log(
  `  staging: under 0..${FEET_OUT}, dig ${FEET_OUT}..${DIG_UNTIL} (to drop ${DIG_DROP}), push ${DIG_UNTIL}..1`,
);

ROWS.forEach((typeId, row) => {
  const rig = rigFor(typeId);
  for (let i = 0; i < WARMUP_FRAMES; i += 1) rig.update(1 / 60, { x: 0, y: 0 }, 0);
  console.log(`\n${typeId}  hiddenDepth ${rig.hiddenDepth.toFixed(1)}`);
  console.log('  phase   tick   buried  bodyDrop   body above   legs above   knee y   body top');

  SHOTS.forEach((phase, col) => {
    const buried = buriedAt(phase);
    rig.burrow = bodyDropAt(phase);
    rig.update(1 / 60, { x: 0, y: 0 }, 0);

    // Exactly what `scene.ts` does: the whole rig is lowered by the buried
    // fraction of its own hidden depth, and the body is dropped inside it.
    rig.group.position.y = -buried * rig.hiddenDepth;
    rig.group.updateMatrixWorld(true);

    const { body, legs } = partsOf(rig);
    const tris = [...groundPlane(), ...moundRing(26), ...body, ...legs];
    blit(img, render(tris, CELL), CELL, GAP + col * (CELL + GAP), GAP + row * (CELL + GAP));

    // The knee is the number readability actually turns on: a leg with no
    // slack left is drawn straight, and a straight leg from a sunken hip to a
    // planted foot is almost entirely under the ground however far out the
    // foot is. `knee y` above `body top` is "the legs are arching over it".
    const snapshot = rig.debugSnapshot().legs;
    const kneeY = Math.max(
      ...snapshot.map((leg) => leg.knee.y + rig.group.position.y),
    );
    const bodyTop = Math.max(...body.map((t) => Math.max(t.a.y, t.b.y, t.c.y)));

    console.log(
      `  ${phase.toFixed(2)}  ${String(Math.round(phase * BURROW_TICKS)).padStart(5)}` +
        `  ${buried.toFixed(3)}     ${rig.burrow.toFixed(3)}` +
        `      ${(aboveGround(body) * 100).toFixed(0).padStart(4)}%` +
        `        ${(aboveGround(legs) * 100).toFixed(0).padStart(4)}%` +
        `    ${kneeY.toFixed(1).padStart(6)}   ${bodyTop.toFixed(1).padStart(6)}`,
    );
  });
});

mkdirSync('.claude/screenshots', { recursive: true });
const path = '.claude/screenshots/emergence.png';
writeFileSync(path, PNG.sync.write(img));
console.log(`\nwrote ${path} (${width}x${height})`);
