/**
 * Render the gallery to pixels, in Node (spec 123).
 *
 * One function, shared by the golden-image test, the PNG writer and the browser
 * preview, so that all three are looking at the same frame. If the goldens and
 * the browser ever disagree, the difference is the backend and not the scene --
 * which is the only way that comparison is worth making.
 */

import { UiRoot } from '../core/root.js';
import { replay } from '../core/draw-list.js';
import { UNBOUNDED, type Size } from '../core/geom.js';
import { bakeAtlas, type Atlas } from '../render/atlas.js';
import { BODY_FONT } from '../text/font.js';
import { RasterSurface } from '../render/raster.js';
import { THEME, type Theme } from '../theme/theme.js';
import type { Widget } from '../core/widget.js';
import { ScrollView } from '../widgets/scroll-view.js';
import { buildGallery } from './gallery.js';
import { buildWindowsScene } from './windows-scene.js';
import { ContextStack } from '../core/events.js';
import { LayerStack } from '../core/layers.js';
import { WindowManager } from '../core/window-manager.js';
import { InputMap } from '../input/input-map.js';
import { KeybindingsScreen } from '../screens/keybindings.js';
import { InventoryScreen, type ContainerView, type ItemView, type SlotRef } from '../screens/inventory.js';
import { Tooltip } from '../widgets/tooltip.js';
import { UiWindow } from '../widgets/window.js';

export interface GalleryFrame {
  readonly surface: RasterSurface;
  readonly root: UiRoot;
  readonly atlas: Atlas;
  readonly parts: Readonly<Record<string, Widget>>;
}

/**
 * The viewport the goldens are taken at.
 *
 * A plausible desktop UI viewport -- 400x300 is what a 1200x900 window gives at
 * scale 3, or a 1600x1200 one at scale 4. Deliberately not the theme's
 * `minViewport`: the goldens are there to show the widgets, and the *smallest*
 * viewport is what the layout tests assert against instead.
 */
export const GOLDEN_VIEWPORT: Size = { width: 400, height: 300 };

export interface RenderOptions {
  readonly viewport?: Size;
  readonly theme?: Theme;
  /** Which widget to paint as focused, by `parts` key. */
  readonly focusKey?: string;
  /** Which widget to paint as hovered, by `parts` key. */
  readonly hoverKey?: string;
  /** Which widget to paint as pressed, by `parts` key. */
  readonly pressKey?: string;
  readonly now?: number;
  /** Scroll the gallery down before painting, so the lower half can be checked. */
  readonly scrollTo?: number;
}

/**
 * Build, lay out and rasterise the gallery.
 *
 * The forced states go through `PaintContext` rather than through the router, so
 * a golden of the pressed style needs no synthetic pointer event and cannot be
 * knocked over by a change to the drag threshold.
 */
export function renderGallery(options: RenderOptions = {}): GalleryFrame {
  const theme = options.theme ?? THEME;
  const viewport = options.viewport ?? GOLDEN_VIEWPORT;
  const atlas = bakeAtlas(theme);
  const gallery = buildGallery(theme);
  const root = new UiRoot(gallery.root, { theme, atlas, viewport });

  root.update(options.now ?? 0);
  if (options.scrollTo !== undefined) {
    const scroller = gallery.parts['galleryScroll'];
    if (scroller instanceof ScrollView) scroller.scrollTo(options.scrollTo);
    root.update(options.now ?? 0);
  }

  const surface = new RasterSurface(atlas, viewport.width, viewport.height);
  surface.clear(theme.color('ink'));

  const pick = (key: string | undefined): Widget | null =>
    key === undefined ? null : gallery.parts[key] ?? null;

  const list = root.paint();
  const context = {
    ...root.paintContext(),
    hovered: pick(options.hoverKey),
    pressed: pick(options.pressKey),
    focused: pick(options.focusKey),
  };
  // Repaint with the forced context: `root.paint()` used the live one.
  list.clear();
  gallery.root.paint(list, context);
  replay(surface, list.finish());

  return { surface, root, atlas, parts: gallery.parts };
}

