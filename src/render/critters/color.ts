/**
 * Colour arithmetic for critter coats (spec 055): pure integer-RGB helpers with
 * no three.js and no DOM, so the palette derivation and the contrast test that
 * guards 64 px legibility both run in Node.
 *
 * Colours are 24-bit `0xRRGGBB` numbers throughout, matching `iso3d/palette.ts`
 * and what `THREE.Color` accepts, so nothing has to convert at the boundary.
 */

/** Clamp to a byte. */
function byte(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

export function rgb(color: number): readonly [number, number, number] {
  return [(color >> 16) & 0xff, (color >> 8) & 0xff, color & 0xff];
}

export function packRgb(r: number, g: number, b: number): number {
  return (byte(r) << 16) | (byte(g) << 8) | byte(b);
}

/** Blend `a` toward `b` by `t` (0..1) in straight sRGB byte space. */
export function mix(a: number, b: number, t: number): number {
  const k = t < 0 ? 0 : t > 1 ? 1 : t;
  const [ar, ag, ab] = rgb(a);
  const [br, bg, bb] = rgb(b);
  return packRgb(ar + (br - ar) * k, ag + (bg - ag) * k, ab + (bb - ab) * k);
}

/**
 * Darken toward a *warm* near-black rather than toward 0x000000. Mixing straight
 * to black desaturates as it darkens and turns every coat into the same grey;
 * pulling toward a brown-black keeps a rose pig's shadows rosy.
 */
const SHADOW = 0x2a1f22;
/** Lighten toward a warm off-white, for the same reason in the other direction. */
const HIGHLIGHT = 0xfff4e6;

export function shade(color: number, amount: number): number {
  return mix(color, SHADOW, amount);
}

export function tint(color: number, amount: number): number {
  return mix(color, HIGHLIGHT, amount);
}

/**
 * Relative luminance (WCAG), 0..1. This is the number that decides whether two
 * flat colours next to each other read as two shapes or as one blob, which is
 * the whole legibility question at 64 px.
 */
export function luminance(color: number): number {
  const channel = (v: number): number => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const [r, g, b] = rgb(color);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/**
 * WCAG contrast ratio between two colours, 1..21.
 *
 * Used as the acceptance bar for a species' accents against every coat the
 * player can pick: a cow's patches have to stay visible on a cream coat *and* on
 * a plum one, and the only way to know that without looking at 24 renders is to
 * compute it.
 */
export function contrastRatio(a: number, b: number): number {
  const la = luminance(a);
  const lb = luminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Push `color` away from `against` until they clear `minRatio` of contrast,
 * moving whichever direction it already leans. This is what lets one species
 * accent (a pig's snout) work under all twelve coats without twelve hand-picked
 * exceptions: a pale coat gets a deeper snout, a dark coat gets a brighter one.
 *
 * Gives up gracefully at the ends of the range -- pure black against pure white
 * is 21 and nothing can do better -- so it never loops.
 */
export function ensureContrast(color: number, against: number, minRatio: number): number {
  if (contrastRatio(color, against) >= minRatio) return color;
  // Lean the way there is more room to move.
  const darker = luminance(against) > 0.18;
  let best = color;
  for (let step = 1; step <= 10; step++) {
    const t = step / 10;
    const candidate = darker ? shade(color, t) : tint(color, t);
    best = candidate;
    if (contrastRatio(candidate, against) >= minRatio) return candidate;
  }
  return best;
}
