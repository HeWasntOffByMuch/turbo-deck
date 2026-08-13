import { describe, expect, it } from 'vitest';
import { monsterLookFor, monsterLookIds } from './monster-look.js';
import { ALL_MONSTERS, monsterById } from '../../../server/data/monsters.js';
import { PALETTE } from '../palette.js';

/**
 * The look table (spec 152), and mostly the rule it exists to hold: a monster's
 * sim numbers have one home and it is not here.
 */
describe('monsterLookFor', () => {
  it('answers for every monster in the table, and names only monsters that exist', () => {
    for (const monster of ALL_MONSTERS) {
      expect(() => monsterLookFor(monster.id), monster.id).not.toThrow();
    }
    // The other direction is the one that catches a typo: a look keyed on a
    // monster nobody has heard of is a row that draws nothing, forever, quietly.
    for (const typeId of monsterLookIds()) {
      expect(monsterById(typeId), typeId).not.toBeNull();
    }
  });

  it('leaves a monster with no row exactly as it draws today', () => {
    for (const id of ['grazer', 'stalker', 'ravager', 'slinger', 'dummy']) {
      expect(monsterLookFor(id), id).toBeNull();
    }
    expect(monsterLookFor('nothing.like.this')).toBeNull();
    expect(monsterLookFor('')).toBeNull();
  });

  it('does not answer with something off Object.prototype', () => {
    // A type id arrives off the wire, and a plain-object table would hand back
    // the Object constructor for this one.
    for (const id of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expect(monsterLookFor(id), id).toBeNull();
    }
  });

  it('never hands two bodies the same records', () => {
    // `MechRig` holds both live and re-reads them every frame, so one shared
    // record would mean recolouring one spider recoloured the whole nest.
    const first = monsterLookFor('small_spider');
    const second = monsterLookFor('small_spider');
    expect(first).not.toBeNull();
    expect(first?.tuning).not.toBe(second?.tuning);
    expect(first?.appearance).not.toBe(second?.appearance);

    (first?.tuning as Record<string, number>)['sizeScale'] = 9;
    if (first) first.appearance.bodyColor = 0xff0000;
    expect(second?.tuning.sizeScale).toBe(0.6);
    expect(second?.appearance.bodyColor).toBe(PALETTE.enemySpider);
    expect(monsterLookFor('small_spider')?.tuning.sizeScale).toBe(0.6);
    expect(monsterLookFor('small_spider')?.appearance.bodyColor).toBe(PALETTE.enemySpider);
  });
});

describe('the small spider', () => {
  const look = monsterLookFor('small_spider');

  it('is a near-black sphere on legs of the same colour', () => {
    expect(look?.appearance.shape).toBe('sphere');
    expect(look?.appearance.bodyColor).toBe(PALETTE.enemySpider);
    // Stated rather than left to the rig's default, which is the body darkened.
    expect(look?.appearance.legColor).toBe(PALETTE.enemySpider);
    // Dark enough to read as black against grass, and not `0x000000` -- a pure
    // black Lambert multiplies the sun out and loses the facets that make the
    // body round. Both halves matter, so both are pinned.
    const channels = [16, 8, 0].map((shift) => (PALETTE.enemySpider >> shift) & 0xff);
    expect(Math.max(...channels)).toBeLessThan(0x40);
    expect(Math.min(...channels)).toBeGreaterThan(0);
  });

  it('carries exactly the numbers it was tuned to, and no others', () => {
    // `toEqual` on the whole object rather than field by field: the point is
    // that nothing ELSE is overridden, so every field this table is silent
    // about stays at `defaultMechTuning()` when `scene.ts` spreads it.
    expect(look?.tuning).toEqual({
      sizeScale: 0.6,
      bodySize: 1.25,
      raisedLegs: 0,
      pitchGain: 0.0006,
      rollGain: 0.03,
      coxaReach: 0,
      femurScale: 1.05,
    });
  });
});

describe('the split with the monster table', () => {
  /**
   * The invariant the `Omit` in `MechRigTuning` exists to make unwriteable,
   * asserted at runtime as well -- because deleting the `Omit` is a one-word
   * edit that a type check would then wave through.
   */
  it('keeps a sim number out of the look table', () => {
    for (const typeId of monsterLookIds()) {
      const tuning = monsterLookFor(typeId)?.tuning as Record<string, unknown>;
      expect(Object.keys(tuning), typeId).not.toContain('moveSpeed');
      expect(Object.keys(tuning), typeId).not.toContain('turnRate');
    }
  });

  it('reads the spider’s tuned speed and turn rate off the monster table', () => {
    // Where the server runs them from, and where `turn-limits.ts` looks to ease
    // the drawn heading of a body it does not own.
    const spider = monsterById('small_spider');
    expect(spider).not.toBeNull();
    expect(spider?.stats.moveSpeed).toBe(115);
    expect(spider?.stats.turnRate).toBe(290);
    // Small enough that the drawn body and the circle you click are the same
    // size; small enough to be the smallest thing in the arena.
    expect(spider?.radius).toBe(12);
    expect(Math.min(...ALL_MONSTERS.map((m) => m.radius))).toBe(12);
  });
});
