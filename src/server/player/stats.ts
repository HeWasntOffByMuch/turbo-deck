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
  HP_PER_STRENGTH,
  MAX_DAMAGE_REDUCTION,
  MOVE_SPEED_HARD_MAX,
  MOVE_SPEED_HARD_MIN,
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
 * What a body with nothing on it waits between basic attacks (spec 088).
 *
 * Slow on purpose. Spec 065 built this game around a commitment being long
 * enough to be read, and the old cadence -- about a third of a second, against
 * a 0.2s wind-up -- left nothing between one blow and the next to read anything
 * in.
 */
export const BASE_ATTACK_DELAY_TICKS = Math.round(SERVER_TICK_RATE * 1.2);

/**
 * Bounds on that delay.
 *
 * A floor as well as a ceiling, for the reason the old attacks-per-second
 * bounds existed: haste is still a divisor, and a modifier that managed to
 * drive it to zero would not make a unit fast, it would make its delay
 * infinite or negative.
 */
export const MIN_ATTACK_DELAY_TICKS = Math.round(SERVER_TICK_RATE * 0.2);
export const MAX_ATTACK_DELAY_TICKS = Math.round(SERVER_TICK_RATE * 5);

/**
 * The delay a set of modifiers produces (spec 088) -- the one place it is
 * worked out, and the whole of what `attackDelayTicks` means.
 *
 * `flatTicks` are added to the base; `haste` divides it, because a modifier
 * that says *percent faster* is talking about a rate and this is a duration.
 * Exported so the bounds can be tested against numbers no item in the table is
 * broken enough to produce -- the point of a clamp is the item added tomorrow.
 */
export function attackDelayTicksFrom(flatTicks: number, haste: number): number {
  const base = BASE_ATTACK_DELAY_TICKS + (Number.isFinite(flatTicks) ? flatTicks : 0);
  // A stat that says nothing is a stat that changes nothing.
  const scale = Number.isNaN(haste) ? 1 : haste;
  // Zero or negative haste is not "instantly", it is "never", so it lands on
  // the ceiling rather than dividing into a negative or an infinite delay.
  if (scale <= 0) return MAX_ATTACK_DELAY_TICKS;
  return clamp(Math.round(base / scale), MIN_ATTACK_DELAY_TICKS, MAX_ATTACK_DELAY_TICKS);
}
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

  // How soon the next blow may begin, resolved here and nowhere else (spec 088).
  // Flat modifiers add ticks; the proportional ones are still *percent faster*,
  // so they divide. Dexterity is deliberately absent: it is a base stat rather
  // than a modifier, and its old haste link was the last of the indirection this
  // replaced -- a weapon that wants to be quick says `attackSpeedPct`, as the
  // Keen Longsword already does.
  const attackDelayTicks = attackDelayTicksFrom(
    bonus.attackCooldownTicks,
    (1 + bonus.attackSpeed) * (1 + bonus.attackSpeedPct),
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
    attackDelayTicks,
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
 * Every shot flies at this fraction of the speed its ability row states
 * (spec 087).
 *
 * A deliberate global knob rather than a per-row retune: shots were crossing
 * their whole range in a handful of frames, which makes a travelling attack
 * indistinguishable from a scheduled one. One line to move when the flight has
 * been watched for long enough to know what the number should be.
 */
export const PROJECTILE_SPEED_SCALE = 0.3;

/**
 * World units per second for a shot of this row (spec 088).
 *
 * The shooter is deliberately not asked. Spec 081 scaled this by the weapon's
 * speed stat, which read correctly while that stat was a multiplier and stopped
 * reading at all once it became a delay -- a *longer* wait between shots would
 * have meant a *faster* one. How soon the next arrow may be loosed and how fast
 * the last one flies are two questions, and only the first is the weapon's.
 */
export function projectileSpeedFor(baseSpeed: number): number {
  const base = Number.isFinite(baseSpeed) && baseSpeed > 0 ? baseSpeed : 0;
  return base * PROJECTILE_SPEED_SCALE;
}

/**
 * Ticks before that shot expires, so its *reach* is what the table says.
 *
 * `lifetimeTicks` is read as the distance it describes at the row's own speed,
 * not as a duration. Scaling the speed and leaving the ticks alone would have
 * expired `bolt.arcane` at 372 units of its 700-unit range and `bolt.lob` at
 * 360 of 520 -- two abilities that can no longer reach what `startCast` will
 * happily let you aim at. That is not a speed change, it is a silent range
 * nerf. So the only thing the scale moves is how long the flight takes.
 */
export function projectileLifetimeTicks(spec: {
  readonly speed: number;
  readonly lifetimeTicks: number;
}): number {
  const speed = projectileSpeedFor(spec.speed);
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
