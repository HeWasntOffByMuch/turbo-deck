/**
 * Reciprocal collision avoidance between moving bodies (ORCA, spec 187).
 *
 * This is van den Berg et al.'s *Optimal Reciprocal Collision Avoidance* --
 * RVO2's 2D solver -- transcribed rather than invented. A body states the
 * velocity it *wants*; each neighbour contributes one half-plane of velocities
 * that are safe with respect to it for the next {@link AvoidanceParams.horizon}
 * seconds; the answer is the velocity nearest the wanted one that satisfies all
 * of them at once, found with a small linear program.
 *
 * The two properties that make it worth transcribing rather than replacing with
 * a repulsion force are both about what it *does not* do:
 *
 *  - **It does not oscillate.** A repulsion force reacts to where a neighbour
 *    *is*, so two bodies swerve, stop overlapping, swerve back, and shudder
 *    down the corridor. A half-plane is built from where the neighbour is
 *    *going*, and each body assumes the other is solving the same problem and
 *    takes exactly half the correction -- so one swerve settles the pair and
 *    neither has to re-decide.
 *  - **It does not stop.** The answer is the *nearest* safe velocity, not a
 *    braking rule, so a body that can go round goes round. Slowing down is what
 *    it does when there is nowhere to go, which is the case the fallback below
 *    exists for.
 *
 * What it deliberately does not know about is walls. Static obstacles are the
 * nav grid's job (`pathfinding.ts` routes round them) and `slideCircle`'s
 * (collision.ts slides along them), and adding ORCA obstacle lines would be a
 * third answer to a question two systems already answer. What that costs is
 * stated in {@link avoidanceVelocity}.
 *
 * Pure and part of the deterministic core: no clock, no RNG, no allocation per
 * neighbour beyond the half-plane list, and every loop runs over an array in
 * the order it was handed. The same `(self, neighbours, preferred)` always
 * gives the same velocity, so a replay walks the same way through the same
 * crowd.
 */

import type { Vec2 } from './types.js';

/** A body in the avoidance problem: where it is, where it is going, how wide. */
export interface CrowdAgent {
  readonly x: number;
  readonly y: number;
  /** Velocity in world units per second, not per tick. */
  readonly vx: number;
  readonly vy: number;
  readonly radius: number;
  /**
   * A body that will not deviate for anyone -- a player, whose movement is
   * predicted on their own machine and must stay exactly what they asked for
   * (spec 067). Everybody else takes the *whole* correction against it rather
   * than half, which is the same rule `resolveOverlaps`'s `pinned` already
   * states for overlap: a partner that takes none of the push leaves all of it
   * to the other body.
   *
   * A pinned agent is never solved for. It appears only as a neighbour.
   */
  readonly pinned: boolean;
}

export interface AvoidanceParams {
  /**
   * Seconds of lookahead. How far ahead a body plans its way round another:
   * larger is smoother and more timid, smaller is later and sharper. Bodies
   * here are 12-30 units wide and travel 40-115 units a second, so a second or
   * so is about two body-lengths of warning.
   */
  readonly horizon: number;
  /**
   * Seconds in one tick. Only used for the *already overlapping* case, where
   * the horizon is one tick: two bodies inside each other have to be separating
   * by the next tick, not eventually.
   */
  readonly timeStep: number;
}

/**
 * A half-plane of allowed velocities: `v` is allowed when it lies to the left
 * of the line through `point` along `direction`.
 *
 * Mutable and pooled rather than built fresh, because there is one of these per
 * neighbour per body per tick -- a few hundred objects sixty times a second in
 * a fight, all of them dead before the next frame. See {@link LinePool}.
 */
export interface OrcaLine {
  px: number;
  py: number;
  dx: number;
  dy: number;
}

/**
 * A growing pool of {@link OrcaLine}s, so a solve allocates nothing after the
 * first crowd of a given size.
 *
 * `take` hands back the next line in the pool and grows it when it runs out;
 * `reset` returns them all. Nothing outside one `avoidanceVelocity` call ever
 * holds a line, so reuse is invisible.
 */
export class LinePool {
  private readonly lines: OrcaLine[] = [];
  private used = 0;

  reset(): void {
    this.used = 0;
  }

