import { describe, expect, it } from 'vitest';
import {
  desaturate,
  flattenLuma,
  glslInkChunk,
  inkAmount,
  inkFill,
  luminance,
  towardFog,
  type InkSettings,
} from './ink.js';

const SETTINGS: InkSettings = {
  inkStart: 1000,
  inkEnd: 5000,
  inkFlatten: 1,
  inkDesaturate: 1,
  inkFog: 1,
};

describe('inkAmount', () => {
  it('is off in front of the start and full past the end', () => {
    expect(inkAmount(500, 1000, 5000)).toBe(0);
    expect(inkAmount(1000, 1000, 5000)).toBe(0);
    expect(inkAmount(5000, 1000, 5000)).toBe(1);
    expect(inkAmount(9000, 1000, 5000)).toBe(1);
  });

  it('rises smoothly rather than linearly', () => {
    // A linear ramp leaves a visible line across the ground where the effect
    // starts: the eye finds the break in the slope even though the value is
    // continuous. Smoothstep has zero slope at both ends, which is the fix.
    const justInside = inkAmount(1040, 1000, 5000);
    const linear = 40 / 4000;
    expect(justInside).toBeLessThan(linear / 2);
    expect(inkAmount(3000, 1000, 5000)).toBeCloseTo(0.5, 6);
  });

  it('is monotonic', () => {
    let previous = -1;
    for (let d = 0; d <= 6000; d += 100) {
      const t = inkAmount(d, 1000, 5000);
      expect(t).toBeGreaterThanOrEqual(previous);
      previous = t;
    }
  });

  it('survives a degenerate range', () => {
    expect(inkAmount(10, 500, 500)).toBe(0);
    expect(inkAmount(900, 500, 500)).toBe(1);
    expect(inkAmount(10, 900, 100)).toBe(0);
  });
});

describe('flattenLuma', () => {
  it('leaves a colour alone at zero', () => {
    expect(flattenLuma([0.4, 0.6, 0.2], 0.5, 0)).toEqual([0.4, 0.6, 0.2]);
  });

  it('gives every colour the same luminance at one, which is what flat means', () => {
    // The claim the whole term exists for: a surface whose pixels share a
    // luminance has no shading gradient left.
    for (const c of [[0.1, 0.2, 0.05], [0.6, 0.8, 0.4], [0.3, 0.3, 0.3]] as const) {
      expect(luminance(flattenLuma(c, 0.45, 1))).toBeCloseTo(0.45, 9);
    }
  });

  it('holds the hue while it does it', () => {
    // Chroma ratios are preserved, so a green hillside flattens to a flat green
    // rather than toward grey -- that is what the desaturate term is for.
    const [r, g, b] = flattenLuma([0.2, 0.6, 0.1], 0.5, 1);
    expect(g / r).toBeCloseTo(0.6 / 0.2, 6);
    expect(b / r).toBeCloseTo(0.1 / 0.2, 6);
  });

  it('refuses to scale a colour with no luminance to speak of', () => {
    // Otherwise the scale factor is a division by nearly zero, and near-black
    // pixels detonate into whatever hue they happened to have.
    expect(flattenLuma([0, 0, 0], 0.5, 1)).toEqual([0, 0, 0]);
    expect(flattenLuma([0.0001, 0.0001, 0.0001], 0.5, 1)).toEqual([0.0001, 0.0001, 0.0001]);
  });
});

describe('desaturate', () => {
  it('reaches exactly grey at one, and grey has the same luminance', () => {
    const grey = desaturate([0.2, 0.6, 0.1], 1);
    expect(grey[0]).toBeCloseTo(grey[1], 9);
    expect(grey[1]).toBeCloseTo(grey[2], 9);
    expect(luminance(grey)).toBeCloseTo(luminance([0.2, 0.6, 0.1]), 9);
  });

  it('leaves a colour alone at zero', () => {
    expect(desaturate([0.2, 0.6, 0.1], 0)).toEqual([0.2, 0.6, 0.1]);
  });
});

describe('towardFog', () => {
  it('reaches the fog colour exactly at one', () => {
    expect(towardFog([0.2, 0.6, 0.1], [0.5, 0.8, 0.75], 1)).toEqual([0.5, 0.8, 0.75]);
  });
});

