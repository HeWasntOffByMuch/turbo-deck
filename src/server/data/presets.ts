/**
 * Representative builds, as data (spec 147).
 *
 * The brief asks for a way to make the builds it wants reviewed quickly, and
 * lists twelve. They are here rather than in a test fixture because three
 * different things need the same twelve and must agree about them: the
 * derivation tests that assert every extreme produces legal stats, the balance
 * harness that fights them against each other, and the admin console that lets
 * somebody stand one up in a running server and play it.
 *
 * The six pure builds are the ones that expose design weakness, so they are
 * *actually* pure -- everything into one attribute, nothing anywhere else. A
 * "pure Strength" build with a comfortable amount of Constitution quietly
 * underneath it would be a build that answers the question by not asking it.
 *
 * Pure data. A preset is a spread and a level, and everything it turns into is
 * derived through the same `computeEffectiveStats` a real character goes
 * through -- there is no second path that builds a character.
 */

import { ATTRIBUTE_KEYS, type AttributeKey } from './attributes.js';
import { SCALING } from './scaling.js';
import { ALL_SPECIALIZATIONS } from './specializations.js';
import type { SpecializationAllocation } from '../state/types.js';

export interface BuildPreset {
  readonly id: string;
  readonly name: string;
  /** What this build is for, in the words the harness prints beside its row. */
  readonly premise: string;
  /** Which attributes the points go into, in order, cycling. */
  readonly into: readonly AttributeKey[];
  /** The level the preset is built at. Decides the budget. */
  readonly level: number;
  /**
   * What fraction of the budget goes into specialization tiers rather than into
   * the attribute itself (spec 244).
   *
   * The axis the one pool created, and the one the harness exists to watch: a
   * point can push a track further or deepen something the track already
   * unlocked, and the failure this is meant to catch is one of those being
   * obviously right every time.
   *
   * 0 is a **deep track** -- every point into the attribute, which is exactly
   * what every preset did before this spec, so the twelve attribute comparisons
   * are unchanged. 1 buys every tier the moment it unlocks and advances only
   * when nothing is buyable, which is the most **specialized** a build can be.
   */
  readonly tierShare: number;
  /**
   * Specialization ids this build buys **first**, in order (spec 275).
   *
   * `tierShare` says *how much* of the budget goes into tiers and the table
   * decides *which* -- lowest threshold first -- which is right for the twelve
   * attribute rows, where the point is that nobody hand-picked the tree. It
   * cannot express "the Adaptation build", and the Wisdom pass needs six rows
   * that differ only in which of one attribute's specializations they bought.
   *
   * Empty for every preset that predates this, so the twelve are untouched.
   */
  readonly focus?: readonly string[];
}

/**
 * The level the presets are built at.
 *
 * High enough that a pure build has crossed its third milestone -- the
 * qualitative one -- because a comparison between builds that have not yet
 * become themselves compares two piles of coefficients.
 */
export const PRESET_LEVEL = 20;

function pure(key: AttributeKey, name: string, premise: string): BuildPreset {
  return { id: `pure.${key}`, name, premise, into: [key], level: PRESET_LEVEL, tierShare: 0 };
}

function hybrid(
  id: string,
  name: string,
  premise: string,
  a: AttributeKey,
  b: AttributeKey,
): BuildPreset {
  return { id, name, premise, into: [a, b], level: PRESET_LEVEL, tierShare: 0 };
}

/** A Wisdom build that spends half its budget on one named specialization first. */
function wisdomFocus(
  id: string,
  name: string,
  premise: string,
  focus: readonly string[],
): BuildPreset {
  return {
    id,
    name,
    premise,
    into: ['wisdom'],
    level: PRESET_LEVEL,
    // Half, so the row has both a real attribute value and a real tree. At 0 it
    // would be `pure.wisdom` six times over; at 1 it would stall at the first
    // threshold its focus opens and never reach the milestones.
    tierShare: focus.length === 0 ? 0.05 : 0.5,
    focus,
  };
}

