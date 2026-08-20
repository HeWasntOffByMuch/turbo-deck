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
  fan: 8,
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
 * | fan        | angle      | radius  | rise  | bearing |
 */
export interface CompiledShape {
  readonly kind: ShapeKind;
  readonly a: number;
  readonly b: number;
  readonly c: number;
  /** Only `fan` uses a fourth: which way the lobe points, in the local frame. */
  readonly d?: number;
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

    case SHAPE.fan: {
      // Thrown *along* the effect's own bearing (spec 158).
      //
      // Every other directional shape here is either about local +Y (`cone`) or
      // radial in the ground plane (`circle`), so "away from the attacker,
      // mostly, and a bit upward" could not be written down at all -- and that
      // is exactly the directional bias a spatter needs. Centred on local +X,
      // the axis `arc` already established as the one the effect's rotation
      // turns, and lifted by `c` so a flick arcs rather than skidding.
      //
      // The yaw is drawn as the *square* of a signed unit draw, which is what
      // makes the bias a bias: most marks land near the bearing and a few stray
      // wide, where a flat draw across the same angle gives a fan with as many
      // marks at its edges as down its middle.
      //
      // `bearing` (spec 159) turns the lobe within the effect's own frame, which
      // is what lets an explosion be *composed* out of several fans pointing
      // different ways with different counts and sizes -- clusters here, a gap
      // there -- instead of one uniform cone, which is a radial star however
      // much the individual marks differ.
      const bias = rng.signed(1);
      const yaw = (shape.d ?? 0) + bias * Math.abs(bias) * shape.a;
      const pitch = shape.c + rng.signed(shape.a * 0.35);
      const cosPitch = Math.cos(pitch);
      out[dirAt] = Math.cos(yaw) * cosPitch;
      out[dirAt + 1] = Math.sin(pitch);
      out[dirAt + 2] = Math.sin(yaw) * cosPitch;
      // Born on a disc across the bearing, so a burst has a mouth rather than a
      // point: every mark leaving one pixel is the thing that reads as a nozzle.
      const spawnPhi = rng.float() * Math.PI * 2;
      const r = shape.b * Math.sqrt(rng.float());
      out[at] = 0;
      out[at + 1] = Math.sin(spawnPhi) * r;
      out[at + 2] = Math.cos(spawnPhi) * r;
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

/**
 * A point on a capsule of unit radius, `heightRadii` radii tall, standing on
 * `y = 0` (spec 197).
 *
 * What a `surface` hook owes `system.ts`, and the one place it is worked out.
 * There are two callers -- the game's own bodies in `world/scene.ts` and the
 * dummy in the judging rig (`brush-scene.ts`) -- and they must not be two
 * answers: the rig exists to say what the game will look like, and a rig that
 * distributes paint differently from the game is evidence about the rig. That is
 * the failure `probe-chat.ts` records having shipped once, where a clearance
 * check measured the wrong furniture and passed while the log sat on the button
 * beside it. A check against the wrong thing is worse than no check, because it
 * reads as evidence.
 *
 * ## The units are the whole of it
 *
 * The hook writes a **local offset from the instance origin, in the effect's own
 * scale units**, which the emit path multiplies by the instance scale before
 * adding it to the resolved attachment point. So this samples a capsule of
 * radius **one** and the caller's `scale` -- the body's footprint radius -- turns
 * it into a body. Write world units here instead and every mark lands a
 * body-radius-squared away from the thing it is meant to be clinging to.
 *
 * Taking the height in radii rather than in world units is what preserves a
 * body's actual proportions once that multiply happens: a tall thin body gets a
 * tall thin capsule.
 *
 * ## Sampled by area, which is the part that is easy to get wrong
 *
 * Picking "cap or side" with an even coin is the mistake that looks right: split
 * evenly, the two hemispherical caps take half the marks whatever the body's
 * proportions, so a tall body wears a hat and boots of paint and nothing on its
 * middle. The side of the cylinder is `2*pi*L` and the two caps together are one
 * sphere, `4*pi`, so the side takes `L / (L + 2)` of the draws and the shape is
 * evenly stained however tall it is.
 *
 * `VfxRng`, never `Math.random`: the promise this system makes is that the same
 * seed draws the same effect, and a surface sample is as much a part of the
 * painting as a velocity is. Two clients watching one poisoned body have to see
 * the same marks, and a harness that cannot reproduce a frame cannot measure one.
 */
export function sampleCapsuleSurface(
  rng: VfxRng,
  out: Float32Array,
  at: number,
  heightRadii: number,
): void {
  // The straight part, between the two cap centres. Clamped at zero so a body
  // shorter than it is wide degenerates to a sphere rather than to nonsense.
  const straight = Math.max(0, heightRadii - 2);
  const theta = rng.range(0, Math.PI * 2);
  if (rng.float() < straight / (straight + 2)) {
    out[at] = Math.cos(theta);
    out[at + 1] = 1 + rng.float() * straight;
    out[at + 2] = Math.sin(theta);
    return;
  }
  // Archimedes: a uniform height on [-1, 1] with a uniform angle is a uniform
  // point on the unit sphere. The top half is hung off the upper cap centre and
  // the bottom half off the lower one, which is exactly what makes the two
  // hemispheres meet the cylinder without a seam.
  const y = rng.range(-1, 1);
  const ring = Math.sqrt(Math.max(0, 1 - y * y));
  out[at] = Math.cos(theta) * ring;
  out[at + 1] = (y >= 0 ? 1 + straight : 1) + y;
  out[at + 2] = Math.sin(theta) * ring;
}

