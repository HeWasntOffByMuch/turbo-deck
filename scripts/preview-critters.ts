// Dev-only: render the critter species (spec 049) to a PNG contact sheet so a
// human -- or an agent with no screen -- can check the models actually read.
// Not part of the app. `tsx scripts/preview-critters.ts`
//
// This is a tiny software ray caster over the *species data*, not a three.js
// render: it intersects the same boxes, ellipsoids and cones the rig builds, at
// the same isometric camera angle the scene uses, in their bind pose. That makes
// it a check on the model -- proportions, silhouette, colour contrast at size --
// and not on the renderer, which is what the vitest suite covers.
//
// Each species is drawn at 256 px (to judge the shapes) and at 64 px upscaled
// (to judge what actually survives in game), across several player coats.
import { writeFileSync, mkdirSync } from 'node:fs';
import { PNG } from 'pngjs';
import { CRITTER_IDS, CRITTERS } from '../src/render/critters/index.js';
import { deriveCoat, PLAYER_COATS } from '../src/render/critters/palette.js';
import { boneOrigins, resolveParts, socketOrigins, type ResolvedPart } from '../src/render/critters/resolve.js';
import type { CoatColors, CritterSpecies } from '../src/render/critters/types.js';

const BIG = 256;
const SMALL = 64;
const SMALL_SCALE = 3;
const GAP = 8;
const BG: readonly [number, number, number] = [58, 60, 68];

// --- Maths ----------------------------------------------------------------

type Vec3 = [number, number, number];

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function norm(a: Vec3): Vec3 {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}
function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/** A 3x3 rotation, row-major. */
type Mat3 = [Vec3, Vec3, Vec3];

const IDENTITY: Mat3 = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

/** XYZ-order Euler to a 3x3 row-major matrix, matching three.js. */
function eulerMatrix(r: readonly [number, number, number]): Mat3 {
  const [cx, sx] = [Math.cos(r[0]), Math.sin(r[0])];
  const [cy, sy] = [Math.cos(r[1]), Math.sin(r[1])];
  const [cz, sz] = [Math.cos(r[2]), Math.sin(r[2])];
  return [
    [cy * cz, -cy * sz, sy],
    [sx * sy * cz + cx * sz, -sx * sy * sz + cx * cz, -sx * cy],
    [-cx * sy * cz + sx * sz, cx * sy * sz + sx * cz, cx * cy],
  ];
}

/** `m^T * v`: world -> local, for an orthonormal `m`. */
function applyT(m: Mat3, v: Vec3): Vec3 {
  return [
    m[0][0] * v[0] + m[1][0] * v[1] + m[2][0] * v[2],
    m[0][1] * v[0] + m[1][1] * v[1] + m[2][1] * v[2],
    m[0][2] * v[0] + m[1][2] * v[1] + m[2][2] * v[2],
  ];
}

/** `m * v`: local -> world. */
function apply(m: Mat3, v: Vec3): Vec3 {
  return [dot(m[0], v), dot(m[1], v), dot(m[2], v)];
}

/** `a * b`. */
function matMul(a: Mat3, b: Mat3): Mat3 {
  const row = (i: 0 | 1 | 2): Vec3 => [
    a[i][0] * b[0][0] + a[i][1] * b[1][0] + a[i][2] * b[2][0],
    a[i][0] * b[0][1] + a[i][1] * b[1][1] + a[i][2] * b[2][1],
    a[i][0] * b[0][2] + a[i][1] * b[1][2] + a[i][2] * b[2][2],
  ];
  return [row(0), row(1), row(2)];
}

// --- Primitives -----------------------------------------------------------

interface Hit {
  t: number;
  n: Vec3;
}

/** Ray vs axis-aligned box centred at the origin with half-extents `h`. */
function hitBox(o: Vec3, d: Vec3, h: Vec3): Hit | null {
  let tmin = -Infinity;
  let tmax = Infinity;
  let axis = 0;
  let sign = 1;
  for (let i = 0; i < 3; i++) {
    const oi = o[i] as number;
    const di = d[i] as number;
    const hi = h[i] as number;
    if (Math.abs(di) < 1e-9) {
      if (Math.abs(oi) > hi) return null;
      continue;
    }
    let t1 = (-hi - oi) / di;
    let t2 = (hi - oi) / di;
    let s = -1;
    if (t1 > t2) {
      [t1, t2] = [t2, t1];
      s = 1;
    }
    if (t1 > tmin) {
      tmin = t1;
      axis = i;
      sign = s;
    }
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return null;
  }
  if (tmin < 0) return null;
  const n: Vec3 = [0, 0, 0];
  n[axis] = sign;
  return { t: tmin, n };
}

