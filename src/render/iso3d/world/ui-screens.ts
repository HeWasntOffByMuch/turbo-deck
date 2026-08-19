/**
 * The interface's tree, its windows and what they are handed (spec 131).
 *
 * The pure half of the mount. Everything about *what the interface is* lives
 * here -- the four screens, the windows around them, which view-model each is
 * given each frame, and who gets an event -- and `ui-layer.ts` beside it is only
 * a canvas, a scale and a coordinate conversion.
 *
 * That split is not tidiness. `presentation-only.test.ts` has asserted since
 * spec 111 that driving the animation layer changes no authoritative state, and
 * mounting an interface over the same sim deserves exactly the same assertion --
 * which is impossible if the only way to run the interface is to have a canvas.
 * Here the whole thing runs in Node, so `mount-presentation.test.ts` can play the
 * same fight twice, once with the screens driven and once without, and require
 * the two to be identical byte for byte.
 *
 * Three rules it keeps, all of them from the brief:
 *
 * **Time is an argument.** `update(view, nowMs)`; nothing under `src/ui/` may
 * read a clock, and nothing here does either.
 *
 * **A screen renders what it is handed and never edits itself.** Every callback
 * below is a *request*; the server decides, and the next `update` is what moves
 * anything. Rollback is therefore not a code path.
 *
 * **A window is sized and placed on its first showing.** Not at construction:
 * the screens are built up front but their windows have no business measuring
 * themselves against a viewport nobody has resized yet, and re-placing on every
 * open would undo a drag the player just made.
 */

import type { DrawCommand } from '../../../ui/core/draw-list.js';
import type { Modifiers, UiEvent } from '../../../ui/core/events.js';
import { UNBOUNDED, type Point, type Rect, type Size } from '../../../ui/core/geom.js';
import { Anchor } from '../../../ui/core/containers.js';
import { LayerStack } from '../../../ui/core/layers.js';
import { UiRoot } from '../../../ui/core/root.js';
import type { MotionPreference } from '../../../ui/core/motion.js';
import { WindowManager } from '../../../ui/core/window-manager.js';
import {
  applyLayout,
  captureLayout,
  layoutSignature,
  type StoredLayout,
} from '../../../ui/core/layout-store.js';
import { bakeAtlas, type Atlas } from '../../../ui/render/atlas.js';
import { BODY_FONT } from '../../../ui/text/font.js';
import { THEME } from '../../../ui/theme/theme.js';
import { CharacterScreen } from '../../../ui/screens/character.js';
import { ChatScreen, chatInsets, type ChatLineView } from '../../../ui/screens/chat.js';
import { InventoryScreen, type SlotRef } from '../../../ui/screens/inventory.js';
import { KeybindingsScreen } from '../../../ui/screens/keybindings.js';
import { ShopScreen } from '../../../ui/screens/shop.js';
import { TradeScreen, type TradeOfferView, type TradeUiView } from '../../../ui/screens/trade.js';
import { OptionsScreen } from '../../../ui/screens/options.js';
import { DisplayScreen } from '../../../ui/screens/display.js';
import type { ScaleChoice } from '../../../ui/input/display-store.js';
import { ScrollView } from '../../../ui/widgets/scroll-view.js';
import { UiWindow } from '../../../ui/widgets/window.js';
import type { InputMap } from '../../../ui/input/input-map.js';
import type { Widget } from '../../../ui/core/widget.js';
import type { ClientView } from '../../../server/client/game-client.js';
import { characterViewOf } from './character-model.js';
import { containerViewOf } from './inventory-model.js';
import { swapProgress, type SwapProgress } from './skill-swap-view.js';
import { shopViewOf } from './shop-model.js';
import { tradeViewOf } from './trade-model.js';
import type { WindowId } from './key-actions.js';
import { ChatLog, revealAt } from './chat-log.js';
import { escapeTaken, reachesGameplay, type Routing } from './ui-routing.js';

export interface UiScreensOptions {
  /** The key map, so the keybinding screen edits the one the game reads. */
  readonly map: InputMap;
  /** A drag that landed: where from, where to, and 0 for the whole stack. */
  readonly onMove: (from: SlotRef, to: SlotRef, count: number) => void;
  /**
   * A carry let go of over the world (spec 172): put it on the ground.
   *
   * Where it lands is not named here and cannot be -- the server throws it in
   * front of the body -- so this says which slot it left and how much of it.
   */
  readonly onDropItem: (at: SlotRef, count: number) => void;
  readonly onSpend: (skillId: string) => void;
  /** Put one attribute point somewhere, and hand every one of them back (147). */
  readonly onAllocate: (key: string) => void;
  readonly onRespec: () => void;
  readonly onBuy: (vendorId: string, defId: string) => void;
  readonly onSell: (vendorId: string, index: number) => void;
  readonly onBuyBack: (vendorId: string, index: number) => void;
  /** Ask the server to open a shop, or to shut the one that is open (`''`). */
  readonly onVendor: (vendorId: string) => void;
  /** Which shop to ask for. Answered from where the player is standing. */
  readonly nearestVendor: () => string | null;
  /** Trade (spec 134). Every one of these is a request; the server decides. */
  readonly onTradeOffer: (
    slots: readonly { readonly index: number; readonly count: number }[],
    coins: number,
  ) => void;
  readonly onTradeAccept: (revision: number) => void;
  readonly onTradeRespond: (accept: boolean) => void;
  readonly onTradeCancel: () => void;
  /**
   * The player has read the ending and put it away (spec 134). Local: the trade
   * is already gone at the server, so there is nothing to tell it.
   */
  readonly onTradeDismiss: () => void;
  /**
   * The player changed a key (spec 135).
   *
   * A callback rather than this half writing storage, for the same reason the
   * time is an argument: `src/ui/` may not touch the platform, and a save no
   * test can observe is a save nothing checks.
   */
  /**
   * A line the player wants to say (spec 189).
   *
   * A request like every other callback here: the server broadcasts it back to
   * everyone including the sender, so what the player sees of their own line
   * arrives through the same path as everybody else's. Nothing is echoed
   * locally, which is what stops a sent line being drawn twice.
   */
  readonly onSay: (text: string) => void;
  readonly onBindingsChanged: () => void;
  /**
   * The player picked an interface scale (spec 136).
   *
   * Same shape and same reason as `onBindingsChanged`: this half neither reads
   * the window nor writes storage. It emits the choice; the mount honours it,
   * saves it, and hands the result back through {@link UiScreens.setScale}.
   */
  readonly onScaleChosen: (choice: ScaleChoice) => void;
  /**
   * The player asked for the frame-time readout, or asked for it to go away
   * (spec 165). Same contract as `onScaleChosen` for the same reason.
   */
  readonly onShowFpsChosen: (show: boolean) => void;
  /**
   * The layout to restore, read at the DOM edge. Null when there is none.
   *
   * Held rather than applied, because it cannot be applied yet: see
   * {@link UiScreens.restoreLayout}.
   */
  readonly layout?: StoredLayout | null;
  /**
   * Where the windows are now, worth writing down (spec 147).
   *
   * Debounced by the mount, so this fires once when a drag ends rather than on
   * every frame of it -- and, like `onBindingsChanged`, it is a callback because
   * `src/ui/` may not touch storage and a save no test can observe is a save
   * nothing checks.
   */
  readonly onLayoutChanged: (layout: StoredLayout) => void;
}

