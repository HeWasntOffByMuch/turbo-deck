// Dev-only: look at the Warden's lance over the arena's real ground (spec 262).
// Not part of the app.
//
//   npx tsx scripts/preview-lance.ts
//
// Writes `.claude/screenshots/warden-lance.png`.
//
// Rasterised in software rather than photographed in a browser, for the reason
// `preview-aim.ts` gives: this environment paints the real page about five times
// a second, and what is being judged here is a *shape* rather than something
// that happens over time. Both phases are ground decals, so the same
// deterministic rasteriser over the same heightfield the server loads answers it
// exactly, with no GPU.
//
// It draws all three pictures the way the scene really configures them: the
// sight as pixels along the line, the shaft as a solid box out of the head, and
// the lane under it as a depth-tested decal that never writes depth. And it
// draws a player and the machine as blocks, because the question this picture
// exists to answer is not "is the beam pretty": it is **can you still see
// yourself standing in it**.
//
// ## What it measures
//
// Two numbers, and both are about failures a thumbnail hides.
//
//   - **cover.** What fraction of the frame the beam paints. A weapon that
//     swamps the screen is unreadable however good the colour is, and a
//     lock-on that covers almost nothing is the honest report of a line six
//     units wide.
//   - **lift.** How far the beam moves the ground's colour, per channel, as a
//     fraction of one retro colour band. `living-ground.ts` records the rule
//     this is measuring against: a mark smaller than half a band is not a
//     subtle mark, it is an absent one -- the retro pass quantizes it away and
//     nothing anywhere fails.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

import { WARDEN_LASER } from '../src/server/data/warden.js';
import { CastPhase } from '../src/server/sim/types.js';
import type { HeightAt } from '../src/render/iso3d/world/ground-decal.js';
import {
  BEAM_GLOW_HEIGHT,
  BEAM_GLOW_LIGHTS,
  BEAM_GLOW_RADIUS,
  SHAFT_FRACTION,
  SIGHT_SPACING,
  beamGlowAt,
  beamGlowBrightness,
  beamLookFor,
  sightDotAt,
  sightDotCount,
  type BeamCast,
  type ShaftLook,
  type SightLook,
} from '../src/render/iso3d/world/warden-beam.js';
import { pointIntensity } from '../src/render/iso3d/player-lights.js';
import { loadMap } from '../src/terrain/map-world.js';
import { loadMapFile } from '../src/server/world/map-file.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, '.claude', 'screenshots');

const CELL = 400;
const GAP = 10;
const LABEL_H = 14;
/** Half the window, so the whole 620-unit reach fits with room around it. */
const HALF = 360;
const VIEW: readonly [number, number, number] = [-1, -0.82, -1];
const LIGHT: readonly [number, number, number] = [0.45, 0.8, 0.38];
const AMBIENT = 0.55;

/** `scene.ts`'s own, so the picture and the game cannot come to two colours. */
const LANCE: RGB = [0xff / 255, 0x33 / 255, 0x23 / 255];
const LANCE_CORE: RGB = [0xff / 255, 0xc0 / 255, 0x7a / 255];
const LANCE_SIGHT: RGB = [0xff / 255, 0x4a / 255, 0x33 / 255];
const GRASS: RGB = [0.14, 0.2, 0.09];
const BODY: RGB = [0.62, 0.66, 0.72];
const MECH: RGB = [0.35, 0.38, 0.42];
const SHEET_BG: RGB = [0.02, 0.02, 0.025];

/** The retro pass's step, for the lift measurement. Five levels a channel. */
const RETRO_LEVELS = 5;

type RGB = readonly [number, number, number];
interface Tri {
  readonly a: readonly [number, number, number];
  readonly b: readonly [number, number, number];
  readonly c: readonly [number, number, number];
}

const dot = (a: readonly number[], b: readonly number[]): number =>
  (a[0] ?? 0) * (b[0] ?? 0) + (a[1] ?? 0) * (b[1] ?? 0) + (a[2] ?? 0) * (b[2] ?? 0);

