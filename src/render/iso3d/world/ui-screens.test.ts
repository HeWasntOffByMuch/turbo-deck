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
import { CHARACTER_MIN_SIZE, UiScreens, WINDOW_CHROME, type UiScreensOptions } from './ui-screens.js';
import { CharacterScreen } from '../../../ui/screens/character.js';
import { captureLayout, LAYOUT_VERSION, type StoredLayout } from '../../../ui/core/layout-store.js';
import type { WindowId } from './control-actions.js';
import type { ClientView } from '../../../server/client/game-client.js';
import { EntityKind } from '../../../server/net/protocol.js';
import { startingBaseStats } from '../../../server/player/attributes.js';
import { NEUTRAL_TRAITS } from '../../../server/player/derived.js';
import { NO_ATTACK_SPEED } from '../../../server/sim/attack-timing.js';
import { NO_WEAPON } from '../../../server/data/weapon-scaling.js';
import type { EffectiveStats } from '../../../server/state/types.js';
import { visualFor } from '../../../server/data/status-visuals.js';
import { StatusId } from '../../../server/sim/statuses.js';

/** The wire index for a status id, so a test reads by name rather than by number. */
function wireOf(id: string): number {
  const visual = visualFor(id);
  if (!visual) throw new Error(`no visible row for ${id}`);
  return visual.wire;
}

const VIEWPORT = { width: 400, height: 300 };
const NONE = { shift: false, ctrl: false, alt: false, meta: false };

const NO_EQUIPMENT: Equipment = {
  mainHand: null,
  offHand: null,
  head: null,
  chest: null,
  legs: null,
  trinket: null,
  skill1: null,
  skill2: null,
  skill3: null,
  skill4: null,
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
    endedTrade: null,
    level: 3,
    experience: 40,
    specializations: [],
    stats: null,
    ...overrides,
  } as unknown as ClientView;
}

interface Harness {
  readonly screens: UiScreens;
  readonly requests: string[];
  /** Every layout the mount asked to have written, in order. */
  readonly saved: StoredLayout[];
}

function harness(options: Partial<UiScreensOptions> = {}, viewport = VIEWPORT): Harness {
  const requests: string[] = [];
  const hovers: (string | null)[] = [];
  const saved: StoredLayout[] = [];
  const screens = new UiScreens(
    {
      map: new InputMap(),
      onMove: (from, to, count) => requests.push(`move:${from.index}->${to.index}x${count}`),
      onDropItem: (at, count) => requests.push(`drop:${at.container}${at.index}x${count}`),
      onSpend: (id) => requests.push(`spend:${id}`),
      onAdvance: (key) => requests.push(`allocate:${key}`),
      onRespec: () => requests.push('respec'),
      onBuy: (vendorId, defId) => requests.push(`buy:${vendorId}:${defId}`),
      onSell: (vendorId, index) => requests.push(`sell:${vendorId}:${index}`),
      onBuyBack: (vendorId, index) => requests.push(`buyback:${vendorId}:${index}`),
      onVendor: (vendorId) => requests.push(`vendor:${vendorId}`),
      onTradeOffer: (slots, coins) => requests.push(`tradeOffer:${slots.length}:${coins}`),
      onTradeAccept: (revision) => requests.push(`tradeAccept:${revision}`),
      onTradeRespond: (accept) => requests.push(`tradeRespond:${accept}`),
      onTradeCancel: () => requests.push('tradeCancel'),
      onTradeDismiss: () => requests.push('tradeDismiss'),
      onCastSlot: (abilityId: string) => requests.push(`cast:${abilityId}`),
      // A hover is presentation, so it is recorded apart from `requests` here
      // for the reason `mount-presentation.test.ts` states at length (spec 235).
      onHoverSlot: (abilityId) => hovers.push(abilityId),
      onSay: (text: string) => requests.push(`say:${text}`),
      onBindingsChanged: () => requests.push('bindings'),
      onScaleChosen: (choice) => requests.push(`scale:${String(choice)}`),
      onShowFpsChosen: (show) => requests.push(`showFps:${String(show)}`),
      onMaxZoomChosen: (choice) => requests.push(`maxZoom:${String(choice)}`),
      onLayoutChanged: (layout) => {
        saved.push(layout);
        requests.push('layout');
      },
      nearestVendor: () => 'vendor.quartermaster',
      ...options,
    },
    viewport,
  );
  return { screens, requests, saved };
}

/** Where a window ended up. Read through the root's manager, as the paint does. */
function windowSize(screens: UiScreens, id: WindowId): Rect {
  const placement = screens.root.windows?.get(id)?.placement();
  if (!placement) throw new Error(`no window called ${id}`);
  return placement;
}

