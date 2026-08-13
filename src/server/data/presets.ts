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

export interface BuildPreset {
  readonly id: string;
  readonly name: string;
  /** What this build is for, in the words the harness prints beside its row. */
  readonly premise: string;
  /** Which attributes the points go into, in order, cycling. */
  readonly into: readonly AttributeKey[];
  /** The level the preset is built at. Decides the budget. */
  readonly level: number;
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
  return { id: `pure.${key}`, name, premise, into: [key], level: PRESET_LEVEL };
}

function hybrid(
  id: string,
  name: string,
  premise: string,
  a: AttributeKey,
  b: AttributeKey,
): BuildPreset {
  return { id, name, premise, into: [a, b], level: PRESET_LEVEL };
}

export const BUILD_PRESETS: readonly BuildPreset[] = [
  pure('strength', 'Pure Strength', 'Solves problems by ending them. Staggers, executes, and takes the resource back off the corpse.'),
  pure('agility', 'Pure Agility', 'Solves problems by not being there. Same attack rate as everyone; a quarter of the rooted time.'),
  pure('intelligence', 'Pure Intelligence', 'Solves problems by changing their shape. Reach, radius, and health spent as mana.'),
  pure('constitution', 'Pure Constitution', 'Solves problems by outlasting them. Cannot be staggered when it matters, and turns every heal into a buffer.'),
  pure('perception', 'Pure Perception', 'Solves problems by reading them. Doubles its weak-point chance against anything that has just committed.'),
  pure('wisdom', 'Pure Wisdom', 'Solves problems by never running out. Casts twice as often as the table intended, and adapts to whatever keeps hitting it.'),

  hybrid('pair.strCon', 'STR/CON', 'The juggernaut. Below half health every cast is armoured.', 'strength', 'constitution'),
  hybrid('pair.agiPer', 'AGI/PER', 'The ranger. Handling shortens projectile cooldowns; Flow buys weak-point chance.', 'agility', 'perception'),
  hybrid('pair.intWis', 'INT/WIS', 'The archmage. A prepared cast is free of the shaping premium and refunds its cooldown.', 'intelligence', 'wisdom'),
  hybrid('pair.strPer', 'STR/PER', 'The executioner. Weak points double poise damage; a staggered target under a quarter health takes 60% more.', 'strength', 'perception'),
  hybrid('pair.agiInt', 'AGI/INT', 'The spellblade. Walking out of a follow-through makes the next spell wind up at weapon speed.', 'agility', 'intelligence'),
  hybrid('pair.conWis', 'CON/WIS', 'The attrition specialist. Healing doubles below half health, and adaptation caps half again as high.', 'constitution', 'wisdom'),
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

export function fullSpreadOf(preset: BuildPreset): Spread {
  const spread: Record<AttributeKey, number> = Object.fromEntries(
    ATTRIBUTE_KEYS.map((key) => [key, SCALING.startingAttribute]),
  ) as Record<AttributeKey, number>;

  const levels = Math.max(0, preset.level - 1);
  let budget = SCALING.startingPoints + SCALING.pointsPerLevel * levels;

  let index = 0;
  let stalled = 0;
  while (budget > 0 && stalled < preset.into.length) {
    const key = preset.into[index % preset.into.length];
    index += 1;
    if (!key) break;
    if (spread[key] >= SCALING.attributeHardCap) {
      stalled += 1;
      continue;
    }
    stalled = 0;
    spread[key] += 1;
    budget -= 1;
  }
  return { attributes: spread, unspent: budget };
}
