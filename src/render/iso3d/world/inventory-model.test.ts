/**
 * The inventory's view-model (spec 127).
 *
 * This is where the boundary between the game and `src/ui/` is paid for, so what
 * is worth asserting is that the mapping is total: a bag with holes in it, a
 * stack, an id the table has dropped, and an item with no art all come out as
 * something the screen can draw.
 */

import { describe, expect, it } from 'vitest';
import { ALL_ITEMS } from '../../../server/data/items.js';
import { EMPTY_EQUIPMENT, emptyInventory, EQUIP_SLOTS } from '../../../server/state/types.js';
import { bakeAtlas } from '../../../ui/render/atlas.js';
import { THEME } from '../../../ui/theme/theme.js';
import { containerViewOf, detailsFor, iconFor, itemViewOf, UNKNOWN_ICON } from './inventory-model.js';

describe('containerViewOf', () => {
  it('maps a bag with holes in it, keeping every index', () => {
    const bag = [...emptyInventory()];
    bag[2] = { defId: 'sword.worn', count: 1 };
    bag[7] = { defId: 'potion.minor', count: 4 };

    const view = containerViewOf({ inventory: bag, equipment: EMPTY_EQUIPMENT, level: 3 });
    expect(view.bag).toHaveLength(bag.length);
    expect(view.bag[0]).toBeNull();
    expect(view.bag[2]).toMatchObject({ defId: 'sword.worn', name: 'Worn Sword', slot: 'mainHand' });
    expect(view.bag[7]).toMatchObject({ count: 4, icon: 'item:potion' });
    expect(view.level).toBe(3);
  });

  it('maps what is worn, and leaves an empty slot empty', () => {
    const view = containerViewOf({
      inventory: emptyInventory(),
      equipment: { ...EMPTY_EQUIPMENT, mainHand: 'bow.hunting' },
      level: 1,
    });
    expect(view.worn['mainHand']).toMatchObject({ defId: 'bow.hunting', icon: 'item:bow' });
    expect(view.worn['head']).toBeNull();
  });

  /**
   * The slot list is handed to the screen rather than listed there, so a seventh
   * slot appears without the screen being told. This is the assertion that keeps
   * that true.
   */
  it('offers exactly the equipment slots the server has, in order', () => {
    const view = containerViewOf({
      inventory: emptyInventory(),
      equipment: EMPTY_EQUIPMENT,
      level: 1,
    });
    expect(view.slots.map((slot) => slot.id)).toEqual([...EQUIP_SLOTS]);
    for (const slot of view.slots) expect(slot.label.length).toBeGreaterThan(0);
  });

  /** An id the table has dropped is still in somebody's bag, and still drawable. */
  it('draws an item the table no longer defines rather than hiding it', () => {
    const bag = [...emptyInventory()];
    bag[0] = { defId: 'sword.imaginary', count: 1 };
    const view = containerViewOf({ inventory: bag, equipment: EMPTY_EQUIPMENT, level: 1 });
    expect(view.bag[0]).toMatchObject({
      defId: 'sword.imaginary',
      name: 'sword.imaginary',
      slot: null,
      icon: UNKNOWN_ICON,
    });
  });
});

describe('icons', () => {
  it('names a sprite the atlas actually has, for every item in the table', () => {
    const atlas = bakeAtlas(THEME);
    for (const item of ALL_ITEMS) {
      expect(atlas.hasSprite(iconFor(item.id))).toBe(true);
    }
  });

  it('falls back to the box rather than to nothing', () => {
    expect(iconFor('nothing.at.all')).toBe(UNKNOWN_ICON);
    expect(bakeAtlas(THEME).hasSprite(UNKNOWN_ICON)).toBe(true);
  });

  it('gives every item its own name, not its id', () => {
    expect(itemViewOf('helm.leather', 1).name).toBe('Leather Cap');
  });
});

/**
 * What an item says about itself (spec 176).
 *
 * Asserted against the real table rather than a fixture, because the thing being
 * checked is the *mapping*: that a row's modifiers come out as lines somebody
 * could read, in one order, with a drawback distinguishable from a benefit.
 */
describe('detailsFor', () => {
  const linesOf = (defId: string): readonly string[] => detailsFor(defId).map((line) => line.text);

  it('names the tier and where it is worn, in one line', () => {
    expect(detailsFor('sword.keen')[0]).toEqual({ text: 'Rare  Main Hand', tone: 'rarity' });
    // Nothing carried is worn anywhere, so the tier stands on its own rather
    // than beside an empty half-sentence.
    expect(detailsFor('potion.minor')[0]).toEqual({ text: 'Common', tone: 'rarity' });
  });

  it('writes each modifier out, benefits and drawbacks apart', () => {
    // The maul is the row that has both, which is why it is the one asked.
    expect(detailsFor('maul.iron')).toEqual([
      { text: 'Rare  Main Hand', tone: 'rarity' },
      { text: '+2 Strength', tone: 'good' },
      { text: '+14 Damage', tone: 'good' },
      { text: '+10 Range', tone: 'good' },
      { text: '-20% Attack Speed', tone: 'bad' },
      { text: 'Worth 110 coins', tone: 'dim' },
    ]);
  });

  it('writes a fraction as a percentage, and rounds it like one', () => {
    // 0.15 * 100 in binary floating point is 15.000000000000002.
    expect(linesOf('sword.keen')).toContain('+15% Attack Speed');
    expect(linesOf('shield.oak')).toContain('+6% Armour');
  });

  it('says an item cannot be sold rather than leaving it unpriced', () => {
    // Every row is worth something today, so this is asserted on the rule rather
    // than on a row: it is the branch that would otherwise never be exercised
    // until somebody authored a quest item and found a blank where a price goes.
    for (const item of ALL_ITEMS) {
      const worth = detailsFor(item.id).at(-1);
      expect(worth?.tone, item.id).toBe('dim');
      expect(worth?.text, item.id).toBe(
        item.value > 0 ? `Worth ${item.value} coins` : 'Cannot be sold',
      );
    }
  });

  it('says nothing at all about an id the table has dropped', () => {
    // A tier and nothing else: there is no row to read stats or a price off, and
    // inventing either would be a lie about something in somebody's bag.
    expect(detailsFor('gone.missing')).toEqual([{ text: 'Common', tone: 'rarity' }]);
  });

  it('draws no line for a stat it has no words for', () => {
    // Every describable field is in the table; a `traits` grant is deliberately
    // not (spec 176), and it must produce no line rather than a raw key.
    const described = detailsFor('trinket.bloodstone').map((line) => line.text);
    expect(described.some((text) => text.includes('traits'))).toBe(false);
    expect(described).toContain('+12% Health');
  });

  it('puts the tier on every view, and common on one it cannot place', () => {
    expect(itemViewOf('trinket.bloodstone', 1).rarity).toBe('exceptional');
    expect(itemViewOf('sword.worn', 1).rarity).toBe('common');
    expect(itemViewOf('gone.missing', 1).rarity).toBe('common');
  });
});
