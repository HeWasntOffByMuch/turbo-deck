// Dev-only: photograph the authored bow shot, frame by frame (spec 164).
// `npx tsx scripts/preview-shot.ts`
//
// The same rasteriser as `preview-strike.ts`, copied for the reason that one
// gives: there is no GPU in a container, and what it draws is the real posed
// mesh at the real sampled frames rather than an approximation of either.
//
// What it does NOT draw is a bow, and that is the honest state of things --
// there is no bow mesh in this project, `weapon.off` carries no calibration to
// hang one from, and a proxy invented here would be a prop the game does not
// have. So the two things the strip is read for are both about the body: does
// the string hand travel and the bow hand hold, and does the release land on
// the frame the arrow leaves rather than near it.
//
// Instead of a blade there is a **string**: a bar drawn between the two hands,
// which is the one thing about a draw that a still frame cannot otherwise show.
// It is a measurement rather than a prop -- it says how far apart the hands got
// -- and a column where it is short is a column where the pig is not drawing.
//
// Two views: the game's own isometric bearing, and a side-on one where the draw
// is a length rather than a foreshortening.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { poseAt } from '../src/units/clip-author.js';
import {
  readInverseBindMatrices,
  readNodeTree,
  readSkinnedMesh,
  splitGlb,
  type GlbReadNode,
  type SkinnedMeshData,
} from '../src/units/glb-read.js';
import { PIG_SHOT, SHOT_KEY_MS } from '../src/units/pig-shot.js';
import { bodyFrame, boneNode, intoBodyFrame, namingOf } from '../src/units/pose.js';
import { poseWorldMatrices, skinPositions, triangleNormal } from '../src/units/skin.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SIZE = Number(process.env['SIZE'] ?? 200);
const GAP = 6;
/** Every 50ms: 24 frames over the clip, which is a strip a person can scan. */
const STEP_MS = Number(process.env['STEP'] ?? 50);

const BG: readonly [number, number, number] = [58, 60, 68];
const BODY: readonly [number, number, number] = [0.82, 0.74, 0.6];
const STRING: readonly [number, number, number] = [0.62, 0.68, 0.78];
const KEY_TINT: readonly [number, number, number] = [70, 66, 58];
const AMBIENT = 0.55;
const LIGHT = norm([0.45, 0.8, 0.38]);

/** The game's isometric bearing, and a side-on one for the draw. */
const VIEWS: readonly { id: string; direction: [number, number, number] }[] = [
  { id: 'iso', direction: norm([-1, -0.6, -1]) },
  { id: 'side', direction: norm([0, -0.12, -1]) },
];

/** How thick the string bar is drawn, as a fraction of the rig's height. */
const STRING_WIDTH = 0.012;

function norm(v: readonly [number, number, number]): [number, number, number] {
  const length = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / length, v[1] / length, v[2] / length];
}

