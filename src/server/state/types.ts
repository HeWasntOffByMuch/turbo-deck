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
 * One occupied inventory slot (spec 126): a definition id and how many.
 *
 * No instance id and no shape. An item *is* its definition plus a count, which
 * keeps `data/items.ts`'s rule intact -- buffing a sword buffs every sword --
 * and keeps a slot addressable by index, which is all a uniform grid needs.
 * Durability, sockets and multi-cell footprints all land as fields here or on
 * the definition when they arrive.
 */
export interface ItemStack {
  readonly defId: string;
  /** >= 1, and <= the definition's `maxStack`. */
  readonly count: number;
}

/** Fixed-length. A null slot is an empty one; the array never shortens. */
export type Inventory = readonly (ItemStack | null)[];

export const INVENTORY_SLOTS = 24;

/** A bag of the right length with nothing in it. A new array every call. */
export function emptyInventory(): Inventory {
  return new Array<ItemStack | null>(INVENTORY_SLOTS).fill(null);
}

export type ContainerId = 'inventory' | 'equipment';

/**
 * One addressable slot, in either container (spec 126).
 *
 * Here in the shared vocabulary rather than beside the rules that use it,
 * because the wire format needs to name a slot too and `net/` is not allowed to
 * depend on anything but this file. `player/inventory.ts` re-exports it, so the
 * rules and the codec cannot disagree about what an address is.
 */
export interface SlotAddress {
  readonly container: ContainerId;
  /** An index into the inventory, or the ordinal of an {@link EquipSlot}. */
  readonly index: number;
}

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
  /**
   * What the player is carrying (spec 126). Exactly {@link INVENTORY_SLOTS}
   * entries once loaded; a save written before this field existed comes back
   * with an empty bag and keeps whatever it had equipped.
   */
  readonly inventory: Inventory;
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
  /**
   * Ticks that must pass after a basic attack before the next may begin
   * (spec 088).
   *
   * The whole answer, and the only one: nothing divides it and nothing else is
   * consulted. It replaced a base cadence, a multiplier over that base, and a
   * helper that divided one by the other at every call site -- three names for
   * one number, which is why asking "when can this body swing again" used to
   * have no field to read.
   *
   * Modifiers are resolved on the way in, in `computeEffectiveStats`: a weapon
   * that says `attackSpeedPct` still means *percent faster*, and shortens this.
   */
  readonly attackDelayTicks: number;
  /** Fraction of incoming damage removed, 0..MAX_ARMOR. */
  readonly armor: number;
  /** Multiplier on ability damage. */
  readonly spellPower: number;
  /** Chance a hit crits, 0..1. Rolled server-side against the sim's seeded PRNG. */
  readonly critChance: number;
  /** Pool abilities are paid out of (spec 062). */
  readonly maxResource: number;
  /** Refilled by this much every tick. */
  readonly resourceRegen: number;
  /**
   * The ability this body's auto-attack uses (spec 079), or `''` for something
   * that never attacks.
   *
   * A stat rather than a constant because it is the difference between a
   * swordsman and an archer, and it is derived exactly like every other stat
   * here: from the main hand for a player, from its row for a monster. The sim
   * never needs it -- a cast names its own ability -- but a client does, to know
   * what its right-click reaches with and asks for.
   */
  readonly basicAttackId: string;
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
