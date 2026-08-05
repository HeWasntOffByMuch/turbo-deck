/**
 * Monster definitions (spec 056). Same contract as SKILLS and ITEMS: a spawned
 * entity stores a type id, and every number it fights with is read from here.
 *
 * Stats are expressed as a full {@link EffectiveStats} because the resolver does
 * not care whether an attacker is a player or not -- one shape, one code path.
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
    stats: {
      maxHealth: 24,
      moveSpeed: 40,
      turnRate: 120,
      attackDamage: 6,
      attackRange: 60,
      attackCooldownTicks: seconds(1.6),
      armor: 0,
      spellPower: 1,
      knockbackResist: 0.1,
      critChance: 0,
    },
  },
  {
    id: 'stalker',
    name: 'Stalker',
    radius: 20,
    aggroRange: 320,
    experience: 18,
    passive: false,
    stats: {
      maxHealth: 40,
      moveSpeed: 105,
      turnRate: 240,
      attackDamage: 11,
      attackRange: 70,
      attackCooldownTicks: seconds(1.2),
      armor: 0.05,
      spellPower: 1,
      knockbackResist: 0.2,
      critChance: 0.05,
    },
  },
  {
    id: 'ravager',
    name: 'Ravager',
    radius: 30,
    aggroRange: 420,
    experience: 55,
    passive: false,
    stats: {
      maxHealth: 140,
      moveSpeed: 95,
      turnRate: 150,
      attackDamage: 24,
      attackRange: 95,
      attackCooldownTicks: seconds(1.8),
      armor: 0.18,
      spellPower: 1,
      knockbackResist: 0.6,
      critChance: 0.1,
    },
  },
];

export const MONSTERS: ReadonlyMap<string, MonsterDefinition> = new Map(
  DEFINITIONS.map((monster) => [monster.id, monster]),
);

export const ALL_MONSTERS: readonly MonsterDefinition[] = DEFINITIONS;

export function monsterById(id: string): MonsterDefinition | null {
  return MONSTERS.get(id) ?? null;
}
