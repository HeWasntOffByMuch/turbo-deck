/**
 * What a landed skill actually does, effect by effect (spec 188).
 *
 * The whole of "a skill is assembled rather than written", and the file to read
 * to see whether that claim is true: every case below is two or three lines
 * that call a function which already owns the mechanic. Damage is
 * {@link resolveBlow}. Guard is `applyPoiseDamage`. A stun is `stagger`, the
 * same one a poise break calls. A status is `applyStatus`. Healing is
 * `applyHealing`, so Wisdom's scale and Constitution's overheal apply to a
 * skill's heal exactly as they apply to Mend's.
 *
 * **There is no case here that implements a mechanic**, and that is the review
 * criterion rather than a boast: an effect that had to do its own arithmetic
 * would be a mechanic living in the skill system instead of in the system it
 * belongs to, which is the thing this spec exists to avoid. The day something
 * needs one, the rule goes where it belongs and the case here calls it.
 *
 * Two orderings are load-bearing:
 *
 *  - **Effects run in the order the row lists them**, so Guard Break's
 *    `poise: -50` comes off before its `poiseDamage: 25` is measured against
 *    the pool. Reordering a row is a balance change and is meant to be.
 *  - **The Rng is threaded**, exactly as it is everywhere else in this sim. Only
 *    `damage` draws from it -- through `resolveBlow`, which rolls crit first and
 *    always -- so a skill that lists two damage effects draws twice, every
 *    replay, in the same order.
 *
 * Pure. The tick and the Rng are arguments and both come back out.
 */

import type { Rng } from '../../shared/prng.js';
import type { AbilityDefinition } from '../data/abilities.js';
import { subjectOf, type SkillEffect } from '../data/skill-effects.js';
import { applyDot } from './damage-over-time.js';
import { applyHealing } from './healing.js';
import { resolveBlow } from './blow.js';
import { abilityEffectPowerOf } from '../data/ability-scaling.js';
import { applyPoiseDamage, isUnstaggerable, stagger } from './poise.js';
import { applyStatus, clearStatus } from './statuses.js';
import type { ServerEntity, ServerSimEvent } from './types.js';

export interface EffectResult {
  /** The caster, with whatever the effects returned to it. */
  readonly caster: ServerEntity;
  /**
   * The target, changed. Equal to {@link caster} when the two are the same
   * body -- a self-targeted skill -- which callers must not write twice.
   */
  readonly target: ServerEntity;
  readonly events: readonly ServerSimEvent[];
  readonly rng: Rng;
}

/**
 * Runs `ability.effects` against one target.
 *
 * The caster comes back too, because `resolveBlow` returns it: a weak point
 * hands the attacker resource, ability damage hands it a shield, a break hands
 * it momentum. Every existing caller of `applyDamage` already writes an attacker
 * back and this is the same contract -- a caller that drops it silently loses
 * every Perception and Wisdom payoff in the game.
 *
 * When the target *is* the caster the two are one body and only `target` is
 * meaningful; `caster` is returned equal to it so a caller that writes both
 * writes the same thing twice rather than losing half the work.
 */
export function applyEffects(
  ability: AbilityDefinition,
  casterIn: ServerEntity,
  targetIn: ServerEntity,
  tick: number,
  rngIn: Rng,
): EffectResult {
  const isSelf = casterIn.id === targetIn.id;
  let caster = casterIn;
  // One body when the skill is aimed at its own caster, two otherwise. Held as
  // separate variables rather than as a map keyed by id, because the two cases
  // are genuinely different -- writing a self-cast through a map would leave
  // two copies of one body to reconcile at the end -- and `isSelf` is the only
  // branch that costs.
  let target = isSelf ? casterIn : targetIn;
  const events: ServerSimEvent[] = [];
  let rng = rngIn;

  for (const effect of ability.effects ?? []) {
    // An effect the row points at the *caster* runs on the caster even inside a
    // list applied to somebody else, so "damage them and heal me" is one row
    // rather than two skills. On a self-cast there is nothing to distinguish.
    const onCaster = !isSelf && subjectOf(effect) === 'caster';
    const applied = applyOne(effect, ability, caster, onCaster ? caster : target, tick, rng, isSelf);
    rng = applied.rng;
    events.push(...applied.events);
    if (onCaster) {
      caster = applied.target;
    } else if (isSelf) {
      caster = applied.target;
      target = applied.target;
    } else {
      caster = applied.caster;
      target = applied.target;
    }
  }

  return { caster, target, events, rng };
}

interface OneResult {
  readonly caster: ServerEntity;
  readonly target: ServerEntity;
  readonly events: readonly ServerSimEvent[];
  readonly rng: Rng;
}

