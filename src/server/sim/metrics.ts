/**
 * What a build actually did, counted (spec 147).
 *
 * The brief asks for debug metrics, and is explicit about why: **the goal is not
 * to equalise DPS.** It is to compare problem-solving power and sustainability
 * across builds that solve problems differently. A table where six builds have
 * the same damage-per-second is not evidence of balance -- it is evidence that
 * five of them have been tuned into the sixth.
 *
 * So this counts the things the six *routes* are made of. Strength's row should
 * be high on staggers and executions and near zero on healing; Constitution's
 * should be high on damage taken and long on encounter length; Agility's should
 * show the smallest health expenditure per kill. A build whose row looks like
 * somebody else's row is the finding.
 *
 * A pure fold over {@link ServerSimEvent}. It reads no clock -- the tick is
 * handed to it -- keeps no reference to the world, and never influences it, so
 * a harness can collect it and the live server can ignore it at zero cost.
 */

import type { ServerSimEvent } from './types.js';

export interface BuildMetrics {
  /** Ticks the fight has been running, from the first event to the last. */
  readonly ticks: number;
  readonly damageDealt: number;
  readonly damageTaken: number;
  /** Absorbed by a shield rather than by health. Constitution's and Wisdom's. */
  readonly damageAbsorbed: number;
  readonly healingReceived: number;
  /** Blows landed, and how many of them found a weak point. */
  readonly hits: number;
  readonly weakPoints: number;
  readonly criticals: number;
  /** Guards this body broke, and had broken. */
  readonly staggersCaused: number;
  readonly staggersTaken: number;
  /** Ticks spent rooted by somebody else's blow -- time under crowd control. */
  readonly ticksStaggered: number;
  readonly resourceSpent: number;
  readonly resourceRestored: number;
  /** Casts committed to, and casts withdrawn from before the attack point. */
  readonly castsCommitted: number;
  readonly castsWithdrawn: number;
  /**
   * Ticks the body was committed to something and could not move.
   *
   * Sampled rather than derived from events, and the one number that makes
   * Agility legible: its whole product is a smaller fraction of each cycle spent
   * rooted, and no event reports "still rooted". Without this column a harness
   * measures Agility's *side effects* and reads it as a weak damage build.
   */
  readonly ticksRooted: number;
  /** Follow-throughs walked out of. Agility's whole loop, counted. */
  readonly backswingsCancelled: number;
  readonly kills: number;
  readonly deaths: number;
  /** Per-ability usage, so "what did this build actually press" is answerable. */
  readonly abilityUses: Readonly<Record<string, number>>;
}

export const EMPTY_METRICS: BuildMetrics = {
  ticks: 0,
  damageDealt: 0,
  damageTaken: 0,
  damageAbsorbed: 0,
  healingReceived: 0,
  hits: 0,
  weakPoints: 0,
  criticals: 0,
  staggersCaused: 0,
  staggersTaken: 0,
  ticksStaggered: 0,
  resourceSpent: 0,
  resourceRestored: 0,
  castsCommitted: 0,
  castsWithdrawn: 0,
  ticksRooted: 0,
  backswingsCancelled: 0,
  kills: 0,
  deaths: 0,
  abilityUses: {},
};

/** Mutable while a fold is running. Frozen into a {@link BuildMetrics} at the end. */
type Working = { -readonly [K in keyof Omit<BuildMetrics, 'abilityUses'>]: number } & {
  abilityUses: Record<string, number>;
};

function working(from: BuildMetrics): Working {
  return { ...from, abilityUses: { ...from.abilityUses } };
}

/**
 * One tick of events, folded into one body's counters.
 *
 * `entityId` is whose row this is: the same event stream is folded once per
 * body being measured, and each fold picks out the half that concerns it. A
 * `hit` is damage dealt for the attacker and damage taken for the target, and
 * counting it once from each side is what makes the two rows comparable.
 *
 * Cast phases are read off `castStarted` (spec 144): a `Backswing` phase *is*
 * the attack point, so it is what "committed" counts. `castEnded` distinguishes
 * a withdrawal from a walked-out follow-through by its reason, which is exactly
 * the distinction Agility's loop turns on.
 */
