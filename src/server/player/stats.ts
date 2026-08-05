/**
 * Effective-stat derivation (spec 056).
 *
 * The whole point of this module is that its output is never stored. A save
 * holds base stats, skill ids with levels, and item ids in slots; everything a
 * client or the sim actually uses is computed from those against the tables as
 * they exist right now. That means: no stat a client sends is ever believed, no
 * balance patch needs a migration, and there is exactly one place a number can
 * come from.
 *
 * Pure: same player record in, same stats out, no clock and no randomness.
 */

import {
  ARMOR_PER_AGILITY,
  ATTACK_SPEED_PER_AGILITY,
  HP_PER_STRENGTH,
  MAX_DAMAGE_REDUCTION,
  MOVE_SPEED_HARD_MAX,
  MOVE_SPEED_HARD_MIN,
  PLAYER_ATTACK_COOLDOWN_TICKS,
  PLAYER_ATTACK_DAMAGE,
  PLAYER_ATTACK_RANGE,
  PLAYER_MAX_HEALTH,
  SPELL_DAMAGE_PER_INTELLIGENCE,
  TICK_RATE as SIM_TICK_RATE,
  TURN_RATE_PER_AGILITY,
} from '../../sim/constants.js';
import { CHARACTERS } from '../../sim/characters.js';
import { SERVER_TICK_RATE } from '../config.js';
import { itemById } from '../data/items.js';
import { scaleModifier, sumModifiers, type StatModifier } from '../data/modifiers.js';
import { skillById } from '../data/skills.js';
import { EQUIP_SLOTS, type BaseStats, type EffectiveStats, type PersistedPlayer } from '../state/types.js';

/**
 * The single-player sim's durations are written in 60Hz ticks; this server runs
 * at 20. Converting here rather than re-deriving the numbers keeps one source of
 * truth for how long a swing takes, in seconds, across both sims.
 */
export function simTicksToServerTicks(simTicks: number): number {
  return Math.max(1, Math.round((simTicks * SERVER_TICK_RATE) / SIM_TICK_RATE));
}

/** Health per point of vitality -- the server's own stat, with no sim analogue. */
export const HP_PER_VITALITY = 14;
/** Health granted by each character level beyond the first. */
export const HP_PER_LEVEL = 8;
/** Attack damage per point of strength. */
export const DAMAGE_PER_STRENGTH = 0.6;
/** Knockback resistance per point of vitality. */
export const KNOCKBACK_RESIST_PER_VITALITY = 0.01;
/** Ceiling on knockback resistance, so nothing is ever completely immovable. */
export const MAX_KNOCKBACK_RESIST = 0.9;
/** Ceiling on the attack-speed bonus from dexterity, so cooldowns stay meaningful. */
export const MAX_ATTACK_SPEED_BONUS = 0.6;
/** Critical-hit chance per point of dexterity, and its ceiling. */
export const CRIT_PER_DEXTERITY = 0.008;
export const MAX_CRIT_CHANCE = 0.5;
/** The ability resource pool (spec 062): a base, plus intelligence. */
export const BASE_RESOURCE = 20;
export const RESOURCE_PER_INTELLIGENCE = 2;
/** Resource regained per second, before modifiers. */
export const RESOURCE_REGEN_PER_SECOND = 2;

const BASE_MOVE_SPEED = CHARACTERS[0]?.moveSpeed ?? 147.5;
const BASE_TURN_RATE = CHARACTERS[0]?.turnRate ?? 180;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Every modifier a character is currently carrying: one entry per skill level
 * held, one per equipped item. Unknown ids are skipped rather than throwing --
 * an item removed from the table should orphan the slot, not brick the login.
 */
export function collectModifiers(player: PersistedPlayer): StatModifier[] {
  const modifiers: StatModifier[] = [];
  for (const allocation of player.skills) {
    const definition = skillById(allocation.skillId);
    if (!definition) continue;
    const level = clamp(Math.floor(allocation.level), 0, definition.maxLevel);
    if (level <= 0) continue;
    modifiers.push(scaleModifier(definition.perLevel, level));
  }
  for (const slot of EQUIP_SLOTS) {
    const itemId = player.equipment[slot];
    if (!itemId) continue;
    const definition = itemById(itemId);
    if (!definition) continue;
    modifiers.push(definition.modifiers);
  }
  return modifiers;
}

