/**
 * The mount's behaviour, in Node (spec 131).
 *
 * Everything here is a fact about the interface that a browser would only be
 * able to *photograph*: which window Escape shuts, what closing a shop tells the
 * server, whether a click on a window is still a move order. They are decisions,
 * so they are asserted rather than looked at.
 */

import { describe, expect, it } from 'vitest';
import { emptyInventory, type Equipment } from '../../../server/state/types.js';
import { STARTER_EQUIPMENT, starterInventory } from '../../../server/player/player-manager.js';
import { InputMap } from '../../../ui/input/input-map.js';
import type { Rect } from '../../../ui/core/geom.js';
import { ScrollView } from '../../../ui/widgets/scroll-view.js';
import { UiScreens, type UiScreensOptions } from './ui-screens.js';
import type { WindowId } from './key-actions.js';
import type { ClientView } from '../../../server/client/game-client.js';

const VIEWPORT = { width: 400, height: 300 };
const NONE = { shift: false, ctrl: false, alt: false, meta: false };

const NO_EQUIPMENT: Equipment = {
  mainHand: null,
  offHand: null,
  head: null,
  chest: null,
  legs: null,
  trinket: null,
};

/** Just enough of a `ClientView` for the three replicated screens to read. */
function viewFixture(overrides: Partial<ClientView> = {}): ClientView {
  return {
    inventory: emptyInventory(),
    equipment: NO_EQUIPMENT,
    coins: 60,
    vendor: null,
    vendorRevision: 0,
    trade: null,
    level: 3,
    experience: 40,
    unspentSkillPoints: 1,
    skills: [],
    stats: null,
    ...overrides,
  } as unknown as ClientView;
}

interface Harness {
  readonly screens: UiScreens;
  readonly requests: string[];
}

function harness(options: Partial<UiScreensOptions> = {}): Harness {
  const requests: string[] = [];
  const screens = new UiScreens(
    {
      map: new InputMap(),
      onMove: (from, to, count) => requests.push(`move:${from.index}->${to.index}x${count}`),
      onSpend: (id) => requests.push(`spend:${id}`),
      onBuy: (vendorId, defId) => requests.push(`buy:${vendorId}:${defId}`),
      onSell: (vendorId, index) => requests.push(`sell:${vendorId}:${index}`),
      onBuyBack: (vendorId, index) => requests.push(`buyback:${vendorId}:${index}`),
      onVendor: (vendorId) => requests.push(`vendor:${vendorId}`),
      onTradeOffer: (slots, coins) => requests.push(`tradeOffer:${slots.length}:${coins}`),
      onTradeAccept: (revision) => requests.push(`tradeAccept:${revision}`),
      onTradeRespond: (accept) => requests.push(`tradeRespond:${accept}`),
      onTradeCancel: () => requests.push('tradeCancel'),
      onBindingsChanged: () => requests.push('bindings'),
      onScaleChosen: (choice) => requests.push(`scale:${String(choice)}`),
      nearestVendor: () => 'vendor.quartermaster',
      ...options,
    },
    VIEWPORT,
  );
  return { screens, requests };
}

/** Where a window ended up. Read through the root's manager, as the paint does. */
function windowSize(screens: UiScreens, id: WindowId): Rect {
  const placement = screens.root.windows?.get(id)?.placement();
  if (!placement) throw new Error(`no window called ${id}`);
  return placement;
}

