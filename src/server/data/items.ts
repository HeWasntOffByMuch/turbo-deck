/**
 * The ITEMS definition table (spec 056).
 *
 * Same contract as SKILLS: a save holds `{ slot: itemId }` and nothing else, so
 * an item's numbers are whatever this table says the next time stats are
 * recalculated. Buffing a sword buffs every sword already in the world.
 */

import type { EquipTarget } from '../state/types.js';
import type { StatModifier } from './modifiers.js';

/**
 * The rarity tiers, in ascending order (spec 158). **Three, and on purpose.**
 *
 * Three is what the presentation ladder in `data/loot.ts` needs -- quiet,
 * delayed, longer -- and a fourth would be a tier with nothing to say. Spec 158
 * explicitly declines to design a full taxonomy: the ladder grows when
 * something needs a rung, and until then every tier differs from its neighbours
 * in how it behaves rather than only in its name.
 *
 * It lives here rather than beside the reveal timings because rarity is a fact
 * about an item, and the timings are a fact about how one is announced. Putting
 * the vocabulary next to the rows that carry it also keeps the two files
 * acyclic: `loot.ts` reads this, and nothing here reads `loot.ts`.
 *
 * The order is the wire order. A tier is appended, never inserted.
 */
export const RARITY_IDS = ['common', 'rare', 'exceptional'] as const;

export type RarityId = (typeof RARITY_IDS)[number];

/** A tier as a byte, for the wire: its index in {@link RARITY_IDS}. */
export function rarityToByte(id: RarityId): number {
  return RARITY_IDS.indexOf(id);
}

/**
 * A byte back to a tier, total by construction.
 *
 * An unknown byte reads as `common` rather than throwing: a client a build
 * behind should draw a quiet drop, not take the frame down over a tier it has
 * never heard of.
 */
export function rarityFromByte(byte: number): RarityId {
  return RARITY_IDS[byte] ?? 'common';
}

export interface ItemDefinition {
  readonly id: string;
  readonly name: string;
  /**
   * Where it goes when worn, or `null` for something that is only ever carried
   * (spec 126). A null slot is what makes "this cannot be equipped" a fact about
   * the row rather than a list of exceptions somewhere else.
   */
  readonly slot: EquipTarget | null;
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
   * The active skill this item *is* (spec 184).
   *
   * The same shape `basicAttackId` above already uses, and for the same stated
   * reason: a bow is a row in this table rather than a class, and so is a skill.
   * It names an ability id, so re-tuning what Guard Break does is one edit in
   * `data/abilities.ts` and nothing here moves.
   *
   * Only ever read for an item in one of the four skill slots. An item that
   * names one and cannot be worn there is inert, which is the same nothing a
   * `basicAttackId` on a helmet already is.
   */
  readonly activeSkillId?: string;
  /**
   * Base worth in coins (spec 129).
   *
   * `0` means it cannot be sold -- and therefore cannot be bought either, since
   * both prices are derived from this one number. Not the same as free.
   */
  readonly value: number;
  /**
   * How many of this fit in one inventory slot (spec 126). Absent means 1.
   *
   * A weapon does not stack and a potion does, and that is the whole of it --
   * `maxStackOf` below is the only thing that reads it, so "absent means one"
   * is stated once rather than at every call site.
   */
  readonly maxStack?: number;
  /**
   * How loudly this announces itself when it drops (spec 158). Absent is
   * `common`, so most of the table says nothing and means it.
   *
   * A property of the *row*, never of a drop: two copies of the same sword are
   * the same tier forever. A per-drop rarity would only mean something if two
   * copies could differ in what they do, which needs affixes, which spec 158
   * deliberately does not build.
   *
   * It changes presentation and nothing else -- no price, no stats, no drop
   * weight. `data/loot.ts` decides how often a row appears and this decides how
   * the appearance is announced, and keeping those two apart is what makes a
   * balance change and a presentation change different diffs.
   */
  readonly rarity?: RarityId;
}

