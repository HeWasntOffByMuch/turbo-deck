/**
 * The ITEMS definition table (spec 056).
 *
 * Same contract as SKILLS: a save holds `{ slot: itemId }` and nothing else, so
 * an item's numbers are whatever this table says the next time stats are
 * recalculated. Buffing a sword buffs every sword already in the world.
 */

import type { EquipSlot } from '../state/types.js';
import type { StatModifier } from './modifiers.js';

export interface ItemDefinition {
  readonly id: string;
  readonly name: string;
  /**
   * Where it goes when worn, or `null` for something that is only ever carried
   * (spec 126). A null slot is what makes "this cannot be equipped" a fact about
   * the row rather than a list of exceptions somewhere else.
   */
  readonly slot: EquipSlot | null;
  /** Character level required to equip; below it the equip is rejected. */
  readonly levelRequirement: number;
  readonly modifiers: StatModifier;
  /**
   * The auto-attack this weapon swings with (spec 079), or absent for one that
   * changes numbers but not the motion.
   *
   * Only a main hand is ever asked. It is an ability *id* like everything else
   * here, so a bow is a row in this table rather than a class, and re-pointing
   * every bow at a different shot is one edit in `data/abilities.ts`.
   */
  readonly basicAttackId?: string;
  /**
   * How many of this fit in one inventory slot (spec 126). Absent means 1.
   *
   * A weapon does not stack and a potion does, and that is the whole of it --
   * `maxStackOf` below is the only thing that reads it, so "absent means one"
   * is stated once rather than at every call site.
   */
  readonly maxStack?: number;
}

const DEFINITIONS: readonly ItemDefinition[] = [
  // --- weapons ---
  {
    id: 'sword.worn',
    name: 'Worn Sword',
    slot: 'mainHand',
    levelRequirement: 1,
    modifiers: { attackDamage: 3 },
  },
  {
    id: 'sword.keen',
    name: 'Keen Longsword',
    slot: 'mainHand',
    levelRequirement: 5,
    // Keen: the speed is the point of it (spec 070), so it says so as a
    // percentage rather than by shaving a tick off the base interval.
    modifiers: { attackDamage: 8, attackRange: 6, attackSpeedPct: 0.15 },
  },
  {
    id: 'maul.iron',
    name: 'Iron Maul',
    slot: 'mainHand',
    levelRequirement: 5,
    modifiers: { attackDamage: 14, attackSpeedPct: -0.2, attackRange: 10, strength: 2 },
  },
  {
    id: 'staff.emberwood',
    name: 'Emberwood Staff',
    slot: 'mainHand',
    levelRequirement: 4,
    modifiers: { attackDamage: 2, spellPower: 0.2, intelligence: 3, attackRange: 20 },
  },
  {
    id: 'bow.hunting',
    name: 'Hunting Bow',
    slot: 'mainHand',
    // Level 1 like the worn sword: these are the starting alternatives, and a
    // switch that refuses two of its three buttons is not a switch.
    levelRequirement: 1,
    // The range is the weapon; the shot it names carries its own (spec 079), so
    // `attackRange` here only nudges what a melee swing would have reached.
    modifiers: { attackDamage: 5, attackSpeedPct: -0.1 },
    basicAttackId: 'ranged.shot',
  },
  {
    id: 'stars.weighted',
    name: 'Weighted Stars',
    slot: 'mainHand',
    levelRequirement: 1,
    modifiers: { attackDamage: 2, attackSpeedPct: 0.2, dexterity: 1 },
    basicAttackId: 'ranged.star',
  },
  // --- off hand ---
  {
    id: 'shield.oak',
    name: 'Oak Shield',
    slot: 'offHand',
    levelRequirement: 2,
    modifiers: { armor: 0.06, moveSpeed: -6 },
  },
  {
    id: 'focus.quartz',
    name: 'Quartz Focus',
    slot: 'offHand',
    levelRequirement: 3,
    modifiers: { spellPower: 0.12, intelligence: 2 },
  },
  // --- armour ---
  {
    id: 'helm.leather',
    name: 'Leather Cap',
    slot: 'head',
    levelRequirement: 1,
    modifiers: { maxHealth: 10, armor: 0.01 },
  },
  {
    id: 'helm.plated',
    name: 'Plated Helm',
    slot: 'head',
    levelRequirement: 6,
    modifiers: { maxHealth: 25, armor: 0.04, moveSpeed: -3 },
  },
  {
    id: 'chest.leather',
    name: 'Leather Jerkin',
    slot: 'chest',
    levelRequirement: 1,
    modifiers: { maxHealth: 18, armor: 0.02 },
  },
  {
    id: 'chest.scale',
    name: 'Scalemail',
    slot: 'chest',
    levelRequirement: 7,
    modifiers: { maxHealth: 45, armor: 0.07, moveSpeed: -8, vitality: 2 },
  },
  {
    id: 'legs.traveller',
    name: "Traveller's Greaves",
    slot: 'legs',
    levelRequirement: 1,
    modifiers: { maxHealth: 8, moveSpeed: 6 },
  },
  // --- trinkets ---
  {
    id: 'trinket.swiftband',
    name: 'Swiftband',
    slot: 'trinket',
    levelRequirement: 3,
    modifiers: { moveSpeedPct: 0.08, dexterity: 2 },
  },
  {
    id: 'trinket.bloodstone',
    name: 'Bloodstone',
    slot: 'trinket',
    levelRequirement: 8,
    modifiers: { maxHealthPct: 0.12, attackDamagePct: 0.05 },
  },
  // --- carried ---
  // Nothing drinks this yet: consuming an item is its own spec, and it is here
  // because stacking has to be a rule about real rows to be worth testing. A
  // table with no stackable item in it makes `maxStack` a hypothesis.
  {
    id: 'potion.minor',
    name: 'Minor Salve',
    slot: null,
    levelRequirement: 1,
    modifiers: {},
    maxStack: 10,
  },
];

export const ITEMS: ReadonlyMap<string, ItemDefinition> = new Map(
  DEFINITIONS.map((item) => [item.id, item]),
);

export const ALL_ITEMS: readonly ItemDefinition[] = DEFINITIONS;

export function itemById(id: string): ItemDefinition | null {
  return ITEMS.get(id) ?? null;
}

/** How many of `id` fit in one slot. Unknown ids answer 1, never 0 (spec 126). */
export function maxStackOf(id: string): number {
  return Math.max(1, Math.floor(ITEMS.get(id)?.maxStack ?? 1));
}

/**
 * What a brand new character is given (spec 126).
 *
 * Once ownership is enforced, a new character with an empty bag can equip
 * nothing at all -- so this table is not a nicety, it is the thing that keeps
 * the change from being a regression for everyone who has not looted anything.
 *
 * Every main hand the HUD's weapon switch offers is in here, because the switch
 * equips by id and a button the server refuses is a button that does nothing.
 * `weapon-switch.test.ts` asserts exactly that, so adding a fourth weapon to the
 * switch fails the suite rather than failing quietly in a player's hands.
 */
export const STARTING_KIT: readonly { readonly defId: string; readonly count: number }[] = [
  { defId: 'sword.worn', count: 1 },
  { defId: 'bow.hunting', count: 1 },
  { defId: 'stars.weighted', count: 1 },
  { defId: 'chest.leather', count: 1 },
  { defId: 'helm.leather', count: 1 },
  { defId: 'legs.traveller', count: 1 },
  { defId: 'potion.minor', count: 3 },
];
