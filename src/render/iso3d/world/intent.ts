/**
 * Keys and a move order, turned into the intent the server is sent
 * (specs 063, 064).
 *
 * The one place the renderer touches input semantics, and deliberately a pure
 * function of what is held and where the last right-click landed: it decides
 * *what was asked for*, never what happens as a result. The
 * server decides that, and the whole reason this is a separate module from the
 * view is so "does W+D walk the diagonal at walking speed" and "does a move
 * order stop on arrival" are answerable in Node.
 *
 * Several of the rules below mirror the server rather than invent anything, and
 * they exist for the same reason: the client *predicts* with this vector, so anywhere
 * it disagrees with `resolveMovement` is a correction the player sees. Mirroring
 * a rule to predict it is not the renderer having an opinion -- the server still
 * decides, and if these drift the only symptom is a rubber-band.
 */

import { findPath, navGridFor } from '../../../sim/pathfinding.js';
import type { WorldColliders } from '../../../sim/types.js';

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** What {@link routeTo} needs to path through: the world, and how wide the body is. */
export interface PathWorld {
  readonly colliders: WorldColliders;
  readonly radius: number;
}

export interface MoveIntent {
  /** A unit vector, or (0,0) when nothing is asked for. */
  readonly moveX: number;
  readonly moveY: number;
  /** Radians. The heading asked for, not the heading reached -- see turnToward. */
  readonly facing: number;
  /**
   * True when a move order has been walked to its destination, so the caller
   * can drop it. Returned rather than acted on because this function owns no
   * state; the view holds the order and this says when it is spent.
   */
  readonly arrived: boolean;
}

/**
 * Which key codes drive which way, in the sim's axes: +y is "down the screen"
 * (south), matching the terrain module's `z`.
 */
export const MOVE_KEYS: Readonly<Record<string, readonly [number, number]>> = {
  KeyW: [0, -1],
  ArrowUp: [0, -1],
  KeyS: [0, 1],
  ArrowDown: [0, 1],
  KeyA: [-1, 0],
  ArrowLeft: [-1, 0],
  KeyD: [1, 0],
  ArrowRight: [1, 0],
};

/**
 * How close counts as arrived, in world units. Sized above one tick of travel at
 * any reachable speed, so a body cannot straddle the destination and jitter
 * across it forever.
 */
export const ARRIVE_EPS = 6;

export interface IntentInput {
  /** Key codes currently down. */
  readonly held: ReadonlySet<string>;
  /** Where the body is now -- the predicted position, not the replica. */
  readonly self: Point;
  /** The standing move order from the last right-click, or null. */
  readonly destination: Point | null;
  /**
   * The world to route a move order through, or null to steer straight at it.
   * Null until the welcome lands and the client has built the world.
   */
  readonly world: PathWorld | null;
  /** The body's current heading, kept when nothing asks for a new one. */
  readonly facing: number;
  /**
   * The aim of the cast in progress, or null when not casting.
   *
   * Two things at once, both mirroring the server. The server roots a caster
   * outright (`world.ts` zeroes the movement components while `cast !== null`),
   * so predicting a walk here would diverge on every tick of every wind-up. And
   * the server turns the body *into* its captured aim over the wind-up
   * (`resolveFacing`), so the heading asked for while casting is that aim and
   * not whatever the keys say.
   */
  readonly castAim: Point | null;
}

export function moveIntent(input: IntentInput): MoveIntent {
  const keyed = keyDirection(input.held);
  // Keys outrank a standing order: grabbing WASD is how you take manual control
  // back, and having to cancel an order first would feel like a stuck key.
  const direction = keyed ?? routeTo(input.self, input.destination, input.world);
  const arrived = keyed === null && direction === null && input.destination !== null;

  // Rooted, and turning into the blow. Asking for the aim rather than holding
  // the old heading is what makes the figure visibly come round during a
  // wind-up: the server is already turning it, and a client that kept asking for
  // its previous heading simply drew a body that never moved.
  if (input.castAim) {
    const dx = input.castAim.x - input.self.x;
    const dy = input.castAim.y - input.self.y;
    const facing = Math.hypot(dx, dy) < 1e-6 ? input.facing : Math.atan2(dy, dx);
    return { moveX: 0, moveY: 0, facing, arrived };
  }

  if (!direction) {
    return { moveX: 0, moveY: 0, facing: input.facing, arrived };
  }

  return {
    moveX: direction.x,
    moveY: direction.y,
    // A body faces where it is going. Aiming is per-cast and travels with the
    // cast rather than with the walk -- `useAbility` carries the cursor, and
    // the server captures it at the moment of commit -- so the cursor does not
    // drag the heading around between blows.
    facing: Math.atan2(direction.y, direction.x),
    arrived: false,
  };
}

/** The normalised direction the held keys ask for, or null when they cancel out. */
function keyDirection(held: ReadonlySet<string>): Point | null {
  let x = 0;
  let y = 0;
  for (const code of held) {
    const axis = MOVE_KEYS[code];
    if (!axis) continue;
    x += axis[0];
    y += axis[1];
  }
  return normalise(x, y);
}

/**
 * The direction toward a standing move order, or null once it is reached.
 *
 * A straight line, which is right whenever the way is clear and wrong the moment
 * it is not: a move order across a wall used to press the body into it and slide.
 * {@link routeTo} is the same question asked of the nav grid; this is what it
 * falls back to.
 */
export function steerTo(self: Point, destination: Point | null): Point | null {
  if (!destination) return null;
  const dx = destination.x - self.x;
  const dy = destination.y - self.y;
  if (Math.hypot(dx, dy) <= ARRIVE_EPS) return null;
  return normalise(dx, dy);
}

/**
 * A route for a move order, through the same grid the monsters use.
 *
 * Client-side on purpose. A move order is *input*: what it produces is the same
 * per-tick unit vector a held key produces, and the server validates it
 * identically. Keeping the routing here is what keeps prediction exact -- the
 * client predicts with the vector it sent. Routing it server-side would mean the
 * client either re-deriving the same path anyway or mispredicting every step
 * around every tree.
 *
 * `findPath` short-circuits to a straight line when nothing is in the way, so the
 * common case costs one segment test.
 */
export function routeTo(
  self: Point,
  destination: Point | null,
  world: PathWorld | null,
): Point | null {
  if (!destination) return null;
  if (Math.hypot(destination.x - self.x, destination.y - self.y) <= ARRIVE_EPS) return null;
  if (!world) return steerTo(self, destination);

  const waypoints = findPath(navGridFor(world.radius, world.colliders), self, destination);
  // Unreachable within the node budget: press toward it and let collision decide,
  // which is what a held key in the same direction would do.
  const next = waypoints[0];
  if (!next) return steerTo(self, destination);
  // A waypoint we are already standing on says nothing about which way to go.
  if (Math.hypot(next.x - self.x, next.y - self.y) <= 1e-6) {
    return steerTo(self, destination);
  }
  return normalise(next.x - self.x, next.y - self.y);
}

function normalise(x: number, y: number): Point | null {
  const length = Math.hypot(x, y);
  if (!Number.isFinite(length) || length <= 1e-6) return null;
  return { x: x / length, y: y / length };
}