describe('the mini HUD (spec 196)', () => {
  function body(overrides: Record<string, unknown> = {}): unknown {
    return {
      id: 4,
      kind: EntityKind.Monster,
      typeId: 'grazer',
      x: 0,
      y: 0,
      z: 0,
      facing: 0,
      health: 30,
      maxHealth: 60,
      activity: 0,
      activityUntilTick: 0,
      level: 2,
      name: '',
      turnRate: 4,
      poise: 1,
      shield: 0,
      shieldUntilTick: 0,
      statuses: [],
      moveScale: 1,
      ...overrides,
    };
  }

  it('shows nothing until something is selected', () => {
    const { screens } = harness();
    screens.update(viewFixture({ entities: [body()] } as Partial<ClientView>), 0);
    expect(screens.readout().selected).toBe('');
    expect(screens.readout().selectedRect).toBeNull();
  });

  it('names the body that was selected', () => {
    const { screens } = harness();
    screens.select(4);
    screens.update(viewFixture({ entities: [body()] } as Partial<ClientView>), 0);
    expect(screens.readout().selected).toBe('Grazer|Lv 2');
    expect(screens.readout().selectedRect).not.toBeNull();
  });

  it('forgets a body that has left the replicated set', () => {
    // Not merely blank: the *id* goes, because entity ids are reused and a
    // selection that outlived its body would come back pointing at a stranger.
    const { screens } = harness();
    screens.select(4);
    screens.update(viewFixture({ entities: [body()] } as Partial<ClientView>), 0);
    screens.update(viewFixture({ entities: [] } as Partial<ClientView>), 16);
    expect(screens.selection).toBeNull();
    expect(screens.readout().selected).toBe('');
  });

  it('lists what is on the body, said the way a player reads it', () => {
    const { screens } = harness();
    screens.select(4);
    const statuses = [{ wire: wireOf(StatusId.Exposed), stacks: 1, expiresAtTick: 200 }];
    screens.update(viewFixture({ entities: [body({ statuses })] } as Partial<ClientView>), 0, 80);
    expect(screens.readout().selectedRows).toEqual(['Exposed|2.0s|affliction']);
  });

  it('clears on a click that named nothing', () => {
    const { screens } = harness();
    screens.select(4);
    screens.update(viewFixture({ entities: [body()] } as Partial<ClientView>), 0);
    screens.select(null);
    screens.update(viewFixture({ entities: [body()] } as Partial<ClientView>), 16);
    expect(screens.readout().selected).toBe('');
  });
});

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
    // Visible, because since spec 189 the chat's own field is in the tree too --
    // in the `hud` layer, which the walk reaches first -- and a closed chat's
    // field is hidden. An invisible widget is one no press can land on and one
    // `FocusManager.focus` refuses outright, so the unfiltered walk finds a
    // field the rest of this test cannot possibly be about.
    //
    // Asked of the whole ancestor chain rather than of the widget's own flag
    // (spec 226). A window closed by `window.visible = false` leaves every
    // field inside it flagged visible, so the account window's login field --
    // registered before the shop's -- was found here by a walk that only
    // checked one flag. The chat's field happens to clear its own, which is why
    // one flag was enough until there was a second window with a field on it.
    const showing = (widget: { visible: boolean; parent: unknown } | null): boolean => {
      for (let node = widget; node !== null; node = node.parent as typeof node) {
        if (!node.visible) return false;
      }
      return true;
    };
    const field = [...screens.root.content.walk()].find((widget) => widget.focusOnPress && showing(widget));
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

/**
 * Putting something down (spec 172).
 *
 * Two facts that only exist at the mount: which press counts as "the world", and
 * that such a press does not also reach gameplay. Everything about what a drop
 * *is* lives in `ui/screens/inventory.test.ts` and over the wire.
 */
