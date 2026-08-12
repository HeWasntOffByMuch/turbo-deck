/**
 * Predicting the blow (spec 069).
 *
 * Spec 067 predicted the *root* a cast implies, because a root is expressible as
 * input and therefore costs nothing when the guess is wrong. It deliberately
 * predicted nothing the player could see: the bar and the cooldown sweep waited
 * for the server, which meant a press did nothing for a round trip and then did
 * everything at once.
 *
 * This file predicts the cast itself. Three rules govern it, and they are the
 * reason to read this comment rather than the code:
 *
 *  1. **The gate is the server's own.** {@link mayCast} calls `startCast` from
 *     `sim/abilities.ts` -- the same pure function the authoritative tick calls
 *     -- against a mirror of this client's entity. A hand-written client copy of
 *     "may I swing" would be a second rulebook that drifts silently from the
 *     first, and every divergence it grew would be a mispredicted blow. Calling
 *     the real one means a wrong prediction can only come from an input that
 *     differs, never from a rule that does.
 *
 *  2. **Only the timeline is advanced, never the effect.** {@link advanceCast}
 *     here is a much smaller thing than the sim's: it moves a cast through
 *     turning, wind-up, channel and recovery so a bar can be drawn against it,
 *     and it spawns nothing, damages nobody and rolls no dice. Predicting a hit
 *     is a far larger commitment than predicting a wind-up, and a health bar
 *     that jumps back up is worse than one that moves late.
 *
 *  3. **The server always wins.** Everything here is an overlay that the next
 *     authoritative message replaces. A refusal takes back the cooldown and the
 *     resource its own request spent, and nothing else.
 *
 * Pure: no transport, no DOM, no clock of its own. Tested headlessly.
 */

import { abilityById, totalCastTicks, type AbilityDefinition } from '../data/abilities.js';
import { turnToward } from '../sim/movement.js';
import { cooldownTicksFor, startCast, type CastRejection } from '../sim/abilities.js';
import { regenerated } from '../sim/resource.js';
import { CastPhase, EntityKindValue, type CastState, type ServerEntity } from '../sim/types.js';
import type { EffectiveStats } from '../state/types.js';

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** What this client believes about itself, as the sim would see it. */
export interface Mirror {
  readonly position: Point;
  readonly facing: number;
  readonly health: number;
  readonly resource: number;
  readonly cooldowns: Readonly<Record<string, number>>;
  readonly cast: CastState | null;
  readonly stats: EffectiveStats;
}

/**
 * Dresses what the client knows as a {@link ServerEntity}, so the server's own
 * gate can be asked about it.
 *
 * The fields `startCast` does not read are filled with something harmless and
 * are not a claim about anything. That is a deliberate trade: passing the real
 * function a slightly synthetic entity keeps one implementation of the rules,
 * where extracting "the parts of the rules the client can check" into a shared
 * helper would leave the other parts unshared and free to drift.
 */
export function asEntity(mirror: Mirror): ServerEntity {
  return {
    id: -1,
    kind: EntityKindValue.Player,
    typeId: '',
    ownerPlayerId: null,
    position: { x: mirror.position.x, y: mirror.position.y, z: 0 },
    facing: mirror.facing,
    health: mirror.health,
    level: 1,
    zoneId: '',
    stats: mirror.stats,
    activity: 0,
    activityUntilTick: 0,
    attackReadyTick: 0,
    radius: 0,
    targetId: null,
    path: null,
    pathIndex: 0,
    repathAtTick: 0,
    pathGoal: null,
    resource: mirror.resource,
    cast: mirror.cast,
    cooldowns: mirror.cooldowns,
    projectile: null,
    claimedPosition: null,
    claimedSeq: 0,
    pardon: null,
    spawnerId: null,
    anchor: null,
  };
}

export type CastDecision =
  | { readonly ok: true; readonly cast: CastState; readonly cost: number; readonly readyAtTick: number }
  | { readonly ok: false; readonly reason: CastRejection };

/**
 * Whether this client expects the server to take `abilityId`, and the cast it
 * expects to get. Straight through the sim's `startCast`, so the answer is the
 * server's answer given the same entity.
 *
 * Two ticks, because there are two questions -- `decideAt` judges *readiness*
 * and `stampAt` sets the cast's own clock -- though since spec 070 the caller
 * passes the same tick for both, and the reason is worth keeping.
 *
 * `targetRadius` is the named body's, and it is not optional in practice
 * (spec 080): reach to a body is measured to its edge on the server, so a client
 * that left it at zero was asking a *stricter* question than the one that will
 * be asked of the server -- and every attack in the band between the two was one
 * it refused to predict and the server took.
 *
 * 069 leaned `decideAt` forward by a round trip, on the argument that failing to
 * predict a commit costs a whole wind-up of discarded walking while predicting
 * one that is refused only shows a bar that vanishes. That is true, and it was
 * still the wrong lever: a refusal stamps a cooldown too, and a stamped cooldown
 * that belongs to a press the server threw away is what blocks the next press
 * the server would have taken. Measured against the latency harness, leaning is
 * worse than not leaning at every delay it was tried at.
 *
 * The tick worth judging at is the one the server will commit on. `stampAt` has
 * always been that tick, and does not lean for a separate reason: the bar is
 * drawn against the estimated server tick, so a cast stamped into the future
 * would sit empty until the clock caught up and release its root early.
 */
