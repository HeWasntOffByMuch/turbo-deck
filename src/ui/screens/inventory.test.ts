/**
 * The inventory screen (spec 127).
 *
 * The assertions that matter are the two halves of one rule: a drag emits an
 * intent, and a drag changes nothing on screen. Everything else here is detail
 * around that -- the refusals, the split, the keyboard, the ghost.
 */

import { describe, expect, it } from 'vitest';
import { FocusManager } from '../core/focus.js';
import { NO_MODIFIERS, type Modifiers } from '../core/events.js';
import { LayerStack } from '../core/layers.js';
import { UiRoot } from '../core/root.js';
import { bakeAtlas } from '../render/atlas.js';
import { THEME } from '../theme/theme.js';
import type { ItemView } from '../widgets/item-slot.js';
import { InventoryScreen, type ContainerView, type MoveIntent } from './inventory.js';

const SLOTS = [
  { id: 'mainHand', label: 'Main' },
  { id: 'offHand', label: 'Off' },
  { id: 'head', label: 'Head' },
  { id: 'chest', label: 'Chest' },
  { id: 'legs', label: 'Legs' },
  { id: 'trinket', label: 'Charm' },
];

function item(defId: string, slot: string | null, count = 1, level = 1): ItemView {
  return { defId, name: defId, count, slot, icon: `item:${defId}`, levelRequirement: level };
}

function viewOf(overrides: Partial<ContainerView> = {}): ContainerView {
  const bag: (ItemView | null)[] = new Array<ItemView | null>(24).fill(null);
  bag[0] = item('sword', 'mainHand');
  bag[1] = item('potion', null, 6);
  return {
    bag,
    worn: { mainHand: null, offHand: null, head: null, chest: null, legs: null, trinket: null },
    slots: SLOTS,
    level: 3,
    ...overrides,
  };
}

interface Harness {
  readonly screen: InventoryScreen;
  readonly moves: MoveIntent[];
  readonly root: UiRoot;
  readonly focus: FocusManager;
}

function harness(view = viewOf()): Harness {
  const focus = new FocusManager();
  const layers = new LayerStack();
  const screen = new InventoryScreen({ theme: THEME, focus, hitTest: (at) => layers.hitTest(at) });
  layers.place('windows', screen);
  layers.place('dragGhost', screen.ghost);
  screen.setContainers(view);

  const moves: MoveIntent[] = [];
  screen.onMove = (intent) => moves.push(intent);

  const root = new UiRoot(layers, {
    theme: THEME,
    atlas: bakeAtlas(THEME),
    viewport: { width: 400, height: 300 },
    layers,
  });
  root.update(0);
  return { screen, moves, root, focus };
}

/** Drag from one cell to another, through the controller as a pointer would. */
function dragBetween(
  test: Harness,
  from: { container: 'inventory' | 'equipment'; index: number },
  to: { container: 'inventory' | 'equipment'; index: number },
  mods: Modifiers = NO_MODIFIERS,
): void {
  const source = test.screen.cellAt(from);
  const target = test.screen.cellAt(to);
  if (!source || !target) throw new Error('no such cell');
  test.screen.pickUp(source, { x: source.rect.x + 2, y: source.rect.y + 2 }, mods);
  const centre = {
    x: target.rect.x + Math.floor(target.rect.width / 2),
    y: target.rect.y + Math.floor(target.rect.height / 2),
  };
  test.screen.drag.moveTo(centre);
  test.screen.drag.drop(centre);
}

const inv = (index: number) => ({ container: 'inventory', index }) as const;
const worn = (index: number) => ({ container: 'equipment', index }) as const;