/**
 * How long the layout has to hold still before it is written, in ms.
 *
 * A trailing debounce rather than a leading one: a drag changes the layout on
 * every frame it moves, and the interesting value is the one it stops on. Short
 * enough that an ordinary quit keeps the arrangement without a flush; the flush
 * exists for the rest ({@link UiScreens.flushLayout}).
 */
const SAVE_DELAY_MS = 400;

/**
 * Which windows may be restored open.
 *
 * See `ApplyOptions.restoreOpen`. The shop and the trade table are the server's
 * to open, so their openness was never the player's choice to remember.
 */
function playerDriven(id: string): boolean {
  return id !== 'shop' && id !== 'trade';
}

const WINDOW_TITLES: Readonly<Record<WindowId, string>> = {
  inventory: 'Inventory',
  character: 'Character',
  shop: 'Shop',
  trade: 'Trade',
  options: 'Options',
};

/**
 * What a window costs around its content: two paddings across, and the title bar
 * plus two paddings down.
 *
 * Mirrors `UiWindow.arrangeSelf`, read once here so a window is asked for at a
 * size that fits its screen rather than one that clips it by four pixels. The
 * gallery works it out the same way, for the same reason.
 */
const WINDOW_CHROME = {
  width: THEME.widget('window').padding * 2,
  height: BODY_FONT.height + THEME.widget('window').padding * 3,
};

/** How far a window sits from the edge it opens against, in UI pixels. */
const MARGIN = 8;

/** One side of the trade table as a single line, for the readout. */
function sideLine(side: TradeOfferView | undefined): string {
  if (!side) return '';
  const rows = side.rows.map((row) => `${row.name} x${row.count}`).join('/');
  return `${side.name}|${side.accepted ? 'yes' : 'no'}|${side.coins}|${rows}`;
}

export class UiScreens {
  readonly atlas: Atlas = bakeAtlas(THEME);
  readonly layers = new LayerStack();
  readonly root: UiRoot;

  private readonly windows = new WindowManager();
  private readonly inventory: InventoryScreen;
  private readonly character: CharacterScreen;
  private readonly shop: ShopScreen;
  private readonly keybindings: KeybindingsScreen;
  private readonly trade: TradeScreen;
  private readonly optionsScreen: OptionsScreen;
  private readonly display: DisplayScreen;
  private readonly chat: ChatScreen;
  /** What has been said. Client state: nothing here is replicated (spec 189). */
  private readonly chatLog = new ChatLog();
  private readonly chatDock = new Anchor('chat:dock');
  private chatRevision = -1;
  private chatLines: readonly ChatLineView[] = [];

  /** Windows whose size and position have been chosen. See the header. */
  private readonly placed = new Set<WindowId>();
  /** ...and ones opened but not yet placed, because their screen is still empty. */
  private readonly awaitingPlacement = new Set<WindowId>();
  /** The saved layout, until there is a viewport worth applying it against. */
  private pendingLayout: StoredLayout | null;
  private layoutRestored = false;
  /** What the layout looked like when it was last written, as a signature. */
  private savedSignature = '';
  /** When the pending write is due, on the mount's own clock. Null when clean. */
  private saveDueAt: number | null = null;
  /**
   * How much of the top of the viewport the app's own chrome is sitting on, in
   * UI pixels.
   *
   * The tab bar is fixed and floats over the whole tab, so a window opened at the
   * margin opens underneath it -- which nobody noticed while the interface was
   * twice as chunky, because a margin of 8 UI pixels was 32 real ones and cleared
   * it by accident. Handed in rather than measured, because this half may not
   * touch the DOM.
   */
  private safeTop = 0;
  /**
   * How far up from the bottom edge the DOM HUD's own furniture reaches, in UI
   * pixels. The counterpart to {@link safeTop}, and what keeps the chat clear of
   * the pool bars it is docked above.
   */
  private safeBottom = 0;
  /** The widget actually inside each window, which is what gets measured. */
  private readonly contents = new Map<WindowId, Widget>();
  /** Whether the `ui` context is on the stack -- pushed, popped, never toggled. */
  private uiContextPushed = false;
  /**
   * The trade stage the window was last sized for (spec 134).
   *
   * Every other window holds one screen whose content is roughly one size, so
   * `placeWindow` sizes it once and never again. The trade table is the
   * exception: it opens holding an *invitation* -- two names and a button --
   * and then grows a bag grid, a coin stepper and a second offer panel the
   * moment the invitation is accepted. Sized once, it was sized for the
   * invitation: 161 UI pixels tall for content that wanted 264, with Accept 77
   * pixels below the bottom edge and clipped by the scroll view. The trade was
   * unfinishable without resizing the window by hand.
   */
  private tradeStagePlaced: string | null = null;
  /** Which trade the window is about, live or ended. Identity for the below. */
  private tradeShowingId: number | null = null;
  /**
   * A trade the player has walked away from by closing the window (spec 170).
   *
   * Neither it nor its ending is drawn again. It has to be an **id** rather
   * than a flag, and it has to outlast the whole cancellation: closing a live
   * trade sends a cancel, and for the round trip that follows the trade is
   * still live and still replicated, so a mount that only remembered "an ending
   * is coming" re-opened the window it had just been told to shut -- and, in
   * re-opening it, cleared the very flag that was meant to keep it closed.
   *
   * Cleared when the trade is gone, so the *next* trade and the next ending are
   * shown normally.
   */
  private tradeLeft: number | null = null;
  private now = 0;
  /** The shop the server says is open. What a Buy is addressed to. */
  private openVendorId = '';
  /**
   * The vendor answer count at the moment the shop was asked for.
   *
   * The shop window is the one screen whose contents have to arrive before it
   * has anything to show, and "the server refused" is what closes it -- so
   * without this it closed itself on the frame it opened, every time, because
   * the answer had not come back yet. `KeyV` therefore did nothing at all, which
   * is precisely the failure the whole mount was written to end.
   */
  private shopAskedAt = -1;
  /** The last answer count seen, so {@link show} can stamp against it. */
  private lastVendorRevision = 0;
  /** What the screens were last built from. See {@link containersChanged}. */
  private lastInventory: ClientView['inventory'] | null = null;
  private lastEquipment: ClientView['equipment'] | null = null;
  private lastLevel = -1;
  /** The change in flight last frame, so the frame it ends on is noticed. */
  private lastSwap: SwapProgress | null = null;
  private lastSkills: ClientView['skills'] | null = null;
  private lastStats: ClientView['stats'] = null;
  private lastSheetLevel = -1;
  private lastExperience = -1;
  private lastPoints = -1;
  private lastBaseStats: unknown = null;
  private lastStatSkills: unknown = null;
  private lastSheetCoins = -1;

