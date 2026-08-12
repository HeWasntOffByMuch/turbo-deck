// Dev-only: photograph the pig's swing with a REAL weapon in its hand, so the
// socket calibration is tuned rather than guessed (spec 140).
//
//   npx tsx scripts/preview-weapon.ts
//   WEAPON=stick_knot STEP=100 SIZE=300 npx tsx scripts/preview-weapon.ts
//   MAIN_ROT=0,0,-90 MAIN_OFF=0,0.02,0 npx tsx scripts/preview-weapon.ts   # try numbers
//   STOW=1 npx tsx scripts/preview-weapon.ts                               # sheathed
//
// This supersedes the blade proxy in `preview-strike.ts`, which was a box on a
// guess about which way a hand points. The whole grip chain runs here exactly as
// `weapon-rig.ts` builds it in the browser -- the same `gripTransform`, the same
// socket euler order -- so a number that looks right in this picture is a number
// that can be pasted into `biped.skeleton.json` and be right there too.
//
// The rasteriser is the one from `preview-strike.ts`, which is the one from
// `preview-deform.ts`. Copied for the reason those say: there is no GPU here.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { poseAt } from '../src/units/clip-author.js';
import {
  compose,
  multiply,
  readAccessor,
  readInverseBindMatrices,
  readNodeTree,
  readSkinnedMesh,
  splitGlb,
  type GlbBinary,
  type GlbReadNode,
} from '../src/units/glb-read.js';
import { PIG_STRIKE, STRIKE_KEY_MS } from '../src/units/pig-strike.js';
import { poseWorldMatrices, skinPositions, triangleNormal } from '../src/units/skin.js';
import { gripTransform } from '../src/items/grip.js';
import { validateWeaponDef } from '../src/items/validate.js';
import { validateSkeleton } from '../src/units/validate.js';
import { namingOf } from '../src/units/pose.js';
import type { SkeletonSocket } from '../src/units/types.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SIZE = Number(process.env['SIZE'] ?? 240);
const GAP = 6;
const STEP_MS = Number(process.env['STEP'] ?? 100);
const WEAPON = process.env['WEAPON'] ?? 'sword_jian';
const STOWED = process.env['STOW'] === '1';

const BG: readonly [number, number, number] = [58, 60, 68];
const KEY_TINT: readonly [number, number, number] = [70, 66, 58];
const BODY: readonly [number, number, number] = [0.82, 0.74, 0.6];
const AMBIENT = 0.55;
const LIGHT = norm([0.45, 0.8, 0.38]);