describe('the inventory screen', () => {
  it('shows what it was handed', () => {
    const { screen } = harness();
    expect(screen.cellAt(inv(0))?.item?.defId).toBe('sword');
    expect(screen.cellAt(inv(1))?.item?.count).toBe(6);
    expect(screen.cellAt(inv(2))?.item).toBeNull();
    expect(screen.equipmentSlots).toHaveLength(SLOTS.length);
  });

  it('emits one intent for a drag between two bag cells', () => {
    const test = harness();
    dragBetween(test, inv(0), inv(5));
    expect(test.moves).toEqual([{ from: inv(0), to: inv(5), count: 0 }]);
  });

  /**
   * The rule the screen exists to keep. The client predicts (spec 126) and the
   * next `setContainers` is what moves anything here -- so a widget that edited
   * itself would need undo code, and this is that code not existing.
   */
  it('moves nothing on screen until it is told to', () => {
    const test = harness();
    dragBetween(test, inv(0), inv(5));
    expect(test.screen.cellAt(inv(0))?.item?.defId).toBe('sword');
    expect(test.screen.cellAt(inv(5))?.item).toBeNull();

    // ...and the rollback is simply the unchanged view arriving back.
    test.screen.setContainers(viewOf());
    expect(test.screen.cellAt(inv(0))?.item?.defId).toBe('sword');
    expect(test.screen.cellAt(inv(5))?.item).toBeNull();
  });

  it('equips into a slot the item belongs in', () => {
    const test = harness();
    dragBetween(test, inv(0), worn(0));
    expect(test.moves).toEqual([{ from: inv(0), to: worn(0), count: 0 }]);
  });

  it('refuses an equipment slot the item does not belong in, and says nothing', () => {
    const test = harness();
    dragBetween(test, inv(0), worn(2));
    expect(test.moves).toEqual([]);
  });

  it('refuses to drop a carried item on the cell it came from', () => {
    const test = harness();
    dragBetween(test, inv(0), inv(0));
    expect(test.moves).toEqual([]);
  });

  it('cancels a release over nothing', () => {
    const test = harness();
    const source = test.screen.cellAt(inv(0));
    if (!source) throw new Error('no cell');
    test.screen.pickUp(source, { x: 1, y: 1 });
    test.screen.drag.drop({ x: 399, y: 299 });
    expect(test.moves).toEqual([]);
    expect(test.screen.drag.active).toBeNull();
  });

  it('takes half a stack when shift is held as the drag begins', () => {
    const test = harness();
    dragBetween(test, inv(1), inv(7), { ...NO_MODIFIERS, shift: true });
    expect(test.moves).toEqual([{ from: inv(1), to: inv(7), count: 3 }]);
  });

  /** A plain drag says 0, which the wire reads as the whole stack (spec 126). */
  it('says zero rather than the count for a whole stack', () => {
    const test = harness();
    dragBetween(test, inv(1), inv(7));
    expect(test.moves[0]?.count).toBe(0);
  });

  it('shift-drag of a single item still carries one', () => {
    const test = harness();
    dragBetween(test, inv(0), inv(7), { ...NO_MODIFIERS, shift: true });
    expect(test.moves[0]?.count).toBe(0);
  });
});

describe('the drag ghost', () => {
  it('follows the cursor and disappears when the drag ends', () => {
    const test = harness();
    const source = test.screen.cellAt(inv(0));
    if (!source) throw new Error('no cell');

    expect(test.screen.ghost.visible).toBe(false);
    test.screen.pickUp(source, { x: 40, y: 40 });
    expect(test.screen.ghost.visible).toBe(true);
    expect(test.screen.ghost.item?.defId).toBe('sword');

    test.screen.drag.moveTo({ x: 90, y: 70 });
    test.root.update(16);
    expect(test.screen.ghost.rect.x).toBe(90 - Math.floor(test.screen.ghost.rect.width / 2));

    test.screen.drag.cancel();
    expect(test.screen.ghost.visible).toBe(false);
  });

  /**
   * A ghost that can be hit is a ghost every drop lands on, because it is
   * directly under the cursor for the whole drag.
   */
  it('is never what a hit test finds', () => {
    const test = harness();
    const source = test.screen.cellAt(inv(0));
    if (!source) throw new Error('no cell');
    test.screen.pickUp(source, { x: 40, y: 40 });
    test.root.update(16);

    const layers = test.root.layers;
    expect(layers).not.toBeNull();
    const hit = layers?.hitTest({ x: test.screen.ghost.rect.x + 2, y: test.screen.ghost.rect.y + 2 });
    expect(hit).not.toBe(test.screen.ghost);
  });

  it('lights the cell a drop would land on, and only that one', () => {
    const test = harness();
    const source = test.screen.cellAt(inv(0));
    const target = test.screen.cellAt(inv(4));
    if (!source || !target) throw new Error('no cell');

    test.screen.pickUp(source, { x: source.rect.x + 2, y: source.rect.y + 2 });
    test.screen.drag.moveTo({ x: target.rect.x + 4, y: target.rect.y + 4 });
    expect(target.dropCandidate).toBe(true);
    expect(test.screen.bagSlots.filter((cell) => cell.dropCandidate)).toEqual([target]);

    // Over a slot that refuses, nothing is lit -- the refusal *is* the absence.
    const head = test.screen.cellAt(worn(2));
    if (!head) throw new Error('no cell');
    test.screen.drag.moveTo({ x: head.rect.x + 4, y: head.rect.y + 4 });
    expect(head.dropCandidate).toBe(false);
    expect(test.screen.bagSlots.filter((cell) => cell.dropCandidate)).toEqual([]);
  });
});

