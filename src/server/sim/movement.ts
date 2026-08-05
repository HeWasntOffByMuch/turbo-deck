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
 * function can measure it. Three things can be wrong with it:
 *
 *  - it is further from the last claim than the inputs it spans could possibly
 *    carry it -- a speed hack, and the correction is unconditional;
 *  - it disagrees with the server by more than the threshold -- the prediction
 *    is badly wrong, and the correction is a snap;
 *  - it disagrees at all, by more than {@link DRIFT_EPSILON} -- ordinary drift,
 *    and the correction is a nudge the client eases in (spec 067).
 *
 * That last tier is new, and it is the one that keeps the other two rare. Before
 * it, anything under 48 units was neither reported nor fixed, so every tick the
 * client guessed wrong banked error that could only ever grow -- invisible until
 * it crossed the threshold, and then a 48-unit jump. Correcting drift as it
 * happens costs one small message per delta at worst and nothing at all in the
 * common case.
 *
 * Because when the prediction is exact nothing is sent, silence still means the
 * client was right: a correct prediction costs no bandwidth and produces no
 * visible snap.
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
}

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;

/**
 * How far a client's claim may sit from the server's answer before it is worth
 * saying so (spec 067).
 *
 * A tenth of a tick's walk at the default speed, and four orders of magnitude
 * above the f32 rounding the wire puts on a position, so an agreeing client is
 * silent and a disagreeing one is heard on the tick it disagrees.
 */
export const DRIFT_EPSILON = 0.25;

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
  context: MovementContext,
): MovementOutcome {
  const { world, terrain, config } = context;
  const from: Vec2 = { x: entity.position.x, y: entity.position.y };

  let dx = 0;
  let dy = 0;

  const maxStep = entity.stats.moveSpeed / SERVER_TICK_RATE;
  if (input) {
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

  const facing = resolveFacing(entity, input);

  return {
    position,
    facing,
    correctionReason:
      input && input.hasPrediction
        ? correctionFor(input, entity, position, maxStep, blockedByTerrain, config)
        : null,
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
 */
function resolveFacing(entity: ServerEntity, input: ServerInput | null): number {
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
 * The claim is measured against the entity's own last claim, not against the
 * server's last authoritative position -- see {@link ServerEntity.claimedPosition}
 * for why that distinction is the difference between a working speed check and
 * one that flags every player with a ping. Two things widen it (spec 067):
 * an input that spans several sequence numbers gets that many ticks of
 * allowance, and the position of the last correction is pardoned, because a
 * client that has just been snapped is *supposed* to be there.
 */
function correctionFor(
  input: ServerInput,
  entity: ServerEntity,
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
  // is not worth a correction, and the checks below still apply.
  const previousClaim = entity.claimedPosition;
  if (previousClaim !== null) {
    const allowanceFor = (span: number): number =>
      maxStep * config.speedTolerance * Math.max(1, Math.min(MAX_SEQ_SPAN, Math.floor(span)));

    const travelled = distance(predictedX, predictedY, previousClaim.x, previousClaim.y);
    let legal = travelled <= allowanceFor(input.seqSpan);

    // The other legal place to be: wherever we last corrected them to, plus the
    // inputs they have replayed since. A reconciling client walks away from that
    // position at exactly walking speed, which is what this measures.
    const pardon = entity.pardon;
    if (!legal && pardon !== null) {
      const sincePardon = distance(predictedX, predictedY, pardon.x, pardon.y);
      legal = sincePardon <= allowanceFor(input.seq - pardon.seq);
    }
    if (!legal) return CorrectionReason.SpeedViolation;
  }

  const drift = distance(predictedX, predictedY, authoritative.x, authoritative.y);
  if (blockedByTerrain && drift > 1) return CorrectionReason.Collision;
  if (drift > config.correctionThreshold) return CorrectionReason.Divergence;
  if (drift > DRIFT_EPSILON) return CorrectionReason.Drift;
  return null;
}

/**
 * Ceiling on the allowance a gap in sequence numbers can buy. A second of
 * missing inputs is a connection problem, not a licence to cross the map: past
 * this the claim is measured as if only this many ticks had passed, and a client
 * that really was away that long is corrected rather than believed.
 */
const MAX_SEQ_SPAN = SERVER_TICK_RATE;
