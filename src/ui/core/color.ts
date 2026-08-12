/**
 * Colour, as four bytes (spec 123).
 *
 * Bytes rather than a packed integer because JavaScript's bitwise operators are
 * 32-bit *signed*: `0xff0000ff | 0` is negative, and every read of a packed
 * colour then needs a `>>> 0` that someone will eventually forget. Four fields
 * cost nothing here -- a frame is a few hundred quads, not a few million pixels
 * of shading.
 *
 * Channels are 0..255 including alpha. The atlas stores premultiplied nothing:
 * straight alpha, composited in `raster.ts`, because the atlas is authored by
 * hand as text and a human writing `#` should not have to think about it.
 */

export interface Color {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

export const TRANSPARENT: Color = { r: 0, g: 0, b: 0, a: 0 };
/** The identity tint. Multiplying by this leaves a sprite exactly as baked. */
export const WHITE: Color = { r: 255, g: 255, b: 255, a: 255 };
export const BLACK: Color = { r: 0, g: 0, b: 0, a: 255 };

function clampByte(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(255, Math.round(value)));
}

export function color(r: number, g: number, b: number, a = 255): Color {
  return { r: clampByte(r), g: clampByte(g), b: clampByte(b), a: clampByte(a) };
}

const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/**
 * Parse `#rgb`, `#rgba`, `#rrggbb` or `#rrggbbaa`.
 *
 * Throws rather than falling back to magenta. This is only ever called on the
 * committed theme document, which is schema-validated before it gets here, so a
 * failure means the schema and the parser disagree -- and a silent default would
 * hide exactly that.
 */
export function parseColor(text: string): Color {
  const match = HEX.exec(text.trim());
  if (!match) throw new Error(`not a colour: ${text}`);
  const body = match[1] ?? '';
  const short = body.length <= 4;
  const step = short ? 1 : 2;
  const channel = (index: number): number => {
    const slice = body.slice(index * step, index * step + step);
    const value = Number.parseInt(short ? slice + slice : slice, 16);
    return value;
  };
  const hasAlpha = body.length === 4 || body.length === 8;
  return color(channel(0), channel(1), channel(2), hasAlpha ? channel(3) : 255);
}

export function colorsEqual(a: Color, b: Color): boolean {
  return a.r === b.r && a.g === b.g && a.b === b.b && a.a === b.a;
}

/** A stable key for caching one tinted copy of the atlas per colour. */
export function colorKey(c: Color): string {
  return `${c.r},${c.g},${c.b},${c.a}`;
}

/** Per-channel multiply, which is what a tint is. */
export function multiply(a: Color, b: Color): Color {
  return {
    r: Math.round((a.r * b.r) / 255),
    g: Math.round((a.g * b.g) / 255),
    b: Math.round((a.b * b.b) / 255),
    a: Math.round((a.a * b.a) / 255),
  };
}

/** `c` with its alpha scaled by `factor` (0..1). Used for disabled states. */
export function fade(c: Color, factor: number): Color {
  return { r: c.r, g: c.g, b: c.b, a: clampByte(c.a * factor) };
}

/**
 * `source` composited over `dest`, straight alpha, both opaque-or-not.
 *
 * The usual "over" operator. Written out rather than reached for from a library
 * because it is four lines and it is the one place the software backend's output
 * is decided -- if the goldens ever disagree with the browser, this is the first
 * thing to read.
 */
export function over(source: Color, dest: Color): Color {
  if (source.a === 0) return dest;
  if (source.a === 255) return source;
  const sa = source.a / 255;
  const da = (dest.a / 255) * (1 - sa);
  const outA = sa + da;
  if (outA <= 0) return TRANSPARENT;
  return {
    r: Math.round((source.r * sa + dest.r * da) / outA),
    g: Math.round((source.g * sa + dest.g * da) / outA),
    b: Math.round((source.b * sa + dest.b * da) / outA),
    a: Math.round(outA * 255),
  };
}

export function toCss(c: Color): string {
  return `rgba(${c.r},${c.g},${c.b},${(c.a / 255).toFixed(4)})`;
}