describe('the keyboard', () => {
  it('picks up and puts down with the same intent a drag makes', () => {
    const test = harness();
    const source = test.screen.cellAt(inv(0));
    const target = test.screen.cellAt(worn(0));
    if (!source || !target) throw new Error('no cell');

    test.screen.activate(source);
    expect(test.screen.drag.active).not.toBeNull();
    test.screen.activate(target);
    expect(test.moves).toEqual([{ from: inv(0), to: worn(0), count: 0 }]);
  });

  it('keeps the item in hand when the target refuses', () => {
    const test = harness();
    const source = test.screen.cellAt(inv(0));
    const head = test.screen.cellAt(worn(2));
    if (!source || !head) throw new Error('no cell');

    test.screen.activate(source);
    test.screen.activate(head);
    expect(test.moves).toEqual([]);
    expect(test.screen.drag.active).not.toBeNull();
  });

  it('cancels a drag on Escape, and reports that it did', () => {
    const test = harness();
    const source = test.screen.cellAt(inv(0));
    if (!source) throw new Error('no cell');
    expect(test.screen.cancelDrag()).toBe(false);
    test.screen.activate(source);
    expect(test.screen.cancelDrag()).toBe(true);
    expect(test.screen.drag.active).toBeNull();
    // With nothing in hand it declines again, so Escape falls through to the
    // window manager rather than being swallowed.
    expect(test.screen.cancelDrag()).toBe(false);
  });

  it('moves focus by one across the grid and by a row down it', () => {
    const test = harness();
    const first = test.screen.cellAt(inv(0));
    if (!first) throw new Error('no cell');
    test.focus.focus(first);

    expect(test.screen.moveFocus(1, 0)).toBe(true);
    expect(test.focus.focused).toBe(test.screen.cellAt(inv(1)));
    expect(test.screen.moveFocus(0, 1)).toBe(true);
    expect(test.focus.focused).toBe(test.screen.cellAt(inv(7)));
  });

  /** Clamped rather than wrapped: a grid has edges you can see. */
  it('stops at the edges instead of wrapping around them', () => {
    const test = harness();
    const first = test.screen.cellAt(inv(0));
    if (!first) throw new Error('no cell');
    test.focus.focus(first);
    expect(test.screen.moveFocus(-1, 0)).toBe(false);
    expect(test.screen.moveFocus(0, -1)).toBe(false);
    expect(test.focus.focused).toBe(first);

    const lastInRow = test.screen.cellAt(inv(5));
    if (!lastInRow) throw new Error('no cell');
    test.focus.focus(lastInRow);
    // Right from the end of a row is not the start of the next one.
    expect(test.screen.moveFocus(1, 0)).toBe(false);
  });

  it('walks the paperdoll one slot at a time, and not sideways', () => {
    const test = harness();
    const head = test.screen.cellAt(worn(2));
    if (!head) throw new Error('no cell');
    test.focus.focus(head);
    expect(test.screen.moveFocus(0, 1)).toBe(true);
    expect(test.focus.focused).toBe(test.screen.cellAt(worn(3)));
    expect(test.screen.moveFocus(1, 0)).toBe(false);
  });
});

