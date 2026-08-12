/**
 * Emission volumes (spec 118).
 *
 * One function, writing six floats: a spawn offset and a unit direction. Both
 * come from the shape together because for every shape worth having they are the
 * same draw -- a point on a sphere *is* its outward direction, and computing them
 * separately would need the position back to derive it.
 *
 * Written into a caller-supplied array rather than returned, because this runs
 * once per particle spawned and a returned object is a per-particle allocation,
 * which is the one thing this system may not do.
 */

import type { VfxRng } from './rng.js';

/** Shape kinds as integers, so the hot path switches on a number. */
export const SHAPE = {
  point: 0,
  sphere: 1,
  hemisphere: 2,
  cone: 3,
  box: 4,
  circle: 5,
  mesh: 6,
  arc: 7,
} as const;

export type ShapeKind = (typeof SHAPE)[keyof typeof SHAPE];

/**
 * A compiled shape: kind, then up to four packed parameters.
 *
 * | kind       | a          | b       | c     |
 * |------------|------------|---------|-------|
 * | sphere     | radius     | shell   |       |
 * | hemisphere | radius     | shell   |       |
 * | cone       | angle      | radius  |       |
 * | box        | halfX      | halfY   | halfZ |
 * | circle     | radius     | shell   |       |
 * | arc        | radius     | sweep   |       |
 */
export interface CompiledShape {
  readonly kind: ShapeKind;
  readonly a: number;
  readonly b: number;
  readonly c: number;
}

/**
 * A point in a unit sphere, written as a direction at `out[at]`.
 *
 * Rejection sampling rather than the trigonometric form: three draws and a
 * length test beats two draws plus a `sin`, `cos`, `acos` and a `sqrt` on every
 * modern engine, and it is uniform by construction rather than by an identity
 * that is easy to get subtly wrong.
 */
function unitVector(rng: VfxRng, out: Float32Array, at: number): void {
  for (let tries = 0; tries < 8; tries++) {
    const x = rng.signed(1);
    const y = rng.signed(1);
    const z = rng.signed(1);
    const lengthSq = x * x + y * y + z * z;
    if (lengthSq > 1e-6 && lengthSq <= 1) {
      const inv = 1 / Math.sqrt(lengthSq);
      out[at] = x * inv;
      out[at + 1] = y * inv;
      out[at + 2] = z * inv;
      return;
    }
  }
  // Vanishingly unlikely, and a bounded loop is worth more than the last
  // fraction of a percent of uniformity: straight up is a defensible fallback.
  out[at] = 0;
  out[at + 1] = 1;
  out[at + 2] = 0;
}

/**
 * Sample a shape.
 *
 * Writes position at `out[at]` (3 floats) and unit direction at `out[at + 3]`
 * (3 floats), both in the emitter's local frame. `index` and `total` are the
 * particle's place in its burst, which only `arc` reads -- a slash lays its
 * particles along the sweep in order, because a swing whose particles arrive in
 * a random order along the arc reads as a puff rather than as a cut.
 */
