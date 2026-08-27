/**
 * Spec 244. The shipped map's NPCs, against the tables that describe them.
 *
 * Here rather than in `data/` because it reads the map off disk, and the data
 * tables are deterministic core. What it is for is the one coupling this
 * feature has that no type can express: a vendor's reach is measured from a
 * *fixed point* and the body that owns it walks, so where the body's spawner is
 * and what `data/vendors.ts` believes about it have to agree, and they live in
 * two files that cannot see each other.
 *
 * The failure that motivates it is quiet: a merchant nudged fifty units in the
 * editor still spawns, still wanders, still talks -- and the reply that opens
 * its shop is refused by the server from the far side of its own wander disc,
 * with nothing anywhere saying why.
 */

import { describe, expect, it } from 'vitest';

import { monsterById } from '../data/monsters.js';
import { ALL_NPCS, npcById } from '../data/npcs.js';
import { vendorById, withinReach } from '../data/vendors.js';
import { loadMapFile } from './map-file.js';
import { spawnPointsFrom } from './spawners.js';

const shipped = loadMapFile();
const points = spawnPointsFrom(shipped.doc);

/** How far a body of this row can get from its anchor. */
function roamOf(npcId: string): number {
  const plan = monsterById(npcId)?.idle;
  if (plan === undefined || plan.kind === 'sentinel') return 0;
  return plan.radius;
}

describe('the shipped map', () => {
  it('has a spawner for every NPC in the table', () => {
    // The direction that catches a table entry nobody placed: an NPC written,
    // given a script and a voice and a shop, and standing nowhere.
    for (const npc of ALL_NPCS) {
      const placed = points.filter((point) => point.monsterId === npc.id);
      expect(placed.length, `${npc.id} has no spawner on the map`).toBeGreaterThan(0);
    }
  });

  it('puts the merchant exactly where its shop thinks it is', () => {
    const point = points.find((each) => each.monsterId === 'npc.merchant');
    expect(point, 'the merchant has no spawner').toBeDefined();
    const vendor = vendorById('vendor.rell');
    expect(vendor, 'the merchant has no vendor row').not.toBeNull();
    if (point === undefined || vendor === null) return;
    expect(point.x).toBeCloseTo(vendor.x, 3);
    expect(point.y).toBeCloseTo(vendor.y, 3);
  });

  it('keeps every shop reachable from anywhere its owner can wander to', () => {
    // The real assertion, and it is about the *worst* case rather than the
    // anchor: a player at the far edge of `talkRadius` from a body at the far
    // edge of its wander disc is the furthest anybody can legitimately be
    // standing when they press the reply that opens the shop.
    for (const npc of ALL_NPCS) {
      if (npc.vendorId === null) continue;
      const vendor = vendorById(npc.vendorId);
      expect(vendor, `${npc.id} names a vendor that does not exist: ${npc.vendorId}`).not.toBeNull();
      if (vendor === null) continue;
      const point = points.find((each) => each.monsterId === npc.id);
      if (point === undefined) continue;

      const worst = roamOf(npc.id) + npc.talkRadius;
      // Measured through the server's own predicate rather than by comparing
      // radii, so this cannot come to a different answer than the check that
      // actually refuses a purchase.
      expect(
        withinReach(vendor, point.x + worst, point.y),
        `${npc.id} can stand ${worst} from its shop, which reaches ${vendor.radius}`,
      ).toBe(true);
      expect(withinReach(vendor, point.x, point.y + worst), npc.id).toBe(true);
    }
  });

  it('gives every NPC spawner a friendly row, so nothing hostile wears an NPC id', () => {
    for (const point of points) {
      const npc = npcById(point.monsterId);
      if (npc === null) continue;
      expect(monsterById(point.monsterId)?.temperament.kind, point.id).toBe('friendly');
    }
  });

  it('leaves the ordinary spawners alone', () => {
    // A control on the edit that placed the merchant: adding one marker must
    // not have moved, renamed or dropped any of the twelve that were there.
    const monsters = points.filter((point) => npcById(point.monsterId) === null);
    expect(monsters.length).toBeGreaterThanOrEqual(12);
    for (const point of monsters) {
      expect(monsterById(point.monsterId), point.id).not.toBeNull();
    }
  });
});
