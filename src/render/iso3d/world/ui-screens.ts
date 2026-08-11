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
import { UNBOUNDED, type Point, type Size } from '../../../ui/core/geom.js';
import { LayerStack } from '../../../ui/core/layers.js';
import { UiRoot } from '../../../ui/core/root.js';
import { WindowManager } from '../../../ui/core/window-manager.js';
import { bakeAtlas, type Atlas } from '../../../ui/render/atlas.js';
import { BODY_FONT } from '../../../ui/text/font.js';
import { THEME } from '../../../ui/theme/theme.js';
import { CharacterScreen } from '../../../ui/screens/character.js';
import { InventoryScreen, type SlotRef } from '../../../ui/screens/inventory.js';
import { KeybindingsScreen } from '../../../ui/screens/keybindings.js';
import { ShopScreen } from '../../../ui/screens/shop.js';
import { ScrollView } from '../../../ui/widgets/scroll-view.js';
import { UiWindow } from '../../../ui/widgets/window.js';
import type { InputMap } from '../../../ui/input/input-map.js';
import type { Widget } from '../../../ui/core/widget.js';
import type { ClientView } from '../../../server/client/game-client.js';
import { characterViewOf } from './character-model.js';
import { containerViewOf } from './inventory-model.js';
import { shopViewOf } from './shop-model.js';
import type { WindowId } from './key-actions.js';
import { escapeTaken, reachesGameplay, type Routing } from './ui-routing.js';

export interface UiScreensOptions {
  /** The key map, so the keybinding screen edits the one the game reads. */
  readonly map: InputMap;
  /** A drag that landed: where from, where to, and 0 for the whole stack. */
  readonly onMove: (from: SlotRef, to: SlotRef, count: number) => void;
  readonly onSpend: (skillId: string) => void;
  readonly onBuy: (vendorId: string, defId: string) => void;
  readonly onSell: (vendorId: string, index: number) => void;
  readonly onBuyBack: (vendorId: string, index: number) => void;
  /** Ask the server to open a shop, or to shut the one that is open (`''`). */
  readonly onVendor: (vendorId: string) => void;
  /** Which shop to ask for. Answered from where the player is standing. */
  readonly nearestVendor: () => string | null;
}