  constructor(
    private readonly options: UiScreensOptions,
    viewport: Size,
  ) {
    this.pendingLayout = options.layout ?? null;
    this.layers.place('windows', this.windows);
    this.root = new UiRoot(this.layers, {
      theme: THEME,
      atlas: this.atlas,
      viewport,
      windows: this.windows,
      layers: this.layers,
    });

    // Every screen that owns a context or a focus ring is given the root's, not
    // one of its own. Keys route to whatever `UiRoot.focus` holds, and a screen
    // focused anywhere else is a screen no keystroke reaches -- which looks
    // completely fine on screen, and is why this is now written down in four
    // places.
    this.inventory = new InventoryScreen({
      theme: THEME,
      hitTest: (at) => this.layers.hitTest(at),
    });
    this.inventory.onMove = (intent) => {
      options.onMove(intent.from, intent.to, intent.count);
    };
    this.inventory.onDropToWorld = (intent) => {
      options.onDropItem(intent.at, intent.count);
    };
    this.layers.place('dragGhost', this.inventory.ghost);
    // Above every window, like the ghost, because a tooltip about a cell in one
    // window must not be clipped by the window next to it (spec 136).
    this.layers.place('tooltip', this.inventory.tooltip);

    this.character = new CharacterScreen({ theme: THEME });
    // The sheet's tooltip goes in the same layer as the bag's, for the reason
    // the bag's is there: a hint about a row in one window must not be clipped
    // by the window next to it. Two widgets rather than one shared, because they
    // are pointed at from two different hit tests.
    this.layers.place('tooltip', this.character.tooltip);
    this.character.onSpend = (skillId) => {
      options.onSpend(skillId);
    };
    // Three more asks, and every one of them is only an ask (spec 147): the
    // screen sends a request and redraws when the server's answer arrives.
    // Nothing here updates a number optimistically, because an attribute that
    // ticked up and then back down is worse than one that ticks up late.
    this.character.onAllocate = (key) => {
      options.onAllocate(key);
    };
    this.character.onRespec = () => {
      options.onRespec();
    };

    this.shop = new ShopScreen({ theme: THEME, contexts: this.root.contexts, focus: this.root.focus });
    this.shop.onBuy = (defId) => {
      options.onBuy(this.openVendorId, defId);
    };
    this.shop.onSell = (index) => {
      options.onSell(this.openVendorId, index);
    };
    this.shop.onBuyBack = (index) => {
      options.onBuyBack(this.openVendorId, index);
    };
    this.layers.place('modal', this.shop.dialog);

    this.trade = new TradeScreen({ theme: THEME });
    this.trade.onOffer = (slots, coins) => {
      options.onTradeOffer(slots, coins);
    };
    this.trade.onAccept = (revision) => {
      options.onTradeAccept(revision);
    };
    this.trade.onRespond = (accept) => {
      options.onTradeRespond(accept);
    };
    this.trade.onCancel = () => {
      // Closing an ended trade is a local act -- there is nothing left to tell
      // the server about -- so it shuts the window instead of sending a cancel
      // for a trade that is already gone.
      // Closing is what dismisses the ending, and `close` is where that lives
      // -- the manager can shut this window without going through here.
      if (this.trade.view?.stage === 'over') this.close('trade');
      else options.onTradeCancel();
    };

    this.keybindings = new KeybindingsScreen({
      theme: THEME,
      map: options.map,
      contexts: this.root.contexts,
    });
    this.keybindings.buildAllTabs();
    this.keybindings.onBindingsChanged = () => {
      options.onBindingsChanged();
    };

    // The keybindings screen lives here and nowhere else. It used to have a
    // window of its own as well, which looked like a free convenience and was
    // not: a widget has one parent, so the second window emptied the first the
    // moment its tab was built. `K` opens this one, on this tab.
    this.display = new DisplayScreen({ theme: THEME });
    this.display.onScaleChosen = (choice) => {
      options.onScaleChosen(choice);
    };
    this.display.onShowFpsChosen = (show) => {
      options.onShowFpsChosen(show);
    };

    this.optionsScreen = new OptionsScreen({
      theme: THEME,
      keys: this.keybindings,
      display: this.display,
    });

    // The chat (spec 189), and the `hud` layer's first occupant in the Play tab.
    // Not a window: no title bar, never dragged, nothing in the layout store,
    // because it is furniture that is always there rather than something the
    // player opened.
    //
    // The dock is an `Anchor` filling the viewport with the log pinned to its
    // bottom-left corner, and it is `pointerTransparent` -- an anchor that
    // covers the frame and is not would swallow every click in the game.
    this.chat = new ChatScreen({ theme: THEME });
    this.chatDock.pointerTransparent = true;
    this.chatDock.padding = chatInsets(THEME, 0);
    this.chatDock.place(this.chat, 'bottomLeft');
    this.layers.place('hud', this.chatDock);
    // Everything a submitted line needs is here and none of it is the screen's:
    // the client to say it to, the root's focus to give back, and the log to
    // remember it in. Doing all three in one place is what stops "send it" and
    // "remember it for Up" drifting apart.
    this.chat.onSubmit = (text) => {
      if (text.length > 0) {
        options.onSay(text);
        this.chatLog.remember(text);
      }
      this.closeChat();
    };
    // Closing restarts the quiet clock, or putting the field away after a long
    // silence makes the log vanish on the same frame -- the player is looking
    // straight at it, and the last thing they did was put it away, which is not
    // the same as having ignored it for ten seconds.
    this.chat.onClosed = () => {
      this.chatLog.touch(this.now);
    };

    this.registerWindow('inventory', this.inventory);
    this.registerWindow('character', this.character);
    this.registerWindow('shop', this.shop);
    this.registerWindow('trade', this.trade);
    // Not scrolled by the mount: the keybindings page inside it has a filter
    // field, tabs and a scroller of its own (spec 125).
    this.registerWindow('options', this.optionsScreen, false);
  }

  /**
   * Build a window around a screen and hand it to the manager, closed.
   *
   * Closed rather than open, and registered up front rather than on demand, so
   * the z-order is the same every session: a window built the first time it is
   * opened would stack in whatever order the player happened to press keys.
   *
   * `resizable` since spec 147, and every one of them: the size a window is
   * given here is measured from what its screen wanted on the frame it first
   * opened, which is a reasonable guess and nothing more. A bag that is one row
   * short is a bag you scroll for the rest of the install.
   */
  private registerWindow(id: WindowId, screen: Widget, scrolled = true): void {
    const content = scrolled ? new ScrollView(screen, `${id}Scroll`) : screen;
    const window = new UiWindow(content, { title: WINDOW_TITLES[id], resizable: true });
    this.contents.set(id, content);
    this.windows.register(window, id);
    window.visible = false;
  }

  // --- the saved layout ------------------------------------------------------

  /**
   * Put the windows back where they were, once there is somewhere to put them.
   *
   * The wait is the whole of it. `UiLayer` measures its frame in its constructor,
   * before the tab has been laid out, and `Math.max(1, clientWidth)` makes that a
   * 1x1 placeholder which the first update corrects. `applyLayout` re-clamps
   * against the viewport it is handed -- correctly, since a layout saved on a
   * monitor must not put a window off the edge of a phone -- so applying it
   * against 1x1 stacks every window at the origin at its minimum size and writes
   * that back as the new layout. The saved arrangement would be destroyed by the
   * act of restoring it.
   *
   * So it is held until the viewport is real, and `layoutRestored` is only set
   * then -- which also means nothing is *written* before it, because a save that
   * beat the restore would save the defaults over the document.
   */
  private restoreLayout(): void {
    if (this.layoutRestored) return;
    const viewport = this.root.viewport;
    if (viewport.width <= 1 || viewport.height <= 1) return;
    this.layoutRestored = true;

    const layout = this.pendingLayout;
    this.pendingLayout = null;
    if (layout) {
      applyLayout(this.windows, layout, viewport, { restoreOpen: playerDriven });
      // A window the document placed does not want the default placement run
      // over it on the next open -- but one the document has never heard of, from
      // a build that did not have it, still does.
      for (const stored of layout.windows) {
        if (this.windows.get(stored.id)) this.placed.add(stored.id as WindowId);
      }
      // `applyLayout` sets `visible` directly, so the context stack has not heard
      // about the windows it just opened.
      this.syncContext();
    }
    // Seeded rather than left empty, so the frame after a restore does not see a
    // change and write the document straight back out.
    this.savedSignature = layoutSignature(this.windows);
  }

