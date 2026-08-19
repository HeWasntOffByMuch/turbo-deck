/**
 * The cell, on its own (spec 127).
 *
 * What is worth checking here rather than through the screen is what the cell
 * refuses and what it draws when the content table has moved on -- the two
 * things a screen test would only reach by accident.
 */

import { describe, expect, it } from 'vitest';
import { over, type Color } from '../core/color.js';
import { DrawList } from '../core/draw-list.js';
import type { DragPayload } from '../core/drag.js';
import { bakeAtlas } from '../render/atlas.js';
import { FULL_MOTION } from '../core/motion.js';
import { THEME } from '../theme/theme.js';
import {
  ItemSlot,
  isItemDrag,
  paintItem,
  SLOT_CATCH,
  SLOT_SIDE,
  type ItemDrag,
  type ItemView,
} from './item-slot.js';

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

function item(defId: string, slot: string | null, count = 1, icon = 'item:sword', rarity = 'common'): ItemView {
  return { defId, name: defId, count, slot, icon, levelRequirement: 1, rarity, details: [] };
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

  /**
   * The tier, drawn where the sprites cannot fight it (spec 185).
   *
   * Asserted against `over` rather than against three literal bytes, because
   * `over` is the rasterizer's own operator and the property being checked is
   * that the wash *is* the tier colour laid on the cell -- pre-composited, since
   * nothing in this framework may blend at draw time.
   */
  it('washes a cell in its tier, opaquely, and leaves ordinary loot alone', () => {
    const wash = (rarity: string): readonly Color[] => {
      const list = new DrawList();
      paintItem(list, PAINT, item('thing', null, 1, 'item:sword', rarity), box);
      return list
        .finish()
        .filter((cmd) => cmd.kind === 'solid')
        .map((cmd) => (cmd as { color: Color }).color);
    };

    expect(wash('common')).toEqual([]);
    // ...and so is a tier this build has never heard of, which is what an
    // unrevealed or a newer drop resolves to.
    expect(wash('platinum')).toEqual([]);

    const mix = THEME.widget('itemSlot').metric('rarityWashMix', 0);
    expect(mix).toBeGreaterThan(0);
    const rare = THEME.color('rarityRare');
    const fill = THEME.widget('itemSlot').state('normal').fill;
    expect(wash('rare')).toEqual([over({ r: rare.r, g: rare.g, b: rare.b, a: mix }, fill)]);
    // Opaque, or `preview-ui-gallery.ts` finds the two backends a byte apart.
    expect(wash('rare')[0]?.a).toBe(255);
    expect(wash('exceptional')[0]).not.toEqual(wash('rare')[0]);
  });

  it('draws the icon in its own colour, whatever the tier', () => {
    // The wash is behind it precisely so this stays true: an orange trinket is
    // an orange trinket at every tier, and the cell says which tier it is.
    const tintsOf = (rarity: string): readonly unknown[] => {
      const list = new DrawList();
      paintItem(list, PAINT, item('thing', null, 1, 'item:sword', rarity), box);
      return list.finish().filter((cmd) => cmd.kind === 'sprite').map((cmd) => (cmd as { tint: unknown }).tint);
    };
    expect(tintsOf('exceptional')).toEqual(tintsOf('common'));
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

describe('the catch around a cell (spec 136)', () => {
  const NO_MODS = { shift: false, ctrl: false, alt: false, meta: false };

  function gesture(kind: 'click' | 'doubleClick' | 'dragStart' | 'dragEnd', button = 0, shift = false) {
    return {
      kind,
      pos: { x: 0, y: 0 },
      delta: { x: 0, y: 0 },
      button,
      mods: { ...NO_MODS, shift },
      time: 0,
    } as const;
  }

  /** A cell placed where the grid would put it, so the rects are real. */
  function placed(x: number, y: number): ItemSlot {
    const cell = new ItemSlot({ container: 'inventory', index: 0 });
    cell.rect = { x, y, width: SLOT_SIDE, height: SLOT_SIDE };
    return cell;
  }

  it('answers the pointer past its own edge, by exactly the catch', () => {
    const cell = placed(10, 10);
    expect(cell.catchRect()).toEqual({
      x: 10 - SLOT_CATCH,
      y: 10 - SLOT_CATCH,
      width: SLOT_SIDE + SLOT_CATCH * 2,
      height: SLOT_SIDE + SLOT_CATCH * 2,
    });
  });

  it('is half the gutter the grid leaves, so the catches tile', () => {
    // The number's whole justification. Two cells a gutter apart: their catches
    // meet exactly, with no pixel in both and no pixel in neither.
    const gutter = THEME.spacing.xs;
    expect(SLOT_CATCH * 2).toBe(gutter);
    const a = placed(0, 0);
    const b = placed(SLOT_SIDE + gutter, 0);
    const left = a.catchRect();
    const right = b.catchRect();
    expect(left.x + left.width).toBe(right.x);
  });

  it('does not draw itself any bigger', () => {
    // The paint rect is untouched, which is what keeps a grid reading as a grid
    // -- and what makes this spec invisible to the goldens.
    const cell = placed(10, 10);
    expect(cell.rect).toEqual({ x: 10, y: 10, width: SLOT_SIDE, height: SLOT_SIDE });
  });

  it('hit-tests over the catch, and stops there', () => {
    const cell = placed(10, 10);
    const hits = (x: number, y: number): boolean => cell.hitTest({ x, y }) === cell;
    expect(hits(10, 10)).toBe(true);
    // Into the gutter above and to the left...
    expect(hits(10 - SLOT_CATCH, 10 - SLOT_CATCH)).toBe(true);
    // ...and one pixel further out, which is the next cell's half.
    expect(hits(10 - SLOT_CATCH - 1, 10)).toBe(false);
    expect(hits(10 + SLOT_SIDE + SLOT_CATCH, 10)).toBe(false);
  });

  it('reports every press and release, and nothing else (spec 137)', () => {
    const cell = placed(0, 0);
    const seen: string[] = [];
    cell.onClick = (_slot, g) => seen.push(`click:${g.button}${g.mods.shift ? '+shift' : ''}`);

    cell.onGesture(gesture('click'));
    cell.onGesture(gesture('click', 2));
    cell.onGesture(gesture('click', 2, true));
    // A press that wandered past the drag threshold: still one press and one
    // release over this cell, and ignoring it would make an unsteady click do
    // nothing at all.
    cell.onGesture(gesture('dragEnd'));
    // Taking something and putting it straight back is two fast clicks on one
    // cell, and the second of those arrives as a double.
    cell.onGesture(gesture('doubleClick'));
    // ...while the start of a press is not a gesture of its own.
    cell.onGesture(gesture('dragStart'));

    expect(seen).toEqual(['click:0', 'click:2', 'click:2+shift', 'click:0', 'click:0']);
  });

  it('is not focusable, so it never holds the arrow keys (spec 137)', () => {
    // The bag is a pointer surface. A focused cell drew a blue ring that read as
    // "active" when nothing was, and held four keys the player walks with.
    expect(placed(0, 0).focusable).toBe(false);
  });
});