const WINDOW_TITLES: Readonly<Record<WindowId, string>> = {
  inventory: 'Inventory',
  character: 'Character',
  shop: 'Shop',
  keybindings: 'Keybindings',
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

export class UiScreens {
  readonly atlas: Atlas = bakeAtlas(THEME);
  readonly layers = new LayerStack();
  readonly root: UiRoot;

  private readonly windows = new WindowManager();
  private readonly inventory: InventoryScreen;
  private readonly character: CharacterScreen;
  private readonly shop: ShopScreen;
  private readonly keybindings: KeybindingsScreen;

  /** Windows whose size and position have been chosen. See the header. */
  private readonly placed = new Set<WindowId>();
  /** ...and ones opened but not yet placed, because their screen is still empty. */
  private readonly awaitingPlacement = new Set<WindowId>();
  /** The widget actually inside each window, which is what gets measured. */
  private readonly contents = new Map<WindowId, Widget>();
  /** Whether the `ui` context is on the stack -- pushed, popped, never toggled. */
  private uiContextPushed = false;
  private now = 0;
  /** The shop the server says is open. What a Buy is addressed to. */
  private openVendorId = '';

  /** What the screens were last built from. See {@link containersChanged}. */
  private lastInventory: ClientView['inventory'] | null = null;
  private lastEquipment: ClientView['equipment'] | null = null;
  private lastLevel = -1;
  private lastSkills: ClientView['skills'] | null = null;
  private lastStats: ClientView['stats'] = null;
  private lastSheetLevel = -1;
  private lastExperience = -1;
  private lastPoints = -1;

  constructor(
    private readonly options: UiScreensOptions,
    viewport: Size,
  ) {
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
      focus: this.root.focus,
      hitTest: (at) => this.layers.hitTest(at),
    });
    this.inventory.onMove = (intent) => {
      options.onMove(intent.from, intent.to, intent.count);
    };
    this.layers.place('dragGhost', this.inventory.ghost);

    this.character = new CharacterScreen({ theme: THEME });
    this.character.onSpend = (skillId) => {
      options.onSpend(skillId);
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

    this.keybindings = new KeybindingsScreen({
      theme: THEME,
      map: options.map,
      contexts: this.root.contexts,
    });
    this.keybindings.buildAllTabs();

    this.registerWindow('inventory', this.inventory);
    this.registerWindow('character', this.character);
    this.registerWindow('shop', this.shop);
    // The only one the mount does not scroll: it has a filter field, tabs and a
    // scroller of its own (spec 125).
    this.registerWindow('keybindings', this.keybindings, false);
  }

  /**
   * Build a window around a screen and hand it to the manager, closed.
   *
   * Closed rather than open, and registered up front rather than on demand, so
   * the z-order is the same every session: a window built the first time it is
   * opened would stack in whatever order the player happened to press keys.
   */
  private registerWindow(id: WindowId, screen: Widget, scrolled = true): void {
    const content = scrolled ? new ScrollView(screen, `${id}Scroll`) : screen;
    const window = new UiWindow(content, { title: WINDOW_TITLES[id] });
    this.contents.set(id, content);
    this.windows.register(window, id);
    window.visible = false;
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

    if (this.isOpen('inventory') && this.containersChanged(view)) {
      this.inventory.setContainers(
        containerViewOf({ inventory: view.inventory, equipment: view.equipment, level: view.level }),
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
        }),
      );
    }

    this.openVendorId = view.vendor?.id ?? '';
    if (this.isOpen('shop')) {
      const shopView = shopViewOf({
        vendor: view.vendor,
        inventory: view.inventory,
        coins: view.coins,
      });
      // The server shut it -- walked out of range, or refused to open one at
      // all. The window goes with it rather than sitting there with a price list
      // nobody can act on. A client never decides this for itself.
      if (shopView) this.shop.setShop(shopView);
      else this.close('shop');
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

    this.syncContext();
    this.root.update(nowMs);
  }

  /**
   * Whether anything the bag draws has been replaced since the last look.
   *
   * By identity, deliberately. `GameClient` replaces these whole -- on a message
   * or on a predicted move's replay -- and never edits one in place, so an
   * identity check answers the question exactly. A deep compare would be slower
   * than the rebuild it is trying to avoid.
   */
  private containersChanged(view: ClientView): boolean {
    if (
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
      view.unspentSkillPoints === this.lastPoints
    ) {
      return false;
    }
    this.lastSkills = view.skills;
    this.lastStats = view.stats;
    this.lastSheetLevel = view.level;
    this.lastExperience = view.experience;
    this.lastPoints = view.unspentSkillPoints;
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
  readout(): { readonly windows: readonly WindowId[]; readonly bag: readonly string[] } {
    return {
      windows: this.opened(),
      bag: this.inventory.bagSlots.map((cell) => cell.item?.name ?? ''),
    };
  }

  resize(viewport: Size): void {
    this.root.resize(viewport);
  }

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
    if (id === 'shop') this.options.onVendor(this.options.nearestVendor() ?? '');
    this.windows.open(id);
    if (!this.placed.has(id)) this.awaitingPlacement.add(id);
    this.syncContext();
  }

  close(id: WindowId): void {
    if (!this.windows.close(id)) return;
    // Closing the shop is telling the server to stop sending one. Without it a
    // re-open would show the stale list for a frame, and the server would go on
    // replicating a vendor nobody is looking at.
    if (id === 'shop') this.options.onVendor('');
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
    const max = {
      width: Math.max(64, viewport.width - MARGIN * 2),
      height: Math.max(48, viewport.height - MARGIN * 2),
    };
    const size = this.sizeFor(id, max);
    window.restore(this.originFor(id, size, viewport), size, viewport);
  }

  private sizeFor(id: WindowId, max: Size): Size {
    const content = this.contents.get(id);
    if (id === 'keybindings' || !content) return max;

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
  private originFor(id: WindowId, size: Size, viewport: Size): Point {
    switch (id) {
      case 'character':
        return { x: Math.max(MARGIN, viewport.width - size.width - MARGIN), y: MARGIN };
      case 'shop':
        return { x: Math.max(MARGIN, Math.floor((viewport.width - size.width) / 2)), y: MARGIN };
      case 'inventory':
      case 'keybindings':
        return { x: MARGIN, y: MARGIN };
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
   * A press also moves focus, so clicking a field and typing into it is one
   * gesture rather than two. Done here rather than inside the router for the
   * reason the gallery page does it too: focus follows the *press*, and the
   * router's job is delivery.
   */
  handlePointer(phase: 'down' | 'up' | 'move', pos: Point, button: number, mods: Modifiers): boolean {
    if (phase === 'down') this.root.focus.focus(this.layers.hitTest(pos));
    const consumed = this.root.handle({ kind: 'pointer', phase, pos, button, mods, time: this.now });
    return !reachesGameplay(this.routingOf(consumed, 'pointer'));
  }

  handleWheel(pos: Point, delta: number, mods: Modifiers): boolean {
    const consumed = this.root.handle({ kind: 'wheel', pos, delta, mods, time: this.now });
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
    if (code === 'Escape' && phase === 'down') {
      return escapeTaken([
        () => this.inventory.cancelDrag(),
        () => this.shop.dismiss(),
        () => this.closeTopmost(),
      ]);
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
    if (!this.windows.closeTopmost()) return false;
    if (shopWasOpen && !this.isOpen('shop')) this.options.onVendor('');
    this.syncContext();
    return true;
  }

  private routingOf(consumed: boolean, kind: UiEvent['kind']): Routing {
    return { consumed, blocked: !this.root.reachesGameplay(kind) };
  }
}
