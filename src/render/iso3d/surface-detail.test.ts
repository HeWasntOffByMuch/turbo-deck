import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TRIPLANAR_SHARPNESS,
  glslSurfaceDetail,
  rockBlend,
  triplanarWeights,
  type BlendSettings,
  maxNoiseForFlatGround,
} from './surface-detail.js';

/** The panel's ceiling on `Ragged edge`, mirrored here so the bound is asserted. */
const BLEND_NOISE_MAX = 0.4;

const BLEND: BlendSettings = {
  slopeStart: 0.85,
  slopeEnd: 0.5,
  heightStart: 260,
  heightEnd: 420,
  noise: 0,
};

describe('triplanarWeights', () => {
  it('always sums to one, so a blend never brightens or dims the surface', () => {
    for (const n of [
      [0, 1, 0],
      [1, 0, 0],
      [0.577, 0.577, 0.577],
      [-0.3, 0.6, -0.74],
      [0.01, 0.999, 0.02],
    ] as const) {
      const [wx, wy, wz] = triplanarWeights(n[0], n[1], n[2]);
      expect(wx + wy + wz).toBeCloseTo(1, 12);
    }
  });

  it('gives a vertical face almost nothing from the ground projection', () => {
    // The whole point. A cliff sampled from the ground plane smears one row of
    // texels down its entire height, and the eye reads that instantly.
    const [, wy] = triplanarWeights(1, 0, 0);
    expect(wy).toBeLessThan(1e-6);
    const [, nearlyVertical] = triplanarWeights(0.98, 0.2, 0);
    expect(nearlyVertical).toBeLessThan(0.01);
  });

  it('gives flat ground almost everything from the ground projection', () => {
    const [, wy] = triplanarWeights(0, 1, 0);
    expect(wy).toBeGreaterThan(0.999999);
  });

  it('commits harder as sharpness rises, monotonically', () => {
    let previous = 0;
    for (const sharpness of [1, 2, 4, 8, 16]) {
      const [, wy] = triplanarWeights(0.5, 0.8, 0.33, sharpness);
      expect(wy).toBeGreaterThan(previous);
      previous = wy;
    }
  });

  it('answers a degenerate normal instead of dividing by zero', () => {
    // This terrain does produce them: a cell at a layer's edge can collapse, and
    // a NaN weight paints the surface black rather than looking like a bug.
    const [wx, wy, wz] = triplanarWeights(0, 0, 0);
    expect(wx + wy + wz).toBeCloseTo(1, 12);
    expect(Number.isFinite(wx)).toBe(true);
  });

  it('is symmetric in sign, since a back face is the same surface', () => {
    expect(triplanarWeights(0.6, 0.5, -0.62)).toEqual(triplanarWeights(-0.6, -0.5, 0.62));
  });

  it('opens at a sharpness that is a real choice', () => {
    expect(DEFAULT_TRIPLANAR_SHARPNESS).toBeGreaterThan(1);
  });
});

