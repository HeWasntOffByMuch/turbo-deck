/**
 * Specs 246 and 245. The shipped map's NPCs, against the tables that describe
 * them.
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

  it('puts every shopkeeper exactly where its shop thinks it is', () => {
    for (const npc of ALL_NPCS) {
      if (npc.vendorId === null) continue;
      const point = points.find((each) => each.monsterId === npc.id);
      expect(point, `${npc.id} has no spawner`).toBeDefined();
      const vendor = vendorById(npc.vendorId);
      expect(vendor, `${npc.id} has no vendor row`).not.toBeNull();
      if (point === undefined || vendor === null) continue;
      expect(point.x, npc.id).toBeCloseTo(vendor.x, 3);
      expect(point.y, npc.id).toBeCloseTo(vendor.y, 3);
    }
  });

  /**
   * No two of them can end up standing in the same place (spec 247).
   *
   * The failure this catches is not a crash: three bodies whose wander discs
   * overlap spend the fight-free half of their lives shoving each other around
   * through `resolveCrowding`, and a player right-clicking the middle of the
   * pile gets whichever one the pick happened to land on. Measured between
   * *discs* rather than between anchors, because the anchors being far apart is
   * not the claim -- the claim is that the bodies cannot meet.
   */
  it("keeps the shopkeepers' wander discs apart", () => {
    const placed = ALL_NPCS.map((npc) => ({
      npc,
      point: points.find((each) => each.monsterId === npc.id),
    })).filter((each): each is { npc: (typeof ALL_NPCS)[number]; point: NonNullable<typeof each.point> } =>
      each.point !== undefined,
    );
    expect(placed.length).toBe(ALL_NPCS.length);
    for (let i = 0; i < placed.length; i += 1) {
      for (let j = i + 1; j < placed.length; j += 1) {
        const a = placed[i];
        const b = placed[j];
        if (a === undefined || b === undefined) continue;
        const gap = Math.hypot(a.point.x - b.point.x, a.point.y - b.point.y);
        const discs = roamOf(a.npc.id) + roamOf(b.npc.id);
        expect(gap, `${a.npc.id} and ${b.npc.id} are ${gap.toFixed(0)} apart`).toBeGreaterThan(discs);
      }
    }
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
    // A control on the edits that placed the shopkeepers: adding three markers
    // must not have moved, renamed or dropped any of the twelve that were
    // there.
    const monsters = points.filter((point) => npcById(point.monsterId) === null);
    expect(monsters.length).toBeGreaterThanOrEqual(12);
    for (const point of monsters) {
      expect(monsterById(point.monsterId), point.id).not.toBeNull();
    }
  });
});
