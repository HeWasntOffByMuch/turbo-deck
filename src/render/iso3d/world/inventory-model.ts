/**
 * What the inventory screen is handed (spec 127).
 *
 * The one file that reads both sides: the replicated containers on one hand, the
 * item table on the other, out to the plain view-model `src/ui/` is allowed to
 * hold. That boundary is not bureaucracy -- lint refuses `src/ui/` the imports
 * needed to build this, because layer 1 has to be portable to an engine that has
 * never heard of `PersistedPlayer`. This is where that costs something, and it
 * costs one pure function.
 *
 * Pure and headlessly tested: it is a mapping, and a mapping is exactly the kind
 * of thing that is checked in Node rather than looked at in a browser.
 */

import { itemById, rarityOf } from '../../../server/data/items.js';
import { rarityRow } from '../../../server/data/loot.js';
import type { StatModifier } from '../../../server/data/modifiers.js';
import { EQUIP_SLOTS, type Equipment, type EquipSlot, type Inventory } from '../../../server/state/types.js';
import type { ContainerView, ItemDetail, ItemView } from '../../../ui/screens/inventory.js';

/**
 * An item id to a sprite name.
 *
 * Here rather than in `data/items.ts` because it is *art direction* and that
 * table is game rules -- and here rather than in `src/ui/` because the screen
 * must not know what a `sword.keen` is. Unknown ids fall through to the box, so a
 * content edit shows up as a wrong picture rather than as a crash.
 */
const ICONS: Readonly<Record<string, string>> = {
  'sword.worn': 'item:sword',
  'sword.keen': 'item:sword',
  'maul.iron': 'item:sword',
  'staff.emberwood': 'item:staff',
  'bow.hunting': 'item:bow',
  'stars.weighted': 'item:star',
  'shield.oak': 'item:shield',
  'focus.quartz': 'item:focus',
  'helm.leather': 'item:helm',
  'helm.plated': 'item:helm',
  'chest.leather': 'item:chest',
  'chest.scale': 'item:chest',
  'legs.traveller': 'item:legs',
  'trinket.swiftband': 'item:trinket',
  'trinket.bloodstone': 'item:trinket',
  'potion.minor': 'item:potion',
};

export const UNKNOWN_ICON = 'item:unknown';

export function iconFor(defId: string): string {
  return ICONS[defId] ?? UNKNOWN_ICON;
}

/**
 * How a slot is named to a player. Title-casing `mainHand` gives "Mainhand".
 *
 * Two names each since spec 185, and the reason is where they are read. The
 * paperdoll's labels sit in a column beside 20px cells and have to be terse; a
 * tooltip has a line to itself and "Main" alone is a riddle. One table, so the
 * two can never come to name different slots.
 */
const SLOT_LABELS: Readonly<Record<EquipSlot, { readonly short: string; readonly long: string }>> = {
  mainHand: { short: 'Main', long: 'Main Hand' },
  offHand: { short: 'Off', long: 'Off Hand' },
  head: { short: 'Head', long: 'Head' },
  chest: { short: 'Chest', long: 'Chest' },
  legs: { short: 'Legs', long: 'Legs' },
  trinket: { short: 'Charm', long: 'Trinket' },
};

/**
 * How a modifier is written out (spec 185).
 *
 * Here rather than in `data/modifiers.ts` for the reason {@link ICONS} gives:
 * this is what a player is told and that file is what the sim computes. Ordered,
 * and read in order, so two items with the same stats list them the same way
 * rather than in whatever order somebody happened to author the object in.
 *
 * `higherIsBetter` is one field and it exists so a stat where *less* is more
 * cannot be coloured as a benefit by accident. Every row but the attack delay
 * is `true` today; the delay is the reason the field is not an assumption.
 *
 * A field with no row here draws no line at all -- an unknown stat is a missing
 * description, not a crash, and not a raw key in front of a player.
 */
interface StatLabel {
  readonly key: keyof Omit<StatModifier, 'traits'>;
  readonly name: string;
  /** Whether the number is a fraction shown as a percentage. */
  readonly percent: boolean;
  readonly higherIsBetter?: boolean;
}

const STAT_LABELS: readonly StatLabel[] = [
  // Attribute grants first: they are the biggest thing an item can say, since
  // spec 147 made an attribute open milestones rather than nudge a coefficient.
  { key: 'strength', name: 'Strength', percent: false },
  { key: 'agility', name: 'Agility', percent: false },
  { key: 'intelligence', name: 'Intelligence', percent: false },
  { key: 'constitution', name: 'Constitution', percent: false },
  { key: 'perception', name: 'Perception', percent: false },
  { key: 'wisdom', name: 'Wisdom', percent: false },
  // ...then what it does to the numbers, offence before defence before movement.
  { key: 'attackDamage', name: 'Damage', percent: false },
  { key: 'attackDamagePct', name: 'Damage', percent: true },
  { key: 'attackRange', name: 'Range', percent: false },
  { key: 'attackSpeed', name: 'Attack Speed', percent: true },
  { key: 'attackSpeedPct', name: 'Attack Speed', percent: true },
  { key: 'attackCooldownTicks', name: 'Attack Delay', percent: false, higherIsBetter: false },
  { key: 'critChance', name: 'Crit Chance', percent: true },
  { key: 'spellPower', name: 'Spell Power', percent: true },
  { key: 'maxHealth', name: 'Health', percent: false },
  { key: 'maxHealthPct', name: 'Health', percent: true },
  { key: 'armor', name: 'Armour', percent: true },
  { key: 'maxResource', name: 'Resource', percent: false },
  { key: 'resourceRegen', name: 'Resource Regen', percent: false },
  { key: 'moveSpeed', name: 'Move Speed', percent: false },
  { key: 'moveSpeedPct', name: 'Move Speed', percent: true },
  { key: 'turnRate', name: 'Turn Rate', percent: false },
];

