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

import { MOVE_EAST, MOVE_NORTH, MOVE_SOUTH, MOVE_WEST } from '../../../ui/input/actions.js';
import { PATH_RETRY_TICKS } from '../../../sim/constants.js';
import { findPath, navGridFor, pathClear, type NavGround } from '../../../sim/pathfinding.js';
import type { WorldColliders } from '../../../sim/types.js';

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** What {@link RoutePlanner} paths through: the world, and how wide the body is. */
export interface PathWorld {
  readonly colliders: WorldColliders;
  readonly radius: number;
  /**
   * The ground a route is planned over (spec 130). Omitted is flat, which is
   * what a sandbox has and what a test that only cares about trees wants.
   */
  readonly ground?: NavGround;
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
 * Which *actions* drive which way, in the sim's axes: +y is "down the screen"
 * (south), matching the terrain module's `z`.
 *
 * Four entries, not eight (spec 125). This used to be keyed by `KeyboardEvent.code`
 * and list WASD and the arrows separately -- which is two bindings of one action
 * spelled as two actions, and put "the arrows walk too" in a table no player
 * could reach. The arrows are now the secondary binding of these four, in
 * `src/ui/input/bindings.json`, where they can be changed.
 */
export const MOVE_ACTIONS: Readonly<Record<string, readonly [number, number]>> = {
  [MOVE_NORTH]: [0, -1],
  [MOVE_SOUTH]: [0, 1],
  [MOVE_WEST]: [-1, 0],
  [MOVE_EAST]: [1, 0],
};

/**
 * How close counts as arrived, in world units. Sized above one tick of travel at
 * any reachable speed, so a body cannot straddle the destination and jitter
 * across it forever.
 */
export const ARRIVE_EPS = 6;

/** Nothing taken out of the player's hands. */
export const NO_HOLD: ReadonlySet<string> = new Set<string>();

export interface SwingHoldInput {
  /** What this answered on the previous frame. */
  readonly previous: ReadonlySet<string>;
  /** Every action id physically down right now. */
  readonly held: ReadonlySet<string>;
  /**
   * The actions that were down when the press was made, or null when no ability
   * was asked for on this frame.
   *
   * A set rather than a boolean since spec 264, because a press may now be held
   * for a swing and sent several frames later: the directions that belong to it
   * are the ones the *press* was made with, and re-reading them at the send
   * would suppress a direction pressed in between -- which is a withdrawal
   * (spec 079), and is exactly what the player asked for by pressing it.
   *
   * An immediate press passes the live `held` set, which is the same thing.
   */
  readonly pressed: ReadonlySet<string> | null;
  /** A cast -- confirmed or only asked for -- is live. */
  readonly casting: boolean;
  /** That cast has passed its attack point (spec 144). */
  readonly committed: boolean;
}

/**
 * Which held directions a swing has taken out of the player's hands (spec 258).
 *
 * **Pressing an ability means "stop and swing".** Without this it means nothing
 * at all: `asksToMove` is how a body withdraws from a blow (spec 079) and a
 * withdrawal outranks a commit arriving on the same tick (spec 092), so a held
 * direction refuses the cast *before it starts* -- measured over a real
 * loopback, 173 swings asked for and **173 refused as `withdrawn`, none
 * started**. A player walking with WASD simply could not attack, silently, and
 * `castNow` clearing the move order did not help because a held key is not a
 * move order.
 *
 * So the four movement actions that are **already down at the moment of the
 * press** stop asking for anything, and the rule is edge-triggered rather than
 * a level, which is the whole of what makes it safe:
 *
 *  - a direction pressed *after* the commit is untouched, so withdrawing from a
 *    wind-up by stepping away -- the decision this game is built on -- still
 *    works exactly as it did;
 *  - a suppressed key that is **released** drops out, so pressing it again is a
 *    fresh ask and withdraws;
 *  - and the hold ends **at the attack point**, because past it walking is no
 *    longer a withdrawal but a walk-out of the follow-through, which is the
 *    thing Agility buys. A player who holds a direction through their own swing
 *    therefore leaves on the first tick the cancel point allows, with no second
 *    press -- the agile loop, for free.
 *
 * Pure, and the reason it is here rather than in `view.ts`: it is a rule about
 * what the player is asking for, which is what this module is.
 */
export function swingHold(input: SwingHoldInput): ReadonlySet<string> {
  // Past the attack point, or nothing to be committed to: the keys are the
  // player's again. Checked before the press so a commit and a fresh press on
  // one frame leave the *press* deciding, which is the later intent.
  const carried =
    input.casting && !input.committed
      ? [...input.previous].filter((action) => input.held.has(action))
      : [];
  if (!input.pressed) return carried.length === 0 ? NO_HOLD : new Set(carried);
  const next = new Set(carried);
  for (const action of input.pressed) {
    // Still down, which is the release-drops-out rule reused rather than
    // restated: a key let go between a queued press and its send is a key the
    // player has taken back, and pressing it again withdraws.
    if (action in MOVE_ACTIONS && input.held.has(action)) next.add(action);
  }
  return next;
}

/** The held set with whatever a swing is holding taken out of it. */
export function heldAfterHold(
  held: ReadonlySet<string>,
  hold: ReadonlySet<string>,
): ReadonlySet<string> {
  if (hold.size === 0) return held;
  const free = new Set(held);
  for (const action of hold) free.delete(action);
  return free;
}

export interface IntentInput {
  /** Action ids currently held. See {@link MOVE_ACTIONS}. */
  readonly held: ReadonlySet<string>;
  /** Where the body is now -- the predicted position, not the replica. */
  readonly self: Point;
  /** The standing move order from the last right-click, or null. */
  readonly destination: Point | null;
  /**
   * The next waypoint on the way to `destination`, from {@link RoutePlanner},
   * or null to walk straight at it.
   *
   * Arrival is still measured against `destination` -- reaching a waypoint is
   * not reaching the order, and clearing the order there would strand the player
   * at the first corner.
   */
  readonly route: Point | null;
  /** The body's current heading, kept when nothing asks for a new one. */
  readonly facing: number;
  /**
   * The aim of the cast in progress, or null when not casting.
   *
   * Two things at once, both mirroring the server. The server roots a caster
   * that asks for nothing (`world.ts` zeroes the movement components while
   * `cast !== null`), so predicting a walk here would diverge on every tick of
   * every wind-up. And the server turns the body *into* its captured aim over
   * the wind-up (`resolveFacing`), so the heading asked for while casting is
   * that aim and not whatever the keys say.
   *
   * Only while nothing else is asked for, since spec 079: a key or a move order
   * withdraws from the cast on the server, so it has to steer here too.
   */
  readonly castAim: Point | null;
  /**
   * True while the follow-through this body is in may not yet be left
   * (spec 258).
   *
   * The one thing that makes {@link castAim} outrank a direction. A wind-up is
   * withdrawn from *by* asking to move, so a direction beating the root there is
   * the feature; a committed follow-through cannot be withdrawn from at all
   * until its cancel point, so during that window the server holds the body
   * whatever this asks for, and asking anyway is a walk predicted against a
   * server standing still.
   *
   * Optional, because the two sandboxes and the tests that drive `moveIntent`
   * directly have no server to be committed to; absent reads as "free", which is
   * how they behaved before this existed.
   */
  readonly committed?: boolean;
  /**
   * Where a drop this client has asked for is aimed, or null (spec 172).
   *
   * Ranked under {@link castAim} and over everything else, including a
   * direction -- which is the one place this list is not simply "the most
   * specific ask wins". A step withdraws from a cast, so a cast aim that lost
   * to a direction was about to stop existing anyway; a drop is not withdrawn
   * from by walking, because there is nothing to refund and nothing rooted. So
   * a body that asked to put something down and then set off keeps coming round
   * to it while it walks, which is exactly what the server is doing with the
   * same aim.
   */
  readonly dropAim?: Point | null;
  /**
   * The mark of a standing attack order, or null (spec 090).
   *
   * Faced while *waiting* to swing at it. With a target in reach and the attack
   * still on cooldown, `autoAttack` asks for nothing at all -- no cast, no chase
   * -- and without this the body keeps whatever heading it had until the blow
   * finally commits. The turn then happens *after* the wait rather than during
   * it: click, stand facing the wrong way for up to a whole attack delay, turn,
   * and only then wind up. At spec 088's 1.2s that is most of two seconds, and
   * nearly all of it dead.
   *
   * Outranked by {@link castAim}, because a committed blow's aim was captured at
   * the commit and is the authority on where the body is pointing, and by any
   * direction, because walking decides its own heading.
   */
  readonly targetAim?: Point | null;
  /**
   * Somebody a conversation has just started with (spec 246), or null.
   *
   * A **one-shot**, and that is the whole difference from {@link targetAim}
   * beside it: this is set at the moment a conversation opens and dropped the
   * instant the body has come round, so it turns you to face the merchant and
   * then lets go. The player is free to walk off mid-sentence -- which is also
   * how a conversation ends -- and a version of this that held the heading for
   * the duration would fight them every time they stopped moving.
   *
   * In `targetAim`'s slot in the order below, and for its reason: a held key
   * outranks it, because walking decides its own heading.
   */
  readonly talkAim?: Point | null;
  /**
   * True while a poise break holds this body (spec 173).
   *
   * Outranks every other branch below, including {@link castAim} and a held
   * key, because on the server it outranks them too: the movement pass zeroes
   * the components *and pins the facing to where the body already points*, so a
   * staggered body neither steps nor turns however the keys are being held.
   *
   * The facing half is the part that is easy to miss and the part that shows.
   * Movement is reconciled -- a `Correction` carries a position, so a predicted
   * step the server discarded is pulled back within a round trip -- and facing
   * is not carried on one at all. A drawn heading that keeps turning through a
   * stagger is therefore an error nothing ever corrects; it is only diluted by
   * whatever the player does next. So the one place it can be prevented is
   * here, by not asking for the turn in the first place.
   */
  readonly staggered?: boolean;
  /**
   * True while this body is at zero health (spec 229).
   *
   * Outranks every branch below, including {@link staggered}, because on the
   * server it outranks them by not being a branch at all: `stepWorld`'s
   * movement pass steps past anything at zero health *before* it reads an
   * intent, so a corpse is neither moved nor turned however the keys are being
   * held.
   *
   * Which makes this the one root nothing ever pulls back. A stagger is
   * reconciled -- the server reads the intent, discards the components and
   * corrects the step -- and a corpse is never read, so it is never corrected
   * either: a predicted walk while dead stands until the respawn teleport,
   * seconds later, and is bounded only by how far the order was. Measured
   * before this existed, one second of a standing move order walked a body 155
   * units across its own screen while every other client watched it lie where
   * it fell.
   *
   * Here rather than in the drivers because there are six doors into a
   * destination -- a key, a move order, a chase, an aim's approach, a pickup
   * walk, a walk over to somebody to talk to -- and being dead is a fact about
   * the body rather than about any of them. `autoAttack` and `approachOrderFor` keep their own death rules because
   * they also decide whether to *ask the server for something*, which a rule at
   * the legs cannot cover.
   */
  readonly dead?: boolean;
}

export function moveIntent(input: IntentInput): MoveIntent {
  const keyed = keyDirection(input.held);
  // Arrival is measured against the *order*, never against a waypoint: reaching
  // a corner is not reaching where you were going, and clearing the order there
  // would strand the player at the first turn.
  const arrived =
    keyed === null && input.destination !== null && steerTo(input.self, input.destination) === null;
  // Keys outrank a standing order: grabbing WASD is how you take manual control
  // back, and having to cancel an order first would feel like a stuck key. A
  // spent order steers nothing, whatever waypoint is still on offer.
  const direction = keyed ?? (arrived ? null : steerTo(input.self, input.route ?? input.destination));

  // A corpse does neither (spec 229), and does it first: a stagger is something
  // the server reads and discards, and a dead body is one it never reads at
  // all. `input.facing` for the same reason the stagger holds it -- the server
  // leaves `facing` exactly where it was, and a `Correction` carries no facing
  // to disagree with, so a heading predicted here would be an error nothing
  // ever corrects.
  //
  // `arrived` is still reported honestly. Being dead is not being somewhere,
  // and a caller that reads it as "the order is spent" is right either way --
  // the view drops the orders at the death itself.
  if (input.dead) {
    return { moveX: 0, moveY: 0, facing: input.facing, arrived };
  }

  // A poise break holds the body outright (spec 173), and holds it harder than
  // a cast does: no step, and no turn either.
  //
  // First, so it beats the wind-up aim and a held key both. It has to beat the
  // key in particular, because that is the one branch a player is actively
  // driving -- somebody who was walking when they were broken is still holding
  // the key, and every other branch here would happily keep asking for the
  // heading it implies.
  //
  // `input.facing` rather than any aim: the server holds `steered.facing`, so
  // the only heading that agrees with it is the one the body already has.
  if (input.staggered) {
    return { moveX: 0, moveY: 0, facing: input.facing, arrived };
  }

  // Rooted, and turning into the blow. Asking for the aim rather than holding
  // the old heading is what makes the figure visibly come round during a
  // wind-up: the server is already turning it, and a client that kept asking for
  // its previous heading simply drew a body that never moved.
  //
  // A direction outranks the root since spec 079: asking to move *is* how a
  // commitment is withdrawn from, and the server acts on it the tick it arrives.
  // Holding the body still here would be predicting a stand the server is about
  // to turn into a step.
  //
  // Except inside a committed follow-through (spec 258), where there is no
  // withdrawal to be had: the server refuses it and holds the body, so the root
  // wins and the same held key walks the moment the cancel point is reached.
  if (input.castAim && (!direction || input.committed === true)) {
    const dx = input.castAim.x - input.self.x;
    const dy = input.castAim.y - input.self.y;
    const facing = Math.hypot(dx, dy) < 1e-6 ? input.facing : Math.atan2(dy, dx);
    return { moveX: 0, moveY: 0, facing, arrived };
  }

  // Turning to put something down (spec 172). Over the direction rather than
  // under it: the walk still happens -- `direction` is what moves the body --
  // and only the heading is the drop's. See the field.
  if (input.dropAim) {
    const dx = input.dropAim.x - input.self.x;
    const dy = input.dropAim.y - input.self.y;
    const facing = Math.hypot(dx, dy) < 1e-6 ? input.facing : Math.atan2(dy, dx);
    return { moveX: direction?.x ?? 0, moveY: direction?.y ?? 0, facing, arrived };
  }

  // Standing over a mark, waiting for the swing to come off cooldown. Turning
  // now is free -- the wait is dead time -- and it means the wind-up starts
  // already aligned rather than paying for the turn once the clock has run
  // (spec 090). The server turns the body from this at its own rate, so it is
  // the same turn every other player sees.
  // Coming round to face somebody you have just spoken to (spec 246). Beside
  // `targetAim` rather than above or below it because the two cannot both be
  // set: a friendly body is never an attack target.
  const standingAim = input.targetAim ?? input.talkAim;
  if (!direction && standingAim) {
    const dx = standingAim.x - input.self.x;
    const dy = standingAim.y - input.self.y;
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
    // Reported, not hardcoded false. Steering and arriving are separate
    // questions: a waypoint can still be pulling us along after the order itself
    // has been reached, and saying "not arrived" there would leave the order
    // standing forever.
    arrived,
  };
}

/**
 * How close two headings have to be before a turn counts as finished.
 *
 * Deliberately loose. What reads this is a one-shot aim being let go of
 * (spec 246), and the cost of being a degree out is nothing at all, where the
 * cost of a threshold too tight is an aim that never clears -- `turnToward`
 * approaches its goal and a body whose turn rate is scaled by a modifier can
 * sit a hair short of it for a long time.
 */
const ALIGNED_RADIANS = 0.05;

/** Whether a body pointing `facing` has arrived at `wanted`. */
export function aligned(facing: number, wanted: number): boolean {
  // Through sin/cos rather than by subtracting, so the wrap at pi is not a
  // special case: two headings either side of it are close, and the difference
  // of the numbers is not.
  return Math.abs(Math.atan2(Math.sin(facing - wanted), Math.cos(facing - wanted))) <= ALIGNED_RADIANS;
}

/** The normalised direction the held keys ask for, or null when they cancel out. */
function keyDirection(held: ReadonlySet<string>): Point | null {
  let x = 0;
  let y = 0;
  for (const code of held) {
    const axis = MOVE_ACTIONS[code];
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
 * {@link RoutePlanner} is the same question asked of the nav grid; this is what
 * it falls back to, and what it steers along between waypoints.
 */
export function steerTo(self: Point, destination: Point | null): Point | null {
  if (!destination) return null;
  const dx = destination.x - self.x;
  const dy = destination.y - self.y;
  if (Math.hypot(dx, dy) <= ARRIVE_EPS) return null;
  return normalise(dx, dy);
}

/**
 * How far the destination may drift before a planned route is stale. A move
 * order does not move, so this only fires when the caller re-points it.
 */
const REPLAN_DISTANCE = 48;

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
 * Stateful, and deliberately so: the first cut re-ran `findPath` every tick,
 * which is a full A* sixty times a second for as long as an order stands. The
 * monsters have carried their route on the entity since spec 065 for exactly
 * this reason; this is the same bookkeeping, in the only place a player's order
 * lives. No clock and no DOM -- the tick is passed in -- so it is testable.
 */
export class RoutePlanner {
  private path: readonly Point[] = [];
  private index = 0;
  private goal: Point | null = null;
  private replanAtTick = 0;
  /**
   * Whether `path` is a search's answer or just the empty start. The server
   * carries `path: null` for "never asked"; here the two states share `[]`, and
   * the retry backoff needs to tell an unreachable order from a fresh one.
   */
  private searched = false;

  /** The waypoints currently planned, for tests and for drawing the route. */
  get waypoints(): readonly Point[] {
    return this.path.slice(this.index);
  }

  /** How many searches this planner has run. The thing the cache exists to hold down. */
  searches = 0;

  clear(): void {
    this.path = [];
    this.index = 0;
    this.goal = null;
    this.replanAtTick = 0;
    this.searched = false;
  }

  /**
   * The next point to walk toward, or null to walk straight at `destination`.
   *
   * Null is the common answer: when nothing is between the body and its order
   * there is no route to follow and none is planned, so an unobstructed march
   * across open ground never touches the grid.
   */
  next(
    self: Point,
    destination: Point | null,
    world: PathWorld | null,
    tick: number,
    replanEvery = 20,
  ): Point | null {
    if (!destination || !world) {
      this.clear();
      return null;
    }
    const grid = navGridFor(world.radius, world.colliders, world.ground);
    // The ground is part of "nothing is between us" (spec 130): a cliff is not a
    // collider, so this used to send a move order straight into one.
    if (pathClear(grid, self, destination)) {
      this.clear();
      return null;
    }

    // A search that came back empty leaves the same empty path as a route walked
    // to its end, and `index >= path.length` cannot tell them apart -- which had
    // an order onto unreachable ground re-running a full A* every frame, the one
    // case this planner exists to prevent (spec 073). A failure waits out
    // `PATH_RETRY_TICKS`, and a target shuffling about is no reason to ask
    // sooner: what is unreachable here is unreachable a body's length away.
    const failed = this.searched && this.path.length === 0;
    const goalMoved =
      !failed &&
      (this.goal === null ||
        Math.hypot(this.goal.x - destination.x, this.goal.y - destination.y) > REPLAN_DISTANCE);
    const exhausted = !failed && this.index >= this.path.length;

    if (goalMoved || exhausted || tick >= this.replanAtTick) {
      this.path = findPath(grid, self, destination);
      this.index = 0;
      this.goal = destination;
      this.searched = true;
      this.replanAtTick = tick + (this.path.length === 0 ? PATH_RETRY_TICKS : replanEvery);
      this.searches += 1;
    }

    // Consume every waypoint already reached; a fast body can clear more than
    // one in a tick once a string-pull has left them far apart.
    while (this.index < this.path.length) {
      const point = this.path[this.index];
      if (!point) break;
      if (Math.hypot(point.x - self.x, point.y - self.y) > ARRIVE_EPS) break;
      this.index += 1;
    }

    // Unreachable, or nothing left: press toward the order and let collision
    // decide, which is what a held key in the same direction would do.
    return this.path[this.index] ?? null;
  }
}

function normalise(x: number, y: number): Point | null {
  const length = Math.hypot(x, y);
  if (!Number.isFinite(length) || length <= 1e-6) return null;
  return { x: x / length, y: y / length };
}
