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

import { itemById } from '../../../server/data/items.js';
import { EQUIP_SLOTS, type Equipment, type EquipSlot, type Inventory } from '../../../server/state/types.js';
import type { ContainerView, ItemView } from '../../../ui/screens/inventory.js';

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

/** How a slot is named to a player. Title-casing `mainHand` gives "Mainhand". */
const SLOT_LABELS: Readonly<Record<EquipSlot, string>> = {
  mainHand: 'Main',
  offHand: 'Off',
  head: 'Head',
  chest: 'Chest',
  legs: 'Legs',
  trinket: 'Charm',
};

export const EQUIPMENT_SLOT_VIEW: readonly { readonly id: string; readonly label: string }[] =
  EQUIP_SLOTS.map((slot) => ({ id: slot, label: SLOT_LABELS[slot] }));

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
