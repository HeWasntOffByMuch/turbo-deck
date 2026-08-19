/**
 * The crowd pass: what a tick does to a body because of the bodies around it
 * (spec 186).
 *
 * Until this existed, nothing on the server knew that two units were in the
 * same place. `resolveMovement` slides a body along walls, refuses it a cliff
 * and refuses it open water, and has never once looked at another body -- so a
 * herd walked as one point, a pack chasing a player converged into a single
 * stack, and "twenty monsters" and "one monster with twenty health bars" were
 * the same picture.
 *
 * This is the two halves of fixing that, in the order a tick needs them:
 *
 *  - {@link solveAvoidance}, **before** anybody moves. Each body states the
 *    velocity it wants and gets back the nearest one that will not run into a
 *    neighbour over the next second or so -- ORCA, from `src/sim/avoidance.ts`.
 *    This is what makes a crowd flow: bodies go *round* each other rather than
 *    into and then out of each other.
 *  - {@link resolveCrowding}, **after** everybody has moved. A small positional
 *    push apart for bodies that are actually overlapping. Avoidance keeps a
 *    crowd from colliding; it cannot undo a collision that already exists,
 *    which is what a spawn, a stagger, a teleport, a wall or a body that had no
 *    legal velocity at all leaves behind.
 *
 * The two are deliberately different in kind, and the difference is the reason
 * neither alone is enough. Avoidance is a *velocity* rule, so it is invisible
 * until a body is on a collision course and it never fights the body's own
 * intent. Separation is a *position* rule, so it works on bodies that are not
 * moving at all -- but it is exactly the rule that shudders if you lean on it,
 * which is why it is a fraction of the overlap per tick and never the whole of
 * it, and why it is a safety net rather than the mechanism.
 *
 * Pure, and part of the deterministic core: everything reads the array it is
 * handed, in the order it is handed, with no clock and no RNG. The caller owns
 * the arrays so a tick allocates nothing per body.
 */

import { hashUnit2 } from '../../shared/hash.js';
import {
  avoidanceVelocity,
  createSolveScratch,
  type AvoidanceParams,
  type CrowdAgent,
  type SolveScratch,
} from '../../sim/avoidance.js';
import { NeighbourGrid } from '../../sim/neighbours.js';

/**
 * Seconds of lookahead for avoidance between bodies.
 *
 * Bodies here are 12 to 30 units across the radius and travel 40 to 115 units a
 * second, so this is roughly one to three body-lengths of warning: long enough
 * that a pair resolves a crossing with one gentle swerve, short enough that a
 * body does not give way to something it will never actually meet. Larger
 * values read as timid, smaller ones as late.
 */
export const AVOID_HORIZON_SECONDS = 1.0;

/**
 * How far out a body looks for neighbours.
 *
 * Has to be at least `horizon * (fastest + fastest) + widest pair of radii`, or
 * the search quietly clips the horizon and the horizon stops being the knob it
 * looks like. The fastest thing that walks is the small spider at 115 and the
 * widest pair is two ravagers at 60, so a second of lookahead needs 290; this
 * is that with margin.
 *
 * A *player* can exceed it -- `MOVE_SPEED_HARD_MAX` is 550 -- and that is a
 * deliberate clip rather than an oversight. A player is pinned: they will not
 * give way, so the only thing a longer reach would buy is a monster starting to
 * sidestep a sprinting player a second earlier, and what actually bounds that
 * case is {@link MAX_AVOID_NEIGHBOURS} rather than any radius.
 */
export const AVOID_NEIGHBOUR_DIST = 320;

/**
 * The most neighbours one body will solve against.
 *
 * A cap rather than a radius, because density is what actually costs: in the
 * middle of a fifty-body herd the nearest eight already box a body in on every
 * side, and the ninth cannot add a constraint the first eight have not. It is
 * also what turns the pass from "quadratic in the densest clump" into
 * "linear in the crowd".
 */
