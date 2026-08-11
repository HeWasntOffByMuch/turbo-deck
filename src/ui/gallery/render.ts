/**
 * Render the gallery to pixels, in Node (spec 121).
 *
 * One function, shared by the golden-image test, the PNG writer and the browser
 * preview, so that all three are looking at the same frame. If the goldens and
 * the browser ever disagree, the difference is the backend and not the scene --
 * which is the only way that comparison is worth making.
 */

import { UiRoot } from '../core/root.js';
import { replay } from '../core/draw-list.js';
import type { Size } from '../core/geom.js';
import { bakeAtlas, type Atlas } from '../render/atlas.js';
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
 * The keybinding window, rasterised (spec 123).
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
