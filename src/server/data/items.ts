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
  readonly slot: EquipSlot;
  /** Character level required to equip; below it the equip is rejected. */
  readonly levelRequirement: number;
  readonly modifiers: StatModifier;
  /**
   * The auto-attack this weapon swings with (spec 077), or absent for one that
   * changes numbers but not the motion.
   *
   * Only a main hand is ever asked. It is an ability *id* like everything else
   * here, so a bow is a row in this table rather than a class, and re-pointing
   * every bow at a different shot is one edit in `data/abilities.ts`.
   */
  readonly basicAttackId?: string;
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
    // The range is the weapon; the shot it names carries its own (spec 077), so
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
];

export const ITEMS: ReadonlyMap<string, ItemDefinition> = new Map(
  DEFINITIONS.map((item) => [item.id, item]),
);

export const ALL_ITEMS: readonly ItemDefinition[] = DEFINITIONS;

export function itemById(id: string): ItemDefinition | null {
  return ITEMS.get(id) ?? null;
}
