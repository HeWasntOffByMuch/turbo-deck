import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { srgbDecode, unpackLinear } from './hike.js';
import { PALETTE, TERRAIN_CLIFF_COLORS, TERRAIN_COLORS } from './palette.js';

/**
 * Regression guards on three.js's colour management (spec 087).
 *
 * The audit that opened this arc found the colour pipeline already correct:
 * lighting runs in linear working space, the sRGB encode happens once at
 * output, and every palette constant is decoded on the way in. None of that is
 * configured anywhere -- it is what three r160 does by default and what this
 * repo declines to fight.
 *
 * That is exactly why it needs tests. A three upgrade, or one stray
 * `renderer.outputColorSpace =`, or `ColorManagement.enabled = false` slipped in
 * to "fix" a colour that looked off, flips any of these with no visible symptom
 * at all: the frame still renders, and only the edge thresholds and palette
 * steps that every later step of spec 087 is tuned against quietly stop meaning
 * what they meant. A wrong transfer function does not look like a bug. It looks
 * like every number needing to be a little different than it should be.
 *
 * Kept out of `PURE_RENDER` in eslint.config.js because it imports three on
 * purpose -- three's behaviour is the subject. `hike.test.ts` holds the
 * reference maths and stays headless.
 */

/** Every colour constant the renderer authors as an sRGB hex. */
const ALL_HEXES: readonly number[] = [
  ...Object.values(PALETTE),
  ...Object.values(TERRAIN_COLORS).flat(),
  ...TERRAIN_CLIFF_COLORS,
];

describe('three colour management', () => {
  it('is enabled', () => {
    // Off, every Color below would be handed to the lighting maths as raw sRGB
    // bytes, and the whole scene would light too bright in the mid-tones.
    expect(THREE.ColorManagement.enabled).toBe(true);
  });

  it('works in linear space', () => {
    expect(THREE.ColorManagement.workingColorSpace).toBe(THREE.LinearSRGBColorSpace);
  });
});

describe('palette constants reach the lighting maths as linear', () => {
  it('decodes every hex the renderer uses', () => {
    // This is the path `terrain-mesh.ts`'s linearColor(), `meshes.ts`'s
    // flatMaterial() and every material in props.ts and critter.ts take.
    for (const hex of ALL_HEXES) {
      const color = new THREE.Color(hex);
      const [r, g, b] = unpackLinear(hex);
      expect(color.r).toBeCloseTo(r, 9);
      expect(color.g).toBeCloseTo(g, 9);
      expect(color.b).toBeCloseTo(b, 9);
    }
  });

  it('is really decoding, not passing on a no-op', () => {
    // Without this the test above would still pass if three stopped converting
    // and `unpackLinear` were the identity -- so pin the two readings apart.
    const asSrgb = new THREE.Color().setHex(PALETTE.grassLight, THREE.SRGBColorSpace);
    const asLinear = new THREE.Color().setHex(PALETTE.grassLight, THREE.LinearSRGBColorSpace);
    expect(asSrgb.g).not.toBeCloseTo(asLinear.g, 3);
    expect(asSrgb.g).toBeLessThan(asLinear.g);
  });

  it('treats a bare hex as sRGB', () => {
    // `new THREE.Color(hex)` with no colour space named is the form used
    // throughout the renderer; it has to mean the sRGB reading.
    const bare = new THREE.Color(PALETTE.brick);
    const named = new THREE.Color().setHex(PALETTE.brick, THREE.SRGBColorSpace);
    expect(bare.getHex()).toBe(named.getHex());
  });
});

describe('the day/night cycle drives its lights through the same decode', () => {
  it('decodes setRGB tagged as sRGB', () => {
    // The form at scene.ts:1094-1098, for the sun, the ambient and the sky.
    const color = new THREE.Color().setRGB(0.5, 0.25, 0.75, THREE.SRGBColorSpace);
    expect(color.r).toBeCloseTo(srgbDecode(0.5), 9);
    expect(color.g).toBeCloseTo(srgbDecode(0.25), 9);
    expect(color.b).toBeCloseTo(srgbDecode(0.75), 9);
  });
});