function normalize(v: readonly number[]): [number, number, number] {
  const len = Math.hypot(v[0] ?? 0, v[1] ?? 0, v[2] ?? 0) || 1;
  return [(v[0] ?? 0) / len, (v[1] ?? 0) / len, (v[2] ?? 0) / len];
}

const cross = (a: readonly number[], b: readonly number[]): [number, number, number] => [
  (a[1] ?? 0) * (b[2] ?? 0) - (a[2] ?? 0) * (b[1] ?? 0),
  (a[2] ?? 0) * (b[0] ?? 0) - (a[0] ?? 0) * (b[2] ?? 0),
  (a[0] ?? 0) * (b[1] ?? 0) - (a[1] ?? 0) * (b[0] ?? 0),
];

type Vec3 = readonly [number, number, number];

/**
 * The twelve triangles of a box, from its eight corners.
 *
 * A fixed-length tuple rather than an array, which is the whole reason this is
 * one function with two callers: under `noUncheckedIndexedAccess` an array index
 * is `Vec3 | undefined` and every face would need a fallback vertex -- which is
 * a silently wrong triangle standing in for an index that cannot be out of
 * range. The corners are named, so nothing is indexed at all.
 *
 * Winding is `near, far, left, right, top, bottom` over the same lattice both
 * callers build: 0-3 the near face counter-clockwise, 4-7 the far one.
 */
type BoxCorners = readonly [Vec3, Vec3, Vec3, Vec3, Vec3, Vec3, Vec3, Vec3];

function hullTris(v: BoxCorners): Tri[] {
  const quad = (a: Vec3, b: Vec3, c: Vec3, d: Vec3): Tri[] => [
    { a, b, c },
    { a, b: c, c: d },
  ];
  return [
    ...quad(v[0], v[1], v[2], v[3]), ...quad(v[5], v[4], v[7], v[6]),
    ...quad(v[4], v[0], v[3], v[7]), ...quad(v[1], v[5], v[6], v[2]),
    ...quad(v[3], v[2], v[6], v[7]), ...quad(v[4], v[5], v[1], v[0]),
  ];
}

/** The twelve triangles of an axis-aligned box, from its centre and half-extents. */
function boxTris(centreAt: Vec3, half: Vec3): Tri[] {
  const [cx, cy, cz] = centreAt;
  const [hx, hy, hz] = half;
  return hullTris([
    [cx - hx, cy - hy, cz - hz], [cx + hx, cy - hy, cz - hz],
    [cx + hx, cy + hy, cz - hz], [cx - hx, cy + hy, cz - hz],
    [cx - hx, cy - hy, cz + hz], [cx + hx, cy - hy, cz + hz],
    [cx + hx, cy + hy, cz + hz], [cx - hx, cy + hy, cz + hz],
  ]);
}

/** A body, as a block standing on the ground: a footprint and a height. */
function block(feet: Vec3, radius: number, height: number): Tri[] {
  return boxTris([feet[0], feet[1] + height / 2, feet[2]], [radius, height / 2, radius]);
}

/** One of the sight's pixels, as a small cube on the line. */
function cube(at: Vec3, side: number): Tri[] {
  return boxTris(at, [side / 2, side / 2, side / 2]);
}

/**
 * The shaft: a box of square section laid along `from -> to`.
 *
 * Built by rotating the box's corners rather than by an axis-aligned box at the
 * midpoint, because the beam slopes and a lance drawn axis-aligned would be a
 * staircase. The frame is the segment plus world up, which is what
 * `layBeamBox`'s quaternion comes to for any direction that is not vertical --
 * and this one never is.
 */