  take(): OrcaLine {
    const held = this.lines[this.used];
    if (held) {
      this.used += 1;
      return held;
    }
    const line: OrcaLine = { px: 0, py: 0, dx: 0, dy: 0 };
    this.lines.push(line);
    this.used += 1;
    return line;
  }
}

/**
 * Below this a determinant is treated as zero and two lines as parallel.
 *
 * RVO2's own constant. It is an absolute epsilon on a quantity in world units
 * squared, which is only defensible because everything here is normalised: a
 * `direction` is a unit vector, so the determinant of two of them is a sine.
 */
const EPSILON = 0.00001;

function det(ax: number, ay: number, bx: number, by: number): number {
  return ax * by - ay * bx;
}

/**
 * The half-plane of velocities safe for `self` with respect to `other`.
 *
 * Returns null when there is nothing to avoid -- which never happens for a pair
 * that can collide, and is what a body handed itself as a neighbour gets.
 *
 * The three cases are RVO2's, and they are three because the velocity obstacle
 * is a cone with a rounded tip: a velocity may be nearest to the *cutoff
 * circle* at the tip (the pair are on course to touch at the far end of the
 * horizon, and the cheapest fix is to go slower or faster), or nearest to one
 * of the two *legs* (the pair are on course to touch sooner, and the cheapest
 * fix is to pass on one side or the other). The third case is the pair already
 * overlapping, where the cone is degenerate and the horizon collapses to a
 * single tick.
 */
export function orcaLine(
  self: CrowdAgent,
  other: CrowdAgent,
  params: AvoidanceParams,
  into: OrcaLine = { px: 0, py: 0, dx: 0, dy: 0 },
): OrcaLine | null {
  // Relative position and velocity, and the distance at which the two touch.
  const rx = other.x - self.x;
  const ry = other.y - self.y;
  const vx = self.vx - other.vx;
  const vy = self.vy - other.vy;
  const distSq = rx * rx + ry * ry;
  const combined = self.radius + other.radius;
  const combinedSq = combined * combined;

  // How much of the correction this body takes. Half against another body that
  // is solving the same problem, all of it against one that is not.
  const share = other.pinned ? 1 : 0.5;

  let dirX: number;
  let dirY: number;
  let ux: number;
  let uy: number;

  if (distSq > combinedSq) {
    // Not yet touching. `w` is how far the relative velocity is from the tip of
    // the cone -- the apex being where the pair would just touch at the horizon.
    const invHorizon = 1 / params.horizon;
    const wx = vx - invHorizon * rx;
    const wy = vy - invHorizon * ry;
    const wLengthSq = wx * wx + wy * wy;
    const dotWR = wx * rx + wy * ry;

    if (dotWR < 0 && dotWR * dotWR > combinedSq * wLengthSq) {
      // Nearest point is on the cutoff circle at the cone's tip.
      const wLength = Math.sqrt(wLengthSq);
      const unitWx = wLength > 0 ? wx / wLength : 0;
      const unitWy = wLength > 0 ? wy / wLength : 0;
      dirX = unitWy;
      dirY = -unitWx;
      const scale = combined * invHorizon - wLength;
      ux = scale * unitWx;
      uy = scale * unitWy;
    } else {
      // Nearest point is on one of the cone's legs. Which leg is decided by
      // which side of the relative position `w` falls on.
      const leg = Math.sqrt(distSq - combinedSq);
      if (det(rx, ry, wx, wy) > 0) {
        dirX = (rx * leg - ry * combined) / distSq;
        dirY = (rx * combined + ry * leg) / distSq;
      } else {
        dirX = -(rx * leg + ry * combined) / distSq;
        dirY = -(-rx * combined + ry * leg) / distSq;
      }
      const along = vx * dirX + vy * dirY;
      ux = along * dirX - vx;
      uy = along * dirY - vy;
    }
  } else {
    // Already overlapping. The horizon is one tick: whatever else happens, the
    // pair must be separating by the next step. Without this a crowd that gets
    // squeezed together -- by a spawn, a teleport, a stagger -- has no way back
    // out, because the cone has no tip to be outside of.
    const invStep = 1 / params.timeStep;
    const wx = vx - invStep * rx;
    const wy = vy - invStep * ry;
    const wLength = Math.sqrt(wx * wx + wy * wy);
    if (wLength < EPSILON) return null;
    const unitWx = wx / wLength;
    const unitWy = wy / wLength;
    dirX = unitWy;
    dirY = -unitWx;
    const scale = combined * invStep - wLength;
    ux = scale * unitWx;
    uy = scale * unitWy;
  }

  into.px = self.vx + share * ux;
  into.py = self.vy + share * uy;
  into.dx = dirX;
  into.dy = dirY;
  return into;
}

