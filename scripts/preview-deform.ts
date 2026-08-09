// Dev-only: photograph a unit at the poses the deformation check measures
// (spec 115), so a person can decide what a warning is worth.
// Not part of the app. `npx tsx scripts/preview-deform.ts [path/to/unit.glb]`
//
// The numbers are the gate; this is the picture beside them. A volume ratio of
// 0.6 is a fact, and whether a shoulder that does that is shippable is not
// something a build gets to decide -- but nobody can decide it from a number
// either. So the same `skinPositions` the check runs is rasterised here, at the
// same poses, with the bind pose beside each one for comparison.
//
// The rasteriser is a copy of the one in `preview-trees.ts` and is here for the
// same reason: there is no GPU in a container. What it draws is the real posed
// mesh, not an approximation of one.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import {
  readInverseBindMatrices,
  readNodeTree,
  readSkinnedMesh,
  splitGlb,
  type GlbReadNode,
  type SkinnedMeshData,
} from '../src/units/glb-read.js';
import { checkDeformation, classifyBindPose, extremePoses } from '../src/units/mesh-check.js';
import { poseWorldMatrices, skinPositions, triangleNormal } from '../src/units/skin.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SIZE = Number(process.env['SIZE'] ?? 260);
const GAP = 8;
const BG: readonly [number, number, number] = [58, 60, 68];
const BODY: readonly [number, number, number] = [0.82, 0.74, 0.6];
/** Roughly the game's isometric bearing, and a light near where its sun is. */
const VIEW: readonly [number, number, number] = norm([-1, -0.6, -1]);
const LIGHT: readonly [number, number, number] = norm([0.45, 0.8, 0.38]);
const AMBIENT = 0.55;

function norm(v: readonly [number, number, number]): [number, number, number] {
  const length = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / length, v[1] / length, v[2] / length];
}

function cross(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): [number, number, number] {
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

/**
 * Orthographic, z-buffered, flat-shaded, at a **fixed** span.
 *
 * Fixed rather than fitted per panel, so an arm that flew off the body makes the
 * body smaller in its panel instead of quietly rescaling to look normal. Fitting
 * each frame is how a check-by-eye stops working.
 */
function render(
  positions: Float32Array,
  indices: Uint32Array,
  size: number,
  centre: readonly [number, number, number],
  span: number,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < size * size; i += 1) {
    out[i * 4] = BG[0];
    out[i * 4 + 1] = BG[1];
    out[i * 4 + 2] = BG[2];
    out[i * 4 + 3] = 255;
  }

  const forward = VIEW;
  const right = norm(cross(forward, [0, 1, 0]));
  const up = norm(cross(right, forward));
  const scale = size / span;
  const toPixel = (x: number, y: number, z: number): [number, number, number] => {
    const p: [number, number, number] = [x - centre[0], y - centre[1], z - centre[2]];
    return [size / 2 + dot(p, right) * scale, size / 2 - dot(p, up) * scale, dot(p, forward)];
  };

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
    // Two-sided on purpose: a triangle that folded through itself must still be
    // drawn, or the very failure this picture exists for renders as nothing.
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

function bounds(positions: Float32Array): { centre: [number, number, number]; span: number } {
  const lo: [number, number, number] = [Infinity, Infinity, Infinity];
  const hi: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let v = 0; v * 3 + 2 < positions.length; v += 1) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = positions[v * 3 + axis] ?? 0;
      lo[axis] = Math.min(lo[axis] ?? value, value);
      hi[axis] = Math.max(hi[axis] ?? value, value);
    }
  }
  return {
    centre: [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2],
    // Room for a limb that swings past the silhouette, which is the case the
    // picture is for.
    span: Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) * 1.9,
  };
}

function main(): void {
  const meshPath = process.argv[2]
    ? resolve(process.argv[2])
    : join(repoRoot, 'assets', 'units', 'dev', 'mannequin.glb');

  const glb = splitGlb(new Uint8Array(readFileSync(meshPath)));
  const nodes: readonly GlbReadNode[] = readNodeTree(glb);
  const mesh: SkinnedMeshData | null = readSkinnedMesh(glb);
  if (!mesh) {
    console.error(`${meshPath} has no skinned mesh in it`);
    process.exitCode = 1;
    return;
  }
  const inverseBind = readInverseBindMatrices(glb);
  const poses = extremePoses(nodes);
  const { centre, span } = bounds(mesh.positions);

  const frames: { label: string; pixels: Uint8ClampedArray }[] = [
    { label: 'bind', pixels: render(mesh.positions, mesh.indices, SIZE, centre, span) },
  ];
  for (const pose of poses) {
    const posed = skinPositions({ ...mesh, inverseBind }, poseWorldMatrices(nodes, pose.rotations));
    frames.push({ label: pose.id, pixels: render(posed, mesh.indices, SIZE, centre, span) });
  }

  const width = frames.length * SIZE + (frames.length - 1) * GAP;
  const png = new PNG({ width, height: SIZE });
  png.data.fill(40);
  frames.forEach((frame, column) => {
    const x0 = column * (SIZE + GAP);
    for (let y = 0; y < SIZE; y += 1) {
      for (let x = 0; x < SIZE; x += 1) {
        const from = (y * SIZE + x) * 4;
        const to = (y * width + x0 + x) * 4;
        png.data[to] = frame.pixels[from] ?? 0;
        png.data[to + 1] = frame.pixels[from + 1] ?? 0;
        png.data[to + 2] = frame.pixels[from + 2] ?? 0;
        png.data[to + 3] = 255;
      }
    }
  });

  const out = join(repoRoot, '.claude', 'screenshots', 'deform.png');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, PNG.sync.write(png));

  const verdict = classifyBindPose(nodes);
  const { issues, reports } = checkDeformation(mesh, nodes, inverseBind);
  console.log(`  ${frames.map((frame) => frame.label).join('  |  ')}`);
  console.log(`  bind pose: ${verdict.shape} -- ${verdict.reason}`);
  for (const report of reports) {
    console.log(
      `  ${report.poseId.padEnd(22)} volume ${(report.volumeRatio * 100).toFixed(0)}%` +
        `  pinched ${report.pinchedTriangles}/${report.triangles}` +
        `  worst vertex ${report.worstDisplacement.toFixed(2)}x height`,
    );
  }
  for (const issue of issues) console.log(`  ${issue.code}: ${issue.message}`);
  console.log(`\n  wrote ${out.slice(repoRoot.length + 1)}`);
}

main();