const VIEWS: readonly { id: string; direction: [number, number, number] }[] = [
  { id: 'iso', direction: norm([-1, -0.6, -1]) },
  { id: 'side', direction: norm([0, -0.12, -1]) },
  { id: 'front', direction: norm([-1, -0.12, 0]) },
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
function encode(linear: number): number {
  const c = linear <= 0 ? 0 : linear >= 1 ? 1 : linear;
  return 255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
}

interface Surface {
  readonly positions: Float32Array;
  readonly indices: Uint32Array;
  readonly colour: readonly [number, number, number];
}

/** An override like `0,0.02,0` from the environment, for trying a number. */
function triple(name: string): [number, number, number] | null {
  const raw = process.env[name];
  if (raw === undefined) return null;
  const parts = raw.split(',').map(Number);
  if (parts.length !== 3 || parts.some((v) => !Number.isFinite(v))) return null;
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

/** Every primitive of a non-skinned `.glb`, with its material's base colour. */
function readRigidMesh(glb: GlbBinary): readonly Surface[] {
  const json = glb.json as {
    meshes?: { primitives?: { attributes?: Record<string, number>; indices?: number; material?: number }[] }[];
    materials?: { pbrMetallicRoughness?: { baseColorFactor?: number[] } }[];
  };
  const out: Surface[] = [];
  for (const mesh of json.meshes ?? []) {
    for (const primitive of mesh.primitives ?? []) {
      const positionIndex = primitive.attributes?.['POSITION'];
      if (positionIndex === undefined || primitive.indices === undefined) continue;
      const factor = json.materials?.[primitive.material ?? -1]?.pbrMetallicRoughness?.baseColorFactor;
      out.push({
        positions: new Float32Array(readAccessor(glb, positionIndex)),
        indices: new Uint32Array(readAccessor(glb, primitive.indices)),
        colour: [factor?.[0] ?? 0.7, factor?.[1] ?? 0.72, factor?.[2] ?? 0.75],
      });
    }
  }
  return out;
}

/** Applies a column-major 4x4 to every vertex of a surface. */
function transformed(surface: Surface, m: readonly number[]): Surface {
  const out = new Float32Array(surface.positions.length);
  for (let v = 0; v + 2 < surface.positions.length; v += 3) {
    const x = surface.positions[v] ?? 0;
    const y = surface.positions[v + 1] ?? 0;
    const z = surface.positions[v + 2] ?? 0;
    out[v] = (m[0] ?? 0) * x + (m[4] ?? 0) * y + (m[8] ?? 0) * z + (m[12] ?? 0);
    out[v + 1] = (m[1] ?? 0) * x + (m[5] ?? 0) * y + (m[9] ?? 0) * z + (m[13] ?? 0);
    out[v + 2] = (m[2] ?? 0) * x + (m[6] ?? 0) * y + (m[10] ?? 0) * z + (m[14] ?? 0);
  }
  return { ...surface, positions: out };
}

/** Euler XYZ degrees to a quaternion, matching `socketPivot`'s order exactly. */
function eulerQuat(deg: readonly [number, number, number]): [number, number, number, number] {
  const d = Math.PI / 360;
  const [cx, cy, cz] = [Math.cos(deg[0] * d), Math.cos(deg[1] * d), Math.cos(deg[2] * d)];
  const [sx, sy, sz] = [Math.sin(deg[0] * d), Math.sin(deg[1] * d), Math.sin(deg[2] * d)];
  return [
    sx * cy * cz + cx * sy * sz,
    cx * sy * cz - sx * cy * sz,
    cx * cy * sz + sx * sy * cz,
    cx * cy * cz - sx * sy * sz,
  ];
}

function render(
  surfaces: readonly Surface[],
  view: readonly [number, number, number],
  centre: readonly [number, number, number],
  span: number,
  background: readonly [number, number, number],
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(SIZE * SIZE * 4);
  for (let i = 0; i < SIZE * SIZE; i += 1) {
    out[i * 4] = background[0];
    out[i * 4 + 1] = background[1];
    out[i * 4 + 2] = background[2];
    out[i * 4 + 3] = 255;
  }
  const right = norm(cross(view, [0, 1, 0]));
  const up = norm(cross(right, view));
  const scale = SIZE / span;
  const toPixel = (x: number, y: number, z: number): [number, number, number] => {
    const p: [number, number, number] = [x - centre[0], y - centre[1], z - centre[2]];
    return [SIZE / 2 + dot(p, right) * scale, SIZE / 2 - dot(p, up) * scale, dot(p, view)];
  };

  const depth = new Float64Array(SIZE * SIZE).fill(Number.POSITIVE_INFINITY);
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
      const hiX = Math.min(SIZE - 1, Math.ceil(Math.max(ax, bx, cx)));
      const loY = Math.max(0, Math.floor(Math.min(ay, by, cy)));
      const hiY = Math.min(SIZE - 1, Math.ceil(Math.max(ay, by, cy)));
      for (let y = loY; y <= hiY; y += 1) {
        for (let x = loX; x <= hiX; x += 1) {
          const px = x + 0.5;
          const py = y + 0.5;
          const w0 = ((bx - ax) * (py - ay) - (by - ay) * (px - ax)) / area;
          const w1 = ((px - ax) * (cy - ay) - (py - ay) * (cx - ax)) / area;
          if (w0 < 0 || w1 < 0 || w0 + w1 > 1) continue;
          const d = az + w1 * (bz - az) + w0 * (cz - az);
          const index = y * SIZE + x;
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
  const unitDir = join(repoRoot, 'assets', 'units', 'pig_a_pose_full');
  const pigGlb = splitGlb(new Uint8Array(readFileSync(join(unitDir, 'pig_a_pose_full.glb'))));
  const nodes: readonly GlbReadNode[] = readNodeTree(pigGlb);
  const mesh = readSkinnedMesh(pigGlb);
  const naming = namingOf(nodes);
  if (!mesh || naming === 'unknown') {
    console.error('the pig mesh is not something this can pose');
    process.exitCode = 1;
    return;
  }
  const inverseBind = readInverseBindMatrices(pigGlb);
  const rig = { nodes, naming };

  const skeleton = validateSkeleton(
    JSON.parse(readFileSync(join(repoRoot, 'assets', 'units', 'biped.skeleton.json'), 'utf8')),
  ).value;
  if (!skeleton) {
    console.error('biped.skeleton.json does not validate');
    process.exitCode = 1;
    return;
  }
  // The pig's import scale, which the socket pivot has to undo: `lengthWorld` is
  // in world units and this preview draws the rig at its authored ~1 unit.
  const unitDoc = JSON.parse(readFileSync(join(unitDir, 'pig_a_pose_full.unitdef.json'), 'utf8')) as {
    import: { scale: number };
  };
  const hostScale = unitDoc.import.scale;

  const weaponDir = join(repoRoot, 'assets', 'items', WEAPON);
  const weapon = validateWeaponDef(JSON.parse(readFileSync(join(weaponDir, `${WEAPON}.weapondef.json`), 'utf8'))).value;
  if (!weapon) {
    console.error(`${WEAPON} does not validate; run npm run validate:items`);
    process.exitCode = 1;
    return;
  }
  const weaponGlb = splitGlb(new Uint8Array(readFileSync(join(weaponDir, weapon.meshRef))));
  const weaponSurfaces = readRigidMesh(weaponGlb);

  const lo: [number, number, number] = [Infinity, Infinity, Infinity];
  const hi: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const surface of weaponSurfaces) {
    surface.positions.forEach((value, index) => {
      const axis = index % 3;
      lo[axis] = Math.min(lo[axis] ?? Infinity, value);
      hi[axis] = Math.max(hi[axis] ?? -Infinity, value);
    });
  }
  const grip = gripTransform(weapon, { min: lo, max: hi });

  const socketId = STOWED ? (weapon.stowSocket ?? weapon.socket) : weapon.socket;
  const socket: SkeletonSocket | undefined = skeleton.sockets.find((entry) => entry.id === socketId);
  if (!socket) {
    console.error(`the pig has no socket "${socketId}"`);
    process.exitCode = 1;
    return;
  }
  const boneIndex = nodes.find((node) => node.name === socket.bone)?.index;
  if (boneIndex === undefined) {
    console.error(`the pig rig has no bone "${socket.bone}"`);
    process.exitCode = 1;
    return;
  }

  // Overridable from the environment so a number can be tried without editing
  // the committed document, which is the whole loop this script exists for.
  const offset = triple(STOWED ? 'STOW_OFF' : 'MAIN_OFF') ?? socket.offset ?? [0, 0, 0];
  const rotation = triple(STOWED ? 'STOW_ROT' : 'MAIN_ROT') ?? socket.rotationDeg ?? [0, 0, 0];

  // The same chain `weapon-rig.ts` builds, as matrices:
  //   bone . pivot(offset, euler, 1/hostScale) . align(gripRotation, gripScale) . model(-gripAt)
  const pivot = multiply(
    compose(offset as [number, number, number], eulerQuat(rotation), [1, 1, 1]),
    compose([0, 0, 0], [0, 0, 0, 1], [1 / hostScale, 1 / hostScale, 1 / hostScale]),
  );
  const align = multiply(
    compose([0, 0, 0], grip.rotation, [grip.scale, grip.scale, grip.scale]),
    compose(grip.meshOffset as [number, number, number], [0, 0, 0, 1], [1, 1, 1]),
  );
  const held = multiply(pivot, align);
  /** The same chain with a candidate socket transform, for a sweep column. */
  const heldWith = (candidate: { rot: [number, number, number]; off: [number, number, number] | null }): readonly number[] =>
    multiply(
      multiply(
        compose(candidate.off ?? (offset as [number, number, number]), eulerQuat(candidate.rot), [1, 1, 1]),
        compose([0, 0, 0], [0, 0, 0, 1], [1 / hostScale, 1 / hostScale, 1 / hostScale]),
      ),
      align,
    );

  // Two column modes. Normally a column is a moment of the swing. With `SWEEP`
  // set -- `SWEEP=0/0/0,0/0/-25,-20/0/0` -- a column is a candidate *rotation*
  // at one fixed moment, which is the loop this script exists for: four numbers
  // side by side beats four runs and four screenshots.
  // `rx/ry/rz` for a rotation, or `rx/ry/rz@ox/oy/oz` to try an offset with it.
  const sweep = (process.env['SWEEP'] ?? '')
    .split(',')
    .filter((entry) => entry.trim() !== '')
    .map((entry): { rot: [number, number, number]; off: [number, number, number] | null } => {
      const [rotPart, offPart] = entry.split('@');
      const r = (rotPart ?? '').split('/').map(Number);
      const o = offPart === undefined ? null : offPart.split('/').map(Number);
      return {
        rot: [r[0] ?? 0, r[1] ?? 0, r[2] ?? 0],
        off: o === null ? null : [o[0] ?? 0, o[1] ?? 0, o[2] ?? 0],
      };
    });
  const sweepAt = Number(process.env['AT'] ?? 0);
  const times: number[] = [];
  if (sweep.length > 0) {
    // One column per candidate, all at the same moment of the swing.
    times.push(...sweep.map(() => sweepAt));
  } else {
    const from = Number(process.env['FROM'] ?? 0);
    const to = Number(process.env['TO'] ?? PIG_STRIKE.durationMs);
    for (let ms = from; ms <= to; ms += STEP_MS) times.push(ms);
  }
  const keyAt = new Map<number, string>(Object.entries(STRIKE_KEY_MS).map(([label, ms]) => [ms as number, label]));

  // Fixed framing off the bind mesh with room for a raised sword, so a frame
  // whose blade left the silhouette makes the body smaller rather than quietly
  // rescaling everything.
  let bodyLo = Infinity;
  let bodyHi = -Infinity;
  const centre: [number, number, number] = [0, 0, 0];
  for (let v = 0; v * 3 + 2 < mesh.positions.length; v += 1) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = mesh.positions[v * 3 + axis] ?? 0;
      bodyLo = Math.min(bodyLo, value);
      bodyHi = Math.max(bodyHi, value);
      centre[axis] = (centre[axis] ?? 0) + value;
    }
  }
  const vertices = mesh.positions.length / 3;
  const height = bodyHi - bodyLo;
  for (let axis = 0; axis < 3; axis += 1) centre[axis] = (centre[axis] ?? 0) / vertices;
  centre[1] = bodyLo + height / 2;
  const span = height * Number(process.env['SPAN'] ?? 2.3);

  const width = times.length * SIZE + (times.length - 1) * GAP;
  const totalHeight = VIEWS.length * SIZE + (VIEWS.length - 1) * GAP;
  const png = new PNG({ width, height: totalHeight });
  png.data.fill(30);

  VIEWS.forEach((view, row) => {
    times.forEach((ms, column) => {
      const world = poseWorldMatrices(nodes, poseAt(PIG_STRIKE, rig, ms));
      const posed = skinPositions({ ...mesh, inverseBind }, world);
      const boneWorld = world[boneIndex] ?? [];
      const candidate = sweep[column];
      const toWorld = multiply(boneWorld, candidate ? heldWith(candidate) : held);
      const surfaces: Surface[] = [
        { positions: posed, indices: mesh.indices, colour: BODY },
        ...weaponSurfaces.map((surface) => transformed(surface, toWorld)),
      ];
      const pixels = render(surfaces, view.direction, centre, span, sweep.length === 0 && keyAt.has(ms) ? KEY_TINT : BG);
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

  const out = join(repoRoot, '.claude', 'screenshots', `weapon-${WEAPON}${STOWED ? '-stowed' : ''}.png`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, PNG.sync.write(png));

  console.log(`  ${weapon.name} (${weapon.id}) on ${socketId} -> ${socket.bone}`);
  console.log(`  mesh ${(hi[2] - lo[2]).toFixed(3)} long -> ${weapon.lengthWorld} world units, scale ${grip.scale.toFixed(3)}`);
  console.log(`  tip ${grip.tipDistance.toFixed(1)} from the grip, butt ${grip.buttDistance.toFixed(1)}`);
  console.log(`  socket offset [${offset.join(', ')}]  rotationDeg [${rotation.join(', ')}]`);
  console.log(
    `  rows ${VIEWS.map((v) => v.id).join(', ')} | columns ` +
      (sweep.length > 0
        ? sweep.map((entry) => `[${entry.rot.join(',')}]${entry.off ? `@[${entry.off.join(',')}]` : ''}`).join(' ')
        : times.map((ms) => keyAt.get(ms) ?? ms).join(' ')),
  );
  console.log(`  wrote ${out.slice(repoRoot.length + 1)}`);
}

main();
