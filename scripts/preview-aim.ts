// Dev-only: draw an aim indicator over the arena's real ground the old way and
// the new one, side by side (spec 153). Not part of the app.
//
//   npx tsx scripts/preview-aim.ts
//
// Writes `.claude/screenshots/aim-indicators.png`.
//
// The picture is rasterised in software rather than photographed in a browser,
// for the reason `preview-turnaround.ts` gives: this environment paints the real
// page about five times a second, and the thing being looked at is a *shape*
// rather than something that happens over time -- so a deterministic rasteriser
// over the same terrain the server loads answers it exactly, in CI, with no GPU.
//
// What it renders is honest about the failure it is showing: terrain first with
// a depth buffer, then the decal translucent, depth-*tested* and never depth-
// writing, which is how `decalMaterial` really configures it. That is what makes
// the old indicator come out as broken arcs -- the half of the ring inside the
// hill fails the depth test and the half over the valley floats -- rather than
// as a clean circle somebody has to take on trust is wrong.
//
// The two columns differ in exactly one thing: whether the decal's vertices are
// placed on the heightfield or all pinned to the height under its centre. Both
// go through `projectDecal`, so the "before" column is the old bug expressed as
// a flat height function rather than as a second copy of the old code.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import {
  SampledGround,
  aimTemplate,
  projectDecal,
  ringTemplate,
  vertexCount,
  type DecalTemplate,
  type HeightAt,
} from '../src/render/iso3d/world/ground-decal.js';
import { parseMap } from '../src/terrain/map.js';
import { loadMap } from '../src/terrain/map-world.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, '.claude', 'screenshots');

const CELL = 420;
const GAP = 10;
const LABEL_H = 14;
/** Half the world-space window a cell is drawn through. */
const HALF_EXTENT = 460;
/** The scene's isometric view direction, and a light roughly where its sun is. */
const VIEW: readonly [number, number, number] = [-1, -0.82, -1];
const LIGHT: readonly [number, number, number] = [0.45, 0.8, 0.38];
const AMBIENT = 0.55;
const AIM_COLOR: readonly [number, number, number] = [0x7f / 255, 0xd4 / 255, 0xff / 255];
const GRASS: readonly [number, number, number] = [0.14, 0.2, 0.09];
const SHEET_BG: readonly [number, number, number] = [0.02, 0.02, 0.025];

interface Tri {
  readonly a: readonly [number, number, number];
  readonly b: readonly [number, number, number];
  readonly c: readonly [number, number, number];
}

function dot(a: readonly number[], b: readonly number[]): number {
  return (a[0] ?? 0) * (b[0] ?? 0) + (a[1] ?? 0) * (b[1] ?? 0) + (a[2] ?? 0) * (b[2] ?? 0);
}

function normalize(v: readonly number[]): [number, number, number] {
  const len = Math.hypot(v[0] ?? 0, v[1] ?? 0, v[2] ?? 0) || 1;
  return [(v[0] ?? 0) / len, (v[1] ?? 0) / len, (v[2] ?? 0) / len];
}

function cross(a: readonly number[], b: readonly number[]): [number, number, number] {
  return [
    (a[1] ?? 0) * (b[2] ?? 0) - (a[2] ?? 0) * (b[1] ?? 0),
    (a[2] ?? 0) * (b[0] ?? 0) - (a[0] ?? 0) * (b[2] ?? 0),
    (a[0] ?? 0) * (b[1] ?? 0) - (a[1] ?? 0) * (b[0] ?? 0),
  ];
}

/**
 * The ground under a window, as the renderer really draws it.
 *
 * Built from the chunks the server streams, off their *jittered* corners and
 * wound the way `terrain-mesh.ts` winds them -- not resampled from `heightAt` on
 * a grid of this script's own. The distinction is the whole point: the drawn
 * surface and the height function are two different objects, they disagree by
 * however far the jitter drags a corner across a slope, and a decal placed by
 * one and depth-tested against the other is what this picture is checking.
 */
