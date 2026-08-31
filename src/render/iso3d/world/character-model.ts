/**
 * What the HUD and the character sheet are handed (spec 128).
 *
 * The same job `inventory-model.ts` does for the bag, and for the same reason:
 * `src/ui/` may not import the sim, so somebody outside it has to turn the
 * replicated facts and the content tables into plain rows.
 *
 * The one decision here worth arguing about is that `canSpend` is answered by
 * `validateSpecializationSpend` -- the server's own function -- rather than by a
 * copy of the milestone rules written for the UI. A greyed-out button and a
 * refused request then cannot disagree, and the tooltip that says *why* says what
 * the server would have said.
 *
 * What this file builds since spec 244 is **six tracks**, and the shape of a
 * track comes from `data/tracks.ts` rather than from anything here: which
 * thresholds exist and what sits on each is content, and this is where a
 * character is placed on it. Nothing about *layout* is decided here or sent over
 * the wire -- no coordinates, no ordering beyond the tables' own -- because the
 * client owns how a track is drawn and the server owns what one is.
 *
 * Pure and headlessly tested.
 */

import { abilityById } from '../../../server/data/abilities.js';
import { ATTRIBUTES, type AttributeKey } from '../../../server/data/attributes.js';
import {
  specializationById,
  type SpecializationDefinition,
} from '../../../server/data/specializations.js';
import { describeSpecialization, technicalText } from '../../../server/data/description.js';
import { experienceForLevel } from '../../../server/player/player-manager.js';
import { RESPEC_COST, pointsSpent, validateAttributeSpend } from '../../../server/player/attributes.js';
import { milestoneProgress } from '../../../server/player/progression.js';
import { trackFor } from '../../../server/data/tracks.js';
import {
  costOfNextTier,
  tierOf,
  totalSpecializationTiers,
  validateSpecializationSpend,
} from '../../../server/player/specializations.js';
import { attackTimingFor } from '../../../server/sim/abilities.js';
import { resolveAttackTiming, type AttackTiming } from '../../../server/sim/attack-timing.js';
import type {
  BaseStats,
  EffectiveStats,
  SpecializationAllocation,
} from '../../../server/state/types.js';
import type { AbilityView, HudView } from '../../../ui/screens/hud.js';
import type {
  CharacterView,
  SpecializationView,
  TrackNodeView,
  TrackView,
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
  // The bow and the stars borrow glyphs rather than having their own. The names
  // outlived the abilities they were drawn for (spec 232) and are kept because
  // the *sprites* are still the right picture for a shot and a thrown blade.
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
  // The field (spec 223). A place rather than a blow, which is what the sprite
  // draws: every other cell on the bar is something you do to a body.
  'skill.scorchedEarth': 'ability:scorchedEarth',
  // The conjured light (spec 250). The one skill on the bar that does nothing
  // to anybody, which is what the sprite has to say: every other glyph in the
  // set is a blow or a place, and this is a lamp.
  'skill.conjureLight': 'ability:conjureLight',
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
    // Shown as what you may *break off* rather than as what you are committed
    // to, so it reads the same way round as every other row here -- bigger is
    // better -- and so the label is the controlled term for the act rather than
    // *recovery*, which `docs/mechanics-vocabulary.md` bans outright and which
    // this row used to be called. The Backswing itself is the same length for
    // everybody since spec 258; what Agility buys is the exit.
    label: 'Break off',
    of: (s) => `${Math.round((1 - s.traits.backswingCancelPct) * 100)}%`,
    hint: 'How much of your Backswing you may break off and walk away from. You are free to move sooner; you do not attack more often. Agility.',
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
  /** The one pool (spec 244), replicated on the `Stats` message. */
  readonly unspentProgressionPoints: number;
  readonly specializations: readonly SpecializationAllocation[];
  readonly stats: EffectiveStats;
  /** The progression half (spec 147), replicated on the `Stats` message. */
  readonly baseStats: BaseStats;
  readonly attributes: BaseStats;
  readonly coins: number;
}

/**
 * What a specialization's tooltip says (spec 191).
 *
 * Newline-joined rather than structured, because `SpecializationView.description`
 * is a string and `SpecializationRow.tooltip` splits it back into the lines the
 * `Tooltip` widget wraps individually. Keeping it a string is what lets the stat
 * lines go on answering `hintAt` exactly as they did.
 */
function specializationTooltip(
  specialization: SpecializationDefinition,
  tier: number,
): string {
  const described = describeSpecialization(specialization, tier);
  const body = technicalText(described);
  return described.flavor === null ? body : `${body}\n"${described.flavor}"`;
}