  /**
   * Notice a moved, resized, opened or restacked window and schedule the write.
   *
   * Trailing debounce: every change slides the due time, so a drag writes once
   * when it stops rather than on each of the frames it moved. The clock is the
   * `nowMs` the mount was handed -- there isn't another one, which is the rule
   * that keeps this file replayable.
   */
  private trackLayout(nowMs: number): void {
    if (!this.layoutRestored) return;
    const signature = layoutSignature(this.windows);
    if (signature !== this.savedSignature) {
      this.savedSignature = signature;
      this.saveDueAt = nowMs + SAVE_DELAY_MS;
      return;
    }
    if (this.saveDueAt === null || nowMs < this.saveDueAt) return;
    this.saveDueAt = null;
    this.options.onLayoutChanged(captureLayout(this.windows));
  }

  /**
   * Write the pending layout now, if there is one.
   *
   * For the tab going away: `ui-layer.ts` calls it on `pagehide` and on the
   * document going hidden, because the debounce above is 400ms of real time and
   * a window dragged immediately before a quit would otherwise be forgotten.
   */
  flushLayout(): void {
    if (this.saveDueAt === null) return;
    this.saveDueAt = null;
    this.options.onLayoutChanged(captureLayout(this.windows));
  }

  // --- the frame ------------------------------------------------------------

  /**
   * Hand every open screen what it shows, and lay out.
   *
   * Two gates, and both of them are measured rather than tidiness.
   *
   * **Only what is open.** A shop's rows are the server's `buy` run over every
   * entry in the stock, and paying for that on every frame of a fight nobody has
   * a shop open in is a cost with no picture at the end of it.
   *
   * **Only when the facts changed.** The replicated containers are *replaced*
   * when the server says something and are the same objects otherwise, so an
   * identity check is exact here rather than a heuristic -- and the screens are
   * built to ignore a resend anyway, so the whole rebuild was landing on
   * `sameItem` guards sixty times a second. It was 2.7ms of a 1.5ms budget.
   */
  update(view: ClientView, nowMs: number): void {
    this.now = nowMs;
    // Before anything is placed, and before anything is saved. The saved layout
    // is the answer to "where does this window go"; the defaults are only what
    // happens when there isn't one.
    this.restoreLayout();

    // The change in flight, as of the tick being drawn (spec 188). Worked out
    // once here and used twice -- the bag marks its two cells with it and the
    // HUD's bar draws the same fraction -- because a swap is one commitment and
    // two surfaces showing it at different depths would be worse than one
    // showing it at all.
    const swap = swapProgress(view.pendingSwap, view.estimatedTick);
    if (this.isOpen('inventory') && this.containersChanged(view, swap)) {
      this.inventory.setContainers(
        containerViewOf({
          inventory: view.inventory,
          equipment: view.equipment,
          level: view.level,
          swap,
        }),
      );
    }
    if (this.isOpen('character') && view.stats && this.characterChanged(view)) {
      this.character.setCharacter(
        characterViewOf({
          name: 'You',
          level: view.level,
          experience: view.experience,
          unspentSkillPoints: view.unspentSkillPoints,
          skills: view.skills,
          stats: view.stats,
          baseStats: view.baseStats,
          attributes: view.attributes,
          unspentAttributePoints: view.unspentAttributePoints,
          coins: view.coins,
        }),
      );
    }

    this.openVendorId = view.vendor?.id ?? '';
    this.lastVendorRevision = view.vendorRevision;
    if (this.isOpen('shop')) {
      const shopView = shopViewOf({
        vendor: view.vendor,
        inventory: view.inventory,
        coins: view.coins,
      });
      // The server shut it -- walked out of range, or refused to open one at
      // all. The window goes with it rather than sitting there with a price list
      // nobody can act on. A client never decides this for itself.
      //
      // ...but only once the server has actually answered. Before that there is
      // no shop because nobody has said yet, which is a different thing from no.
      if (shopView) this.shop.setShop(shopView);
      else if (view.vendorRevision > this.shopAskedAt) this.close('shop');
    }

    // Placed *here*, after the screens have been fed, and not in `show`.
    //
    // A window is sized from what its screen wants, and a screen that has never
    // been handed anything wants a good deal less: an inventory with no bag and
    // no paperdoll measures 211x114 against the 214x162 it becomes a frame
    // later, so a window placed at the moment of the keypress opened two
    // equipment rows too short and scrolled for the rest of the session. It
    // looked like a layout bug and was a sequencing one.
    for (const id of this.awaitingPlacement) this.placeWindow(id);
    this.awaitingPlacement.clear();

    // The trade window is not on a key: a trade is something the *other* player
    // starts, so the window follows the server exactly as the shop does. It
    // opens when a trade appears and closes when the player dismisses the
    // ending -- not when the trade ends, because the ending is the one thing
    // the interface most needs to say.
    //
    // The live trade, or the last one to end. The fallback is the whole of the
    // "what the ending says" rule: the server forgets a trade the instant it is
    // over, so by the time there is a reason to show, `view.trade` is already
    // null -- and a window that read only that would vanish on the one frame it
    // had something worth saying.
    const tradeView = tradeViewOf({
      trade: view.trade ?? view.endedTrade,
      inventory: view.inventory,
      coins: view.coins,
    });
    // Which trade this is, so leaving one can be remembered by identity rather
    // than by a flag a later frame could clear.
    const replicated = view.trade ?? view.endedTrade;
    this.tradeShowingId = replicated?.id ?? null;
    if (replicated === null) this.tradeLeft = null;

    if (tradeView !== null && replicated !== null && this.tradeLeft === replicated.id) {
      // Walked away from. Not drawn, live or ended -- and once the ending has
      // arrived there is something to forget, which is what finally clears it.
      if (view.trade === null) this.options.onTradeDismiss();
    } else if (tradeView) {
      if (!this.isOpen('trade')) this.show('trade');
      this.trade.setTrade(tradeView);
      // Re-sized when the stage changes, because the stage is exactly what
      // decides how much there is to show. Queued rather than done here: the
      // screen has to be laid out with its new content before it can be
      // measured, which is the same frame-behind rule `awaitingPlacement`
      // exists for above.
      if (tradeView.stage !== this.tradeStagePlaced) {
        this.tradeStagePlaced = tradeView.stage;
        this.placed.delete('trade');
        this.awaitingPlacement.add('trade');
      }
    }

    // The tooltip's delay is time passing rather than an event, so it is
    // advanced once a frame from the time the mount was handed (spec 136).
    this.inventory.tooltip.viewport = this.root.viewport;
    // ...and it says nothing at all when the bag is shut. The tooltip sits in a
    // layer above every window rather than inside one, and the bag closes on a
    // *key*, which no pointer move follows -- so without this, closing it with
    // the cursor on an item leaves the box floating over the world.
    if (!this.isOpen('inventory')) {
      this.inventory.clearTooltip();
      // ...and nothing is left in hand either (spec 137). The ghost is in a
      // layer above every window too, so closing the bag mid-carry left an item
      // stuck to the cursor over the world with no way to put it down. The item
      // goes back to the cell it came from, which is where it still is as far as
      // the server is concerned.
      this.inventory.cancelDrag();
    }
    this.inventory.updateTooltip(nowMs);
    // The sheet's, on the same terms (spec 147).
    this.character.tooltip.viewport = this.root.viewport;
    if (!this.isOpen('character')) this.character.clearTooltip();
    this.character.updateTooltip(nowMs, THEME.input.tooltipDelayMs);
    // ...and a capture does not outlive the window it was armed in either. It
    // holds `textEntry` while it waits, so a capture stranded by a window closing
    // any other way -- the title bar's cross, a second press of K -- is an
    // interface that swallows every key from then on.
    if (!this.isOpen('options')) this.keybindings.cancelCapture();

    // What the chat draws (spec 189). The line list is rebuilt only when
    // something was actually said: the log mutates its array in place -- pushed,
    // and shifted at the cap -- so its identity says nothing about whether
    // anything arrived, which is what `revision` is for.
    if (this.chatRevision !== this.chatLog.revision) {
      this.chatRevision = this.chatLog.revision;
      this.chatLines = this.chatLog.entries;
    }
    this.chat.setView({
      lines: this.chatLines,
      reveal: revealAt(this.chatLog.lastAtMs, nowMs, this.chat.isOpen),
    });

    this.syncContext();
    this.root.update(nowMs);
    // After the layout pass, and it has to be: `maxScroll` is derived from the
    // content height the layout just measured, so a scroll requested before it
    // lands one line short of the bottom -- which is the newest line, every
    // time.
    this.chat.settle();
    // After the layout pass, so a drag that landed this frame is measured at the
    // position it landed at rather than the one it left.
    this.trackLayout(nowMs);
  }

