/**
 * Whether the shop that is open can still be reached (spec 264).
 *
 * The measurement is against the vendor's **own** radius rather than a number
 * written here, because the whole point of the rule is that the window shuts
 * exactly when the cells would begin being refused -- so a test that named its
 * own distance would be asserting agreement with itself.
 */

import { describe, expect, it } from 'vitest';
import { ALL_VENDORS, vendorById, withinReach, type VendorDefinition } from '../../../server/data/vendors.js';
import { shopInReach } from './shop-range.js';

const QUARTERMASTER = vendorById('vendor.quartermaster') as VendorDefinition;

/** A point `distance` due east of a vendor. */
function eastOf(vendor: VendorDefinition, distance: number): { x: number; y: number } {
  return { x: vendor.x + distance, y: vendor.y };
}

describe('shopInReach', () => {
  it('holds a shop the player is standing in', () => {
    expect(shopInReach(QUARTERMASTER.id, eastOf(QUARTERMASTER, 0))).toBe(true);
  });

  it('lets go once the player walks past the radius', () => {
    expect(shopInReach(QUARTERMASTER.id, eastOf(QUARTERMASTER, QUARTERMASTER.radius + 1))).toBe(false);
  });

  /**
   * The boundary, because a boundary bug is a bug about where you are standing.
   *
   * Exactly at the radius is **in**, which is the answer `withinReach` gives --
   * a hair tighter here would take away a purchase the server would have
   * allowed, which is a worse failure than the one being fixed.
   */
  it('agrees with the server at the exact radius, in every direction', () => {
    for (const vendor of ALL_VENDORS) {
      for (let degrees = 0; degrees < 360; degrees += 15) {
        const radians = (degrees * Math.PI) / 180;
        for (const offset of [-1, 0, 1]) {
          const span = vendor.radius + offset;
          const at = { x: vendor.x + Math.cos(radians) * span, y: vendor.y + Math.sin(radians) * span };
          expect(shopInReach(vendor.id, at), `${vendor.id} at ${span} on ${degrees}deg`).toBe(
            withinReach(vendor, at.x, at.y),
          );
        }
      }
    }
  });

  /** No shop is open, so there is nothing to hold. */
  it('holds nothing for an empty vendor id', () => {
    expect(shopInReach('', eastOf(QUARTERMASTER, 0))).toBe(false);
  });

  /**
   * Both of these are the *safe* direction rather than a shrug. A client a
   * build behind the server's content that shut a shop it could not name would
   * be one that cannot buy from a vendor the server is perfectly happy to
   * serve; and a null position is a client with no prediction yet -- the first
   * frames of a session -- rather than a body a hundred metres away.
   */
  it('holds a vendor this build has never heard of', () => {
    expect(shopInReach('vendor.future', eastOf(QUARTERMASTER, 100_000))).toBe(true);
  });

  it('holds when there is no position yet', () => {
    expect(shopInReach(QUARTERMASTER.id, null)).toBe(true);
  });
});