export const MAX_AVOID_NEIGHBOURS = 8;

/**
 * How much of an overlap is taken out per tick.
 *
 * Not all of it, and that is the whole design of this half. Resolving an
 * overlap outright makes a body jump, makes a stack of bodies explode, and --
 * worst -- fights the avoidance solver, which is busy arranging for the overlap
 * to be gone in a few ticks anyway. A quarter is enough that a real pile-up
 * unstacks within half a second and gentle enough that it never reads as a
 * shove.
 */
export const SEPARATION_RATE = 0.25;

/**
 * The fastest a body may be shoved out of an overlap, as a fraction of its own
 * walking speed.
 *
 * A cap in *speed* rather than in distance, and it is the difference between a
 * safety net and a movement mechanic. The first cut capped the push at a
 * fraction of the body's radius, which for a grazer is eleven units a tick --
 * six hundred and sixty a second, against a walking speed of forty. What that
 * produced was a bulldozer: a player walking into a grazer pushed it away at
 * three times the speed it could run, so the animal fled across the map at the
 * player's pace and could not be caught. Every number in it was small and the
 * product was absurd, which is the same failure `turn-swing.ts` exists to
 * catch.
 *
 * Half, so a shove always reads as slower than walking, and so a body that
 * cannot walk cannot be shoved at all.
 */
export const SEPARATION_MAX_SPEED = 0.5;

/** Cell size for the overlap search: the widest pair of bodies that can touch. */
export const SEPARATION_CELL = 96;

/**
 * A hair of asymmetry, in radians, added to what each body says it wants.
 *
 * The one configuration reciprocal avoidance is genuinely bad at is *exact*
 * mirror symmetry: two bodies crossing at right angles from mirrored positions
 * at mirrored speeds compute mirrored answers, stay mirrored, and grind round
 * each other for several seconds before one of them wins. Nothing is unsafe
 * about it -- they never touch -- but it reads as two animals being excessively
 * polite, and a game spawns bodies on grids and marches them in ranks, so it is
 * not the rare accident it is in a paper.
 *
 * The fix is the one RVO2's own demos use: perturb what each body wants, so no
 * two of them are ever exactly mirrored. Where this differs is that it must not
 * be *random* -- a draw from `state.rng` would shift every crit, weak point and
 * loot roll after it in every replay, and one from `Math.random` is not
 * available at all. So it is hashed off the body's id: constant for the life of
 * the body, different for every body, and free of both the clock and the draw
 * sequence.
 *
 * A tenth of a degree. Four orders of magnitude above the floating-point noise
 * that would otherwise be the only thing separating a mirrored pair, and small
 * enough that a body crossing the whole map arrives a third of a unit off the
 * line it would otherwise have walked.
 */
export const SYMMETRY_BREAK_RADIANS = 0.0021;

/** The seed the symmetry break is hashed with. Arbitrary, and fixed forever. */
const SYMMETRY_SEED = 0x184;

/**
 * This body's constant, deterministic sliver of asymmetry -- as a **tangent**
 * rather than an angle, because of how it is applied.
 *
 * `Math.sin` and `Math.cos` are implementation-approximated in ECMAScript: the
 * spec permits an implementation-dependent approximation, so two engines may
 * disagree in the last bits, and this codebase runs the same sim in Node and in
 * a browser tab. A rotation built from them is therefore a replay-divergence
 * hazard hiding inside a constant nobody would ever look at again. Built from
 * `Math.sqrt` -- which IEEE-754 requires to be correctly rounded, and which the
 * spec requires to follow it -- the rotation is exact everywhere.
 *
 * So the bias is a slope, and {@link rotateBySlope} turns it into the exact
 * rotation by `atan(slope)`. For a slope this small the two are the same number
 * to twelve decimal places anyway.
 */
export function symmetryBreak(id: number): number {
  return (hashUnit2(id, 0, SYMMETRY_SEED) * 2 - 1) * SYMMETRY_BREAK_RADIANS;
}