  /**
   * Whether anything the bag draws has been replaced since the last look.
   *
   * By identity, deliberately. `GameClient` replaces these whole -- on a message
   * or on a predicted move's replay -- and never edits one in place, so an
   * identity check answers the question exactly. A deep compare would be slower
   * than the rebuild it is trying to avoid.
   */
  private containersChanged(view: ClientView, swap: SwapProgress | null): boolean {
    // A change in flight moves every frame, so the containers are re-pushed
    // every frame while one is running. The guard exists to stop a resend
    // twenty times a second becoming a teardown of thirty-odd cells; a swap
    // lasts a second and a half and is the one thing on this screen that is
    // *animated*, so paying for it while it happens is the whole point.
    //
    // The `!swap && !this.lastSwap` half is what turns the mark off: the frame
    // after a swap ends still has to run once to clear the two cells it left
    // marked, and comparing the two nulls is how that frame is noticed.
    const swapping = swap !== null || this.lastSwap !== null;
    this.lastSwap = swap;
    if (
      !swapping &&
      view.inventory === this.lastInventory &&
      view.equipment === this.lastEquipment &&
      view.level === this.lastLevel
    ) {
      return false;
    }
    this.lastInventory = view.inventory;
    this.lastEquipment = view.equipment;
    this.lastLevel = view.level;
    return true;
  }

  private characterChanged(view: ClientView): boolean {
    if (
      view.skills === this.lastSkills &&
      view.stats === this.lastStats &&
      view.level === this.lastSheetLevel &&
      view.experience === this.lastExperience &&
      view.unspentSkillPoints === this.lastPoints &&
      view.baseStats === this.lastBaseStats &&
      view.skills === this.lastStatSkills &&
      view.coins === this.lastSheetCoins
    ) {
      return false;
    }
    this.lastSkills = view.skills;
    this.lastStats = view.stats;
    this.lastSheetLevel = view.level;
    this.lastExperience = view.experience;
    this.lastPoints = view.unspentSkillPoints;
    this.lastBaseStats = view.baseStats;
    this.lastStatSkills = view.skills;
    this.lastSheetCoins = view.coins;
    return true;
  }

  /** This frame's commands, in paint order. */
  paint(): readonly DrawCommand[] {
    return this.root.paint().finish();
  }

  /**
   * What the interface is showing, in words, for a harness.
   *
   * The same idea as `authoredUnitReadout` (spec 111): a window into the
   * renderer, read by `preview-world.ts` and by nothing in the game. It exists
   * because this interface draws to a canvas, so "the bag on screen is the bag
   * the server sent" is a claim with no DOM to check it against -- and a browser
   * assertion that could only say "some pixels changed" would pass just as
   * happily over a demo bag as over the real one.
   */
  readout(): {
    readonly windows: readonly WindowId[];
    readonly bag: readonly string[];
    readonly tab: string;
    readonly tabRects: readonly { readonly id: string; readonly rect: Rect }[];
    readonly scaleChoice: string;
    readonly scaleRects: readonly { readonly id: string; readonly rect: Rect }[];
    readonly bagRects: readonly { readonly id: string; readonly rect: Rect }[];
    readonly bindRects: readonly { readonly id: string; readonly rect: Rect }[];
    readonly resetRects: readonly { readonly id: string; readonly rect: Rect }[];
    readonly windowRects: readonly { readonly id: string; readonly rect: Rect }[];
    readonly tradeStage: string;
    readonly tradeReason: string;
    readonly tradeInvited: string;
    readonly tradeYou: string;
    readonly tradeThem: string;
    readonly tradeRects: readonly { readonly id: string; readonly rect: Rect }[];
    readonly chat: readonly string[];
    readonly chatOpen: boolean;
    readonly chatInput: string;
    readonly chatRects: readonly { readonly id: string; readonly rect: Rect }[];
  } {
    const tabs = this.optionsScreen.tabs;
    const shownTrade = this.isOpen('trade') ? this.trade.view : null;
    return {
      windows: this.opened(),
      bag: this.inventory.bagSlots.map((cell) => cell.item?.name ?? ''),
      // What the chat is showing, said the way a player reads it (spec 189).
      // The log is drawn to a canvas like everything else here, so "the line
      // the server broadcast is on screen" has no element to ask -- and a
      // harness that could only say some pixels changed would pass just as
      // happily over a log that drew the wrong channel in the wrong colour.
      chat: this.chatLines.map((line) => (line.from.length > 0 ? `${line.from}: ${line.text}` : line.text)),
      chatOpen: this.chat.isOpen,
      chatInput: this.chat.inputText,
      // Where the log and the field are, in UI pixels. The one claim about the
      // chat that is purely geometric -- that it clears the HUD it is docked
      // above -- can only be checked against something that knows where the
      // pool bars are, and that is the DOM, on the other side of the canvas.
      chatRects: [
        { id: 'log', rect: this.chat.log.rect },
        ...(this.chat.isOpen ? [{ id: 'input', rect: this.chat.field.rect }] : []),
      ],
      // The options window's tab strip, in UI pixels (spec 136). A harness
      // cannot click a tab it cannot find, and every other way of finding one --
      // a guessed offset, a scan for lit pixels -- is a measurement of the
      // layout rather than of the thing being checked.
      tab: tabs.activeId,
      tabRects: tabs.tabIds.flatMap((id) => {
        const rect = tabs.tabRect(id);
        return rect ? [{ id, rect }] : [];
      }),
      scaleChoice: String(this.display.selected),
      scaleRects: this.display.choiceRects(),
      // ...and the bag's cells, in the same shape and for the same reason (spec
      // 137). Carrying an item is now a click on one cell and a click on
      // another, and a harness that cannot say *which* cell is a harness that
      // can only say some pixels changed.
      bagRects: this.inventory.bagSlots.map((cell, index) => ({ id: String(index), rect: cell.rect })),
      // The keybinding rows' buttons, by action id (spec 138). Binding a key is
      // two events a browser has to deliver in order -- a press on the button and
      // then a key with no focus anywhere -- which is precisely the path that
      // broke, and the resets are here so a harness can put back what it bound.
      bindRects: this.rowButtons('bind:', ':primary'),
      resetRects: this.rowButtons('reset:', ''),
      // Where each window is and how big it is, in UI pixels (spec 147). The
      // whole feature is a claim about numbers that survive a reload, and this
      // is the only way a browser can read one back: the interface is a canvas,
      // so "the bag came back where I left it" has no element to ask.
      windowRects: this.windows.ids().flatMap((id) => {
        const window = this.windows.get(id);
        return window ? [{ id, rect: window.placement() }] : [];
      }),
      // The trade table, in the same shape and for the same reason (spec 134).
      // This is the one screen a single tab cannot exercise at all -- it needs
      // two players and a server between them -- so it is also the one whose
      // wiring nothing but a two-tab harness can check. The stage and the
      // reason ride along because "the window is open" is the assertion that
      // let a frozen window pass for a finished trade for two specs.
      // Only while the window is up. The screen keeps the last view it was
      // handed -- that is what makes a re-open instant -- but this readout is a
      // statement about what is *on screen*, and a closed window is showing
      // nothing. Reporting the stale stage here would make "the ending was put
      // away" indistinguishable from "the ending is still up".
      tradeStage: shownTrade?.stage ?? '',
      // The reason an ending gives, or the warning a live table carries -- the
      // same one thing the screen puts in that line.
      tradeReason: shownTrade === null ? '' : shownTrade.stage === 'over' ? shownTrade.reason : shownTrade.warning,
      tradeInvited: shownTrade === null ? '' : shownTrade.invited ? 'yes' : 'no',
      // What is actually on each side of the table. The stage says how far the
      // trade has got; these say what it is *about*, which is the half a
      // harness needs to tell "the click landed" from "the click missed".
      tradeYou: sideLine(shownTrade?.you),
      tradeThem: sideLine(shownTrade?.them),
      tradeRects: shownTrade ? this.tradeButtons() : [],
    };
  }

