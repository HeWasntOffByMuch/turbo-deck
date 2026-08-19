/**
 * Where a body actually walks, once its neighbours are taken into account
 * (spec 184).
 *
 * The rule the whole module is built to respect: **nothing here moves
 * anything.** `steer` returns a *direction*, which the caller hands to the same
 * `resolveMovement` a player's own input goes through -- so a body affected by
 * a crowd is a body that decided to walk somewhere slightly different, at its
 * own move speed, over ground it is allowed to cross, with `activity` going to
 * `Moving` so the renderer draws it walking. A separation solver would instead
 * displace it after the fact, which is a body sliding while its animation says
 * it is standing still, and the animation would be right.
 *
 * Four rules, and each one answers a case the brief named.
 *
 * **Separation** keeps a body out of the space around its neighbours, and is
 * the term that stops a crowd converging to a point.
 *
 * **The side-step** turns a body to pass beside something in its way rather
 * than into it, and which side is the sign of `cross(desired, toNeighbour)`.
 * What makes that enough is that both bodies evaluate it over the same pair of
 * vectors and reach the same *handedness* -- and two bodies walking at each
 * other are pointing opposite ways, so one rule applied in each body's own
 * frame sends them down opposite sides of the world. That is the reciprocity
 * ORCA buys with a linear program, bought here with a comparison.
 *
 * The handedness has to be shared rather than divided, which is the thing that
 * is easy to get backwards: an id tie-break -- lower id goes left -- reads as
 * the obvious way to break the symmetry and is exactly wrong, because "left" is
 * measured against each body's own heading, so head-on bodies given opposite
 * handedness both step the same way in the world and collide having each
 * politely yielded. Dead head-on the cross product is zero and there is no side
 * to deduce at all, so the tie goes to one fixed handedness -- both left, like
 * a rule of the road, which is again opposite in the world.
 *
 * **Closing speed** scales the side-step. Two bodies travelling the same way at
 * the same speed are not closing on each other, get no side-step at all, and
 * flow as a herd; a body walking into a stationary one is closing at its full
 * speed and gets all of it. Without this a group moving together weaves
 * continuously, because every member is permanently beside somebody.
 *
 * **Nothing slows down.** This returns a unit vector and never a speed. A body
 * that matched the pace of whatever is in front of it would turn a crowd into a
 * queue, and the fast unit that could have gone around would be stuck behind
 * the slow one for ever.
 *
 * Pure, and part of the deterministic core: no clock, no randomness, and every
 * tie -- coincident bodies, exactly head-on -- broken on entity id.
 */

import {
  CROWD_CELL_SIZE,
  CROWD_LOOKAHEAD,
  CROWD_MARGIN,
  CROWD_MAX_AVOID,
  CROWD_MAX_NEIGHBOURS,
  CROWD_SEPARATION_WEIGHT,
  CROWD_SIDESTEP_WEIGHT,
} from '../../sim/constants.js';
import { NeighbourGrid } from '../../sim/neighbours.js';
import type { Vec2 } from '../../sim/types.js';

export interface CrowdBody {
  /** The entity id, and so every tie-break in here. */
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  /**
   * What this body is about to do, in world units per tick -- its intended
   * movement rather than where it has been. Zero for a body that is standing.
   *
   * Intent rather than history because a crowd is decided a tick at a time: two
   * bodies that have both just been told to walk at each other are closing,
   * whatever they were doing a tick ago.
   */
  readonly vx: number;
  readonly vy: number;
}

/** Coincident bodies split along x, lower id to the left. */
function coincidentAway(self: CrowdBody, other: CrowdBody): Vec2 {
  return { x: self.id < other.id ? -1 : 1, y: 0 };
}

function unit(x: number, y: number): Vec2 | null {
  const length = Math.hypot(x, y);
  if (!Number.isFinite(length) || length <= 1e-9) return null;
  return { x: x / length, y: y / length };
}

/**
 * The direction this body should walk, given where its route wants it and who
 * is nearby. Null when it should stand still.
 *
 * `desired` is the router's answer -- a unit vector, or null for a body with
 * nowhere to be. With no route the only term that runs is separation, and it
 * runs on a *tighter* threshold: a body that has arrived corrects a real
 * overlap and ignores mere proximity. That difference is the whole of idle
 * jitter. Bodies standing shoulder to shoulder around a target are touching by
 * design, and a margin applied to them would have every one of them shuffling
 * away from its neighbours for ever.
 */
