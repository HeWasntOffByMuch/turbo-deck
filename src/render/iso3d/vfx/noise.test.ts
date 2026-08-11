import { describe, expect, it } from 'vitest';
import { noise3, turbulence3 } from './noise.js';

const out = new Float32Array(8);

describe('noise3', () => {
  it('is a pure function of its inputs', () => {
    for (let i = 0; i < 50; i++) {
      const a = noise3(i * 0.37, i * 1.1, i * 0.03, 42);
      const b = noise3(i * 0.37, i * 1.1, i * 0.03, 42);
      expect(a).toBe(b);
    }
  });

  it('stays inside [-1, 1)', () => {
    for (let i = 0; i < 4000; i++) {
      const v = noise3(i * 0.13, i * 0.29 - 40, i * 0.07, 7);
      expect(v).toBeGreaterThanOrEqual(-1);
      expect(v).toBeLessThan(1);
    }
  });

  it('is continuous across a lattice boundary', () => {
    // The property smoothstep exists for: without it the lattice shows up as a
    // grid of creases in the field, and a smoke column visibly steps.
    const before = noise3(2 - 1e-6, 0.4, 0.6, 3);
    const after = noise3(2 + 1e-6, 0.4, 0.6, 3);
    expect(Math.abs(after - before)).toBeLessThan(1e-4);
  });

  it('gives different fields for different seeds', () => {
    let differences = 0;
    for (let i = 0; i < 200; i++) {
      if (noise3(i * 0.3, 0, 0, 1) !== noise3(i * 0.3, 0, 0, 2)) differences += 1;
    }
    expect(differences).toBeGreaterThan(150);
  });
});

describe('turbulence3', () => {
  it('writes three components at the requested offset and nothing else', () => {
    const wide = new Float32Array(8).fill(-99);
    turbulence3(1.5, 2.5, 3.5, 11, wide, 2);
    expect(wide[1]).toBe(-99);
    expect(wide[5]).toBe(-99);
    for (let i = 2; i < 5; i++) {
      expect(wide[i]).toBeGreaterThanOrEqual(-1);
      expect(wide[i]).toBeLessThan(1);
    }
  });

  it('is a pure function of its inputs', () => {
    turbulence3(3.3, -1.2, 0.7, 5, out, 0);
    const first = Array.from(out.subarray(0, 3));
    out.fill(0);
    turbulence3(3.3, -1.2, 0.7, 5, out, 0);
    expect(Array.from(out.subarray(0, 3))).toEqual(first);
  });

  it('gives three uncorrelated axes rather than three copies of one', () => {
    // The whole point of reading three bit-fields out of one hash: if the axes
    // agreed, turbulence would push every particle along one diagonal.
    let equalXY = 0;
    let equalXZ = 0;
    const n = 500;
    for (let i = 0; i < n; i++) {
      turbulence3(i * 0.41, i * 0.17, i * 0.93, 9, out, 0);
      if (out[0] === out[1]) equalXY += 1;
      if (out[0] === out[2]) equalXZ += 1;
    }
    expect(equalXY).toBeLessThan(n * 0.05);
    expect(equalXZ).toBeLessThan(n * 0.05);
  });

  it('agrees with the scalar reference on its first axis', () => {
    // turbulence3's axis 0 and noise3 read the same low 10 bits of the same
    // lattice, so the flattened version cannot silently drift from the reference.
    for (let i = 0; i < 200; i++) {
      const x = i * 0.23;
      const y = i * 0.11 - 3;
      const z = i * 0.71;
      turbulence3(x, y, z, 13, out, 0);
      expect(out[0]).toBeCloseTo(noise3(x, y, z, 13), 6);
    }
  });

  it('is continuous across a lattice boundary on every axis', () => {
    turbulence3(4 - 1e-6, 1.3, 2.7, 21, out, 0);
    const before = Array.from(out.subarray(0, 3));
    turbulence3(4 + 1e-6, 1.3, 2.7, 21, out, 0);
    for (let axis = 0; axis < 3; axis++) {
      expect(Math.abs((out[axis] ?? 0) - (before[axis] ?? 0))).toBeLessThan(1e-4);
    }
  });

  it('covers most of its range rather than hugging the middle', () => {
    let low = 0;
    let high = 0;
    for (let i = 0; i < 3000; i++) {
      turbulence3(i * 0.37, i * 0.19, i * 0.53, 4, out, 0);
      if ((out[0] ?? 0) < -0.4) low += 1;
      if ((out[0] ?? 0) > 0.4) high += 1;
    }
    expect(low).toBeGreaterThan(100);
    expect(high).toBeGreaterThan(100);
  });
});
