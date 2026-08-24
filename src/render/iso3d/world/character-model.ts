/**
 * What the HUD and the character sheet are handed (spec 128).
 *
 * The same job `inventory-model.ts` does for the bag, and for the same reason:
 * `src/ui/` may not import the sim, so somebody outside it has to turn the
 * replicated facts and the content tables into plain rows.
 *
 * The one decision here worth arguing about is that `canSpend` is answered by
 * `validateSkillSpend` -- the server's own function -- rather than by a copy of
 * the tier rules written for the UI. A greyed-out button and a refused request
 * then cannot disagree, and the tooltip that says *why* says what the server
 * would have said.
 *
 * Pure and headlessly tested.
 */

import { abilityById } from '../../../server/data/abilities.js';
import { ATTRIBUTES, type AttributeKey } from '../../../server/data/attributes.js';
import { skillById, skillsFor, type SkillDefinition } from '../../../server/data/skills.js';
import { describeStatSkill, technicalText } from '../../../server/data/description.js';
import { experienceForLevel } from '../../../server/player/player-manager.js';
import { RESPEC_COST, pointsSpent, validateAttributeSpend } from '../../../server/player/attributes.js';
import { milestoneProgress } from '../../../server/player/progression.js';
import { levelOf, validateSkillSpend } from '../../../server/player/skills.js';
import { attackTimingFor } from '../../../server/sim/abilities.js';
import { resolveAttackTiming, type AttackTiming } from '../../../server/sim/attack-timing.js';
import type {
  BaseStats,
  EffectiveStats,
  SkillAllocation,
} from '../../../server/state/types.js';
import type { AbilityView, HudView } from '../../../ui/screens/hud.js';
import type {
  AttributeRowView,
  BranchView,
  CharacterView,
} from '../../../ui/screens/character.js';

/** Ticks per second, for turning a cooldown into the seconds a player reads. */
const TICK_RATE = 60;

/**
 * An ability id to a sprite name.
 *
 * Art direction, so it lives beside the other art mapping rather than in
 * `data/abilities.ts`, which is rules. An id with no entry draws the box.
 */
const ABILITY_ICONS: Readonly<Record<string, string>> = {
  'melee.slash': 'ability:slash',
  'melee.heavy': 'ability:heavy',
  'bolt.arcane': 'ability:bolt',
  'bolt.lob': 'ability:lob',
  'bolt.seek': 'ability:seek',
  'ground.quake': 'ability:quake',
  'self.mend': 'ability:mend',
  'channel.drain': 'ability:drain',
  'ranged.shot': 'ability:seek',
  'ranged.star': 'ability:slash',
  // The four active skills (spec 188) and the flask, which had no rows at all
  // until spec 196 put them on a bar somebody looks at: an id with no entry
  // draws the box, so every skill a player equipped and the vial beside them
  // came out as the same question mark.
  'skill.guardBreak': 'ability:guardBreak',
  'skill.stunningBlow': 'ability:stunningBlow',
  'skill.whirlwind': 'ability:whirlwind',
  'skill.cripplingStrike': 'ability:cripplingStrike',
  // The flask is a *thing* rather than a skill, which is the whole reason the
  // DOM bar drew it as an object too -- so it takes the item's art rather than
  // an ability glyph invented for it.
  'skill.poisonDart': 'ability:poisonDart',
  'skill.rendingCut': 'ability:rendingCut',
  'skill.acidSpray': 'ability:acidSpray',
  'skill.arcLash': 'ability:arcLash',
  'skill.blight': 'ability:blight',
  'skill.emberToss': 'ability:emberToss',
  'skill.rimeTouch': 'ability:rimeTouch',
  'skill.testStatuses': 'ability:testStatuses',
  'self.hearthdraught': 'item:potion',
};

export const UNKNOWN_ABILITY_ICON = 'item:unknown';

export function abilityIconFor(id: string): string {
  return ABILITY_ICONS[id] ?? UNKNOWN_ABILITY_ICON;
}