/**
 * The six tracks.
 *
 * `canAdvance` goes through `validateAttributeSpend` and `canSpend` through
 * `validateSpecializationSpend` -- the server's own functions, against the
 * client's copy of the record -- so a greyed-out "+" and a refused request cannot
 * disagree, and the tooltip that says why says what the server would have said.
 *
 * `nextEffect` and a milestone's `effect` are the tables' own strings, so the
 * sentence a player reads is the sentence the designer wrote beside the grant
 * rather than a second description of it kept in the UI.
 *
 * Both validators want a whole `PersistedPlayer` and this side has a fragment of
 * one, so a stand-in is built from the fields each actually reads. Deliberately a
 * local shim rather than a looser signature on the server's functions: the rule
 * belongs to the server and bending it to suit a caller is how a rule stops being
 * one.
 */
export function tracksOf(source: CharacterSource): readonly TrackView[] {
  const totals = source.attributes as unknown as Record<AttributeKey, number>;
  const attributeStand = {
    baseStats: source.baseStats,
    unspentProgressionPoints: source.unspentProgressionPoints,
  };
  const specializationStand = {
    specializations: source.specializations,
    unspentProgressionPoints: source.unspentProgressionPoints,
  };
  const progress = milestoneProgress(totals);

  return ATTRIBUTES.map((definition) => {
    const advance = validateAttributeSpend(attributeStand, definition.key);
    const mine = progress.find((entry) => entry.attribute === definition.key);
    const total = source.attributes[definition.key];
    const track = trackFor(definition.key);

    const nodes: TrackNodeView[] = track.nodes.map((node) => ({
      threshold: node.threshold,
      reached: total >= node.threshold,
      milestone:
        node.milestone === null
          ? null
          : { name: node.milestone.name, effect: node.milestone.effect },
      specializations: node.specializations.map((specialization): SpecializationView => {
        const tier = tierOf(source.specializations, specialization.id);
        const check = validateSpecializationSpend(specializationStand, totals, specialization.id);
        return {
          id: specialization.id,
          name: specialization.name,
          tier,
          maxTier: specialization.maxTier,
          cost: costOfNextTier(specialization),
          // Its own threshold rather than the node's, because Mastery lowers a
          // tier-3 requirement and a specialization a character can actually buy
          // must not be drawn as locked.
          unlocked: check.ok || check.reason !== 'attributeTooLow',
          // The Technical Description, derived (spec 191). It replaces
          // `description (trigger)`, which was the authored sentence and the
          // authored trigger and not one number -- so a player could read that
          // Crushing Blows made their blows "carry more weight" and never that it
          // was +18% Guard damage a tier.
          description: specializationTooltip(specialization, tier),
          canSpend: check.ok,
          blockedBecause: check.ok ? '' : check.detail,
        };
      }),
    }));

    // The *next* threshold on the track, which is not the same question
    // `milestoneProgress` answers: that one walks the automatic milestones alone,
    // and a track's next interesting number can be a specialization threshold
    // ten points below the next milestone. The sentence still comes from the
    // milestone where there is one, since a threshold that only unlocks a
    // purchase has no authored effect line of its own -- the specializations
    // under it are the answer, and they are drawn right there.
    const next = nodes.find((node) => !node.reached) ?? null;
    return {
      key: definition.key,
      // The name alone. It used to read "STR  Strength", and on a window this
      // narrow the redundant three letters pushed the value column into it.
      name: definition.name,
      abbrev: definition.abbrev,
      from: track.from,
      // The verb and what it owns, from the table rather than written here --
      // `owns` is already the reviewed list of what an attribute is the source
      // of, and a second description beside it is a second thing to keep true.
      description: `${definition.verb}. ${sentenceCase(definition.owns.join(', '))}.`,
      allocated: source.baseStats[definition.key],
      total,
      canAdvance: advance.ok,
      blockedBecause: advance.ok ? '' : advance.detail,
      nextThreshold: next?.threshold ?? 0,
      toNext: next ? Math.max(0, next.threshold - total) : 0,
      nextEffect: mine?.next ? `${mine.next.name}: ${mine.next.effect}` : '',
      tiersBought: totalSpecializationTiers(
        source.specializations.filter(
          (allocation) =>
            specializationById(allocation.specializationId)?.attribute === definition.key,
        ),
      ),
      nodes,
    };
  });
}

/** The sheet, from what the client was told. */
export function characterViewOf(source: CharacterSource): CharacterView {
  return {
    name: source.name,
    level: source.level,
    experience: { current: source.experience, toNext: experienceForLevel(source.level + 1) },
    unspentPoints: source.unspentProgressionPoints,
    stats: STAT_ROWS.map((row) => ({
      label: row.label,
      value: row.of(source.stats),
      hint: row.hint,
    })),
    tracks: tracksOf(source),
    respec: {
      cost: RESPEC_COST,
      // Both halves of the server's own rule, run against the client's copy:
      // there has to be something to hand back -- attributes or tiers, since spec
      // 244 refunds both together -- and the purse has to cover it.
      enabled:
        (pointsSpent(source.baseStats) > 0 ||
          totalSpecializationTiers(source.specializations) > 0) &&
        source.coins >= RESPEC_COST,
    },
  };
}

/** A skill's definition, for a caller that wants a name without the whole view. */
export function skillNameOf(id: string): string {
  return specializationById(id)?.name ?? id;
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
