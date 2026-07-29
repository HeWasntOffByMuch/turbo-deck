import { Rng } from '../../shared/prng.js';
import type { Vec2 } from '../../sim/types.js';

/**
 * Deterministic scenery placement for the isometric scene (spec 018). This is
 * pure decoration -- trees and bushes have no effect on the sim -- but it still
 * goes through the seeded PRNG so the same (seed, bounds) always yields the same
 * arrangement. That keeps the renderer reproducible and testable, and keeps this
 * module free of any DOM/three dependency so it can be unit-tested in Node.
 */

export type PropKind = 'tree' | 'bush';

export interface Prop {
  readonly kind: PropKind;
  /** Position on the sim ground plane, in world units. */
  readonly x: number;
  readonly y: number;
  /** Uniform size multiplier applied to the base mesh. */
  readonly scale: number;
  /** Y-axis spin (radians) so identical meshes don't look stamped. */
  readonly rotation: number;
  /** Small per-instance foliage tint offset, in [-1, 1]. */
  readonly tint: number;
}

export interface ScatterOptions {
  /** How many trees to place. */
  readonly trees: number;
  /** How many bushes to place. */
  readonly bushes: number;
  /** No prop is placed within this radius of any keep-out point. */
  readonly keepOutRadius: number;
  /** No prop is placed within this radius of any already-placed prop. */
  readonly spacing: number;
  /** Inset from the arena edge so nothing clips the border. */
  readonly margin: number;
}

const DEFAULTS: ScatterOptions = {
  trees: 14,
  bushes: 20,
  keepOutRadius: 160,
  spacing: 70,
  margin: 60,
};

const UNIT = 1 << 24;

/** Draw a float in [0, 1) from the immutable Rng, returning the advanced Rng. */
function nextUnit(rng: Rng): [number, Rng] {
  const [n, next] = rng.nextInt(0, UNIT - 1);
  return [n / UNIT, next];
}

function farEnough(x: number, y: number, points: readonly Vec2[], minDist: number): boolean {
  const min2 = minDist * minDist;
  for (const p of points) {
    const dx = x - p.x;
    const dy = y - p.y;
    if (dx * dx + dy * dy < min2) return false;
  }
  return true;
}

/**
 * Place trees then bushes across the `width` x `height` ground plane, avoiding
 * every `keepOut` point (e.g. the player spawn) and crowding onto each other.
 * Rejection sampling with a bounded attempt budget: deterministic, and it
 * simply stops early rather than looping forever on a dense arena.
 */
export function scatterProps(
  seed: number,
  width: number,
  height: number,
  keepOut: readonly Vec2[],
  options: Partial<ScatterOptions> = {},
): Prop[] {
  const opt = { ...DEFAULTS, ...options };
  let rng = Rng.fromSeed(seed);
  const props: Prop[] = [];
  const placed: Vec2[] = [];

  const place = (kind: PropKind, count: number): void => {
    for (let i = 0; i < count; i++) {
      for (let attempt = 0; attempt < 24; attempt++) {
        let ux: number, uy: number, us: number, ur: number, ut: number;
        [ux, rng] = nextUnit(rng);
        [uy, rng] = nextUnit(rng);
        [us, rng] = nextUnit(rng);
        [ur, rng] = nextUnit(rng);
        [ut, rng] = nextUnit(rng);
        const x = opt.margin + ux * (width - 2 * opt.margin);
        const y = opt.margin + uy * (height - 2 * opt.margin);
        if (!farEnough(x, y, keepOut, opt.keepOutRadius)) continue;
        if (!farEnough(x, y, placed, opt.spacing)) continue;
        props.push({
          kind,
          x,
          y,
          scale: 0.8 + us * 0.6,
          rotation: ur * Math.PI * 2,
          tint: ut * 2 - 1,
        });
        placed.push({ x, y });
        break;
      }
    }
  };

  place('tree', opt.trees);
  place('bush', opt.bushes);
  return props;
}