/** Working slot for the linear program, so the solvers return without allocating. */
export interface Solution {
  x: number;
  y: number;
}

/**
 * Optimise along one line, subject to every line before it and the speed disc.
 *
 * Returns false when the constraints so far leave nothing on this line -- which
 * is what makes the whole program detect infeasibility, and what
 * {@link linearProgram3} exists to answer.
 */
function linearProgram1(
  lines: readonly OrcaLine[],
  lineNo: number,
  maxSpeed: number,
  optX: number,
  optY: number,
  directionOpt: boolean,
  out: Solution,
): boolean {
  const line = lines[lineNo];
  if (!line) return false;
  const dot = line.px * line.dx + line.py * line.dy;
  const discriminant = dot * dot + maxSpeed * maxSpeed - (line.px * line.px + line.py * line.py);
  // The speed disc does not reach this line at all: no legal velocity on it.
  if (discriminant < 0) return false;

  const root = Math.sqrt(discriminant);
  let tLeft = -dot - root;
  let tRight = -dot + root;

  for (let i = 0; i < lineNo; i++) {
    const other = lines[i];
    if (!other) continue;
    const denominator = det(line.dx, line.dy, other.dx, other.dy);
    const numerator = det(other.dx, other.dy, line.px - other.px, line.py - other.py);

    if (Math.abs(denominator) <= EPSILON) {
      // Parallel. Either this line lies entirely inside the other's half-plane
      // (nothing to do) or entirely outside it (nothing is legal).
      if (numerator < 0) return false;
      continue;
    }

    const t = numerator / denominator;
    if (denominator >= 0) tRight = Math.min(tRight, t);
    else tLeft = Math.max(tLeft, t);
    if (tLeft > tRight) return false;
  }

  if (directionOpt) {
    // Optimising a *direction* rather than a point: take whichever end of the
    // legal span goes furthest that way.
    const t = optX * line.dx + optY * line.dy > 0 ? tRight : tLeft;
    out.x = line.px + t * line.dx;
    out.y = line.py + t * line.dy;
  } else {
    const t = line.dx * (optX - line.px) + line.dy * (optY - line.py);
    const clamped = t < tLeft ? tLeft : t > tRight ? tRight : t;
    out.x = line.px + clamped * line.dx;
    out.y = line.py + clamped * line.dy;
  }
  return true;
}

/**
 * The velocity nearest the wanted one satisfying every line, or the index of
 * the first line that could not be satisfied.
 */
function linearProgram2(
  lines: readonly OrcaLine[],
  maxSpeed: number,
  optX: number,
  optY: number,
  directionOpt: boolean,
  out: Solution,
): number {
  if (directionOpt) {
    out.x = optX * maxSpeed;
    out.y = optY * maxSpeed;
  } else if (optX * optX + optY * optY > maxSpeed * maxSpeed) {
    const length = Math.sqrt(optX * optX + optY * optY);
    out.x = (optX / length) * maxSpeed;
    out.y = (optY / length) * maxSpeed;
  } else {
    out.x = optX;
    out.y = optY;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    if (det(line.dx, line.dy, line.px - out.x, line.py - out.y) <= 0) continue;
    const heldX = out.x;
    const heldY = out.y;
    if (!linearProgram1(lines, i, maxSpeed, optX, optY, directionOpt, out)) {
      out.x = heldX;
      out.y = heldY;
      return i;
    }
  }
  return lines.length;
}

/**
 * The fallback when no velocity satisfies every neighbour at once, which is the
 * whole reason a dense crowd does not deadlock or shudder.
 *
 * A body wedged between three others has an empty feasible set. The naive
 * answers are both bad: refusing to move is a body that stands in a doorway
 * forever, and ignoring the constraints is a body that walks through its
 * neighbours. What RVO2 does instead is relax -- it finds the velocity that
 * minimises the *worst* violation, by re-solving against the half-planes
 * bisecting each pair of conflicting ones. The result is a body that gives
 * ground toward the least-bad direction rather than one that dithers, and it is
 * the single most important thing in this file for the crowd cases the spec is
 * about.
 */
