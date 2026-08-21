/**
 * The mark the world puts under the pointer (spec 197).
 *
 * Two of them, and they are the same mark at two lengths. The **small** one --
 * a centre dot and the four arm tips -- says there is a body under the pointer
 * that a click would act on. The **full** one -- the arms extended to the edge
 * of the same box -- says a skill is armed and the next click places it
 * (spec 080). Everywhere else the page's own arrow stands, because a pointer
 * that never changes says nothing, and what these two are for is saying
 * something.
 *
 * They are authored the way `pixel-font.ts` is authored and for the same three
 * reasons: nothing may be fetched, a bitmap is a binary blob nobody can review
 * in a diff, and a table of `#` is the same register as the posterized world
 * behind it. Rendered as axis-aligned rects with
 * `shape-rendering: crispEdges`, so each is exact at whatever scale it is asked
 * for rather than something that has to be kept at 1x, and handed to CSS as a
 * data URI with the hotspot named -- the *middle pixel*, which is why the art
 * is odd-sided and has a centre to name at all.
 *
 * The one thing the pair guarantees is that **going from the small mark to the
 * full one moves nothing**: same box, same hotspot, and every pixel the small
 * one lights the full one lights too, so arming a skill over a body you were
 * already pointing at extends the arms and shifts not one pixel. A cursor image
 * is placed by its hotspot, so two marks that disagreed about theirs would jump
 * against each other -- which is exactly what the arrow does, its hotspot being
 * its tip where a crosshair's is its centre. That jump is accepted where the
 * arrow hands over, because that is a deliberate hover onto a body, and refused
 * between these two, because that is a key press in the middle of a fight.
 *
 * Two of the browser's limits shape the size and both are stated rather than
 * discovered: a cursor image over 32px square is refused outright by some
 * engines, which is why the drawn box is 22, and an SVG cursor is not honoured
 * at all by others, which is why every value here ends in a keyword fallback.
 *
 * Pure: no DOM, no three.js, no clock. `view.ts` assigns what
 * {@link worldCursor} returns to `canvas.style.cursor` and decides nothing.
 */

import type { PixelRect } from './pixel-font.js';

/**
 * The full crosshair: nine by nine, `#` for a lit pixel.
 *
 * The four pixels around the centre are dark on purpose: a crosshair whose arms
 * meet is a plus sign, and the gap is the whole reason a mark can sit on top of
 * what it is pointing at and still leave it readable. Odd-sided, so there is a
 * centre pixel for the hotspot to be.
 */
const FULL: readonly string[] = [
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

/**
 * The small mark: the four arm *tips*, and the centre dot.
 *
 * What a body under the pointer gets. It is not a second design -- it is the
 * crosshair above with its arms pulled in, on the same grid, so that arming a
 * skill over that body reads as the arms extending out of a mark that was
 * already there. Sparse on purpose: what a player is looking at is the body it
 * is sitting on, and a mark that filled the same box solidly would be in front
 * of the thing it is pointing out.
 */
const SMALL: readonly string[] = [
  '....#....',
  '.........',
  '.........',
  '.........',
  '#...#...#',
  '.........',
  '.........',
  '.........',
  '....#....',
];

/** The art's side, in font pixels. Square, so one number covers both. */
export const CROSSHAIR_SIDE = FULL.length;

/** Which of the two marks a caller wants. */
export type CrosshairArt = 'full' | 'small';

function artFor(art: CrosshairArt): readonly string[] {
  return art === 'full' ? FULL : SMALL;
}

/** One rect per lit pixel, origin at the top left, in font-pixel coordinates. */
export function crosshairRects(art: CrosshairArt = 'full'): readonly PixelRect[] {
  const rows = artFor(art);
  const rects: PixelRect[] = [];
  for (let row = 0; row < rows.length; row++) {
    const line = rows[row];
    if (!line) continue;
    for (let column = 0; column < line.length; column++) {
      if (line[column] !== '#') continue;
      rects.push({ x: column, y: row, w: 1, h: 1 });
    }
  }
  return rects;
}

/** One SVG path `d` covering every lit pixel. */
export function crosshairPath(art: CrosshairArt = 'full'): string {
  return crosshairRects(art)
    .map((rect) => `M${rect.x} ${rect.y}h${rect.w}v${rect.h}h-${rect.w}z`)
    .join('');
}

export interface CrosshairOptions {
  /** Which mark: the full crosshair, or the same one with its arms pulled in. */
  readonly art?: CrosshairArt;
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

  const path = crosshairPath(options.art ?? 'full');
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

/** Built once each: the art is constant, and a data URI rebuilt per frame is churn. */
const FULL_CURSOR = crosshairCursor({ art: 'full' });
const SMALL_CURSOR = crosshairCursor({ art: 'small' });

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
   * True while the cursor is over a body a click would act on -- `attackable`'s
   * answer, so the mark and what the button actually does cannot disagree.
   */
  readonly overEnemy: boolean;
  /**
   * True while the cursor is over a drop (spec 158) -- the one thing in the
   * world with no other affordance saying it can be clicked.
   */
  readonly overDrop: boolean;
}

/**
 * Every cursor this file can return, for the test that asserts the two marks
 * name the same hotspot -- which is what makes going from one to the other
 * positionless.
 */
export const WORLD_CURSORS = { full: FULL_CURSOR, small: SMALL_CURSOR } as const;

/**
 * What the canvas's `cursor` should be, in one place rather than three.
 *
 * The order is the order of commitment, and each step of it earns its mark. An
 * armed skill outranks everything, and it has to: while a skill is aimed a left
 * click *places* it, so a pointing hand -- or a mark that said "this body" --
 * would promise something the click is not going to perform. A body under the
 * pointer is next, because a click there does something to it. The drop's hand
 * is last of the three and is spec 158's, kept as it was.
 *
 * Everything else is the empty string: whatever the page says, which is the
 * arrow. A mark that is always on says nothing by being on, and these two are
 * only worth drawing because their absence is the ordinary case.
 */
export function worldCursor(input: WorldCursorInput): string {
  if (input.aiming) return FULL_CURSOR;
  if (input.overEnemy) return SMALL_CURSOR;
  return input.overDrop ? 'pointer' : '';
}