export function foldMetrics(
  into: BuildMetrics,
  entityId: number,
  tick: number,
  events: readonly ServerSimEvent[],
  reasons: {
    readonly cancelled: number;
    readonly backswingCancelled: number;
    readonly backswingPhase: number;
  },
): BuildMetrics {
  const next = working(into);
  next.ticks = Math.max(next.ticks, tick);

  for (const event of events) {
    switch (event.kind) {
      case 'hit': {
        // A heal is reported as a hit against oneself with negative damage
        // (spec 062), so one code path covers both and the sign tells them apart.
        if (event.damage < 0) {
          if (event.targetId === entityId) next.healingReceived += -event.damage;
          break;
        }
        if (event.attackerId === entityId) {
          next.damageDealt += event.damage;
          next.hits += 1;
          if (event.weakPoint) next.weakPoints += 1;
          if (event.critical) next.criticals += 1;
          if (event.killed) next.kills += 1;
        }
        if (event.targetId === entityId) next.damageTaken += event.damage;
        break;
      }
      case 'poiseBroken':
        if (event.breakerId === entityId) next.staggersCaused += 1;
        if (event.entityId === entityId) {
          next.staggersTaken += 1;
          next.ticksStaggered += event.ticks;
        }
        break;
      case 'castStarted':
        if (event.entityId !== entityId) break;
        if (event.phase === reasons.backswingPhase) next.castsCommitted += 1;
        else next.abilityUses[event.abilityId] = (next.abilityUses[event.abilityId] ?? 0) + 1;
        break;
      case 'castEnded':
        if (event.entityId !== entityId) break;
        if (event.reason === reasons.cancelled) next.castsWithdrawn += 1;
        if (event.reason === reasons.backswingCancelled) next.backswingsCancelled += 1;
        break;
      case 'died':
        if (event.entityId === entityId) next.deaths += 1;
        break;
      default:
        break;
    }
  }

  return { ...next, abilityUses: next.abilityUses };
}

/** One tick of posture: was this body rooted by its own commitment? */
export function foldPosture(into: BuildMetrics, rooted: boolean): BuildMetrics {
  return rooted ? { ...into, ticksRooted: into.ticksRooted + 1 } : into;
}

/**
 * Resource and shield movement, which no event reports.
 *
 * Sampled from the entity between ticks rather than derived from events,
 * because spending is not an event: `startCast` takes the cost silently and a
 * regen tick adds it back silently. The caller hands the before and after, and
 * this decides which direction it went -- so a build that spends and regains
 * the same pool twenty times reads as forty movements rather than as zero.
 */
export function foldResource(
  into: BuildMetrics,
  before: { readonly resource: number; readonly shield: number },
  after: { readonly resource: number; readonly shield: number },
): BuildMetrics {
  const delta = after.resource - before.resource;
  const absorbed = Math.max(0, before.shield - after.shield);
  return {
    ...into,
    resourceSpent: into.resourceSpent + Math.max(0, -delta),
    resourceRestored: into.resourceRestored + Math.max(0, delta),
    damageAbsorbed: into.damageAbsorbed + absorbed,
  };
}

/**
 * The comparisons the brief actually asks for.
 *
 * Every one is a *ratio*, because the raw totals are not comparable across
 * builds that fight for different lengths of time -- which is the whole point of
 * measuring an attrition build against a burst one.
 */
export interface BuildSummary {
  /** Damage per second of encounter. The number that is *not* the goal. */
  readonly dps: number;
  /** Health spent per kill. Agility's route should be lowest here. */
  readonly healthPerKill: number;
  /** How much of the incoming damage never reached health. */
  readonly absorbFraction: number;
  /** Weak points as a fraction of blows landed. Perception's row. */
  readonly weakPointRate: number;
  /** Guards broken per kill. Strength's row. */
  readonly staggersPerKill: number;
  /** Fraction of the fight spent rooted by somebody else. */
  readonly controlledFraction: number;
  /** Resource restored over resource spent. Above 1 is a build that never dries. */
  readonly resourceRatio: number;
  /** Follow-throughs walked out of, per attack committed. */
  readonly cancelRate: number;
  /** Fraction of the fight spent rooted by one's own commitment. Agility's row. */
  readonly rootedFraction: number;
  readonly kills: number;
  readonly deaths: number;
}

export function summarise(metrics: BuildMetrics, tickRate: number): BuildSummary {
  const seconds = Math.max(1 / tickRate, metrics.ticks / tickRate);
  const kills = Math.max(1, metrics.kills);
  const incoming = metrics.damageTaken + metrics.damageAbsorbed;
  return {
    dps: metrics.damageDealt / seconds,
    healthPerKill: metrics.damageTaken / kills,
    absorbFraction: incoming > 0 ? metrics.damageAbsorbed / incoming : 0,
    weakPointRate: metrics.hits > 0 ? metrics.weakPoints / metrics.hits : 0,
    staggersPerKill: metrics.staggersCaused / kills,
    controlledFraction: metrics.ticks > 0 ? metrics.ticksStaggered / metrics.ticks : 0,
    resourceRatio: metrics.resourceSpent > 0 ? metrics.resourceRestored / metrics.resourceSpent : 0,
    cancelRate:
      metrics.castsCommitted > 0 ? metrics.backswingsCancelled / metrics.castsCommitted : 0,
    rootedFraction: metrics.ticks > 0 ? metrics.ticksRooted / metrics.ticks : 0,
    kills: metrics.kills,
    deaths: metrics.deaths,
  };
}