export function mayCast(
  mirror: Mirror,
  abilityId: string,
  aim: Point,
  decideAt: number,
  stampAt: number,
  targetEntityId = 0,
  targetRadius = 0,
): CastDecision {
  const ability = abilityById(abilityId);
  if (!ability) return { ok: false, reason: 'unknownAbility' };
  const entity = asEntity(mirror);
  const result = startCast(
    entity,
    { abilityId, targetX: aim.x, targetY: aim.y, targetEntityId, targetRadius },
    decideAt,
  );
  if (!result.ok) return { ok: false, reason: result.reason };
  const cast = result.entity.cast;
  // `startCast` returning ok always sets a cast; this is a type narrowing rather
  // than a case that happens.
  if (!cast) return { ok: false, reason: 'unknownAbility' };
  const shift = stampAt - decideAt;
  return {
    ok: true,
    cast: {
      ...cast,
      startedTick: cast.startedTick + shift,
      releaseTick: cast.releaseTick + shift,
      endTick: cast.endTick + shift,
    },
    cost: ability.cost,
    // From the *release*, not the commit (spec 091): the cooldown starts when
    // the blow goes off, so a wind-up that is withdrawn from costs none of it.
    // Predicting it from the commit would grey the button out for a swing that
    // may never happen, and then have to hand it back.
    readyAtTick: stampAt + ability.windupTicks + cooldownTicksFor(ability, entity),
  };
}

/**
 * One tick of a predicted cast's timeline, or null once it is over.
 *
 * A deliberate subset of `sim/abilities.ts`'s `advanceCast`: the phases and
 * their ticks, and nothing that happens *because* of them. The one piece of real
 * behaviour it must reproduce is the wind-up re-stamp at the end of a turn --
 * the server restarts the wind-up clock at alignment, so a client that kept the
 * provisional `releaseTick` would fill its bar early and then watch it reset.
 */
export function advanceCast(
  cast: CastState,
  facing: number,
  position: Point,
  tick: number,
  ability: AbilityDefinition | null,
): CastState | null {
  if (!ability) return null;

  if (cast.phase === CastPhase.Turning) {
    if (!facingAim(position, facing, cast)) return cast;
    return {
      ...cast,
      phase: CastPhase.Windup,
      releaseTick: tick + ability.windupTicks,
      endTick: tick + totalCastTicks(ability),
    };
  }

  // The release. A blow that is not a channel is *over* on the tick it lands:
  // there is no recovery to sit through since spec 069, so the body is free the
  // moment the swing goes off.
  if (cast.phase === CastPhase.Windup && tick >= cast.releaseTick) {
    if (ability.kind !== 'channel') return null;
    return { ...cast, phase: CastPhase.Channel, nextPulseTick: tick };
  }

  // A channel runs from its release for `channelTicks`, and ends when its pulses
  // are done. That line is `releaseTick + channelTicks` rather than `endTick`,
  // to match the sim exactly -- the pulses are what the phase is for.
  if (cast.phase === CastPhase.Channel && tick >= cast.releaseTick + (ability.channelTicks ?? 0)) {
    return null;
  }

  return cast;
}

/**
 * Where the body is looking after one tick, mirroring `resolveFacing` in
 * `sim/movement.ts`: a cast in progress outranks the input, because the aim was
 * captured at the commit and the body turns *into* the blow over its wind-up.
 *
 * Tracked here at all because the turning phase depends on it: whether a press
 * begins winding up or spends a few ticks coming round is decided by the facing
 * the server has, and a client that assumed it was always aligned would predict
 * a wind-up that had not started.
 */
export function steerFacing(
  facing: number,
  cast: CastState | null,
  position: Point,
  wanted: number,
  turnRate: number,
  tickRate: number,
): number {
  const toward = cast
    ? Math.atan2(cast.targetY - position.y, cast.targetX - position.x)
    : Number.isFinite(wanted)
      ? wanted
      : facing;
  return turnToward(facing, toward, turnRate, tickRate);
}

/**
 * Half a degree, matching `TURN_ALIGN_EPS` in `sim/abilities.ts`. Slack against
 * float drift rather than a tolerance anybody plays against -- a rooted caster's
 * aim does not move, and `turnToward` lands exactly on its target.
 */
const TURN_ALIGN_EPS = (0.5 * Math.PI) / 180;

function facingAim(position: Point, facing: number, cast: CastState): boolean {
  const dx = cast.targetX - position.x;
  const dy = cast.targetY - position.y;
  if (Math.hypot(dx, dy) < 1e-6) return true;
  let delta = (Math.atan2(dy, dx) - facing) % (Math.PI * 2);
  if (delta > Math.PI) delta -= Math.PI * 2;
  if (delta <= -Math.PI) delta += Math.PI * 2;
  return Math.abs(delta) <= TURN_ALIGN_EPS;
}

/**
 * The pool this client believes it has, at `tick`.
 *
 * The server's last word, regenerated forward with the sim's own curve, minus
 * what has been spent on commits it has not answered yet. Clamped at zero: a
 * mirror that reports a negative pool would refuse casts the server allows.
 */
export function modelledResource(
  lastKnown: number,
  lastKnownTick: number,
  unconfirmedSpend: number,
  stats: EffectiveStats,
  tick: number,
): number {
  const regen = regenerated(
    lastKnown,
    stats.resourceRegen,
    stats.maxResource,
    tick - lastKnownTick,
  );
  return Math.max(0, regen - unconfirmedSpend);
}
