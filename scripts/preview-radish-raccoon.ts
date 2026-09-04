/**
 * Photograph the radish raccoon's rig, its skin and its two clips (spec 277).
 *
 * Three sheets, because three different things can be wrong and none of them is
 * visible in the others.
 *
 *  - `radish-raccoon-parts.png` is the mesh painted by the part each vertex was
 *    labelled with. This is the sheet that matters most, because a mislabelled
 *    region is invisible at bind -- the animal looks perfect -- and only shows
 *    up as an ear that travels with a leaf once something moves.
 *  - `radish-raccoon-rig.png` is the skeleton over the silhouette, which is what
 *    says a bone is *inside* the limb it drives. The auto-rig this replaces put
 *    a knee 0.33 outside the body and looked entirely fine in a viewport that
 *    was not drawing the bones.
 *  - `radish-raccoon-clips.png` is `run` and `idle` sampled across their cycles,
 *    CPU-skinned through the real `skinPositions` at poses taken from the real
 *    `poseAt`, so what is drawn is what a frame will draw.
 *
 * Software-rasterised in the register `preview-strike.ts` established, and for
 * its reason: what is being judged is a *sequence*, this environment paints a
 * real page at a few frames a second, and none of it needs a GPU.
 *
 * It prints numbers as well, because two of the three failures are bad at being
 * photographed: how many vertices each part took, and how far each foot travels
 * across the ground over a run cycle -- a stride that slides is the one flaw a
 * strip of stills reliably hides.
 *
 * `npx tsx scripts/preview-radish-raccoon.ts`
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { readNodeTree, splitGlb, readAccessor, nodePosition, type GlbReadNode } from '../src/units/glb-read.js';
import { poseWorldMatrices, skinPositions, triangleNormal } from '../src/units/skin.js';
import { poseAt, type PosedRig } from '../src/units/clip-author.js';
import { namingOf } from '../src/units/pose.js';
import { MESH_OFFSET, RADISH_RACCOON_BONES, type PartId } from '../src/units/radish-raccoon-rig.js';
import { labelOf } from '../src/units/radish-raccoon-skin.js';
import { EAR_FLICK_AT, EAR_FLICK_SPAN, RADISH_RACCOON_CLIPS, RADISH_RACCOON_IDLE, RADISH_RACCOON_RUN } from '../src/units/radish-raccoon-clips.js';

const MESH = 'assets/units/radish_raccoon_2/radish_raccoon_2.glb';
const OUT_DIR = '.claude/screenshots';
const SIZE = 320;
const AMBIENT = 0.42;


type Vec3 = readonly [number, number, number];

/** The slice of a glTF JSON this reads: one primitive, one skin. */
interface PreviewGltf {
  readonly meshes: readonly { readonly primitives: readonly { readonly attributes: Readonly<Record<string, number>>; readonly indices: number }[] }[];
  readonly skins: readonly { readonly joints: readonly number[]; readonly inverseBindMatrices: number }[];
}


const PART_COLOUR: Readonly<Record<PartId, Vec3>> = {
  body: [214, 64, 74],
  head: [232, 214, 186],
  earL: [96, 128, 240],
  earR: [56, 78, 190],
  crown: [240, 176, 72],
  leafA: [110, 210, 90],
  leafB: [46, 150, 62],
  leafC: [176, 240, 120],
  tail: [176, 120, 200],
  armL: [250, 176, 120],
  armR: [212, 118, 54],
  legL: [120, 226, 220],
  legR: [42, 156, 158],
};

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function norm(a: Vec3): Vec3 {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}

const LIGHT: Vec3 = norm([0.45, 0.8, 0.4]);

interface Camera {
  readonly label: string;
  readonly view: Vec3;
}
/** Down -Z is the side, down -X is the front, down -Y is the top. */
const CAMERAS: readonly Camera[] = [
  { label: 'side', view: norm([0, 0, 1]) },
  { label: 'front', view: norm([-1, 0, 0]) },
  { label: 'three-quarter', view: norm([-0.75, -0.35, 0.65]) },
];

interface Frame {
  readonly pixels: Uint8ClampedArray;
  readonly size: number;
}