export interface HudSource {
  readonly health: number;
  readonly maxHealth: number;
  readonly resource: number;
  readonly maxResource: number;
  /** Ability id -> the tick it is ready on, straight from the server. */
  readonly cooldowns: Readonly<Record<string, number>>;
  /** The tick being drawn, so a sweep is measured against it and not a clock. */
  readonly tick: number;
  /** What is winding up on this body, or null. */
  readonly cast: { readonly abilityId: string; readonly progress: number } | null;
  /** The abilities on the bar, in order. */
  readonly hotbar: readonly string[];
  /** What each slot's key is called, from the InputMap. */
  readonly keyLabels: readonly string[];
}

/**
 * One slot's view.
 *
 * The sweep is a *fraction of this ability's own cooldown*, not of a fixed
 * window: a two-second cooldown and a twelve-second one both fill their slot
 * over their own length, which is what makes the wedge readable as "nearly
 * back" rather than as an absolute duration nobody can compare.
 */
export function abilityViewOf(
  abilityId: string,
  readyAtTick: number,
  tick: number,
  resource: number,
): AbilityView | null {
  const ability = abilityById(abilityId);
  if (!ability) return null;
  const remaining = Math.max(0, readyAtTick - tick);
  const length = Math.max(1, ability.cooldownTicks);
  return {
    id: abilityId,
    name: ability.name,
    icon: abilityIconFor(abilityId),
    cost: ability.cost,
    sweep: Math.min(1, remaining / length),
    affordable: resource >= ability.cost,
    secondsLeft: remaining / TICK_RATE,
  };
}

export function hudViewOf(source: HudSource): HudView {
  const cast = source.cast ? abilityById(source.cast.abilityId) : null;
  return {
    health: { current: source.health, max: source.maxHealth },
    resource: { current: source.resource, max: source.maxResource },
    cast: cast && source.cast ? { name: cast.name, progress: source.cast.progress } : null,
    slots: source.hotbar.map((id) =>
      abilityViewOf(id, source.cooldowns[id] ?? 0, source.tick, source.resource),
    ),
    keyLabels: source.keyLabels,
  };
}

/**
 * This body's basic attack, resolved -- or a bare BAT with nothing swinging it,
 * for a unit whose `basicAttackId` names nothing (the training dummy).
 *
 * Through the sim's own resolver, so the sheet cannot quote a rate the sim does
 * not run at.
 */
function basicAttackTiming(stats: EffectiveStats): AttackTiming {
  const ability = abilityById(stats.basicAttackId);
  if (ability) return attackTimingFor(ability, { stats });
  return resolveAttackTiming(
    {
      baseAttackTimeTicks: stats.baseAttackTimeTicks,
      baseAttackPointTicks: 1,
      baseAttackBackswingTicks: 0,
    },
    stats,
    TICK_RATE,
  );
}

/**
 * How a stat is named, formatted, and explained on the sheet.
 *
 * `hint` is one short sentence, and the rule for writing one is the rule the
 * whole sheet is built on: **say what it does, or say that it does nothing.**
 * A stat with no hint is a number a player has to guess about; a stat with a
 * confident hint that is not actually wired to anything is worse, because they
 * will build toward it. Where something is a socket with no source plugged into
 * it yet, the hint says so in as many words.
 */