function terrainTriangles(cx: number, cz: number, half: number): Tri[] {
  const tris: Tri[] = [];
  for (const chunk of map.chunks) {
    const stride = chunk.cols + 1;
    const corner = (i: number, j: number): [number, number, number] => {
      const k = j * stride + i;
      return [chunk.cornerX[k] ?? 0, chunk.heights[k] ?? 0, chunk.cornerZ[k] ?? 0];
    };
    for (let j = 0; j < chunk.rows; j++) {
      for (let i = 0; i < chunk.cols; i++) {
        if (chunk.solid[j * chunk.cols + i] !== 1) continue;
        const c00 = corner(i, j);
        const c10 = corner(i + 1, j);
        const c01 = corner(i, j + 1);
        const c11 = corner(i + 1, j + 1);
        if (Math.abs(c00[0] - cx) > half + 60 || Math.abs(c00[2] - cz) > half + 60) continue;
        tris.push({ a: c00, b: c01, c: c11 }, { a: c00, b: c11, c: c10 });
      }
    }
  }
  return tris;
}

/**
 * How high the drawn ground is at a point, by dropping a vertical ray onto the
 * triangles above -- the question a decal's depth test is really asking.
 */
function drawnHeightAt(tris: readonly Tri[], x: number, z: number): number | null {
  for (const t of tris) {
    const area =
      (t.b[0] - t.a[0]) * (t.c[2] - t.a[2]) - (t.c[0] - t.a[0]) * (t.b[2] - t.a[2]);
    if (Math.abs(area) < 1e-9) continue;
    const w0 = ((t.b[0] - x) * (t.c[2] - z) - (t.c[0] - x) * (t.b[2] - z)) / area;
    const w1 = ((t.c[0] - x) * (t.a[2] - z) - (t.a[0] - x) * (t.c[2] - z)) / area;
    const w2 = 1 - w0 - w1;
    if (w0 < -1e-9 || w1 < -1e-9 || w2 < -1e-9) continue;
    return w0 * t.a[1] + w1 * t.b[1] + w2 * t.c[1];
  }
  return null;
}

/** A projected decal, as triangles. */
function decalTriangles(
  template: DecalTemplate,
  placement: { x: number; z: number; heading: number; lift: number },
  heightAt: HeightAt,
): Tri[] {
  const world = projectDecal(
    template,
    placement,
    heightAt,
    new Float32Array(vertexCount(template) * 3),
  );
  const vertex = (i: number): [number, number, number] => [
    world[i * 3] ?? 0,
    world[i * 3 + 1] ?? 0,
    world[i * 3 + 2] ?? 0,
  ];
  const tris: Tri[] = [];
  for (let i = 0; i < template.index.length; i += 3) {
    tris.push({
      a: vertex(template.index[i] ?? 0),
      b: vertex(template.index[i + 1] ?? 0),
      c: vertex(template.index[i + 2] ?? 0),
    });
  }
  return tris;
}

/** Linear-sRGB to sRGB, the transfer WebGL applies on the way to the screen. */
function encode(linear: number): number {
  const c = linear <= 0 ? 0 : linear >= 1 ? 1 : linear;
  return 255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
}

interface Cell {
  readonly rgb: Float64Array;
  readonly depth: Float64Array;
}

function newCell(): Cell {
  const rgb = new Float64Array(CELL * CELL * 3);
  for (let i = 0; i < CELL * CELL; i++) {
    rgb[i * 3] = SHEET_BG[0];
    rgb[i * 3 + 1] = SHEET_BG[1];
    rgb[i * 3 + 2] = SHEET_BG[2];
  }
  return { rgb, depth: new Float64Array(CELL * CELL).fill(Infinity) };
}

const forward = normalize(VIEW);
const right = normalize(cross(forward, [0, 1, 0]));
const up = normalize(cross(right, forward));
const light = normalize(LIGHT);

/**
 * Orthographic, z-buffered, flat-shaded, back-face culled -- and, for a
 * translucent pass, depth-tested without depth-writing, which is what the aim
 * material really is. `centre` fixes the window in world space so both columns
 * show the same ground.
 */
