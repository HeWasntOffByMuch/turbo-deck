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
import { SKILL_BRANCHES, skillById, ALL_SKILLS } from '../../../server/data/skills.js';
import { experienceForLevel } from '../../../server/player/player-manager.js';
import { attackTimingFor } from '../../../server/sim/abilities.js';
import { resolveAttackTiming, type AttackTiming } from '../../../server/sim/attack-timing.js';
import { lockedBranches, pointsInBranch, levelOf, validateSkillSpend } from '../../../server/player/skills.js';
import type { EffectiveStats, PersistedPlayer, SkillAllocation } from '../../../server/state/types.js';
import type { AbilityView, HudView } from '../../../ui/screens/hud.js';
import type { BranchView, CharacterView, SkillView } from '../../../ui/screens/character.js';

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
];

export interface CharacterSource {
  readonly name: string;
  readonly level: number;
  readonly experience: number;
  readonly unspentSkillPoints: number;
  readonly skills: readonly SkillAllocation[];
  readonly stats: EffectiveStats;
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
    stats: STAT_ROWS.map((row) => ({ label: row.label, value: row.of(source.stats) })),
    branches,
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