/** Ray vs axis-aligned ellipsoid centred at the origin with radii `r`. */
function hitEllipsoid(o: Vec3, d: Vec3, r: Vec3): Hit | null {
  const oz: Vec3 = [o[0] / r[0], o[1] / r[1], o[2] / r[2]];
  const dz: Vec3 = [d[0] / r[0], d[1] / r[1], d[2] / r[2]];
  const a = dot(dz, dz);
  const b = 2 * dot(oz, dz);
  const c = dot(oz, oz) - 1;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  const t = (-b - Math.sqrt(disc)) / (2 * a);
  if (t < 0) return null;
  const p: Vec3 = [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t];
  return { t, n: norm([p[0] / (r[0] * r[0]), p[1] / (r[1] * r[1]), p[2] / (r[2] * r[2])]) };
}

/**
 * Ray vs a truncated elliptical cone about +y: radius scales from 1 at y = -hy
 * to `taper` at y = +hy, with x/z radii `rx`/`rz` at the base. Solved by
 * marching, which is plenty for a preview and far less code than the closed form.
 */
function hitCone(o: Vec3, d: Vec3, rx: number, hy: number, rz: number, taper: number): Hit | null {
  const inside = (p: Vec3): boolean => {
    if (Math.abs(p[1]) > hy) return false;
    const k = (p[1] + hy) / (2 * hy);
    const s = 1 + (taper - 1) * k;
    if (s <= 1e-4) return false;
    const u = p[0] / (rx * s);
    const v = p[2] / (rz * s);
    return u * u + v * v <= 1;
  };
  // Bound the march by the y slab, so it costs nothing when the ray misses.
  const rmax = Math.max(rx, rz) * Math.max(1, taper);
  const bound = hitBox(o, d, [rmax, hy, rmax]);
  if (!bound) return null;
  const step = Math.min(hy, rmax) / 24;
  let t = bound.t;
  const limit = bound.t + 2 * (hy + rmax) * 2;
  let prev: Vec3 | null = null;
  for (; t < limit; t += step) {
    const p: Vec3 = [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t];
    if (inside(p)) {
      // Refine to the surface, then take a cheap finite-difference normal.
      let lo = prev ? t - step : t;
      let hi = t;
      for (let i = 0; i < 12; i++) {
        const mid = (lo + hi) / 2;
        const q: Vec3 = [o[0] + d[0] * mid, o[1] + d[1] * mid, o[2] + d[2] * mid];
        if (inside(q)) hi = mid;
        else lo = mid;
      }
      const p2: Vec3 = [o[0] + d[0] * hi, o[1] + d[1] * hi, o[2] + d[2] * hi];
      const e = 0.05;
      const g = (ax: number): number => {
        const a: Vec3 = [...p2] as Vec3;
        const b: Vec3 = [...p2] as Vec3;
        a[ax] = (a[ax] as number) + e;
        b[ax] = (b[ax] as number) - e;
        return (inside(a) ? 0 : 1) - (inside(b) ? 0 : 1);
      };
      const n = norm([g(0), g(1), g(2)]);
      return { t: hi, n: Number.isFinite(n[0]) ? n : [0, 1, 0] };
    }
    prev = p;
  }
  return null;
}

// --- Scene ----------------------------------------------------------------

interface Solid {
  readonly centre: Vec3;
  readonly rot: Mat3;
  readonly half: Vec3;
  readonly shape: 'box' | 'ball' | 'cone';
  readonly taper: number;
  readonly color: number;
}

function buildSolids(species: CritterSpecies, colors: CoatColors): Solid[] {
  const bones = boneOrigins(species.metrics);
  const sockets = socketOrigins(species);
  // Socket rotations apply to whatever hangs off them, so fold them in.
  const rotOf = new Map<string, Mat3>();
  for (const s of species.sockets) {
    const r = s.rot ?? ([0, 0, 0] as const);
    rotOf.set(s.socket, eulerMatrix(r));
    if (s.mirror) rotOf.set(`${s.socket}R`, eulerMatrix([-r[0], -r[1], r[2]]));
  }

  const out: Solid[] = [];
  for (const part of resolveParts(species) as ResolvedPart[]) {
    const isSocket = typeof part.attach === 'string';
    const base = isSocket ? sockets.get(part.attach) : bones[part.attach as number];
    if (!base) throw new Error(`unresolved attachment for ${part.name}`);
    const parentRot = isSocket ? rotOf.get(part.attach as string) ?? IDENTITY : IDENTITY;
    const offset = apply(parentRot, [part.pos[0], part.pos[1], part.pos[2]]);
    out.push({
      centre: [base.x + offset[0], base.y + offset[1], base.z + offset[2]],
      rot: matMul(parentRot, eulerMatrix(part.rot)),
      half: [part.size[0] / 2, part.size[1] / 2, part.size[2] / 2],
      shape: part.shape,
      taper: part.taper ?? 0,
      color: colors[part.role],
    });
  }
  return out;
}

