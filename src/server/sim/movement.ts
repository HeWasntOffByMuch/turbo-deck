/**
 * Server-authoritative movement (spec 056).
 *
 * A client sends a *direction*, not a position. This module turns that into the
 * one position the server will accept, by walking the same distance the
 * player's derived speed allows, sliding along the same colliders the
 * single-player sim uses (`src/sim/collision.ts`, reused rather than
 * reimplemented), and refusing any step the heightfield says is a cliff or open
 * water.
 *
 * The client's own predicted position rides along in the input purely so this
 * function can measure it. Two things can be wrong with it:
 *
 *  - it is further from the last authoritative position than one tick of
 *    movement could possibly carry it -- a speed hack, and the correction is
 *    unconditional;
 *  - it merely disagrees with the server by more than the threshold -- ordinary
 *    drift, and the correction is a nudge.
 *
 * Under the threshold nothing is sent at all. That silence is the entire point
 * of client-side prediction: a correct prediction should cost no bandwidth and
 * produce no visible snap.
 */

import { slideCircle, pushOutOfObstacles } from '../../sim/collision.js';
import type { Vec2, WorldColliders } from '../../sim/types.js';
import type { LiveConfig } from '../config.js';
import { SERVER_TICK_RATE } from '../config.js';
import { CorrectionReason } from '../net/protocol.js';
import type { Vec3 } from '../state/types.js';
import { MAX_STEP_HEIGHT, WALKABLE_MIN_HEIGHT, type TerrainSampler } from '../world/terrain.js';
import type { ServerEntity, ServerInput } from './types.js';

export interface MovementContext {
  readonly world: WorldColliders;
  readonly terrain: TerrainSampler;
  readonly config: LiveConfig;
}

export interface MovementOutcome {
  readonly position: Vec3;
  readonly facing: number;
  /** A {@link CorrectionReason}, or null when the client's prediction was fine. */
  readonly correctionReason: number | null;
  /** Residual knockback after this tick's decay. */
  readonly knockbackX: number;
  readonly knockbackY: number;
}

/** Knockback bleeds off by this fraction per tick, so it eases rather than stops dead. */
const KNOCKBACK_DECAY = 0.6;

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;

/** The signed turn from `from` to `to`, in (-PI, PI]. */
function shortestTurn(from: number, to: number): number {
  let delta = (to - from) % TAU;
  if (delta > Math.PI) delta -= TAU;
  if (delta <= -Math.PI) delta += TAU;
  return delta;
}

/**
 * Rotate `from` toward `to` by at most one tick of `turnRateDegPerSecond`.
 *
 * A body turns; it does not teleport its heading. Until spec 064 this was
 * derived from stats, replicated on the wire, and then never read -- facing was
 * whatever the client's last input said it was, so a unit could reverse
 * instantly and a 240-degree-per-second stat meant nothing.
 *
 * Exported because the client predicts facing with it too. There is one turn
 * rule and it lives here; a second implementation on the client is how the drawn
 * heading and the authoritative one drift apart.
 */
export function turnToward(
  from: number,
  to: number,
  turnRateDegPerSecond: number,
  tickRate: number,
): number {
  if (!Number.isFinite(to)) return from;
  if (!Number.isFinite(from)) return to;
  const delta = shortestTurn(from, to);
  // A turn rate of zero is a body that cannot turn at all (a training dummy),
  // not a body that turns instantly.
  const step = Math.max(0, turnRateDegPerSecond) * DEG / tickRate;
  if (Math.abs(delta) <= step) return to;
  return from + Math.sign(delta) * step;
}

function distance(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(ax - bx, ay - by);
}

/**
 * Clamps the client's direction to a unit vector. A client that sends a longer
 * one is asking to move further than a tick allows; normalising rather than
 * rejecting means a buggy client just moves at the right speed instead of being
 * kicked, while a cheating one gains nothing.
 */
function clampDirection(moveX: number, moveY: number): Vec2 {
  if (!Number.isFinite(moveX) || !Number.isFinite(moveY)) return { x: 0, y: 0 };
  const length = Math.hypot(moveX, moveY);
  if (length <= 1e-6) return { x: 0, y: 0 };
  if (length <= 1) return { x: moveX, y: moveY };
  return { x: moveX / length, y: moveY / length };
}

/** True when the ground at a point is somewhere a body may legally stand. */
export function isWalkable(
  from: Vec3,
  x: number,
  y: number,
  terrain: TerrainSampler,
): boolean {
  const height = terrain.heightAt(x, y);
  if (height <= WALKABLE_MIN_HEIGHT) return false;
  return Math.abs(height - from.z) <= MAX_STEP_HEIGHT;
}