const STAT_ROWS: readonly {
  readonly label: string;
  readonly of: (stats: EffectiveStats) => string;
  readonly hint: string;
}[] = [
  { label: 'Health', of: (s) => String(Math.round(s.maxHealth)), hint: 'Damage you can take before dying. Mostly Constitution.' },
  {
    label: 'Damage',
    of: (s) => String(Math.round(s.attackDamage)),
    hint: 'How hard your weapon hits. Multiplies every basic attack. Which attributes raise it is the weapon\'s own scaling.',
  },
  { label: 'Range', of: (s) => String(Math.round(s.attackRange)), hint: 'How far your weapon reaches, in world units.' },
  // Ticks are a server unit; a player reads swings per second (specs 088, 144).
  // Through the *basic attack's* resolved timing rather than off BAT directly,
  // because attack speed divides one into the other and this row is the number
  // the player is actually attacking at.
  {
    label: 'Speed',
    of: (s) => `${basicAttackTiming(s).attacksPerSecond.toFixed(2)}/s`,
    hint: 'Attacks per second, after your weapon. Agility shortens the swing, not the cadence.',
  },
  // What that rate is before attack speed, and what attack speed is doing to it
  // (spec 144). Two rows rather than one, because a player who cannot see both
  // cannot tell a slow weapon from a slowed body.
  {
    label: 'Base attack time',
    of: (s) => `${(s.baseAttackTimeTicks / TICK_RATE).toFixed(2)}s`,
    hint: 'Seconds between one attack starting and the next. The same for every weapon.',
  },
  {
    label: 'Attack speed',
    // The factor rather than the additive `attackSpeed` stat (spec 174). Both
    // are real and only one has a source: items author `attackSpeedPct`, which
    // is a multiplier, and nothing authors the flat half. The rule at the top
    // of this table says to state what a number does or state that it does
    // nothing, and a permanently-zero `+0` printed beside a factor that moves
    // is the one thing that manages neither.
    of: (s) => `${basicAttackTiming(s).factor.toFixed(2)}x`,
    hint: 'Divides the gap between attacks, the wind-up and the recovery alike. From your weapon.',
  },
  { label: 'Armour', of: (s) => `${Math.round(s.armor * 100)}%`, hint: 'Fraction of incoming damage removed. Constitution, and a little Agility.' },
  {
    label: 'Crit',
    of: (s) => `${Math.round(s.critChance * 100)}%`,
    hint: 'Chance a blow deals 75% extra. Perception.',
  },
  { label: 'Power', of: (s) => s.spellPower.toFixed(2), hint: 'Multiplies ability damage, not weapon damage. Intelligence.' },
  { label: 'Move', of: (s) => String(Math.round(s.moveSpeed)), hint: 'World units per second on foot. Agility.' },
  { label: 'Pool', of: (s) => String(Math.round(s.maxResource)), hint: 'What abilities are paid out of. Intelligence, and a little Wisdom.' },
  // The progression numbers (spec 147). Chosen so that every one of the six
  // attributes has at least one row that visibly moves when a point goes into
  // it -- a sheet where an attribute changes nothing you can see is a sheet that
  // cannot be used to make a decision.
  {
    label: 'Guard',
    of: (s) => String(Math.round(s.traits.maxPoise)),
    hint: 'Poise. Spent by blows landing on you; when it empties you are staggered. Constitution.',
  },
  {
    // `poiseRegen` is per *tick* -- `derived.ts` divides by the tick rate on the
    // line that computes it -- and a player reads seconds. Multiplied back here
    // rather than stored twice, so there is still one number.
    label: 'Guard regen',
    of: (s) => `${(s.traits.poiseRegen * TICK_RATE).toFixed(1)}/s`,
    hint: 'Guard you get back per second, and only while standing still until something grants otherwise. Constitution.',
  },
  {
    label: 'Stagger',
    of: (s) => String(Math.round(s.traits.staggerPower)),
    hint: 'Guard your blows take off. Break someone and they are rooted and lose what they were casting. Strength.',
  },
  {
    label: 'Hyper-armour',
    of: (s) => `${Math.round(s.traits.windupPoiseArmor * 100)}%`,
    hint: 'Guard damage you ignore -- but only while committed to a wind-up, never while idle. Strength.',
  },
  // As percentages of the authored animation, because "0.72x" is a ratio nobody
  // has the other half of. 28% shorter is a sentence.
  {
    label: 'Recovery',
    of: (s) => `-${Math.round((1 - s.traits.backswingScale) * 100)}%`,
    hint: 'How much shorter your follow-through is. You are free to move sooner; you do not attack more often. Agility.',
  },
  {
    label: 'Wind-up',
    of: (s) => `-${Math.round((1 - s.traits.attackPointScale) * 100)}%`,
    hint: 'How much sooner your blows land. Agility.',
  },
  {
    label: 'Weak point',
    of: (s) => `${Math.round(s.traits.weakPointChance * 100)}%`,
    hint: 'Chance a blow finds a seam: extra damage, and it leaves the target exposed for everyone. Perception.',
  },
  {
    label: 'Ability cost',
    of: (s) => `-${Math.round((1 - s.traits.resourceCostScale) * 100)}%`,
    hint: 'How much less abilities cost. Wisdom.',
  },
  {
    label: 'Cooldowns',
    of: (s) => `-${Math.round((1 - s.traits.cooldownScale) * 100)}%`,
    hint: 'How much sooner abilities come back. Wisdom.',
  },
  {
    label: 'Healing',
    of: (s) => `${Math.round(s.traits.healingScale * 100)}%`,
    hint: 'What a heal is worth on you. Wisdom, and a little Constitution.',
  },
];