export interface WindowsFrame {
  readonly surface: RasterSurface;
  readonly root: UiRoot;
  readonly atlas: Atlas;
  readonly scene: ReturnType<typeof buildWindowsScene>;
}

export interface WindowsRenderOptions {
  readonly viewport?: Size;
  readonly now?: number;
  /** Bring this window to the front before painting. */
  readonly focusWindow?: string;
  /** Select this tab in the character window. */
  readonly tab?: string;
  /** Show a tooltip anchored here, with the delay already elapsed. */
  readonly tooltipAt?: { x: number; y: number };
  readonly tooltipText?: string;
}

/**
 * The six-window scene, rasterised.
 *
 * Shares nothing with `renderGallery` except the backend, deliberately: the two
 * scenes answer different questions and a helper that did both would be a helper
 * with a mode flag.
 */
export function renderWindows(options: WindowsRenderOptions = {}): WindowsFrame {
  const theme = THEME;
  const viewport = options.viewport ?? GOLDEN_VIEWPORT;
  const atlas = bakeAtlas(theme);
  const scene = buildWindowsScene(theme, viewport);
  const root = new UiRoot(scene.root, {
    theme,
    atlas,
    viewport,
    windows: scene.manager,
    layers: scene.root,
  });

  const now = options.now ?? 0;
  if (options.tab !== undefined) scene.tabs.select(options.tab);
  if (options.focusWindow !== undefined) scene.manager.focus(options.focusWindow);
  if (options.tooltipAt !== undefined) {
    scene.tooltip.point(options.tooltipText ?? 'A tooltip that flips at the edges', options.tooltipAt, 0);
    scene.tooltip.update(theme.input.tooltipDelayMs + 1, theme.input.tooltipDelayMs);
  }
  root.update(now);

  const surface = new RasterSurface(atlas, viewport.width, viewport.height);
  surface.clear(theme.color('ink'));
  replay(surface, root.paint().finish());

  return { surface, root, atlas, scene };
}

export interface InventoryFrame {
  readonly surface: RasterSurface;
  readonly root: UiRoot;
  readonly screen: InventoryScreen;
}

export interface InventoryRenderOptions {
  readonly viewport?: Size;
  /** Pick this cell up, so the ghost is in the frame. */
  readonly pickUp?: SlotRef;
  /**
   * ...and hold it over this cell. A cell that accepts lights up; one that
   * refuses does not, which is how a refusal reads.
   *
   * A cell rather than a coordinate: the grid's gaps are four pixels wide and a
   * hand-written point lands in one of them about a fifth of the time -- which
   * produces a golden of a drag over nothing that looks exactly like a golden of
   * a highlight that stopped working.
   */
  readonly carryToCell?: SlotRef;
  /** Show the tooltip over this cell, with the delay already elapsed. */
  readonly tooltipOver?: SlotRef;
  /** Which cell to paint as focused, so the keyboard path has a picture. */
  readonly focus?: SlotRef;
}

/**
 * A demo bag, dense enough that a golden says something.
 *
 * Written here rather than taken from the game's item table: this scene is the
 * *framework's* QA surface, and a golden that moved every time somebody rebalanced
 * a sword would be a golden nobody trusted.
 */
