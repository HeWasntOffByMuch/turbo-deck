import { describe, expect, it } from 'vitest';
import { applySpread, sampleShape, SHAPE, type CompiledShape } from './shapes.js';
import { VfxRng } from './rng.js';

const out = new Float32Array(6);

function draw(shape: CompiledShape, seed: number, index = 0, total = 1): Float32Array {
  const rng = new VfxRng(seed);
  sampleShape(shape, rng, out, 0, index, total);
  return out;
}

function length(at: number): number {
  const x = out[at] ?? 0;
  const y = out[at + 1] ?? 0;
  const z = out[at + 2] ?? 0;
  return Math.sqrt(x * x + y * y + z * z);
}

describe('sampleShape', () => {
  it('always writes a unit direction, whatever the shape', () => {
    const shapes: CompiledShape[] = [
      { kind: SHAPE.point, a: 0, b: 0, c: 0 },
      { kind: SHAPE.sphere, a: 10, b: 0, c: 0 },
      { kind: SHAPE.hemisphere, a: 10, b: 1, c: 0 },
      { kind: SHAPE.cone, a: 0.6, b: 4, c: 0 },
      { kind: SHAPE.box, a: 3, b: 4, c: 5 },
      { kind: SHAPE.circle, a: 8, b: 0, c: 0 },
      { kind: SHAPE.arc, a: 20, b: 1.2, c: 0 },
      { kind: SHAPE.mesh, a: 0, b: 0, c: 0 },
    ];
    for (const shape of shapes) {
      for (let seed = 0; seed < 40; seed++) {
        draw(shape, seed);
        expect(length(3)).toBeCloseTo(1, 4);
      }
    }
  });

  it('keeps sphere samples inside the radius, and on it when shelled', () => {
    for (let seed = 0; seed < 200; seed++) {
      draw({ kind: SHAPE.sphere, a: 10, b: 0, c: 0 }, seed);
      expect(length(0)).toBeLessThanOrEqual(10.0001);
    }
    for (let seed = 0; seed < 200; seed++) {
      draw({ kind: SHAPE.sphere, a: 10, b: 1, c: 0 }, seed);
      expect(length(0)).toBeCloseTo(10, 3);
    }
  });

  it('never points a hemisphere downward', () => {
    for (let seed = 0; seed < 200; seed++) {
      draw({ kind: SHAPE.hemisphere, a: 5, b: 0, c: 0 }, seed);
      expect(out[4] ?? -1).toBeGreaterThanOrEqual(0);
    }
  });

  it('keeps cone directions inside the half-angle', () => {
    const angle = 0.6;
    for (let seed = 0; seed < 300; seed++) {
      draw({ kind: SHAPE.cone, a: angle, b: 4, c: 0 }, seed);
      // The cone opens about +Y, so the direction's Y is its cosine.
      expect(out[4] ?? 0).toBeGreaterThanOrEqual(Math.cos(angle) - 1e-4);
    }
  });

  it('keeps box samples inside their half extents', () => {
    for (let seed = 0; seed < 200; seed++) {
      draw({ kind: SHAPE.box, a: 3, b: 4, c: 5 }, seed);
      expect(Math.abs(out[0] ?? 0)).toBeLessThanOrEqual(3);
      expect(Math.abs(out[1] ?? 0)).toBeLessThanOrEqual(4);
      expect(Math.abs(out[2] ?? 0)).toBeLessThanOrEqual(5);
    }
  });

  it('keeps circle samples flat and inside the radius', () => {
    for (let seed = 0; seed < 200; seed++) {
      draw({ kind: SHAPE.circle, a: 9, b: 0, c: 0 }, seed);
      expect(out[1]).toBe(0);
      expect(length(0)).toBeLessThanOrEqual(9.0001);
    }
  });

  it('lays an arc out in emission order rather than at random', () => {
    // The property that makes a slash read as a cut: the first particle is at
    // one end of the sweep and the last is at the other.
    const shape: CompiledShape = { kind: SHAPE.arc, a: 30, b: 1.4, c: 0 };
    const rng = new VfxRng(11);
    const angles: number[] = [];
    for (let i = 0; i < 8; i++) {
      sampleShape(shape, rng, out, 0, i, 8);
      angles.push(Math.atan2(out[2] ?? 0, out[0] ?? 0));
    }
    for (let i = 1; i < angles.length; i++) {
      expect(angles[i] ?? 0).toBeGreaterThan(angles[i - 1] ?? 0);
    }
  });

  it('gives the arc a tangential direction, not a radial one', () => {
    const rng = new VfxRng(5);
    sampleShape({ kind: SHAPE.arc, a: 30, b: 1.4, c: 0 }, rng, out, 0, 3, 8);
    const dot = (out[0] ?? 0) * (out[3] ?? 0) + (out[2] ?? 0) * (out[5] ?? 0);
    expect(Math.abs(dot)).toBeLessThan(1e-3);
  });
});

describe('applySpread', () => {
  it('leaves a direction alone at zero spread', () => {
    const rng = new VfxRng(3);
    out.set([0, 0, 0, 0, 1, 0]);
    applySpread(rng, out, 3, 0);
    expect(Array.from(out.subarray(3))).toEqual([0, 1, 0]);
  });

  it('stays inside the spread angle and stays normalized', () => {
    const spread = 0.4;
    for (let seed = 0; seed < 300; seed++) {
      const rng = new VfxRng(seed);
      out.set([0, 0, 0, 0, 1, 0]);
      applySpread(rng, out, 3, spread);
      expect(length(3)).toBeCloseTo(1, 4);
      expect(out[4] ?? 0).toBeGreaterThanOrEqual(Math.cos(spread) - 1e-4);
    }
  });

  it('handles a direction aligned with each axis without collapsing', () => {
    // The degenerate case a naive helper axis gets wrong: cross(d, d) is zero,
    // and the particle either keeps its exact direction or goes to NaN.
    for (const axis of [[1, 0, 0], [0, 1, 0], [0, 0, 1], [-1, 0, 0]]) {
      const rng = new VfxRng(7);
      out.set([0, 0, 0, axis[0] ?? 0, axis[1] ?? 0, axis[2] ?? 0]);
      applySpread(rng, out, 3, 0.5);
      expect(length(3)).toBeCloseTo(1, 4);
      expect(Number.isNaN(out[3] ?? NaN)).toBe(false);
    }
  });
});