export function resolveMovement(
  entity: ServerEntity,
  input: ServerInput | null,
  tick: number,
  context: MovementContext,
): MovementOutcome {
  const { world, terrain, config } = context;
  const from: Vec2 = { x: entity.position.x, y: entity.position.y };

  // Hitstop freezes the body outright; knockback still carries it, because
  // being frozen in place mid-knockback reads as the hit not landing.
  const frozen = tick < entity.hitstopUntilTick;
  const knocked = tick < entity.knockbackUntilTick;

  let dx = 0;
  let dy = 0;
  if (knocked) {
    dx += entity.knockbackX;
    dy += entity.knockbackY;
  }

  const maxStep = entity.stats.moveSpeed / SERVER_TICK_RATE;
  if (!frozen && !knocked && input) {
    const direction = clampDirection(input.moveX, input.moveY);
    dx += direction.x * maxStep;
    dy += direction.y * maxStep;
  }

  let landed: Vec2 = dx === 0 && dy === 0 ? from : slideCircle(from, dx, dy, entity.radius, world);

  // The heightfield half of collision. `slideCircle` knows about walls and
  // vegetation; it knows nothing about a cliff face or a lake, so those are
  // checked here and refused by simply not moving.
  let blockedByTerrain = false;
  if ((landed.x !== from.x || landed.y !== from.y) && !isWalkable(entity.position, landed.x, landed.y, terrain)) {
    // Try each axis alone before giving up, so running along a shoreline slides
    // rather than sticking.
    const alongX = { x: landed.x, y: from.y };
    const alongY = { x: from.x, y: landed.y };
    if (alongX.x !== from.x && isWalkable(entity.position, alongX.x, alongX.y, terrain)) {
      landed = alongX;
    } else if (alongY.y !== from.y && isWalkable(entity.position, alongY.x, alongY.y, terrain)) {
      landed = alongY;
    } else {
      landed = from;
      blockedByTerrain = true;
    }
  }

  const settled = pushOutOfObstacles(landed, entity.radius, world);
  const position: Vec3 = {
    x: settled.x,
    y: settled.y,
    z: terrain.heightAt(settled.x, settled.y),
  };

  const facing = resolveFacing(entity, input, frozen);

  const nextKnockbackX = knocked ? entity.knockbackX * KNOCKBACK_DECAY : 0;
  const nextKnockbackY = knocked ? entity.knockbackY * KNOCKBACK_DECAY : 0;

  return {
    position,
    facing,
    correctionReason:
      input && input.hasPrediction
        ? correctionFor(input, entity.claimedPosition, position, maxStep, blockedByTerrain, config)
        : null,
    knockbackX: nextKnockbackX,
    knockbackY: nextKnockbackY,
  };
}

/**
 * Where the body wants to be looking, and how far it gets this tick.
 *
 * A cast in progress outranks the input: the aim was captured when the blow was
 * committed, so the body turns *into* the blow over its wind-up rather than
 * snapping to it the instant the key went down. That turn is visible and it is
 * the readable half of committing -- and it changes no outcome, because a melee
 * cone is measured from `cast.targetX/Y`, not from where the body is looking.
 *
 * Frozen bodies do not turn. Being stunned and still able to pivot on the spot
 * is how a hitstop stops reading as a hit.
 */
function resolveFacing(entity: ServerEntity, input: ServerInput | null, frozen: boolean): number {
  if (frozen) return entity.facing;

  const cast = entity.cast;
  const wanted = cast
    ? Math.atan2(cast.targetY - entity.position.y, cast.targetX - entity.position.x)
    : input && Number.isFinite(input.facing)
      ? input.facing
      : entity.facing;

  return turnToward(entity.facing, wanted, entity.stats.turnRate, SERVER_TICK_RATE);
}

/**
 * Decides whether the client needs telling. Ordered most-serious first, so an
 * impossible move is reported as a speed violation rather than as drift that
 * happens to be large.
 *
 * `previousClaim` is the client's own last predicted position, not the server's
 * last authoritative one -- see {@link ServerEntity.claimedPosition} for why
 * that distinction is the difference between a working speed check and one that
 * flags every player with a ping.
 */
function correctionFor(
  input: ServerInput,
  previousClaim: { readonly x: number; readonly y: number } | null,
  authoritative: Vec3,
  maxStep: number,
  blockedByTerrain: boolean,
  config: LiveConfig,
): number | null {
  const predictedX = input.predictedX;
  const predictedY = input.predictedY;
  if (!Number.isFinite(predictedX) || !Number.isFinite(predictedY)) {
    return CorrectionReason.Divergence;
  }

  // The first input has nothing to compare against; one free tick of movement
  // is not worth a correction, and the divergence check below still applies.
  if (previousClaim !== null) {
    const claimedTravel = distance(predictedX, predictedY, previousClaim.x, previousClaim.y);
    if (claimedTravel > maxStep * config.speedTolerance) return CorrectionReason.SpeedViolation;
  }

  const drift = distance(predictedX, predictedY, authoritative.x, authoritative.y);
  if (blockedByTerrain && drift > 1) return CorrectionReason.Collision;
  if (drift > config.correctionThreshold) return CorrectionReason.Divergence;
  return null;
}
