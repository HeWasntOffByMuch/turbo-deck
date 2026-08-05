/**
 * The sandbox mover (spec 066).
 *
 * All the movement sandbox and the rig debugger ever wanted from a simulation:
 * a position, a heading, and a standing move order. They used to get it from
 * `src/sim/combat.ts`, which was a whole second sim and is gone -- and reviving
 * it to walk a spider around a tuning viewport would be the worst possible
 * reason to have two of them.
 *
 * So this is a *mover*, not a sim. It decides no game outcome: no server sees
 * it, no other unit exists in the tabs that use it, and nothing it produces
 * travels further than the rig standing on it. What it does keep is the MOBA
 * feel the rigs were tuned against (spec 028) -- the body turns to face its
 * destination before it travels, so a 180-degree reversal costs turn time -- by
 * reusing the rules rather than restating them: `turnToward` from the server
 * (there is one turn rule and it lives there), the collision and pathfinding
 * helpers from `src/sim/`, and the movement constants those specs set.
 *
 * Pure and headlessly tested: given a start state and a sequence of inputs it
 * produces the same state on every run, which is what makes a rig regression
 * something a test can catch rather than something you have to watch for.
 */

import { characterAt, CHARACTERS, DEFAULT_CHARACTER_INDEX } from '../../sim/characters.js';
import { DEFAULT_WORLD, segmentClear, slideCircle } from '../../sim/collision.js';
import {
  MOVE_ARRIVE_EPS,
  MOVE_FACING_THRESHOLD_DEG,
  MOVE_SPEED_HARD_MAX,
  MOVE_SPEED_HARD_MIN,
  PATH_WAYPOINT_EPS,
  PLAYER_RADIUS,
  TICK_RATE,
} from '../../sim/constants.js';
import { findPath, navGridFor } from '../../sim/pathfinding.js';
import type { Vec2, WorldColliders } from '../../sim/types.js';
import { turnToward } from '../../server/sim/movement.js';

const DEG2RAD = Math.PI / 180;
const TWO_PI = Math.PI * 2;
const MOVE_FACING_THRESHOLD = MOVE_FACING_THRESHOLD_DEG * DEG2RAD;

/** The controllable body: where it stands, where it looks, and where it was told to go. */
export interface MoverState {
  readonly position: Vec2;
  readonly facing: number;
  /** The standing order, or null when there is none. Cleared on arrival. */
  readonly moveTarget: Vec2 | null;
  /** Waypoints around a wall, if the order needed routing; empty means "steer straight at it". */
  readonly path: readonly Vec2[];
  /** Which movement archetype is active (see `src/sim/characters.ts`). */
  readonly characterIndex: number;
}

/** One tick of intent. Every field is optional: an empty input is a quiet tick. */
export interface MoverInput {
  /** A right-click: a fresh destination, replacing any standing order. */
  readonly moveTarget?: Vec2;
  /** Cycle to the next archetype (C). */
  readonly cycleCharacter?: boolean;
  /** Live panel override for travel speed, in world units per second. */
  readonly moveSpeed?: number;
  /** Live panel override for turn rate, in degrees per second. */
  readonly turnRate?: number;
}

