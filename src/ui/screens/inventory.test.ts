/**
 * The inventory screen (specs 127, 136, 137).
 *
 * The assertions that matter are the two halves of one rule: a click emits an
 * intent, and the server is what moves anything. Everything else here is detail
 * around that -- the refusals, the split, the ghost, the gutter.
 */

import { describe, expect, it } from 'vitest';
import { NO_MODIFIERS, type Modifiers } from '../core/events.js';
import { LayerStack } from '../core/layers.js';
import { UiRoot } from '../core/root.js';
import { bakeAtlas } from '../render/atlas.js';
import { THEME } from '../theme/theme.js';
import type { ItemDetail, ItemView } from '../widgets/item-slot.js';
import {
  InventoryScreen,
  type ContainerView,
  type DropIntent,
  type MoveIntent,
} from './inventory.js';

const SLOTS = [
  { id: 'mainHand', label: 'Main' },
  { id: 'offHand', label: 'Off' },
  { id: 'head', label: 'Head' },
  { id: 'chest', label: 'Chest' },
  { id: 'legs', label: 'Legs' },
  { id: 'trinket', label: 'Charm' },
];

// `accepts` is the family (spec 188), which is what `inventory-model.ts` hands
// in: all four take `skill`, so one sigil row fits any of them.
const SKILL_SLOTS = [
  { id: 'skill1', label: 'Skill 1', accepts: 'skill' },
  { id: 'skill2', label: 'Skill 2', accepts: 'skill' },
  { id: 'skill3', label: 'Skill 3', accepts: 'skill' },
  { id: 'skill4', label: 'Skill 4', accepts: 'skill' },
];

function item(
  defId: string,
  slot: string | null,
  count = 1,
  level = 1,
  rarity = 'common',
  details: readonly ItemDetail[] = [],
): ItemView {
  return { defId, name: defId, count, slot, icon: `item:${defId}`, levelRequirement: level, rarity, details };
}

function says(test: { screen: InventoryScreen }, index: number): readonly string[] {
  const cell = test.screen.cellAt(inv(index));
  if (!cell) throw new Error(`no cell ${index}`);
  return test.screen.tooltipFor(cell).map((line) => line.text);
}

function viewOf(overrides: Partial<ContainerView> = {}): ContainerView {
  const bag: (ItemView | null)[] = new Array<ItemView | null>(24).fill(null);
  bag[0] = item('sword', 'mainHand');
  bag[1] = item('potion', null, 6);
  return {
    bag,
    worn: { mainHand: null, offHand: null, head: null, chest: null, legs: null, trinket: null },
    slots: SLOTS,
    skillSlots: SKILL_SLOTS,
    level: 3,
    coins: 42,
    ...overrides,
  };
}

interface Harness {
  readonly screen: InventoryScreen;
  readonly moves: MoveIntent[];
  readonly dropped: DropIntent[];
  readonly root: UiRoot;
}

function harness(view = viewOf()): Harness {
  const layers = new LayerStack();
  const screen = new InventoryScreen({ theme: THEME, hitTest: (at) => layers.hitTest(at) });
  layers.place('windows', screen);
  layers.place('dragGhost', screen.ghost);
  screen.setContainers(view);

  const moves: MoveIntent[] = [];
  screen.onMove = (intent) => moves.push(intent);
  const dropped: DropIntent[] = [];
  screen.onDropToWorld = (intent) => dropped.push(intent);

  const root = new UiRoot(layers, {
    theme: THEME,
    atlas: bakeAtlas(THEME),
    viewport: { width: 400, height: 300 },
    layers,
  });
  root.update(0);
  return { screen, moves, dropped, root };
}

interface Ref {
  readonly container: 'inventory' | 'equipment';
  readonly index: number;
}

