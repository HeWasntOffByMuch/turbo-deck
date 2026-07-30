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
}

/**
 * The tuning that matches the reference screenshot: few enough colours that the
 * weave is unmistakable, a full-strength 4x4 dither at one cell per pixel.
 */
export const RETRO_DEFAULTS: RetroSettings = {
  enabled: true,
  levels: 6,
  ditherStrength: 1,
  matrixSize: 4,
  ditherScale: 1,
  pixelSize: 1,
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
