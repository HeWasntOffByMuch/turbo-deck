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
  MOVE_SPEED_HARD_MAX,
  MOVE_SPEED_HARD_MIN,
  PLAYER_ATTACK_DAMAGE,
  PLAYER_ATTACK_RANGE,
  PLAYER_MAX_HEALTH,
  TICK_RATE as SIM_TICK_RATE,
} from '../../sim/constants.js';
import { CHARACTERS } from '../../sim/characters.js';
import {
  MAX_ATTACK_INTERVAL_SECONDS,
  MIN_ATTACK_INTERVAL_SECONDS,
  NO_ATTACK_SPEED,
} from '../sim/attack-timing.js';
import { SERVER_TICK_RATE } from '../config.js';
import { BASIC_ATTACK_ID } from '../data/abilities.js';
import { itemById } from '../data/items.js';
import { SCALING } from '../data/scaling.js';
import type { StatModifier } from '../data/modifiers.js';
import { armorFromAttributes, deriveTraits } from './derived.js';
import { heldModifiers, resolveProgression } from './progression.js';
import { type BaseStats, type EffectiveStats, type PersistedPlayer } from '../state/types.js';

/**
 * The single-player sim's durations are written in 60Hz ticks; this server runs
 * at 20. Converting here rather than re-deriving the numbers keeps one source of
 * truth for how long a swing takes, in seconds, across both sims.
 */
export function simTicksToServerTicks(simTicks: number): number {
  return Math.max(1, Math.round((simTicks * SERVER_TICK_RATE) / SIM_TICK_RATE));
}

/**
 * Health per point of constitution.
 *
 * These four re-export {@link SCALING} rather than restating it (spec 147). They
 * are the names the tests and the balance harness already use, and pointing them
 * at the one tunable table means a balance pass edits `data/scaling.ts` and
 * nothing here goes stale behind it.
 */
export const HP_PER_CONSTITUTION = SCALING.constitution.healthPer;
/** Health per point of strength. Small: Constitution owns the pool. */
export const HP_PER_STRENGTH = SCALING.strength.healthPer;
/** Health granted by each character level beyond the first. */
export const HP_PER_LEVEL = 8;
/** Attack damage per point of strength. */
export const DAMAGE_PER_STRENGTH = SCALING.strength.damagePer;
/**
 * What a body with nothing on it waits between basic attacks (spec 088).
 *
 * Slow on purpose. Spec 065 built this game around a commitment being long
 * enough to be read, and the old cadence -- about a third of a second, against
 * a 0.2s wind-up -- left nothing between one blow and the next to read anything
 * in.
 *
 * Since spec 144 this is Base Attack Time, and the *base* is now load-bearing:
 * attack speed divides it to get the interval, and divides the wind-up and the
 * backswing by the same factor.
 */
export const BASE_ATTACK_TIME_TICKS = Math.round(SERVER_TICK_RATE * 1.2);

/**
 * Bounds on the resolved interval.
 *
 * A floor as well as a ceiling, for the reason the old attacks-per-second
 * bounds existed: attack speed is still a divisor, and a modifier that managed
 * to drive it to zero would not make a unit fast, it would make its interval
 * infinite or negative. The clamp itself lives in `sim/attack-timing.ts`, beside
 * the division; these are the same two numbers in the unit `stats.test.ts` reads
 * them in.
 */
export const MIN_ATTACK_DELAY_TICKS = Math.round(
  SERVER_TICK_RATE * MIN_ATTACK_INTERVAL_SECONDS,
);
export const MAX_ATTACK_DELAY_TICKS = Math.round(
  SERVER_TICK_RATE * MAX_ATTACK_INTERVAL_SECONDS,
);

/**
 * The Base Attack Time a set of modifiers produces (spec 144).
 *
 * `flatTicks` are added to the base -- that is what `attackCooldownTicks` has
 * always meant -- and the result is held inside the interval bounds so a base
 * that is already absurd cannot be rescued or ruined by the factor later.
 *
 * Note what is *not* here any more: the haste divisor. Spec 088 divided at this
 * point and called the result the delay; 144 keeps the division for
 * {@link resolveAttackTiming}, because the same factor also has to reach the
 * wind-up and the backswing, and a base that had already been divided could not
 * tell it what to divide.
 */
export function baseAttackTimeTicksFrom(flatTicks: number): number {
  const base = BASE_ATTACK_TIME_TICKS + (Number.isFinite(flatTicks) ? flatTicks : 0);
  return clamp(Math.round(base), MIN_ATTACK_DELAY_TICKS, MAX_ATTACK_DELAY_TICKS);
}
/**
 * Critical-hit chance per point of **perception**, and its ceiling (spec 147).
 *
 * Moved off Agility deliberately and stated here rather than buried in the
 * table, because it is the one existing coefficient this spec takes away from a
 * stat rather than adding to one. Crit is a payoff for knowing where to hit,
 * which is Perception's whole identity; leaving it on the fast stat is what made
 * Agility the universal damage stat in the four-stat system.
 */
export const CRIT_PER_PERCEPTION = SCALING.perception.critPer;
export const MAX_CRIT_CHANCE = 0.5;
/** The ability resource pool (spec 062): a base, plus intelligence and wisdom. */
export const BASE_RESOURCE = 20;
export const RESOURCE_PER_INTELLIGENCE = SCALING.intelligence.resourcePer;
export const RESOURCE_PER_WISDOM = SCALING.wisdom.resourcePer;
/** Resource regained per second, before modifiers. Wisdom adds to it. */
export const RESOURCE_REGEN_PER_SECOND = 2;
export const REGEN_PER_WISDOM = SCALING.wisdom.regenPer;

