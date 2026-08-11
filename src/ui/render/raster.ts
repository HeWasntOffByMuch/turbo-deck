/**
 * The software backend, and the reason the goldens are exact (spec 123).
 *
 * Writes RGBA bytes into a `Uint8Array` with no GPU, no canvas and no browser,
 * which makes it the one backend a vitest run can drive. Every golden image in
 * the suite is this backend's output, so a screen is compared byte for byte in
 * `npm test` rather than photographed and eyeballed -- the thing every existing
 * `preview-*.ts` script in this repo cannot do, and the reason none of them run
 * in CI.
 *
 * It is not a test double. It is a full implementation of the six methods, and
 * having two unrelated ones is what turns "the backend is swappable" from a
 * claim into a fact about the module graph.
 *
 * Sampling is nearest-neighbour, computed per destination pixel. That is the
 * same rule `image-rendering: pixelated` is defined as, which is what lets
 * `canvas2d`'s output be asserted equal to this one's.
 */

import { over, type Color } from '../core/color.js';
import { intersect, isEmptyRect, snapRect, type Rect } from '../core/geom.js';
import type { AtlasRect } from './atlas.js';
import { TintCache, type Atlas } from './atlas.js';
import type { UiSurface } from './surface.js';

export class RasterSurface implements UiSurface {
  readonly width: number;
  readonly height: number;
  /** RGBA, straight alpha, row-major. */
  readonly pixels: Uint8Array;

  private readonly clips: Rect[] = [];
  private readonly tints: TintCache;
  private readonly atlas: Atlas;

  constructor(atlas: Atlas, width: number, height: number) {
    this.atlas = atlas;
    this.width = Math.max(1, Math.floor(width));
    this.height = Math.max(1, Math.floor(height));
    this.pixels = new Uint8Array(this.width * this.height * 4);
    this.tints = new TintCache(atlas);
  }

  /** The whole buffer cleared to `color`, or to transparent when omitted. */
  clear(color?: Color): void {
    if (!color) {
      this.pixels.fill(0);
      return;
    }
    for (let i = 0; i < this.pixels.length; i += 4) {
      this.pixels[i] = color.r;
      this.pixels[i + 1] = color.g;
      this.pixels[i + 2] = color.b;
      this.pixels[i + 3] = color.a;
    }
  }

  beginFrame(): void {
    this.clips.length = 0;
  }

  endFrame(): void {
    if (this.clips.length !== 0) throw new Error('raster: frame ended with an unbalanced clip stack');
  }

  pushClip(rect: Rect): void {
    const snapped = snapRect(rect);
    const current = this.currentClip();
    this.clips.push(intersect(current, snapped));
  }

  popClip(): void {
    if (this.clips.length === 0) throw new Error('raster: popClip with no matching pushClip');
    this.clips.pop();
  }

  drawSolid(dst: Rect, color: Color): void {
    if (color.a === 0) return;
    const area = intersect(snapRect(dst), this.currentClip());
    if (isEmptyRect(area)) return;
    for (let y = area.y; y < area.y + area.height; y++) {
      for (let x = area.x; x < area.x + area.width; x++) {
        this.blend(x, y, color);
      }
    }
  }

  /**
   * Nearest-neighbour blit, with the source coordinate derived from the
   * destination pixel's position *within the unclipped destination rect*.
   *
   * Deriving it from the unclipped rect is the whole trick: a sprite half off
   * the edge of a scroll view must show the same pixels it would have shown
   * whole, just fewer of them. Deriving from the clipped rect would resample the
   * visible part to fill the smaller box, so a list item would visibly stretch
   * as it scrolled under the top edge.
   */
  drawSprite(src: AtlasRect, dst: Rect, tint: Color): void {
    if (src.width <= 0 || src.height <= 0) return;
    const full = snapRect(dst);
    if (isEmptyRect(full)) return;
    const area = intersect(full, this.currentClip());
    if (isEmptyRect(area)) return;

    const pixels = this.tints.get(tint);
    const atlasWidth = this.atlas.width;

    for (let y = area.y; y < area.y + area.height; y++) {
      const v = Math.min(src.height - 1, Math.floor(((y - full.y) * src.height) / full.height));
      const row = (src.y + v) * atlasWidth;
      for (let x = area.x; x < area.x + area.width; x++) {
        const u = Math.min(src.width - 1, Math.floor(((x - full.x) * src.width) / full.width));
        const offset = (row + src.x + u) * 4;
        const alpha = pixels[offset + 3] ?? 0;
        if (alpha === 0) continue;
        this.blend(x, y, {
          r: pixels[offset] ?? 0,
          g: pixels[offset + 1] ?? 0,
          b: pixels[offset + 2] ?? 0,
          a: alpha,
        });
      }
    }
  }

  /** The pixel at (x, y), for tests and for the cross-backend comparison. */
  pixelAt(x: number, y: number): Color {
    const offset = (y * this.width + x) * 4;
    return {
      r: this.pixels[offset] ?? 0,
      g: this.pixels[offset + 1] ?? 0,
      b: this.pixels[offset + 2] ?? 0,
      a: this.pixels[offset + 3] ?? 0,
    };
  }

  private currentClip(): Rect {
    return this.clips[this.clips.length - 1] ?? { x: 0, y: 0, width: this.width, height: this.height };
  }

  private blend(x: number, y: number, source: Color): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const offset = (y * this.width + x) * 4;
    const existing = this.pixels[offset + 3] ?? 0;
    // The overwhelmingly common case in a flat UI: an opaque colour over
    // anything, or anything over an empty pixel. Both skip the blend entirely.
    if (source.a === 255 || existing === 0) {
      this.pixels[offset] = source.r;
      this.pixels[offset + 1] = source.g;
      this.pixels[offset + 2] = source.b;
      this.pixels[offset + 3] = source.a;
      return;
    }
    const blended = over(source, {
      r: this.pixels[offset] ?? 0,
      g: this.pixels[offset + 1] ?? 0,
      b: this.pixels[offset + 2] ?? 0,
      a: existing,
    });
    this.pixels[offset] = blended.r;
    this.pixels[offset + 1] = blended.g;
    this.pixels[offset + 2] = blended.b;
    this.pixels[offset + 3] = blended.a;
  }
}