function beamBox(from: Vec3, to: Vec3, thickness: number): Tri[] {
  const ax = to[0] - from[0];
  const ay = to[1] - from[1];
  const az = to[2] - from[2];
  const length = Math.hypot(ax, ay, az) || 1;
  const f: Vec3 = [ax / length, ay / length, az / length];
  const right = normalize(cross(f, [0, 1, 0]));
  const upv = normalize(cross(right, f));
  const h = thickness / 2;
  const corner = (along: number, u: number, w: number): Vec3 => [
    from[0] + f[0] * along + right[0] * u + upv[0] * w,
    from[1] + f[1] * along + right[1] * u + upv[1] * w,
    from[2] + f[2] * along + right[2] * u + upv[2] * w,
  ];
  return hullTris([
    corner(0, -h, -h), corner(length, -h, -h), corner(length, h, -h), corner(0, h, -h),
    corner(0, -h, h), corner(length, -h, h), corner(length, h, h), corner(0, h, h),
  ]);
}

const map = loadMap(loadMapFile().doc);
const rawHeight: HeightAt = (x, z) => map.world.heightAt(x, z);

/** Ground triangles near the window, as `terrain-mesh.ts` winds them. */
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
        if (Math.abs(c00[0] - cx) > half + 80 || Math.abs(c00[2] - cz) > half + 80) continue;
        tris.push(
          { a: c00, b: corner(i, j + 1), c: corner(i + 1, j + 1) },
          { a: c00, b: corner(i + 1, j + 1), c: corner(i + 1, j) },
        );
      }
    }
  }
  return tris;
}

const forward = normalize(VIEW);
const right = normalize(cross(forward, [0, 1, 0]));
const up = normalize(cross(right, forward));
const light = normalize(LIGHT);

interface Cell {
  readonly rgb: Float64Array;
  readonly depth: Float64Array;
  /** Which pixels a translucent pass touched, for the cover measurement. */
  readonly painted: Uint8Array;
}

function newCell(): Cell {
  const rgb = new Float64Array(CELL * CELL * 3);
  for (let i = 0; i < CELL * CELL; i++) {
    rgb[i * 3] = SHEET_BG[0];
    rgb[i * 3 + 1] = SHEET_BG[1];
    rgb[i * 3 + 2] = SHEET_BG[2];
  }
  return {
    rgb,
    depth: new Float64Array(CELL * CELL).fill(Infinity),
    painted: new Uint8Array(CELL * CELL),
  };
}

/** One point light, as the frame throws it. */
interface Lamp {
  readonly at: Vec3;
  readonly color: RGB;
  /** three's `intensity`, i.e. `pointIntensity(brightness, radius)`. */
  readonly intensity: number;
  /** three's `distance`: the cutoff its window is built on. */
  readonly distance: number;
}

/**
 * The lights lit for the shot being drawn.
 *
 * Module state rather than an argument, because `draw` is called once per layer
 * of a shot and every layer is lit by the same thing. Set by `render` and read
 * only for opaque geometry -- the beam's own boxes are emissive and are not
 * shaded at all.
 */
let lamps: readonly Lamp[] = [];

const saturate = (x: number): number => Math.min(1, Math.max(0, x));

/**
 * three's own point-light falloff, transcribed.
 *
 * The physical branch of `getDistanceAttenuation` -- `LEGACY_LIGHTS` is off in
 * this renderer -- borrowed verbatim from `preview-fixtures.ts`, for its stated
 * reason: a falloff written from memory is a preview that flatters or punishes
 * `BEAM_GLOW_BRIGHTNESS` by an amount nobody could measure.
 */
function attenuation(distance: number, cutoff: number): number {
  let falloff = 1 / Math.max(distance * distance, 0.01);
  if (cutoff > 0) {
    const w = saturate(1 - Math.pow(distance / cutoff, 4));
    falloff *= w * w;
  }
  return falloff;
}