  /**
   * Where the trade table's controls are, by name. For the harness.
   *
   * Only what is *visible*: this screen hides its buttons rather than disabling
   * them -- an ended trade offers nothing that would ask the server for
   * anything -- so publishing a hidden button's rect would hand a harness a
   * place to click that a player does not have.
   */
  private tradeButtons(): readonly { id: string; rect: Rect }[] {
    const named: readonly (readonly [string, Widget])[] = [
      ['accept', this.trade.acceptButton],
      ['decline', this.trade.declineButton],
      ['cancel', this.trade.cancelButton],
      ['addCoin', this.trade.addCoin],
      ['removeCoin', this.trade.removeCoin],
      ...this.trade.bagSlots.map((cell, index) => [`bag:${index}`, cell] as const),
    ];
    return named
      .filter(([, widget]) => widget.visible)
      .map(([id, widget]) => ({ id, rect: widget.rect }))
      // ...and nothing with no area. A cell inside a hidden grid stays visible
      // in its own right -- the grid is what was hidden -- so it would otherwise
      // publish a 0x0 box at the origin, which is a place a harness can click
      // and a player cannot.
      .filter(({ rect }) => rect.width > 0 && rect.height > 0);
  }

  /** Where a keybinding row's buttons are, by action id. For the harness. */
  private rowButtons(prefix: string, suffix: string): readonly { id: string; rect: Rect }[] {
    const found: { id: string; rect: Rect }[] = [];
    for (const widget of this.keybindings.walk()) {
      if (!widget.visible || !widget.name.startsWith(prefix) || !widget.name.endsWith(suffix)) continue;
      if (widget.rect.width === 0) continue;
      const id = widget.name.slice(prefix.length, widget.name.length - suffix.length);
      found.push({ id, rect: widget.rect });
      if (found.length >= 4) break;
    }
    return found;
  }

  /** Whether something is in hand. For a test, and for the harness. */
  get carrying(): boolean {
    return this.inventory.drag.active !== null;
  }

  /** What the tooltip is saying, or `''` when it is not showing. */
  get tooltipText(): string {
    return this.inventory.tooltip.visible ? this.inventory.tooltip.label : '';
  }

  resize(viewport: Size): void {
    this.root.resize(viewport);
  }

  /**
   * Told what the scale preference is, and what it worked out to (spec 136).
   *
   * Both, because they are different facts: the preference is what the player
   * chose and `effective` is what the interface is actually being drawn at, and
   * the whole point of showing the second is that `auto` does not say which.
   * The Display page never sets its own tick -- this is what does.
   */
  setScale(choice: ScaleChoice, effective: number): void {
    this.display.setChoice(choice);
    this.display.setEffectiveScale(effective);
  }

  /** Told whether the frame-time readout is being drawn (spec 165). */
  setShowFps(show: boolean): void {
    this.display.setShowFps(show);
  }

  /** Told whether the player has asked for less motion (spec 133). */
  setMotion(motion: MotionPreference): void {
    this.root.setMotion(motion);
  }

  /** Told where the app's chrome ends. See {@link safeTop}. */
  setSafeTop(uiPixels: number): void {
    this.safeTop = Math.max(0, Math.floor(uiPixels));
  }

  /**
   * Told how far up the DOM HUD's own furniture reaches (spec 189).
   *
   * The counterpart to {@link setSafeTop} and fed the same way -- measured
   * outside and converted through the one place UI pixels and CSS pixels meet.
   * The chat is docked bottom-left, which is where the pool bars are, so
   * without it the log sits on top of the player's own health.
   *
   * Applied as the dock's padding rather than per frame: an inset is a fact
   * about the layout, and rewriting it every frame would allocate one object a
   * frame to say the same thing.
   */
  setSafeBottom(uiPixels: number): void {
    const next = Math.max(0, Math.floor(uiPixels));
    if (next === this.safeBottom) return;
    this.safeBottom = next;
    this.chatDock.padding = chatInsets(THEME, next);
    this.chatDock.invalidateArrange();
  }

  // --- chat (spec 189) ------------------------------------------------------

  /**
   * Something was said.
   *
   * Stamped with the frame's time rather than a clock of this module's own, for
   * the reason `ErrorLog.add` gives: a chat line arrives on a network callback,
   * outside the frame loop, and a frame is a few milliseconds of error against a
   * ten-second quiet window. A second clock in here is the one thing that would
   * make the mount impure.
   */
  pushChat(channel: number, from: string, text: string): void {
    this.chatLog.append(channel, from, text, this.now);
  }

