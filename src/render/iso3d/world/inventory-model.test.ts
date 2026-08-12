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
import { containerViewOf, iconFor, itemViewOf, UNKNOWN_ICON } from './inventory-model.js';

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
