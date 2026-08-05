/**
 * The SKILLS definition table (spec 056).
 *
 * Placeholder content in a production-shaped schema: the point of shipping real
 * rows rather than an empty table is that the validation rules and the stat
 * pipeline get exercised against actual data, so a schema that cannot express a
 * real tree fails now rather than after everything is built on it.
 *
 * A player's save holds only `{ skillId, level }`. Everything a skill *does*
 * lives here and is re-read on every recalculation, so rebalancing a skill
 * changes every character the next time they log in -- no migration.
 */

import type { StatModifier } from './modifiers.js';

export type SkillBranchId = 'might' | 'finesse' | 'arcane';

export interface SkillBranch {
  readonly id: SkillBranchId;
  readonly name: string;
  /**
   * Branches this one locks out. Spending a point here makes every listed
   * branch permanently unavailable to that character -- the commitment that
   * makes a build a build. Symmetric by convention, and asserted in the tests.
   */
  readonly locks: readonly SkillBranchId[];
}

export const SKILL_BRANCHES: readonly SkillBranch[] = [
  { id: 'might', name: 'Might', locks: ['arcane'] },
  { id: 'finesse', name: 'Finesse', locks: [] },
  { id: 'arcane', name: 'Arcane', locks: ['might'] },
];

/**
 * Points that must already be spent *in the same branch* before a tier opens.
 * Index is the tier; tier 1 is free, tier 2 wants 3 points, tier 3 wants 8.
 */
export const TIER_POINT_GATE: readonly number[] = [0, 0, 3, 8];

export const MAX_SKILL_TIER = 3;

export interface SkillDefinition {
  readonly id: string;
  readonly name: string;
  readonly branch: SkillBranchId;
  readonly tier: number;
  readonly maxLevel: number;
  /** Skills that must be at level >= 1 before this one may be taken. */
  readonly requires: readonly string[];
  /** What one level is worth; the effective total is this times the level held. */
  readonly perLevel: StatModifier;
  readonly description: string;
}

const DEFINITIONS: readonly SkillDefinition[] = [
  // --- Might ---
  {
    id: 'might.toughness',
    name: 'Toughness',
    branch: 'might',
    tier: 1,
    maxLevel: 5,
    requires: [],
    perLevel: { maxHealth: 12, knockbackResist: 0.02 },
    description: 'Flat health and a firmer footing against knockback.',
  },
  {
    id: 'might.heavyBlows',
    name: 'Heavy Blows',
    branch: 'might',
    tier: 1,
    maxLevel: 5,
    requires: [],
    perLevel: { attackDamage: 2 },
    description: 'Every swing hits harder.',
  },
  {
    id: 'might.bulwark',
    name: 'Bulwark',
    branch: 'might',
    tier: 2,
    maxLevel: 3,
    requires: ['might.toughness'],
    perLevel: { armor: 0.03, maxHealth: 20 },
    description: 'Armour and bulk, at the cost of nothing but points.',
  },
  {
    id: 'might.cleave',
    name: 'Cleave',
    branch: 'might',
    tier: 3,
    maxLevel: 1,
    requires: ['might.heavyBlows', 'might.bulwark'],
    perLevel: { attackDamagePct: 0.15, attackRange: 12 },
    description: 'A wider, heavier arc.',
  },
  // --- Finesse ---
  {
    id: 'finesse.footwork',
    name: 'Footwork',
    branch: 'finesse',
    tier: 1,
    maxLevel: 5,
    requires: [],
    perLevel: { moveSpeed: 4, turnRate: 12 },
    description: 'Move and pivot faster.',
  },
  {
    id: 'finesse.precision',
    name: 'Precision',
    branch: 'finesse',
    tier: 1,
    maxLevel: 5,
    requires: [],
    perLevel: { attackCooldownTicks: -0.4, dexterity: 1 },
    description: 'A quicker recovery between swings.',
  },
  {
    id: 'finesse.slipstream',
    name: 'Slipstream',
    branch: 'finesse',
    tier: 2,
    maxLevel: 3,
    requires: ['finesse.footwork'],
    perLevel: { moveSpeedPct: 0.04 },
    description: 'Compounding movement speed.',
  },
  {
    id: 'finesse.flurry',
    name: 'Flurry',
    branch: 'finesse',
    tier: 3,
    maxLevel: 1,
    requires: ['finesse.precision', 'finesse.slipstream'],
    perLevel: { attackCooldownTicks: -3, attackDamagePct: 0.05 },
    description: 'A markedly faster attack cadence.',
  },
  // --- Arcane ---
  {
    id: 'arcane.focus',
    name: 'Focus',
    branch: 'arcane',
    tier: 1,
    maxLevel: 5,
    requires: [],
    perLevel: { intelligence: 1, spellPower: 0.04 },
    description: 'Sharper mind, stronger abilities.',
  },
  {
    id: 'arcane.wards',
    name: 'Wards',
    branch: 'arcane',
    tier: 1,
    maxLevel: 5,
    requires: [],
    perLevel: { armor: 0.015, maxHealth: 6 },
    description: 'A thin protective ward.',
  },
  {
    id: 'arcane.channeling',
    name: 'Channeling',
    branch: 'arcane',
    tier: 2,
    maxLevel: 3,
    requires: ['arcane.focus'],
    perLevel: { spellPower: 0.08, attackRange: 8 },
    description: 'Reach further, hit harder with abilities.',
  },
  {
    id: 'arcane.overload',
    name: 'Overload',
    branch: 'arcane',
    tier: 3,
    maxLevel: 1,
    requires: ['arcane.focus', 'arcane.channeling'],
    perLevel: { spellPower: 0.25, maxHealthPct: -0.1 },
    description: 'Far greater ability damage, at the cost of your own health pool.',
  },
];

export const SKILLS: ReadonlyMap<string, SkillDefinition> = new Map(
  DEFINITIONS.map((skill) => [skill.id, skill]),
);

export const ALL_SKILLS: readonly SkillDefinition[] = DEFINITIONS;

export function skillById(id: string): SkillDefinition | null {
  return SKILLS.get(id) ?? null;
}

export function branchById(id: string): SkillBranch | null {
  return SKILL_BRANCHES.find((branch) => branch.id === id) ?? null;
}
