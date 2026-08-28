/**
 * The mark the world puts under the pointer (spec 200).
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
 * for rather than something that has to be kept at 1x.
 *
 * **They are drawn in the page, not handed to CSS as a cursor image.** The
 * first two cuts of this were a `cursor: url(...) 11 11` data URI, and on a real
 * machine the mark landed four to seven CSS pixels up and left of the point it
 * was meant to be marking -- about half the hotspot -- with the pointer provably
 * stationary. Measured off a phone recording of the screen, because neither a
 * headless screenshot nor OBS captures what the compositor draws for a cursor:
 * a hotspot is applied somewhere between the style and the glass, by a layer
 * that also has a device scale and a page zoom to apply, and CSS has no way to
 * ask what it did. Drawing the mark ourselves puts it in the one coordinate
 * space this program can see the whole of -- the pointer position it already
 * tracks -- so there is no hotspot to be right about, and, for the first time,
 * a probe can *measure* where the mark went.
 *
 * What that costs is a frame: an OS cursor is composited at pointer rate and a
 * page element is not. It is placed from the pointer event rather than from the
 * frame to keep that to the minimum a page can manage.
 *
 * Pure: no DOM, no three.js, no clock. `view.ts` asks {@link worldMark} what to
 * draw and {@link worldCursor} what the canvas should wear underneath it, and
 * decides neither.
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

/**
 * The speech bubble: what sits over a body you can talk to (spec 246).
 *
 * The one mark of the three that is a **picture rather than a reticle**, and
 * deliberately so: the other two say *where* the click lands, and this says
 * *what it does*. A crosshair variant would have had to encode "talk" in the
 * length of four arms, which is not something four arms can say.
 *
 * On the same nine-by-nine grid as the other two, so all three swap without the
 * box under the pointer changing size -- and with the same odd side, so the tail
 * can sit on the centre column and the mark still reads as pointing at one
 * pixel. A rounded box with a tail out of the bottom-left, which is the shape
 * every speech bubble in every game has been since they were drawn on paper;
 * three dots inside, because an empty box is a box and the dots are what make it
 * a *said* thing.
 *
 * The blank row top and bottom is not padding: this mark is **centred on the
 * pointer** like the other two, so what has to sit on the box's middle is the
 * bubble's own body rather than the whole drawing including its tail. Without
 * them the art's mass rides a row high, and against a mark that is meant to sit
 * *on* the body it is pointing out, a row is visible.
 */
const BUBBLE: readonly string[] = [
  '.........',
  '.#######.',
  '#.......#',
  '#.#.#.#.#',
  '#.......#',
  '.#######.',
  '..#......',
  '.#.......',
  '.........',
];

/** The art's side, in font pixels. Square, so one number covers all three. */
export const CROSSHAIR_SIDE = FULL.length;

/** Which of the three marks a caller wants. */
export type CrosshairArt = 'full' | 'small' | 'bubble';

function artFor(art: CrosshairArt): readonly string[] {
  if (art === 'full') return FULL;
  return art === 'bubble' ? BUBBLE : SMALL;
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
 * What a caller offsets the mark by to centre it on the pointer. Floored rather
 * than rounded, because a whole pixel keeps the art on the device grid and the
 * middle pixel of an odd-sided box straddles the half either way. Half a pixel
 * of offset on a 22px mark is invisible; being a whole pixel out is not.
 */
export const CROSSHAIR_CENTRE = Math.floor(CROSSHAIR_BOX / 2);

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

export interface WorldPointerInput {
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
  /**
   * True while the cursor is over a body that can be talked to (spec 246) --
   * `talkable`'s answer, the same way `overEnemy` is `attackable`'s.
   *
   * Its own field rather than folded into `overEnemy`, because the two can never
   * both be true and the *mark* is the whole point: a friendly body under the
   * pointer means something different is about to happen, and the pointer is
   * where a player looks to find that out.
   */
  readonly overNpc: boolean;
}

/**
 * Which mark to draw at the pointer, or null for none.
 *
 * The order is the order of commitment, and each step of it earns its mark. An
 * armed skill outranks everything, and it has to: while a skill is aimed a left
 * click *places* it, so a mark that said "this body" would promise something
 * the click is not going to perform. A body under the pointer is next, because
 * a click there does something to it. Everything else is unmarked -- a mark
 * that is always on says nothing by being on, and these two are only worth
 * drawing because their absence is the ordinary case.
 */
export function worldMark(input: WorldPointerInput): CrosshairArt | null {
  if (input.aiming) return 'full';
  // Ahead of `overEnemy` for clarity rather than for precedence: `attackable`
  // already refuses a friendly body, so the two can never both be true.
  if (input.overNpc) return 'bubble';
  if (input.overEnemy) return 'small';
  return null;
}

/**
 * What the canvas itself should wear underneath, in one place rather than two.
 *
 * `none` wherever we draw a mark of our own, since the point of drawing it is
 * that it is the only thing there; the drop's pointing hand (spec 158) where
 * there is no mark and something to pick up; and otherwise the empty string,
 * which is whatever the page says -- the arrow.
 *
 * Derived from {@link worldMark} rather than deciding again, so "we hid the
 * cursor" and "we drew a mark" cannot come apart. That pairing is the one way
 * this can fail badly: a hidden cursor with nothing drawn is a pointer the
 * player cannot find.
 */
export function worldCursor(input: WorldPointerInput): string {
  if (worldMark(input) !== null) return 'none';
  return input.overDrop ? 'pointer' : '';
}