function draw(
  cell: Cell,
  tris: readonly Tri[],
  color: readonly [number, number, number],
  alpha: number,
  centre: readonly [number, number, number],
): void {
  const midU = dot(centre, right);
  const midV = dot(centre, up);
  for (const t of tris) {
    const project = (p: readonly [number, number, number]): [number, number, number] => [
      dot(p, right),
      dot(p, up),
      dot(p, forward),
    ];
    const [ax, ay, az] = project(t.a);
    const [bx, by, bz] = project(t.b);
    const [cx, cy, cz] = project(t.c);

    const e1 = [t.b[0] - t.a[0], t.b[1] - t.a[1], t.b[2] - t.a[2]];
    const e2 = [t.c[0] - t.a[0], t.c[1] - t.a[1], t.c[2] - t.a[2]];
    const normal = normalize(cross(e1, e2));
    // The decal is DoubleSide, so only the opaque ground is culled.
    if (alpha >= 1 && dot(normal, forward) > 0) continue;
    const lambert = AMBIENT + (1 - AMBIENT) * Math.max(0, Math.abs(dot(normal, light)));
    const shade: [number, number, number] =
      alpha >= 1 ? [color[0] * lambert, color[1] * lambert, color[2] * lambert] : [...color];

    const px = (u: number): number => ((u - midU) / (2 * HALF_EXTENT) + 0.5) * CELL;
    const py = (v: number): number => (0.5 - (v - midV) / (2 * HALF_EXTENT)) * CELL;
    const p0 = [px(ax), py(ay)] as const;
    const p1 = [px(bx), py(by)] as const;
    const p2 = [px(cx), py(cy)] as const;

    const minX = Math.max(0, Math.floor(Math.min(p0[0], p1[0], p2[0])));
    const maxX = Math.min(CELL - 1, Math.ceil(Math.max(p0[0], p1[0], p2[0])));
    const minY = Math.max(0, Math.floor(Math.min(p0[1], p1[1], p2[1])));
    const maxY = Math.min(CELL - 1, Math.ceil(Math.max(p0[1], p1[1], p2[1])));

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
        const d = y * CELL + x;
        if (z >= (cell.depth[d] ?? Infinity)) continue;
        if (alpha >= 1) cell.depth[d] = z;
        for (let k = 0; k < 3; k++) {
          const was = cell.rgb[d * 3 + k] ?? 0;
          cell.rgb[d * 3 + k] = was * (1 - alpha) + (shade[k] ?? 0) * alpha;
        }
      }
    }
  }
}

// --- The picture ----------------------------------------------------------

const map = loadMap(parseMap(readFileSync(join(root, 'maps', 'arena.json'), 'utf8')));
/** How many times the real heightfield was asked, so the memo can be priced. */
let heightCalls = 0;
const rawHeight: HeightAt = (x, z) => {
  heightCalls++;
  return map.world.heightAt(x, z);
};
/** What the scene hands the decals: the memo, not the heightfield. */
const sampled = new SampledGround(rawHeight);
const heightAt = sampled.at;

/**
 * Somewhere with real relief to stand on: the point whose surroundings vary
 * most in height, over a coarse sweep of the map. Found rather than typed,
 * because a hand-picked coordinate goes stale the next time the arena is baked.
 */
function findSlope(): { x: number; z: number; fall: number } {
  const bounds = map.doc.layers[0]?.bounds;
  if (!bounds) throw new Error('arena.json has no layers');
  let best = { x: 0, z: 0, fall: -1 };
  for (let x = bounds.minX + 300; x < bounds.maxX - 300; x += 60) {
    for (let z = bounds.minZ + 300; z < bounds.maxZ - 300; z += 60) {
      let lo = Infinity;
      let hi = -Infinity;
      for (let a = 0; a < 8; a++) {
        const angle = (a / 8) * Math.PI * 2;
        const h = rawHeight(x + Math.cos(angle) * 260, z + Math.sin(angle) * 260);
        lo = Math.min(lo, h);
        hi = Math.max(hi, h);
      }
      if (hi - lo > best.fall) best = { x, z, fall: hi - lo };
    }
  }
  return best;
}

