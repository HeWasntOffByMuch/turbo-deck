/**
 * Dev-only: what the run clip's posture actually looks like (spec 163).
 *
 *   npx tsx scripts/preview-run-posture.ts
 *   POSTURE=spine:9,chest:9,neck:8,head:8 npx tsx scripts/preview-run-posture.ts
 *
 * Two rows per view: the retarget as it was bought, and the clip in a posture
 * table. The table defaults to `RUN_POSTURE`, and `POSTURE=` overrides it,
 * because the numbers in that table were *chosen* rather than derived and the
 * only honest way to choose them is to look at a few side by side.
 *
 * The side view is the row that matters -- a lean and a gaze are sagittal, and
 * the game's own isometric bearing foreshortens both. The iso row is there to
 * confirm the correction stayed a pitch: a rotation taken in the wrong frame
 * arrives as a pitch mixed with a roll, and a body listing to one side is
 * invisible from directly beside it.
 *
 * The rasteriser is the one from `preview-strike.ts`, copied for the reason that
 * one gives: there is no GPU in a container, and what it draws is the real posed
 * mesh at the real sampled frames rather than an approximation of either.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { clipDurationOf, clipPoseAt } from '../src/units/clip-sample.js';
import {
  readInverseBindMatrices,
  readNodeTree,
  readSkinnedMesh,
  splitGlb,
  type GlbReadNode,
  type SkinnedMeshData,
} from '../src/units/glb-read.js';
import { bodyFrame, namingOf } from '../src/units/pose.js';
import {
  pitchedPose,
  postureDelta,
  readPosture,
  recordedPosture,
  RUN_POSTURE,
  type PostureTable,
} from '../src/units/posture.js';
import { poseWorldMatrices, skinPositions, triangleNormal, type PoseRotations } from '../src/units/skin.js';
import type { BoneRole } from '../src/units/naming.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SIZE = Number(process.env['SIZE'] ?? 220);
const GAP = 6;
/** Eight frames over the loop: two strides, which is enough to read a gait. */
const COLUMNS = Number(process.env['COLUMNS'] ?? 8);

const BG: readonly [number, number, number] = [58, 60, 68];
const AFTER_TINT: readonly [number, number, number] = [48, 62, 56];
const BODY: readonly [number, number, number] = [0.82, 0.74, 0.6];
const HORIZON: readonly [number, number, number] = [96, 92, 84];
const AMBIENT = 0.55;
const LIGHT = norm([0.45, 0.8, 0.38]);

const VIEWS: readonly { id: string; direction: [number, number, number] }[] = [
  { id: 'side', direction: norm([0, -0.08, -1]) },
  { id: 'iso', direction: norm([-1, -0.6, -1]) },
];

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

/** `spine:9,chest:9,neck:8,head:8`, for trying a candidate without an edit. */
function tableFromEnv(): PostureTable {
  const text = process.env['POSTURE'];
  if (text === undefined || text.trim() === '') return RUN_POSTURE;
  const out: Partial<Record<BoneRole, number>> = {};
  for (const pair of text.split(',')) {
    const [role, degrees] = pair.split(':');
    if (!role || degrees === undefined) throw new Error(`POSTURE entry "${pair}" is not role:degrees`);
    out[role.trim() as BoneRole] = Number(degrees);
  }
  return out;
}

function render(
  positions: Float32Array,
  indices: Uint32Array,
  view: readonly [number, number, number],
  size: number,
  centre: readonly [number, number, number],
  span: number,
  background: readonly [number, number, number],
  eyeHeight: number,
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

  // A horizon at the height of the head at bind, so "the face is below level"
  // is something a reader can see rather than something they have to take on
  // trust from the numbers underneath.
  const line = Math.round(size / 2 - (eyeHeight - centre[1]) * scale);
  if (line >= 0 && line < size) {
    for (let x = 0; x < size; x += 4) {
      const index = line * size + x;
      out[index * 4] = HORIZON[0];
      out[index * 4 + 1] = HORIZON[1];
      out[index * 4 + 2] = HORIZON[2];
    }
  }

  const depth = new Float64Array(size * size).fill(Number.POSITIVE_INFINITY);
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
        out[index * 4] = encode(BODY[0] * shade);
        out[index * 4 + 1] = encode(BODY[1] * shade);
        out[index * 4 + 2] = encode(BODY[2] * shade);
      }
    }
  }
  return out;
}

