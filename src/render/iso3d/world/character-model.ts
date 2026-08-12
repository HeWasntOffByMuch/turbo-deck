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
import { ATTRIBUTES, attributeByKey, type AttributeKey } from '../../../server/data/attributes.js';
import { SKILL_BRANCHES, skillById, ALL_SKILLS } from '../../../server/data/skills.js';
import { statSkillById, statSkillsFor } from '../../../server/data/stat-skills.js';
import { ALL_SYNERGIES, metSynergies } from '../../../server/data/synergies.js';
import { experienceForLevel } from '../../../server/player/player-manager.js';
import { RESPEC_COST, pointsSpent, validateAttributeSpend } from '../../../server/player/attributes.js';
import { milestoneProgress } from '../../../server/player/progression.js';
import { levelOfStatSkill, validateStatSkillSpend } from '../../../server/player/stat-skills.js';
import { attackTimingFor } from '../../../server/sim/abilities.js';
import { resolveAttackTiming, type AttackTiming } from '../../../server/sim/attack-timing.js';
import { lockedBranches, pointsInBranch, levelOf, validateSkillSpend } from '../../../server/player/skills.js';
import type {
  BaseStats,
  EffectiveStats,
  PersistedPlayer,
  SkillAllocation,
} from '../../../server/state/types.js';
import type { AbilityView, HudView } from '../../../ui/screens/hud.js';
import type {
  AttributeRowView,
  BranchView,
  CharacterView,
  SkillView,
  SynergyRowView,
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

/** How a stat is named and formatted on the sheet. */
const STAT_ROWS: readonly {
  readonly label: string;
  readonly of: (stats: EffectiveStats) => string;
}[] = [
  { label: 'Health', of: (s) => String(Math.round(s.maxHealth)) },
  { label: 'Damage', of: (s) => String(Math.round(s.attackDamage)) },
  { label: 'Range', of: (s) => String(Math.round(s.attackRange)) },
  // Ticks are a server unit; a player reads swings per second (specs 088, 144).
  // Through the *basic attack's* resolved timing rather than off BAT directly,
  // because attack speed divides one into the other and this row is the number
  // the player is actually attacking at.
  { label: 'Speed', of: (s) => `${basicAttackTiming(s).attacksPerSecond.toFixed(2)}/s` },
  // What that rate is before attack speed, and what attack speed is doing to it
  // (spec 144). Two rows rather than one, because a player who cannot see both
  // cannot tell a slow weapon from a slowed body.
  { label: 'Base attack time', of: (s) => `${(s.baseAttackTimeTicks / TICK_RATE).toFixed(2)}s` },
  {
    label: 'Attack speed',
    of: (s) => {
      const factor = basicAttackTiming(s).factor;
      return `${s.attackSpeed >= 0 ? '+' : ''}${Math.round(s.attackSpeed)} (${factor.toFixed(2)}x)`;
    },
  },
  { label: 'Armour', of: (s) => `${Math.round(s.armor * 100)}%` },
  { label: 'Crit', of: (s) => `${Math.round(s.critChance * 100)}%` },
  { label: 'Power', of: (s) => s.spellPower.toFixed(2) },
  { label: 'Move', of: (s) => String(Math.round(s.moveSpeed)) },
  { label: 'Pool', of: (s) => String(Math.round(s.maxResource)) },
  // The progression numbers (spec 147). Chosen so that every one of the six
  // attributes has at least one row that visibly moves when a point goes into
  // it -- a sheet where an attribute changes nothing you can see is a sheet that
  // cannot be used to make a decision.
  { label: 'Guard', of: (s) => String(Math.round(s.traits.maxPoise)) },
  { label: 'Stagger', of: (s) => String(Math.round(s.traits.staggerPower)) },
  // As percentages of the authored animation, because "0.72x" is a ratio nobody
  // has the other half of. 28% shorter is a sentence.
  {
    label: 'Recovery',
    of: (s) => `-${Math.round((1 - s.traits.backswingScale) * 100)}%`,
  },
  { label: 'Wind-up', of: (s) => `-${Math.round((1 - s.traits.attackPointScale) * 100)}%` },
  { label: 'Weak point', of: (s) => `${Math.round(s.traits.weakPointChance * 100)}%` },
  { label: 'Ability cost', of: (s) => `-${Math.round((1 - s.traits.resourceCostScale) * 100)}%` },
  { label: 'Cooldowns', of: (s) => `-${Math.round((1 - s.traits.cooldownScale) * 100)}%` },
  { label: 'Healing', of: (s) => `${Math.round(s.traits.healingScale * 100)}%` },
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
  readonly statSkills: readonly SkillAllocation[];
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
      name: `${definition.abbrev}  ${definition.name}`,
      abbrev: definition.abbrev,
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
 * All fifteen pairs, active or not.
 *
 * Every one of them, always. A list that showed only what a character already
 * has cannot answer the question a player actually has in front of the sheet --
 * *what is one point away* -- and the fifteen rows are the design's own claim
 * that no pair is a dead end, so hiding fourteen of them hides the claim.
 */
export function synergyRowsOf(attributes: BaseStats): readonly SynergyRowView[] {
  const totals = attributes as unknown as Record<AttributeKey, number>;
  const active = new Set(metSynergies(totals).map((synergy) => synergy.id));
  return ALL_SYNERGIES.map((synergy) => ({
    id: synergy.id,
    name: synergy.name,
    effect: synergy.effect,
    active: active.has(synergy.id),
    requirement: `${abbrev(synergy.a)} ${synergy.threshold} / ${abbrev(synergy.b)} ${synergy.threshold}`,
  }));
}

function abbrev(key: AttributeKey): string {
  return attributeByKey(key)?.abbrev ?? key.slice(0, 3).toUpperCase();
}

/** The attuned tree, as one `BranchView` per attribute (spec 147). */
export function statSkillBranchesOf(source: CharacterSource): readonly BranchView[] {
  const totals = source.attributes as unknown as Record<AttributeKey, number>;
  const stand = { statSkills: source.statSkills, unspentSkillPoints: source.unspentSkillPoints };
  return ATTRIBUTES.map((definition) => ({
    id: `attr:${definition.key}`,
    name: definition.abbrev,
    // Nothing in this tree locks anything. The field exists because the branch
    // tree has it, and it is false here forever -- which is the design decision,
    // stated where a reader will see it.
    locked: false,
    pointsSpent: source.statSkills
      .filter((allocation) => statSkillById(allocation.skillId)?.attribute === definition.key)
      .reduce((sum, allocation) => sum + allocation.level, 0),
    skills: statSkillsFor(definition.key).map((skill) => {
      const check = validateStatSkillSpend(stand, totals, skill.id);
      return {
        id: skill.id,
        name: skill.name,
        tier: skill.tier,
        level: levelOfStatSkill(source.statSkills, skill.id),
        maxLevel: skill.maxLevel,
        description: `${skill.description} (${skill.trigger})`,
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
  const stand = {
    skills: source.skills,
    level: source.level,
    unspentSkillPoints: source.unspentSkillPoints,
  } as unknown as PersistedPlayer;

  const locked = lockedBranches(source.skills);
  const branches: BranchView[] = SKILL_BRANCHES.map((branch) => {
    const skills: SkillView[] = ALL_SKILLS.filter((skill) => skill.branch === branch.id)
      .slice()
      .sort((a, b) => a.tier - b.tier || (a.id < b.id ? -1 : 1))
      .map((skill) => {
        const check = validateSkillSpend(stand, skill.id);
        return {
          id: skill.id,
          name: skill.name,
          tier: skill.tier,
          level: levelOf(source.skills, skill.id),
          maxLevel: skill.maxLevel,
          description: skill.description,
          canSpend: check.ok,
          blockedBecause: check.ok ? '' : check.detail,
        };
      });
    return {
      id: branch.id,
      name: branch.name,
      locked: locked.has(branch.id),
      pointsSpent: pointsInBranch(source.skills, branch.id),
      skills,
    };
  });

  return {
    name: source.name,
    level: source.level,
    experience: { current: source.experience, toNext: experienceForLevel(source.level + 1) },
    unspentPoints: source.unspentSkillPoints,
    unspentAttributePoints: source.unspentAttributePoints,
    stats: STAT_ROWS.map((row) => ({ label: row.label, value: row.of(source.stats) })),
    attributes: attributeRowsOf(source),
    synergies: synergyRowsOf(source.attributes),
    branches,
    statSkills: statSkillBranchesOf(source),
    respec: {
      cost: RESPEC_COST,
      // Both halves of the server's own rule, run against the client's copy:
      // there has to be something to hand back, and the purse has to cover it.
      enabled: pointsSpent(source.baseStats) > 0 && source.coins >= RESPEC_COST,
    },
  };
}

/** Every skill the table defines, sorted by branch then tier. For the sheet. */
export function skillIdsOf(branchId: string): readonly string[] {
  return ALL_SKILLS.filter((skill) => skill.branch === branchId).map((skill) => skill.id);
}

/** A skill's definition, for a caller that wants a name without the whole view. */
export function skillNameOf(id: string): string {
  return skillById(id)?.name ?? id;
}
