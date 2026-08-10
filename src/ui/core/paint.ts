/**
 * 9-slice frames and text runs, as `drawSprite` calls (spec 121).
 *
 * These are the functions that keep the backend interface at six methods. A
 * frame is nine quads and a string is one quad per glyph, and both decompose
 * *here* rather than in a backend -- so `raster` and `canvas2d` do not each need
 * their own idea of what a border looks like, and cannot disagree about it.
 *
 * Pure. No DOM, no clock, no backend import beyond the atlas's rect type.
 */

import type { Color } from './color.js';
import type { DrawList } from './draw-list.js';
import type { Rect } from './geom.js';
import type { Atlas, NineSlice } from '../render/atlas.js';
import { advance, glyphFor, measureText, type Font } from '../text/font.js';

/**
 * Draw a 9-slice frame to fill `dst`.
 *
 * The border is clamped to half the destination in each axis, so a frame drawn
 * into a box narrower than two borders degrades to two touching corners instead
 * of drawing them overlapping and inside out. A 1px frame in a 1px-wide box is a
 * real thing a separator does.
 */
export function drawNineSlice(
  out: DrawList,
  patch: NineSlice,
  dst: Rect,
  tint: Color,
): void {
  const src = patch.bounds;
  if (src.width <= 0 || src.height <= 0 || dst.width <= 0 || dst.height <= 0) return;

  const b = Math.max(0, Math.min(patch.border, Math.floor(dst.width / 2), Math.floor(dst.height / 2)));
  if (b === 0) {
    // No room for corners: stretch the whole patch and let it read as a fill.
    out.sprite(src, dst, tint);
    return;
  }

  const sb = patch.border;
  const srcMidW = Math.max(1, src.width - sb * 2);
  const srcMidH = Math.max(1, src.height - sb * 2);
  const midW = dst.width - b * 2;
  const midH = dst.height - b * 2;

  const cols: readonly { sx: number; sw: number; dx: number; dw: number }[] = [
    { sx: src.x, sw: sb, dx: dst.x, dw: b },
    { sx: src.x + sb, sw: srcMidW, dx: dst.x + b, dw: midW },
    { sx: src.x + src.width - sb, sw: sb, dx: dst.x + dst.width - b, dw: b },
  ];
  const rows: readonly { sy: number; sh: number; dy: number; dh: number }[] = [
    { sy: src.y, sh: sb, dy: dst.y, dh: b },
    { sy: src.y + sb, sh: srcMidH, dy: dst.y + b, dh: midH },
    { sy: src.y + src.height - sb, sh: sb, dy: dst.y + dst.height - b, dh: b },
  ];

  for (const row of rows) {
    if (row.dh <= 0) continue;
    for (const col of cols) {
      if (col.dw <= 0) continue;
      out.sprite(
        { x: col.sx, y: row.sy, width: col.sw, height: row.sh },
        { x: col.dx, y: row.dy, width: col.dw, height: row.dh },
        tint,
      );
    }
  }
}

/**
 * Draw `text` with its top-left at (x, y).
 *
 * Whitespace emits no quad: a space's glyph is empty, and skipping it here keeps
 * a paragraph's draw-call count proportional to its ink rather than its length.
 */
export function drawText(
  out: DrawList,
  atlas: Atlas,
  font: Font,
  text: string,
  x: number,
  y: number,
  color: Color,
): void {
  const step = advance(font);
  let pen = x;
  for (const character of text) {
    if (character !== ' ') {
      const glyph = glyphFor(font, character);
      if (glyph.lit.some(Boolean)) {
        out.sprite(
          atlas.glyph(font, character),
          { x: pen, y, width: font.width, height: font.height },
          color,
        );
      }
    }
    pen += step;
  }
}

/**
 * Draw `text`, clipped to `box` -- but only pushing a clip when it is needed.
 *
 * A widget squeezed narrower than its label still draws the whole label, so
 * without this the overflow runs straight across its neighbour and reads as two
 * broken widgets instead of one that did not fit. Clipping conditionally matters:
 * a clip is two draw-list commands and the overwhelming majority of labels fit,
 * so paying for it always would double the command count of a text-heavy screen
 * to solve a problem it does not have.
 */
export function drawTextClipped(
  out: DrawList,
  atlas: Atlas,
  font: Font,
  text: string,
  x: number,
  y: number,
  color: Color,
  box: Rect,
): void {
  const width = measureText(font, text);
  const overflows =
    x < box.x || y < box.y || x + width > box.x + box.width || y + font.height > box.y + box.height;
  if (overflows) out.pushClip(box);
  drawText(out, atlas, font, text, x, y, color);
  if (overflows) out.popClip();
}

export type HorizontalAlign = 'start' | 'center' | 'end';

/** The x a run of `text` starts at to sit `align`ed within `box`. */
export function alignTextX(font: Font, text: string, box: Rect, align: HorizontalAlign): number {
  const width = measureText(font, text);
  if (align === 'start') return box.x;
  if (align === 'end') return box.x + box.width - width;
  // Floored rather than rounded: a half-pixel offset would land the whole run
  // off the grid, and every glyph in it with the run.
  return box.x + Math.floor((box.width - width) / 2);
}

/** The y a single line sits at to be vertically centred in `box`. */
export function centerTextY(font: Font, box: Rect): number {
  return box.y + Math.floor((box.height - font.height) / 2);
}

/** Draw a 1px outline just outside `rect`, for the focus ring. */
export function drawFocusRing(out: DrawList, atlas: Atlas, rect: Rect, tint: Color): void {
  const patch = atlas.patch('focusRing');
  drawNineSlice(
    out,
    patch,
    { x: rect.x - 1, y: rect.y - 1, width: rect.width + 2, height: rect.height + 2 },
    tint,
  );
}
