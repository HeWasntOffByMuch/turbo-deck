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
import { BASIC_ATTACK_ID } from '../data/abilities.js';
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
/**
 * Bounds on attacks per second (spec 070).
 *
 * A floor as well as a ceiling, because `attackSpeed` divides: an item that
 * managed to drive it to zero would not make a unit slow, it would make its
 * swing interval infinite, and a stat that can produce a division by zero is a
 * stat that will.
 */
export const MIN_ATTACK_SPEED = 0.25;
export const MAX_ATTACK_SPEED = 3;
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

  // The base cadence carries only flat modifiers (spec 070). Dexterity used to
  // shorten it directly; it now feeds `attackSpeed` instead, so a point of
  // dexterity and a +10% haste item are added in one place rather than two that
  // silently multiply.
  const baseCooldown = simTicksToServerTicks(PLAYER_ATTACK_COOLDOWN_TICKS);
  const attackCooldownTicks = Math.max(1, Math.round(baseCooldown + bonus.attackCooldownTicks));

  const attackSpeed = clamp(
    (1 + ATTACK_SPEED_PER_AGILITY * dexterity + bonus.attackSpeed) * (1 + bonus.attackSpeedPct),
    MIN_ATTACK_SPEED,
    MAX_ATTACK_SPEED,
  );

  const armor = clamp(ARMOR_PER_AGILITY * dexterity + bonus.armor, 0, MAX_DAMAGE_REDUCTION);

  const spellPower = Math.max(
    0,
    1 + SPELL_DAMAGE_PER_INTELLIGENCE * intelligence + bonus.spellPower,
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
    attackSpeed,
    armor,
    spellPower,
    critChance,
    maxResource,
    resourceRegen,
    basicAttackId: basicAttackFor(player),
  };
}

/**
 * The ability this character's auto-attack uses (spec 079).
 *
 * The main hand decides, because that is what a weapon *is* here: a bow says
 * `ranged.shot` the same way the Keen Longsword says `attackSpeedPct`. A weapon
 * that says nothing, an empty hand, and an item id no longer in the table all
 * fall back to the sword swing, so a character is never left unable to attack by
 * what it happens to be holding.
 */
export function basicAttackFor(player: PersistedPlayer): string {
  const mainHand = player.equipment.mainHand;
  const item = mainHand ? itemById(mainHand) : null;
  return item?.basicAttackId ?? BASIC_ATTACK_ID;
}

/**
 * Ticks between one basic attack and the next, for these stats (spec 070).
 *
 * The one place the swing cadence is worked out, called by the sim when it
 * stamps a basic attack's cooldown and by the client's mirror of the same gate.
 * Floored at a tick, because a cadence faster than the sim runs is not a
 * cadence -- it is a swing every tick with the remainder thrown away.
 */
export function attackIntervalTicks(stats: EffectiveStats): number {
  return Math.max(1, Math.round(stats.attackCooldownTicks / weaponSpeed(stats)));
}

/**
 * The weapon speed multiplier, clamped, for every use of it (spec 081).
 *
 * Both halves of what a weapon's speed means -- how often it swings and how
 * fast what it throws travels -- run through this, so a stat driven to zero or
 * to `NaN` by some future item can never mean one thing to a swing and another
 * to a shot.
 */
function weaponSpeed(stats: EffectiveStats): number {
  return Number.isFinite(stats.attackSpeed)
    ? clamp(stats.attackSpeed, MIN_ATTACK_SPEED, MAX_ATTACK_SPEED)
    : 1;
}

/**
 * Every shot flies at this fraction of the speed its ability row states
 * (spec 081).
 *
 * A deliberate global knob rather than a per-row retune: shots were crossing
 * their whole range in a handful of frames, which makes a travelling attack
 * indistinguishable from a scheduled one. One line to move when the flight has
 * been watched for long enough to know what the number should be.
 */
export const PROJECTILE_SPEED_SCALE = 0.3;

/**
 * World units per second for a shot this body looses (spec 081).
 *
 * `attackSpeed` is *the* weapon speed stat here -- it is what `attackSpeedPct`
 * on the Keen Longsword and the Weighted Stars feeds -- so a weapon that swings
 * fast throws fast, and the Iron Maul's penalty reads as heft in both halves of
 * what it does. The ability row is the shot's own character; the stat is the
 * arm behind it.
 */
export function projectileSpeedFor(baseSpeed: number, stats: EffectiveStats): number {
  const base = Number.isFinite(baseSpeed) && baseSpeed > 0 ? baseSpeed : 0;
  return base * weaponSpeed(stats) * PROJECTILE_SPEED_SCALE;
}

/**
 * Ticks before that shot expires, so its *reach* is what the table says.
 *
 * `lifetimeTicks` is read as the distance it describes at the row's own speed,
 * not as a duration. Scaling the speed and leaving the ticks alone would have
 * expired `bolt.arcane` at 372 units of its 700-unit range and `bolt.lob` at
 * 360 of 520 -- two abilities that can no longer reach what `startCast` will
 * happily let you aim at. That is not a speed change, it is a silent range
 * nerf. So the only thing a shooter moves is how long the flight takes.
 */
export function projectileLifetimeTicks(
  spec: { readonly speed: number; readonly lifetimeTicks: number },
  stats: EffectiveStats,
): number {
  const speed = projectileSpeedFor(spec.speed, stats);
  if (speed <= 0 || !Number.isFinite(spec.lifetimeTicks)) {
    return Math.max(1, Math.round(spec.lifetimeTicks) || 1);
  }
  return Math.max(1, Math.round((spec.lifetimeTicks * spec.speed) / speed));
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
