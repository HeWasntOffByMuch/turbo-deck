import { describe, expect, it } from 'vitest';
import { ALL_ITEMS } from '../../../server/data/items.js';
import {
  drawableItemIds,
  weaponExtent,
  weaponKindFor,
  weaponProfile,
  type WeaponKind,
} from './weapon-shape.js';

const KINDS: readonly WeaponKind[] = ['sword', 'maul', 'staff', 'bow', 'thrown'];

/** The height the pig is actually drawn at, which is the real case. */
const BODY = 17.9;

describe('weaponKindFor', () => {
  it('draws nothing for an item with no row, rather than guessing', () => {
    expect(weaponKindFor('helm.leather')).toBeNull();
    expect(weaponKindFor('')).toBeNull();
    // The prefix trap the table exists to avoid: this is not a real item, and
    // a rule that parsed `sword.` out of an id would have drawn it as one.
    expect(weaponKindFor('swordfish.trophy')).toBeNull();
  });

  it('covers every main-hand item the server can actually equip', () => {
    // Driven off the real item table, so adding a weapon server-side fails
    // here rather than silently putting an empty hand on screen.
    const mainHand = ALL_ITEMS.filter((item) => item.slot === 'mainHand').map((item) => item.id);
    expect(mainHand.length).toBeGreaterThan(0);
    const undrawn = mainHand.filter((id) => weaponKindFor(id) === null);
    expect(undrawn).toEqual([]);
  });

  it('has no rows for items that are not main-hand weapons', () => {
    // The other direction: a stale row outliving the item it drew is a shape
    // nothing can ever ask for.
    const mainHand = new Set(ALL_ITEMS.filter((item) => item.slot === 'mainHand').map((item) => item.id));
    const orphans = drawableItemIds().filter((id) => !mainHand.has(id));
    expect(orphans).toEqual([]);
  });
});

describe('weaponProfile', () => {
  it('gives every kind a profile', () => {
    for (const kind of KINDS) expect(weaponProfile(kind, BODY).kind).toBe(kind);
  });

  it('is sized like something a body could hold', () => {
    // The lamppost check. A weapon longer than the person swinging it is the
    // failure that looks fine in a unit test and absurd in a frame.
    for (const kind of KINDS) {
      const extent = weaponExtent(weaponProfile(kind, BODY));
      expect(extent, `${kind} extent`).toBeGreaterThan(BODY * 0.05);
      expect(extent, `${kind} extent`).toBeLessThan(BODY);
    }
  });

  it('keeps every dimension non-negative and the shaft thinner than it is long', () => {
    for (const kind of KINDS) {
      const profile = weaponProfile(kind, BODY);
      expect(profile.length, kind).toBeGreaterThan(0);
      expect(profile.gripOffset, kind).toBeGreaterThanOrEqual(0);
      expect(profile.shaftRadius, kind).toBeGreaterThan(0);
      expect(profile.headLength, kind).toBeGreaterThanOrEqual(0);
      expect(profile.headRadius, kind).toBeGreaterThanOrEqual(0);
      expect(profile.headAt, kind).toBeGreaterThan(0);
      expect(profile.headAt, kind).toBeLessThanOrEqual(1);
      expect(profile.guardSpan, kind).toBeGreaterThanOrEqual(0);
    }
  });

  it('scales with the body, so the same weapon suits a pig and a mannequin', () => {
    // The bug this replaced: profiles built against the canonical constant
    // (55.65) gave the pig, drawn 17.9 tall, a sword longer than itself.
    for (const kind of KINDS) {
      const small = weaponExtent(weaponProfile(kind, 17.9));
      const large = weaponExtent(weaponProfile(kind, 55.65));
      expect(large / small, kind).toBeCloseTo(55.65 / 17.9, 5);
      expect(small, `${kind} on a small body`).toBeLessThan(17.9);
    }
  });

  it('reads as the weapon it is: the maul is top-heavy and the staff is long', () => {
    const maul = weaponProfile('maul', BODY);
    const sword = weaponProfile('sword', BODY);
    const staff = weaponProfile('staff', BODY);
    const bow = weaponProfile('bow', BODY);

    // A maul's head is what makes it a maul.
    expect(maul.headRadius).toBeGreaterThan(maul.shaftRadius * 3);
    // A sword is the only thing here with a crossguard.
    expect(sword.guardSpan).toBeGreaterThan(0);
    expect(maul.guardSpan).toBe(0);
    // A staff outreaches a sword, which is the reason to carry one.
    expect(staff.length).toBeGreaterThan(sword.length);
    // A bow is held at its middle, so most of its length hangs below the hand.
    expect(bow.gripOffset).toBeGreaterThan(bow.length * 0.4);
  });
});
