/**
 * Where a second player stands (spec 145).
 *
 * `DEFAULT_SPAWN` is one point, and nothing in this game collides body against
 * body, so before this every player logged in *inside* everybody else. That
 * reads as a bug long before anybody works out it is a spawn rule.
 *
 * Deterministic with no PRNG to thread anywhere, which is the whole reason it
 * is a ring rather than a scatter: the candidate order is a compile-time
 * constant, so the same occupied set always yields the same point, and a replay
 * puts the same players in the same places. A jittered spawn would have needed
 * the seeded PRNG passed down through login, for no gain a player could see.
 *
 * Pure. Part of the deterministic core.
 */

import type { Vec2 } from '../../sim/types.js';

/**
 * Offsets in units of `spacing`, nearest first: the centre, a ring of six, then
 * a ring of twelve. Six because that is how many circles of radius r pack
 * around one of radius r, so the first ring is the tightest arrangement that
 * still leaves everybody a body's width.
 */
const RINGS: readonly (readonly Vec2[])[] = [
  [{ x: 0, y: 0 }],
  ringOf(6, 1),
  ringOf(12, 2),
];

function ringOf(count: number, radius: number): readonly Vec2[] {
  const points: Vec2[] = [];
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2;
    points.push({ x: Math.cos(angle) * radius, y: Math.sin(angle) * radius });
  }
  return points;
}

/** Slack for a chord that is meant to be exactly `spacing`. See `spawnAround`. */
const EPSILON = 1e-6;

/** Every candidate, nearest ring first. Flattened once rather than per call. */
const CANDIDATES: readonly Vec2[] = RINGS.flat();

/**
 * The first candidate around `base` that `fits` and is at least `spacing` from
 * everything in `occupied`.
 *
 * Falls back to `base` when every candidate is taken or unwalkable: refusing to
 * spawn somebody is worse than spawning them close, and the alternative is a
 * login that fails for a reason nobody can act on.
 */
export function spawnAround(
  base: Vec2,
  occupied: readonly Vec2[],
  spacing: number,
  fits: (x: number, y: number) => boolean,
): Vec2 {
  for (const offset of CANDIDATES) {
    const x = base.x + offset.x * spacing;
    const y = base.y + offset.y * spacing;
    if (!fits(x, y)) continue;
    let clear = true;
    for (const taken of occupied) {
      // `- EPSILON`, because the rings are built to land *exactly* `spacing`
      // apart: six points at radius `spacing` have a chord of precisely
      // `spacing`, and so does a ring-1 point against the ring-2 point behind
      // it. A bare `<` rejects those on the wrong side of a floating-point
      // rounding, which empties the rings and drops everybody back onto the
      // base -- the exact bug this function exists to prevent, arrived at from
      // the other direction.
      if (Math.hypot(taken.x - x, taken.y - y) < spacing - EPSILON) {
        clear = false;
        break;
      }
    }
    if (clear) return { x, y };
  }
  return { x: base.x, y: base.y };
}
