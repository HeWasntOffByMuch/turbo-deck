/**
 * The maths behind the retro post filter (spec 038), kept pure and free of
 * three.js and the DOM so it can be tested headlessly in Node.
 *
 * The look being imitated is a machine with too few colours: continuous shading
 * is snapped to a handful of steps per channel (quantization), and the shade
 * *between* two steps is faked by mixing both in a fixed screen-space pattern
 * (ordered dithering). The pattern comes from a Bayer matrix -- a recursively
 * built permutation of thresholds that spreads its values as evenly as possible,
 * which is why the result reads as a fine even weave rather than as clumps.
 *
 * Ordered dithering is indexed by pixel position, not by neighbouring pixels, so
 * it is stable while the camera moves (no crawling texture) and needs no
 * sequential pass -- both reasons it, rather than error diffusion, is what a
 * fragment shader can do. The functions here are the reference model; the shader
 * in `retro-pass.ts` computes the same expression per colour channel.
 */

/** Bayer matrix edge lengths we support: bigger = finer, more shades faked. */
export const BAYER_SIZES = [2, 4, 8] as const;
export type BayerSize = (typeof BAYER_SIZES)[number];

/** Everything the filter needs to know, as plain data the control panel edits. */
export interface RetroSettings {
  /** Off renders the scene straight to the canvas, untouched. */
  readonly enabled: boolean;
  /** Colour steps per channel after quantization (2..16). Fewer = harsher bands. */
  readonly levels: number;
  /** How far the threshold can push a pixel, in band edges. 1 = a full edge. */
  readonly ditherStrength: number;
  /** Bayer matrix edge length. */
  readonly matrixSize: BayerSize;
  /** Size of one dither cell, in low-resolution pixels. */
  readonly ditherScale: number;
  /** Divisor on the internal render resolution (1..4): bigger = chunkier pixels. */
  readonly pixelSize: number;
  /**
   * Leave exempt pixels out of the dither and the quantize (spec 138).
   *
   * Who is exempt is not a question this module can answer -- `RetroPass`
   * takes the objects from its caller, and the only caller that names any is
   * the Play tab, which names the player. Inert everywhere else.
   */
  readonly excludePlayer: boolean;
}

/**
 * The tuning the view opens at: twelve steps per channel, and a dither turned
 * right down to 5%. Enough colours that shading reads as shading rather than as
 * posterization, with the weave only just breaking up the band edges -- the
 * retro texture without the crosshatch swallowing the palette.
 */
export const RETRO_DEFAULTS: RetroSettings = {
  enabled: true,
  levels: 12,
  ditherStrength: 0.05,
  matrixSize: 4,
  ditherScale: 1,
  pixelSize: 1,
  excludePlayer: true,
};

/**
 * The `size`x`size` ordered-dither matrix, holding every integer `0..size²-1`
 * exactly once. Built by the standard recurrence from the 2x2 base case: each
 * step scales the parent by 4 and adds a fixed offset per quadrant, which is
 * what keeps successive thresholds maximally far apart on screen.
 */
export function bayerMatrix(size: BayerSize): number[][] {
  let m: number[][] = [
    [0, 2],
    [3, 1],
  ];
  for (let n = 2; n < size; n *= 2) {
    const next: number[][] = [];
    for (let y = 0; y < n * 2; y++) {
      const row: number[] = [];
      for (let x = 0; x < n * 2; x++) {
        // Quadrant offsets, in the same 0,2,3,1 order as the base case.
        const quadrant = (x < n ? 0 : 1) + (y < n ? 0 : 2);
        const offset = [0, 2, 3, 1][quadrant] ?? 0;
        row.push((m[y % n]?.[x % n] ?? 0) * 4 + offset);
      }
      next.push(row);
    }
    m = next;
  }
  return m;
}

/**
 * The matrix as thresholds in (0, 1). The half-step offset centres them, so the
 * set averages exactly 0.5 and dithering shifts no overall brightness -- it only
 * decides which side of a band edge each pixel falls on.
 */
export function bayerThresholds(size: BayerSize): number[][] {
  const cells = size * size;
  return bayerMatrix(size).map((row) => row.map((v) => (v + 0.5) / cells));
}

/**
 * The thresholds as one byte each, row-major -- the form the pass uploads as a
 * single-channel texture for the shader to sample.
 */
export function bayerTextureData(size: BayerSize): Uint8Array {
  const data = new Uint8Array(size * size);
  const thresholds = bayerThresholds(size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      data[y * size + x] = Math.round((thresholds[y]?.[x] ?? 0) * 255);
    }
  }
  return data;
}

/** Snap a 0..1 channel to the nearest of `levels` evenly spaced palette values. */
export function quantizeChannel(v: number, levels: number): number {
  const steps = Math.max(1, levels - 1);
  const clamped = Math.min(1, Math.max(0, v));
  return Math.round(clamped * steps) / steps;
}

/**
 * Quantize, but first nudge the value by up to half a band in either direction
 * according to this pixel's threshold. A value sitting a third of the way
 * between two palette steps ends up on the higher step for the third of the
 * matrix whose thresholds are high enough -- so the region becomes a weave of
 * the two steps that reads, from a distance, as the shade in between.
 */
export function ditherChannel(v: number, threshold: number, levels: number, strength: number): number {
  const steps = Math.max(1, levels - 1);
  return quantizeChannel(v + ((threshold - 0.5) * strength) / steps, levels);
}

// --- the exemption (spec 138) ------------------------------------------------

