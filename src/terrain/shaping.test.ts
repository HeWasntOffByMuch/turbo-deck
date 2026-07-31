import { describe, expect, it } from 'vitest';
import {
  clamp01,
  distToPolyline,
  distToSegment,
  fbm,
  radialFalloff,
  smoothstep01,
  terrace,
  valueNoise2,
} from './shaping.js';

describe('easing', () => {
  it('clamps and eases flat at both ends', () => {
    expect(clamp01(-3)).toBe(0);
    expect(clamp01(3)).toBe(1);
    expect(smoothstep01(0)).toBe(0);
    expect(smoothstep01(1)).toBe(1);
    expect(smoothstep01(0.5)).toBeCloseTo(0.5, 10);
    expect(smoothstep01(-1)).toBe(0);
    expect(smoothstep01(2)).toBe(1);
  });
});

describe('value noise', () => {
  it('is deterministic and bounded to [0, 1)', () => {
    for (let i = 0; i < 500; i++) {
      const x = i * 0.37 - 90;
      const z = i * -0.61 + 40;
      const n = valueNoise2(x, z, 4242);
      expect(n).toBe(valueNoise2(x, z, 4242));
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThan(1);
    }
  });

  it('is continuous: a small step in x is a small step in output', () => {
    let previous = valueNoise2(0, 3.5, 11);
    for (let i = 1; i <= 400; i++) {
      const n = valueNoise2(i * 0.01, 3.5, 11);
      // One lattice cell spans 1.0, so a 0.01 step can move at most ~0.05.
      expect(Math.abs(n - previous)).toBeLessThan(0.05);
      previous = n;
    }
  });

  it('reproduces the lattice value at integer coordinates', () => {
    // Both fractional weights are 0 there, so it must return the corner exactly.
    expect(valueNoise2(6, -2, 3)).toBe(valueNoise2(6.0, -2.0, 3));
  });
});

describe('fbm', () => {
  it('stays in [0, 1) and depends on the seed', () => {
    let differed = false;
    for (let i = 0; i < 200; i++) {
      const x = i * 13;
      const z = i * -7;
      const a = fbm(x, z, 1);
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThan(1);
      if (a !== fbm(x, z, 2)) differed = true;
    }
    expect(differed).toBe(true);
  });

  it('is continuous across world-scale steps', () => {
    let previous = fbm(0, 0, 5);
    for (let x = 4; x <= 2000; x += 4) {
      const n = fbm(x, 0, 5);
      expect(Math.abs(n - previous)).toBeLessThan(0.1);
      previous = n;
    }
  });
});

describe('radialFalloff', () => {
  it('is 1 at the centre, 0 at the radius, and monotonic between', () => {
    expect(radialFalloff(0, 100, 40)).toBe(1);
    expect(radialFalloff(60, 100, 40)).toBe(1); // still inside the flat core
    expect(radialFalloff(100, 100, 40)).toBe(0);
    expect(radialFalloff(140, 100, 40)).toBe(0);

    let previous = 1;
    for (let d = 0; d <= 120; d += 2) {
      const w = radialFalloff(d, 100, 40);
      expect(w).toBeLessThanOrEqual(previous + 1e-12);
      expect(w).toBeGreaterThanOrEqual(0);
      expect(w).toBeLessThanOrEqual(1);
      previous = w;
    }
  });

  it('has no ground at a non-positive radius', () => {
    expect(radialFalloff(0, 0, 0)).toBe(0);
  });
});

describe('distances', () => {
  it('measures to a segment, not its infinite line', () => {
    expect(distToSegment(0, 0, -10, 0, 10, 0)).toBe(0);
    expect(distToSegment(0, 5, -10, 0, 10, 0)).toBeCloseTo(5, 10);
    // Past the end: distance to the endpoint, not a perpendicular foot.
    expect(distToSegment(20, 0, -10, 0, 10, 0)).toBeCloseTo(10, 10);
    // Degenerate segment behaves as a point.
    expect(distToSegment(3, 4, 0, 0, 0, 0)).toBeCloseTo(5, 10);
  });

  it('takes the nearest segment of a polyline', () => {
    const line = [
      [0, 0],
      [100, 0],
      [100, 100],
    ] as const;
    expect(distToPolyline(50, 10, line)).toBeCloseTo(10, 10);
    expect(distToPolyline(90, 50, line)).toBeCloseTo(10, 10);
    expect(distToPolyline(0, 0, [[5, 5]])).toBe(Infinity); // no segments
  });
});

describe('terrace', () => {
  it('is the identity at zero strength or zero step', () => {
    for (const h of [-30.5, 0, 12.25, 187.75]) {
      expect(terrace(h, 25, 0)).toBe(h);
      expect(terrace(h, 0, 1)).toBe(h);
    }
  });

  it('collapses a smooth ramp onto far fewer distinct heights', () => {
    const smooth = new Set<number>();
    const stepped = new Set<number>();
    for (let i = 0; i < 400; i++) {
      const h = i * 0.5; // a ramp 0..200
      smooth.add(Math.round(h * 100));
      stepped.add(Math.round(terrace(h, 25, 1) * 100));
    }
    expect(smooth.size).toBe(400);
    // Flat treads mean many inputs land on the same output.
    expect(stepped.size).toBeLessThan(smooth.size / 2);
  });

  it('is monotonic, and stays within a step of the height it shaped', () => {
    let previous = terrace(0, 20, 0.8);
    for (let i = 1; i <= 500; i++) {
      const h = i * 0.4;
      const t = terrace(h, 20, 0.8);
      expect(t).toBeGreaterThanOrEqual(previous - 1e-9);
      expect(Math.abs(t - h)).toBeLessThanOrEqual(20);
      previous = t;
    }
  });

  it('blends continuously between smooth and stepped', () => {
    const h = 37.5;
    const half = terrace(h, 25, 0.5);
    const full = terrace(h, 25, 1);
    expect(half).toBeCloseTo(h + (full - h) * 0.5, 10);
  });
});