export function sampleShape(
  shape: CompiledShape,
  rng: VfxRng,
  out: Float32Array,
  at: number,
  index: number,
  total: number,
): void {
  const dirAt = at + 3;
  switch (shape.kind) {
    case SHAPE.sphere:
    case SHAPE.hemisphere: {
      unitVector(rng, out, dirAt);
      if (shape.kind === SHAPE.hemisphere) {
        out[dirAt + 1] = Math.abs(out[dirAt + 1] ?? 0);
      }
      // `shell` puts every particle on the surface; otherwise the radius is
      // cube-rooted so the interior fills evenly instead of clumping at the core.
      const t = shape.b > 0.5 ? 1 : Math.cbrt(rng.float());
      const r = shape.a * t;
      out[at] = (out[dirAt] ?? 0) * r;
      out[at + 1] = (out[dirAt + 1] ?? 0) * r;
      out[at + 2] = (out[dirAt + 2] ?? 0) * r;
      return;
    }

    case SHAPE.cone: {
      // Uniform inside the cap of half-angle `a`, about +Y.
      const cosMax = Math.cos(shape.a);
      const cosTheta = 1 - rng.float() * (1 - cosMax);
      const sinTheta = Math.sqrt(Math.max(0, 1 - cosTheta * cosTheta));
      const phi = rng.float() * Math.PI * 2;
      out[dirAt] = Math.cos(phi) * sinTheta;
      out[dirAt + 1] = cosTheta;
      out[dirAt + 2] = Math.sin(phi) * sinTheta;
      const r = shape.b * Math.sqrt(rng.float());
      const spawnPhi = rng.float() * Math.PI * 2;
      out[at] = Math.cos(spawnPhi) * r;
      out[at + 1] = 0;
      out[at + 2] = Math.sin(spawnPhi) * r;
      return;
    }

    case SHAPE.box: {
      out[at] = rng.signed(shape.a);
      out[at + 1] = rng.signed(shape.b);
      out[at + 2] = rng.signed(shape.c);
      unitVector(rng, out, dirAt);
      return;
    }

    case SHAPE.circle: {
      const phi = rng.float() * Math.PI * 2;
      const r = shape.a * (shape.b > 0.5 ? 1 : Math.sqrt(rng.float()));
      const cx = Math.cos(phi);
      const cz = Math.sin(phi);
      out[at] = cx * r;
      out[at + 1] = 0;
      out[at + 2] = cz * r;
      out[dirAt] = cx;
      out[dirAt + 1] = 0;
      out[dirAt + 2] = cz;
      return;
    }

    case SHAPE.arc: {
      // In emission order along the sweep, centred on local +X, with a little
      // jitter so the cut is a stroke rather than a row of beads.
      const span = total > 1 ? index / (total - 1) : 0.5;
      const angle = (span - 0.5) * shape.b + rng.signed(shape.b * 0.02);
      const r = shape.a * (0.85 + rng.float() * 0.15);
      const cx = Math.cos(angle);
      const cz = Math.sin(angle);
      out[at] = cx * r;
      out[at + 1] = 0;
      out[at + 2] = cz * r;
      // Tangent, not radial: a slash throws along the direction the edge travels.
      out[dirAt] = -cz;
      out[dirAt + 1] = 0;
      out[dirAt + 2] = cx;
      return;
    }

    case SHAPE.mesh:
    case SHAPE.point:
    default: {
      out[at] = 0;
      out[at + 1] = 0;
      out[at + 2] = 0;
      unitVector(rng, out, dirAt);
      return;
    }
  }
}

/**
 * Rotate a direction away from itself by up to `spread` radians, in place.
 *
 * Applied after the shape, so an emitter can say "outward from a sphere, but
 * loosely" without needing a second shape kind for every combination. Builds its
 * basis from whichever axis the direction is least aligned with, which is the
 * standard way to avoid the degenerate case where the helper axis is the
 * direction itself.
 */
export function applySpread(rng: VfxRng, out: Float32Array, dirAt: number, spread: number): void {
  if (spread <= 0) return;
  const dx = out[dirAt] ?? 0;
  const dy = out[dirAt + 1] ?? 0;
  const dz = out[dirAt + 2] ?? 0;

  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  const az = Math.abs(dz);
  let hx = 0;
  let hy = 0;
  let hz = 0;
  if (ax <= ay && ax <= az) hx = 1;
  else if (ay <= az) hy = 1;
  else hz = 1;

  // u = normalize(d x h), v = d x u
  let ux = dy * hz - dz * hy;
  let uy = dz * hx - dx * hz;
  let uz = dx * hy - dy * hx;
  const ulen = Math.sqrt(ux * ux + uy * uy + uz * uz);
  if (ulen < 1e-6) return;
  ux /= ulen;
  uy /= ulen;
  uz /= ulen;
  const vx = dy * uz - dz * uy;
  const vy = dz * ux - dx * uz;
  const vz = dx * uy - dy * ux;

  const cosMax = Math.cos(spread);
  const cosTheta = 1 - rng.float() * (1 - cosMax);
  const sinTheta = Math.sqrt(Math.max(0, 1 - cosTheta * cosTheta));
  const phi = rng.float() * Math.PI * 2;
  const cp = Math.cos(phi) * sinTheta;
  const sp = Math.sin(phi) * sinTheta;

  out[dirAt] = dx * cosTheta + ux * cp + vx * sp;
  out[dirAt + 1] = dy * cosTheta + uy * cp + vy * sp;
  out[dirAt + 2] = dz * cosTheta + uz * cp + vz * sp;
}