const DEFINITIONS: readonly ItemDefinition[] = [
  // --- weapons ---
  {
    id: 'sword.worn',
    value: 12,
    name: 'Worn Sword',
    slot: 'mainHand',
    levelRequirement: 1,
    modifiers: { attackDamage: 3 },
  },
  {
    id: 'sword.keen',
    rarity: 'rare',
    value: 90,
    name: 'Keen Longsword',
    slot: 'mainHand',
    levelRequirement: 5,
    // Keen: the speed is the point of it (spec 070), so it says so as a
    // percentage rather than by shaving a tick off the base interval.
    modifiers: { attackDamage: 8, attackRange: 6, attackSpeedPct: 0.15 },
  },
  {
    id: 'maul.iron',
    rarity: 'rare',
    value: 110,
    name: 'Iron Maul',
    slot: 'mainHand',
    levelRequirement: 5,
    modifiers: { attackDamage: 14, attackSpeedPct: -0.2, attackRange: 10, strength: 2 },
  },
  {
    id: 'staff.emberwood',
    rarity: 'rare',
    value: 95,
    name: 'Emberwood Staff',
    slot: 'mainHand',
    levelRequirement: 4,
    modifiers: { attackDamage: 2, spellPower: 0.2, intelligence: 3, attackRange: 20 },
  },
  {
    id: 'bow.hunting',
    value: 30,
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
    value: 26,
    name: 'Weighted Stars',
    slot: 'mainHand',
    levelRequirement: 1,
    modifiers: { attackDamage: 2, attackSpeedPct: 0.2, agility: 1 },
    basicAttackId: 'ranged.star',
  },
  // --- off hand ---
  {
    id: 'shield.oak',
    value: 40,
    name: 'Oak Shield',
    slot: 'offHand',
    levelRequirement: 2,
    modifiers: { armor: 0.06, moveSpeed: -6 },
  },
  {
    id: 'focus.quartz',
    rarity: 'rare',
    value: 55,
    name: 'Quartz Focus',
    slot: 'offHand',
    levelRequirement: 3,
    modifiers: { spellPower: 0.12, intelligence: 2 },
  },
  // --- armour ---
  {
    id: 'helm.leather',
    value: 15,
    name: 'Leather Cap',
    slot: 'head',
    levelRequirement: 1,
    modifiers: { maxHealth: 10, armor: 0.01 },
  },
  {
    id: 'helm.plated',
    rarity: 'rare',
    value: 120,
    name: 'Plated Helm',
    slot: 'head',
    levelRequirement: 6,
    modifiers: { maxHealth: 25, armor: 0.04, moveSpeed: -3 },
  },
  {
    id: 'chest.leather',
    value: 22,
    name: 'Leather Jerkin',
    slot: 'chest',
    levelRequirement: 1,
    modifiers: { maxHealth: 18, armor: 0.02 },
  },
  {
    id: 'chest.scale',
    rarity: 'rare',
    value: 160,
    name: 'Scalemail',
    slot: 'chest',
    levelRequirement: 7,
    modifiers: { maxHealth: 45, armor: 0.07, moveSpeed: -8, constitution: 2 },
  },
  {
    id: 'legs.traveller',
    value: 18,
    name: "Traveller's Greaves",
    slot: 'legs',
    levelRequirement: 1,
    modifiers: { maxHealth: 8, moveSpeed: 6 },
  },
  // --- trinkets ---
  {
    id: 'trinket.swiftband',
    rarity: 'rare',
    value: 70,
    name: 'Swiftband',
    slot: 'trinket',
    levelRequirement: 3,
    modifiers: { moveSpeedPct: 0.08, agility: 2 },
  },
  {
    id: 'trinket.bloodstone',
    rarity: 'exceptional',
    value: 210,
    name: 'Bloodstone',
    slot: 'trinket',
    levelRequirement: 8,
    modifiers: { maxHealthPct: 0.12, attackDamagePct: 0.05 },
  },
  // --- active skills (spec 184) ---
  //
  // A skill is an item, so it drops, trades, sits in a bag and is worn -- and
  // every one of those verbs is a system that already existed. What makes these
  // rows different from a sword is one field: `activeSkillId`, which names the
  // row in `data/abilities.ts` that says what the thing actually does. There
  // are no numbers here, deliberately: a sigil's damage is the ability's, and a
  // second copy in this table would be a second place to retune it.
  //
  // `slot: 'skill'` is the family, so one row fits any of the four slots.
  {
    id: 'sigil.guardBreak',
    name: 'Sigil of Guard Break',
    slot: 'skill',
    levelRequirement: 1,
    modifiers: {},
    activeSkillId: 'skill.guardBreak',
    value: 45,
  },
  {
    id: 'sigil.stunningBlow',
    rarity: 'rare',
    name: 'Sigil of the Stunning Blow',
    slot: 'skill',
    levelRequirement: 4,
    modifiers: {},
    activeSkillId: 'skill.stunningBlow',
    value: 130,
  },
  {
    id: 'sigil.whirlwind',
    rarity: 'rare',
    name: 'Sigil of the Whirlwind',
    slot: 'skill',
    levelRequirement: 5,
    modifiers: {},
    activeSkillId: 'skill.whirlwind',
    value: 145,
  },
  {
    id: 'sigil.cripplingStrike',
    name: 'Sigil of the Crippling Strike',
    slot: 'skill',
    levelRequirement: 2,
    modifiers: {},
    activeSkillId: 'skill.cripplingStrike',
    value: 60,
  },
  // --- carried ---
  // Nothing drinks this yet: consuming an item is its own spec, and it is here
  // because stacking has to be a rule about real rows to be worth testing. A
  // table with no stackable item in it makes `maxStack` a hypothesis.
  {
    id: 'potion.minor',
    value: 6,
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

/**
 * An item's tier (spec 158).
 *
 * Read off the row, so a drop cannot have a rarity its item does not. An
 * unknown id is `common`, like everything else about rarity that has to be
 * total -- a body dropping something this build has never heard of should be a
 * quiet drop, not a crash.
 */
export function rarityOf(defId: string): RarityId {
  return ITEMS.get(defId)?.rarity ?? 'common';
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
  // One skill to start (spec 184). Not a nicety: with four empty slots and no
  // sigil in the bag there is no way for a new character to reach the feature
  // at all, and "it works once you have looted one" is how a system ships
  // untested by everybody who has not.
  { defId: 'sigil.guardBreak', count: 1 },
];