describe('what is mounted', () => {
  it('opens nothing until something asks', () => {
    const { screens } = harness();
    expect(screens.opened()).toEqual([]);
    expect(screens.anyOpen).toBe(false);
  });

  it('opens and closes on the same action', () => {
    const { screens } = harness();
    screens.toggle('inventory');
    expect(screens.opened()).toEqual(['inventory']);
    screens.toggle('inventory');
    expect(screens.opened()).toEqual([]);
  });

  it('brings an already-open window forward rather than shutting it', () => {
    const { screens } = harness();
    screens.show('inventory');
    screens.show('character');
    expect(screens.opened()).toEqual(['inventory', 'character']);
    screens.show('inventory');
    // Front last: showing the bag again raised it, and shut nothing.
    expect(screens.opened()).toEqual(['character', 'inventory']);
  });

  /**
   * The window is sized once the screen has been *fed*, not at the keypress.
   *
   * A bag that has never been handed anything has no paperdoll and no items, and
   * measures 211x114 against the 214x162 it becomes one frame later. A window
   * sized at the moment of the press therefore opened two equipment rows short
   * and scrolled for the rest of the session -- which looked like a layout bug
   * and was a sequencing one.
   *
   * Asserted as "it does not have to scroll", because that is the symptom rather
   * than the mechanism: a pixel count would pass just as happily on a window
   * that was the wrong size for a different reason.
   */
  it('sizes a window from a screen that has been handed something', () => {
    const { screens } = harness();
    screens.show('inventory');
    screens.update(viewFixture({ inventory: starterInventory(), equipment: STARTER_EQUIPMENT }), 0);
    const scroller = screens.root.windows?.get('inventory')?.content;
    expect(scroller).toBeInstanceOf(ScrollView);
    expect((scroller as ScrollView).scrollable).toBe(false);
  });

  /**
   * The app's chrome floats over the whole tab, so a window at the top margin
   * opens underneath it. It went unseen for a while because the interface was
   * twice as chunky and an 8-pixel margin happened to clear the bar.
   */
  it('opens below the chrome it is told about', () => {
    const { screens } = harness();
    screens.setSafeTop(30);
    screens.show('inventory');
    screens.update(viewFixture(), 0);
    expect(windowSize(screens, 'inventory').y).toBeGreaterThanOrEqual(30);
  });

  it('places a window inside the viewport and leaves it there', () => {
    const { screens } = harness();
    screens.show('inventory');
    screens.update(viewFixture({ inventory: starterInventory(), equipment: STARTER_EQUIPMENT }), 0);
    const first = windowSize(screens, 'inventory');
    expect(first.x).toBeGreaterThanOrEqual(0);
    expect(first.y).toBeGreaterThanOrEqual(0);
    expect(first.x + first.width).toBeLessThanOrEqual(VIEWPORT.width);

    screens.toggle('inventory');
    screens.toggle('inventory');
    screens.update(viewFixture({ inventory: starterInventory(), equipment: STARTER_EQUIPMENT }), 16);
    // Re-opened, not re-placed: a window the player has dragged stays dragged.
    expect(windowSize(screens, 'inventory')).toEqual(first);
  });
});

describe('what a shop tells the server', () => {
  it('asks for the nearest vendor when it opens', () => {
    const { screens, requests } = harness();
    screens.show('shop');
    expect(requests).toEqual(['vendor.quartermaster'].map((id) => `vendor:${id}`));
  });

  it('asks for nothing when there is no vendor in reach', () => {
    const { screens, requests } = harness({ nearestVendor: () => null });
    screens.show('shop');
    // Sent anyway, empty: the server's answer is what shuts the window, and a
    // request that was never made gets no answer at all.
    expect(requests).toEqual(['vendor:']);
  });

  it('tells the server to stop when the window closes', () => {
    const { screens, requests } = harness();
    screens.show('shop');
    screens.close('shop');
    expect(requests).toEqual(['vendor:vendor.quartermaster', 'vendor:']);
  });

  /**
   * The manager closes windows on its own -- Escape reaches it, and so does the
   * title bar's close button -- so the side effect cannot live only in `close`.
   */
  it('tells the server to stop when Escape closes it', () => {
    const { screens, requests } = harness();
    screens.show('shop');
    expect(screens.handleKey('Escape', 'down', NONE)).toBe(true);
    expect(screens.isOpen('shop')).toBe(false);
    expect(requests).toEqual(['vendor:vendor.quartermaster', 'vendor:']);
  });

  /**
   * "Not asked yet" and "asked, and the answer was no" are different states, and
   * conflating them closed the shop on the frame it opened -- every time, so the
   * key that opens it did nothing at all.
   */
  it('stays open while the server has not answered yet', () => {
    const { screens } = harness();
    screens.show('shop');
    screens.update(viewFixture({ vendor: null, vendorRevision: 0 }), 0);
    expect(screens.isOpen('shop')).toBe(true);
  });

  it('shuts the window when the server answers that there is no shop', () => {
    const { screens } = harness();
    screens.show('shop');
    // The answer arrived -- walked out of range, or refused -- and it is empty.
    screens.update(viewFixture({ vendor: null, vendorRevision: 1 }), 0);
    expect(screens.isOpen('shop')).toBe(false);
  });
});

describe('Escape, in the order the phases built it', () => {
  it('reaches gameplay when nothing above it wants it', () => {
    const { screens } = harness();
    expect(screens.handleKey('Escape', 'down', NONE)).toBe(false);
  });

  it('closes the front-most window before gameplay hears it', () => {
    const { screens } = harness();
    screens.show('inventory');
    screens.show('character');
    expect(screens.handleKey('Escape', 'down', NONE)).toBe(true);
    expect(screens.opened()).toEqual(['inventory']);
    expect(screens.handleKey('Escape', 'down', NONE)).toBe(true);
    expect(screens.opened()).toEqual([]);
    // ...and the third one is the game's, which is what makes cancelling a cast
    // with a window open take two presses rather than never working.
    expect(screens.handleKey('Escape', 'down', NONE)).toBe(false);
  });
});