function draw(
  cell: Cell,
  tris: readonly Tri[],
  color: RGB,
  alpha: number,
  centre: readonly [number, number, number],
  mark = false,
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
    const normal = normalize(
      cross(
        [t.b[0] - t.a[0], t.b[1] - t.a[1], t.b[2] - t.a[2]],
        [t.c[0] - t.a[0], t.c[1] - t.a[1], t.c[2] - t.a[2]],
      ),
    );
    if (alpha >= 1 && dot(normal, forward) > 0) continue;
    const lambert = AMBIENT + (1 - AMBIENT) * Math.max(0, Math.abs(dot(normal, light)));
    // Per triangle, sampled at the centroid, which is what makes this a
    // *flat*-shaded renderer -- and is why the ground is a grid fine enough for
    // a pool of light to have a shape on it.
    const centroid: Vec3 = [
      (t.a[0] + t.b[0] + t.c[0]) / 3,
      (t.a[1] + t.b[1] + t.c[1]) / 3,
      (t.a[2] + t.b[2] + t.c[2]) / 3,
    ];
    const glow = [0, 0, 0];
    for (const lamp of lamps) {
      const dx = lamp.at[0] - centroid[0];
      const dy = lamp.at[1] - centroid[1];
      const dz = lamp.at[2] - centroid[2];
      const distance = Math.hypot(dx, dy, dz);
      if (distance <= 0) continue;
      // The grazing term, which is the one `preview-fixtures.ts` exists to
      // print: the ground is not facing the light, so what lands on it is the
      // authored brightness scaled by `height / hypot(height, d)`.
      const facing = Math.max(0, dot(normal, [dx / distance, dy / distance, dz / distance]));
      if (facing <= 0) continue;
      const irradiance = lamp.intensity * attenuation(distance, lamp.distance) * facing;
      for (let k = 0; k < 3; k++) glow[k] = (glow[k] ?? 0) + (lamp.color[k] ?? 0) * irradiance;
    }
    const shade: RGB =
      alpha >= 1
        ? [
            color[0] * (lambert + (glow[0] ?? 0)),
            color[1] * (lambert + (glow[1] ?? 0)),
            color[2] * (lambert + (glow[2] ?? 0)),
          ]
        : color;

    const px = (u: number): number => ((u - midU) / (2 * HALF) + 0.5) * CELL;
    const py = (v: number): number => (0.5 - (v - midV) / (2 * HALF)) * CELL;
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
        if (mark) cell.painted[d] = 1;
        for (let k = 0; k < 3; k++) {
          const was = cell.rgb[d * 3 + k] ?? 0;
          cell.rgb[d * 3 + k] = was * (1 - alpha) + (shade[k] ?? 0) * alpha;
        }
      }
    }
  }
}

// --- the scene ------------------------------------------------------------

/** Flat-ish ground with some relief in it, found rather than typed. */
function findGround(): { x: number; z: number } {
  const bounds = map.doc.layers[0]?.bounds;
  if (!bounds) throw new Error('the shipped map has no layers');
  let best = { x: 0, z: 0, score: Infinity };
  for (let x = bounds.minX + 400; x < bounds.maxX - 400; x += 60) {
    for (let z = bounds.minZ + 400; z < bounds.maxZ - 400; z += 60) {
      let lo = Infinity;
      let hi = -Infinity;
      for (let a = 0; a < 8; a++) {
        const angle = (a / 8) * Math.PI * 2;
        const h = rawHeight(x + Math.cos(angle) * 200, z + Math.sin(angle) * 200);
        lo = Math.min(lo, h);
        hi = Math.max(hi, h);
      }
      // Some fall, but not a cliff: the beam has to be readable over ground a
      // fight actually happens on.
      const fall = hi - lo;
      const score = Math.abs(fall - 26);
      if (score < best.score) best = { x, z, score };
    }
  }
  return { x: best.x, z: best.z };
}

const MECH_AT = findGround();
const HEADING = 0.6;
const dirX = Math.cos(HEADING);
const dirZ = Math.sin(HEADING);
const midpoint = WARDEN_LASER.range * 0.46;
const centre: [number, number, number] = [
  MECH_AT.x + dirX * midpoint,
  rawHeight(MECH_AT.x + dirX * midpoint, MECH_AT.z + dirZ * midpoint),
  MECH_AT.z + dirZ * midpoint,
];

