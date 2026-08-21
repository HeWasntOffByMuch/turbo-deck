/**
 * The mouse cursor while a skill is being aimed (spec 197).
 *
 * A hotbar press starts an *aim* (spec 080): the shape of the blow is drawn on
 * the ground and the game waits for the click that answers it. What was left
 * pointing at that decision was the browser's own arrow -- the one thing on
 * screen that belongs to the operating system rather than to this game, and the
 * one thing whose tip is not where the click will land.
 *
 * So while an aim is pending the canvas wears a crosshair, authored the way
 * `pixel-font.ts` is authored and for the same three reasons: nothing may be
 * fetched, a bitmap is a binary blob nobody can review in a diff, and a table of
 * `#` is the same register as the posterized world behind it. It is rendered as
 * axis-aligned rects with `shape-rendering: crispEdges`, so it is exact at
 * whatever scale it is asked for rather than something that has to be kept at
 * 1x, and handed to CSS as a data URI with the hotspot named -- the *middle
 * pixel*, which is why the art is odd-sided and has a centre to name at all.
 *
 * Two limits the size is chosen against, both of them the browser's: a cursor
 * image over 32px square is refused outright by some engines, and an SVG cursor
 * is not honoured at all by others. The first is why the drawn box is 22px; the
 * second is why every value here ends in a keyword fallback, so a browser that
 * drops the image still gets a crosshair rather than an arrow.
 *
 * Pure: no DOM, no three.js, no clock. `view.ts` assigns what
 * {@link worldCursor} returns to `canvas.style.cursor` and decides nothing.
 */

import type { PixelRect } from './pixel-font.js';

/**
 * Nine by nine, `#` for a lit pixel.
 *
 * The four pixels around the centre are dark on purpose: a crosshair whose arms
 * meet is a plus sign, and the gap is the whole reason a mark can sit on top of
 * what it is pointing at and still leave it readable. Odd-sided, so there is a
 * centre pixel for the hotspot to be.
 */
const CROSSHAIR: readonly string[] = [
  '....#....',
  '....#....',
  '....#....',
  '.........',
  '###.#.###',
  '.........',
  '....#....',
  '....#....',
  '....#....',
];

/** The art's side, in font pixels. Square, so one number covers both. */
export const CROSSHAIR_SIDE = CROSSHAIR.length;

/** One rect per lit pixel, origin at the top left, in font-pixel coordinates. */
export function crosshairRects(): readonly PixelRect[] {
  const rects: PixelRect[] = [];
  for (let row = 0; row < CROSSHAIR.length; row++) {
    const line = CROSSHAIR[row];
    if (!line) continue;
    for (let column = 0; column < line.length; column++) {
      if (line[column] !== '#') continue;
      rects.push({ x: column, y: row, w: 1, h: 1 });
    }
  }
  return rects;
}

/** One SVG path `d` covering every lit pixel. */
export function crosshairPath(): string {
  return crosshairRects()
    .map((rect) => `M${rect.x} ${rect.y}h${rect.w}v${rect.h}h-${rect.w}z`)
    .join('');
}

export interface CrosshairOptions {
  /** Screen pixels per font pixel. 2 gives the 22x22 the cursor is drawn at. */
  readonly scale?: number;
  readonly fill?: string;
  /** Outline colour. One font-pixel thick, drawn behind the fill. */
  readonly outline?: string;
}

/** Screen pixels per font pixel, and the box that comes out at that scale. */
export const CROSSHAIR_SCALE = 2;
/** One font pixel of margin on every side, for the outline to live in. */
const MARGIN = 1;
/** The drawn side in screen pixels. Under 32, which is the cursor size floor. */
export const CROSSHAIR_BOX = (CROSSHAIR_SIDE + MARGIN * 2) * CROSSHAIR_SCALE;

/**
 * Where the click lands, in the drawn image: the centre pixel's own middle.
 *
 * Floored rather than rounded, because CSS wants whole pixels and the middle
 * pixel of an odd-sided box straddles the half. Half a pixel of offset on a
 * 22px mark is invisible; being a whole pixel out on every cast is not.
 */