/** `8` -> `+8`, `-0.2` at percent -> `-20%`. Signed always: a `+` is the point. */
function writeAmount(value: number, percent: boolean): string {
  const scaled = percent ? value * 100 : value;
  // Rounded to a tenth and then trimmed, so `0.15 * 100` reads `15%` rather than
  // `15.000000000000002%` and a genuinely fractional flat stat still says so.
  const rounded = Math.round(scaled * 10) / 10;
  const sign = rounded >= 0 ? '+' : '-';
  return `${sign}${Math.abs(rounded)}${percent ? '%' : ''}`;
}

/**
 * What an item does, one line per modifier it carries.
 *
 * Zero is skipped rather than written as `+0`: a row that sets a field to zero
 * is saying nothing, and a line saying nothing is worse than no line.
 */
function statDetails(modifiers: StatModifier): ItemDetail[] {
  const lines: ItemDetail[] = [];
  for (const label of STAT_LABELS) {
    const value = modifiers[label.key];
    if (typeof value !== 'number' || value === 0) continue;
    const good = value > 0 === (label.higherIsBetter ?? true);
    lines.push({ text: `${writeAmount(value, label.percent)} ${label.name}`, tone: good ? 'good' : 'bad' });
  }
  return lines;
}

export const EQUIPMENT_SLOT_VIEW: readonly { readonly id: string; readonly label: string }[] =
  EQUIP_SLOTS.map((slot) => ({ id: slot, label: SLOT_LABELS[slot].short }));

/**
 * Everything an item says about itself under its name (spec 185).
 *
 * The tier and where it is worn on one line, because they are one sentence --
 * "a rare thing you hold in your main hand" -- and two lines of two words each
 * over a 20px cell is a paragraph. Then the stats, then the worth.
 *
 * The level gate is deliberately *not* here: it is the only thing about an item
 * that depends on who is holding it, and `InventoryScreen` adds it against the
 * character's own level. Baking it in would mean rebuilding every view the
 * moment somebody levelled.
 */
export function detailsFor(defId: string): readonly ItemDetail[] {
  const definition = itemById(defId);
  const rarity = rarityOf(defId);
  const tier = rarityRow(rarity).name;
  const slot = definition?.slot ?? null;
  const lines: ItemDetail[] = [
    { text: slot === null ? tier : `${tier}  ${SLOT_LABELS[slot].long}`, tone: 'rarity' },
  ];
  if (definition) {
    lines.push(...statDetails(definition.modifiers));
    // `0` is "cannot be sold" rather than "free" (spec 129), so it is said in
    // as many words -- an omitted line would read as an item nobody had priced.
    lines.push(
      definition.value > 0
        ? { text: `Worth ${definition.value} coins`, tone: 'dim' }
        : { text: 'Cannot be sold', tone: 'dim' },
    );
  }
  return lines;
}

/**
 * One stack as the screen sees it, or null.
 *
 * An id the table no longer defines still draws: it is in somebody's bag and
 * pretending otherwise would make it un-draggable and therefore un-removable.
 */
export function itemViewOf(defId: string, count: number): ItemView {
  const definition = itemById(defId);
  return {
    defId,
    name: definition?.name ?? defId,
    count,
    slot: definition?.slot ?? null,
    icon: iconFor(defId),
    levelRequirement: definition?.levelRequirement ?? 1,
    // `common` for an id the table no longer defines, exactly as `rarityOf`
    // answers on the server: a stack nobody can name is drawn quietly rather
    // than not at all.
    rarity: rarityOf(defId),
    details: detailsFor(defId),
  };
}

export interface ContainerSource {
  readonly inventory: Inventory;
  readonly equipment: Equipment;
  readonly level: number;
}

/**
 * The whole view, from the client's replicated containers.
 *
 * Takes the three fields rather than a `ClientView`, so a test can build one
 * without standing up a server and so this cannot quietly start depending on the
 * rest of the client's read model.
 */
export function containerViewOf(source: ContainerSource): ContainerView {
  return {
    bag: source.inventory.map((stack) => (stack ? itemViewOf(stack.defId, stack.count) : null)),
    worn: Object.fromEntries(
      EQUIP_SLOTS.map((slot) => {
        const id = source.equipment[slot];
        return [slot, id === null ? null : itemViewOf(id, 1)];
      }),
    ),
    slots: EQUIPMENT_SLOT_VIEW,
    level: source.level,
  };
}