/**
 * Rotate `(x, y)` by `atan(slope)`, preserving its length exactly.
 *
 * `cos(atan(s)) = 1/sqrt(1+s^2)` and `sin(atan(s)) = s/sqrt(1+s^2)`, so the
 * whole rotation is one square root and no trigonometry at all.
 */
function rotateBySlope(x: number, y: number, slope: number, out: { x: number; y: number }): void {
  const cos = 1 / Math.sqrt(1 + slope * slope);
  const sin = slope * cos;
  out.x = x * cos - y * sin;
  out.y = x * sin + y * cos;
}

/** Reused by the solve so a tick does not allocate one of these per body. */
const BIASED = { x: 0, y: 0 };

/**
 * One body in the crowd, for one tick.
 *
 * Mutable, and owned by the caller, because a tick's worth of these is a few
 * hundred objects that would otherwise be allocated and thrown away sixty times
 * a second. Nothing here is entity state -- it is a working copy of the facts
 * the two passes need, read out of the entities at the top of the tick and
 * written back at the bottom.
 */
export interface CrowdBody extends CrowdAgent {
  readonly id: number;
  /**
   * One body this one does not avoid, or -1.
   *
   * A monster charging a player does not dodge the player -- what stops it is
   * its own standoff distance, which is further out than any radius avoidance
   * would keep. Left in, the target's half-plane bites over the last stretch of
   * the approach and a pack closes in a slow curve rather than a charge; and a
   * body that has already stopped in reach would spend the fight being told to
   * back off from the thing it is hitting.
   */
  ignoreId: number;
  x: number;
  y: number;
  /** The velocity this body actually travelled at last tick, world units per second. */
  vx: number;
  vy: number;
  radius: number;
  /**
   * A body that will not deviate for anybody: a player, whose movement is
   * predicted on their own machine (spec 067), and any body that is not moving
   * this tick at all -- one rooted by a cast, broken by a stagger, standing at
   * its target or simply idle. Everyone else takes the whole of the avoidance
   * against it, and it is never solved for.
   */
  pinned: boolean;
  /**
   * Whether this body takes part in the overlap pass at all, as something
   * pushed and as something that pushes.
   *
   * False for a player, and that is a deliberate limit rather than an oversight
   * (spec 186). Shoving monsters aside by walking into them is a real design
   * decision with real consequences for every reach, standoff and chase in the
   * game -- it is how a player would kite a pack into a wall -- and it is not
   * the decision this feature is about. Monsters no longer stand inside each
   * other; a player and a monster overlap exactly as much as they always have.
   *
   * Separate from {@link pinned} because the two questions are genuinely
   * different. A monster standing at its target is pinned -- it has no velocity
   * to solve for and everybody routes around it -- and is emphatically part of
   * the overlap pass: a pack that arrives and stops is the crowd that most
   * needs unpacking.
   */
  bumps: boolean;
  /**
   * The furthest this body may be displaced in one tick, world units. Zero
   * keeps it exactly where it is, and a body that cannot walk gets zero.
   */
  pushLimit: number;
  /** Its own speed cap, world units per second. Different per body, and it stays that way. */
  maxSpeed: number;
  /** The velocity it wants, world units per second. Written by the caller before the solve. */
  prefX: number;
  prefY: number;
  /** The velocity it should take, world units per second. Written by the solve. */
  outX: number;
  outY: number;
}

/** A body's position after it has moved, for the overlap pass. */
export interface CrowdPush {
  x: number;
  y: number;
}

/**
 * Fill every body's `outX`/`outY` with the velocity it should take.
 *
 * `bodies` must be in a stable order -- the sim's entity creation order -- for
 * two reasons that are easy to miss. The obvious one is that the linear program
 * visits half-planes in the order it is handed them and its answer can depend
 * on that order when two of them tie. The other is that `NeighbourGrid` reports
 * bodies by index, so the *set* of nearest neighbours is stable only if the
 * indices are.
 *
 * A pinned body is skipped: its `outX`/`outY` are set to its preference
 * unchanged, which for every pinned body this sim produces is zero or a
 * player's own input.
 */