export interface CharacterSource {
  readonly name: string;
  readonly level: number;
  readonly experience: number;
  readonly unspentSkillPoints: number;
  readonly skills: readonly SkillAllocation[];
  readonly stats: EffectiveStats;
  /** The progression half (spec 147), replicated on the `Stats` message. */
  readonly baseStats: BaseStats;
  readonly attributes: BaseStats;
  readonly unspentAttributePoints: number;
  readonly coins: number;
}

/**
 * The six attribute rows.
 *
 * `canAllocate` goes through `validateAttributeSpend` -- the server's own
 * function -- for the reason `canSpend` goes through `validateSkillSpend`: a
 * greyed-out "+" and a refused request must not be able to disagree, and the
 * tooltip that says why should say what the server would have said.
 *
 * `nextEffect` is the milestone's own `effect` string, so the sentence a player
 * reads is the sentence the designer wrote beside the grant rather than a second
 * description of it kept in the UI.
 */
export function attributeRowsOf(source: CharacterSource): readonly AttributeRowView[] {
  const stand = {
    baseStats: source.baseStats,
    unspentAttributePoints: source.unspentAttributePoints,
  };
  const progress = milestoneProgress(source.attributes as unknown as Record<AttributeKey, number>);
  return ATTRIBUTES.map((definition) => {
    const check = validateAttributeSpend(stand, definition.key);
    const mine = progress.find((entry) => entry.attribute === definition.key);
    return {
      key: definition.key,
      // The name alone. It used to read "STR  Strength", and on a window this
      // narrow the redundant three letters pushed the value column into it.
      name: definition.name,
      abbrev: definition.abbrev,
      // The verb and what it owns, from the table rather than written here --
      // `owns` is already the reviewed list of what an attribute is the source
      // of, and a second description beside it is a second thing to keep true.
      description: `${definition.verb}. ${sentenceCase(definition.owns.join(', '))}.`,
      allocated: source.baseStats[definition.key],
      total: source.attributes[definition.key],
      canAllocate: check.ok,
      blockedBecause: check.ok ? '' : check.detail,
      nextEffect: mine?.next ? `${mine.next.name} — ${mine.next.effect}` : '',
      toNext: mine?.remaining ?? 0,
      active: (mine?.met ?? []).map((milestone) => milestone.name),
    };
  });
}

/**
 * What a skill row's tooltip says (spec 191).
 *
 * Newline-joined rather than structured, because `SkillView.description` is a
 * string and `SkillRow.tooltip` splits it back into the lines the `Tooltip`
 * widget wraps individually. Keeping it a string is what lets the attribute
 * rows and the stat lines go on answering `hintAt` exactly as they did.
 */