describe('layout', () => {
  it('lays every cell out without overlapping', () => {
    const { screen } = harness();
    const cells = [...screen.bagSlots, ...screen.equipmentSlots];
    for (const a of cells) {
      expect(a.rect.width).toBe(a.rect.height);
      for (const b of cells) {
        if (a === b) continue;
        const apart =
          a.rect.x + a.rect.width <= b.rect.x ||
          b.rect.x + b.rect.width <= a.rect.x ||
          a.rect.y + a.rect.height <= b.rect.y ||
          b.rect.y + b.rect.height <= a.rect.y;
        expect(apart).toBe(true);
      }
    }
  });

  it('does no layout work on a still frame', () => {
    const test = harness();
    const passes = test.root.layoutPasses;
    for (let frame = 1; frame <= 30; frame++) test.root.update(frame * 16);
    expect(test.root.layoutPasses).toBe(passes);
  });

  /**
   * A resend arrives twenty times a second and rebuilds the whole view-model, so
   * a screen that compared items by identity would relayout on every one.
   */
  it('does no layout work when the same contents arrive again', () => {
    const test = harness();
    const passes = test.root.layoutPasses;
    test.screen.setContainers(viewOf());
    test.root.update(16);
    expect(test.root.layoutPasses).toBe(passes);
  });

  it('says what an item is, and flags one the character cannot use yet', () => {
    const bag: (ItemView | null)[] = new Array<ItemView | null>(24).fill(null);
    bag[0] = item('maul', 'mainHand', 1, 9);
    bag[1] = item('potion', null, 6);
    const test = harness(viewOf({ bag }));
    const says = (index: number): string => {
      const cell = test.screen.cellAt(inv(index));
      if (!cell) throw new Error(`no cell ${index}`);
      return test.screen.tooltipFor(cell);
    };
    expect(says(0)).toContain('Requires level 9');
    expect(says(1)).toBe('potion x6');
    expect(says(9)).toBe('');
  });

  // --- spec 136 ---------------------------------------------------------

  /** A click, through the gesture the router would deliver for a short press. */
  function clickCell(
    test: Harness,
    ref: { container: 'inventory' | 'equipment'; index: number },
    button = 0,
    mods: Modifiers = NO_MODIFIERS,
  ): void {
    const cell = test.screen.cellAt(ref);
    if (!cell) throw new Error('no such cell');
    const pos = {
      x: cell.rect.x + Math.floor(cell.rect.width / 2),
      y: cell.rect.y + Math.floor(cell.rect.height / 2),
    };
    test.screen.clickCell(cell, {
      kind: 'click',
      pos,
      delta: { x: 0, y: 0 },
      button,
      mods,
      time: 0,
    });
  }

  describe('clicking to carry (spec 136)', () => {
    it('takes on the first click and puts down on the second', () => {
      const test = harness();
      clickCell(test, inv(0));
      // In hand, and nothing has moved: the screen never edits itself.
      expect(test.screen.drag.active).not.toBeNull();
      expect(test.moves).toEqual([]);

      clickCell(test, inv(5));
      expect(test.screen.drag.active).toBeNull();
      expect(test.moves).toEqual([{ from: inv(0), to: inv(5), count: 0 }]);
    });

    /**
     * The two gestures are one state machine reached two ways, so they must
     * produce the same request -- otherwise "it worked when I dragged it" is a
     * real sentence and one of the two paths is wrong.
     */
    it('reaches the same move a drag would', () => {
      const dragged = harness();
      dragBetween(dragged, inv(0), inv(5));

      const clicked = harness();
      clickCell(clicked, inv(0));
      clickCell(clicked, inv(5));

      expect(clicked.moves).toEqual(dragged.moves);
    });

    it('leaves it in hand when the cell refuses', () => {
      const test = harness();
      // A sword into the head slot: refused, and there is no floor to lose it on.
      clickCell(test, inv(0));
      clickCell(test, worn(2));
      expect(test.screen.drag.active).not.toBeNull();
      expect(test.moves).toEqual([]);
    });

    it('does nothing on an empty cell with empty hands', () => {
      const test = harness();
      clickCell(test, inv(20));
      expect(test.screen.drag.active).toBeNull();
      expect(test.moves).toEqual([]);
    });

    it('still halves a stack when shift is held', () => {
      const test = harness();
      // Slot 1 holds six potions; half of six is three.
      clickCell(test, inv(1), 0, { ...NO_MODIFIERS, shift: true });
      clickCell(test, inv(9));
      expect(test.moves[0]?.count).toBe(3);
    });
  });

  describe('right-clicking to equip (spec 136)', () => {
    it('sends a bag item to the slot it names', () => {
      const test = harness();
      // Slot 0 holds a sword, which is `mainHand` -- the first paperdoll slot.
      clickCell(test, inv(0), 2);
      expect(test.moves).toEqual([{ from: inv(0), to: worn(0), count: 0 }]);
    });

    it('sends a worn item back to the first free bag cell', () => {
      const test = harness(
        viewOf({
          worn: {
            mainHand: item('sword', 'mainHand'),
            offHand: null,
            head: null,
            chest: null,
            legs: null,
            trinket: null,
          },
        }),
      );
      clickCell(test, worn(0), 2);
      const move = test.moves[0];
      expect(move?.from).toEqual(worn(0));
      expect(move?.to.container).toBe('inventory');
      // The first cell that is actually empty, not merely the first cell.
      expect(test.screen.bagSlots[move?.to.index ?? -1]?.item).toBeNull();
    });

    it('does nothing for something that is not equipment', () => {
      const test = harness();
      // Slot 1 is a potion: no `slot`, so it is not equipment.
      clickCell(test, inv(1), 2);
      expect(test.moves).toEqual([]);
    });

    it('does nothing while something is in hand', () => {
      const test = harness();
      clickCell(test, inv(0));
      clickCell(test, inv(1), 2);
      expect(test.moves).toEqual([]);
    });
  });

  describe('the tooltip (spec 136)', () => {
    it('says what the item under the pointer is, after the delay', () => {
      const test = harness();
      const cell = test.screen.cellAt(inv(0));
      if (!cell) throw new Error('no cell');
      test.screen.pointerMoved({ x: cell.rect.x + 2, y: cell.rect.y + 2 }, 0);
      test.screen.updateTooltip(0);
      expect(test.screen.tooltip.visible).toBe(false);

      test.screen.updateTooltip(THEME.input.tooltipDelayMs + 1);
      expect(test.screen.tooltip.visible).toBe(true);
      expect(test.screen.tooltip.label).toContain('sword');
    });

    it('says nothing over an empty cell', () => {
      const test = harness();
      const cell = test.screen.cellAt(inv(20));
      if (!cell) throw new Error('no cell');
      test.screen.pointerMoved({ x: cell.rect.x + 2, y: cell.rect.y + 2 }, 0);
      test.screen.updateTooltip(THEME.input.tooltipDelayMs + 1);
      expect(test.screen.tooltip.visible).toBe(false);
    });
  });

  /**
   * The gutter belongs to the nearer cell, and to exactly one of them (spec 136).
   *
   * This is the property `SLOT_CATCH` exists for and the reason it is half the
   * grid's gap rather than any other number. Overlap would be worse than the gap
   * it fixes: two cells claiming a pixel makes the winner depend on child order,
   * which is invisible on screen and therefore unfixable by a player.
   *
   * Walked over every pixel of the grid rather than sampled, because the failure
   * is one column wide.
   */
  describe('the drop gutter (spec 136)', () => {
    it('gives every pixel of the bag to exactly one cell', () => {
      const test = harness();
      const cells = test.screen.bagSlots;
      const first = cells[0];
      const last = cells[cells.length - 1];
      if (!first || !last) throw new Error('no cells');

      const bounds = {
        left: first.rect.x,
        top: first.rect.y,
        right: last.rect.x + last.rect.width,
        bottom: last.rect.y + last.rect.height,
      };

      let claimedTwice = 0;
      let claimedNever = 0;
      for (let y = bounds.top; y < bounds.bottom; y += 1) {
        for (let x = bounds.left; x < bounds.right; x += 1) {
          let claims = 0;
          for (const cell of cells) {
            const rect = cell.catchRect();
            if (x < rect.x || x >= rect.x + rect.width) continue;
            if (y < rect.y || y >= rect.y + rect.height) continue;
            claims += 1;
          }
          if (claims > 1) claimedTwice += 1;
          if (claims === 0) claimedNever += 1;
        }
      }
      expect(claimedTwice).toBe(0);
      expect(claimedNever).toBe(0);
    });

    /** ...and the gap was real before it, so the test above is worth having. */
    it('was not already covered by the drawn rects alone', () => {
      const test = harness();
      const cells = test.screen.bagSlots;
      const a = cells[0];
      const b = cells[1];
      if (!a || !b) throw new Error('no cells');
      expect(b.rect.x).toBeGreaterThan(a.rect.x + a.rect.width);
      // ...and the catch closes it exactly, with nothing to spare.
      expect(a.catchRect().x + a.catchRect().width).toBe(b.catchRect().x);
    });

    it('leaves the drawn rect alone, so nothing looks different', () => {
      const test = harness();
      const cell = test.screen.bagSlots[0];
      expect(cell?.rect.width).toBe(20);
      expect(cell?.rect.height).toBe(20);
    });
  });
});