export function solveAvoidance(
  bodies: readonly CrowdBody[],
  scratch: CrowdScratch,
  params: AvoidanceParams = { horizon: AVOID_HORIZON_SECONDS, timeStep: 1 / 60 },
): void {
  const grid = scratch.avoid;
  const scratchIndices = scratch.indices;
  const scratchNeighbours = scratch.neighbours;
  grid.rebuild(bodies);

  for (let i = 0; i < bodies.length; i++) {
    const self = bodies[i];
    if (!self) continue;
    if (self.pinned) {
      self.outX = self.prefX;
      self.outY = self.prefY;
      continue;
    }

    scratchIndices.length = 0;
    grid.around(self.x, self.y, i, scratchIndices);
    nearest(bodies, self, scratchIndices, scratchNeighbours, scratch.keys);

    // Turned rather than nudged, so the body still asks for exactly its own
    // speed -- a perturbation added componentwise would quietly make every body
    // slightly faster or slower than its stat says.
    rotateBySlope(self.prefX, self.prefY, symmetryBreak(self.id), BIASED);
    const velocity = avoidanceVelocity(self, scratchNeighbours, BIASED, self.maxSpeed, params, scratch.solve);
    self.outX = velocity.x;
    self.outY = velocity.y;
  }
}

/**
 * The {@link MAX_AVOID_NEIGHBOURS} nearest of `candidates`, nearest first.
 *
 * An insertion sort into a bounded list rather than a sort of the whole
 * candidate set: the list is eight long and the candidate set is rarely more
 * than a couple of dozen, so this is both faster and -- more to the point --
 * allocates nothing.
 *
 * Ties break on entity id, and that is load-bearing rather than tidy. The
 * broadphase reports candidates in *bucket* order, which is a hash of their
 * cell -- perfectly deterministic, and not a property of anything a reader of
 * this sim would recognise. Two neighbours at exactly the same distance would
 * otherwise be ordered by where the hash happened to put them, and the linear
 * program's answer can depend on the order its half-planes arrive in. Ordering
 * by id makes the same crowd give the same answer whatever the cell size is.
 */
function nearest(
  bodies: readonly CrowdBody[],
  self: CrowdBody,
  candidates: readonly number[],
  out: CrowdBody[],
  keys: number[],
): void {
  let held = 0;

  for (const index of candidates) {
    const other = bodies[index];
    if (!other) continue;
    if (other.id === self.ignoreId) continue;
    const dx = other.x - self.x;
    const dy = other.y - self.y;
    const distSq = dx * dx + dy * dy;

    // Where it belongs, walking back from the end of what is held.
    let at = held;
    while (at > 0) {
      const key = keys[at - 1] ?? 0;
      if (key < distSq) break;
      if (key === distSq && (out[at - 1]?.id ?? 0) < other.id) break;
      at -= 1;
    }
    if (at >= MAX_AVOID_NEIGHBOURS) continue;

    // Shift by hand rather than with `splice`: this runs once per candidate per
    // body per tick, and `splice` on a hot array is both slower and a source of
    // garbage in exactly the place a crowd cannot afford one.
    const top = Math.min(held, MAX_AVOID_NEIGHBOURS - 1);
    for (let i = top; i > at; i--) {
      out[i] = out[i - 1] as CrowdBody;
      keys[i] = keys[i - 1] as number;
    }
    out[at] = other;
    keys[at] = distSq;
    if (held < MAX_AVOID_NEIGHBOURS) held += 1;
  }

  out.length = held;
  keys.length = held;
}