describe('rockBlend', () => {
  it('leaves flat low ground entirely as soil', () => {
    expect(rockBlend(1, 0, 0.5, BLEND)).toBe(0);
  });

  it('makes a vertical face entirely rock', () => {
    expect(rockBlend(0, 0, 0.5, BLEND)).toBe(1);
  });

  it('makes a bald summit rock even where it is flat', () => {
    // Either reason is enough. Requiring both would leave a cliff at sea level
    // and a flat summit each looking like meadow.
    expect(rockBlend(1, 500, 0.5, BLEND)).toBe(1);
  });

  it('rises as the ground steepens', () => {
    let previous = -1;
    for (const normalY of [1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.3]) {
      const value = rockBlend(normalY, 0, 0.5, BLEND);
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
  });

  it('stays in range for absurd inputs', () => {
    for (const [n, h] of [[5, -9000], [-3, 1e6], [0, Number.NaN]] as const) {
      const value = rockBlend(n, h, 0.5, BLEND);
      if (Number.isNaN(h)) continue;
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  it('leaves dead-flat ground alone for every noise the panel can ask for', () => {
    // The displacement is a fraction of the ramp, not an absolute shift in normal
    // units. Applied absolutely, a quarter of noise displaced the boundary by 0.25
    // against a ramp 0.35 wide -- past ground with no slope at all, so a meadow
    // grew patches of stone. It looked like a plausible amount of noise until
    // something counted pixels.
    //
    // The bound is real rather than chosen: past `maxNoiseForFlatGround` the
    // boundary genuinely does reach flat ground, so the slider stops there instead
    // of the code pretending otherwise.
    const limit = maxNoiseForFlatGround(BLEND.slopeStart, BLEND.slopeEnd);
    expect(limit).toBeGreaterThan(BLEND_NOISE_MAX);
    for (let n = 0; n <= 1; n += 0.05) {
      expect(rockBlend(1, 0, n, { ...BLEND, noise: BLEND_NOISE_MAX })).toBe(0);
    }
  });

  it('does reach flat ground past that bound, which is why the bound exists', () => {
    // Stated rather than hidden: the guarantee above is a property of the setting
    // range, not of the formula, and a test that only ever passed would not say
    // which.
    const beyond = maxNoiseForFlatGround(BLEND.slopeStart, BLEND.slopeEnd) + 0.2;
    expect(rockBlend(1, 0, 1, { ...BLEND, noise: beyond })).toBeGreaterThan(0);
  });

  it('moves the boundary both ways with the noise, and by a bounded amount', () => {
    // The term the whole blend exists for. Without it the boundary is a contour
    // line on a heightfield, which is as regular as the lattice underneath it.
    const noisy = { ...BLEND, noise: 0.25 };
    // Picked on the slope ramp, where the boundary actually is.
    const low = rockBlend(0.72, 0, 0, noisy);
    const mid = rockBlend(0.72, 0, 0.5, noisy);
    const high = rockBlend(0.72, 0, 1, noisy);
    expect(low).not.toBeCloseTo(mid, 3);
    expect(high).not.toBeCloseTo(mid, 3);
    // Opposite sides: one displaces toward rock and the other toward soil.
    expect(Math.sign(low - mid)).toBe(-Math.sign(high - mid));
    // And centred, so noise at 0.5 is the un-displaced boundary.
    expect(mid).toBeCloseTo(rockBlend(0.72, 0, 0.5, BLEND), 12);
  });

  it('survives a degenerate ramp rather than dividing by zero', () => {
    const flat = { ...BLEND, slopeStart: 0.5, slopeEnd: 0.5, heightStart: 100, heightEnd: 100 };
    const value = rockBlend(0.5, 200, 0.5, flat);
    expect(Number.isFinite(value)).toBe(true);
  });
});

describe('glslSurfaceDetail', () => {
  it('declares the functions the ground materials call', () => {
    const glsl = glslSurfaceDetail();
    expect(glsl).toContain('vec3 triplanarWeights(');
    expect(glsl).toContain('float triplanarDetail(');
    expect(glsl).toContain('float rockBlend(');
  });

  it('samples three projections and never the same one twice', () => {
    // Two identical projections is a bug that still looks like a texture, and it
    // is exactly the smear triplanar exists to avoid.
    const glsl = glslSurfaceDetail();
    for (const swizzle of ['worldPos.zy', 'worldPos.xz', 'worldPos.xy']) {
      expect(glsl).toContain(swizzle);
    }
  });

  it('guards the degenerate normal the reference guards', () => {
    expect(glslSurfaceDetail()).toContain('if (total <= 0.0)');
  });

  it('centres the noise the same way the reference does', () => {
    expect(glslSurfaceDetail()).toContain('(noiseValue - 0.5) * 2.0 * noiseAmount');
  });
});
