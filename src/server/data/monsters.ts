/**
 * Monster definitions (spec 056). Same contract as SKILLS and ITEMS: a spawned
 * entity stores a type id, and every number it fights with is read from here.
 *
 * Stats are expressed as a full {@link EffectiveStats} because the resolver does
 * not care whether an attacker is a player or not -- one shape, one code path.
 * That includes `attackDelayTicks` (spec 082), which is where a darting stalker
 * and a lumbering ravager stop feeling like the same fight at different damage
 * numbers: they swing at visibly different rates off the same swing. It is the
 * delay itself, in ticks -- a row says how long this body waits, rather than a
 * base cadence and a multiplier over it that had to be divided to mean anything.
 *
 * Since spec 079 it also includes `basicAttackId`, which is where the monster's
 * `ability` field went. Two places naming what a body swings with was one too
 * many, and the sim was already reaching past the entity to find the other one.
 * An empty id is a training dummy: scenery with a health bar.
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
      attackDelayTicks: seconds(1.6),
      armor: 0,
      spellPower: 1,
      critChance: 0,
      maxResource: 0,
      resourceRegen: 0,
      basicAttackId: 'melee.slash',
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
      attackDelayTicks: seconds(0.9),
      armor: 0.05,
      spellPower: 1,
      critChance: 0.05,
      maxResource: 0,
      resourceRegen: 0,
      basicAttackId: 'melee.slash',
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
      attackDelayTicks: seconds(2.25),
      armor: 0.18,
      spellPower: 1,
      critChance: 0.1,
      maxResource: 0,
      resourceRegen: 0,
      basicAttackId: 'melee.slash',
    },
  },
  {
    id: 'slinger',
    name: 'Slinger',
    radius: 20,
    // Notices further than it can throw, so it opens the fight by closing to
    // its own standoff rather than being walked up on.
    aggroRange: 520,
    experience: 32,
    passive: false,
    stats: {
      maxHealth: 34,
      moveSpeed: 90,
      turnRate: 200,
      attackDamage: 9,
      // `monsterIntent` stands off at the *ability's* range, so this number only
      // matters to a body that has lost its throwing arm. The star reaches 300.
      attackRange: 300,
      attackDelayTicks: seconds(1.4),
      armor: 0,
      spellPower: 1,
      critChance: 0.05,
      maxResource: 0,
      resourceRegen: 0,
      basicAttackId: 'ranged.star',
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
  stats: {
    maxHealth: 100000,
    moveSpeed: 0,
    turnRate: 0,
    attackDamage: 0,
    attackRange: 0,
    attackDelayTicks: 1,
    armor: 0,
    spellPower: 1,
    critChance: 0,
    maxResource: 0,
    resourceRegen: 0,
    basicAttackId: '',
  },
};

export const MONSTERS: ReadonlyMap<string, MonsterDefinition> = new Map(
  [...DEFINITIONS, DUMMY].map((monster) => [monster.id, monster]),
);

export const ALL_MONSTERS: readonly MonsterDefinition[] = DEFINITIONS;

export function monsterById(id: string): MonsterDefinition | null {
  return MONSTERS.get(id) ?? null;
}