function applyOne(
  effect: SkillEffect,
  ability: AbilityDefinition,
  caster: ServerEntity,
  target: ServerEntity,
  tick: number,
  rng: Rng,
  selfDirected: boolean,
): OneResult {
  const still = (entity: ServerEntity, events: readonly ServerSimEvent[] = []): OneResult => ({
    caster,
    target: entity,
    events,
    rng,
  });

  switch (effect.kind) {
    case 'damage': {
      // A body cannot damage itself with a skill. Not a rule about hostility --
      // the caller already filtered for that -- but about the one case the
      // filter cannot see: a self-targeted skill listing damage would run
      // `resolveBlow` with the same body on both sides.
      if (selfDirected && caster.id === target.id) return still(target);
      // The row with its damage replaced, so `resolveBlow` runs unchanged and a
      // skill's blow is a blow: crit, weak point, exposure, armour, adaptation,
      // shields, poise, aftermath, the `hit` event and the kill. Nothing about
      // damage is reimplemented here and nothing may be.
      const base = effect.amount ?? ability.damage;
      const scaled = base * (effect.multiplier ?? 1);
      const blow = resolveBlow({ ...ability, damage: scaled }, caster, target, tick, rng);
      return { caster: blow.attacker, target: blow.target, events: blow.events, rng: blow.rng };
    }

    case 'poiseDamage': {
      // Through the break machinery, so hyper-armour reduces it, the immunity
      // window refuses the break, and emptying the pool staggers exactly the way
      // a weapon emptying it does.
      const poised = applyPoiseDamage(target, effect.amount, tick, false);
      if (!poised.broke) return still(poised.entity);
      const struck = stagger(
        poised.entity,
        caster.id,
        poised.entity.stats.traits.staggerTicks,
        tick,
        poised.interrupted,
      );
      return still(struck.entity, struck.events);
    }

    case 'stun': {
      // **A stun is not a guard break, and is not rate-limited like one.**
      //
      // `staggerImmune` is the anti-chain window, and what it exists to stop is
      // a *break* being repeatable: every basic attack carries poise, so two
      // Strength characters swinging freely would otherwise hold a third on the
      // floor forever. A skill's stun has nothing in common with that. It is
      // gated by a cast time long enough to read and step out of, by a cost,
      // and by a cooldown measured in seconds -- those are its rate limit, and
      // they are stricter than the window.
      //
      // Consulting the window here made the skill fail in the way it was
      // reported: Stunning Blow's own `poiseDamage` runs first, and on a body
      // whose guard it *breaks* that stamps the window a line before this read
      // it. So the same skill stunned for its authored duration against a
      // ravager (guard 49, unbroken by 30) and for the target's own much
      // shorter `staggerTicks` against a grazer (guard 20, always broken) --
      // and did nothing at all to a body already inside somebody else's window.
      // One skill, three behaviours, none of them stated anywhere.
      //
      // What is still refused: a corpse, and {@link isUnstaggerable}. That
      // second one is the difference between a global guard and an *earned*
      // defence -- a Constitution character who is hurt enough to have it is
      // meant to be unstaggerable, and a skill that walked through it would
      // make the trait worth nothing. It is `isUnstaggerable` rather than
      // `isResolute` since spec 237, so a stun is refused by the milestone that
      // grants immunity and not by the skill that grants a damage reduction.
      if (isUnstaggerable(target) || target.health <= 0) return still(target);
      // It still *stamps* the window, so a guard break cannot follow it for
      // free: what this changes is who the window applies to, not that it
      // exists.
      const struck = stagger(target, caster.id, Math.max(1, Math.round(effect.ticks)), tick);
      return still(struck.entity, struck.events);
    }

    case 'applyStatus':
      // **A row that authors no magnitude carries the caster's resolved ability
      // power** (spec 231), which is the rule `Exposed` and every affliction
      // already follow: a status usually belongs to somebody *else's* stats, so
      // what it is worth is captured when it lands rather than re-read off
      // whoever happens to be standing there later.
      //
      // A row that authors one means that number literally -- Crippling
      // Strike's `0.4` is a fraction of move speed and would be nonsense
      // scaled. So the two cases are "this status carries a quantity the row
      // states" and "this status carries how strong the caster was", and the
      // presence of the field is which.
      return still({
        ...target,
        statuses: applyStatus(target.statuses, effect.statusId, tick, effect.durationTicks, {
          ...(effect.maxStacks === undefined ? {} : { maxStacks: effect.maxStacks }),
          magnitude:
            effect.magnitude === undefined
              ? abilityEffectPowerOf(ability.scaling, caster.stats)
              : effect.magnitude,
        }),
      });

    case 'removeStatus':
      return still({ ...target, statuses: clearStatus(target.statuses, effect.statusId) });

    case 'applyDot':
      // Through the system that owns afflictions and nowhere else (spec 190).
      // Two lines, like every other case here: what an affliction is worth,
      // how long it runs and who is answerable for what it kills are all
      // decided by `applyDot` against its own table, so a skill row cannot
      // author a Burn that is not the Burn.
      return still(applyDot(target, effect.dotId, tick, caster, ability));

    case 'heal': {
      const amount = (effect.amount ?? 0) + target.stats.maxHealth * (effect.fraction ?? 0);
      const restored = applyHealing(target, amount, tick);
      return still(restored.entity);
    }

    case 'resource':
      return still({
        ...target,
        resource: Math.max(0, Math.min(target.stats.maxResource, target.resource + effect.amount)),
      });

    case 'poise':
      // The pool written directly, and it **cannot break**: clamped at zero
      // rather than allowed to empty into a stagger. Stripping a guard and
      // knocking somebody down are different asks, and one effect that
      // sometimes did the other would make a skill's behaviour depend on how
      // full its target happened to be.
      return still({
        ...target,
        poise: Math.max(0, Math.min(target.stats.traits.maxPoise, target.poise + effect.amount)),
      });
  }
}
