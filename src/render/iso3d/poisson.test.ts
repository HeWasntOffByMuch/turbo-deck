import { describe, expect, it } from 'vitest';
import { Rng } from '../../shared/prng.js';
import {
  SHADOW_DISK_SEED,
  SHADOW_DISK_TAPS,
  SHADOW_POISSON_DISK,
  centroid,
  glslPoissonShadow,
  minimumSeparation,
  poissonDisk,
} from './poisson.js';

describe('poissonDisk', () => {
  it('puts every point inside the unit disc', () => {
    // The radius the shader multiplies by is in texels, so a point outside the
    // unit disc silently reaches further than the setting says it does.
    for (const [x, y] of SHADOW_POISSON_DISK) {
      expect(Math.hypot(x, y)).toBeLessThanOrEqual(1);
    }
  });

  it('produces the number of taps asked for', () => {
    expect(SHADOW_POISSON_DISK).toHaveLength(SHADOW_DISK_TAPS);
    expect(poissonDisk(5, Rng.fromSeed(1))).toHaveLength(5);
    expect(poissonDisk(0, Rng.fromSeed(1))).toEqual([]);
  });

  it('keeps its points apart, which is the whole of what "Poisson" means here', () => {
    // The property that separates a blue-noise kernel from twelve random points,
    // and the one a hand-pasted table fails quietly: two taps landing on the same
    // texel is a wasted sample and a lumpy penumbra.
    //
    // Twelve points spread over the unit disc have about 0.26 of area each, so a
    // separation of 0.35 is a real constraint rather than a formality -- uniform
    // random points of this count routinely come within 0.1 of each other, which
    // the comparison below demonstrates rather than asserts in the abstract.
    expect(minimumSeparation(SHADOW_POISSON_DISK)).toBeGreaterThan(0.35);
  });

  it('beats a uniform draw at spreading out, on the same seed', () => {
    // The claim above, made relative: best-candidate is doing something, and this
    // is what it is doing.
    let rng = Rng.fromSeed(SHADOW_DISK_SEED);
    const random: [number, number][] = [];
    for (let i = 0; i < SHADOW_DISK_TAPS; i++) {
      const [u, afterU] = rng.nextInt(0, 0xffffff);
      const [v, afterV] = afterU.nextInt(0, 0xffffff);
      rng = afterV;
      const radius = Math.sqrt(u / 0x1000000);
      const angle = (v / 0x1000000) * 2 * Math.PI;
      random.push([radius * Math.cos(angle), radius * Math.sin(angle)]);
    }
    expect(minimumSeparation(SHADOW_POISSON_DISK)).toBeGreaterThan(minimumSeparation(random) * 2);
  });

  it('is roughly centred, so the penumbra does not lean', () => {
    // A lopsided kernel shifts the shadow rather than softening it, which reads as
    // the sun having moved when the checkbox was ticked.
    const [x, y] = centroid(SHADOW_POISSON_DISK);
    expect(Math.hypot(x, y)).toBeLessThan(0.2);
  });

  it('is the same disc every time, and a different one for a different seed', () => {
    expect(poissonDisk(SHADOW_DISK_TAPS, Rng.fromSeed(SHADOW_DISK_SEED))).toEqual(
      [...SHADOW_POISSON_DISK],
    );
    expect(poissonDisk(SHADOW_DISK_TAPS, Rng.fromSeed(7))).not.toEqual([...SHADOW_POISSON_DISK]);
  });
});

describe('glslPoissonShadow', () => {
  it('carries exactly the points the array holds, in order', () => {
    // Parsed back out rather than string-matched: the check is that the shader
    // samples the disc that was tested, not that it mentions some numbers.
    const glsl = glslPoissonShadow(SHADOW_POISSON_DISK);
    const vectors = [...glsl.matchAll(/vec2\( (-?\d+\.\d+), (-?\d+\.\d+) \)/g)].map(
      (m) => [Number(m[1]), Number(m[2])] as const,
    );
    expect(vectors).toHaveLength(SHADOW_POISSON_DISK.length);
    vectors.forEach(([x, y], i) => {
      const point = SHADOW_POISSON_DISK[i];
      expect(x).toBeCloseTo(point?.[0] ?? 0, 5);
      expect(y).toBeCloseTo(point?.[1] ?? 0, 5);
    });
  });

  it('averages the taps rather than summing them', () => {
    // A filter that returns a sum is a filter that reports twelve times the light
    // and blows out every lit surface, which looks like a lighting bug elsewhere.
    expect(glslPoissonShadow(SHADOW_POISSON_DISK)).toContain(`sum * ${(1 / 12).toFixed(8)}`);
  });

  it('declares the function the patched chunk calls', () => {
    expect(glslPoissonShadow(SHADOW_POISSON_DISK)).toContain('float hikePoissonShadow(');
  });

  it('scales its taps by the radius it is handed', () => {
    // Otherwise the slider does nothing and the kernel is one texel wide forever.
    expect(glslPoissonShadow(SHADOW_POISSON_DISK)).toContain('* radius');
  });

  it('survives an empty disc without emitting a division by zero', () => {
    expect(glslPoissonShadow([])).toContain('sum * 1.0');
  });
});