const LOCK_ON: BeamCast = {
  abilityId: WARDEN_LASER.abilityId,
  phase: CastPhase.Windup,
  startTick: 0,
  releaseTick: WARDEN_LASER.lockOnTicks,
};
const FIRING: BeamCast = { ...LOCK_ON, phase: CastPhase.Channel };

/**
 * How high the head's opening sits over the mech's feet.
 *
 * `rigs.ts`'s `BODY_Y` (40) times the Warden look's own `sizeScale` (1.1), which
 * is where `MechRig` puts the eye -- and the eye *is* the opening, since spec 262
 * made `buildBody` hand it back. Stated here rather than imported because the rig
 * module is three.js and this script rasterises in software; nothing checks the
 * two agree, so it is a number to re-derive if either moves, and what it costs if
 * it drifts is a preview whose beam leaves the block a few units off.
 */
const MUZZLE_HEIGHT = 44;

/** Bodies: the machine, somebody standing in the beam, somebody beside it. */
const BODIES: readonly {
  at: readonly [number, number];
  radius: number;
  height: number;
  color: RGB;
}[] = [
  { at: [0, 0], radius: 30, height: MUZZLE_HEIGHT + 12, color: MECH },
  // Down the middle at half reach: the readability question in one body.
  { at: [WARDEN_LASER.range * 0.5, 0], radius: 16, height: 34, color: BODY },
  // Clear of the lane by a body's width, which is what escaping looks like.
  { at: [WARDEN_LASER.range * 0.34, WARDEN_LASER.width * 0.5 + 34], radius: 16, height: 34, color: BODY },
];


interface Shot {
  readonly label: string;
  readonly cast: BeamCast;
  readonly tick: number;
}

/**
 * The bodies, drawn last.
 *
 * So a player standing in the beam is drawn over it where the beam is on the
 * ground and behind it where the beam is in the air -- which is the whole
 * readability question, and is why they are blocks rather than discs.
 */
function drawBodies(cell: Cell): void {
  for (const body of BODIES) {
    const x = MECH_AT.x + dirX * (body.at[0] ?? 0) - dirZ * (body.at[1] ?? 0);
    const z = MECH_AT.z + dirZ * (body.at[0] ?? 0) + dirX * (body.at[1] ?? 0);
    const base = rawHeight(x, z);
    draw(cell, block([x, base, z], body.radius, body.height), body.color, 1, centre);
  }
}

/**
 * The lights a firing beam hangs along itself, as the frame throws them.
 *
 * The same three the scene asks the pool for -- `beamGlowAt` for where and
 * `beamGlowBrightness` for how much -- through `pointIntensity`, which is the
 * conversion three's `intensity` field wants. Reproducing the arithmetic here
 * rather than importing the scene's, because that half is three.js and this
 * script rasterises in software; what is shared is the two pure functions the
 * numbers actually come from.
 */
function beamLamps(look: ShaftLook, tick: number): Lamp[] {
  const out: Lamp[] = [];
  for (let i = 0; i < BEAM_GLOW_LIGHTS; i++) {
    const along = beamGlowAt(look, i);
    const x = MECH_AT.x + dirX * along;
    const z = MECH_AT.z + dirZ * along;
    out.push({
      at: [x, rawHeight(x, z) + BEAM_GLOW_HEIGHT, z],
      color: LANCE,
      intensity: pointIntensity(beamGlowBrightness(i, tick), BEAM_GLOW_RADIUS),
      distance: BEAM_GLOW_RADIUS,
    });
  }
  return out;
}

/** The frame with nothing happening in it, rendered once: what a lift is against. */
const BARE = ((): Float64Array => {
  lamps = [];
  const cell = newCell();
  draw(cell, terrainTriangles(centre[0], centre[2], HALF), GRASS, 1, centre);
  drawBodies(cell);
  return Float64Array.from(cell.rgb);
})();

