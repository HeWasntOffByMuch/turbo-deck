/**
 * Monster definitions (spec 056). Same contract as SKILLS and ITEMS: a spawned
 * entity stores a type id, and every number it fights with is read from here.
 *
 * Stats are expressed as a full {@link EffectiveStats} because the resolver does
 * not care whether an attacker is a player or not -- one shape, one code path.
 * That now includes `attackSpeed` (spec 070), which is where a darting stalker
 * and a lumbering ravager stop feeling like the same fight at different damage
 * numbers: they swing at visibly different rates off the same swing.
 */

import { SERVER_TICK_RATE } from '../config.js';
import type { EffectiveStats } from '../state/types.js';

export interface MonsterDefinition {
  readonly id: string;
  readonly name: string;
  readonly radius: number;
  /** How far it notices a player, in world units. */
  readonly aggroRange: number;
  /** Experience granted to its killer. */
  readonly experience: number;
  readonly stats: EffectiveStats;
  /** Passive monsters only fight back once hit. */
  readonly passive: boolean;
  /**
   * The ability it swings with, or null for something that never attacks --
   * a training dummy, a critter, anything that is scenery with a health bar.
   */
  readonly ability: string | null;
}

function seconds(value: number): number {
  return Math.max(1, Math.round(value * SERVER_TICK_RATE));
}

const DEFINITIONS: readonly MonsterDefinition[] = [
  {
    id: 'grazer',
    name: 'Grazer',
    radius: 22,
    aggroRange: 0,
    experience: 8,
    passive: true,
    ability: 'melee.slash',
    stats: {
      maxHealth: 24,
      moveSpeed: 40,
      turnRate: 120,
      attackDamage: 6,
      attackRange: 60,
      attackCooldownTicks: seconds(1.6),
      attackSpeed: 1,
      armor: 0,
      spellPower: 1,
      critChance: 0,
      maxResource: 0,
      resourceRegen: 0,
    },
  },
  {
    id: 'stalker',
    name: 'Stalker',
    radius: 20,
    aggroRange: 320,
    experience: 18,
    passive: false,
    ability: 'melee.slash',
    stats: {
      maxHealth: 40,
      moveSpeed: 105,
      turnRate: 240,
      attackDamage: 11,
      attackRange: 70,
      attackCooldownTicks: seconds(1.2),
      attackSpeed: 1.35,
      armor: 0.05,
      spellPower: 1,
      critChance: 0.05,
      maxResource: 0,
      resourceRegen: 0,
    },
  },
  {
    id: 'ravager',
    name: 'Ravager',
    radius: 30,
    aggroRange: 420,
    experience: 55,
    passive: false,
    ability: 'melee.slash',
    stats: {
      maxHealth: 140,
      moveSpeed: 95,
      turnRate: 150,
      attackDamage: 24,
      attackRange: 95,
      attackCooldownTicks: seconds(1.8),
      attackSpeed: 0.8,
      armor: 0.18,
      spellPower: 1,
      critChance: 0.1,
      maxResource: 0,
      resourceRegen: 0,
    },
  },
];

const DUMMY: MonsterDefinition = {
  id: 'dummy',
  name: 'Training Dummy',
  radius: 22,
  aggroRange: 0,
  experience: 0,
  passive: true,
  ability: null,
  stats: {
    maxHealth: 100000,
    moveSpeed: 0,
    turnRate: 0,
    attackDamage: 0,
    attackRange: 0,
    attackCooldownTicks: 1,
    attackSpeed: 1,
    armor: 0,
    spellPower: 1,
    critChance: 0,
    maxResource: 0,
    resourceRegen: 0,
  },
};

export const MONSTERS: ReadonlyMap<string, MonsterDefinition> = new Map(
  [...DEFINITIONS, DUMMY].map((monster) => [monster.id, monster]),
);

export const ALL_MONSTERS: readonly MonsterDefinition[] = DEFINITIONS;

export function monsterById(id: string): MonsterDefinition | null {
  return MONSTERS.get(id) ?? null;
}