/** Base stats plus everything skills and items grant on top of them. */
export function totalBaseStats(player: PersistedPlayer): BaseStats {
  const bonus = sumModifiers(collectModifiers(player));
  return {
    strength: player.baseStats.strength + bonus.strength,
    dexterity: player.baseStats.dexterity + bonus.dexterity,
    intelligence: player.baseStats.intelligence + bonus.intelligence,
    vitality: player.baseStats.vitality + bonus.vitality,
  };
}

export function computeEffectiveStats(player: PersistedPlayer): EffectiveStats {
  const bonus = sumModifiers(collectModifiers(player));
  const strength = player.baseStats.strength + bonus.strength;
  const dexterity = player.baseStats.dexterity + bonus.dexterity;
  const intelligence = player.baseStats.intelligence + bonus.intelligence;
  const vitality = player.baseStats.vitality + bonus.vitality;
  const levels = Math.max(0, player.level - 1);

  const flatHealth =
    PLAYER_MAX_HEALTH +
    HP_PER_STRENGTH * strength +
    HP_PER_VITALITY * vitality +
    HP_PER_LEVEL * levels +
    bonus.maxHealth;
  const maxHealth = Math.max(1, flatHealth * (1 + bonus.maxHealthPct));

  const moveSpeed = clamp(
    (BASE_MOVE_SPEED + bonus.moveSpeed) * (1 + bonus.moveSpeedPct),
    MOVE_SPEED_HARD_MIN,
    MOVE_SPEED_HARD_MAX,
  );

  const turnRate = Math.max(30, BASE_TURN_RATE + TURN_RATE_PER_AGILITY * dexterity + bonus.turnRate);

  const attackDamage = Math.max(
    0,
    (PLAYER_ATTACK_DAMAGE + DAMAGE_PER_STRENGTH * strength + bonus.attackDamage) *
      (1 + bonus.attackDamagePct),
  );

  const attackRange = Math.max(1, PLAYER_ATTACK_RANGE + bonus.attackRange);

  const baseCooldown = simTicksToServerTicks(PLAYER_ATTACK_COOLDOWN_TICKS);
  const speedBonus = clamp(ATTACK_SPEED_PER_AGILITY * dexterity, 0, MAX_ATTACK_SPEED_BONUS);
  const attackCooldownTicks = Math.max(
    1,
    Math.round(baseCooldown * (1 - speedBonus) + bonus.attackCooldownTicks),
  );

  const armor = clamp(ARMOR_PER_AGILITY * dexterity + bonus.armor, 0, MAX_DAMAGE_REDUCTION);

  const spellPower = Math.max(
    0,
    1 + SPELL_DAMAGE_PER_INTELLIGENCE * intelligence + bonus.spellPower,
  );

  const knockbackResist = clamp(
    KNOCKBACK_RESIST_PER_VITALITY * vitality + bonus.knockbackResist,
    0,
    MAX_KNOCKBACK_RESIST,
  );

  const critChance = clamp(CRIT_PER_DEXTERITY * dexterity + bonus.critChance, 0, MAX_CRIT_CHANCE);

  const maxResource = Math.max(
    0,
    BASE_RESOURCE + RESOURCE_PER_INTELLIGENCE * intelligence + bonus.maxResource,
  );
  const resourceRegen = Math.max(
    0,
    RESOURCE_REGEN_PER_SECOND / SERVER_TICK_RATE + bonus.resourceRegen,
  );

  return {
    maxHealth,
    moveSpeed,
    turnRate,
    attackDamage,
    attackRange,
    attackCooldownTicks,
    armor,
    spellPower,
    knockbackResist,
    critChance,
    maxResource,
    resourceRegen,
  };
}

/** Ability resource after a recalculation, held under the fresh ceiling. */
export function clampResourceToStats(resource: number, stats: EffectiveStats): number {
  if (!Number.isFinite(resource) || resource <= 0) return 0;
  return Math.min(resource, stats.maxResource);
}

/**
 * Current health after a recalculation. Health is a live resource rather than a
 * derived stat, so it persists -- but unequipping a +health item must not leave
 * a character above their own ceiling, and a fresh maxHealth must not silently
 * heal them either.
 */
export function clampHealthToStats(health: number, stats: EffectiveStats): number {
  if (!Number.isFinite(health) || health <= 0) return 0;
  return Math.min(health, stats.maxHealth);
}

/** Damage after armour, floored at zero. The one place mitigation is applied. */
export function applyArmor(damage: number, stats: EffectiveStats): number {
  return Math.max(0, damage * (1 - stats.armor));
}