function skillTooltip(skill: SkillDefinition, level: number): string {
  const described = describeStatSkill(skill, level);
  const body = technicalText(described);
  return described.flavor === null ? body : `${body}\n"${described.flavor}"`;
}

/** The attuned tree, as one `BranchView` per attribute (spec 147). */
export function skillBranchesOf(source: CharacterSource): readonly BranchView[] {
  const totals = source.attributes as unknown as Record<AttributeKey, number>;
  const stand = { skills: source.skills, unspentSkillPoints: source.unspentSkillPoints };
  return ATTRIBUTES.map((definition) => ({
    id: `attr:${definition.key}`,
    name: definition.abbrev,
    pointsSpent: source.skills
      .filter((allocation) => skillById(allocation.skillId)?.attribute === definition.key)
      .reduce((sum, allocation) => sum + allocation.level, 0),
    skills: skillsFor(definition.key).map((skill) => {
      const check = validateSkillSpend(stand, totals, skill.id);
      return {
        id: skill.id,
        name: skill.name,
        tier: skill.tier,
        level: levelOf(source.skills, skill.id),
        maxLevel: skill.maxLevel,
        // The Technical Description, derived (spec 191). It replaces
        // `description (trigger)`, which was the authored sentence and the
        // authored trigger and not one number -- so a player could read that
        // Crushing Blows made their blows "carry more weight" and never that it
        // was +18% Guard damage a rank. The flavour is still here and still
        // last, separated by the quotes rather than run into the mechanics.
        description: skillTooltip(skill, levelOf(source.skills, skill.id)),
        canSpend: check.ok,
        blockedBecause: check.ok ? '' : check.detail,
      };
    }),
  }));
}

/**
 * The sheet, from what the client was told.
 *
 * `validateSkillSpend` wants a whole `PersistedPlayer` and this side has a
 * fragment of one, so a stand-in is built from the fields it actually reads --
 * skills, level and unspent points. Deliberately a local shim rather than a
 * looser signature on the server's function: the rule belongs to the server and
 * bending it to suit a caller is how a rule stops being one.
 */
export function characterViewOf(source: CharacterSource): CharacterView {
  return {
    name: source.name,
    level: source.level,
    experience: { current: source.experience, toNext: experienceForLevel(source.level + 1) },
    unspentPoints: source.unspentSkillPoints,
    unspentAttributePoints: source.unspentAttributePoints,
    stats: STAT_ROWS.map((row) => ({
      label: row.label,
      value: row.of(source.stats),
      hint: row.hint,
    })),
    attributes: attributeRowsOf(source),
    // No pair list, and deliberately none (spec 147). The fifteen two-attribute
    // interactions are *live* -- they are in the sim and they are in the derived
    // traits -- and they are not named on this screen. Printing "Duelist: each
    // Flow stack grants 4% damage reduction" turns a discovery into a menu, and
    // the whole premise of the design is that a player asks "how do I want to
    // solve problems" rather than "which of the fifteen am I building toward".
    // What a player is told is what their own attributes do next; what a pair
    // does, they find out by having one.
    branches: skillBranchesOf(source),
    respec: {
      cost: RESPEC_COST,
      // Both halves of the server's own rule, run against the client's copy:
      // there has to be something to hand back, and the purse has to cover it.
      enabled: pointsSpent(source.baseStats) > 0 && source.coins >= RESPEC_COST,
    },
  };
}

/** A skill's definition, for a caller that wants a name without the whole view. */
export function skillNameOf(id: string): string {
  return skillById(id)?.name ?? id;
}

/**
 * First letter up, and nothing else touched.
 *
 * `owns` is authored as a list of mechanics rather than as prose -- "poise
 * damage", not "Poise damage" -- because a test reads it and a reviewer holds a
 * new mechanic up against it. Turning the joined list into a sentence is this
 * side's job, so the table stays a table.
 */
function sentenceCase(text: string): string {
  return text.slice(0, 1).toUpperCase() + text.slice(1);
}