function cross(a: readonly [number, number, number], b: readonly [number, number, number]): [number, number, number] {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function dot(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/** Linear-sRGB to sRGB, the transfer WebGL applies on the way to the screen. */
function encode(linear: number): number {
  const c = linear <= 0 ? 0 : linear >= 1 ? 1 : linear;
  return 255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
}

interface Surface {
  readonly positions: Float32Array;
  readonly indices: Uint32Array;
  readonly colour: readonly [number, number, number];
}

/**
 * The string, as a thin box between the two hands.
 *
 * A *measurement*, not a prop: a draw is the distance the hands get apart, and
 * a still frame of two arms cannot say whether that distance is growing. Drawn
 * between the hand origins rather than from either hand's own axes, because
 * neither wrist decides where the other hand is -- which is exactly the thing
 * this clip has to get right and the sword never had to.
 */
function stringSurface(from: readonly number[], to: readonly number[], height: number): Surface {
  const a: [number, number, number] = [from[12] ?? 0, from[13] ?? 0, from[14] ?? 0];
  const b: [number, number, number] = [to[12] ?? 0, to[13] ?? 0, to[14] ?? 0];
  const along = norm([b[0] - a[0], b[1] - a[1], b[2] - a[2]]);
  // Any two directions across it will do; the bar is square and has no roll.
  const side = norm(cross(along, Math.abs(along[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0]));
  const flat = norm(cross(along, side));

  const half = height * STRING_WIDTH;
  const corners: [number, number, number][] = [];
  for (const end of [a, b]) {
    for (const s of [-1, 1]) {
      for (const f of [-1, 1]) {
        corners.push([
          end[0] + side[0] * half * s + flat[0] * half * f,
          end[1] + side[1] * half * s + flat[1] * half * f,
          end[2] + side[2] * half * s + flat[2] * half * f,
        ]);
      }
    }
  }
  const positions = new Float32Array(corners.flat());
  // The six faces of the box, two triangles each, wound outward.
  const indices = new Uint32Array([
    0, 1, 3, 0, 3, 2, 4, 7, 5, 4, 6, 7, 0, 5, 1, 0, 4, 5, 2, 3, 7, 2, 7, 6, 0, 2, 6, 0, 6, 4, 1, 7, 3, 1, 5, 7,
  ]);
  return { positions, indices, colour: STRING };
}

/** Orthographic, z-buffered, flat-shaded, at a fixed span so nothing rescales. */
function render(
  surfaces: readonly Surface[],
  view: readonly [number, number, number],
  size: number,
  centre: readonly [number, number, number],
  span: number,
  background: readonly [number, number, number],
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < size * size; i += 1) {
    out[i * 4] = background[0];
    out[i * 4 + 1] = background[1];
    out[i * 4 + 2] = background[2];
    out[i * 4 + 3] = 255;
  }

  const right = norm(cross(view, [0, 1, 0]));
  const up = norm(cross(right, view));
  const scale = size / span;
  const toPixel = (x: number, y: number, z: number): [number, number, number] => {
    const p: [number, number, number] = [x - centre[0], y - centre[1], z - centre[2]];
    return [size / 2 + dot(p, right) * scale, size / 2 - dot(p, up) * scale, dot(p, view)];
  };

  const depth = new Float64Array(size * size).fill(Number.POSITIVE_INFINITY);
  for (const surface of surfaces) {
    const { positions, indices, colour } = surface;
    for (let at = 0; at + 2 < indices.length; at += 3) {
      const a = indices[at] ?? 0;
      const b = indices[at + 1] ?? 0;
      const c = indices[at + 2] ?? 0;
      const [ax, ay, az] = toPixel(positions[a * 3] ?? 0, positions[a * 3 + 1] ?? 0, positions[a * 3 + 2] ?? 0);
      const [bx, by, bz] = toPixel(positions[b * 3] ?? 0, positions[b * 3 + 1] ?? 0, positions[b * 3 + 2] ?? 0);
      const [cx, cy, cz] = toPixel(positions[c * 3] ?? 0, positions[c * 3 + 1] ?? 0, positions[c * 3 + 2] ?? 0);
      const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      if (area === 0) continue;

      const normal = norm(triangleNormal(positions, a, b, c));
      const shade = AMBIENT + (1 - AMBIENT) * Math.abs(dot(normal, LIGHT));

      const loX = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
      const hiX = Math.min(size - 1, Math.ceil(Math.max(ax, bx, cx)));
      const loY = Math.max(0, Math.floor(Math.min(ay, by, cy)));
      const hiY = Math.min(size - 1, Math.ceil(Math.max(ay, by, cy)));
      for (let y = loY; y <= hiY; y += 1) {
        for (let x = loX; x <= hiX; x += 1) {
          const px = x + 0.5;
          const py = y + 0.5;
          const w0 = ((bx - ax) * (py - ay) - (by - ay) * (px - ax)) / area;
          const w1 = ((px - ax) * (cy - ay) - (py - ay) * (cx - ax)) / area;
          if (w0 < 0 || w1 < 0 || w0 + w1 > 1) continue;
          const d = az + w1 * (bz - az) + w0 * (cz - az);
          const index = y * size + x;
          if (d >= (depth[index] ?? Number.POSITIVE_INFINITY)) continue;
          depth[index] = d;
          out[index * 4] = encode(colour[0] * shade);
          out[index * 4 + 1] = encode(colour[1] * shade);
          out[index * 4 + 2] = encode(colour[2] * shade);
        }
      }
    }
  }
  return out;
}

function main(): void {
  const meshPath = join(repoRoot, 'assets', 'units', 'pig_a_pose_full', 'pig_a_pose_full.glb');
  const glb = splitGlb(new Uint8Array(readFileSync(meshPath)));
  const nodes: readonly GlbReadNode[] = readNodeTree(glb);
  const mesh: SkinnedMeshData | null = readSkinnedMesh(glb);
  const naming = namingOf(nodes);
  if (!mesh || naming === 'unknown') {
    console.error('the pig mesh has no skinned mesh, or bones nothing recognises');
    process.exitCode = 1;
    return;
  }
  const rig = { nodes, naming };
  const inverseBind = readInverseBindMatrices(glb);
  const draw = boneNode(nodes, naming, 'rightHand');
  const bow = boneNode(nodes, naming, 'leftHand');
  if (!draw || !bow) {
    console.error('the rig is missing a hand, so there is no string to draw between them');
    process.exitCode = 1;
    return;
  }

  // Fixed against the *bind* mesh with room for a raised blade, so a frame whose
  // arm left the silhouette makes the body smaller rather than quietly
  // rescaling. Fitting each frame is how a check-by-eye stops working.
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  const centre: [number, number, number] = [0, 0, 0];
  for (let v = 0; v * 3 + 2 < mesh.positions.length; v += 1) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = mesh.positions[v * 3 + axis] ?? 0;
      lo = Math.min(lo, value);
      hi = Math.max(hi, value);
      centre[axis] = (centre[axis] ?? 0) + value;
    }
  }
  const height = hi - lo;
  const vertices = mesh.positions.length / 3;
  for (let axis = 0; axis < 3; axis += 1) centre[axis] = (centre[axis] ?? 0) / vertices;
  centre[1] = lo + height / 2;
  const span = height * Number(process.env['SPAN'] ?? 1.12);

  const times: number[] = [];
  const from = Number(process.env['FROM'] ?? 0);
  const to = Number(process.env['TO'] ?? PIG_SHOT.durationMs);
  for (let ms = from; ms <= to; ms += STEP_MS) times.push(ms);
  const keyAt = new Map<number, string>(Object.entries(SHOT_KEY_MS).map(([label, ms]) => [ms as number, label]));

  const columns = times.length;
  const width = columns * SIZE + (columns - 1) * GAP;
  const height2 = VIEWS.length * SIZE + (VIEWS.length - 1) * GAP;
  const png = new PNG({ width, height: height2 });
  png.data.fill(30);

  VIEWS.forEach((view, row) => {
    times.forEach((ms, column) => {
      const world = poseWorldMatrices(nodes, poseAt(PIG_SHOT, rig, ms));
      const posed = skinPositions({ ...mesh, inverseBind }, world);
      const surfaces: Surface[] = [
        { positions: posed, indices: mesh.indices, colour: BODY },
        stringSurface(world[bow.index] ?? [], world[draw.index] ?? [], height),
      ];
      // A key frame gets a lighter ground, so the seven authored poses can be
      // picked out of the strip without counting columns.
      const background = keyAt.has(ms) ? KEY_TINT : BG;
      const pixels = render(surfaces, view.direction, SIZE, centre, span, background);
      const x0 = column * (SIZE + GAP);
      const y0 = row * (SIZE + GAP);
      for (let y = 0; y < SIZE; y += 1) {
        for (let x = 0; x < SIZE; x += 1) {
          const from = (y * SIZE + x) * 4;
          const to = ((y0 + y) * width + x0 + x) * 4;
          png.data[to] = pixels[from] ?? 0;
          png.data[to + 1] = pixels[from + 1] ?? 0;
          png.data[to + 2] = pixels[from + 2] ?? 0;
          png.data[to + 3] = 255;
        }
      }
    });
  });

  const out = join(repoRoot, '.claude', 'screenshots', 'pig-shot.png');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, PNG.sync.write(png));

  // The numbers the strip is actually read for. A thumbnail of a pig cannot
  // settle whether the string hand went *back* -- both hands are in front of
  // the body for most of the clip and a bar between them foreshortens -- so the
  // places are printed in the body's own axes beside the picture.
  const frame = bodyFrame(nodes, naming);
  const hips = boneNode(nodes, naming, 'hips');
  if (frame && hips) {
    const place = (world: readonly (readonly number[])[], index: number): { right: number; up: number; forward: number } => {
      const m = world[index] ?? [];
      const at = world[hips.index] ?? [];
      return intoBodyFrame(frame, [
        (m[12] ?? 0) - (at[12] ?? 0),
        (m[13] ?? 0) - (at[13] ?? 0),
        (m[14] ?? 0) - (at[14] ?? 0),
      ]);
    };
    const say = (v: { right: number; up: number; forward: number }): string =>
      [v.right, v.up, v.forward].map((n) => (n / height).toFixed(2).padStart(6)).join(' ');
    console.log('\n     ms  label      bow hand (r,u,f)     draw hand (r,u,f)    apart');
    for (const ms of times) {
      const world = poseWorldMatrices(nodes, poseAt(PIG_SHOT, rig, ms));
      const b = place(world, bow.index);
      const d = place(world, draw.index);
      const apart = Math.hypot(b.right - d.right, b.up - d.up, b.forward - d.forward) / height;
      console.log(
        `  ${String(ms).padStart(5)}  ${(keyAt.get(ms) ?? '').padEnd(8)}  ${say(b)}  ${say(d)}  ${apart.toFixed(3)}`,
      );
    }
    console.log('');
  }

  console.log(`  rows: ${VIEWS.map((view) => view.id).join(', ')}`);
  console.log(`  columns: ${times.map((ms) => keyAt.get(ms) ?? String(ms)).join(' ')}`);
  console.log(`  wrote ${out.slice(repoRoot.length + 1)}`);
}

main();