const BASE_MOVE_SPEED = CHARACTERS[0]?.moveSpeed ?? 147.5;
const BASE_TURN_RATE = CHARACTERS[0]?.turnRate ?? 180;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Every modifier a character is currently carrying: one entry per skill level
 * held, one per stat-skill level held, one per equipped item.
 *
 * Delegates to `progression.ts`, which is where hop 1 of the dependency graph
 * lives (spec 147). Kept as an export because the balance harness and the tests
 * ask for it by this name.
 */
export function collectModifiers(player: PersistedPlayer): StatModifier[] {
  return heldModifiers(player);
}

/** Attributes plus everything skills, stat skills and items grant on top. */
export function totalBaseStats(player: PersistedPlayer): BaseStats {
  const { attributes } = resolveProgression(player);
  return {
    strength: attributes.strength,
    agility: attributes.agility,
    intelligence: attributes.intelligence,
    constitution: attributes.constitution,
    perception: attributes.perception,
    wisdom: attributes.wisdom,
  };
}

export function computeEffectiveStats(player: PersistedPlayer): EffectiveStats {
  // Hop 1 then hop 2, once (spec 147). `bonus` is everything summed -- held
  // modifiers *and* the grants of whichever milestones and synergies the
  // attributes reached -- and the attributes themselves were settled before any
  // of those grants existed, which is what keeps the graph acyclic.
  const progression = resolveProgression(player);
  const bonus = progression.totals;
  const attributes = progression.attributes;
  const { strength, agility, intelligence, constitution, perception, wisdom } = attributes;
  const levels = Math.max(0, player.level - 1);

  const flatHealth =
    PLAYER_MAX_HEALTH +
    HP_PER_STRENGTH * strength +
    HP_PER_CONSTITUTION * constitution +
    HP_PER_LEVEL * levels +
    bonus.maxHealth;
  const maxHealth = Math.max(1, flatHealth * (1 + bonus.maxHealthPct));

  const moveSpeed = clamp(
    (BASE_MOVE_SPEED + SCALING.agility.movePer * agility + bonus.moveSpeed) * (1 + bonus.moveSpeedPct),
    MOVE_SPEED_HARD_MIN,
    MOVE_SPEED_HARD_MAX,
  );

  const turnRate = Math.max(30, BASE_TURN_RATE + SCALING.agility.turnPer * agility + bonus.turnRate);

  const attackDamage = Math.max(
    0,
    (PLAYER_ATTACK_DAMAGE +
      DAMAGE_PER_STRENGTH * strength +
      SCALING.agility.damagePer * agility +
      bonus.attackDamage) *
      (1 + bonus.attackDamagePct),
  );

  const attackRange = Math.max(1, PLAYER_ATTACK_RANGE + bonus.attackRange);

  // Base Attack Time, and the three attack-speed inputs beside it (spec 144).
  //
  // All four are deliberately unmodified. Spec 091 took the attack cadence off
  // the weapon on purpose -- a bow and a sword put you on the same clock, and
  // picking one up cannot buy a faster one -- and spec 144 builds the HoN model
  // over that decision rather than reversing it. `attackSpeedPct` and the flat
  // `attackCooldownTicks` still exist as modifiers and still mean what they say;
  // nothing reads them here, which is why the two Finesse skills still do not
  // shorten the cadence and `stats.test.ts` still asserts that they do not.
  //
  // What changed is that there is now somewhere for an attack-speed source to
  // plug in when a spec decides there should be one: `attackSpeed` is additive
  // flat in the HoN convention, and the two multipliers stack apart from it.
  // Converting the existing modifiers onto those three is one call to
  // `attackSpeedFromHaste` and a sign test, and it is a content decision rather
  // than a refactor, so it is left undone rather than done quietly.
  const baseAttackTimeTicks = baseAttackTimeTicksFrom(0);

  const armor = armorFromAttributes(attributes, bonus.armor);

  const spellPower = Math.max(
    0,
    1 + SCALING.intelligence.spellPowerPer * intelligence + bonus.spellPower,
  );

  const critChance = clamp(CRIT_PER_PERCEPTION * perception + bonus.critChance, 0, MAX_CRIT_CHANCE);

  const maxResource = Math.max(
    0,
    BASE_RESOURCE +
      RESOURCE_PER_INTELLIGENCE * intelligence +
      RESOURCE_PER_WISDOM * wisdom +
      bonus.maxResource,
  );
  const resourceRegen = Math.max(
    0,
    (RESOURCE_REGEN_PER_SECOND + REGEN_PER_WISDOM * wisdom) / SERVER_TICK_RATE + bonus.resourceRegen,
  );

  return {
    maxHealth,
    moveSpeed,
    turnRate,
    attackDamage,
    attackRange,
    baseAttackTimeTicks,
    ...NO_ATTACK_SPEED,
    armor,
    spellPower,
    critChance,
    maxResource,
    resourceRegen,
    basicAttackId: basicAttackFor(player),
    // Derived last, because two of its fields are fractions of maxHealth and
    // one is a duration in ticks -- it needs the pool it is a fraction of, and
    // the tick rate the sim actually runs at.
    traits: deriveTraits(attributes, bonus, { tickRate: SERVER_TICK_RATE, maxHealth }),
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
 *
 * Watched, and moved once: 0.3 was a third again too slow to read as a *shot*
 * rather than as a thrown pebble, so this is that number a third faster. The
 * reach does not move with it -- {@link projectileLifetimeTicks} divides the
 * lifetime by the same scale, so a row still covers exactly the ground it says
 * and only the time it takes changes.
 */
export const PROJECTILE_SPEED_SCALE = 0.39;

/**
 * World units per second for a shot of this row (spec 088).
 *
 * The shooter is deliberately not asked. Spec 087 scaled this by the weapon's
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