export const BUILD_PRESETS: readonly BuildPreset[] = [
  pure('strength', 'Pure Strength', 'Solves problems by ending them. Staggers, executes, and takes the resource back off the corpse.'),
  pure('agility', 'Pure Agility', 'Solves problems by not being there. Same attack rate as everyone; a quarter of the rooted time.'),
  pure('intelligence', 'Pure Intelligence', 'Solves problems by changing their shape. Reach, radius, and health spent as mana.'),
  pure('constitution', 'Pure Constitution', 'Solves problems by outlasting them. Cannot be staggered when it matters, and turns every heal into a buffer.'),
  pure('perception', 'Pure Perception', 'Solves problems by reading them. Doubles its weak-point chance against anything that has just committed.'),
  pure('wisdom', 'Pure Wisdom', 'Solves problems by never running out of answers. Kills slowly and always has something coming back.'),

  hybrid('pair.strCon', 'STR/CON', 'The juggernaut. Below half health every cast is armoured.', 'strength', 'constitution'),
  hybrid('pair.agiPer', 'AGI/PER', 'The ranger. Handling shortens projectile cooldowns; Flow buys weak-point chance.', 'agility', 'perception'),
  hybrid('pair.intWis', 'INT/WIS', 'The archmage. A large pool and abilities that come back, with nothing bespoke joining them.', 'intelligence', 'wisdom'),
  hybrid('pair.strPer', 'STR/PER', 'The executioner. Weak points double poise damage; a staggered target under a quarter health takes 60% more.', 'strength', 'perception'),
  hybrid('pair.agiInt', 'AGI/INT', 'The spellblade. Walking out of a follow-through makes the next spell wind up at weapon speed.', 'agility', 'intelligence'),
  // Added by spec 275, which needs the third Wisdom pair to answer whether
  // exploit-based sustain works through the systems alone. No pair node exists
  // for it and none is wanted: what should make it good is that Perception's
  // weak-point kill heal is healing, and Wisdom owns healing efficiency.
  hybrid('pair.perWis', 'PER/WIS', 'Exploit-based sustain. Precision that pays, on a body that gets more from being paid.', 'perception', 'wisdom'),
  hybrid('pair.conWis', 'CON/WIS', 'The attrition specialist. Durability, and healing that goes further on it.', 'constitution', 'wisdom'),

  // The Wisdom spending rows (spec 275). Six builds at one attribute value that
  // differ only in which of Wisdom's specializations they bought, which is the
  // comparison the twelve above cannot make: `tierShare` picks by threshold, so
  // every Wisdom row before this bought the same tree in the same order.
  wisdomFocus('wis.raw', 'Raw WIS', 'The attribute and almost nothing else. The control the other five are read against.', []),
  wisdomFocus('wis.recovery', 'Recovery WIS', 'Everything into healing received. What a restorative is worth to a specialist.', ['wis.measuredRecovery']),
  wisdomFocus('wis.conservation', 'Conservation WIS', 'Attuned, deeply. Careful casting paying for the next cast.', ['wis.conservation']),
  wisdomFocus('wis.adaptation', 'Adaptation WIS', 'Deep repeated-threat defence. The ceiling rather than the ramp.', ['wis.adaptation']),
  wisdomFocus('wis.composure', 'Composure WIS', 'Broad cooldown availability. The whole bar rotating sooner.', ['wis.composure']),
  wisdomFocus('wis.mastery', 'Mastery WIS', 'One tool, leaned on. Per-ability cooldown earned by repetition.', ['wis.mastery']),
  {
    id: 'wis.full',
    name: 'Full WIS',
    premise: 'Every Wisdom tier the level can pay for. What the track is worth bought outright.',
    into: ['wisdom'],
    level: PRESET_LEVEL,
    tierShare: 0.5,
  },

  // The spending axis (spec 244). The twelve above are the attribute comparison
  // and every one of them spends nothing on tiers, which is what they always did
  // -- so their rows are unchanged and these four are the new question: with one
  // pool, is pushing the number always right, or is deepening always right?
  {
    id: 'spend.deep',
    name: 'STR deep',
    premise: 'Strength as far as it goes, and a token few tiers. The highest number the level can reach.',
    into: ['strength'],
    // Not 0: `pure.strength` is already the zero-tier control and a second copy
    // of it would be a duplicate row costing a thirty-second fight to say what
    // the row above it says. A tenth is the brief's "high STR, few tiers".
    level: PRESET_LEVEL,
    tierShare: 0.1,
  },
  {
    id: 'spend.specialized',
    name: 'STR specialized',
    premise: 'Strength only as far as the next milestone, then everything it unlocked. A lower number, deeply invested.',
    into: ['strength'],
    level: PRESET_LEVEL,
    tierShare: 0.6,
  },
  {
    id: 'spend.mixed',
    name: 'STR/PER mixed',
    premise: 'Two tracks and their specializations in equal measure. The build a player actually makes.',
    into: ['strength', 'perception'],
    level: PRESET_LEVEL,
    tierShare: 0.4,
  },
  {
    id: 'spend.generalist',
    name: 'Generalist',
    premise: 'Four tracks, moderately advanced, buying the first tier of whatever opens.',
    into: ['strength', 'agility', 'constitution', 'perception'],
    level: PRESET_LEVEL,
    tierShare: 0.35,
  },
];

export function presetById(id: string): BuildPreset | null {
  return BUILD_PRESETS.find((preset) => preset.id === id) ?? null;
}

/**
 * The attribute spread a preset produces.
 *
 * Points are dealt round-robin into `into` and every attribute is held under the
 * hard cap -- a pure build at a high enough level would otherwise ask for more
 * of one attribute than exists, and silently getting fewer points than the level
 * earned is the sort of thing a balance table should not do quietly. Anything
 * that will not fit spills into the next attribute in the list, and a build
 * whose whole list is capped simply stops placing points, which is the honest
 * answer.
 */