function main(): void {
  const meshGlb = splitGlb(new Uint8Array(readFileSync(join(repoRoot, 'assets', 'units', 'pig_a_pose_full', 'pig_a_pose_full.glb'))));
  const clipGlb = splitGlb(new Uint8Array(readFileSync(join(repoRoot, 'assets', 'units', 'clips', 'run.glb'))));
  const nodes: readonly GlbReadNode[] = readNodeTree(meshGlb);
  const clipNodes = readNodeTree(clipGlb);
  const mesh: SkinnedMeshData | null = readSkinnedMesh(meshGlb);
  const naming = namingOf(nodes);
  if (!mesh || naming === 'unknown') {
    console.error('the pig mesh has no skinned mesh, or bones nothing recognises');
    process.exitCode = 1;
    return;
  }
  const frame = bodyFrame(nodes, naming);
  if (!frame) {
    console.error('the pig rig has no measurable body frame');
    process.exitCode = 1;
    return;
  }
  const inverseBind = readInverseBindMatrices(meshGlb);
  const table = tableFromEnv();

  // Fixed against the bind mesh, so a frame that reaches further makes the body
  // smaller rather than quietly rescaling -- fitting each cell is how a
  // check-by-eye stops working, and this one is entirely a check by eye.
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
  const span = height * 1.05;
  // The top of the head at bind: where the face looks out from when standing.
  const eyeHeight = lo + height * 0.88;

  const duration = clipDurationOf(clipGlb);
  const times: number[] = [];
  for (let column = 0; column < COLUMNS; column += 1) times.push((duration * column) / COLUMNS);

  // The committed clip already carries a posture, so "before" is the clip with
  // that posture taken back out -- the retarget as it was bought. Read off the
  // file rather than assumed, or this preview quietly draws the correction
  // twice the moment the bytes are written.
  const applied = recordedPosture(clipGlb.json);
  const rows: { view: string; label: string; posture: PostureTable }[] = [];
  for (const view of VIEWS) {
    rows.push({ view: view.id, label: 'retarget', posture: postureDelta({}, applied) });
    rows.push({ view: view.id, label: 'corrected', posture: postureDelta(table, applied) });
  }

  const width = COLUMNS * SIZE + (COLUMNS - 1) * GAP;
  const tall = rows.length * SIZE + (rows.length - 1) * GAP;
  const png = new PNG({ width, height: tall });
  png.data.fill(30);

  const reading = { retarget: { gaze: 0, lean: 0 }, corrected: { gaze: 0, lean: 0 } };
  rows.forEach((row, index) => {
    const view = VIEWS.find((entry) => entry.id === row.view);
    if (!view) return;
    times.forEach((seconds, column) => {
      const raw: PoseRotations = clipPoseAt(clipGlb, clipNodes, seconds);
      const pose = pitchedPose(nodes, naming, frame, raw, row.posture);
      const world = poseWorldMatrices(nodes, pose);
      const posed = skinPositions({ ...mesh, inverseBind }, world);
      const measured = readPosture(nodes, naming, frame, pose);
      if (measured && row.view === 'side') {
        const into = row.label === 'retarget' ? reading.retarget : reading.corrected;
        into.gaze += measured.gaze / COLUMNS;
        into.lean += measured.lean / COLUMNS;
      }
      const pixels = render(
        posed,
        mesh.indices,
        view.direction,
        SIZE,
        centre,
        span,
        row.label === 'retarget' ? BG : AFTER_TINT,
        eyeHeight,
      );
      const x0 = column * (SIZE + GAP);
      const y0 = index * (SIZE + GAP);
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

  const out = join(repoRoot, '.claude', 'screenshots', 'run-posture.png');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, PNG.sync.write(png));

  const say = (n: number): string => `${n >= 0 ? '+' : ''}${n.toFixed(1)}`;
  console.log(`  posture: ${Object.entries(table).map(([role, deg]) => `${role} ${say(deg)}`).join(', ') || 'none'}`);
  console.log(`  rows: ${rows.map((row) => `${row.view}/${row.label}`).join(', ')}`);
  console.log(`  gaze  ${say(reading.retarget.gaze)} -> ${say(reading.corrected.gaze)}`);
  console.log(`  lean  ${say(reading.retarget.lean)} -> ${say(reading.corrected.lean)}`);
  console.log(`  wrote ${out.slice(repoRoot.length + 1)}`);
}

main();