interface Shot0 {
  readonly cell: Cell;
  /** Fraction of the frame the beam's own geometry paints. */
  readonly cover: number;
  /** How far it moves the ground's colour where it paints, in retro bands. */
  readonly lift: readonly number[];
  /** Fraction of the frame its *light* moves by half a band or more. */
  readonly glowArea: number;
  /** How far it moves it there, in retro bands, averaged over those pixels. */
  readonly glowLift: number;
}

function render(shot: Shot): Shot0 {
  const look = beamLookFor('warden', shot.cast, shot.tick);
  // Set before anything is drawn, because the ground is what the light lands on
  // and it is the first thing rasterised.
  lamps = look?.kind === 'firing' ? beamLamps(look, shot.tick) : [];

  const cell = newCell();
  draw(cell, terrainTriangles(centre[0], centre[2], HALF), GRASS, 1, centre);

  if (look) {
    // The line: out of the head's opening, down to just off the ground at the
    // far end. The origin's height is `MechRig`'s in the game and a constant
    // here, because this harness draws blocks rather than rigs -- and what is
    // being judged is the line, which is the same line either way.
    const from: Vec3 = [MECH_AT.x, rawHeight(MECH_AT.x, MECH_AT.z) + MUZZLE_HEIGHT, MECH_AT.z];
    const endX = MECH_AT.x + dirX * look.length;
    const endZ = MECH_AT.z + dirZ * look.length;
    const to: Vec3 = [endX, rawHeight(endX, endZ) + look.endLift, endZ];

    if (look.kind === 'firing') {
      draw(cell, beamBox(from, to, look.width), LANCE, look.opacity, centre, true);
      draw(cell, beamBox(from, to, look.coreWidth), LANCE_CORE, look.coreOpacity, centre, true);
    } else {
      const dots = sightDotCount(look);
      for (let i = 0; i < dots; i++) {
        const along = sightDotAt(look, i) / look.length;
        const at: Vec3 = [
          from[0] + (to[0] - from[0]) * along,
          from[1] + (to[1] - from[1]) * along,
          from[2] + (to[2] - from[2]) * along,
        ];
        // A cube about `pixel` cells across, which is what a
        // `sizeAttenuation: false` point comes out as at this framing. Doubled
        // because a cube is drawn *cornerwise* at this camera and the projected
        // width of one `pixel` on a side is well under a raster cell, so an
        // undoubled dot is rounded away by the very sampler this sheet is meant
        // to be judging the line through. Not the same thing the game draws --
        // that one is the same size at every distance and this one is not -- and
        // near enough for the question the sheet asks, which is whether a dotted
        // line reads as a sight.
        draw(cell, cube(at, (look.pixel * 2 * HALF) / CELL), LANCE_SIGHT, look.opacity, centre, true);
      }
    }
  }

  drawBodies(cell);
  lamps = [];

  const band = 1 / RETRO_LEVELS;
  let painted = 0;
  const sum = [0, 0, 0];
  const was = [0, 0, 0];
  // The light is measured everywhere the beam does *not* paint, which is the
  // whole of what replaced the ground decal: the same instrument would report a
  // hard band and a lit pool identically if it only looked where the beam is.
  let glowPixels = 0;
  let glowSum = 0;
  for (let i = 0; i < CELL * CELL; i++) {
    let moved = 0;
    for (let k = 0; k < 3; k++) {
      moved = Math.max(moved, Math.abs((cell.rgb[i * 3 + k] ?? 0) - (BARE[i * 3 + k] ?? 0)));
    }
    if (cell.painted[i] === 1) {
      painted++;
      for (let k = 0; k < 3; k++) {
        sum[k] = (sum[k] ?? 0) + (cell.rgb[i * 3 + k] ?? 0);
        was[k] = (was[k] ?? 0) + (BARE[i * 3 + k] ?? 0);
      }
      continue;
    }
    // Half a band is this file's own threshold for a mark that survives the
    // quantize at all -- below it the retro pass rounds the change away and the
    // ground is not lit, it merely differs in a float nobody can see.
    if (moved < band / 2) continue;
    glowPixels++;
    glowSum += moved / band;
  }
  const lift = [0, 1, 2].map((k) =>
    painted === 0 ? 0 : Math.abs((sum[k] ?? 0) - (was[k] ?? 0)) / painted / band,
  );
  return {
    cell,
    cover: painted / (CELL * CELL),
    lift,
    glowArea: glowPixels / (CELL * CELL),
    glowLift: glowPixels === 0 ? 0 : glowSum / glowPixels,
  };
}