const spot = findSlope();
const centre: [number, number, number] = [spot.x, rawHeight(spot.x, spot.z), spot.z];
console.log(
  `standing at (${spot.x.toFixed(0)}, ${spot.z.toFixed(0)}), where the ground falls ` +
    `${spot.fall.toFixed(1)} units within 260 of the caster`,
);

const ground = terrainTriangles(spot.x, spot.z, HALF_EXTENT);

/**
 * How far the drawn surface sits above the height function that places the
 * decals on it, over the ground this picture shows.
 *
 * The number the lift has to clear, and the reason it is measured rather than
 * guessed: `heightAt` samples the layer's own lattice, and the mesh is built
 * from corners the mesher *jitters* by a third of a cell -- so on a slope the
 * two disagree by the jitter times the gradient, everywhere, with no bug
 * involved.
 */
{
  let worstAbove = 0;
  let samples = 0;
  for (let x = spot.x - 400; x <= spot.x + 400; x += 7) {
    for (let z = spot.z - 400; z <= spot.z + 400; z += 7) {
      const drawn = drawnHeightAt(ground, x, z);
      if (drawn === null) continue;
      samples++;
      worstAbove = Math.max(worstAbove, drawn - rawHeight(x, z));
    }
  }
  console.log(
    `drawn ground vs heightAt over ${samples} points: up to ${worstAbove.toFixed(2)} units above it`,
  );
}

/** The old way: every vertex pinned to the one height under the indicator. */
const pinned: HeightAt = () => rawHeight(spot.x, spot.z);

const RANGE = 420;
const templates: readonly (readonly [string, DecalTemplate, number])[] = [
  ['range ring, 420', ringTemplate(RANGE * 0.985, RANGE), 1.1],
  ['quake, radius 140', aimTemplate({ kind: 'circle', radius: 140 }), 1.3],
  ['bolt lane, 700x16', aimTemplate({ kind: 'line', length: 700, width: 16 }), 1.3],
];

const columns: Cell[] = [];
const worst: number[] = [];
for (const [, template, lift] of templates) {
  for (const ground_ of [pinned, heightAt]) {
    const cell = newCell();
    draw(cell, ground, GRASS, 1, centre);
    draw(
      cell,
      decalTriangles(template, { x: spot.x, z: spot.z, heading: 0.6, lift }, ground_),
      AIM_COLOR,
      0.55,
      centre,
    );
    columns.push(cell);
  }
  // How far off the ground the old indicator was, at its worst.
  const flat = decalTriangles(template, { x: spot.x, z: spot.z, heading: 0.6, lift }, pinned);
  worst.push(
    flat.reduce((max, t) => {
      const off = Math.abs(t.a[1] - rawHeight(t.a[0], t.a[2]) - lift);
      return Math.max(max, off);
    }, 0),
  );
}

for (const [i, [name]] of templates.entries()) {
  console.log(`${name}: the flat mesh was up to ${(worst[i] ?? 0).toFixed(1)} units off the ground`);
}

