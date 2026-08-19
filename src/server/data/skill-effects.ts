/**
 * What an active skill is assembled *from* (spec 184).
 *
 * The vocabulary and nothing else -- three small unions and one tuning block,
 * pure data with no behaviour, in `data/` because every number in them is a
 * balance value and this repo's rule is that balance values live in a table
 * somebody can diff.
 *
 * The idea the whole spec rests on is that a skill is
 * `targeting + casting + costs + cooldown + effects`, and that **each of those
 * five is a system this game already has**. So nothing here is a mechanic: an
 * effect is a *verb over an existing system*, and the resolver in
 * `sim/skill-effects.ts` is a switch that calls the function that already owns
 * each one -- `resolveBlow` for damage, `applyPoiseDamage` and `stagger` for
 * guard and stuns, `applyStatus`/`clearStatus` for statuses, `applyHealing`
 * for healing. An effect that needed a *new* rule would be a sign that the rule
 * belongs in the system it is about rather than in a skill row.
 *
 * Separate from `abilities.ts` for one reason: that file is the ability table,
 * these are the shapes a row is built out of, and a reader who wants to know
 * what an effect can be should not have to scroll past eleven rows to find out.
 */

import { SERVER_TICK_RATE } from '../config.js';
import { StatusId } from '../sim/statuses.js';

/**
 * Costs beside pool and flask charges (spec 184).
 *
 * Deliberately *beside* rather than replacing them. `AbilityDefinition.cost` is
 * the pool cost and it is threaded through `resourceCostFor`, `spentResource`,
 * every refund path and Wisdom's whole cost-reduction chain; `chargeCost` is the
 * flask's. Rewriting those into a uniform record would be the spec rewriting a
 * working system to fit a new feature, which is the one thing it is not allowed
 * to do. So the two that already exist stay where they are and this names the
 * two that did not.
 *
 * A record rather than two fields, so a third resource is a key here and a case
 * in `payCosts` rather than a new field on `CastState` and four new refund
 * lines. Absent is free; zero is free; negative is refused by the validator.
 */
export interface SkillCosts {
  /**
   * Health, paid at the commit.
   *
   * Can never be lethal: `startCast` refuses a skill whose blood price is not
   * strictly less than what the caster has left, which is the same shape
   * `overflowCostFor` already gives Arcane Overflow. A cost that could kill you
   * is a cost that makes the skill unusable exactly when you need it.
   */
  readonly health?: number;
  /**
   * Guard, paid at the commit.
   *
   * Refused rather than clamped when the pool is short, and refused rather than
   * allowed to *break* the caster: paying guard you have not got would mean a
   * skill that staggers the person casting it, and a self-stagger is a bug that
   * looks exactly like a mechanic.
   */
  readonly poise?: number;
}

/**
 * How a landing picks who it lands on, when the answer is a shape rather than
 * a named body (spec 184).
 *
 * Three shapes, one union, and the union is the extension point: a fourth is a
 * member here and a case in `selectByArea`, with no other file touched. The
 * brief asks for circle-around-caster, circle-at-location, cone and line, and
 * the first two are one shape with an `origin` because they differ in where
 * their centre comes from and in nothing else.
 *
 * Every shape's reach is measured **to a body's edge**, the same way
 * `landOnTarget` and `landBlast` already measure theirs: a target's radius is
 * added to the distance allowed, so a big body is caught by the edge of a blast
 * rather than only by its centre.
 */
export type SkillArea =
  | {
      readonly shape: 'circle';
      /** The caster's feet, or the point the cast was aimed at. */
      readonly origin: 'caster' | 'aim';
      readonly radius: number;
      readonly maxTargets?: number;
    }
  | {
      readonly shape: 'cone';
      /** The **full** opening angle, not the half-angle. Degrees. */
      readonly angleDeg: number;
      readonly range: number;
      readonly maxTargets?: number;
    }
  | {
      readonly shape: 'line';
      /** The lane's full width, so a body within `width / 2` of it is in it. */
      readonly width: number;
      readonly range: number;
      readonly maxTargets?: number;
    };

/**
 * One reusable thing a skill does to whoever it landed on (spec 184).
 *
 * Read the list as the whole of what a skill may do: there is no `custom` case
 * and no script, because "the smallest clean abstraction that fits" stops
 * exactly here. A skill that needs something not on this list is asking for a
 * mechanic, and a mechanic belongs in the system it is about with an effect
 * added here to reach it.
 *
 * Order matters and is the authored order. That is not incidental -- Guard
 * Break takes the guard *before* it deals its damage, so the damage lands on a
 * body whose pool is already down, and swapping the two rows changes the skill.
 */