/** A press and release on a cell, as the router would deliver it. */
function clickCell(test: Harness, ref: Ref, button = 0, mods: Modifiers = NO_MODIFIERS): void {
  const cell = test.screen.cellAt(ref);
  if (!cell) throw new Error('no such cell');
  const pos = {
    x: cell.rect.x + Math.floor(cell.rect.width / 2),
    y: cell.rect.y + Math.floor(cell.rect.height / 2),
  };
  test.screen.clickCell(cell, { kind: 'click', pos, delta: { x: 0, y: 0 }, button, mods, time: 0 });
}

/** Take from one cell and put down on another: the whole gesture, twice a click. */
function carryBetween(test: Harness, from: Ref, to: Ref, button = 0, mods: Modifiers = NO_MODIFIERS): void {
  clickCell(test, from, button, mods);
  clickCell(test, to);
}

const inv = (index: number) => ({ container: 'inventory', index }) as const;
const worn = (index: number) => ({ container: 'equipment', index }) as const;

describe('the inventory screen', () => {
  it('shows what it was handed', () => {
    const { screen } = harness();
    expect(screen.cellAt(inv(0))?.item?.defId).toBe('sword');
    expect(screen.cellAt(inv(1))?.item?.count).toBe(6);
    expect(screen.cellAt(inv(2))?.item).toBeNull();
    // Worn cells and skill cells share one list, indexed by equipment ordinal
    // (spec 188): a `SlotRef` has to mean the same thing whichever group the
    // cell was drawn in, or a drag into the skill row would address a helmet.
    expect(screen.equipmentSlots).toHaveLength(SLOTS.length + SKILL_SLOTS.length);
  });

  it('emits one intent for a carry between two bag cells', () => {
    const test = harness();
    carryBetween(test, inv(0), inv(5));
    expect(test.moves).toEqual([{ from: inv(0), to: inv(5), count: 0 }]);
  });

  /**
   * The rule the screen exists to keep. The client predicts (spec 126) and the
   * next `setContainers` is what moves anything here -- so a widget that edited
   * itself would need undo code, and this is that code not existing.
   */
  it('moves nothing on screen until it is told to', () => {
    const test = harness();
    carryBetween(test, inv(0), inv(5));
    expect(test.screen.cellAt(inv(0))?.item?.defId).toBe('sword');
    expect(test.screen.cellAt(inv(5))?.item).toBeNull();

    // ...and the rollback is simply the unchanged view arriving back.
    test.screen.setContainers(viewOf());
    expect(test.screen.cellAt(inv(0))?.item?.defId).toBe('sword');
    expect(test.screen.cellAt(inv(5))?.item).toBeNull();
  });

  it('equips into a slot the item belongs in', () => {
    const test = harness();
    carryBetween(test, inv(0), worn(0));
    expect(test.moves).toEqual([{ from: inv(0), to: worn(0), count: 0 }]);
  });

  it('refuses an equipment slot the item does not belong in, and says nothing', () => {
    const test = harness();
    carryBetween(test, inv(0), worn(2));
    expect(test.moves).toEqual([]);
  });

  /**
   * Putting it back where it came from (spec 137).
   *
   * A cancel rather than a refusal, and the difference is visible: the cell is
   * empty while the item is in hand, so "you cannot drop it there" would leave
   * the player holding something with nowhere to put it back.
   */
  it('puts a carried item back into the cell it came from', () => {
    const test = harness();
    carryBetween(test, inv(0), inv(0));
    expect(test.moves).toEqual([]);
    expect(test.screen.drag.active).toBeNull();
    expect(test.screen.cellAt(inv(0))?.item?.defId).toBe('sword');
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

  /** A plain carry says 0, which the wire reads as the whole stack (spec 126). */
  it('says zero rather than the count for a whole stack', () => {
    const test = harness();
    carryBetween(test, inv(1), inv(7));
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

describe('Escape, with something in hand', () => {
  it('cancels the carry and reports that it did', () => {
    const test = harness();
    const source = test.screen.cellAt(inv(0));
    if (!source) throw new Error('no cell');
    expect(test.screen.cancelDrag()).toBe(false);
    clickCell(test, inv(0));
    expect(test.screen.cancelDrag()).toBe(true);
    expect(test.screen.drag.active).toBeNull();
    // ...and the cell it came out of has it again.
    expect(test.screen.cellAt(inv(0))?.item?.defId).toBe('sword');
    // With nothing in hand it declines, so Escape falls through to the window
    // manager rather than being swallowed.
    expect(test.screen.cancelDrag()).toBe(false);
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
    expect(says(test, 0)).toContain('Requires level 9');
    expect(says(test, 1)).toEqual(['potion', 'x6']);
    expect(says(test, 9)).toEqual([]);
  });

  /**
   * The tier reaches the interface as a colour (spec 185).
   *
   * Asserted as tokens rather than as bytes, because a token is what the widget
   * carries and what a theme retune would keep: the day somebody warms the gold
   * up, this test should not fail.
   */
  it('draws an item in its own tier, and everything it was told about it', () => {
    const bag: (ItemView | null)[] = new Array<ItemView | null>(24).fill(null);
    bag[0] = item('bloodstone', 'trinket', 1, 1, 'exceptional', [
      { text: 'Exceptional  Trinket', tone: 'rarity' },
      { text: '+12% Health', tone: 'good' },
      { text: '-8 Move Speed', tone: 'bad' },
      { text: 'Worth 210 coins', tone: 'dim' },
    ]);
    bag[1] = item('rock', null, 1, 1, 'nothing-this-build-has-heard-of');
    const test = harness(viewOf({ bag }));
    const cell = test.screen.cellAt(inv(0));
    if (!cell) throw new Error('no cell');

    expect(test.screen.tooltipFor(cell)).toEqual([
      { text: 'bloodstone', colorToken: 'rarityExceptional' },
      // The tier line wears the item's own colour rather than a tone's.
      { text: 'Exceptional  Trinket', colorToken: 'rarityExceptional' },
      { text: '+12% Health', colorToken: 'success' },
      { text: '-8 Move Speed', colorToken: 'danger' },
      { text: 'Worth 210 coins', colorToken: 'textDim' },
    ]);

    // Total, like `rarityFromByte`: an unknown tier is ordinary loot, not a throw.
    const unknown = test.screen.cellAt(inv(1));
    if (!unknown) throw new Error('no cell');
    expect(test.screen.tooltipFor(unknown)[0]?.colorToken).toBe('rarityCommon');
  });

  // --- specs 136 and 137 -------------------------------------------------

  describe('clicking to carry', () => {
    it('takes on the first click and puts down on the second', () => {
      const test = harness();
      clickCell(test, inv(0));
      // In hand, and nothing has moved on the server: the screen never edits
      // itself. What it *does* do is empty the cell it came out of.
      expect(test.screen.drag.active).not.toBeNull();
      expect(test.moves).toEqual([]);
      expect(test.screen.cellAt(inv(0))?.item).toBeNull();

      clickCell(test, inv(5));
      expect(test.screen.drag.active).toBeNull();
      expect(test.moves).toEqual([{ from: inv(0), to: inv(5), count: 0 }]);
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
  });

  /**
   * How much comes out of a stack (spec 137).
   *
   * The genre's split, and the one the player asked for: left takes the lot,
   * right takes half, shift+right takes one.
   */
  describe('taking part of a stack', () => {
    it('takes the whole stack on a left click', () => {
      const test = harness();
      carryBetween(test, inv(1), inv(9));
      // Zero on the wire is "all of it" (spec 126).
      expect(test.moves).toEqual([{ from: inv(1), to: inv(9), count: 0 }]);
    });

    it('takes half on a right click, rounding up', () => {
      const test = harness();
      // Slot 1 holds six potions.
      carryBetween(test, inv(1), inv(9), 2);
      expect(test.moves[0]?.count).toBe(3);
      // ...and the three left behind are still drawn in the cell while the
      // other three are in hand.
      const test2 = harness();
      clickCell(test2, inv(1), 2);
      expect(test2.screen.cellAt(inv(1))?.item?.count).toBe(3);
    });

    it('takes one on shift+right, whatever the stack', () => {
      const test = harness();
      carryBetween(test, inv(1), inv(9), 2, { ...NO_MODIFIERS, shift: true });
      expect(test.moves[0]?.count).toBe(1);
      const test2 = harness();
      clickCell(test2, inv(1), 2, { ...NO_MODIFIERS, shift: true });
      expect(test2.screen.cellAt(inv(1))?.item?.count).toBe(5);
    });

    it('takes the one item there is, on either right-click, when there is no stack', () => {
      for (const mods of [NO_MODIFIERS, { ...NO_MODIFIERS, shift: true }]) {
        const test = harness();
        carryBetween(test, inv(0), inv(9), 2, mods);
        // A single item is the whole stack, so the wire says zero.
        expect(test.moves).toEqual([{ from: inv(0), to: inv(9), count: 0 }]);
      }
    });

    it('empties the cell entirely when the whole stack is taken', () => {
      const test = harness();
      clickCell(test, inv(1));
      expect(test.screen.cellAt(inv(1))?.item).toBeNull();
    });

    it('puts the rest of a split back when the carry is cancelled', () => {
      const test = harness();
      clickCell(test, inv(1), 2);
      expect(test.screen.cellAt(inv(1))?.item?.count).toBe(3);
      test.screen.cancelDrag();
      expect(test.screen.cellAt(inv(1))?.item?.count).toBe(6);
    });
  });

  describe('shift+left to wear it', () => {
    it('sends a bag item to the slot it names', () => {
      const test = harness();
      // Slot 0 holds a sword, which is `mainHand` -- the first paperdoll slot.
      clickCell(test, inv(0), 0, { ...NO_MODIFIERS, shift: true });
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
      clickCell(test, worn(0), 0, { ...NO_MODIFIERS, shift: true });
      const move = test.moves[0];
      expect(move?.from).toEqual(worn(0));
      expect(move?.to.container).toBe('inventory');
      // The first cell that is actually empty, not merely the first cell.
      expect(test.screen.bagSlots[move?.to.index ?? -1]?.item).toBeNull();
    });

    it('does nothing for something that is not equipment', () => {
      const test = harness();
      // Slot 1 is a potion: no `slot`, so it is not equipment.
      clickCell(test, inv(1), 0, { ...NO_MODIFIERS, shift: true });
      expect(test.moves).toEqual([]);
    });

    it('puts down what is in hand rather than equipping, when hands are full', () => {
      const test = harness();
      clickCell(test, inv(0));
      clickCell(test, inv(1), 0, { ...NO_MODIFIERS, shift: true });
      // A click while carrying is a placement, whatever button or modifier it
      // arrived with -- one rule, so nothing is ever left mysteriously in hand.
      expect(test.moves).toEqual([{ from: inv(0), to: inv(1), count: 0 }]);
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
/**
 * Putting a carry down in the world (spec 172).
 *
 * The screen's half of it is small on purpose: it says which slot the thing came
 * out of and lets go. Where it lands, whether the server allows it and what the
 * cell shows next are all somebody else's -- the same division every other
 * intent on this screen keeps.
 */
describe('dropping a carry into the world', () => {
  it('emits the slot it came from and ends the carry', () => {
    const test = harness();
    clickCell(test, { container: 'inventory', index: 0 });
    expect(test.screen.drag.active).not.toBeNull();

    expect(test.screen.dropCarried()).toBe(true);
    expect(test.dropped).toEqual([{ at: { container: 'inventory', index: 0 }, count: 0 }]);
    expect(test.screen.drag.active).toBeNull();
    // Nothing was moved between slots: a drop is not a move.
    expect(test.moves).toEqual([]);
  });

  /** 0 is "all of it" on the wire, so a part-carry has to say how many. */
  it('says how many when only part of a stack is in hand', () => {
    const test = harness();
    // Right-click on the stack of six takes half of it.
    clickCell(test, { container: 'inventory', index: 1 }, 2);
    test.screen.dropCarried();
    expect(test.dropped).toEqual([{ at: { container: 'inventory', index: 1 }, count: 3 }]);
  });

  it('drops what was taken off the paperdoll', () => {
    const worn = viewOf({
      worn: {
        mainHand: item('sword', 'mainHand'),
        offHand: null,
        head: null,
        chest: null,
        legs: null,
        trinket: null,
      },
    });
    const test = harness(worn);
    clickCell(test, { container: 'equipment', index: 0 });
    test.screen.dropCarried();
    expect(test.dropped).toEqual([{ at: { container: 'equipment', index: 0 }, count: 0 }]);
  });

  it('does nothing at all with empty hands', () => {
    const test = harness();
    expect(test.screen.dropCarried()).toBe(false);
    expect(test.dropped).toEqual([]);
  });

  /**
   * The cell goes back to showing what the server last said. What removes the
   * item is the client's prediction arriving through `setContainers`, like every
   * other change here -- this screen never edits itself.
   */
  it('leaves the cell holding what it was handed until it is told otherwise', () => {
    const test = harness();
    clickCell(test, { container: 'inventory', index: 0 });
    expect(test.screen.cellAt({ container: 'inventory', index: 0 })?.item).toBeNull();
    test.screen.dropCarried();
    expect(test.screen.cellAt({ container: 'inventory', index: 0 })?.item?.defId).toBe('sword');
  });
});

/**
 * A cell takes a *family*, not a slot name (spec 188).
 *
 * The bug this covers made the whole skill feature unreachable: a sigil says
 * `slot: 'skill'` and a cell said `acceptsSlot: 'skill1'`, so the drop was
 * refused by the screen while `applyMove` on the server would have taken it.
 * Nothing lit up and nothing said why, because an unlit cell *is* the refusal.
 */
describe('what a skill cell will take', () => {
  it('accepts a sigil in any of the four slots', () => {
    const screen = new InventoryScreen({ theme: THEME });
    screen.setContainers(viewOf());
    const sigil = item('sigil.guardBreak', 'skill');
    for (let i = 0; i < SKILL_SLOTS.length; i++) {
      const cell = screen.cellAt({ container: 'equipment', index: SLOTS.length + i });
      expect(cell, `slot ${i}`).toBeTruthy();
      expect(
        cell?.canAcceptDrop({
          source: cell,
          data: { from: { container: 'inventory', index: 0 }, item: sigil, count: 1 },
        }),
        `slot ${i}`,
      ).toBe(true);
    }
  });

  it('still refuses a sword in a skill slot', () => {
    const screen = new InventoryScreen({ theme: THEME });
    screen.setContainers(viewOf());
    const cell = screen.cellAt({ container: 'equipment', index: SLOTS.length });
    expect(
      cell?.canAcceptDrop({
        source: cell,
        data: { from: { container: 'inventory', index: 0 }, item: item('sword.worn', 'mainHand'), count: 1 },
      }),
    ).toBe(false);
  });

  it('still refuses a sigil in the main hand', () => {
    const screen = new InventoryScreen({ theme: THEME });
    screen.setContainers(viewOf());
    const cell = screen.cellAt({ container: 'equipment', index: 0 });
    expect(
      cell?.canAcceptDrop({
        source: cell,
        data: { from: { container: 'inventory', index: 0 }, item: item('sigil.guardBreak', 'skill'), count: 1 },
      }),
    ).toBe(false);
  });
});

/**
 * The purse, under the bag (spec 269).
 *
 * Coins ride the `Inventory` message beside the stacks, so the window that says
 * what you have is the window that says what you have -- and before this the
 * number was drawn in exactly one place in the whole interface, the shop's own
 * line.
 */
describe('the purse', () => {
  function purseText(screen: InventoryScreen): string[] {
    return [...screen.walk()]
      .map((widget) => (widget as unknown as { text?: string }).text)
      .filter((text): text is string => typeof text === 'string')
      .filter((text) => text.endsWith('coins'));
  }

  it('says what the bag is carrying', () => {
    const test = harness();
    test.screen.setContainers(viewOf({ coins: 137 }));
    expect(purseText(test.screen)).toEqual(['137 coins']);
  });

  /** An omitted line reads as a missing feature where `0 coins` is a fact. */
  it('says nothing left rather than nothing at all', () => {
    const test = harness();
    test.screen.setContainers(viewOf({ coins: 0 }));
    expect(purseText(test.screen)).toEqual(['0 coins']);
  });
});

/**
 * Dragging, alongside the click (spec 282).
 *
 * Driven through `UiRoot.handle` rather than by calling `dragCell` directly,
 * which is the point of this block: every other test here builds a synthetic
 * `click` and hands it over, so nothing in the tree has ever exercised the
 * router's own `dragStart`/`drag`/`dragEnd` derivation against a bag cell --
 * which is exactly the path that was dead.
 */
describe('dragging an item', () => {
  const at = (test: Harness, ref: Ref): { x: number; y: number } => {
    const cell = test.screen.cellAt(ref);
    if (!cell) throw new Error('no such cell');
    return {
      x: cell.rect.x + Math.floor(cell.rect.width / 2),
      y: cell.rect.y + Math.floor(cell.rect.height / 2),
    };
  };

  const press = (
    test: Harness,
    pos: { x: number; y: number },
    phase: 'down' | 'move' | 'up',
    time: number,
    button = 0,
    mods: Modifiers = NO_MODIFIERS,
  ): void => {
    test.root.handle({ kind: 'pointer', phase, pos, button, mods, time });
  };

  /** Press on `from`, travel well past the threshold, release over `to`. */
  function dragBetween(
    test: Harness,
    from: Ref,
    to: { x: number; y: number } | Ref,
    button = 0,
    mods: Modifiers = NO_MODIFIERS,
  ): void {
    const end = 'container' in to ? at(test, to) : to;
    press(test, at(test, from), 'down', 0, button, mods);
    press(test, end, 'move', 10, button, mods);
    press(test, end, 'up', 20, button, mods);
  }

  it('moves a stack to the cell it was let go over, not the one it was pressed on', () => {
    const test = harness();
    dragBetween(test, inv(0), inv(5));
    expect(test.moves).toEqual([{ from: inv(0), to: inv(5), count: 0 }]);
    expect(test.screen.drag.active).toBeNull();
  });

  /** The rule every gesture on this screen shares: the server moves things. */
  it('does not move the item itself', () => {
    const test = harness();
    dragBetween(test, inv(0), inv(5));
    expect(test.screen.cellAt(inv(0))?.item?.defId).toBe('sword');
    expect(test.screen.cellAt(inv(5))?.item).toBeNull();
  });

  it('carries the count the press asked for, and says so on the ghost', () => {
    const half = harness();
    press(half, at(half, inv(1)), 'down', 0, 2);
    press(half, { x: at(half, inv(1)).x + 40, y: at(half, inv(1)).y }, 'move', 10, 2);
    expect(half.screen.ghost.count).toBe(3);

    const test = harness();
    dragBetween(test, inv(1), inv(5), 2);
    expect(test.moves).toEqual([{ from: inv(1), to: inv(5), count: 3 }]);
  });

  it('takes one with shift and the right button', () => {
    const test = harness();
    dragBetween(test, inv(1), inv(5), 2, { ...NO_MODIFIERS, shift: true });
    expect(test.moves).toEqual([{ from: inv(1), to: inv(5), count: 1 }]);
  });

  /**
   * The unsteady click spec 137 was written about, and it needs no branch: the
   * source cell refuses a drop from itself, so nothing takes it and the hand
   * keeps it -- which is what a clean click would have left.
   */
  it('leaves a wobbled press carrying, exactly as a click would', () => {
    const wobbled = harness();
    const pos = at(wobbled, inv(0));
    press(wobbled, pos, 'down', 0);
    press(wobbled, { x: pos.x + 4, y: pos.y + 1 }, 'move', 5);
    press(wobbled, { x: pos.x + 4, y: pos.y + 1 }, 'up', 10);

    const clicked = harness();
    clickCell(clicked, inv(0));

    for (const test of [wobbled, clicked]) {
      expect(test.moves).toEqual([]);
      expect(test.screen.drag.active).not.toBeNull();
      expect(test.screen.ghost.item?.defId).toBe('sword');
      // The cell it came from draws empty, because this screen emptied it.
      expect(test.screen.cellAt(inv(0))?.item).toBeNull();
    }
  });

  /**
   * A release nobody takes hands over to the click model rather than undoing
   * the carry -- which is the whole of "both gestures, one hand".
   */
  it('keeps the item in hand when it is let go over nothing', () => {
    const test = harness();
    dragBetween(test, inv(0), { x: 398, y: 298 });
    expect(test.moves).toEqual([]);
    expect(test.screen.drag.active).not.toBeNull();
    // And the click model finishes it.
    clickCell(test, inv(5));
    expect(test.moves).toEqual([{ from: inv(0), to: inv(5), count: 0 }]);
  });

  it('keeps it in hand over a cell that refuses it, and lights nothing', () => {
    const test = harness();
    dragBetween(test, inv(0), worn(2)); // a sword over the head slot
    expect(test.moves).toEqual([]);
    expect(test.screen.drag.active).not.toBeNull();
    expect(test.screen.equipmentSlots.filter((cell) => cell.dropCandidate)).toEqual([]);
  });

  it('equips onto the slot the item names', () => {
    const test = harness();
    dragBetween(test, inv(0), worn(0));
    expect(test.moves).toEqual([{ from: inv(0), to: worn(0), count: 0 }]);
  });

  /**
   * Equipping is not a pick-up, so it has no carry to drag: the drag declines
   * and the release falls back to the click, which wears it.
   */
  it('still equips on an unsteady shift and left button', () => {
    const test = harness();
    dragBetween(test, inv(0), inv(0), 0, { ...NO_MODIFIERS, shift: true });
    expect(test.moves).toEqual([{ from: inv(0), to: worn(0), count: 0 }]);
    expect(test.screen.drag.active).toBeNull();
  });

  it('lights the cell under the cursor while the drag is in flight', () => {
    const test = harness();
    press(test, at(test, inv(0)), 'down', 0);
    press(test, at(test, inv(5)), 'move', 10);
    const target = test.screen.cellAt(inv(5));
    expect(target?.dropCandidate).toBe(true);
    expect(test.screen.bagSlots.filter((cell) => cell.dropCandidate)).toEqual([target]);
  });

  it('is cancelled by Escape, which is the carry cancelled by Escape', () => {
    const test = harness();
    press(test, at(test, inv(0)), 'down', 0);
    press(test, at(test, inv(5)), 'move', 10);
    expect(test.screen.cancelDrag()).toBe(true);
    expect(test.screen.drag.active).toBeNull();
    expect(test.screen.cellAt(inv(0))?.item?.defId).toBe('sword');
  });

  /** A drag begun with something already in hand places where it is let go. */
  it('places a carried stack on the cell the release landed on', () => {
    const test = harness();
    clickCell(test, inv(0));
    dragBetween(test, inv(3), inv(7));
    expect(test.moves).toEqual([{ from: inv(0), to: inv(7), count: 0 }]);
  });
});
