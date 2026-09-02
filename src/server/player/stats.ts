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
  PLAYER_ATTACK_RANGE,
  PLAYER_MAX_HEALTH,
  TICK_RATE as SIM_TICK_RATE,
} from '../../sim/constants.js';
import { CHARACTERS } from '../../sim/characters.js';
import {
  attackSpeedFromHaste,
  MAX_ATTACK_INTERVAL_SECONDS,
  MIN_ATTACK_INTERVAL_SECONDS,
} from '../sim/attack-timing.js';
import { SERVER_TICK_RATE } from '../config.js';
import { BASIC_ATTACK_ID } from '../data/abilities.js';
import { itemById } from '../data/items.js';
import { above, SCALING } from '../data/scaling.js';
import {
  attributeScalingBonus,
  damageOf,
  effectiveScaling,
  gradeModifiersFrom,
  scalingOf,
} from '../data/weapon-scaling.js';
import type { StatModifier } from '../data/modifiers.js';
import { armorFromAttributes, deriveTraits } from './derived.js';
import { skillAbilityIdsOf } from './skill-slots.js';
import { heldModifiers, resolveProgression } from './progression.js';
import {
  type BaseStats,
  type EffectiveStats,
  type PersistedPlayer,
  type ScalingAttributes,
} from '../state/types.js';

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
export const HP_PER_LEVEL = 2;
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
/**
 * Resource regained per second before Wisdom, and **the magazine's whole
 * premise** (spec 270).
 *
 * 2/s until this spec, which is what made the Intelligence economy decorative:
 * a four-slot rotation draws about 2.2/s, so every build in the game refilled
 * about as fast as it could spend whatever its pool happened to be. The shaping
 * premium could not be felt, Efficient Construction bought back nothing, and
 * Arcane Overflow -- a capstone that fires on an empty pool -- waited on a state
 * Intelligence's own 2-per-point pool guaranteed never arrived.
 *
 * Dropped to a trickle, with the rate moved onto {@link REGEN_PER_WISDOM}, so
 * the split the design states is the split the numbers make: **Intelligence buys
 * the magazine and Wisdom buys the reload.** A high-Wisdom character regenerates
 * *more* than before this spec; a character who bought none regenerates a fifth
 * of what they did, and eventually has to stop casting.
 *
 * Deliberately not zero. Zero would make a body that had spent its pool
 * permanently unable to cast until it died, which is a wall rather than a
 * pressure -- and would make the flask, not Wisdom, the only answer.
 */