/** The scene's isometric view direction, and a light roughly where its sun is. */
const VIEW_DIR = norm([-1, -0.82, -1]);
const LIGHT = norm([0.45, 0.8, 0.38]);

function render(species: CritterSpecies, colors: CoatColors, size: number): Uint8ClampedArray {
  const solids = buildSolids(species, colors);
  const out = new Uint8ClampedArray(size * size * 4);

  // Frame the species on its own bind-pose extent, with a little air.
  let minY = Infinity;
  let maxY = -Infinity;
  let maxR = 0;
  for (const s of solids) {
    const r = Math.max(s.half[0], s.half[1], s.half[2]);
    minY = Math.min(minY, s.centre[1] - r);
    maxY = Math.max(maxY, s.centre[1] + r);
    maxR = Math.max(maxR, Math.hypot(s.centre[0], s.centre[2]) + r);
  }
  const centreY = (minY + maxY) / 2;
  const halfH = (maxY - minY) / 2 + 6;
  const halfW = Math.max(halfH, maxR + 4);

  const forward = VIEW_DIR;
  const right = norm(cross(forward, [0, 1, 0]));
  const up = cross(right, forward);
  const eye: Vec3 = [-forward[0] * 400, centreY - forward[1] * 400, -forward[2] * 400];

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const u = ((px + 0.5) / size - 0.5) * 2 * halfW;
      const v = -((py + 0.5) / size - 0.5) * 2 * halfH;
      const o: Vec3 = [
        eye[0] + right[0] * u + up[0] * v,
        eye[1] + right[1] * u + up[1] * v,
        eye[2] + right[2] * u + up[2] * v,
      ];
      let best: { t: number; n: Vec3; color: number } | null = null;
      for (const s of solids) {
        const ro = applyT(s.rot, sub(o, s.centre));
        const rd = applyT(s.rot, forward);
        const hit =
          s.shape === 'box'
            ? hitBox(ro, rd, s.half)
            : s.shape === 'ball'
              ? hitEllipsoid(ro, rd, s.half)
              : hitCone(ro, rd, s.half[0], s.half[1], s.half[2], s.taper);
        if (hit && (!best || hit.t < best.t)) {
          best = { t: hit.t, n: apply(s.rot, hit.n), color: s.color };
        }
      }
      const d = (py * size + px) * 4;
      if (!best) {
        out[d] = BG[0];
        out[d + 1] = BG[1];
        out[d + 2] = BG[2];
        out[d + 3] = 255;
        continue;
      }
      const lambert = 0.42 + 0.58 * Math.max(0, dot(best.n, LIGHT));
      out[d] = (((best.color >> 16) & 0xff) * lambert) | 0;
      out[d + 1] = (((best.color >> 8) & 0xff) * lambert) | 0;
      out[d + 2] = ((best.color & 0xff) * lambert) | 0;
      out[d + 3] = 255;
    }
  }
  return out;
}

// --- Sheet ----------------------------------------------------------------

const COATS = ['rose', 'sage', 'blue', 'cream', 'plum'];
const swatches = COATS.map((id) => PLAYER_COATS.find((c) => c.id === id)).filter(Boolean) as typeof PLAYER_COATS;

const cellW = BIG + GAP;
const rowH = BIG + GAP;
const sheetW = swatches.length * cellW + SMALL * SMALL_SCALE + GAP;
const sheetH = CRITTER_IDS.length * rowH;
const img = new PNG({ width: sheetW, height: sheetH, colorType: 6 });
for (let i = 0; i < img.data.length; i += 4) {
  img.data[i] = 30;
  img.data[i + 1] = 31;
  img.data[i + 2] = 36;
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

CRITTER_IDS.forEach((id, row) => {
  const species = CRITTERS[id];
  swatches.forEach((swatch, col) => {
    const colors = deriveCoat(species, swatch.hex);
    blit(render(species, colors, BIG), BIG, col * cellW, row * rowH);
  });
  // The rightmost cell is the same model at the size it actually ships at.
  const colors = deriveCoat(species, species.defaultCoat);
  blit(render(species, colors, SMALL), SMALL, swatches.length * cellW, row * rowH, SMALL_SCALE);
  process.stdout.write(`${species.name}: ${species.parts.length} parts declared\n`);
});

mkdirSync('.claude/screenshots', { recursive: true });
const path = '.claude/screenshots/critters.png';
writeFileSync(path, PNG.sync.write(img));
process.stdout.write(`wrote ${path} (${sheetW}x${sheetH})\n`);