  get chatOpen(): boolean {
    return this.chat.isOpen;
  }

  /** Open the input line and give it the keyboard. */
  openChat(): void {
    if (this.chat.isOpen) return;
    // Up starts from the newest end -- the empty field the player is looking at
    // -- rather than wherever the last session of typing left the cursor.
    this.chatLog.resetRecall();
    this.chat.open(this.chatFocus);
  }

  closeChat(): void {
    this.chat.close(this.chatFocus);
  }

  private escapeChat(): boolean {
    if (!this.chat.isOpen) return false;
    this.closeChat();
    return true;
  }

  /**
   * The root's focus and context stack, narrowed to what the chat needs.
   *
   * The root's, never one of the screen's own: keys route to whatever
   * `UiRoot.focus` holds, and a screen focused anywhere else is a screen no
   * keystroke reaches -- which looks completely fine on screen, and is why this
   * is now written down in five places.
   */
  private readonly chatFocus = {
    focus: (widget: Widget | null): boolean => this.root.focus.focus(widget),
    push: (id: 'textEntry'): void => {
      this.root.pushContext(id);
    },
    pop: (id: 'textEntry'): void => {
      this.root.popContext(id);
    },
  };

  get viewport(): Size {
    return this.root.viewport;
  }

  // --- windows --------------------------------------------------------------

  get anyOpen(): boolean {
    return this.windows.openWindows().length > 0;
  }

  isOpen(id: WindowId): boolean {
    return this.windows.get(id)?.visible === true;
  }

  /**
   * What the trade window is showing, or null. Diagnostics, and what a harness
   * reads -- "the window is open" cannot tell an ending being shown apart from
   * a window frozen on the last live frame, which is the exact difference the
   * ending is for.
   */
  get shownTrade(): TradeUiView | null {
    return this.trade.view;
  }

  /** Which windows are open, front last. Diagnostics, and what a harness reads. */
  opened(): readonly WindowId[] {
    return this.windows.order.filter((id): id is WindowId => this.isOpen(id as WindowId));
  }

  toggle(id: WindowId): void {
    if (this.isOpen(id)) this.close(id);
    else this.show(id);
  }

  show(id: WindowId): void {
    if (this.isOpen(id)) {
      this.windows.focus(id);
      return;
    }
    // Asked for before the window appears, so the first frame it is drawn on is
    // already the answer rather than an empty shop that fills in a moment later.
    if (id === 'shop') {
      this.shopAskedAt = this.lastVendorRevision;
      this.options.onVendor(this.options.nearestVendor() ?? '');
    }
    // Handed the time, so the window wipes into view (spec 133). It is the only
    // caller that has one -- the goldens open a window settled, on purpose.
    this.windows.open(id, this.now);
    if (!this.placed.has(id)) this.awaitingPlacement.add(id);
    this.syncContext();
  }

  close(id: WindowId): void {
    if (!this.windows.close(id)) return;
    // Closing the shop is telling the server to stop sending one. Without it a
    // re-open would show the stale list for a frame, and the server would go on
    // replicating a vendor nobody is looking at.
    if (id === 'shop') this.options.onVendor('');
    // Closing the trade window is what puts it away (spec 134). Here rather
    // than in the Close button's handler, because Escape and the title bar shut
    // a window without pressing anything -- and an ending still remembered is
    // an ending the mount re-opens on the very next frame.
    if (id === 'trade') this.leaveTrade();
    this.syncContext();
  }

  /**
   * Size and place a window, once.
   *
   * Sized to what the screen actually wants where that is knowable and to the
   * viewport where it is not, then clamped in both. A window stretched to fill is
   * mostly empty panel; one measured with no ceiling is taller than the screen on
   * a small tab.
   */
  private placeWindow(id: WindowId): void {
    if (this.placed.has(id)) return;
    this.placed.add(id);
    const window = this.windows.get(id);
    if (!window) return;

    const viewport = this.root.viewport;
    const top = this.safeTop + MARGIN;
    const max = {
      width: Math.max(64, viewport.width - MARGIN * 2),
      height: Math.max(48, viewport.height - top - MARGIN),
    };
    const size = this.sizeFor(id, max);
    window.restore(this.originFor(id, size, viewport, top), size, viewport);
  }

  private sizeFor(id: WindowId, max: Size): Size {
    const content = this.contents.get(id);
    // Both of these are lists that want the room: the standalone keybindings
    // window and the options window that contains the same screen.
    if (id === 'options' || !content) return max;

    // The window's *content* is measured, not the screen inside it: the content
    // is a `ScrollView`, which takes its bar's width off before handing the rest
    // on. Measuring the screen and sizing the window to that is a window exactly
    // one scrollbar too narrow, which shows up as the last column of the bag
    // clipped and a horizontal offset nobody asked for.
    //
    // No vertical ceiling, so the answer is the natural height rather than
    // whatever the content would compress to.
    const natural = content.measure(
      { maxWidth: max.width - WINDOW_CHROME.width, maxHeight: UNBOUNDED },
      this.root.layoutContext(),
    );
    return {
      width: Math.min(max.width, natural.width + WINDOW_CHROME.width),
      height: Math.min(max.height, natural.height + WINDOW_CHROME.height),
    };
  }

  /**
   * Where a window opens.
   *
   * The bag on the left and the sheet on the right, because that pair is the one
   * combination worth reading at once -- what is worn against what it would do.
   * The shop opens in the middle, and the keybindings fill the tab.
   */
  private originFor(id: WindowId, size: Size, viewport: Size, top: number): Point {
    switch (id) {
      case 'character':
        return { x: Math.max(MARGIN, viewport.width - size.width - MARGIN), y: top };
      case 'shop':
      case 'trade':
        return { x: Math.max(MARGIN, Math.floor((viewport.width - size.width) / 2)), y: top };
      case 'options':
        return { x: Math.max(MARGIN, Math.floor((viewport.width - size.width) / 2)), y: top };
      case 'inventory':
        return { x: MARGIN, y: top };
    }
  }

  /**
   * Keep the `ui` context in step with whether anything is open.
   *
   * It neither blocks nor swallows -- a window does not stop the world, and the
   * brief's stack is `Gameplay -> UI -> Modal -> TextEntry` with `ui` as the
   * quiet one. It is maintained anyway because the *depth* is what a modal is
   * pushed onto, and a stack that only ever gets its top two entries is a stack
   * that is lying about the other two.
   */
  private syncContext(): void {
    const wanted = this.anyOpen;
    if (wanted === this.uiContextPushed) return;
    this.uiContextPushed = wanted;
    if (wanted) this.root.pushContext('ui');
    else this.root.popContext('ui');
  }

  // --- input ----------------------------------------------------------------