export const CROSSHAIR_HOTSPOT = Math.floor(CROSSHAIR_BOX / 2);

/** The aim's own colour, `scene.ts`'s AIM_COLOR, so the mark and the shape agree. */
export const CROSSHAIR_FILL = '#7fd4ff';
const CROSSHAIR_OUTLINE = '#0a0e14';

/**
 * The crosshair as a self-contained `<svg>` element.
 *
 * The outline is eight offset copies of the same path rather than a stroke, for
 * the reason `pixelTextSvg` gives: a stroke rounds and bleeds at the corners,
 * which is exactly the look a pixel mark exists to avoid. It matters more for a
 * cursor than for a number, because this is drawn over grass, over water, over
 * snow and over a body, and a mark that disappears against one of them is a
 * mark that cannot be trusted against any of them.
 */
export function crosshairSvg(options: CrosshairOptions = {}): string {
  const scale = options.scale ?? CROSSHAIR_SCALE;
  const fill = options.fill ?? CROSSHAIR_FILL;
  const outline = options.outline ?? CROSSHAIR_OUTLINE;

  const path = crosshairPath();
  const box = CROSSHAIR_SIDE + MARGIN * 2;

  const offsets: readonly (readonly [number, number])[] = [
    [-1, -1], [0, -1], [1, -1],
    [-1, 0], [1, 0],
    [-1, 1], [0, 1], [1, 1],
  ];
  const shadow = offsets
    .map(([dx, dy]) => `<path d="${path}" fill="${outline}" transform="translate(${dx} ${dy})"/>`)
    .join('');

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${box * scale}" ` +
    `height="${box * scale}" viewBox="0 0 ${box} ${box}" ` +
    'shape-rendering="crispEdges" style="display:block">' +
    `<g transform="translate(${MARGIN} ${MARGIN})">${shadow}<path d="${path}" fill="${fill}"/></g>` +
    '</svg>'
  );
}

/**
 * The whole CSS `cursor` value: the image, its hotspot, and a keyword behind it.
 *
 * `encodeURIComponent` rather than base64, so what ships is the same markup the
 * table above produces and a stylesheet somebody is reading in devtools still
 * says what it draws. The keyword is not decoration: an engine that refuses SVG
 * cursors, or a cursor image at all, falls through to it, and `crosshair` is the
 * one keyword that means what this means.
 */
export function crosshairCursor(options: CrosshairOptions = {}): string {
  const svg = encodeURIComponent(crosshairSvg(options))
    // `encodeURIComponent` leaves the two brackets alone, and the markup is full
    // of them -- every `translate(1 1)` in the outline. Inside a *quoted* url()
    // that is legal and this is quoted, so the escape buys nothing today; it is
    // here so that the value stays one token whoever pastes it where, which is
    // the whole reason a data URI is preferable to a fetch in the first place.
    .replaceAll('(', '%28')
    .replaceAll(')', '%29');
  return `url("data:image/svg+xml,${svg}") ${CROSSHAIR_HOTSPOT} ${CROSSHAIR_HOTSPOT}, crosshair`;
}

/** Built once: the art is constant, and a data URI rebuilt per frame is churn. */
const AIM_CURSOR = crosshairCursor();

export interface WorldCursorInput {
  /**
   * True while a hotbar press is waiting for the click that places it -- the one
   * state in which the pointer is being used to *choose a point* (spec 080).
   *
   * A confirmed order is deliberately not this: the aim has been answered, the
   * body is walking into range, and the pointer is back to being a pointer.
   */
  readonly aiming: boolean;
  /**
   * True while the cursor is over a drop (spec 158) -- the one thing in the
   * world with no other affordance saying it can be clicked.
   */
  readonly overDrop: boolean;
}

/**
 * What the canvas's `cursor` should be, in one place rather than two.
 *
 * The aim wins over the drop, and it has to: while a skill is aimed a left
 * click places it, so a pointing hand would promise a pickup the click is not
 * going to perform. Empty string is "whatever the page says", which is what
 * this was before either rule existed.
 */
export function worldCursor(input: WorldCursorInput): string {
  if (input.aiming) return AIM_CURSOR;
  return input.overDrop ? 'pointer' : '';
}
