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
import { CLIMB_PACE } from '../../sim/constants.js';
import { gradeOfSlope, GroundGrade, groundSlopeAt } from '../../sim/slope.js';
import { MAX_STEP_HEIGHT, WALKABLE_MIN_HEIGHT, type TerrainSampler } from '../world/terrain.js';
import { moveScaleOf } from './statuses.js';
import type { ServerEntity, ServerInput } from './types.js';

/**
 * The slowest a slow may leave a body, as a fraction of its own speed
 * (spec 188).
 *
 * A quarter, and it is a floor rather than a clamp on the authored magnitude so
 * that stacking sources -- when there are any -- still cannot cross it. What it
 * protects is the difference between a slow and a root: a body that cannot move
 * at all needs its own counterplay, its own duration budget and its own tell,
 * and none of those come free with a movement multiplier.
 */
export const MIN_MOVE_SCALE = 0.25;

export interface MovementContext {
  readonly world: WorldColliders;
  readonly terrain: TerrainSampler;
  readonly config: LiveConfig;
  /**
   * The tick being resolved (spec 188).
   *
   * Here because a slow is a *timed state* and this is where speed is read: a
   * status is only live relative to a tick, so a mover that could not name one
   * would have to be handed a pre-scaled speed instead -- which is a second
   * place for "how fast is this body" to be answered, and the whole reason
   * {@link moveScaleOf} exists is that there should be one.
   */
  readonly tick: number;
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

/**
 * The heading from one point to another, or `fallback` when there is no
 * direction to take.
 *
 * The degenerate case is the reason this is a function rather than an `atan2`
 * at each call site: an aim on top of the body -- a self cast, a click at your
 * own feet -- has no direction in it, and `atan2(0, 0)` is zero, which is a
 * heading, and a wrong one. Every reader of this wants "keep looking where you
 * were looking" there instead.
 */
export function headingToward(from: Vec2, to: Vec2, fallback: number): number {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (Math.hypot(dx, dy) < 1e-6) return fallback;
  return Math.atan2(dy, dx);
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

/**
 * What a step onto some ground amounts to (spec 227).
 *
 * `Walk` is ordinary ground; `Climb` is steep enough to be crossed at
 * {@link CLIMB_PACE} rather than at speed; `Refused` is water, a wall, or a
 * hillside past {@link MAX_CLIMB_SLOPE}.
 */
export const StepGrade = { Walk: 0, Climb: 1, Refused: 2 } as const;
export type StepGradeValue = (typeof StepGrade)[keyof typeof StepGrade];

/** The magnitude a grade lets a body move at. */
export function paceFor(grade: StepGradeValue): number {
  return grade === StepGrade.Walk ? 1 : grade === StepGrade.Climb ? CLIMB_PACE : 0;
}

/**
 * Grade the step from where a body is standing to where it wants to be.
 *
 * **Two rules, asking two different questions** (spec 227), and separating them
 * is the whole change:
 *
 *  - {@link MAX_STEP_HEIGHT} on the *step*: can the body get over this lip?
 *    Unchanged since spec 056, same value, and still what refuses a tier edge
 *    and permits a stair riser.
 *  - {@link groundSlopeAt} at the *destination*: is that ground a body can
 *    stand on? This is the new half and the one that finally makes a maximum
 *    walkable angle exist.
 *
 * They were one rule and it could only do one job honestly. A height per tick
 * is an angle divided by how far the body travelled, so the same hillside came
 * back at 69 degrees for a body at `MOVE_SPEED_HARD_MAX` and 88.4 for a grazer
 * -- the slower body walking up the steeper ground -- and a player went up 83.9
 * degrees head-on with nothing in the game refusing it.
 *
 * The ground rule is a property of the ground alone, so it is the same answer
 * at every speed and from every direction: there is no approach angle that
 * gets a body up a slope past `MAX_CLIMB_SLOPE`, which is what "maximum
 * walkable angle" has to mean to be worth stating.
 */
export function gradeStep(
  from: Vec3,
  x: number,
  y: number,
  terrain: TerrainSampler,
): StepGradeValue {
  const height = terrain.heightAt(x, y);
  if (height <= WALKABLE_MIN_HEIGHT) return StepGrade.Refused;

  // The jump rule, unchanged since spec 056 and now the only thing it does.
  if (Math.abs(height - from.z) > MAX_STEP_HEIGHT) return StepGrade.Refused;

  const slope = groundSlopeAt(x, y, height, (sx, sy) => terrain.heightAt(sx, sy));
  const grade = gradeOfSlope(slope);
  if (grade === GroundGrade.Cliff) return StepGrade.Refused;
  return grade === GroundGrade.Climb ? StepGrade.Climb : StepGrade.Walk;
}

/**
 * True when the ground at a point is somewhere a body may legally stand.
 *
 * The yes-or-no half of {@link gradeStep}, kept for the callers that only want
 * one -- a step it refuses is a step no pace makes legal.
 */
export function isWalkable(
  from: Vec3,
  x: number,
  y: number,
  terrain: TerrainSampler,
): boolean {
  return gradeStep(from, x, y, terrain) !== StepGrade.Refused;
}

/**
 * Shorten a step to climbing pace (spec 227).
 *
 * An interpolation of the *already slid* landing rather than a second
 * `slideCircle`: the collider answer for this direction is in hand, and moving
 * less far along it is strictly less likely to be inside something than moving
 * the whole way -- `pushOutOfObstacles` runs afterwards either way.
 *
 * The shortened landing is graded again and the full one kept if it comes back
 * refused, which is the case that would otherwise pin a body. On smooth ground
 * a shorter step over the same slope is the same gradient and this never fires;
 * at a lip the full step cleared, the rise stays and the run shrinks, and the
 * ratio can cross the ceiling the full step passed.
 *
 * Shared by the server and the client's predictor, so a climb is not a
 * correction.
 */
export function climbStep(
  standingOn: Vec3,
  from: Vec2,
  landed: Vec2,
  terrain: TerrainSampler,
): Vec2 {
  const slowed = {
    x: from.x + (landed.x - from.x) * CLIMB_PACE,
    y: from.y + (landed.y - from.y) * CLIMB_PACE,
  };
  return gradeStep(standingOn, slowed.x, slowed.y, terrain) === StepGrade.Refused ? landed : slowed;
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

  // A slow multiplies the step and nothing else (spec 188): the collision, the
  // terrain check and the facing are all unchanged, so a slowed body walks the
  // same way it always did and gets less far doing it. `MIN_MOVE_SCALE` is the
  // floor -- see `moveScaleOf` -- so no slow can turn into a root.
  const maxStep =
    (entity.stats.moveSpeed * moveScaleOf(entity.statuses, context.tick, MIN_MOVE_SCALE)) /
    SERVER_TICK_RATE;
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
  let grade: StepGradeValue = StepGrade.Walk;
  if (landed.x !== from.x || landed.y !== from.y) {
    grade = gradeStep(entity.position, landed.x, landed.y, terrain);
  }
  if (grade === StepGrade.Refused) {
    // Try each axis alone before giving up, so running along a shoreline slides
    // rather than sticking.
    const alongX = { x: landed.x, y: from.y };
    const alongY = { x: from.x, y: landed.y };
    const gradeX =
      alongX.x === from.x ? StepGrade.Refused : gradeStep(entity.position, alongX.x, alongX.y, terrain);
    const gradeY =
      alongY.y === from.y ? StepGrade.Refused : gradeStep(entity.position, alongY.x, alongY.y, terrain);
    if (gradeX !== StepGrade.Refused) {
      landed = alongX;
      grade = gradeX;
    } else if (gradeY !== StepGrade.Refused) {
      landed = alongY;
      grade = gradeY;
    } else {
      landed = from;
      grade = StepGrade.Walk;
      blockedByTerrain = true;
    }
  }
  if (grade === StepGrade.Climb) {
    landed = climbStep(entity.position, from, landed, terrain);
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
 *
 * A pending drop outranks the input for the same reason and is outranked by the
 * cast for the obvious one (spec 172). The difference from a cast is that a step
 * does not withdraw from it: there is nothing to refund and nothing rooted, so a
 * player who asked to put something down and then walked still asked to put it
 * down, and the body comes round while it walks.
 */
function resolveFacing(entity: ServerEntity, input: ServerInput | null): number {
  const cast = entity.cast;
  const aim = cast ? { x: cast.targetX, y: cast.targetY } : entity.dropAim;
  const wanted = aim
    ? headingToward(entity.position, aim, entity.facing)
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
