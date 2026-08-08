import { Rng } from '../../shared/prng.js';

/**
 * The one texture in this renderer, generated rather than fetched (spec 102).
 *
 * Pure -- no three.js and no DOM -- so what the tile *is* can be asserted in
 * Node; `terrain-detail.ts` uploads whatever this returns.
 *
 * ## Why it is generated
 *
 * There are no texture assets in this project and no way to get any: nothing may
 * be fetched at runtime, and a new dependency is a question rather than a
 * decision. So the tile is grown from the repo's seeded PRNG at startup.
 *
 * That is also the honest version. A checked-in PNG would be a binary nobody
 * reviews; this is a function whose tiling, range and determinism are all things
 * a test can state.
 *
 * ## Value noise, summed over octaves
 *
 * A lattice of random values, smoothly interpolated, summed at doubling
 * frequencies and halving amplitudes. Cheap, and -- more to the point -- *tileable
 * by construction*: the lattice wraps, so the interpolation wraps with it. A tile
 * that nearly wraps draws a visible grid across the whole cliff, which is the one
 * failure that would be obvious on screen and invisible in every other check.
 */

/** Side of the generated tile, in texels. A power of two, so mipmaps halve cleanly. */
export const DETAIL_TILE_SIZE = 128;

/** The seed the shipped tile is grown from. */
export const DETAIL_TILE_SEED = 0x7ea_1e5;

/** How many octaves are summed. Four spans 8 to 64 texels of feature size. */
const OCTAVES = 4;

/** Lattice period of the coarsest octave, in texels. Must divide the tile size. */
const BASE_PERIOD = 16;

/** Smoothstep, so the lattice interpolation has no visible creases at cell edges. */
function fade(t: number): number {
  return t * t * (3 - 2 * t);
}

/**
 * A `period` x `period` lattice of values in [0, 1), drawn in a fixed order so
 * the tile is a pure function of the seed.
 */
function lattice(period: number, rng: Rng): { values: number[]; rng: Rng } {
  const values: number[] = [];
  let current = rng;
  for (let i = 0; i < period * period; i++) {
    const [value, next] = current.nextInt(0, 0xffffff);
    current = next;
    values.push(value / 0x1000000);
  }
  return { values, rng: current };
}

/**
 * One octave of wrapped value noise at (x, y), in texels.
 *
 * The `% period` on the *upper* lattice index is the whole tiling property: the
 * cell at the last row interpolates back to row zero rather than off the end.
 */
function octaveAt(
  values: readonly number[],
  period: number,
  size: number,
  x: number,
  y: number,
): number {
  const scale = period / size;
  const fx = x * scale;
  const fy = y * scale;
  const x0 = ((Math.floor(fx) % period) + period) % period;
  const y0 = ((Math.floor(fy) % period) + period) % period;
  const x1 = (x0 + 1) % period;
  const y1 = (y0 + 1) % period;
  const tx = fade(fx - Math.floor(fx));
  const ty = fade(fy - Math.floor(fy));

  const v00 = values[y0 * period + x0] ?? 0;
  const v10 = values[y0 * period + x1] ?? 0;
  const v01 = values[y1 * period + x0] ?? 0;
  const v11 = values[y1 * period + x1] ?? 0;
  const top = v00 + (v10 - v00) * tx;
  const bottom = v01 + (v11 - v01) * tx;
  return top + (bottom - top) * ty;
}

/**
 * The noise as a continuous function of texel coordinates, before it is
 * quantized into a tile.
 *
 * Exposed because the property that matters cannot be checked on the byte array:
 * "it tiles" is a statement about the texel *past* the right edge, which the
 * array does not contain. Against this it is an equality -- `field(size, y)`
 * must be `field(0, y)` -- and a tile that only nearly wraps draws a grid of
 * seams across every cliff in the world.
 */
export function detailField(
  size: number = DETAIL_TILE_SIZE,
  seed: number = DETAIL_TILE_SEED,
): (x: number, y: number) => number {
  let rng = Rng.fromSeed(seed);
  const octaves: { values: number[]; period: number; amplitude: number }[] = [];
  let amplitude = 1;
  let total = 0;
  for (let o = 0; o < OCTAVES; o++) {
    const period = BASE_PERIOD * 2 ** o;
    const built = lattice(period, rng);
    rng = built.rng;
    octaves.push({ values: built.values, period, amplitude });
    total += amplitude;
    amplitude /= 2;
  }
  return (x, y) => {
    let sum = 0;
    for (const octave of octaves) {
      sum += octaveAt(octave.values, octave.period, size, x, y) * octave.amplitude;
    }
    return sum / total;
  };
}

/**
 * The tile as one byte per texel, row-major, `size * size` long.
 *
 * One channel: this is a detail signal that modulates a colour the material
 * already has, not a colour of its own. `terrain-detail.ts` expands it to the
 * format the GL context wants.
 *
 * Normalized to span the full byte range afterwards, because a sum of octaves
 * clusters around its mean and would otherwise arrive as a narrow band of greys
 * that the retro pass's quantizer flattens to nothing.
 */
export function detailTile(size: number = DETAIL_TILE_SIZE, seed: number = DETAIL_TILE_SEED): Uint8Array {
  const field = detailField(size, seed);
  const raw = new Float32Array(size * size);
  let lowest = Infinity;
  let highest = -Infinity;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const value = field(x, y);
      raw[y * size + x] = value;
      lowest = Math.min(lowest, value);
      highest = Math.max(highest, value);
    }
  }

  const span = highest - lowest;
  const out = new Uint8Array(size * size);
  for (let i = 0; i < raw.length; i++) {
    const normalized = span > 0 ? ((raw[i] ?? 0) - lowest) / span : 0.5;
    out[i] = Math.max(0, Math.min(255, Math.round(normalized * 255)));
  }
  return out;
}