export function steer(
  self: CrowdBody,
  desired: Vec2 | null,
  neighbours: readonly CrowdBody[],
): Vec2 | null {
  let avoidX = 0;
  let avoidY = 0;

  const selfSpeed = Math.hypot(self.vx, self.vy);

  for (const other of neighbours) {
    if (other.id === self.id) continue;
    const touch = self.radius + other.radius;
    let dx = self.x - other.x;
    let dy = self.y - other.y;
    let distance = Math.hypot(dx, dy);
    if (distance <= 1e-6) {
      const away = coincidentAway(self, other);
      dx = away.x;
      dy = away.y;
      distance = 1e-6;
    }
    // Unit vector pointing away from the neighbour, and its negation pointing
    // at it. Both are used below and neither is worth computing twice.
    const awayX = dx / distance;
    const awayY = dy / distance;

    // --- separation ------------------------------------------------------
    const personal = desired ? touch + CROWD_MARGIN : touch;
    if (distance < personal) {
      const weight = ((personal - distance) / personal) * CROWD_SEPARATION_WEIGHT;
      avoidX += awayX * weight;
      avoidY += awayY * weight;
    }

    // --- the side-step ---------------------------------------------------
    // Only a body with somewhere to be steps around anything. A body that has
    // arrived has no direction to be beside.
    if (!desired) continue;
    const reach = touch + CROWD_LOOKAHEAD;
    if (distance >= reach) continue;

    // How much of our route points at this neighbour. Something off to the
    // side is not in the way and is left alone.
    const ahead = desired.x * -awayX + desired.y * -awayY;
    if (ahead <= 0) continue;

    // How fast the gap between us is closing, along the line between us.
    // Negative or zero means we are not gaining on it, which is what two
    // bodies travelling together look like -- and they get nothing.
    const closing = (self.vx - other.vx) * -awayX + (self.vy - other.vy) * -awayY;
    if (closing <= 0) continue;
    const urgency = selfSpeed > 1e-9 ? Math.min(1, closing / selfSpeed) : 1;

    // Which side to pass on. `cross` is positive when the neighbour lies
    // counter-clockwise of where we are heading -- to our left -- so we go
    // right. Both bodies run this against the same pair of vectors and get
    // opposite answers, which is what makes the two of them agree without
    // either of them asking.
    const cross = desired.x * -awayY - desired.y * -awayX;
    const left = cross <= 0;
    const tangentX = left ? -desired.y : desired.y;
    const tangentY = left ? desired.x : -desired.x;

    const strength = (1 - distance / reach) * urgency * ahead * CROWD_SIDESTEP_WEIGHT;
    avoidX += tangentX * strength;
    avoidY += tangentY * strength;
  }

  // A body with no route walks out of an overlap and otherwise stands. This is
  // the "unstick" case, and it is an ordinary intent: it goes through
  // `resolveMovement` like every other step, so it obeys move speed, walls,
  // water and cliffs, and is animated as walking rather than drawn sliding.
  if (!desired) return unit(avoidX, avoidY);

  // Cap the avoidance so the route always dominates the crowd. Because the cap
  // is strictly below 1, `desired + avoid` can never be zero, so there is no
  // arrangement of neighbours that cancels a body's route and strands it.
  const magnitude = Math.hypot(avoidX, avoidY);
  if (magnitude > CROWD_MAX_AVOID) {
    const scale = CROWD_MAX_AVOID / magnitude;
    avoidX *= scale;
    avoidY *= scale;
  }
  return unit(desired.x + avoidX, desired.y + avoidY) ?? desired;
}

/**
 * This tick's bodies, indexed so each one only ever looks at the handful that
 * could touch it.
 *
 * Held by the caller and rebuilt each tick rather than allocated per tick: the
 * grid, the handle buffer and the result array all survive, so a tick with
 * forty bodies in it allocates nothing. `findPath` keeps its working set the
 * same way and for the same reason.
 *
 * Nothing in here is state the sim reads *across* ticks -- `build` replaces
 * everything -- so a replay that rebuilds the index from the same bodies gets
 * the same answers, and there is no order of `step` calls that could leak one
 * tick's crowd into another's.
 */
export class CrowdIndex {
  private readonly grid = new NeighbourGrid(CROWD_CELL_SIZE);
  private readonly handles = new Int32Array(CROWD_MAX_NEIGHBOURS);
  private readonly found: CrowdBody[] = [];
  private bodies: readonly CrowdBody[] = [];
  private widest = 0;

  build(bodies: readonly CrowdBody[]): void {
    this.bodies = bodies;
    this.grid.reset(bodies.length);
    let widest = 0;
    for (let i = 0; i < bodies.length; i++) {
      const one = bodies[i];
      if (!one) continue;
      this.grid.insert(i, one.x, one.y);
      if (one.radius > widest) widest = one.radius;
    }
    this.widest = widest;
  }

  /**
   * How far this body has to look: far enough to see the widest body in the
   * world at the edge of its own lookahead.
   *
   * Measured from the crowd rather than from a constant, so a map that adds a
   * bigger monster cannot silently shorten everybody's sight of it.
   */
  rangeFor(body: CrowdBody): number {
    return body.radius + this.widest + CROWD_LOOKAHEAD + CROWD_MARGIN;
  }

  /**
   * The bodies near this one, nearest-first-capped and never including itself.
   *
   * The returned array is reused on the next call. Callers pass it straight to
   * `steer` and to the blocker list within the same tick, which is the only
   * use it has; holding on to it would see it change underneath.
   */
  near(body: CrowdBody, range: number): readonly CrowdBody[] {
    const count = this.grid.query(body.x, body.y, range, this.handles);
    this.found.length = 0;
    for (let i = 0; i < count; i++) {
      const handle = this.handles[i] ?? -1;
      const other = handle >= 0 ? this.bodies[handle] : undefined;
      if (other && other.id !== body.id) this.found.push(other);
    }
    return this.found;
  }
}
