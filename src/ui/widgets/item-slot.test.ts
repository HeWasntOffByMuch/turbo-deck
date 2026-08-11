/**
 * The cell, on its own (spec 127).
 *
 * What is worth checking here rather than through the screen is what the cell
 * refuses and what it draws when the content table has moved on -- the two
 * things a screen test would only reach by accident.
 */

import { describe, expect, it } from 'vitest';
import { DrawList } from '../core/draw-list.js';
import type { DragPayload } from '../core/drag.js';
import { bakeAtlas } from '../render/atlas.js';
import { FULL_MOTION } from '../core/motion.js';
import { THEME } from '../theme/theme.js';
import { ItemSlot, isItemDrag, paintItem, type ItemDrag, type ItemView } from './item-slot.js';

const ATLAS = bakeAtlas(THEME);

const PAINT = {
  theme: THEME,
  atlas: ATLAS,
  now: 0,
  motion: FULL_MOTION,
  hovered: null,
  pressed: null,
  focused: null,
};

function item(defId: string, slot: string | null, count = 1, icon = 'item:sword'): ItemView {
  return { defId, name: defId, count, slot, icon, levelRequirement: 1 };
}

function payloadFrom(cell: ItemSlot, drag: ItemDrag): DragPayload {
  return { source: cell, data: drag };
}

describe('ItemSlot', () => {
  it('takes anything when it accepts anything', () => {
    const source = new ItemSlot({ container: 'inventory', index: 0 });
    const target = new ItemSlot({ container: 'inventory', index: 1 });
    const drag: ItemDrag = { from: source.ref, item: item('sword', 'mainHand'), count: 1 };
    expect(target.canAcceptDrop(payloadFrom(source, drag))).toBe(true);
  });

  it('takes only its own slot when it names one', () => {
    const source = new ItemSlot({ container: 'inventory', index: 0 });
    const head = new ItemSlot({ container: 'equipment', index: 2 });
    head.acceptsSlot = 'head';

    const sword: ItemDrag = { from: source.ref, item: item('sword', 'mainHand'), count: 1 };
    const helm: ItemDrag = { from: source.ref, item: item('helm', 'head'), count: 1 };
    expect(head.canAcceptDrop(payloadFrom(source, sword))).toBe(false);
    expect(head.canAcceptDrop(payloadFrom(source, helm))).toBe(true);
  });

  /** A carried item is not something you can drop onto where it came from. */
  it('refuses the cell the drag started in', () => {
    const cell = new ItemSlot({ container: 'inventory', index: 3 });
    const drag: ItemDrag = { from: cell.ref, item: item('sword', 'mainHand'), count: 1 };
    expect(cell.canAcceptDrop(payloadFrom(cell, drag))).toBe(false);
  });

  it('refuses anything while disabled', () => {
    const source = new ItemSlot({ container: 'inventory', index: 0 });
    const target = new ItemSlot({ container: 'inventory', index: 1 });
    target.enabled = false;
    const drag: ItemDrag = { from: source.ref, item: item('sword', 'mainHand'), count: 1 };
    expect(target.canAcceptDrop(payloadFrom(source, drag))).toBe(false);
  });

  it('refuses a payload that is not an item at all', () => {
    const source = new ItemSlot({ container: 'inventory', index: 0 });
    const target = new ItemSlot({ container: 'inventory', index: 1 });
    expect(target.canAcceptDrop({ source, data: 'a window' })).toBe(false);
    expect(isItemDrag('a window')).toBe(false);
  });

  it('hands the drag on to whoever is listening, with its own address', () => {
    const source = new ItemSlot({ container: 'inventory', index: 0 });
    const target = new ItemSlot({ container: 'equipment', index: 1 });
    const taken: ItemDrag[] = [];
    target.onDropItem = (drag, to) => {
      taken.push(drag);
      expect(to).toEqual({ container: 'equipment', index: 1 });
    };
    const drag: ItemDrag = { from: source.ref, item: item('shield', 'offHand'), count: 1 };
    target.onDrop(payloadFrom(source, drag));
    expect(taken).toEqual([drag]);
  });
});

describe('paintItem', () => {
  const box = { x: 0, y: 0, width: 20, height: 20 };

  it('draws the box for an icon the atlas has never heard of', () => {
    const list = new DrawList();
    // A content edit must not be able to crash the interface, so an unknown
    // sprite is a picture of "something is here" rather than a throw.
    expect(() => paintItem(list, PAINT, item('mystery', null, 1, 'item:nope'), box)).not.toThrow();
    const unknown = ATLAS.sprite('item:unknown');
    expect(list.finish().some((cmd) => cmd.kind === 'sprite' && cmd.src.x === unknown.x)).toBe(true);
  });

  it('draws a count only when there is more than one', () => {
    const one = new DrawList();
    paintItem(one, PAINT, item('potion', null, 1), box);
    const many = new DrawList();
    paintItem(many, PAINT, item('potion', null, 6), box);
    expect(many.finish().length).toBeGreaterThan(one.finish().length);
  });

  it('draws the count it is carrying, not the count in the stack', () => {
    // The ghost passes the carried count: a shift-drag of six shows three, and
    // it has to look exactly like a stack of three or the ghost is lying about
    // what is in flight.
    const carried = new DrawList();
    paintItem(carried, PAINT, item('potion', null, 6), box, 3);
    const three = new DrawList();
    paintItem(three, PAINT, item('potion', null, 3), box);
    expect(carried.finish()).toEqual(three.finish());
  });
});
