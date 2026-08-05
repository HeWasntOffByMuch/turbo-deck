/**
 * The server's shared vocabulary (spec 056): the shapes that persistence, the
 * sim, the network layer and the admin router all agree on. Types only, no
 * imports, no behaviour -- so every other server module can depend on this one
 * without any risk of a cycle.
 */

/**
 * A point in the world. `x`/`y` are the ground plane, matching the sim's
 * {@link import('../../sim/types.js').Vec2} so the existing collision helpers
 * apply unchanged; `z` is height above the ground, sampled from the heightfield.
 */
export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/**
 * The four stats chosen at character creation. Persisted verbatim and never
 * recomputed -- these are the *inputs* to the stat pipeline, not its output.
 */
export interface BaseStats {
  readonly strength: number;
  readonly dexterity: number;
  readonly intelligence: number;
  readonly vitality: number;
}

export type BaseStatKey = keyof BaseStats;

export const BASE_STAT_KEYS: readonly BaseStatKey[] = [
  'strength',
  'dexterity',
  'intelligence',
  'vitality',
];

export type EquipSlot = 'mainHand' | 'offHand' | 'head' | 'chest' | 'legs' | 'trinket';

export const EQUIP_SLOTS: readonly EquipSlot[] = [
  'mainHand',
  'offHand',
  'head',
  'chest',
  'legs',
  'trinket',
];

export function isEquipSlot(value: string): value is EquipSlot {
  return (EQUIP_SLOTS as readonly string[]).includes(value);
}

/** A point spent in the tree. Only the id and the level are ever stored. */
export interface SkillAllocation {
  readonly skillId: string;
  readonly level: number;
}

export type Equipment = Readonly<Record<EquipSlot, string | null>>;

export const EMPTY_EQUIPMENT: Equipment = {
  mainHand: null,
  offHand: null,
  head: null,
  chest: null,
  legs: null,
  trinket: null,
};

/**
 * Everything about a player that survives a disconnect.
 *
 * Note what is *not* here: no maxHealth, no attack damage, no movement speed,
 * no armor. Those are derived on login and on every equip/skill change by
 * {@link import('../player/stats.js').computeEffectiveStats}, from the tables
 * as they exist *now*. Persisting them would freeze yesterday's balance patch
 * into every save file and hand the client a number worth lying about.
 *
 * `health` is here because it is a live resource, not a derived stat -- but it
 * is clamped to the freshly derived maxHealth on every recalculation.
 *
 * `currentChunk` is likewise absent: it is a pure function of `position`
 * (see `world/chunks.ts`), and a second copy of a fact is a second copy to get
 * wrong.
 */
export interface PersistedPlayer {
  readonly id: string;
  readonly displayName: string;
  readonly baseStats: BaseStats;
  readonly skills: readonly SkillAllocation[];
  readonly equipment: Equipment;
  readonly position: Vec3;
  /** Heading in radians, 0 = +x. */
  readonly facing: number;
  readonly currentZone: string;
  readonly level: number;
  readonly experience: number;
  /** Skill points earned by levelling and not yet spent. */
  readonly unspentSkillPoints: number;
  /** Live resource, clamped to derived maxHealth whenever stats are recomputed. */
  readonly health: number;
  /** Ability resource, clamped the same way. Live, not derived. */
  readonly resource: number;
}

/**
 * Stats as the sim and the client actually use them. Computed, broadcast, and
 * never written to the store.
 */
export interface EffectiveStats {
  readonly maxHealth: number;
  /** World units per second. */
  readonly moveSpeed: number;
  /** Degrees per second. */
  readonly turnRate: number;
  readonly attackDamage: number;
  readonly attackRange: number;
  readonly attackCooldownTicks: number;
  /** Fraction of incoming damage removed, 0..MAX_ARMOR. */
  readonly armor: number;
  /** Multiplier on ability damage. */
  readonly spellPower: number;
  /** Fraction of incoming knockback removed, 0..1. */
  readonly knockbackResist: number;
  /** Chance a hit crits, 0..1. Rolled server-side against the sim's seeded PRNG. */
  readonly critChance: number;
  /** Pool abilities are paid out of (spec 062). */
  readonly maxResource: number;
  /** Refilled by this much every tick. */
  readonly resourceRegen: number;
}

export interface Ban {
  readonly playerId: string;
  /** Epoch ms the ban lifts; Infinity for permanent. */
  readonly until: number;
  readonly reason: string;
  readonly issuedBy: string;
}

export interface Mute {
  readonly playerId: string;
  readonly until: number;
  readonly issuedBy: string;
}

/** One line of the admin accountability log: who, what, when. */
export interface AuditEntry {
  readonly at: number;
  readonly actor: string;
  readonly action: string;
  readonly target: string;
  readonly detail: string;
  readonly accepted: boolean;
}