export function demoContainers(): ContainerView {
  const bag: (ItemView | null)[] = new Array<ItemView | null>(24).fill(null);
  const put = (index: number, defId: string, name: string, icon: string, slot: string | null, count = 1): void => {
    bag[index] = { defId, name, count, slot, icon: `item:${icon}`, levelRequirement: 1 };
  };
  put(0, 'sword', 'Worn Sword', 'sword', 'mainHand');
  put(1, 'bow', 'Hunting Bow', 'bow', 'mainHand');
  put(2, 'star', 'Weighted Stars', 'star', 'mainHand');
  put(3, 'staff', 'Emberwood Staff', 'staff', 'mainHand');
  put(6, 'shield', 'Oak Shield', 'shield', 'offHand');
  put(7, 'focus', 'Quartz Focus', 'focus', 'offHand');
  put(8, 'potion', 'Minor Salve', 'potion', null, 9);
  put(13, 'legs', "Traveller's Greaves", 'legs', 'legs');
  put(19, 'mystery', 'Something Else', 'nope', null);

  return {
    bag,
    worn: {
      mainHand: { defId: 'maul', name: 'Iron Maul', count: 1, slot: 'mainHand', icon: 'item:sword', levelRequirement: 5 },
      offHand: null,
      head: { defId: 'helm', name: 'Leather Cap', count: 1, slot: 'head', icon: 'item:helm', levelRequirement: 1 },
      chest: { defId: 'jerkin', name: 'Leather Jerkin', count: 1, slot: 'chest', icon: 'item:chest', levelRequirement: 1 },
      legs: null,
      trinket: { defId: 'band', name: 'Swiftband', count: 1, slot: 'trinket', icon: 'item:trinket', levelRequirement: 3 },
    },
    slots: [
      { id: 'mainHand', label: 'Main' },
      { id: 'offHand', label: 'Off' },
      { id: 'head', label: 'Head' },
      { id: 'chest', label: 'Chest' },
      { id: 'legs', label: 'Legs' },
      { id: 'trinket', label: 'Charm' },
    ],
    level: 4,
  };
}

/**
 * The inventory window, rasterised (spec 127).
 *
 * Its own scene for the same reason the keybinding one is: the six-window scene
 * exists to measure a frame budget, and a seventh window would quietly change
 * what that number means.
 */
/**
 * What a window costs around its content: two paddings across, and the title bar
 * plus two paddings down. Mirrors `UiWindow.arrangeSelf` -- read once here so the
 * scene asks for a window that fits rather than one that clips by four pixels.
 */
const WINDOW_CHROME = {
  width: THEME.widget('window').padding * 2,
  height: BODY_FONT.height + THEME.widget('window').padding * 3,
};

export function renderInventory(options: InventoryRenderOptions = {}): InventoryFrame {
  const theme = THEME;
  const viewport = options.viewport ?? GOLDEN_VIEWPORT;
  const atlas = bakeAtlas(theme);
  const layers = new LayerStack();
  const manager = new WindowManager();
  layers.place('windows', manager);

  const screen = new InventoryScreen({ theme, hitTest: (at) => layers.hitTest(at) });
  screen.setContainers(demoContainers());
  layers.place('dragGhost', screen.ghost);

  const tooltip = new Tooltip();
  tooltip.viewport = viewport;
  layers.place('tooltip', tooltip);

  // Sized to what the screen actually wants, clamped to the viewport. A window
  // stretched to fill would make the goldens mostly empty panel, and the thing
  // being looked at is the arrangement of the cells.
  const natural = screen.measure({ maxWidth: viewport.width - 16, maxHeight: UNBOUNDED }, { theme, atlas });
  // Scrolled rather than squashed, the same answer the widget gallery reaches:
  // a linear container asked for less room than it needs will compress its
  // children, and cells drawn on top of each other misrepresent the screen. At
  // the golden viewport there is room to spare and the bars never appear.
  const scroller = new ScrollView(screen, 'inventoryScroll');
  const window = new UiWindow(scroller, {
    title: 'Inventory',
    at: { x: 8, y: 8 },
    size: {
      width: Math.min(viewport.width - 16, natural.width + WINDOW_CHROME.width),
      height: Math.min(viewport.height - 16, natural.height + WINDOW_CHROME.height),
    },
  });
  manager.register(window, 'inventory');

  const root = new UiRoot(layers, { theme, atlas, viewport, windows: manager, layers });
  // The root owns the focus manager the paint context reads, so the screen is
  // pointed at that one rather than at the placeholder it was built with --
  // otherwise a focused cell is focused in a manager nothing draws from.
  screen.focusManager = root.focus;
  manager.setViewport(viewport);
  root.update(0);

  if (options.focus !== undefined) root.focus.focus(screen.cellAt(options.focus));
  if (options.pickUp !== undefined) {
    const cell = screen.cellAt(options.pickUp);
    if (cell) {
      screen.pickUp(cell, { x: cell.rect.x + 2, y: cell.rect.y + 2 });
      const over = options.carryToCell === undefined ? null : screen.cellAt(options.carryToCell);
      if (over) {
        screen.drag.moveTo({
          x: over.rect.x + Math.floor(over.rect.width / 2),
          y: over.rect.y + Math.floor(over.rect.height / 2),
        });
      }
    }
  }
  if (options.tooltipOver !== undefined) {
    const cell = screen.cellAt(options.tooltipOver);
    if (cell) {
      tooltip.point(screen.tooltipFor(cell), { x: cell.rect.x + 8, y: cell.rect.y + 8 }, 0);
      tooltip.update(theme.input.tooltipDelayMs + 1, theme.input.tooltipDelayMs);
    }
  }
  root.update(0);

  const surface = new RasterSurface(atlas, viewport.width, viewport.height);
  surface.clear(theme.color('ink'));
  replay(surface, root.paint().finish());

  return { surface, root, screen };
}