/**
 * How far each body should be nudged to stop overlapping its neighbours.
 *
 * `positions` is where the bodies ended up after moving -- so this runs at the
 * *end* of a tick, not the start. `out` is written one entry per body: the
 * offset to apply, which is zero for a pinned body and for anybody who is not
 * overlapping anything.
 *
 * The push is symmetric between two free bodies and taken entirely by the free
 * one against a pinned one, which is the rule `resolveOverlaps` already states
 * for the single-player sim's bodies and the same rule the avoidance solver
 * uses for its half-planes. Two bodies at exactly the same point are split
 * along +x by index, so a stack unpacks the same way in every replay rather
 * than depending on which way a zero-length vector happened to normalise.
 *
 * The caller applies the offsets: this function knows nothing about walls,
 * cliffs or water, and a push that would put a body somewhere it may not stand
 * must be refused by whoever does know.
 */
export function resolveCrowding(
  bodies: readonly CrowdBody[],
  positions: readonly CrowdPush[],
  scratch: CrowdScratch,
  out: CrowdPush[],
): void {
  const grid = scratch.bump;
  const scratchIndices = scratch.indices;
  grid.rebuild(positions);

  for (const slot of out) {
    slot.x = 0;
    slot.y = 0;
  }

  for (let i = 0; i < bodies.length; i++) {
    const self = bodies[i];
    const at = positions[i];
    const push = out[i];
    if (!self || !at || !push || !self.bumps || self.pushLimit <= 0) continue;

    scratchIndices.length = 0;
    grid.around(at.x, at.y, i, scratchIndices);

    for (const index of scratchIndices) {
      const other = bodies[index];
      const there = positions[index];
      if (!other || !there || !other.bumps) continue;
      const reach = self.radius + other.radius;
      let dx = at.x - there.x;
      let dy = at.y - there.y;
      const distSq = dx * dx + dy * dy;
      if (distSq >= reach * reach) continue;

      let overlap: number;
      if (distSq < 1e-12) {
        // Exactly coincident: split along +x, lower index to the left. The same
        // tie-break `resolveOverlaps` makes, for the same reason -- a zero
        // vector has no direction and picking one by index is the only answer
        // that replays.
        dx = i < index ? -1 : 1;
        dy = 0;
        overlap = reach;
      } else {
        const dist = Math.sqrt(distSq);
        dx /= dist;
        dy /= dist;
        overlap = reach - dist;
      }

      // A partner that cannot be pushed takes none of it, so this body takes
      // the whole overlap rather than half.
      const share = other.pushLimit > 0 ? 0.5 : 1;
      push.x += dx * overlap * share * SEPARATION_RATE;
      push.y += dy * overlap * share * SEPARATION_RATE;
    }

    const cap = self.pushLimit;
    const length = Math.sqrt(push.x * push.x + push.y * push.y);
    if (length > cap) {
      push.x = (push.x / length) * cap;
      push.y = (push.y / length) * cap;
    }
  }
}

/**
 * The buffers a crowd pass reuses between ticks.
 *
 * Only the parts whose size is a function of the crowd rather than of one body:
 * the two grids, whose typed arrays are grown and never shrunk, and the two
 * per-body working lists. The {@link CrowdBody} records themselves are built
 * fresh each tick, because a tick already builds a whole new entity object per
 * body and one more small object per body is nowhere near the dominant cost --
 * where a hundred kilobytes of typed array per tick would be.
 */
export interface CrowdScratch {
  readonly avoid: NeighbourGrid;
  readonly bump: NeighbourGrid;
  readonly indices: number[];
  readonly neighbours: CrowdBody[];
  readonly keys: number[];
  readonly solve: SolveScratch;
}

export function createCrowdScratch(): CrowdScratch {
  return {
    avoid: new NeighbourGrid(AVOID_NEIGHBOUR_DIST),
    bump: new NeighbourGrid(SEPARATION_CELL),
    indices: [],
    neighbours: [],
    keys: [],
    solve: createSolveScratch(),
  };
}