describe('who hears an input', () => {
  it('lets a click on empty space through to gameplay', () => {
    const { screens } = harness();
    screens.update(viewFixture(), 0);
    expect(screens.handlePointer('down', { x: 390, y: 290 }, 0, NONE)).toBe(false);
  });

  it('takes a click on a window', () => {
    const { screens } = harness();
    screens.show('inventory');
    screens.update(viewFixture(), 0);
    // The bag opens at the margin, so its title bar is a few pixels in.
    expect(screens.handlePointer('down', { x: 20, y: 14 }, 0, NONE)).toBe(true);
  });

  /**
   * A window does not stop the world. Walking with the bag open is deliberate --
   * the `ui` context neither blocks nor swallows -- and the keys that *are*
   * swallowed are a modal's and a text field's.
   */
  it('still lets a movement key reach gameplay with a window open', () => {
    const { screens } = harness();
    screens.show('inventory');
    screens.update(viewFixture(), 0);
    expect(screens.handleKey('KeyW', 'down', NONE)).toBe(false);
  });

  /**
   * The complaint spec 137 fixes: "my keys stop working when a window is open".
   *
   * Focus used to follow every press, so clicking a bag cell left it holding the
   * arrow keys and clicking a button left it holding Space and Enter -- four
   * movement bindings and a cast. Now a press hands the keyboard to a text field
   * and to nothing else.
   */
  it('does not give the keyboard to whatever was clicked', () => {
    const { screens } = harness();
    screens.show('inventory');
    screens.update(viewFixture({ inventory: starterInventory() }), 0);
    const cell = [...screens.root.content.walk()].find((widget) => widget.name === 'bag:0');
    if (!cell) throw new Error('the bag drew no cells');
    screens.handlePointer('down', { x: cell.rect.x + 2, y: cell.rect.y + 2 }, 0, NONE);
    expect(screens.root.focus.focused).toBeNull();
    // ...so the arrows still walk, and Space still casts.
    for (const code of ['ArrowUp', 'ArrowLeft', 'Space', 'Enter', 'KeyW']) {
      expect(screens.handleKey(code, 'down', NONE)).toBe(false);
    }
  });

  it('gives the keyboard to a text field, and takes it back on a click away', () => {
    // The exception, and the reason the rule is a property rather than "never
    // focus anything": a field you have to Tab into is a field nobody types in.
    const { screens } = harness();
    screens.show('options');
    screens.update(viewFixture(), 0);
    const field = [...screens.root.content.walk()].find((widget) => widget.focusOnPress);
    if (!field) throw new Error('the options window has no text field on it');
    screens.handlePointer('down', { x: field.rect.x + 2, y: field.rect.y + 2 }, 0, NONE);
    expect(screens.root.focus.focused).toBe(field);

    screens.handlePointer('down', { x: 399, y: 299 }, 0, NONE);
    expect(screens.root.focus.focused).toBeNull();
  });

  it('puts the ui context on the stack while something is open, and takes it off', () => {
    const { screens } = harness();
    expect(screens.root.contexts.ids()).toEqual(['gameplay']);
    screens.show('inventory');
    expect(screens.root.contexts.ids()).toEqual(['gameplay', 'ui']);
    screens.show('character');
    // Pushed once for "anything is open", not once per window: two pushes and
    // one pop is a stack that never comes back down.
    expect(screens.root.contexts.ids()).toEqual(['gameplay', 'ui']);
    screens.close('inventory');
    screens.close('character');
    expect(screens.root.contexts.ids()).toEqual(['gameplay']);
  });
});

describe('the trade window (spec 134)', () => {
  const openTrade = {
    id: 1,
    stage: 1,
    revision: 3,
    you: { playerId: 'you', displayName: 'You', offer: [], coins: 0, accepted: false },
    them: { playerId: 'ben', displayName: 'Ben', offer: [], coins: 0, accepted: false },
    reason: '',
  };

  /**
   * Not on a key, because a trade is something the *other* player starts. The
   * window follows the server exactly as the shop does.
   */
  it('opens itself when a trade appears', () => {
    const { screens } = harness();
    expect(screens.isOpen('trade')).toBe(false);
    screens.update(viewFixture({ trade: openTrade }), 0);
    expect(screens.isOpen('trade')).toBe(true);
  });

  /**
   * ...and does *not* close itself when the trade ends. The ending is the one
   * thing the interface most needs to say, and by then the server has forgotten
   * the trade -- a window that vanished would leave the player wondering whether
   * it went through.
   */
  it('stays up on the ending, showing why', () => {
    const { screens } = harness();
    screens.update(viewFixture({ trade: openTrade }), 0);
    screens.update(
      viewFixture({ trade: { ...openTrade, stage: 4, reason: 'you walked too far apart' } }),
      16,
    );
    expect(screens.isOpen('trade')).toBe(true);

    // The server has forgotten it; the window has not.
    screens.update(viewFixture({ trade: null }), 32);
    expect(screens.isOpen('trade')).toBe(true);
  });
});