describe('a carry let go of over the world', () => {
  function carrying(): ReturnType<typeof harness> {
    const test = harness();
    test.screens.show('inventory');
    test.screens.update(viewFixture({ inventory: starterInventory() }), 0);
    const cell = [...test.screens.root.content.walk()].find((widget) => widget.name === 'bag:0');
    if (!cell) throw new Error('the bag drew no cells');
    const at = { x: cell.rect.x + 2, y: cell.rect.y + 2 };
    test.screens.handlePointer('down', at, 0, NONE);
    test.screens.handlePointer('up', at, 0, NONE);
    if (!test.screens.carrying) throw new Error('nothing was picked up');
    return test;
  }

  it('asks the server to put it down, and keeps the press from gameplay', () => {
    const test = carrying();
    // Bottom-right of a 400x300 viewport with the bag at the top-left margin:
    // nothing in the interface is there.
    expect(test.screens.handlePointer('down', { x: 390, y: 290 }, 0, NONE)).toBe(true);
    expect(test.requests.filter((r) => r.startsWith('drop:'))).toEqual(['drop:inventory0x0']);
    expect(test.screens.carrying).toBe(false);
  });

  /**
   * The empty half of a window is not the world. Releasing over it has always
   * meant "keep hold of it", and turning that into a discard would make the one
   * gesture on this screen that destroys something the easiest one to do by
   * accident.
   */
  it('keeps hold of it when the press lands on a window', () => {
    const test = carrying();
    expect(test.screens.handlePointer('down', { x: 20, y: 14 }, 0, NONE)).toBe(true);
    expect(test.requests.filter((r) => r.startsWith('drop:'))).toEqual([]);
    expect(test.screens.carrying).toBe(true);
  });

  it('leaves a press with empty hands to the world', () => {
    const test = harness();
    test.screens.show('inventory');
    test.screens.update(viewFixture({ inventory: starterInventory() }), 0);
    expect(test.screens.handlePointer('down', { x: 390, y: 290 }, 0, NONE)).toBe(false);
    expect(test.requests.filter((r) => r.startsWith('drop:'))).toEqual([]);
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
    invited: false,
    warning: '',
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

  /** How an ending actually reaches the mount: `trade` null, `endedTrade` set. */
  const endedTrade = { ...openTrade, stage: 4, reason: 'you walked too far apart' };

  /**
   * ...and does *not* close itself when the trade ends. The ending is the one
   * thing the interface most needs to say, and by then the server has forgotten
   * the trade -- a window that vanished would leave the player wondering whether
   * it went through.
   *
   * The shape matters more than the assertion here. An ended trade never
   * arrives in `view.trade`: the client moves it to `endedTrade` and nulls the
   * live one on the same message, so a test that puts a `cancelled` stage in
   * `trade` is testing a view the client cannot produce. That is what this test
   * used to do, and it passed for two specs against a mount that read only
   * `view.trade` -- so the window froze on the last live frame and the reason
   * was never drawn at all.
   */
  it('stays up on the ending, showing why', () => {
    const { screens } = harness();
    screens.update(viewFixture({ trade: openTrade }), 0);
    screens.update(viewFixture({ trade: null, endedTrade }), 16);
    expect(screens.isOpen('trade')).toBe(true);
    // Open is not enough: a window frozen on the last live frame is also open.
    expect(screens.shownTrade?.stage).toBe('over');
    expect(screens.shownTrade?.reason).toBe('you walked too far apart');

    // And goes on saying it, frame after frame, until it is put away.
    screens.update(viewFixture({ trade: null, endedTrade }), 32);
    expect(screens.isOpen('trade')).toBe(true);
    expect(screens.shownTrade?.stage).toBe('over');
  });

  /**
   * Closing it is what dismisses it, and the mount must say so -- the client is
   * what remembers the ending, so a window closed without telling it is a
   * window the very next frame re-opens.
   */
  it('dismisses the ending when the window is closed', () => {
    const { screens, requests } = harness();
    screens.update(viewFixture({ trade: null, endedTrade }), 0);
    screens.close('trade');
    expect(requests).toContain('tradeDismiss');
    expect(screens.isOpen('trade')).toBe(false);
  });

  /** Escape shuts a window without pressing anything, so it dismisses too. */
  it('dismisses the ending when Escape shuts it', () => {
    const { screens, requests } = harness();
    screens.update(viewFixture({ trade: null, endedTrade }), 0);
    expect(screens.handleKey('Escape', 'down', NONE)).toBe(true);
    expect(screens.isOpen('trade')).toBe(false);
    expect(requests).toContain('tradeDismiss');
  });

  /** Once dismissed, the client stops sending it -- and it stays shut. */
  it('does not come back once the ending is dismissed', () => {
    const { screens } = harness();
    screens.update(viewFixture({ trade: null, endedTrade }), 0);
    screens.close('trade');
    screens.update(viewFixture({ trade: null, endedTrade: null }), 16);
    expect(screens.isOpen('trade')).toBe(false);
  });

  /**
   * The window has to be big enough for what the trade has *become*.
   *
   * Every other window holds one screen of roughly one size, so `placeWindow`
   * sizes it once. The trade table opens holding an invitation -- two names and
   * a button -- and grows a bag grid, a coin stepper and a second offer panel
   * the moment the invitation is accepted. Sized once, it was sized for the
   * invitation: the Accept button ended up 77 UI pixels below the window's own
   * bottom edge, clipped by the scroll view, and the trade could not be
   * completed without resizing the window by hand. Two tabs found it; nothing
   * in Node could, because nothing measured a button against its window.
   */
  it('grows to fit the table once the invitation is accepted', () => {
    const { screens } = harness({}, { width: 1200, height: 800 });
    // The frame after each update is where placement happens: a window is sized
    // from what its screen wants, and that is not known until it is laid out.
    const settle = (view: ClientView): void => {
      for (let frame = 0; frame < 3; frame += 1) screens.update(view, frame * 16);
    };

    // Through the invitation first, because that is where the bug is born: the
    // window is placed while it holds two names and a button, and the grid
    // arrives afterwards. Straight to `open` and it is sized correctly by
    // accident, which is what made this pass before the fix existed.
    const bag = starterInventory();
    settle(viewFixture({ trade: { ...openTrade, stage: 0 }, inventory: bag }));
    settle(viewFixture({ trade: openTrade, inventory: bag }));
    const open = screens.readout();
    const frame = open.windowRects.find((box) => box.id === 'trade')?.rect;
    const accept = open.tradeRects.find((box) => box.id === 'accept')?.rect;
    expect(frame).toBeDefined();
    expect(accept).toBeDefined();
    if (!frame || !accept) return;

    // Inside the window it belongs to, on both edges. A button below the fold is
    // a button the pointer cannot reach.
    expect(accept.y + accept.height).toBeLessThanOrEqual(frame.y + frame.height);
    expect(accept.x + accept.width).toBeLessThanOrEqual(frame.x + frame.width);
    // ...and the bag it offers from, which is the taller half.
    const lastCell = open.tradeRects.filter((box) => box.id.startsWith('bag:')).at(-1)?.rect;
    expect(lastCell).toBeDefined();
    if (lastCell) expect(lastCell.y + lastCell.height).toBeLessThanOrEqual(frame.y + frame.height);
  });

  /**
   * The window can always be shut (spec 170).
   *
   * The mount re-opens it every frame while a trade is live, so Escape and the
   * title bar did nothing at all and Cancel was the only exit. Closing a live
   * trade means leaving the table, so it cancels -- a window that shut while
   * the trade went on would leave the player in a trade they cannot see and
   * unable to start another.
   */
  it('closes a live trade by leaving the table', () => {
    const { screens, requests } = harness();
    screens.update(viewFixture({ trade: openTrade }), 0);
    expect(screens.isOpen('trade')).toBe(true);

    expect(screens.handleKey('Escape', 'down', NONE)).toBe(true);
    expect(screens.isOpen('trade')).toBe(false);
    expect(requests).toContain('tradeCancel');

    // For the whole round trip the trade is still live and still replicated,
    // and it must not re-open the window the player just shut. This is the case
    // a flag could not hold: re-opening here is also what cleared it.
    for (let frame = 1; frame <= 6; frame += 1) {
      screens.update(viewFixture({ trade: openTrade }), frame * 16);
      expect(screens.isOpen('trade')).toBe(false);
    }

    // ...and then the cancellation arrives as an ending. One action, not two.
    screens.update(viewFixture({ trade: null, endedTrade }), 112);
    expect(screens.isOpen('trade')).toBe(false);
    expect(requests).toContain('tradeDismiss');
  });

  /** ...but the *next* trade's ending is still shown. */
  it('shows the ending of a trade the player did not close', () => {
    const { screens } = harness();
    screens.update(viewFixture({ trade: openTrade }), 0);
    screens.handleKey('Escape', 'down', NONE);
    screens.update(viewFixture({ trade: null, endedTrade }), 16);
    expect(screens.isOpen('trade')).toBe(false);

    // A second trade, ended by somebody else. A new id, because the registry
    // never reuses one -- and it is the id that says which table was left.
    const second = { ...openTrade, id: openTrade.id + 1 };
    screens.update(viewFixture({ trade: second }), 32);
    screens.update(viewFixture({ trade: null, endedTrade: { ...endedTrade, id: second.id } }), 48);
    expect(screens.isOpen('trade')).toBe(true);
    expect(screens.shownTrade?.stage).toBe('over');
  });

  /** A live trade wins over an ending the player has not put away yet. */
  it('shows the live trade rather than a stale ending', () => {
    const { screens } = harness();
    screens.update(viewFixture({ trade: openTrade, endedTrade }), 0);
    expect(screens.isOpen('trade')).toBe(true);
    // Nothing to dismiss: the window is showing a trade that is still running.
    expect(screens.shownTrade?.stage).toBe('open');
    screens.update(viewFixture({ trade: openTrade, endedTrade }), 16);
    expect(screens.isOpen('trade')).toBe(true);
    expect(screens.shownTrade?.stage).toBe('open');
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

  /**
   * Binding a key, the way a player does it (spec 138).
   *
   * Every step through the mount's own doors: a press on the row's button, then
   * a key. It went through *focus* before spec 137 -- the pressed button held
   * the keyboard and the event bubbled up to the screen -- so when a press
   * stopped taking focus, binding a key stopped working entirely and there was
   * no test between the two facts.
   */
  function pressBindButton(screens: UiScreens, actionId: string): void {
    const button = [...screens.root.content.walk()].find(
      (widget) => widget.name === `bind:${actionId}:primary`,
    );
    if (!button) throw new Error(`no bind button for ${actionId}`);
    const at = { x: button.rect.x + 2, y: button.rect.y + 2 };
    screens.handlePointer('down', at, 0, NONE);
    screens.handlePointer('up', at, 0, NONE);
  }

  it('binds the next key pressed after the button', () => {
    const map = new InputMap();
    const { screens, requests } = harness({ map });
    screens.toggle('options');
    screens.update(viewFixture(), 0);

    pressBindButton(screens, 'move.north');
    expect(screens.handleKey('KeyT', 'down', NONE)).toBe(true);

    expect(map.bindingsFor('move.north').primary?.code).toBe('KeyT');
    expect(requests).toContain('bindings');
  });

  it('gives every key back afterwards', () => {
    // The second half of the complaint: after trying to bind, nothing worked.
    // The capture holds `textEntry` while it waits, so a capture that never ends
    // is an interface that swallows the whole keyboard for the rest of the
    // session.
    const { screens } = harness();
    screens.toggle('options');
    screens.update(viewFixture(), 0);

    pressBindButton(screens, 'move.north');
    screens.handleKey('KeyT', 'down', NONE);
    expect(screens.root.contexts.ids()).not.toContain('textEntry');
    expect(screens.handleKey('KeyW', 'down', NONE)).toBe(false);
  });

  it('cancels the capture on Escape rather than closing the window', () => {
    const { screens } = harness();
    screens.toggle('options');
    screens.update(viewFixture(), 0);

    pressBindButton(screens, 'move.north');
    expect(screens.handleKey('Escape', 'down', NONE)).toBe(true);
    // The window it was armed in is still open, and nothing was bound.
    expect(screens.isOpen('options')).toBe(true);
    expect(screens.root.contexts.ids()).not.toContain('textEntry');
    expect(screens.handleKey('KeyW', 'down', NONE)).toBe(false);
  });

  it('cancels a capture the window closed out from under', () => {
    const { screens } = harness();
    screens.toggle('options');
    screens.update(viewFixture(), 0);

    pressBindButton(screens, 'move.north');
    screens.close('options');
    screens.update(viewFixture(), 16);
    expect(screens.root.contexts.ids()).not.toContain('textEntry');
    expect(screens.handleKey('KeyW', 'down', NONE)).toBe(false);
  });

  /**
   * The same path for a mouse button (spec 189).
   *
   * Every step through the mount's own doors again, because the interesting half
   * is the routing rather than the screen: an armed capture has to be offered a
   * press *before* the router gets it, or the press goes to whatever widget is
   * under the cursor and the binding never happens.
   */
  /**
   * A point the interface does not want, found rather than assumed.
   *
   * The window is placed by the mount and moves whenever its content does, so a
   * hard-coded corner is a test that passes until somebody widens a row. The
   * whole claim being made here is about a press the interface would otherwise
   * have let through, so the point has to be one it lets through.
   */
  function overTheWorld(screens: UiScreens): { x: number; y: number } {
    // The options window fills all but an eight-pixel margin of this viewport, so
    // the candidates start in the margin and the middle is only the fallback.
    for (const y of [2, 297, 150]) {
      for (const x of [2, 397, 200]) {
        if (!screens.handlePointer('move', { x, y }, -1, NONE)) return { x, y };
      }
    }
    throw new Error('the interface wanted every candidate point');
  }

  it('binds the next mouse button pressed after the button', () => {
    // `move.north` rather than one of the new rows, and not for convenience: a
    // movement action landing on a mouse button is the claim spec 189 is really
    // making -- an action does not know what pressed it, so the vocabulary is
    // shared in both directions.
    const map = new InputMap();
    const { screens, requests } = harness({ map });
    screens.toggle('options');
    screens.update(viewFixture(), 0);
    const world = overTheWorld(screens);

    pressBindButton(screens, 'move.north');
    // Over the world, which is where a player's next click most likely lands --
    // and the one place a press would otherwise have reached gameplay.
    expect(screens.handlePointer('down', world, 1, NONE)).toBe(true);

    expect(map.bindingsFor('move.north').primary?.code).toBe('MouseMiddle');
    expect(requests).toContain('bindings');
  });

  it('eats the release of the press it bound', () => {
    // The router only emits a click from the widget that took the press, so a
    // press it never saw cannot become one -- but a release it *does* see while
    // the capture is open would still reach whatever is under the cursor.
    const { screens } = harness();
    screens.toggle('options');
    screens.update(viewFixture(), 0);
    const world = overTheWorld(screens);

    pressBindButton(screens, 'move.north');
    expect(screens.handlePointer('down', world, 2, NONE)).toBe(true);
    expect(screens.handlePointer('up', world, 2, NONE)).toBe(false);
    // And the capture is over, so the next press is the world's again.
    expect(screens.root.contexts.ids()).not.toContain('textEntry');
    expect(screens.handlePointer('down', world, 2, NONE)).toBe(false);
  });

  it('lets a move through to the router while it waits', () => {
    // A capture consumes presses and releases and deliberately not moves. Not
    // symmetry: consuming a move means the router never sees it, so hover stops
    // updating -- the tooltip, the carry and every button's pressed look freeze
    // for the length of the capture, which is exactly when a player is moving
    // the cursor around looking at rows.
    //
    // The *return* is true either way and says nothing about this: a capture
    // pushes `textEntry`, which blocks pointer routing to gameplay whatever
    // happens here. What is being asserted is that the event still arrived.
    const { screens } = harness();
    screens.toggle('options');
    screens.update(viewFixture(), 0);

    const secondary = [...screens.root.content.walk()].find(
      (widget) => widget.name === 'bind:move.north:secondary',
    );
    if (!secondary) throw new Error('no secondary bind button');

    pressBindButton(screens, 'move.north');
    screens.handlePointer('move', { x: secondary.rect.x + 2, y: secondary.rect.y + 2 }, -1, NONE);
    expect(screens.root.paintContext().hovered).toBe(secondary);
  });

  it('binds a wheel notch turned at an armed row', () => {
    const map = new InputMap();
    const { screens } = harness({ map });
    screens.toggle('options');
    screens.update(viewFixture(), 0);
    const world = overTheWorld(screens);

    pressBindButton(screens, 'move.north');
    expect(screens.handleWheel(world, -1, NONE)).toBe(true);
    expect(map.bindingsFor('move.north').primary?.code).toBe('WheelDown');
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

  /**
   * The whole chain, end to end (spec 185).
   *
   * Every part of this is asserted somewhere on its own -- the table has the
   * numbers, `detailsFor` turns them into lines, the screen colours them. What
   * only this can say is that they are *connected*: a real bag, through the real
   * mount, reading the real item table, says what the item actually does.
   */
  it('describes the item under the cursor, out of the real table', () => {
    const bag = [...starterInventory()];
    bag[0] = { defId: 'sword.keen', count: 1 };
    const view = viewFixture({ inventory: bag });
    const { screens } = harness();
    screens.show('inventory');
    screens.update(view, 0);

    const cell = [...screens.root.content.walk()].find((widget) => widget.name === 'bag:0');
    if (!cell) throw new Error('the bag drew no cells');
    screens.handlePointer('move', { x: cell.rect.x + 2, y: cell.rect.y + 2 }, 0, NONE);
    screens.update(view, 1000);

    expect(screens.tooltipText.split('\n')).toEqual([
      'Keen Longsword',
      'Rare  Main Hand',
      // What it hits for and what that grows with (specs 216, 217): the range
      // is the row's own, and the scaling line is drawn as three coloured runs
      // and read back here as the whole line it also carries as text.
      '3-6 Damage',
      'B / B / -',
      '+6 Range',
      '+15% Attack Speed',
      'Worth 90 coins',
      // The fixture's character is below the sword's level, and that line is
      // the one thing decided against *who is looking* rather than off the row.
      'Requires level 5',
    ]);
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
  /**
   * With no window open, the only thing on the canvas is the furniture: the
   * action bar, which is always there (spec 196), and the chat, which draws
   * nothing until somebody says something.
   *
   * Asserted as "opening the bag adds to it" rather than as an absolute count,
   * because the count is a fact about how many quads five slots take and would
   * fail on a change to the frame art rather than on a change to what is shown.
   */
  it('draws only the bar when nothing is open', () => {
    const { screens } = harness();
    screens.update(viewFixture(), 0);
    const furniture = screens.paint().length;
    expect(furniture).toBeGreaterThan(0);

    screens.show('inventory');
    screens.update(viewFixture(), 0);
    expect(screens.paint().length).toBeGreaterThan(furniture);
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

/**
 * Where the windows were, across a reload (spec 147).
 *
 * The half that had never been written. `layout-store.ts` has been complete
 * since spec 124 and nothing outside its own test imported it, so every one of
 * its invariants held perfectly while the shipped game opened every window in
 * its default place every session. These are assertions about the *mount* --
 * that the document reaches it, that it is applied at a moment when applying it
 * means something, and that a change to it is written back.
 */
describe('the saved layout', () => {
  /** A document naming one window, at a place the defaults would never pick. */
  function documentFor(id: string, at = { x: 120, y: 96 }, size = { width: 160, height: 128 }): StoredLayout {
    return {
      version: LAYOUT_VERSION,
      order: [id],
      windows: [
        { id, x: at.x, y: at.y, width: size.width, height: size.height, open: false, pinned: false },
      ],
    };
  }

  it('puts a window back where the document says', () => {
    const { screens } = harness({ layout: documentFor('inventory') });
    screens.update(viewFixture(), 0);
    screens.show('inventory');
    screens.update(viewFixture(), 16);
    expect(windowSize(screens, 'inventory')).toEqual({ x: 120, y: 96, width: 160, height: 128 });
  });

  it('does not let the default placement run over a restored window', () => {
    // `placeWindow` measures the screen and picks a corner, once, the first time
    // a window is opened. A restore that did not claim the window would be
    // overwritten by it the moment the player pressed I.
    const { screens } = harness({ layout: documentFor('character', { x: 40, y: 40 }) });
    screens.update(viewFixture(), 0);
    screens.show('character');
    screens.update(viewFixture(), 16);
    expect(windowSize(screens, 'character').x).toBe(40);
    expect(windowSize(screens, 'character').y).toBe(40);
  });

  it('still places a window the document has never heard of', () => {
    // A build that adds a window must not invalidate everybody's saved layout,
    // and the new one still has to be given somewhere to go.
    const { screens } = harness({ layout: documentFor('inventory') });
    screens.update(viewFixture(), 0);
    screens.show('character');
    screens.update(viewFixture(), 16);
    const placement = windowSize(screens, 'character');
    expect(placement.width).toBeGreaterThan(0);
    expect(placement.x + placement.width).toBeLessThanOrEqual(VIEWPORT.width);
  });

  /**
   * The decision the whole feature turns on.
   *
   * `UiLayer` measures its frame before the tab is laid out and gets a 1x1
   * placeholder. `applyLayout` re-clamps against whatever viewport it is handed
   * -- correctly -- so applying against 1x1 stacks every window at the origin at
   * its minimum size, and then writes *that* back as the layout. The saved
   * arrangement would be destroyed by the act of restoring it.
   */
  it('waits for a real viewport rather than restoring against the placeholder', () => {
    const { screens, saved } = harness({ layout: documentFor('inventory') }, { width: 1, height: 1 });
    screens.update(viewFixture(), 0);
    screens.show('inventory');
    screens.update(viewFixture(), 16);
    // Nothing applied, and -- just as important -- nothing written either.
    expect(windowSize(screens, 'inventory')).not.toEqual({ x: 120, y: 96, width: 160, height: 128 });
    expect(saved).toEqual([]);

    screens.resize(VIEWPORT);
    screens.update(viewFixture(), 32);
    expect(windowSize(screens, 'inventory')).toEqual({ x: 120, y: 96, width: 160, height: 128 });
  });

  it('never brings the shop or the trade table back open', () => {
    // Both are opened by the server. A trade window restored open has no trade
    // in it and no way to get one.
    const layout: StoredLayout = {
      version: LAYOUT_VERSION,
      order: ['shop', 'trade', 'inventory'],
      windows: (['shop', 'trade', 'inventory'] as const).map((id) => ({
        id,
        x: 16,
        y: 16,
        width: 120,
        height: 96,
        open: true,
        pinned: false,
      })),
    };
    const { screens } = harness({ layout });
    screens.update(viewFixture(), 0);
    expect(screens.isOpen('shop')).toBe(false);
    expect(screens.isOpen('trade')).toBe(false);
    // ...while a window the player drives does come back.
    expect(screens.isOpen('inventory')).toBe(true);
  });

  it('pulls a layout saved on a big screen back onto a small one', () => {
    const { screens } = harness(
      { layout: documentFor('inventory', { x: 900, y: 700 }, { width: 600, height: 400 }) },
      { width: 320, height: 240 },
    );
    screens.update(viewFixture(), 0);
    const placement = windowSize(screens, 'inventory');
    expect(placement.x).toBeGreaterThanOrEqual(0);
    expect(placement.y).toBeGreaterThanOrEqual(0);
    expect(placement.x + placement.width).toBeLessThanOrEqual(320);
    expect(placement.y + placement.height).toBeLessThanOrEqual(240);
  });

  it('writes nothing while nothing moves', () => {
    const { screens, saved } = harness();
    for (let frame = 0; frame < 8; frame += 1) screens.update(viewFixture(), frame * 1000);
    expect(saved).toEqual([]);
  });

  it('writes once for a burst of changes, carrying the last of them', () => {
    // A trailing debounce: a drag changes the layout on every frame it moves,
    // and the value worth keeping is the one it stops on.
    const { screens, saved } = harness();
    screens.update(viewFixture(), 0);
    screens.show('inventory');

    for (let frame = 1; frame <= 5; frame += 1) {
      screens.root.windows?.get('inventory')?.place({ x: frame * 8, y: 8 }, screens.root.layoutContext(), VIEWPORT);
      screens.update(viewFixture(), frame * 50);
    }
    expect(saved).toEqual([]);

    // ...and 400ms after the last of them, exactly one write.
    screens.update(viewFixture(), 250 + 400);
    expect(saved.length).toBe(1);
    const stored = saved[0]?.windows.find((entry) => entry.id === 'inventory');
    expect(stored?.x).toBe(40);
  });

  it('flushes a pending write on the way out', () => {
    const { screens, saved } = harness();
    screens.update(viewFixture(), 0);
    screens.show('inventory');
    screens.update(viewFixture(), 16);
    expect(saved).toEqual([]);

    screens.flushLayout();
    expect(saved.length).toBe(1);
    // ...and a second flush with nothing pending writes nothing.
    screens.flushLayout();
    expect(saved.length).toBe(1);
  });

  it('round-trips: what is written restores to the same placements', () => {
    const first = harness();
    first.screens.update(viewFixture(), 0);
    first.screens.show('inventory');
    first.screens.show('character');
    first.screens.update(viewFixture(), 16);
    const context = first.screens.root.layoutContext();
    first.screens.root.windows?.get('inventory')?.resize({ width: 200, height: 150 }, context, VIEWPORT);
    first.screens.root.windows?.get('character')?.place({ x: 32, y: 64 }, context, VIEWPORT);
    first.screens.update(viewFixture(), 32);
    first.screens.flushLayout();

    const document = first.saved.at(-1);
    expect(document).toBeDefined();
    if (!document) return;

    const second = harness({ layout: document });
    second.screens.update(viewFixture(), 0);
    for (const id of ['inventory', 'character'] as const) {
      expect(windowSize(second.screens, id), id).toEqual(windowSize(first.screens, id));
    }
  });

  it('captures every window, not only the open ones', () => {
    const { screens } = harness();
    screens.update(viewFixture(), 0);
    const manager = screens.root.windows;
    expect(manager).toBeDefined();
    if (!manager) return;
    const captured = captureLayout(manager);
    expect(captured.windows.map((entry) => entry.id).sort()).toEqual([
      'account',
      'character',
      'inventory',
      'options',
      'shop',
      'trade',
    ]);
  });
});

describe('resizing a game window', () => {
  it('makes every one of them resizable', () => {
    const { screens } = harness();
    for (const id of ['inventory', 'character', 'shop', 'trade', 'options'] as const) {
      expect(screens.root.windows?.get(id)?.resizable, id).toBe(true);
    }
  });

  it('keeps a resized window at its new size when it is closed and reopened', () => {
    // The size is chosen once, on the first open, from what the screen happened
    // to want. Re-opening must not throw away what the player did about it.
    const { screens } = harness();
    screens.update(viewFixture(), 0);
    screens.show('inventory');
    screens.update(viewFixture(), 16);
    screens.root.windows
      ?.get('inventory')
      ?.resize({ width: 220, height: 180 }, screens.root.layoutContext(), VIEWPORT);
    const resized = windowSize(screens, 'inventory');

    screens.toggle('inventory');
    screens.update(viewFixture(), 32);
    screens.toggle('inventory');
    screens.update(viewFixture(), 48);
    expect(windowSize(screens, 'inventory')).toEqual(resized);
  });
});

/**
 * The chat's wiring (spec 189).
 *
 * Everything about *what the chat is* is asserted in `src/ui/screens/chat.test.ts`;
 * what this file is for is the half that only exists once a screen is mounted --
 * that a submitted line reaches the client, that Escape and a click away give the
 * keyboard back, and that a closed log does not take the wheel.
 */
describe('the chat', () => {
  it('shows what the server said, in the order it was said', () => {
    const { screens } = harness();
    screens.pushChat(0, 'Ada', 'watch the ravager');
    screens.pushChat(1, '', 'Grazer was slain by Bru');
    screens.update(viewFixture(), 0);

    expect(screens.readout().chat).toEqual([
      'Ada: watch the ravager',
      'Grazer was slain by Bru',
    ]);
  });

  it('sends a line and takes the keyboard back', () => {
    const { screens, requests } = harness();
    screens.update(viewFixture(), 0);
    screens.openChat();
    expect(screens.chatOpen).toBe(true);
    // While it is open, the game hears nothing: this is the context the whole
    // stack exists for, and until now nothing had ever pushed it. Probed without
    // the character the key would produce, or the probe types into the field it
    // is measuring -- which is the right behaviour and the wrong assertion.
    expect(screens.handleKey('Digit1', 'down', NONE)).toBe(true);
    expect(screens.handleKey('KeyW', 'down', NONE)).toBe(true);

    screens.handleKey('KeyH', 'down', NONE, 'h');
    screens.handleKey('KeyI', 'down', NONE, 'i');
    screens.handleKey('Enter', 'down', NONE);

    expect(requests).toContain('say:hi');
    expect(screens.chatOpen).toBe(false);
    // ...and the game has the keys again.
    expect(screens.handleKey('Digit1', 'down', NONE)).toBe(false);
  });

  it('does not send an empty line, and closes on one', () => {
    // A blank line broadcast to everyone in the game is never what was meant,
    // and the key that opened the chat is the one somebody presses to get out.
    const { screens, requests } = harness();
    screens.update(viewFixture(), 0);
    screens.openChat();
    screens.handleKey('Enter', 'down', NONE);

    expect(requests.filter((entry) => entry.startsWith('say:'))).toEqual([]);
    expect(screens.chatOpen).toBe(false);
  });

  it('closes on Escape before it closes a window', () => {
    const { screens } = harness();
    screens.show('inventory');
    screens.update(viewFixture(), 0);
    screens.openChat();

    expect(screens.handleKey('Escape', 'down', NONE)).toBe(true);
    expect(screens.chatOpen).toBe(false);
    // The bag is still open: Escape got rid of the thing in front of it.
    expect(screens.isOpen('inventory')).toBe(true);

    expect(screens.handleKey('Escape', 'down', NONE)).toBe(true);
    expect(screens.isOpen('inventory')).toBe(false);
  });

  it('gives the keyboard back when a press lands away from the field', () => {
    // `TextField` pops `textEntry` only when it is *told* it lost focus, and a
    // press moves focus on its own -- so without this the interface swallows
    // every key in the game from then on.
    const { screens } = harness();
    screens.update(viewFixture(), 0);
    screens.openChat();
    expect(screens.root.contexts.ids()).toContain('textEntry');

    screens.handlePointer('down', { x: 399, y: 40 }, 0, NONE);
    expect(screens.chatOpen).toBe(false);
    expect(screens.root.contexts.ids()).toEqual(['gameplay']);
    expect(screens.handleKey('KeyW', 'down', NONE, 'w')).toBe(false);
  });

  it('walks what was said on Up and Down, and only while it is open', () => {
    const { screens } = harness();
    screens.update(viewFixture(), 0);

    screens.openChat();
    screens.handleKey('KeyA', 'down', NONE, 'a');
    screens.handleKey('Enter', 'down', NONE);
    screens.openChat();
    screens.handleKey('KeyB', 'down', NONE, 'b');
    screens.handleKey('Enter', 'down', NONE);

    screens.openChat();
    expect(screens.handleKey('ArrowUp', 'down', NONE)).toBe(true);
    expect(screens.readout().chatInput).toBe('b');
    screens.handleKey('ArrowUp', 'down', NONE);
    expect(screens.readout().chatInput).toBe('a');
    screens.handleKey('ArrowDown', 'down', NONE);
    expect(screens.readout().chatInput).toBe('b');
    // Down past the newest end empties the field rather than sticking.
    screens.handleKey('ArrowDown', 'down', NONE);
    expect(screens.readout().chatInput).toBe('');

    screens.closeChat();
    // Closed, the arrows are the game's again -- they are bound to walking.
    expect(screens.handleKey('ArrowUp', 'down', NONE)).toBe(false);
  });

  it('lets the wheel through to the camera while it is closed', () => {
    // The wheel is camera zoom in the Play tab. A log that took it whenever the
    // cursor happened to be bottom-left would break zoom in one corner of the
    // screen, with nothing drawn there to explain why.
    const { screens } = harness();
    screens.pushChat(0, 'Ada', 'watch the ravager');
    screens.update(viewFixture(), 0);
    const overTheLog = { x: 20, y: VIEWPORT.height - 40 };

    expect(screens.handleWheel(overTheLog, 1, NONE)).toBe(false);

    screens.openChat();
    screens.update(viewFixture(), 16);
    expect(screens.handleWheel(overTheLog, 1, NONE)).toBe(true);
  });

  it('is not a window, so it does not open the ui context or count as open', () => {
    // It is furniture in the `hud` layer: no title bar, never dragged, nothing
    // in the layout store. `anyOpen` is what decides whether a click on empty
    // space still walks the player, and a chat must not change that answer.
    const { screens, saved } = harness();
    screens.update(viewFixture(), 0);
    screens.openChat();
    screens.update(viewFixture(), 16);

    expect(screens.anyOpen).toBe(false);
    expect(screens.opened()).toEqual([]);
    expect(screens.root.contexts.ids()).toEqual(['gameplay', 'textEntry']);
    expect(saved.flatMap((layout) => layout.windows.map((entry) => entry.id))).not.toContain('chat');
  });
});


/**
 * The character window, which is the one the mount does not scroll (spec 198).
 *
 * The sheet pins its heading and its tab strip and scrolls the tab under them,
 * which it can only do because it is handed the window's real height. What is
 * asserted here is the complaint that started it: scrolling the skill tree used
 * to take the tabs with it, so there was no way back to Attributes without
 * scrolling to the top first.
 */
describe('the character window scrolls under its tabs', () => {
  const STATS: EffectiveStats = {
    maxHealth: 138,
    moveSpeed: 150,
    turnRate: 210,
    attackDamage: 12,
    attackRange: 56,
    baseAttackTimeTicks: 30,
    ...NO_ATTACK_SPEED,
    armor: 0.12,
    spellPower: 1.2,
    critChance: 0.05,
    maxResource: 40,
    resourceRegen: 0.5,
    basicAttackId: 'melee.slash',
    skillAbilityIds: [],
  ...NO_WEAPON,
    traits: NEUTRAL_TRAITS,
  };

  /** The mounted sheet, found in the tree rather than reached through the mount. */
  function sheetOf(screens: UiScreens): CharacterScreen {
    const found = [...screens.root.content.walk()].find(
      (widget): widget is CharacterScreen => widget instanceof CharacterScreen,
    );
    if (!found) throw new Error('no character screen is mounted');
    return found;
  }

  /** Everything the sheet reads. `stats` alone is what gates the feed. */
  function fed(): ClientView {
    return viewFixture({
      stats: STATS,
      baseStats: startingBaseStats(),
      attributes: startingBaseStats(),
      unspentProgressionPoints: 4,
    });
  }

  /** The sheet open, fed, and looking at the tallest tab there is. */
  function opened(): UiScreens {
    const { screens } = harness();
    screens.show('character');
    screens.update(fed(), 0);
    sheetOf(screens).tabs.select('skills');
    screens.update(fed(), 16);
    return screens;
  }

  it('is not wrapped in a scroller of its own', () => {
    const { screens } = harness();
    // The whole screen in one `ScrollView` is what put the tab strip inside the
    // thing that scrolls it.
    expect(screens.root.windows?.get('character')?.content).not.toBeInstanceOf(ScrollView);
  });

  it('leaves the tab headers where they are when the tree is scrolled', () => {
    const screens = opened();
    const tabs = sheetOf(screens).tabs;
    const before = tabs.tabIds.map((id) => ({ id, rect: tabs.tabRect(id) }));
    expect(tabs.bodyScroller?.scrollable).toBe(true);

    tabs.bodyScroller?.scrollTo(9999);
    screens.update(fed(), 32);

    expect(tabs.bodyScroller?.scrollOffset).toBeGreaterThan(0);
    expect(tabs.tabIds.map((id) => ({ id, rect: tabs.tabRect(id) }))).toEqual(before);
    // ...and every one of them is still inside the window, which is the thing a
    // player is actually complaining about.
    const window = windowSize(screens, 'character');
    for (const { rect } of before) {
      expect(rect).not.toBeNull();
      if (!rect) continue;
      expect(rect.y).toBeGreaterThanOrEqual(window.y);
      expect(rect.y + rect.height).toBeLessThanOrEqual(window.y + window.height);
    }
  });

  /**
   * The floor under the pinned band, measured rather than trusted.
   *
   * `Linear.shareSpace` starves a grower to nothing when the fixed children
   * alone overflow, so a window shorter than the band takes the tab panel with
   * it -- strip and all. The minimum has to hold the band, one row of whatever
   * the tab is showing, and the window's own chrome; a theme that grows the
   * heading fails here rather than on somebody's screen.
   */
  it('will not be resized under its own pinned band', () => {
    const screens = opened();
    const sheet = sheetOf(screens);
    const band = sheet.tabs.bodyViewport().y - sheet.rect.y;
    const row = sheet.specializationRowList[0]?.rect.height ?? 0;
    expect(band).toBeGreaterThan(0);
    expect(row).toBeGreaterThan(0);
    expect(CHARACTER_MIN_SIZE.height).toBeGreaterThanOrEqual(band + row + WINDOW_CHROME.height);

    // And the window honours it: dragged to nothing, the strip is still there.
    const window = screens.root.windows?.get('character');
    window?.resize({ width: 10, height: 10 }, screens.root.layoutContext(), VIEWPORT);
    screens.update(fed(), 48);
    expect(windowSize(screens, 'character').height).toBe(CHARACTER_MIN_SIZE.height);
    expect(sheet.tabs.headerStrip.rect.height).toBeGreaterThan(0);
    expect(sheet.tabs.bodyViewport().height).toBeGreaterThan(0);
  });
});