export interface Spread {
  readonly attributes: Record<AttributeKey, number>;
  /** Tiers bought out of the same pool (spec 244). */
  readonly specializations: readonly SpecializationAllocation[];
  /**
   * Points the preset could not place.
   *
   * Reported rather than swallowed, because it is a real fact about the design:
   * a pure build at {@link PRESET_LEVEL} has more points than one attribute can
   * hold, which is what the hard cap is *for* -- past a certain level even a
   * specialist has to put something somewhere else. A harness that silently
   * dropped them would print a comparison between builds with different budgets.
   */
  readonly unspent: number;
}

export function spreadOf(preset: BuildPreset): Record<AttributeKey, number> {
  return fullSpreadOf(preset).attributes;
}

/**
 * What a preset buys with its whole budget.
 *
 * Points are dealt one at a time, and each one goes to a tier or to an attribute
 * according to `tierShare` -- measured against what has been spent so far, so a
 * share of 0.4 stays near 0.4 the whole way rather than front-loading. Attributes
 * are dealt round-robin into `into` and held under the hard cap; anything that
 * will not fit spills into the next attribute in the list, and a build whose
 * whole list is capped stops placing points, which is the honest answer.
 *
 * A tier is only bought where its milestone is already reached, so a specializing
 * build still has to advance the track to open the next thing -- which is the
 * trade-off the spec is about, playing out in the harness rather than asserted.
 */
export function fullSpreadOf(preset: BuildPreset): Spread {
  const spread: Record<AttributeKey, number> = Object.fromEntries(
    ATTRIBUTE_KEYS.map((key) => [key, SCALING.startingAttribute]),
  ) as Record<AttributeKey, number>;
  const tiers = new Map<string, number>();

  const levels = Math.max(0, preset.level - 1);
  let budget = SCALING.startingPoints + SCALING.pointsPerLevel * levels;
  const wanted = new Set(preset.into);

  /** The next tier this build would take, or null. Cheapest threshold first. */
  const nextTier = (): string | null => {
    const open = ALL_SPECIALIZATIONS.filter(
      (specialization) =>
        wanted.has(specialization.attribute) &&
        spread[specialization.attribute] >= specialization.requires &&
        (tiers.get(specialization.id) ?? 0) < specialization.maxTier,
    );
    if (open.length === 0) return null;
    // A focused build buys its own list and **nothing else**, in the order it
    // names. Exclusive rather than merely first, and that is what makes the six
    // Wisdom rows a comparison at all: at the preset level a character has 82
    // points against 55 to cap an attribute and 16 to buy every tier it has, so
    // a build that fell through to the table's order simply bought the whole
    // tree and all six rows came out identical. What is left over goes into the
    // attribute and then reports as unspent, which is the honest picture of a
    // point budget that is currently too large -- and the reason this spec does
    // not try to fix that here.
    const focus = preset.focus ?? [];
    if (focus.length > 0) {
      for (const id of focus) {
        const wantedTier = open.find((specialization) => specialization.id === id);
        if (wantedTier) return wantedTier.id;
      }
      return null;
    }
    // Lowest threshold, then id, so the choice is a property of the tables
    // rather than of authoring order.
    open.sort((a, b) => a.requires - b.requires || (a.id < b.id ? -1 : 1));
    return open[0]?.id ?? null;
  };

  let spent = 0;
  let onTiers = 0;
  let index = 0;
  let stalled = 0;
  while (budget > 0) {
    const wantTier = spent > 0 ? onTiers / spent < preset.tierShare : preset.tierShare > 0;
    const tier = wantTier ? nextTier() : null;
    if (tier !== null) {
      tiers.set(tier, (tiers.get(tier) ?? 0) + 1);
      onTiers += 1;
      spent += 1;
      budget -= 1;
      stalled = 0;
      continue;
    }

    // No tier wanted, or none available: advance the track instead. That
    // fallback is what makes `tierShare: 1` a build rather than a deadlock --
    // a specializing character still has to raise the attribute to open more.
    const key = preset.into[index % preset.into.length];
    index += 1;
    if (!key) break;
    if (spread[key] >= SCALING.attributeHardCap) {
      stalled += 1;
      // Every attribute in the list capped: stop, and report the rest unspent.
      //
      // **Not** "buy tiers with the remainder", which is what the first cut did
      // and which never terminated: a `tierShare: 0` build wants no tier, so the
      // loop reached here, found one available, reset the counter and came round
      // to want no tier again. `pure.strength` is the case -- 82 points at level
      // 20 against a cap 55 above the start -- so twelve of the sixteen presets
      // hung. Breaking is also the answer that keeps the twelve comparable:
      // spending the leftover would give every capped build a tree it did not
      // ask for, and `unspent` is reported precisely so that is visible.
      if (stalled >= preset.into.length) break;
      continue;
    }
    stalled = 0;
    spread[key] += 1;
    spent += 1;
    budget -= 1;
  }

  const specializations = [...tiers.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([specializationId, tier]) => ({ specializationId, tier }));
  return { attributes: spread, specializations, unspent: budget };
}