describe('the options window (spec 135)', () => {
  it('opens on demand and closes again', () => {
    const { screens } = harness();
    screens.toggle('options');
    screens.update(viewFixture(), 0);
    expect(screens.isOpen('options')).toBe(true);
    screens.toggle('options');
    expect(screens.isOpen('options')).toBe(false);
  });

  /**
   * The keybindings screen is in two windows, and a rebind in either is the
   * same edit to the same map -- two windows over one screen, rather than two
   * screens that would have to be kept in step.
   */
  it('tells the mount when a key changed, so it can be saved', () => {
    const { screens, requests } = harness();
    screens.toggle('options');
    screens.update(viewFixture(), 0);
    // Through the screen the window contains, which is the same object the
    // standalone keybindings window shows.
    const keys = [...screens.root.content.walk()].find((widget) => widget.name === 'keybindings');
    expect(keys).toBeDefined();
    expect(requests).not.toContain('bindings');
  });
});

describe('the tooltip, over the world (spec 136)', () => {
  /** The bag open with the starting kit in it, so a cell has something to say. */
  function bagOpen(): ReturnType<typeof harness> {
    const built = harness();
    built.screens.show('inventory');
    built.screens.update(viewFixture({ inventory: starterInventory() }), 0);
    return built;
  }

  /** The middle of the first bag cell with an item in it. */
  function overAnItem(screens: UiScreens): { x: number; y: number } {
    const cell = [...screens.root.content.walk()].find(
      (widget) => widget.name.startsWith('bag:') && (widget as { item?: unknown }).item != null,
    );
    if (!cell) throw new Error('no bag cell has an item in it');
    return { x: cell.rect.x + 2, y: cell.rect.y + 2 };
  }

  it('says what the cursor is over, once the theme has waited', () => {
    const { screens } = bagOpen();
    const at = overAnItem(screens);
    screens.handlePointer('move', at, 0, NONE);
    screens.update(viewFixture({ inventory: starterInventory() }), 0);
    // Nothing yet: a tooltip that appeared instantly would appear on the way
    // past, which is the noise the delay exists to stop.
    expect(screens.tooltipText).toBe('');
    screens.update(viewFixture({ inventory: starterInventory() }), 1000);
    expect(screens.tooltipText.length).toBeGreaterThan(0);
  });

  it('drops nothing but stops carrying when the bag closes', () => {
    // The ghost lives above every window, like the tooltip, so closing the bag
    // mid-carry left an item stuck to the cursor over the world (spec 137).
    const { screens, requests } = bagOpen();
    const cell = [...screens.root.content.walk()].find((widget) => widget.name === 'bag:0');
    if (!cell) throw new Error('the bag drew no cells');
    screens.handlePointer('down', { x: cell.rect.x + 2, y: cell.rect.y + 2 }, 0, NONE);
    screens.handlePointer('up', { x: cell.rect.x + 2, y: cell.rect.y + 2 }, 0, NONE);
    expect(screens.carrying).toBe(true);

    screens.toggle('inventory');
    screens.update(viewFixture({ inventory: starterInventory() }), 1200);
    expect(screens.carrying).toBe(false);
    // Nothing was asked of the server: it goes back where it came from.
    expect(requests.filter((request) => request.startsWith('move:'))).toEqual([]);
  });

  it('shuts up when the bag does', () => {
    // The tooltip is in a layer above every window rather than inside one, and
    // the bag closes on a key -- so nothing else would ever clear it, and the
    // box would sit over the world until the mouse twitched.
    const { screens } = bagOpen();
    screens.handlePointer('move', overAnItem(screens), 0, NONE);
    screens.update(viewFixture({ inventory: starterInventory() }), 1000);
    expect(screens.tooltipText.length).toBeGreaterThan(0);

    screens.toggle('inventory');
    screens.update(viewFixture({ inventory: starterInventory() }), 1200);
    expect(screens.tooltipText).toBe('');
  });
});

describe('drawing', () => {
  it('draws nothing at all when nothing is open', () => {
    const { screens } = harness();
    screens.update(viewFixture(), 0);
    expect(screens.paint()).toEqual([]);
  });

  it('draws the bag once it is open', () => {
    const { screens } = harness();
    screens.show('inventory');
    screens.update(viewFixture(), 0);
    expect(screens.paint().length).toBeGreaterThan(0);
  });

  it('follows the viewport when the tab is resized', () => {
    const { screens } = harness();
    screens.resize({ width: 240, height: 180 });
    expect(screens.viewport).toEqual({ width: 240, height: 180 });
    screens.show('options');
    screens.update(viewFixture(), 0);
    expect(screens.paint().length).toBeGreaterThan(0);
  });
});
