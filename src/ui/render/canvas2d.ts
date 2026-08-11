/**
 * The browser backend (spec 123).
 *
 * The **only** file under `src/ui/` that touches the DOM, which is the whole
 * point of the layer split -- and it is a hundred lines, which is what makes the
 * portability claim credible rather than aspirational.
 *
 * Why canvas2d and not WebGL, for now: the frame budget is what decides it and
 * the measurement does not exist yet, so the version that ships first is the one
 * with no shader to fail and no GL state entangled with the world's
 * post-processing chain. `drawImage` with smoothing off, at integer coordinates,
 * is a plain blit -- the same rule `raster.ts` implements -- which is what lets
 * the two be asserted byte-identical. When the budget says otherwise, a WebGL
 * backend implements the same six methods and nothing above here changes.
 *
 * There is also a correctness dividend. A separate canvas stacked over the world
 * canvas composites *after* the retro pass by construction; a WebGL backend
 * sharing the framebuffer has to be drawn after it deliberately, which is
 * exactly the mistake spec 101 shipped once.
 */

import { colorKey, toCss, WHITE, type Color } from '../core/color.js';
import { intersect, isEmptyRect, snapRect, type Rect } from '../core/geom.js';
import type { AtlasRect } from './atlas.js';
import { TintCache, type Atlas } from './atlas.js';
import type { UiSurface } from './surface.js';

/** The 2D context features this backend needs. Narrowed so it can be faked. */
type Context2D = CanvasRenderingContext2D;

export interface Canvas2dOptions {
  /** Device pixels per UI pixel. The canvas is scaled by this, not the content. */
  readonly scale: number;
}

export class Canvas2dSurface implements UiSurface {
  width: number;
  height: number;

  private readonly context: Context2D;
  private readonly tints: TintCache;
  private readonly tinted = new Map<string, HTMLCanvasElement>();
  private readonly clips: Rect[] = [];
  private scale: number;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly atlas: Atlas,
    width: number,
    height: number,
    options: Canvas2dOptions,
  ) {
    const context = canvas.getContext('2d', { alpha: true });
    if (!context) throw new Error('canvas2d: no 2d context');
    this.context = context;
    this.tints = new TintCache(atlas);
    this.width = Math.max(1, Math.floor(width));
    this.height = Math.max(1, Math.floor(height));
    this.scale = Math.max(1, Math.floor(options.scale));
    this.applySize();
  }

  /** Resize the viewport and/or change the scale. */
  resize(width: number, height: number, scale: number): void {
    this.width = Math.max(1, Math.floor(width));
    this.height = Math.max(1, Math.floor(height));
    this.scale = Math.max(1, Math.floor(scale));
    this.applySize();
  }

  private applySize(): void {
    // The backing store is in device pixels and the transform does the upscale,
    // so every draw below is in UI pixels and lands on a whole multiple of them.
    this.canvas.width = this.width * this.scale;
    this.canvas.height = this.height * this.scale;
    this.canvas.style.width = `${this.canvas.width}px`;
    this.canvas.style.height = `${this.canvas.height}px`;
    this.canvas.style.imageRendering = 'pixelated';
  }

  beginFrame(): void {
    const context = this.context;
    // Unwind anything a previous frame left on the canvas state stack before
    // touching the transform, or a leaked `save` narrows this frame too.
    while (this.clips.length > 0) {
      context.restore();
      this.clips.pop();
    }
    context.setTransform(this.scale, 0, 0, this.scale, 0, 0);
    context.imageSmoothingEnabled = false;
    context.clearRect(0, 0, this.width, this.height);
  }

  endFrame(): void {
    if (this.clips.length !== 0) throw new Error('canvas2d: frame ended with an unbalanced clip stack');
  }

  /**
   * Clipping is `save`/`clip` and `restore`, and it has to be.
   *
   * A 2D canvas clip can only ever *narrow*: `ctx.clip()` intersects with what is
   * already in force and there is no call that widens it again. Resetting the
   * transform does not reset it either -- the transform and the clip region are
   * separate pieces of state.
   *
   * This was not obvious and it was not free. The first version of this file
   * recomputed the intersection itself and re-applied it after every pop, exactly
   * as `raster.ts` does, which looks symmetrical and is wrong: after the first
   * `popClip` the canvas was still clipped to the narrowest rect any widget had
   * asked for, so everything drawn afterwards was quietly cropped. The software
   * rasterizer was right, the browser was wrong, and nothing in `npm test` could
   * tell -- it took the cross-backend comparison in `scripts/preview-ui-gallery.ts`
   * to surface it, as one pixel of the wrong colour in a scrollbar.
   *
   * The stack below is kept anyway: it detects an unbalanced push and it keeps
   * `currentClip()` answerable, which `beginFrame` needs to unwind cleanly.
   */
  pushClip(rect: Rect): void {
    const snapped = snapRect(rect);
    this.clips.push(intersect(this.currentClip(), snapped));
    const context = this.context;
    context.save();
    const path = new Path2D();
    path.rect(snapped.x, snapped.y, snapped.width, snapped.height);
    context.clip(path);
  }

  popClip(): void {
    if (this.clips.length === 0) throw new Error('canvas2d: popClip with no matching pushClip');
    this.clips.pop();
    this.context.restore();
  }

  drawSolid(dst: Rect, color: Color): void {
    if (color.a === 0) return;
    const area = snapRect(dst);
    if (isEmptyRect(area)) return;
    this.context.fillStyle = toCss(color);
    this.context.fillRect(area.x, area.y, area.width, area.height);
  }

  drawSprite(src: AtlasRect, dst: Rect, tint: Color): void {
    if (src.width <= 0 || src.height <= 0) return;
    const area = snapRect(dst);
    if (isEmptyRect(area)) return;
    const sheet = this.sheetFor(tint);
    this.context.drawImage(
      sheet,
      src.x,
      src.y,
      src.width,
      src.height,
      area.x,
      area.y,
      area.width,
      area.height,
    );
  }

  /**
   * One canvas per tint colour, built from the same bytes `raster.ts` uses.
   *
   * Sharing `TintCache` is not a convenience: a tint applied by two different
   * rules would differ in the last bit and nowhere else, which is the hardest
   * kind of mismatch to find.
   */
  private sheetFor(tint: Color): HTMLCanvasElement {
    const key = colorKey(tint);
    const cached = this.tinted.get(key);
    if (cached) return cached;

    const sheet = this.canvas.ownerDocument.createElement('canvas');
    sheet.width = this.atlas.width;
    sheet.height = this.atlas.height;
    const context = sheet.getContext('2d');
    if (!context) throw new Error('canvas2d: no 2d context for the atlas');
    const image = context.createImageData(this.atlas.width, this.atlas.height);
    image.data.set(colorKey(tint) === colorKey(WHITE) ? this.atlas.pixels : this.tints.get(tint));
    context.putImageData(image, 0, 0);
    this.tinted.set(key, sheet);
    return sheet;
  }

  private currentClip(): Rect {
    return this.clips[this.clips.length - 1] ?? { x: 0, y: 0, width: this.width, height: this.height };
  }
}