/**
 * The dither, unless this pixel is exempt -- the reference model for the mix at
 * the bottom of the shader.
 *
 * `mask` is what the mask buffer holds for this pixel: 1 inside an exempt body,
 * 0 everywhere else. An exempt pixel is returned *unchanged*, not quantized
 * more gently: the point is a body whose colours survive, and a body on 64
 * steps instead of 12 is still a body the palette got to.
 *
 * Written as a mix rather than a branch because that is what the shader does,
 * and because it is the whole cost of a partial exemption if one is ever
 * wanted. Values between 0 and 1 are therefore meaningful here, and nothing
 * currently produces one.
 */
export function exemptChannel(
  v: number,
  threshold: number,
  levels: number,
  strength: number,
  mask: number,
): number {
  const m = Math.min(1, Math.max(0, mask));
  return ditherChannel(v, threshold, levels, strength) * (1 - m) + v * m;
}

/**
 * Whether the exemption is worth rendering a mask for.
 *
 * Three ways to be inert, and the reason to check all of them here rather than
 * in the pass is that the mask costs a draw: nobody named exempt (every caller
 * but the Play tab), the setting off, or nothing to be exempt *from*.
 *
 * That last one is why this takes `hasPalette` rather than reading
 * `settings.enabled` alone. A palette snaps colours with the retro filter
 * switched off -- it is the reason spec 102 runs the quad at all -- so a
 * palettized frame has something for a body to be exempt from even though the
 * filter is off.
 */
export function exemptionIsLive(
  settings: RetroSettings,
  hasPalette: boolean,
  exemptCount: number,
): boolean {
  if (!settings.excludePlayer || exemptCount <= 0) return false;
  return settings.enabled || hasPalette;
}

// --- quantizing onto a palette (spec 102) ------------------------------------

/**
 * Snap a colour to the nearest entry of a palette, in the same display space the
 * palette is authored in.
 *
 * Nearest by squared distance in RGB. Not a perceptual metric, deliberately: a
 * limited palette is chosen *as* a set of colours that look right together, so
 * the useful question is which of them a pixel is closest to, and a perceptual
 * distance mostly redistributes error toward hues the palette was picked to
 * avoid. Squared, because the square root is monotonic and would change nothing
 * but the cost.
 *
 * `palette` is a flat run of r, g, b triples in 0..1. An empty palette leaves the
 * colour alone rather than returning black.
 */
export function nearestPaletteColor(
  r: number,
  g: number,
  b: number,
  palette: ArrayLike<number>,
): readonly [number, number, number] {
  const count = Math.floor(palette.length / 3);
  if (count === 0) return [r, g, b];

  let best = 0;
  let bestDistance = Infinity;
  for (let i = 0; i < count; i++) {
    const dr = r - (palette[i * 3] ?? 0);
    const dg = g - (palette[i * 3 + 1] ?? 0);
    const db = b - (palette[i * 3 + 2] ?? 0);
    const distance = dr * dr + dg * dg + db * db;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = i;
    }
  }
  return [palette[best * 3] ?? 0, palette[best * 3 + 1] ?? 0, palette[best * 3 + 2] ?? 0];
}

/**
 * How far apart the palette's colours are: the mean distance from each entry to
 * its nearest neighbour.
 *
 * This is what the dither is measured in. With evenly spaced levels a band is
 * `1 / (levels - 1)` wide and the dither nudges by up to half of one, but a
 * palette has no bands -- so the equivalent nudge is half the typical gap
 * between neighbouring colours. Without this the dither is either invisible on a
 * wide palette or a snowstorm on a tight one, and the strength slider means
 * something different for every palette.
 *
 * Zero for a palette of fewer than two colours, which correctly disables the
 * dither: there is nothing to mix between.
 */
export function paletteSpacing(palette: ArrayLike<number>): number {
  const count = Math.floor(palette.length / 3);
  if (count < 2) return 0;

  let total = 0;
  for (let i = 0; i < count; i++) {
    let nearest = Infinity;
    for (let j = 0; j < count; j++) {
      if (i === j) continue;
      const dr = (palette[i * 3] ?? 0) - (palette[j * 3] ?? 0);
      const dg = (palette[i * 3 + 1] ?? 0) - (palette[j * 3 + 1] ?? 0);
      const db = (palette[i * 3 + 2] ?? 0) - (palette[j * 3 + 2] ?? 0);
      nearest = Math.min(nearest, Math.hypot(dr, dg, db));
    }
    total += nearest;
  }
  return total / count;
}

/**
 * A palette of packed `0xRRGGBB` values as a flat run of 0..1 triples.
 *
 * The form both {@link nearestPaletteColor} and the shader want -- the shader
 * gets it as a one-row texture, so the colours stay data the panel supplies and
 * never constants compiled into GLSL.
 */
export function paletteChannels(palette: readonly number[]): Float32Array {
  const out = new Float32Array(palette.length * 3);
  palette.forEach((hex, i) => {
    out[i * 3] = ((hex >> 16) & 0xff) / 255;
    out[i * 3 + 1] = ((hex >> 8) & 0xff) / 255;
    out[i * 3 + 2] = (hex & 0xff) / 255;
  });
  return out;
}

/** The same, as the bytes a one-row RGBA texture is uploaded from. */
export function paletteTextureData(palette: readonly number[]): Uint8Array {
  const out = new Uint8Array(Math.max(1, palette.length) * 4);
  palette.forEach((hex, i) => {
    out[i * 4] = (hex >> 16) & 0xff;
    out[i * 4 + 1] = (hex >> 8) & 0xff;
    out[i * 4 + 2] = hex & 0xff;
    out[i * 4 + 3] = 255;
  });
  return out;
}
