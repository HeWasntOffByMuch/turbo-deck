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
