/**
 * A pixel font, as data (spec 065).
 *
 * Damage numbers were drawn in the browser's monospace UI font, floating over a
 * deliberately posterized, low-resolution world. Nothing else on screen looked
 * like that.
 *
 * There is no font to reach for: the repo vendors none, nothing may be fetched,
 * and a webfont is a binary blob nobody can review in a diff. So the glyphs are
 * a table — five columns by seven rows, one string per row, `#` for a lit pixel.
 * That is small enough to read, small enough to edit, and it is the same
 * register as the blocky world behind it.
 *
 * Rendered as a single SVG path of axis-aligned rectangles with
 * `shape-rendering: crispEdges`, so it is exact at any size instead of being a
 * bitmap someone has to keep at 1x.
 *
 * Pure: no DOM, no three.js. `pixelTextSvg` returns a string.
 */

export const GLYPH_WIDTH = 5;
export const GLYPH_HEIGHT = 7;
/** Blank columns between glyphs, in pixels. */
export const GLYPH_SPACING = 1;

/**
 * Every character the HUD can emit: the digits, a sign for heals and negatives,
 * a bang for a critical, since spec 143 the capitals, a colon and a full stop,
 * because the refusal stack in the corner draws words, and since spec 163 a
 * slash, a percent and a pair of brackets, because the bottom band draws
 * quantities -- "179 / 218", "62.4%", "(312 / 926 XP)". Anything else falls back
 * to a solid block, which is visibly wrong rather than invisibly missing.
 *
 * One case, deliberately. A lower case would double the table for the benefit of
 * one screen, and every caller here is a short shout: a damage number, or
 * `SLASH: ON COOLDOWN`. `ErrorLog` uppercases before it gets this far.
 */
