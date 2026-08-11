/**
 * The entire graphics API surface, in six methods (spec 123).
 *
 * This is the whole of what a backend has to implement. 9-slice frames, text
 * runs, borders, focus rings and the drag ghost are all *core* functions that
 * decompose into `drawSprite` calls, and text is measured from the glyph tables
 * rather than asked of the backend -- so a port implements the six below and
 * inherits every widget, every layout and every golden image.
 *
 * It is small on purpose. The brief asks for engine portability because a Godot
 * migration is on the table, and a portability claim is only worth what the
 * porting surface is small enough to make credible. Six methods is credible.
 *
 * The proof that it is real, rather than aspirational, is that there are already
 * two implementations with nothing in common: `raster.ts` writes bytes into a
 * `Uint8Array` in Node, and `canvas2d.ts` calls `drawImage` in a browser.
 */

import type { Color } from '../core/color.js';
import type { Rect } from '../core/geom.js';
import type { AtlasRect } from './atlas.js';

export interface UiSurface {
  /** The viewport, in UI pixels. */
  readonly width: number;
  readonly height: number;
  beginFrame(): void;
  /** Intersected with the current clip, never replacing it. */
  pushClip(rect: Rect): void;
  popClip(): void;
  /** `tint` multiplies. {@link WHITE} leaves the sprite exactly as baked. */
  drawSprite(src: AtlasRect, dst: Rect, tint: Color): void;
  drawSolid(dst: Rect, color: Color): void;
  endFrame(): void;
}