/**
 * Which body an effect lands on (spec 184).
 *
 * `target` -- whoever the landing picked -- is the default and is what almost
 * every effect means. `caster` is how one row says "and it does this to *me*":
 * a strike that heals its user, a sweep that costs guard to throw.
 *
 * A field on every effect rather than a set of kinds that are "self effects",
 * because which way round an effect points is a *design* decision per row and
 * not a property of the verb. Healing is usually the caster and draining is
 * usually the target, and a table that hard-coded either would make the other
 * inexpressible.
 *
 * On a self-targeted skill the two are one body and this changes nothing.
 */
export type EffectSubject = 'target' | 'caster';

export type SkillEffect = { readonly on?: EffectSubject } & (
  /**
   * Damage, through `resolveBlow` and nothing else.
   *
   * `amount` replaces the row's own `damage`; `multiplier` scales whichever of
   * the two is in play. Both absent is the row's damage unchanged, which is
   * what makes `effects: [{ kind: 'damage' }]` the honest way to write "the
   * damage this skill already says it does, and then these other things".
   */
  | { readonly kind: 'damage'; readonly amount?: number; readonly multiplier?: number }
  /**
   * Guard damage on top of what the blow itself carries.
   *
   * Absolute, unlike `poiseDamageOf`'s `staggerPower * multiplier`, because a
   * skill that says "and 40 guard" should mean 40 to everyone -- a Strength
   * character already gets more out of every blow and does not also need the
   * skill's stated number to scale. Runs through `applyPoiseDamage`, so
   * hyper-armour, the immunity window and the break itself all apply.
   */
  | { readonly kind: 'poiseDamage'; readonly amount: number }
  /**
   * A stagger, applied directly rather than as the consequence of a break.
   *
   * The same `stagger` in `sim/poise.ts` that a poise break calls, so the
   * rooted legs, the refused hands, the dropped cast, the lost Flow, the
   * `poiseBroken` event, the flinch and the swirl over the head are the ones
   * the game already has. It respects `staggerImmune`, which is what stops two
   * casters holding a third permanently -- the same guard the break has.
   */
  | { readonly kind: 'stun'; readonly ticks: number }
  /** A status, through `applyStatus`. `magnitude` is the strength. */
  | {
      readonly kind: 'applyStatus';
      readonly statusId: string;
      readonly durationTicks: number;
      readonly magnitude?: number;
      readonly maxStacks?: number;
    }
  /** A status taken off, through `clearStatus`. */
  | { readonly kind: 'removeStatus'; readonly statusId: string }
  /** Healing, through `applyHealing`, so Wisdom's scale and overheal apply. */
  | { readonly kind: 'heal'; readonly amount?: number; readonly fraction?: number }
  /** Pool. Positive restores, negative drains. Clamped at both ends. */
  | { readonly kind: 'resource'; readonly amount: number }
  /**
   * Guard as a pool rather than as damage. Positive restores, negative removes.
   *
   * Distinct from `poiseDamage` on purpose, and the distinction is what Guard
   * Break is: this writes the pool directly and **cannot break it**, where
   * `poiseDamage` goes through the break machinery and can. "Strip guard" and
   * "stagger" are different asks, and one effect that sometimes did the other
   * would make a skill's behaviour depend on how full its target happened to be.
   */
  | { readonly kind: 'poise'; readonly amount: number });

/** Which body `effect` lands on. `target` unless the row says otherwise. */
export function subjectOf(effect: SkillEffect): EffectSubject {
  return effect.on ?? 'target';
}

function seconds(value: number): number {
  return Math.max(1, Math.round(value * SERVER_TICK_RATE));
}

/**
 * What changing a skill slot costs (spec 184).
 *
 * One block, because the brief's three asks about swapping -- that it takes
 * time, that it is not instantaneous in combat, and that it applies a status --
 * are three numbers about one action and belong in one place a designer can
 * find.
 *
 * `statusId` is an **existing** status with an existing reader, and that is the
 * whole argument for choosing it: `Vulnerable` is what a body carries for a
 * beat after committing an attack -- an opening anybody with Perception can
 * read -- and somebody rummaging in their pack mid-fight is exactly that. A
 * status invented for this would be a second debuff system in a game that has
 * one.
 */
export const SKILL_SWAP = {
  /**
   * How long the swap takes.
   *
   * Longer than any wind-up in the table on purpose: the point is that it is
   * not something you do between two swings.
   */
  durationTicks: seconds(1.5),
  /** What the swapper carries while it is in flight, and for a beat after. */
  statusId: StatusId.Vulnerable,
  statusTicks: seconds(2),
  /** How many swaps may be waiting at once. A queue, like spec 172's drops. */
  maxPending: 4,
} as const;

/** How long Slow lasts if a row forgets to say, and how much it takes. */
export const SLOW_DEFAULTS = {
  /** Fraction of move speed removed. 0.4 is "40% slower". */
  magnitude: 0.4,
  durationTicks: seconds(2),
  /** Nothing may be slowed past this, or a slow becomes a root. */
  maxMagnitude: 0.75,
} as const;