describe('inkFill', () => {
  it('does nothing in front of the start', () => {
    expect(inkFill([0.2, 0.6, 0.1], [0.5, 0.8, 0.75], 400, 0.45, SETTINGS)).toEqual([0.2, 0.6, 0.1]);
  });

  it('flattens two shades of one surface onto exactly one colour', () => {
    // The effect, stated as the thing a viewer would see: a lit hillside and its
    // shadowed half stop being distinguishable and become one shape.
    //
    // Exactly, not approximately, and that is a fact about Lambert rather than a
    // lucky tolerance: diffuse shading is albedo times a scalar, so a lit pixel
    // and a shaded pixel of one surface differ only in luminance -- which is the
    // single quantity this term normalizes. (An earlier version of this test
    // invented two "shades" that were not a scalar multiple of each other, and
    // then needed a loose tolerance to pass. The tolerance was hiding that the
    // fixture, not the code, was wrong.)
    const albedo: readonly [number, number, number] = [0.34, 0.7, 0.18];
    const flat = { ...SETTINGS, inkDesaturate: 0, inkFog: 0 };
    const lit = inkFill([albedo[0] * 0.9, albedo[1] * 0.9, albedo[2] * 0.9], [0.5, 0.8, 0.75], 5000, 0.45, flat);
    const shade = inkFill([albedo[0] * 0.35, albedo[1] * 0.35, albedo[2] * 0.35], [0.5, 0.8, 0.75], 5000, 0.45, flat);
    for (let i = 0; i < 3; i++) {
      expect(lit[i] as number).toBeCloseTo(shade[i] as number, 9);
    }
  });

  it('ends at the fog colour when everything is turned up', () => {
    const out = inkFill([0.2, 0.6, 0.1], [0.5, 0.8, 0.75], 9000, 0.45, SETTINGS);
    expect(out[0]).toBeCloseTo(0.5, 6);
    expect(out[1]).toBeCloseTo(0.8, 6);
    expect(out[2]).toBeCloseTo(0.75, 6);
  });

  it('moves further the further away it is', () => {
    const near = inkFill([0.2, 0.6, 0.1], [0.5, 0.8, 0.75], 1500, 0.45, SETTINGS);
    const far = inkFill([0.2, 0.6, 0.1], [0.5, 0.8, 0.75], 4000, 0.45, SETTINGS);
    const distance = (a: readonly [number, number, number]): number =>
      Math.hypot(a[0] - 0.2, a[1] - 0.6, a[2] - 0.1);
    expect(distance(far)).toBeGreaterThan(distance(near));
  });

  it('applies the three terms in the order that makes each one count', () => {
    // Flatten before desaturate: flattening a grey is the same operation as
    // fogging it, so the reverse order spends one of the three terms twice.
    const flattenFirst = inkFill([0.2, 0.6, 0.1], [0, 0, 0], 5000, 0.45, {
      ...SETTINGS,
      inkFog: 0,
    });
    const grey = desaturate([0.2, 0.6, 0.1], 1);
    const desaturateFirst = flattenLuma(grey, 0.45, 1);
    expect(flattenFirst).not.toEqual(desaturateFirst);
    // And the order chosen is the one that still has chroma to hold.
    expect(luminance(flattenFirst)).toBeCloseTo(0.45, 6);
  });
});

describe('glslInkChunk', () => {
  it('declares what the pass calls', () => {
    const glsl = glslInkChunk();
    expect(glsl).toContain('float inkAmount(');
    expect(glsl).toContain('vec3 flattenLuma(');
    expect(glsl).toContain('vec3 inkFill(');
  });

  it('smoothsteps, and does it by hand rather than by name', () => {
    // Written out so it matches the reference exactly; GLSL's own smoothstep is
    // the same curve but the reference has to be readable beside it.
    expect(glslInkChunk()).toContain('return t * t * (3.0 - 2.0 * t);');
  });

  it('carries the same luma weights the reference uses', () => {
    expect(glslInkChunk()).toContain('vec3(0.2126, 0.7152, 0.0722)');
  });

  it('applies the three terms in the reference order', () => {
    const glsl = glslInkChunk();
    const flatten = glsl.indexOf('flattenLuma(c, target');
    const desat = glsl.indexOf('t * desat');
    const fog = glsl.indexOf('t * fogAmount');
    expect(flatten).toBeGreaterThan(0);
    expect(desat).toBeGreaterThan(flatten);
    expect(fog).toBeGreaterThan(desat);
  });
});
