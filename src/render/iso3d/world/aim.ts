/**
 * Aiming a skill, and the order a confirmed aim becomes (spec 080).
 *
 * A hotbar press used to be the commitment: it read whatever ground point the
 * cursor was over and sent the cast. This puts a step in front of it. The press
 * starts an *aim* -- the shape of the blow, drawn -- a left-click confirms it,
 * and only then does the body walk into range and commit.
 *
 * Everything here is client-side and pure, for the reason `target.ts` gives
 * about the attack order: an aim is **input**. What it produces is a per-tick
 * move vector and one ability request, both of which the server validates
 * exactly as it validates a held key and a right-click. Nothing in this file
 * decides whether a blow lands, what it costs, or whether it was allowed --
 * `startCast` answers all three and refuses whatever it does not like.
 *
 * Pure -- a few numbers in, a decision out, no DOM and no clock -- so "does the
 * body stop walking and throw the thing" is answerable in Node.
 */

import type { AbilityDefinition } from '../../../server/data/abilities.js';
import { HOLD_FRACTION, STANDOFF_FRACTION, type Point, type TargetSnapshot } from './target.js';

/** What the player has to supply before an ability may be asked for. */
export type AimGesture =
  /** Nothing: it casts on the press. */
  | 'none'
  /** A body, picked by left-clicking it. */
  | 'unit'
  /** A point, picked by left-clicking the ground. */
  | 'ground';

/**
 * The gesture an ability asks for, which is a total function of its targeting
 * mode -- what you have to supply and what the blow resolves against are the
 * same thing, so there is one field and this reads it.
 */
export function aimGesture(ability: AbilityDefinition): AimGesture {
  switch (ability.targeting) {
    case 'self':
      return 'none';
    case 'unit':
      return 'unit';
    case 'point':
    case 'direction':
      return 'ground';
  }
}

/** What a hotbar press turns into. */
export type AimStart =
  /** Nothing to aim: ask for it now. */
  | { readonly kind: 'cast' }
  /** Draw the shape and wait for the click that answers it. */
  | { readonly kind: 'aim'; readonly gesture: AimGesture }
  /** Not the player's to make yet. Nothing is drawn, and nothing is sent. */
  | { readonly kind: 'refused'; readonly reason: 'onCooldown' };

export interface AimStartInput {
  /** The tick this ability is ready again, from the server's own table. */
  readonly readyAtTick: number;
  /** The client's estimate of the server's tick. */
  readonly tick: number;
}

/**
 * What a press does, decided in one place before anything is drawn.
 *
 * An aim is refused while its ability is on cooldown rather than started and
 * left standing. A shape on the ground that cannot be thrown is a place to park
 * a press until the timer comes back, which is a queue -- and the whole point of
 * a wind-up you can be seen entering is that what you commit to is something you
 * can do *now*.
 *
 * The cooldown is the server's own number played back, exactly as `autoAttack`
 * plays it back to decide whether a swing is worth asking for. The client never
 * decides when something is ready; it decides whether asking is worth the round
 * trip, and a request the server would refuse costs a `castRejected` and a
 * cooldown guess to take back again.
 *
 * A `'self'` cast is gated too, though it has nothing to aim. One rule reads
 * better than "gated, except the instant ones", and the answer is the one the
 * server would have sent back a tick later anyway.
 */
export function startAim(ability: AbilityDefinition, input: AimStartInput): AimStart {
  if (input.tick < input.readyAtTick) return { kind: 'refused', reason: 'onCooldown' };
  const gesture = aimGesture(ability);
  return gesture === 'none' ? { kind: 'cast' } : { kind: 'aim', gesture };
}

/** What to draw on the ground while aiming. */
export type AimShape =
  | { readonly kind: 'none' }
  | { readonly kind: 'circle'; readonly radius: number }
  | { readonly kind: 'cone'; readonly halfAngle: number; readonly length: number }
  | { readonly kind: 'line'; readonly length: number; readonly width: number };

/**
 * The shape of the blow, read off the numbers the blow is actually made of.
 *
 * Derived rather than declared, so retuning a radius moves the picture with it
 * and there is no third field that has to be kept agreeing with the other two.
 * The order of the tests is the order of specificity: a body first, then a
 * wedge, then a burst, then the lane a shot flies down.
 */
export function aimShape(ability: AbilityDefinition): AimShape {
  // A named body is its own indicator -- the ring goes under it, and a wedge
  // drawn beside it would say something about the blow that is not true.
  if (ability.targeting === 'self' || ability.targeting === 'unit') return { kind: 'none' };
  if (ability.arcCosSq !== undefined) {
    // `arcCosSq` is the squared cosine of the half-angle, which is how
    // `isInCone` avoids a square root per candidate. Undoing it here costs one
    // acos per frame and gets the wedge the sim will actually test.
    const cos = Math.sqrt(Math.max(0, Math.min(1, ability.arcCosSq)));
    return { kind: 'cone', halfAngle: Math.acos(cos), length: ability.range };
  }
  if (ability.radius !== undefined) return { kind: 'circle', radius: ability.radius };
  if (ability.projectile) {
    return { kind: 'line', length: ability.range, width: ability.projectile.radius * 2 };
  }
  return { kind: 'none' };
}

/** A confirmed aim: what to cast, and where it was placed. */
export interface AimOrder {
  readonly abilityId: string;
  /** The body named, or 0 for an order placed on the ground. */
  readonly targetEntityId: number;
  /** Where it was placed. For a unit order this is re-read from the body. */
  readonly x: number;
  readonly y: number;
  /** The ability's range, from the server's own table. */
  readonly range: number;
}