/** Wrap an angle into (-PI, PI]. */
function normalizeAngle(a: number): number {
  let x = a % TWO_PI;
  if (x <= -Math.PI) x += TWO_PI;
  else if (x > Math.PI) x -= TWO_PI;
  return x;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * The travel speed a tick actually uses: the panel's override when it is a
 * usable number, the archetype's otherwise, clamped to the same caps the game
 * has always had so a slider dragged to an extreme cannot teleport the body.
 */
export function moverSpeed(state: MoverState, input: MoverInput): number {
  const base = Number.isFinite(input.moveSpeed ?? NaN)
    ? (input.moveSpeed as number)
    : characterAt(state.characterIndex).moveSpeed;
  return Math.round(clamp(base, MOVE_SPEED_HARD_MIN, MOVE_SPEED_HARD_MAX));
}

/** The turn rate a tick actually uses, in degrees per second. Same override rule as the speed. */
export function moverTurnRate(state: MoverState, input: MoverInput): number {
  const base = Number.isFinite(input.turnRate ?? NaN)
    ? (input.turnRate as number)
    : characterAt(state.characterIndex).turnRate;
  return Math.max(0, base);
}

export function initMover(position: Vec2, characterIndex: number = DEFAULT_CHARACTER_INDEX): MoverState {
  return {
    position,
    facing: 0,
    moveTarget: null,
    path: [],
    characterIndex: ((characterIndex % CHARACTERS.length) + CHARACTERS.length) % CHARACTERS.length,
  };
}

/**
 * Route a fresh order (spec 037). A destination in plain sight needs no route --
 * the empty path means "steer straight at it" -- and one behind a wall is routed
 * once, since walls are static and there is nothing to replan. An unreachable
 * destination also yields no route: the body walks at it and presses on the wall.
 */
function routeOrder(from: Vec2, to: Vec2, world: WorldColliders): readonly Vec2[] {
  if (segmentClear(from, to, PLAYER_RADIUS, world)) return [];
  return findPath(navGridFor(PLAYER_RADIUS, world), from, to);
}

/**
 * Advance the body one tick.
 *
 * With no order it stands still and *keeps its heading* -- it does not rotate to
 * follow the cursor, or a standing body would already be facing every click
 * point and the turn rate the sandbox exists to show would never be visible.
 */
export function stepMover(
  state: MoverState,
  input: MoverInput = {},
  world: WorldColliders = DEFAULT_WORLD,
): MoverState {
  const characterIndex = input.cycleCharacter
    ? (state.characterIndex + 1) % CHARACTERS.length
    : state.characterIndex;

  // Apply this tick's order before moving, so a click takes effect on the tick
  // it arrived rather than the one after.
  let moveTarget = state.moveTarget;
  let path = state.path;
  const ordered = input.moveTarget;
  if (ordered) {
    const reissued =
      state.moveTarget !== null && ordered.x === state.moveTarget.x && ordered.y === state.moveTarget.y;
    moveTarget = ordered;
    path = reissued ? state.path : routeOrder(state.position, ordered, world);
  }

  const settled: MoverState = { ...state, characterIndex, moveTarget, path };
  if (moveTarget === null) return { ...settled, path: [] };

  const speedPerTick = moverSpeed(settled, input) / TICK_RATE;
  const turnRate = moverTurnRate(settled, input);

  // Drop route legs as they are reached; with no route this steers at the
  // destination itself, which is the unchanged straight-line case.
  while (path.length > 1) {
    const head = path[0];
    if (!head || Math.hypot(head.x - state.position.x, head.y - state.position.y) > PATH_WAYPOINT_EPS) break;
    path = path.slice(1);
  }
  const leg = path[0] ?? moveTarget;

  const dx = leg.x - state.position.x;
  const dy = leg.y - state.position.y;
  const dist = Math.hypot(dx, dy);
  const toTarget = Math.hypot(moveTarget.x - state.position.x, moveTarget.y - state.position.y);
  if (toTarget <= MOVE_ARRIVE_EPS) return { ...settled, moveTarget: null, path: [] };
  if (dist <= MOVE_ARRIVE_EPS) return { ...settled, path };

  const desired = Math.atan2(dy, dx);
  const facing = normalizeAngle(turnToward(state.facing, desired, turnRate, TICK_RATE));
  // Gate closed: still facing too far off, so rotate in place and don't travel yet.
  if (Math.abs(normalizeAngle(desired - facing)) > MOVE_FACING_THRESHOLD) {
    return { ...settled, facing, path };
  }

  // Gate open: travel straight at this leg (no arcing along a lagging heading).
  const step = Math.min(speedPerTick, dist);
  const position = slideCircle(state.position, (dx / dist) * step, (dy / dist) * step, PLAYER_RADIUS, world);
  const arrived = Math.hypot(moveTarget.x - position.x, moveTarget.y - position.y) <= MOVE_ARRIVE_EPS;
  return {
    position,
    facing,
    moveTarget: arrived ? null : moveTarget,
    path: arrived ? [] : path,
    characterIndex,
  };
}