/** An orthographic, z-buffered, flat-shaded pass with a colour per vertex. */
function render(
  positions: Float32Array,
  indices: Uint32Array,
  colourOf: (vertex: number) => Vec3,
  camera: Camera,
  centre: Vec3,
  span: number,
): Frame {
  const pixels = new Uint8ClampedArray(SIZE * SIZE * 4);
  for (let i = 0; i < SIZE * SIZE; i += 1) {
    pixels[i * 4] = 250;
    pixels[i * 4 + 1] = 250;
    pixels[i * 4 + 2] = 250;
    pixels[i * 4 + 3] = 255;
  }
  const right = norm(cross(camera.view, [0, 1, 0]));
  const up = norm(cross(right, camera.view));
  const scale = SIZE / span;
  const toPixel = (x: number, y: number, z: number): Vec3 => {
    const p: Vec3 = [x - centre[0], y - centre[1], z - centre[2]];
    return [SIZE / 2 + dot(p, right) * scale, SIZE / 2 - dot(p, up) * scale, dot(p, camera.view)];
  };
  const depth = new Float64Array(SIZE * SIZE).fill(Number.POSITIVE_INFINITY);
  for (let at = 0; at + 2 < indices.length; at += 3) {
    const a = indices[at] as number;
    const b = indices[at + 1] as number;
    const c = indices[at + 2] as number;
    const [ax, ay, az] = toPixel(positions[a * 3] as number, positions[a * 3 + 1] as number, positions[a * 3 + 2] as number);
    const [bx, by, bz] = toPixel(positions[b * 3] as number, positions[b * 3 + 1] as number, positions[b * 3 + 2] as number);
    const [cx, cy, cz] = toPixel(positions[c * 3] as number, positions[c * 3 + 1] as number, positions[c * 3 + 2] as number);
    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (area === 0) continue;
    const shade = AMBIENT + (1 - AMBIENT) * Math.abs(dot(norm(triangleNormal(positions, a, b, c) as Vec3), LIGHT));
    const colour = colourOf(a);
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
        if (d >= (depth[index] as number)) continue;
        depth[index] = d;
        pixels[index * 4] = colour[0] * shade;
        pixels[index * 4 + 1] = colour[1] * shade;
        pixels[index * 4 + 2] = colour[2] * shade;
      }
    }
  }
  return { pixels, size: SIZE };
}

/** Bones over whatever is already in the frame, so the picture says where they are. */
function drawBones(frame: Frame, world: readonly (readonly number[])[], camera: Camera, centre: Vec3, span: number): void {
  const right = norm(cross(camera.view, [0, 1, 0]));
  const up = norm(cross(right, camera.view));
  const scale = SIZE / span;
  const at = (m: readonly number[]): [number, number] => {
    const p: Vec3 = [(m[12] as number) - centre[0], (m[13] as number) - centre[1], (m[14] as number) - centre[2]];
    return [SIZE / 2 + dot(p, right) * scale, SIZE / 2 - dot(p, up) * scale];
  };
  const plot = (x: number, y: number, c: Vec3): void => {
    const px = Math.round(x);
    const py = Math.round(y);
    if (px < 0 || py < 0 || px >= SIZE || py >= SIZE) return;
    const i = (py * SIZE + px) * 4;
    frame.pixels[i] = c[0];
    frame.pixels[i + 1] = c[1];
    frame.pixels[i + 2] = c[2];
  };
  RADISH_RACCOON_BONES.forEach((bone, index) => {
    const here = at(world[index] as readonly number[]);
    if (bone.parent !== null) {
      const parent = RADISH_RACCOON_BONES.findIndex((b) => b.name === bone.parent);
      const there = at(world[parent] as readonly number[]);
      const steps = Math.max(2, Math.ceil(Math.hypot(here[0] - there[0], here[1] - there[1])));
      for (let s = 0; s <= steps; s += 1) {
        plot(there[0] + ((here[0] - there[0]) * s) / steps, there[1] + ((here[1] - there[1]) * s) / steps, [20, 20, 30]);
      }
    }
    for (let dy = -2; dy <= 2; dy += 1) for (let dx = -2; dx <= 2; dx += 1) {
      if (dx * dx + dy * dy > 5) continue;
      plot(here[0] + dx, here[1] + dy, PART_COLOUR[bone.part]);
    }
  });
}

function sheet(rows: readonly (readonly Frame[])[], out: string): void {
  const width = Math.max(...rows.map((row) => row.length)) * SIZE;
  const png = new PNG({ width, height: rows.length * SIZE });
  png.data.fill(255);
  rows.forEach((row, r) => {
    row.forEach((frame, c) => {
      for (let y = 0; y < SIZE; y += 1) {
        for (let x = 0; x < SIZE; x += 1) {
          const from = (y * SIZE + x) * 4;
          const to = ((r * SIZE + y) * width + c * SIZE + x) * 4;
          png.data[to] = frame.pixels[from] as number;
          png.data[to + 1] = frame.pixels[from + 1] as number;
          png.data[to + 2] = frame.pixels[from + 2] as number;
          png.data[to + 3] = 255;
        }
      }
    });
  });
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(out, PNG.sync.write(png));
}