export interface CastOrderInput {
  /** Where we are: the predicted position, not the replica. */
  readonly self: Point;
  readonly order: AimOrder | null;
  /**
   * The named body as the view last saw it, or null when the order was placed
   * on the ground -- or when the body it named is no longer in the world.
   */
  readonly target: TargetSnapshot | null;
  /**
   * True while a cast is in progress. A committed body neither walks nor
   * re-commits (spec 079); chasing now would withdraw from the wind-up on the
   * player's behalf, and asking would earn an `alreadyCasting` refusal.
   */
  readonly rooted: boolean;
  /**
   * True while a poise break holds this body (spec 169).
   *
   * Its own field beside {@link rooted}, and it has to be: a break *clears* the
   * cast it interrupted (`applyPoiseDamage` nulls it), so `rooted` -- which is
   * "a cast is in progress" -- is false for the whole stagger. An order left to
   * run on `rooted` alone therefore treats a stunned body as a free one: it
   * chases, and in reach it sends a `useAbility` the server answers with
   * `'staggered'`, then drops the order as though it had been spent.
   */
  readonly staggered: boolean;
  /** The tick this ability is ready again, from the server's own table. */
  readonly readyAtTick: number;
  /** The client's estimate of the server's tick. */
  readonly tick: number;
}

export interface CastOrderStep {
  /**
   * Where to walk to close the gap, or null when there is nothing to close. The
   * caller feeds it to `moveIntent` as an ordinary destination, so an approach
   * is routed round trees by the same planner a right-click on the ground uses.
   */
  readonly chaseTo: Point | null;
  /** The request to send this tick, or null. Sending it consumes the order. */
  readonly cast: {
    readonly abilityId: string;
    readonly x: number;
    readonly y: number;
    readonly targetEntityId: number;
  } | null;
  /** The order is spent, or its mark is gone: the caller should forget it. */
  readonly drop: boolean;
}

const NOTHING: CastOrderStep = { chaseTo: null, cast: null, drop: false };

/**
 * One tick of a confirmed aim: close the gap, then throw it -- once.
 *
 * The rules are `autoAttack`'s, and the two standoff fractions are imported
 * from it rather than restated. There is one standoff, and the reasoning in
 * that file for why there have to be *two* numbers applies here unchanged: a
 * body that has to be *at* its destination to act stops within `ARRIVE_EPS` of
 * it and is therefore just outside its own threshold, forever.
 *
 * The one place it differs is the end. An attack order is a cadence and stands
 * until the body is down; this is a single blow, so the tick it asks is the
 * tick it drops.
 */
export function castOrder(input: CastOrderInput): CastOrderStep {
  const order = input.order;
  if (!order) return NOTHING;

  // A unit order outlives neither its mark's death nor its despawn. Dropping it
  // here rather than in the view means "when does an order stop" has one answer
  // and it is tested.
  const named = order.targetEntityId !== 0;
  if (named && (!input.target || input.target.health <= 0)) {
    return { chaseTo: null, cast: null, drop: true };
  }

  if (input.rooted) return NOTHING;

  // A broken body holds its order and does nothing with it (spec 169). Returned
  // as `NOTHING` rather than as a drop, for the same reason the standing attack
  // order keeps its mark: a stagger is half a second, and an order that
  // evaporated every time the player was hit would make a break cost the plan
  // as well as the footing.
  if (input.staggered) return NOTHING;

  // A unit order follows its mark: the body moves, so the placement is re-read
  // every tick rather than frozen at the click. A ground order stays put --
  // that is what placing it meant.
  const at = named && input.target ? { x: input.target.x, y: input.target.y } : { x: order.x, y: order.y };
  // Reach is measured to the body's edge on both ends (spec 079): `startCast`
  // gates a named cast at `range + radius`, so an approach that stopped at
  // `range` would leave a band that could be walked into and never cast from.
  const reach = order.range + (named && input.target ? input.target.radius : 0);

  const distance = Math.hypot(at.x - input.self.x, at.y - input.self.y);
  if (distance > reach * HOLD_FRACTION) {
    return { chaseTo: standoffPoint(input.self, at, reach), cast: null, drop: false };
  }

  // In reach, and not ready: the order is dropped rather than parked. It waits
  // on the range, because walking is what it is for, and on nothing else --
  // holding here is the queue `startAim` refuses a press to avoid, arrived at
  // by the back door. Unreachable while that gate holds, and this is what it
  // does if it ever stops.
  if (input.tick < input.readyAtTick) return { chaseTo: null, cast: null, drop: true };

  return {
    chaseTo: null,
    cast: { abilityId: order.abilityId, x: at.x, y: at.y, targetEntityId: order.targetEntityId },
    // One confirm is one cast. This is the whole difference between an aim and
    // the attack order it is otherwise shaped like.
    drop: true,
  };
}

/**
 * The point to walk to: on the line from the placement back toward us, a
 * standoff inside reach. Degenerate only when the two are on top of each other,
 * which cannot be out of reach, so the caller never sees it.
 */
function standoffPoint(self: Point, at: Point, reach: number): Point {
  const dx = self.x - at.x;
  const dy = self.y - at.y;
  const length = Math.hypot(dx, dy);
  if (!Number.isFinite(length) || length <= 1e-6) return { x: at.x, y: at.y };
  const stop = reach * STANDOFF_FRACTION;
  return { x: at.x + (dx / length) * stop, y: at.y + (dy / length) * stop };
}