  /**
   * Offer a pointer event, in UI pixels. True when gameplay must not act on it.
   *
   * A press moves focus only onto something that wants the keyboard, which
   * today is a text field and nothing else (spec 137). Done here rather than
   * inside the router for the reason the gallery page does it too: focus follows
   * the *press*, and the router's job is delivery.
   */
  handlePointer(phase: 'down' | 'up' | 'move', pos: Point, button: number, mods: Modifiers): boolean {
    if (phase === 'down') {
      this.focusOnPress(pos);
      // A press that landed anywhere but the field has just taken the keyboard
      // off it -- and `TextField` pops `textEntry` only when it is *told* it
      // lost focus. Without this the interface swallows every key from then on,
      // which is the exact failure a stranded keybinding capture used to cause.
      // Clicking the world while typing means going back to the game anyway.
      if (this.chat.isOpen && this.root.focus.focused !== this.chat.field) this.closeChat();
    }
    // A press on the world with something in hand puts it down (spec 172), and
    // is not passed on: the button that drops an item must not also order the
    // player to walk over to where it landed.
    //
    // On the press rather than the release, because that is the half gameplay
    // acts on -- an order is given on the way down -- so consuming the release
    // would be consuming an event nothing was going to read.
    if (phase === 'down' && this.dropOnWorld(pos)) return true;
    const consumed = this.root.handle({ kind: 'pointer', phase, pos, button, mods, time: this.now });
    // A move with no button down reaches no gesture, and two things need it: a
    // carry follows the cursor with nothing held, and a tooltip is by definition
    // about hovering (spec 136). This is the one place that sees every move.
    if (phase === 'move' && this.isOpen('inventory')) this.inventory.pointerMoved(pos, this.now);
    if (phase === 'move' && this.isOpen('character')) this.character.pointerMoved(pos, this.now);
    return !reachesGameplay(this.routingOf(consumed, 'pointer'));
  }

  /**
   * Put a carried stack down, if the press landed on the world (spec 172).
   *
   * "The world" is nothing in the interface at all -- a null hit test through
   * the layer stack, which is the same question {@link focusOnPress} asks. A
   * press on a window that is not a cell is not a drop: releasing over the empty
   * half of the bag has always meant "keep hold of it", and turning that into a
   * discard would be the one gesture in the screen that destroys something by
   * being slightly off.
   */
  private dropOnWorld(pos: Point): boolean {
    if (this.inventory.drag.active === null) return false;
    if (this.layers.hitTest(pos) !== null) return false;
    return this.inventory.dropCarried();
  }

  /**
   * Give the keyboard to what was pressed, if it is a thing that types.
   *
   * A press on anything else *clears* focus rather than leaving it, which is the
   * half that matters: a text field that keeps the keyboard after you click
   * away is a text field that goes on eating W, A, S and D.
   */
  private focusOnPress(pos: Point): void {
    const hit = this.layers.hitTest(pos);
    if (hit?.focusOnPress) this.root.focus.focus(hit);
    else this.root.focus.focus(null);
  }

  handleWheel(pos: Point, delta: number, mods: Modifiers): boolean {
    const consumed = this.root.handle({ kind: 'wheel', pos, delta, mods, time: this.now });
    // Asked after the event, because whether the log is still following its own
    // tail is a fact about where it ended up rather than about the wheel.
    if (this.chat.isOpen) this.chat.noteScrolled();
    return !reachesGameplay(this.routingOf(consumed, 'wheel'));
  }

  /**
   * Offer a key. True when gameplay must not act on it.
   *
   * Escape is the one with an order to it -- a drag, then a dialog, then a
   * window, and only then gameplay -- and each step already reports whether it
   * acted, so it is a list rather than four nested ifs (`escapeTaken`).
   *
   * `text` is the printable character the key produced, when it produced one. It
   * goes as a second event because a text field takes characters from `text` and
   * control keys from `key`, and a browser delivers both on one `keydown`.
   */
  handleKey(code: string, phase: 'down' | 'up', mods: Modifiers, text?: string): boolean {
    // A capture in progress owns every key, Escape included.
    //
    // Handed here rather than routed, because routing a key means routing it to
    // *focus* -- and since spec 137 a press no longer takes focus, so the button
    // that armed the capture is not holding the keyboard and the screen the key
    // has to reach is not focusable at all. The keybinding screen is the one
    // thing in the interface whose whole job is to hear a key it was not given,
    // so it is asked directly, from the one place that sees every key.
    //
    // It is also *before* Escape's list. A capture is the thing in front of you,
    // like a drag: Escape has to call it off rather than close the window it was
    // opened in -- which used to leave `textEntry` pushed with nothing to pop it,
    // and from then on the interface swallowed every key in the game.
    if (phase === 'down' && this.keybindings.capturing && this.keybindings.captureKey(code, mods)) {
      return true;
    }

    if (code === 'Escape' && phase === 'down') {
      return escapeTaken([
        () => this.inventory.cancelDrag(),
        () => this.shop.dismiss(),
        // Ahead of closing a window and behind cancelling a drag: an open chat
        // is the thing in front of you, and it is what Escape should get rid of
        // before it reaches the bag behind it.
        () => this.escapeChat(),
        () => this.closeTopmost(),
      ]);
    }

    // Up and Down walk what this player has said, and they are asked here rather
    // than routed for the reason a keybinding capture is: `TextField` swallows
    // every key it is given and answers the arrows it cares about itself, so a
    // routed `ArrowUp` reaches the field and stops. This is the one place that
    // sees every key.
    if (phase === 'down' && this.chat.isOpen && (code === 'ArrowUp' || code === 'ArrowDown')) {
      this.chat.setInputText(this.chatLog.recall(code === 'ArrowUp' ? -1 : 1));
      return true;
    }

    let consumed = this.root.handle({ kind: 'key', phase, code, mods, time: this.now });
    if (phase === 'down' && text !== undefined && text.length > 0) {
      consumed = this.root.handle({ kind: 'text', text, time: this.now }) || consumed;
    }
    return !reachesGameplay(this.routingOf(consumed, 'key'));
  }

  /** Move focus, for Tab. Separate because Tab is not routed to a widget. */
  moveFocus(step: number): void {
    this.root.moveFocus(step);
  }

  /**
   * Shut the front-most window, and tell the server if it was the shop.
   *
   * The manager closes windows on its own -- Escape reaches it, and so does a
   * title-bar close button -- so the side effect cannot live only in
   * {@link close}. Asking which one went is how it stays in one place.
   */
  private closeTopmost(): boolean {
    const shopWasOpen = this.isOpen('shop');
    const tradeWasOpen = this.isOpen('trade');
    if (!this.windows.closeTopmost()) return false;
    if (shopWasOpen && !this.isOpen('shop')) this.options.onVendor('');
    if (tradeWasOpen && !this.isOpen('trade')) this.leaveTrade();
    this.syncContext();
    return true;
  }

  /**
   * Shutting the trade window, however it was shut.
   *
   * **Closing a live trade cancels it**, because leaving the table is what
   * closing means and there is no other honest reading: a window that shut
   * while the trade went on would leave the player in a trade they cannot see
   * and unable to start another. Before this the mount re-opened the window
   * every frame while a trade was live, so Escape and the title bar did nothing
   * at all and the Cancel button was the only way out.
   *
   * An ending is simply forgotten -- there is nothing left to tell the server
   * about a trade it has already dropped.
   */
  private leaveTrade(): void {
    const showing = this.trade.view;
    if (showing !== null && showing.stage !== 'over') this.options.onTradeCancel();
    this.tradeLeft = this.tradeShowingId;
    this.options.onTradeDismiss();
    this.tradeStagePlaced = null;
  }

  private routingOf(consumed: boolean, kind: UiEvent['kind']): Routing {
    return { consumed, blocked: !this.root.reachesGameplay(kind) };
  }
}