export interface KeybindingsFrame {
  readonly surface: RasterSurface;
  readonly root: UiRoot;
  readonly screen: KeybindingsScreen;
  readonly map: InputMap;
}

export interface KeybindingsRenderOptions {
  readonly viewport?: Size;
  /** Which category tab to show. */
  readonly tab?: string;
  /** Type into the filter field. */
  readonly filter?: string;
  /** Show the row waiting for a key. */
  readonly capture?: { readonly actionId: string; readonly slot: 'primary' | 'secondary' };
  /** Rebind this action to this chord first, so a conflict notice is in the frame. */
  readonly rebind?: { readonly actionId: string; readonly code: string };
  /** Unbind this action, so the flagged state is in the frame. */
  readonly unbind?: string;
}

/**
 * The keybinding window, rasterised (spec 125).
 *
 * Its own scene rather than a seventh window in the six-window one, so the frame
 * budget that scene exists to measure keeps meaning what it says.
 */
export function renderKeybindings(options: KeybindingsRenderOptions = {}): KeybindingsFrame {
  const theme = THEME;
  const viewport = options.viewport ?? GOLDEN_VIEWPORT;
  const atlas = bakeAtlas(theme);
  const map = new InputMap();
  const contexts = new ContextStack();
  const screen = new KeybindingsScreen({ theme, map, contexts });
  screen.buildAllTabs();

  if (options.unbind !== undefined) {
    map.bind(options.unbind, 'primary', null);
    map.bind(options.unbind, 'secondary', null);
  }
  if (options.rebind !== undefined) {
    screen.beginCapture(options.rebind.actionId, 'primary');
    screen.captureKey(options.rebind.code, { shift: false, ctrl: false, alt: false, meta: false });
  }
  if (options.tab !== undefined) screen.tabs.select(options.tab);
  if (options.filter !== undefined) screen.filter.setText(options.filter);
  if (options.capture !== undefined) screen.beginCapture(options.capture.actionId, options.capture.slot);
  screen.refresh();

  const window = new UiWindow(screen, {
    title: 'Keybindings',
    at: { x: 8, y: 8 },
    size: { width: viewport.width - 16, height: viewport.height - 16 },
  });
  const manager = new WindowManager();
  const layers = new LayerStack();
  layers.place('windows', manager);
  manager.register(window, 'keybindings');

  const root = new UiRoot(layers, { theme, atlas, viewport, windows: manager, layers });
  manager.setViewport(viewport);
  root.update(0);

  const surface = new RasterSurface(atlas, viewport.width, viewport.height);
  surface.clear(theme.color('ink'));
  replay(surface, root.paint().finish());

  return { surface, root, screen, map };
}
