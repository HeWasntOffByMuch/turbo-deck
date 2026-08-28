/**
 * Spec 245. Every shop can be opened by somebody.
 *
 * Spec 237's rule, one table over: *"every ability in that table is reachable by
 * somebody"*, and it found nine rows that were not. This is the same question
 * about `VENDORS`, and it is worth asking because the answer was **no** for two
 * of the three rows the moment `KeyV` was deleted -- `nearestVendorTo` was the
 * only thing that ever named `vendor.quartermaster` and `vendor.armourer`, and
 * the key press was its only caller.
 *
 * What made that dangerous rather than merely untidy is that a shop is the only
 * way to buy anything: `staff.emberwood`, `helm.plated`, `chest.scale` and
 * `shield.oak` appear in no loot table, so an orphaned row is four items quietly
 * leaving the game with every test green. Hence the second assertion, which is
 * the one with teeth.
 */

import { describe, expect, it } from 'vitest';

import { DROP_TABLES } from './loot.js';
import { ALL_NPCS } from './npcs.js';
import { ALL_VENDORS, vendorById } from './vendors.js';

/** Which vendor, if any, each NPC opens. */
const named = new Set(ALL_NPCS.map((npc) => npc.vendorId).filter((id): id is string => id !== null));

describe('the shops', () => {
  it('are each opened by an NPC', () => {
    // The direction that catches a row nobody can reach. There is exactly one
    // way to open a shop -- a reply naming a vendor id -- so being named by an
    // NPC *is* being reachable, and a row that is not named is dead content.
    for (const vendor of ALL_VENDORS) {
      expect(named.has(vendor.id), `${vendor.id} is opened by nobody`).toBe(true);
    }
  });

  it('are each opened by exactly one NPC', () => {
    // The other direction, and it is about the player rather than the code: two
    // merchants offering one stock at one markup are two doors into the same
    // room, which is not a second shop and reads as a bug.
    for (const vendor of ALL_VENDORS) {
      const owners = ALL_NPCS.filter((npc) => npc.vendorId === vendor.id);
      expect(owners.map((npc) => npc.id), vendor.id).toHaveLength(1);
    }
  });

  it('names a vendor that exists, for every NPC that has one', () => {
    for (const npc of ALL_NPCS) {
      if (npc.vendorId === null) continue;
      expect(vendorById(npc.vendorId), `${npc.id} names ${npc.vendorId}`).not.toBeNull();
    }
  });

  it('is the only way to get the items that never drop', () => {
    // The assertion with teeth, and the reason the first one is not merely
    // tidiness. An item in no loot table and no shop is an item that exists in
    // `data/items.ts` and cannot be obtained -- so this pins the four that are
    // in that position today, by checking they are still *sold*.
    const dropped = new Set<string>();
    for (const table of DROP_TABLES.values()) {
      for (const entry of table.entries) dropped.add(entry.defId);
    }
    // Off the shops somebody can actually *open*, not off every row in the
    // table -- which is the whole failure. Deleting `KeyV` left both older
    // vendors sitting there with full stock lists and no door, and a check
    // against `ALL_VENDORS` would have called that fine.
    const sold = new Set(
      ALL_VENDORS.filter((vendor) => named.has(vendor.id)).flatMap((vendor) => [...vendor.stock]),
    );

    for (const defId of ['staff.emberwood', 'helm.plated', 'chest.scale', 'shield.oak']) {
      expect(dropped.has(defId), `${defId} is expected to be shop-only`).toBe(false);
      expect(sold.has(defId), `${defId} drops from nothing and is sold by nobody`).toBe(true);
    }
  });
});