function main(): void {
  const glb = splitGlb(new Uint8Array(readFileSync(MESH)));
  const json = glb.json as unknown as PreviewGltf;
  const primitive = json.meshes[0]?.primitives[0];
  const skin = json.skins[0];
  if (!primitive || !skin) throw new Error(`${MESH} has no skinned primitive -- run scripts/make-radish-raccoon.ts`);
  const positions = readAccessor(glb, primitive.attributes['POSITION'] as number) as Float32Array;
  const indices = readAccessor(glb, primitive.indices) as Uint32Array;
  const joints = readAccessor(glb, primitive.attributes['JOINTS_0'] as number) as Uint32Array;
  const weights = readAccessor(glb, primitive.attributes['WEIGHTS_0'] as number) as Float32Array;
  const inverseBind = readAccessor(glb, skin.inverseBindMatrices) as Float32Array;
  const nodes = readNodeTree(glb);
  const naming = namingOf(nodes);
  if (naming === 'unknown') throw new Error('the rig answers to neither naming contract');
  const rig: PosedRig = { nodes, naming };

  // Labels are read in the mesh's own frame, which is the shifted one on disk.
  const labels: PartId[] = [];
  for (let i = 0; i < positions.length / 3; i += 1) {
    labels.push(
      labelOf([
        (positions[i * 3] as number) - (MESH_OFFSET[0] as number),
        (positions[i * 3 + 1] as number) - (MESH_OFFSET[1] as number),
        (positions[i * 3 + 2] as number) - (MESH_OFFSET[2] as number),
      ]),
    );
  }

  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let k = 0; k < 3; k += 1) {
      lo[k] = Math.min(lo[k] as number, positions[i + k] as number);
      hi[k] = Math.max(hi[k] as number, positions[i + k] as number);
    }
  }
  const centre: Vec3 = [((lo[0] as number) + (hi[0] as number)) / 2, ((lo[1] as number) + (hi[1] as number)) / 2, ((lo[2] as number) + (hi[2] as number)) / 2];
  const span = Math.max(...[0, 1, 2].map((k) => (hi[k] as number) - (lo[k] as number))) * 1.12;

  const boneNodes = RADISH_RACCOON_BONES.map((bone) => nodes.find((n) => n.name === bone.name) as GlbReadNode);
  // `skinPositions` wants the inverse binds as one array per joint and the node
  // each joint is, which is the skin's own joint list in its own order.
  const inverseBindRows = skin.joints.map((_, j) => Array.from(inverseBind.subarray(j * 16, j * 16 + 16)));
  const skinInput = {
    positions,
    joints,
    weights,
    jointNodes: skin.joints,
    inverseBind: inverseBindRows as readonly (readonly number[])[],
  };

  // --- parts: the hard labels, and the field they become ---
  //
  // The second row is the one that answers the question the first one raises.
  // A label is a decision and a *weight* is what the mesh is actually skinned
  // by, so a seam that looks like a cliff on the top row and a gradient on the
  // bottom one is the relaxation pass having done its job -- and a seam that is
  // a cliff on both is a tear waiting for the first frame that bends it.
  const partOfBone = RADISH_RACCOON_BONES.map((bone) => PART_COLOUR[bone.part]);
  const blended = (v: number): Vec3 => {
    const mix: [number, number, number] = [0, 0, 0];
    for (let k = 0; k < 4; k += 1) {
      const w = weights[v * 4 + k] as number;
      if (w <= 0) continue;
      const c = partOfBone[joints[v * 4 + k] as number] as Vec3;
      mix[0] += c[0] * w;
      mix[1] += c[1] * w;
      mix[2] += c[2] * w;
    }
    return mix;
  };
  sheet(
    [
      CAMERAS.map((camera) => render(positions, indices, (v) => PART_COLOUR[labels[v] as PartId], camera, centre, span)),
      CAMERAS.map((camera) => render(positions, indices, blended, camera, centre, span)),
    ],
    `${OUT_DIR}/radish-raccoon-parts.png`,
  );

  // --- rig over the silhouette ---
  const bind = poseWorldMatrices(nodes, new Map());
  const rigRow = CAMERAS.map((camera) => {
    const frame = render(positions, indices, () => [222, 222, 226], camera, centre, span);
    drawBones(frame, RADISH_RACCOON_BONES.map((b) => bind[nodes.findIndex((n) => n.name === b.name)] as readonly number[]), camera, centre, span);
    return frame;
  });
  sheet([rigRow], `${OUT_DIR}/radish-raccoon-rig.png`);

  // --- clips ---
  //
  // `run` in profile, because a stride is a thing seen from the side, and
  // `idle` head-on, because a weight shift is a roll and a roll is invisible in
  // the plane it happens in. Eight frames each, evenly over the cycle.
  const strip = (clip: (typeof RADISH_RACCOON_CLIPS)[number], view: Camera, count: number, from = 0, to = 1): Frame[] => {
    const frames: Frame[] = [];
    for (let step = 0; step < count; step += 1) {
      const phase = from + ((to - from) * step) / count;
      const posed = skinPositions(skinInput, poseWorldMatrices(nodes, poseAt(clip, rig, phase * clip.durationMs)));
      frames.push(render(posed, indices, blended, view, centre, span));
    }
    return frames;
  };
  const side = CAMERAS[0] as Camera;
  const front = CAMERAS[1] as Camera;
  sheet(
    [strip(RADISH_RACCOON_RUN, side, 8), strip(RADISH_RACCOON_RUN, CAMERAS[2] as Camera, 8), strip(RADISH_RACCOON_IDLE, front, 8)],
    `${OUT_DIR}/radish-raccoon-clips.png`,
  );

  // The ear flick gets a strip of its own, and it needs one: it lasts 0.045 of
  // a 4.8-second cycle, so eight frames spread over the clip land on it with
  // probability about a third and a sheet that missed it looks exactly like a
  // sheet of an ear that never moved.
  sheet(
    [strip(RADISH_RACCOON_IDLE, front, 8, EAR_FLICK_AT - 0.01, EAR_FLICK_AT + EAR_FLICK_SPAN + 0.01)],
    `${OUT_DIR}/radish-raccoon-ear-flick.png`,
  );

  // --- numbers ---
  // How soft the skin came out: a vertex whose heaviest bone holds nearly all
  // of it is inside a part, and one that is split is on a seam. Both extremes
  // are findings -- no split vertices at all means the relaxation did nothing.
  let solo = 0;
  let split = 0;
  for (let v = 0; v < positions.length / 3; v += 1) {
    const top = weights[v * 4] as number;
    if (top > 0.98) solo += 1;
    else if (top < 0.75) split += 1;
  }
  const total = positions.length / 3;
  console.log(`skin: ${((solo / total) * 100).toFixed(1)}% of vertices ride one bone, ${((split / total) * 100).toFixed(1)}% are shared three ways or more\n`);

  const tally = new Map<PartId, number>();
  for (const label of labels) tally.set(label, (tally.get(label) ?? 0) + 1);
  console.log('vertices per part');
  for (const [part, n] of [...tally].sort((a, b) => b[1] - a[1])) console.log(`  ${part.padEnd(6)} ${String(n).padStart(5)}`);

  console.log('\nbind pose bone positions');
  RADISH_RACCOON_BONES.forEach((bone, i) => {
    const p = nodePosition(boneNodes[i] as GlbReadNode);
    console.log(`  ${bone.name.padEnd(11)} [${p.map((v) => v.toFixed(3)).join(', ')}]`);
  });

  for (const clip of RADISH_RACCOON_CLIPS) {
    console.log(`\n${clip.id}: ${clip.durationMs}ms`);
    for (const foot of ['L_ToeBase', 'R_ToeBase'] as const) {
      const index = nodes.findIndex((n) => n.name === foot);
      let lowest = Number.POSITIVE_INFINITY;
      let highest = Number.NEGATIVE_INFINITY;
      let travel = 0;
      let previous: Vec3 | null = null;
      for (let step = 0; step <= 32; step += 1) {
        const world = poseWorldMatrices(nodes, poseAt(clip, rig, (step / 32) * clip.durationMs));
        const m = world[index] as readonly number[];
        const p: Vec3 = [m[12] as number, m[13] as number, m[14] as number];
        lowest = Math.min(lowest, p[1]);
        highest = Math.max(highest, p[1]);
        if (previous) travel += Math.hypot(p[0] - previous[0], p[2] - previous[2]);
        previous = p;
      }
      console.log(`  ${foot}: lift ${(highest - lowest).toFixed(3)}  ground travel ${travel.toFixed(3)}  lowest ${lowest.toFixed(3)}`);
    }
  }
}

main();
