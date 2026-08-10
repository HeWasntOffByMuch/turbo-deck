/**
 * The sprites, grown rather than fetched (spec 118).
 *
 * Nothing in this renderer may load an asset over the network -- the same rule
 * `pixel-font.ts` and `detail-texture.ts` already live under -- so every sprite
 * a particle can draw is generated here, from arithmetic, at startup.
 *
 * That is not a compromise at this resolution. A particle is three to twelve
 * virtual pixels across; an authored 64x64 sprite would be thrown away by the
 * downsample, and what actually decides how a particle reads is its *silhouette*
 * and how its edge falls off. Both of those are two lines of maths.
 *
 * ## Falloff is dithered, never smooth
 *
 * The soft radial gradient every particle system reaches for is exactly wrong
 * here: `RetroPass` quantizes the finished frame to a handful of levels, so a
 * smooth edge arrives as two or three visible rings. {@link radialSprite} bands
 * its falloff against the *same* 4x4 Bayer matrix `retro.ts` builds, so the edge
 * dissolves into the frame's own weave instead of fighting it.
 */

import * as THREE from 'three';
import { ditherThreshold } from './palette.js';

/** Every generated sheet, so one texture is uploaded once and shared. */
const CACHE = new Map<string, THREE.DataTexture>();

/**
 * `Uint8Array<ArrayBuffer>` rather than plain `Uint8Array`: three's DataTexture
 * takes a `BufferSource`, which excludes a view that might be backed by a
 * `SharedArrayBuffer`, and the default `Uint8Array` type admits one.
 */
function makeTexture(pixels: Uint8Array<ArrayBuffer>, width: number, height: number): THREE.DataTexture {
  const texture = new THREE.DataTexture(pixels, width, height, THREE.RGBAFormat);
  // Nearest everywhere, for the reason the whole look exists. A linear filter
  // here would reintroduce the sub-pixel shimmer the virtual resolution and the
  // pixel snap were built to remove.
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  // The sheets carry coverage, not colour -- the tint comes from the gradient --
  // so they must not be decoded as sRGB on the way in.
  texture.colorSpace = THREE.NoColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/** A solid square: the default, and what a spark actually wants. */
function solidSprite(size: number): Uint8Array<ArrayBuffer> {
  const pixels = new Uint8Array(size * size * 4);
  pixels.fill(255);
  return pixels;
}

/**
 * A disc with a hot core and a dithered edge.
 *
 * `core` is the fraction of the radius held at full strength before the falloff
 * starts. The ordered dither turns the ramp into a stipple, which survives
 * quantization; a smooth ramp does not.
 */
function radialSprite(size: number, core: number, dither: boolean): Uint8Array<ArrayBuffer> {
  const pixels = new Uint8Array(size * size * 4);
  const centre = (size - 1) / 2;
  const radius = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x - centre) / radius;
      const dy = (y - centre) / radius;
      const distance = Math.sqrt(dx * dx + dy * dy);
      let coverage = 0;
      if (distance <= core) coverage = 1;
      else if (distance < 1) coverage = 1 - (distance - core) / (1 - core);

      let alpha = coverage;
      if (dither && coverage > 0 && coverage < 1) {
        alpha = coverage > ditherThreshold(x, y) ? 1 : 0;
      }
      const at = (y * size + x) * 4;
      pixels[at] = 255;
      pixels[at + 1] = 255;
      pixels[at + 2] = 255;
      pixels[at + 3] = Math.round(Math.max(0, Math.min(1, alpha)) * 255);
    }
  }
  return pixels;
}

/**
 * A puff flipbook: `frames` discs laid out left to right, each one a little
 * larger and a little more eaten away than the last.
 *
 * The erosion is the whole trick -- a puff that only scales up reads as a
 * zoom, and a puff that loses pixels off its edge reads as dispersing.
 */
function puffSheet(size: number, frames: number): { pixels: Uint8Array<ArrayBuffer>; width: number } {
  const width = size * frames;
  const pixels = new Uint8Array(width * size * 4);
  const centre = (size - 1) / 2;
  for (let f = 0; f < frames; f++) {
    const t = frames > 1 ? f / (frames - 1) : 0;
    const radius = (size / 2) * (0.45 + t * 0.55);
    const core = 0.7 - t * 0.6;
    const erosion = t * 0.55;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dx = x - centre;
        const dy = y - centre;
        const distance = Math.sqrt(dx * dx + dy * dy) / radius;
        let coverage = 0;
        if (distance <= core) coverage = 1;
        else if (distance < 1) coverage = 1 - (distance - core) / Math.max(1e-3, 1 - core);
        coverage *= 1 - erosion;
        const alpha = coverage > 0 && coverage < 1 ? (coverage > ditherThreshold(x + f * 3, y) ? 1 : 0) : coverage;
        const at = (y * width + f * size + x) * 4;
        pixels[at] = 255;
        pixels[at + 1] = 255;
        pixels[at + 2] = 255;
        pixels[at + 3] = Math.round(Math.max(0, Math.min(1, alpha)) * 255);
      }
    }
  }
  return { pixels, width };
}

/**
 * A named sheet.
 *
 * The empty name is the solid square, which is what an emitter with no `sprite`
 * gets -- and what sparks want, since a spark is a chip of light and not a soft
 * blob. Unknown names fall back to it rather than throwing: a typo in a
 * definition should draw something ugly and obvious, not take the tab down.
 */
export function spriteSheet(name: string): THREE.DataTexture {
  const cached = CACHE.get(name);
  if (cached) return cached;

  let texture: THREE.DataTexture;
  switch (name) {
    case 'glow':
      texture = makeTexture(radialSprite(16, 0.15, true), 16, 16);
      break;
    case 'glow_smooth':
      // The comparison subject in spec 119, kept so the two can be shown side by
      // side rather than argued about.
      texture = makeTexture(radialSprite(16, 0.15, false), 16, 16);
      break;
    case 'disc':
      texture = makeTexture(radialSprite(8, 0.55, true), 8, 8);
      break;
    case 'puff': {
      const { pixels, width } = puffSheet(12, 8);
      texture = makeTexture(pixels, width, 12);
      break;
    }
    default:
      texture = makeTexture(solidSprite(2), 2, 2);
      break;
  }

  CACHE.set(name, texture);
  return texture;
}

/** How many frames wide a named sheet is. Must agree with `spriteSheet`. */
export function sheetFrames(name: string): number {
  return name === 'puff' ? 8 : 1;
}

/** Drop every generated sheet. Only a context loss needs this. */
export function disposeSprites(): void {
  for (const texture of CACHE.values()) texture.dispose();
  CACHE.clear();
}