const encode = (linear: number): number => {
  const c = linear <= 0 ? 0 : linear >= 1 ? 1 : linear;
  return 255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
};

const shots: readonly Shot[] = [
  { label: 'lock-on, just started', cast: LOCK_ON, tick: 0 },
  { label: 'lock-on, half way', cast: LOCK_ON, tick: Math.round(WARDEN_LASER.lockOnTicks / 2) },
  { label: 'lock-on, committing', cast: LOCK_ON, tick: WARDEN_LASER.lockOnTicks },
  { label: 'firing, shimmer low', cast: FIRING, tick: 5 },
  { label: 'firing, shimmer high', cast: FIRING, tick: 2 },
  { label: 'nothing (the control)', cast: { ...LOCK_ON, abilityId: 'melee.slash' }, tick: 0 },
];

const cells = shots.map((shot) => ({ shot, ...render(shot) }));

const cols = 3;
const rows = Math.ceil(cells.length / cols);
const width = cols * CELL + (cols + 1) * GAP;
const height = rows * (CELL + LABEL_H) + (rows + 1) * GAP;
const png = new PNG({ width, height });
for (let i = 0; i < width * height; i++) {
  png.data[i * 4] = 12;
  png.data[i * 4 + 1] = 12;
  png.data[i * 4 + 2] = 14;
  png.data[i * 4 + 3] = 255;
}
cells.forEach((entry, index) => {
  const col = index % cols;
  const row = Math.floor(index / cols);
  const ox = GAP + col * (CELL + GAP);
  const oy = GAP + row * (CELL + LABEL_H + GAP) + LABEL_H;
  for (let y = 0; y < CELL; y++) {
    for (let x = 0; x < CELL; x++) {
      const from = (y * CELL + x) * 3;
      const to = ((oy + y) * width + ox + x) * 4;
      png.data[to] = encode(entry.cell.rgb[from] ?? 0);
      png.data[to + 1] = encode(entry.cell.rgb[from + 1] ?? 0);
      png.data[to + 2] = encode(entry.cell.rgb[from + 2] ?? 0);
      png.data[to + 3] = 255;
    }
  }
});

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'warden-lance.png'), PNG.sync.write(png));

const sight = beamLookFor('warden', LOCK_ON, 0) as SightLook;
console.log(`the lance over ${MECH_AT.x.toFixed(0)},${MECH_AT.z.toFixed(0)}, heading ${HEADING}`);
console.log(
  `beam ${WARDEN_LASER.range} long, lane ${WARDEN_LASER.width} wide, ` +
    `shaft ${(WARDEN_LASER.width * SHAFT_FRACTION).toFixed(0)}; ` +
    `the sight is ${sightDotCount(sight)} pixels ${SIGHT_SPACING} apart\n`,
);
console.log(
  '  phase                     cover   lift (r/g/b, bands)      lit    by (bands)',
);
for (const entry of cells) {
  console.log(
    `  ${entry.shot.label.padEnd(24)} ${(entry.cover * 100).toFixed(2).padStart(5)}%   ` +
      `${entry.lift.map((v) => v.toFixed(2)).join(' / ').padEnd(22)}  ` +
      `${(entry.glowArea * 100).toFixed(2).padStart(5)}%  ${entry.glowLift.toFixed(2)}`,
  );
}
console.log(`\nwrote ${join(outDir, 'warden-lance.png')}`);
