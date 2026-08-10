/**
 * The VFX palette and the tint rule (spec 118).
 *
 * Every colour an effect can produce is named here. Effect definitions carry
 * *keys*, never hex, which is the whole mechanism behind "colors snap to a
 * constrained palette": an effect physically cannot introduce a colour the look
 * does not have, because there is nowhere in the definition format to write one.
 *
 * The names follow the damage-type language in `docs/vfx-plan.md` section 6, and
 * the ramps all share one rule: a near-white hot core, a saturated body, and a
 * dark tail. At 300 pixels tall the flash is what reads; the ramp behind it is
 * what says which damage type it was.
 *
 * These are *not* run through `RetroPass`'s palette here. The frame's own
 * quantizer does that at the end of the pass, to the whole image at once, which
 * is exactly where it should happen -- a particle pre-snapped to the display
 * palette and then snapped again by the pass would band twice. What this table
 * is for is stopping thirty effects each inventing their own orange.
 *
 * ## Authored as sRGB, used as linear
 *
 * Every entry below is an sRGB hex, the way every other colour constant in this
 * renderer is authored (`iso3d/palette.ts`, and `color-space.test.ts` beside it).
 * The scene is lit and composited in linear working space and the sRGB encode
 * happens once, in `RetroPass`, over the finished frame -- so these have to
 * arrive at the shader as *linear*, exactly as `new THREE.Color(hex)` would
 * deliver them.
 *
 * {@link paletteInto} therefore decodes, through the same `unpackLinear` the
 * rest of the renderer is held to. Skipping it does not look like a bug: the
 * particles simply come out too bright in the mid-tones, in a way that reads as
 * the alpha curves needing tuning.
 */

import { unpackLinear } from '../hike.js';

export const VFX_PALETTE = {
  // --- sparks and metal ---
  sparkHot: 0xfff6df,
  sparkWarm: 0xffb347,
  sparkEmber: 0x8a3418,
  metalDust: 0xb4bfca,

  // --- fire ---
  fireCore: 0xfff3cd,
  fireBody: 0xf58722,
  fireDeep: 0xc0341c,
  emberGlow: 0xff8a3d,

  // --- smoke and dust ---
  smokeLight: 0x9a938c,
  smokeDark: 0x3c3733,
  dustPale: 0xf2efe4,
  dustEarth: 0xc8823f,
  dustSand: 0xe8d49c,
  dustSnow: 0xf5f5f0,
  dustStone: 0xc6bda9,
  splashWater: 0x4ec3d4,

  // --- blood and other fluids ---
  bloodFresh: 0xa32a26,
  bloodDeep: 0x5e1414,
  sapAmber: 0xc98a2b,
  ichorViolet: 0x7b3fa0,
  oilBlack: 0x1a1a20,
  slimeGreen: 0x6fae4a,

  // --- damage types (docs/vfx-plan.md section 6) ---
  physicalBone: 0xe8e2d4,
  physicalGrey: 0x9a938c,
  poisonPale: 0xc4e08a,
  poisonDeep: 0x4a8a35,
  poisonMurk: 0x2c4a24,
  iceWhite: 0xeaf7ff,
  icePale: 0x9fd8ff,
  iceDeep: 0x3f6fb0,
  boltWhite: 0xfffbe0,
  boltYellow: 0xffe08a,
  boltViolet: 0x9a5ad0,
  arcaneLilac: 0xd7bdf0,
  arcaneMagenta: 0xc04ab8,
  arcaneDeep: 0x4a2a7a,

  // --- status auras ---
  auraBuff: 0x7fd08a,
  auraDebuff: 0xd0796f,
  auraShield: 0x9fd8ff,
  auraHeal: 0xbdf0a8,
  auraChannel: 0xe8f6ff,
  auraTelegraph: 0xd6483f,
  auraSelected: 0xffe08a,
} as const;

export type PaletteKey = keyof typeof VFX_PALETTE;

/** Rec. 709 luma, the same weights `retro-pass.ts` grades against. */
const LUMA_R = 0.2126;
const LUMA_G = 0.7152;
const LUMA_B = 0.0722;

/** True when `key` names a real entry -- the check a loaded JSON definition needs. */
export function isPaletteKey(key: string): key is PaletteKey {
  return Object.prototype.hasOwnProperty.call(VFX_PALETTE, key);
}

/**
 * Unpack a packed sRGB `0xRRGGBB` into three **linear** floats, written at `at`.
 *
 * Through the renderer's own `unpackLinear`, so a VFX colour takes exactly the
 * journey every other palette constant here takes and a three.js upgrade that
 * moved one would move both.
 */
export function unpackInto(packed: number, out: Float32Array, at: number): void {
  const [r, g, b] = unpackLinear(packed);
  out[at] = r;
  out[at + 1] = g;
  out[at + 2] = b;
}

/** A palette entry as three linear floats, written at `at`. */
export function paletteInto(key: PaletteKey, out: Float32Array, at: number): void {
  unpackInto(VFX_PALETTE[key], out, at);
}

/**
 * Recolour toward a tint at matched luminance, in place.
 *
 * The same expression `grade.ts` and the retro shader use, and for the same
 * reason: multiplying by a tint is also a dimmer, so orange fire multiplied by
 * blue is a muddy near-black rather than blue fire. Dividing the tint by its own
 * luma keeps a strong hue from doubling as a brightness change, so one fire
 * definition really does produce normal, blue and cursed fire from a parameter.
 *
 * `strength` 0 leaves the colour alone; 1 replaces the hue outright and keeps
 * the ramp's brightness, which is what makes the flash still read as a flash.
 */
export function tintInto(
  rgb: Float32Array,
  at: number,
  tintR: number,
  tintG: number,
  tintB: number,
  strength: number,
): void {
  if (strength <= 0) return;
  const r = rgb[at] ?? 0;
  const g = rgb[at + 1] ?? 0;
  const b = rgb[at + 2] ?? 0;
  const grey = r * LUMA_R + g * LUMA_G + b * LUMA_B;
  const tintLuma = Math.max(tintR * LUMA_R + tintG * LUMA_G + tintB * LUMA_B, 1e-4);
  const scale = grey / tintLuma;
  rgb[at] = r + (tintR * scale - r) * strength;
  rgb[at + 1] = g + (tintG * scale - g) * strength;
  rgb[at + 2] = b + (tintB * scale - b) * strength;
}

/**
 * Snap one channel to `levels` even steps.
 *
 * The shared quantization helper, offered so an effect that wants to be visibly
 * chunky in its *own* colour (a dissolve, a flipbook generated at runtime) uses
 * the same arithmetic the frame's filter does rather than a second version of it.
 * `retro.ts` computes the identical expression for the whole image.
 */
export function quantizeChannel(value: number, levels: number): number {
  const steps = Math.max(1, levels - 1);
  const clamped = value < 0 ? 0 : value > 1 ? 1 : value;
  return Math.round(clamped * steps) / steps;
}

/**
 * The 4x4 ordered-dither threshold at a pixel, in [0, 1).
 *
 * The same Bayer recurrence `retro.ts` builds its matrix from, flattened to a
 * lookup so a shader chunk and this agree. Effects use it for the dither-cutout
 * blend and for radial glow falloff, which is what lets a halo fade without a
 * soft gradient the pixelation would turn to mush.
 */
const BAYER_4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

export function ditherThreshold(px: number, py: number): number {
  const x = ((px % 4) + 4) % 4;
  const y = ((py % 4) + 4) % 4;
  return (BAYER_4[y * 4 + x] ?? 0) / 16;
}