/**
 * The acceptance number: how far the conforming decal is *buried* by the ground
 * the renderer actually draws, at its worst, over the steepest ground the arena
 * has.
 *
 * Measured against the drawn triangles rather than against `heightAt`, because
 * burial is a depth test and the depth test compares against what was drawn. A
 * positive number here is a hole in the indicator.
 */
{
  for (const [name, template, lift] of templates) {
    let buried = -Infinity;
    let flatBuried = -Infinity;
    for (const heading of [0, 0.6, 1.9, 3.4, 4.8]) {
      for (const [ground_, into] of [
        [heightAt, (v: number) => (buried = Math.max(buried, v))] as const,
        [pinned, (v: number) => (flatBuried = Math.max(flatBuried, v))] as const,
      ]) {
        for (const t of decalTriangles(template, { x: spot.x, z: spot.z, heading, lift }, ground_)) {
          // The centroid, and the three edge midpoints: the points on a triangle
          // furthest from the vertices that were placed.
          for (const [px, py, pz] of [
            [(t.a[0] + t.b[0] + t.c[0]) / 3, (t.a[1] + t.b[1] + t.c[1]) / 3, (t.a[2] + t.b[2] + t.c[2]) / 3],
            [(t.a[0] + t.b[0]) / 2, (t.a[1] + t.b[1]) / 2, (t.a[2] + t.b[2]) / 2],
            [(t.b[0] + t.c[0]) / 2, (t.b[1] + t.c[1]) / 2, (t.b[2] + t.c[2]) / 2],
            [(t.c[0] + t.a[0]) / 2, (t.c[1] + t.a[1]) / 2, (t.c[2] + t.a[2]) / 2],
          ] as const) {
            const drawn = drawnHeightAt(ground, px ?? 0, pz ?? 0);
            if (drawn === null) continue;
            into(drawn - (py ?? 0));
          }
        }
      }
    }
    console.log(
      `${name}: on the ground it is buried by at most ${buried.toFixed(2)} units; ` +
        `pinned to one height it was buried by ${flatBuried.toFixed(1)}`,
    );
  }
}

/**
 * What the memo costs, over an aim that is *moving* -- which is the only case
 * that matters, since a still cursor re-reads what it read last frame.
 *
 * The number to compare it against is what the same projection costs asking the
 * heightfield directly: `SampledGround`'s own doc has that measurement, and it
 * is the reason this class exists at all.
 */
{
  const template = ringTemplate(RANGE * 0.985, RANGE);
  const out = new Float32Array(vertexCount(template) * 3);
  const warm = new SampledGround(rawHeight);
  for (let f = 0; f < 20; f++) {
    projectDecal(template, { x: spot.x + f * 3, z: spot.z + f * 2, heading: 0, lift: 1.1 }, warm.at, out);
  }
  const before = heightCalls;
  const started = process.hrtime.bigint();
  const frames = 120;
  for (let f = 20; f < 20 + frames; f++) {
    projectDecal(template, { x: spot.x + f * 3, z: spot.z + f * 2, heading: 0, lift: 1.1 }, warm.at, out);
  }
  const ms = Number(process.hrtime.bigint() - started) / 1e6 / frames;
  console.log(
    `a moving ${RANGE}-unit range ring: ${vertexCount(template)} vertices, ` +
      `${((heightCalls - before) / frames).toFixed(0)} heightfield samples a frame, ${ms.toFixed(2)} ms a frame`,
  );
}

const cols = 2;
const rows = templates.length;
const width = cols * CELL + (cols + 1) * GAP;
const height = rows * (CELL + LABEL_H) + (rows + 1) * GAP;
const png = new PNG({ width, height });
for (let i = 0; i < width * height; i++) {
  png.data[i * 4] = encode(SHEET_BG[0]);
  png.data[i * 4 + 1] = encode(SHEET_BG[1]);
  png.data[i * 4 + 2] = encode(SHEET_BG[2]);
  png.data[i * 4 + 3] = 255;
}
for (const [i, cell] of columns.entries()) {
  const col = i % cols;
  const row = Math.floor(i / cols);
  const ox = GAP + col * (CELL + GAP);
  const oy = GAP + row * (CELL + LABEL_H + GAP);
  for (let y = 0; y < CELL; y++) {
    for (let x = 0; x < CELL; x++) {
      const from = (y * CELL + x) * 3;
      const to = ((oy + y) * width + ox + x) * 4;
      png.data[to] = encode(cell.rgb[from] ?? 0);
      png.data[to + 1] = encode(cell.rgb[from + 1] ?? 0);
      png.data[to + 2] = encode(cell.rgb[from + 2] ?? 0);
      png.data[to + 3] = 255;
    }
  }
}

mkdirSync(outDir, { recursive: true });
const out = join(outDir, 'aim-indicators.png');
writeFileSync(out, PNG.sync.write(png));
console.log(`left column: pinned to one height (the old way). right column: on the ground.`);
console.log(`rows, top to bottom: ${templates.map(([name]) => name).join(' / ')}`);
console.log(`wrote ${out}`);