function linearProgram3(
  lines: readonly OrcaLine[],
  beginLine: number,
  maxSpeed: number,
  out: Solution,
  pool: LinePool,
  projected: OrcaLine[],
): void {
  let distance = 0;

  for (let i = beginLine; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    if (det(line.dx, line.dy, line.px - out.x, line.py - out.y) <= distance) continue;

    projected.length = 0;
    for (let j = 0; j < i; j++) {
      const other = lines[j];
      if (!other) continue;
      const determinant = det(line.dx, line.dy, other.dx, other.dy);
      let px: number;
      let py: number;
      if (Math.abs(determinant) <= EPSILON) {
        // Parallel and pointing the same way: `other` is the weaker of the two
        // and adds nothing. Pointing opposite ways: the compromise is halfway
        // between them.
        if (line.dx * other.dx + line.dy * other.dy > 0) continue;
        px = 0.5 * (line.px + other.px);
        py = 0.5 * (line.py + other.py);
      } else {
        const t = det(other.dx, other.dy, line.px - other.px, line.py - other.py) / determinant;
        px = line.px + t * line.dx;
        py = line.py + t * line.dy;
      }
      let dx = other.dx - line.dx;
      let dy = other.dy - line.dy;
      const length = Math.sqrt(dx * dx + dy * dy);
      if (length <= EPSILON) continue;
      dx /= length;
      dy /= length;
      const into = pool.take();
      into.px = px;
      into.py = py;
      into.dx = dx;
      into.dy = dy;
      projected.push(into);
    }

    const heldX = out.x;
    const heldY = out.y;
    // Optimise *away* from the violated line: its left normal.
    if (linearProgram2(projected, maxSpeed, -line.dy, line.dx, true, out) < projected.length) {
      out.x = heldX;
      out.y = heldY;
    }
    distance = det(line.dx, line.dy, line.px - out.x, line.py - out.y);
  }
}

/**
 * The velocity `self` should take this tick: as near `preferred` as its
 * neighbours allow, and never faster than `maxSpeed`.
 *
 * `neighbours` is the caller's business, and both halves of that matter. It
 * must be a *bounded* set -- everybody in the world is O(N^2) and the far half
 * of it changes nothing -- and it must be in a *stable* order, because the
 * linear program's answer depends on the order the half-planes are visited
 * whenever two of them tie. `src/sim/neighbours.ts` is the broadphase that
 * answers both.
 *
 * Velocities are in world units per second. Positions are world units.
 *
 * What this does not do is walls. A body that solves its way sideways into a
 * tree gets stopped by `slideCircle` and slides along it, which is the same
 * answer it had before there was any avoidance at all -- so the failure mode of
 * omitting obstacle lines is a body that hugs a wall rather than one that walks
 * through it. What it costs is that a crowd in a doorway leans on the frame
 * instead of queueing tidily; what it buys is that there is exactly one
 * description of the world's geometry, and it is the nav grid's.
 */
export function avoidanceVelocity(
  self: CrowdAgent,
  neighbours: readonly CrowdAgent[],
  preferred: Vec2,
  maxSpeed: number,
  params: AvoidanceParams,
  scratch: SolveScratch = createSolveScratch(),
): Vec2 {
  const { pool, lines, projected, out } = scratch;
  pool.reset();
  lines.length = 0;
  projected.length = 0;
  for (const other of neighbours) {
    const line = orcaLine(self, other, params, pool.take());
    if (line) lines.push(line);
  }

  out.x = 0;
  out.y = 0;
  const failed = linearProgram2(lines, maxSpeed, preferred.x, preferred.y, false, out);
  if (failed < lines.length) linearProgram3(lines, failed, maxSpeed, out, pool, projected);
  return { x: out.x, y: out.y };
}

/**
 * The buffers one solve reuses. The caller owns it so a tick of solves
 * allocates nothing but its answers; `avoidanceVelocity` makes a private one
 * when it is not given one, so a single call still reads as a pure function.
 */
export interface SolveScratch {
  readonly pool: LinePool;
  readonly lines: OrcaLine[];
  readonly projected: OrcaLine[];
  readonly out: Solution;
}

export function createSolveScratch(): SolveScratch {
  return { pool: new LinePool(), lines: [], projected: [], out: { x: 0, y: 0 } };
}