export const RESOURCE_REGEN_PER_SECOND = 0.4;
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
  // Held finite as well as non-negative, for the reason `attributesFrom` holds
  // the attributes: a corrupt save should cost a character their bonuses, not
  // make them unkillable. `Math.max(0, NaN)` is NaN, and a maxHealth of NaN is a
  // body that `Math.max(0, health - damage)` can never reduce.
  const levels = Number.isFinite(player.level) ? Math.max(0, player.level - 1) : 0;

  const flatHealth =
    PLAYER_MAX_HEALTH +
    HP_PER_STRENGTH * strength +
    HP_PER_CONSTITUTION * constitution +
    HP_PER_LEVEL * levels +
    bonus.maxHealth;
  const maxHealth = Math.max(1, flatHealth * (1 + bonus.maxHealthPct));

  const moveSpeed = clamp(
    (BASE_MOVE_SPEED + SCALING.agility.movePer * above(agility) + bonus.moveSpeed) * (1 + bonus.moveSpeedPct),
    MOVE_SPEED_HARD_MIN,
    MOVE_SPEED_HARD_MAX,
  );

  const turnRate = Math.max(30, BASE_TURN_RATE + SCALING.agility.turnPer * agility + bonus.turnRate);

  // The Damage row (spec 216).
  //
  // What replaced two hard-coded attribute terms is one call through the
  // resolver: the weapon says which attributes it scales with as a letter each,
  // the player's equipment and passives shift those letters, and
  // `attributeScalingBonus` turns the resolved grades into a number. Before
  // this, `SCALING.strength.damagePer * strength + agility.damagePer * agility`
  // was added for *every* weapon in the game, so the maul, the bow and the
  // Emberwood Staff all bought their damage from the same stat and nothing a
  // designer could write in `data/items.ts` changed it.
  //
  // Resolved once, here, and handed to the client on `EffectiveStats` -- the
  // tooltip reads the same grades rather than working them out again.
  const mainHand = player.equipment.mainHand;
  const weapon = mainHand ? itemById(mainHand) : null;
  const held = weapon !== null;
  const scalingModifiers = gradeModifiersFrom(bonus);
  const weaponScaling = effectiveScaling(scalingOf(weapon?.scaling, held), scalingModifiers);
  // The three values every grade in the game is resolved against, named once
  // (spec 238). The weapon folds its own term into the range below; an ability
  // cannot, because which grades apply depends on which ability -- so the sim
  // carries these and resolves per blow, through the same `contributionOf`.
  const scalingAttributes: ScalingAttributes = { strength, agility, intelligence };

  // The weapon's own range, with everything that acts on it folded in (spec
  // 217). Both ends take the same additions, so a wide weapon stays wide and a
  // narrow one stays narrow -- an attribute term that multiplied the spread
  // would make every high-Strength maul a lottery.
  const weaponDamage = damageOf(weapon?.damage, held);
  const scalingBonus = attributeScalingBonus(scalingAttributes, weaponScaling);
  const resolve = (end: number): number =>
    Math.max(0, (end + scalingBonus + bonus.attackDamage) * (1 + bonus.attackDamagePct));
  const weaponDamageMin = resolve(weaponDamage.min);
  const weaponDamageMax = resolve(weaponDamage.max);

  // The **midpoint**, which is what the character sheet's Damage row shows and
  // what a stagger's power is sized off. One number, because both of those want
  // one; the range is what a blow actually rolls between.
  const attackDamage = (weaponDamageMin + weaponDamageMax) / 2;

  const attackRange = Math.max(1, PLAYER_ATTACK_RANGE + bonus.attackRange);

  // Base Attack Time, and the three attack-speed inputs beside it (specs 144, 174).
  //
  // Spec 144 built this socket and deliberately left it unplugged; spec 174
  // plugs it in, because four weapon rows had been authoring `attackSpeedPct`
  // into it since spec 070 and every one of them was inert. Spec 091's rule
  // that the cadence is a property of attacking rather than of what is held is
  // reversed **for the weapon half only** -- that is the half a player picks
  // up and can therefore make a decision about.
  //
  // What is NOT reversed is spec 147's structural commitment: every Agility
  // scale is on the attack point and the backswing, and nothing an attribute
  // writes reaches `baseAttackTimeTicks` or any of these three. The fast stat
  // still cannot become the damage stat by shortening the cadence, and
  // `stats.test.ts` still asserts it.
  //
  // The two multipliers are the same summed fraction split by sign rather than
  // one number in one bucket. Arithmetically that is identical today -- the
  // factor is their product and the other is 1 -- and it is written this way so
  // that a slow arriving later as a status lands in the slow bucket beside the
  // slows rather than being cancelled against an item's haste.
  const baseAttackTimeTicks = baseAttackTimeTicksFrom(bonus.attackCooldownTicks);
  const attackSpeed = attackSpeedFromHaste(bonus.attackSpeed);
  const attackSpeedPct = Number.isFinite(bonus.attackSpeedPct) ? bonus.attackSpeedPct : 0;
  const attackSpeedMultiplier = 1 + Math.max(0, attackSpeedPct);
  const attackSpeedSlowMultiplier = 1 + Math.min(0, attackSpeedPct);

  const armor = armorFromAttributes(attributes, bonus.armor);

  // Spell Power (spec 238).
  //
  // **Intelligence is deliberately no longer a term in it.** Before spec 238
  // this was `1 + per * Intelligence + bonus` and it multiplied the damage of
  // every non-basic ability in the game, which is how Whirlwind came to be an
  // Intelligence skill. Intelligence now reaches an ability exactly once, as
  // the attribute its declared `intelligence` grade is resolved against, and
  // leaving the per-point term here as well would make an Intelligence ability
  // quadratic in Intelligence -- the double-count spec 238 exists to prevent.
  //
  // What is left is what items and passives grant, and what it now multiplies
  // is the **Intelligence contribution of an ability's scaling** and nothing
  // else (`abilityContributionOf`). So "Spell Power" means what it says: it
  // amplifies your magic, it cannot reach a Strength ability, and the two
  // rows that author it -- the Emberwood Staff and `int.potency` -- keep
  // meaning what they meant.
  const spellPower = Math.max(0, 1 + bonus.spellPower);

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
    // Measured from `above()` since spec 270 -- the baseline rule `scaling.ts`
    // states for every other scale, and the reason the first cut of this change
    // barely moved: at the raw value a character who had spent *nothing* on
    // Wisdom still collected five points of reload, which was most of what a
    // pure-Intelligence build was living on. Wisdom investment is the reload
    // now, and the starting five buy nothing, so `RESOURCE_REGEN_PER_SECOND` is
    // genuinely what a body with no Wisdom gets.
    (RESOURCE_REGEN_PER_SECOND + REGEN_PER_WISDOM * above(wisdom)) / SERVER_TICK_RATE +
      bonus.resourceRegen,
  );

  return {
    maxHealth,
    moveSpeed,
    turnRate,
    attackDamage,
    attackRange,
    baseAttackTimeTicks,
    attackSpeed,
    attackSpeedMultiplier,
    attackSpeedSlowMultiplier,
    armor,
    spellPower,
    critChance,
    maxResource,
    resourceRegen,
    basicAttackId: basicAttackFor(player),
    skillAbilityIds: skillAbilityIdsOf(player.equipment),
    weaponScaling,
    weaponDamageMin,
    weaponDamageMax,
    scalingModifiers,
    scalingAttributes,
    // Derived last, because two of its fields are fractions of maxHealth and
    // one is a duration in ticks -- it needs the pool it is a fraction of, and
    // the tick rate the sim actually runs at.
    traits: deriveTraits(attributes, bonus, {
      tickRate: SERVER_TICK_RATE,
      maxHealth,
      attackDamage,
    }),
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

/**
 * Fallback flask charges after a recalculation (spec 156).
 *
 * The one place `undefined` is turned into a number, and it becomes a *full*
 * flask: a record written before the field existed cannot tell "drank them all"
 * from "never had any", and the generous reading is the only one that cannot
 * strand an existing character with no way to recover. Clamped like health and
 * the pool, because Constitution owns the ceiling and a respec can lower it.
 */
export function clampCharges(charges: number | undefined, stats: EffectiveStats): number {
  const max = Math.max(0, Math.floor(stats.traits.fallbackCharges));
  if (charges === undefined || !Number.isFinite(charges)) return max;
  return Math.min(max, Math.max(0, Math.floor(charges)));
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