const GLYPHS: Readonly<Record<string, readonly string[]>> = {
  '0': ['.###.', '#...#', '#..##', '#.#.#', '##..#', '#...#', '.###.'],
  '1': ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  '2': ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
  '3': ['####.', '....#', '....#', '.###.', '....#', '....#', '####.'],
  '4': ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
  '5': ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
  '6': ['..##.', '.#...', '#....', '####.', '#...#', '#...#', '.###.'],
  '7': ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
  '8': ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'],
  '9': ['.###.', '#...#', '#...#', '.####', '....#', '...#.', '.##..'],
  '+': ['.....', '..#..', '..#..', '#####', '..#..', '..#..', '.....'],
  '-': ['.....', '.....', '.....', '#####', '.....', '.....', '.....'],
  '!': ['..#..', '..#..', '..#..', '..#..', '..#..', '.....', '..#..'],
  ':': ['.....', '..#..', '..#..', '.....', '..#..', '..#..', '.....'],
  // Spec 163's four: the bottom band draws "179 / 218", "62.4%" and
  // "(312 / 926 XP)", and every character a HUD emits has to have a glyph or it
  // comes out as the solid block.
  '/': ['....#', '....#', '...#.', '..#..', '.#...', '#....', '#....'],
  '%': ['##..#', '##..#', '...#.', '..#..', '.#...', '#..##', '#..##'],
  '(': ['..##.', '.#...', '#....', '#....', '#....', '.#...', '..##.'],
  ')': ['.##..', '...#.', '....#', '....#', '....#', '...#.', '.##..'],
  '.': ['.....', '.....', '.....', '.....', '.....', '..#..', '..#..'],
  ' ': ['.....', '.....', '.....', '.....', '.....', '.....', '.....'],
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  B: ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'],
  C: ['.###.', '#...#', '#....', '#....', '#....', '#...#', '.###.'],
  D: ['####.', '#...#', '#...#', '#...#', '#...#', '#...#', '####.'],
  E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  F: ['#####', '#....', '#....', '####.', '#....', '#....', '#....'],
  G: ['.###.', '#...#', '#....', '#.###', '#...#', '#...#', '.###.'],
  H: ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  I: ['.###.', '..#..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  J: ['..###', '...#.', '...#.', '...#.', '...#.', '#..#.', '.##..'],
  K: ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
  L: ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
  M: ['#...#', '##.##', '#.#.#', '#.#.#', '#...#', '#...#', '#...#'],
  N: ['#...#', '##..#', '##..#', '#.#.#', '#..##', '#..##', '#...#'],
  O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  P: ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
  Q: ['.###.', '#...#', '#...#', '#...#', '#.#.#', '#..#.', '.##.#'],
  R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  S: ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'],
  T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  U: ['#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  V: ['#...#', '#...#', '#...#', '#...#', '#...#', '.#.#.', '..#..'],
  W: ['#...#', '#...#', '#...#', '#.#.#', '#.#.#', '##.##', '#...#'],
  X: ['#...#', '#...#', '.#.#.', '..#..', '.#.#.', '#...#', '#...#'],
  Y: ['#...#', '#...#', '.#.#.', '..#..', '..#..', '..#..', '..#..'],
  Z: ['#####', '....#', '...#.', '..#..', '.#...', '#....', '#####'],
};

const FALLBACK: readonly string[] = [
  '#####',
  '#####',
  '#####',
  '#####',
  '#####',
  '#####',
  '#####',
];

export interface PixelRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** Every character this font has a glyph for. */
export function glyphNames(): readonly string[] {
  return Object.keys(GLYPHS);
}

export function hasGlyph(character: string): boolean {
  return character in GLYPHS;
}

/** Width of `text` in font pixels, spacing included, excluding the trailing gap. */
export function textWidth(text: string): number {
  if (text.length === 0) return 0;
  return text.length * (GLYPH_WIDTH + GLYPH_SPACING) - GLYPH_SPACING;
}

/**
 * The lit pixels of `text`, in font-pixel coordinates with the origin at the
 * top left. One rect per lit pixel: runs are *not* merged, because a path is
 * built once per message rather than once per frame, and because `src/ui/`'s
 * numeric face is derived from this function one pixel at a time -- a merged
 * run would arrive there as a single lit pixel and the rest of the glyph would
 * go dark.
 */
export function glyphRects(text: string): readonly PixelRect[] {
  const rects: PixelRect[] = [];
  let cursor = 0;
  for (const character of text) {
    const rows = GLYPHS[character] ?? FALLBACK;
    for (let row = 0; row < rows.length; row++) {
      const line = rows[row];
      if (!line) continue;
      for (let column = 0; column < line.length; column++) {
        if (line[column] !== '#') continue;
        rects.push({ x: cursor + column, y: row, w: 1, h: 1 });
      }
    }
    cursor += GLYPH_WIDTH + GLYPH_SPACING;
  }
  return rects;
}

/** One SVG path `d` covering every lit pixel. */
export function glyphPath(text: string): string {
  return glyphRects(text)
    .map((rect) => `M${rect.x} ${rect.y}h${rect.w}v${rect.h}h-${rect.w}z`)
    .join('');
}

export interface PixelTextOptions {
  /** Screen pixels per font pixel. 3 gives a 15x21 digit. */
  readonly scale?: number;
  readonly fill?: string;
  /** Outline colour. One font-pixel thick, drawn behind the fill. */
  readonly outline?: string;
}

/**
 * `text` as a self-contained `<svg>` element.
 *
 * The outline is eight offset copies of the same path rather than a stroke: a
 * stroke rounds and bleeds at corners, which is exactly the look a pixel font is
 * for avoiding. Eight copies of a five-glyph path is nothing, and the result is
 * a hard one-pixel border that survives any background.
 */
export function pixelTextSvg(text: string, options: PixelTextOptions = {}): string {
  const scale = options.scale ?? 3;
  const fill = options.fill ?? '#ffffff';
  const outline = options.outline ?? '#000000';

  const path = glyphPath(text);
  const width = textWidth(text);
  // One font pixel of margin on every side, for the outline to live in.
  const boxWidth = width + 2;
  const boxHeight = GLYPH_HEIGHT + 2;

  const offsets: readonly (readonly [number, number])[] = [
    [-1, -1], [0, -1], [1, -1],
    [-1, 0], [1, 0],
    [-1, 1], [0, 1], [1, 1],
  ];
  const shadow = offsets
    .map(([dx, dy]) => `<path d="${path}" fill="${outline}" transform="translate(${dx} ${dy})"/>`)
    .join('');

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${boxWidth * scale}" ` +
    `height="${boxHeight * scale}" viewBox="0 0 ${boxWidth} ${boxHeight}" ` +
    'shape-rendering="crispEdges" style="display:block">' +
    `<g transform="translate(1 1)">${shadow}<path d="${path}" fill="${fill}"/></g>` +
    '</svg>'
  );
}
