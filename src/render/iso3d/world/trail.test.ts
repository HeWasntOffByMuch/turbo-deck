import { describe, expect, it } from 'vitest';
import { Trail } from './trail.js';

/** A straight flight along +x, one push per unit of `step`. */
function flown(trail: Trail, count: number, step: number): Trail {
  for (let i = 0; i < count; i++) trail.push({ x: i * step, y: 0, z: 5 });
  return trail;
}

describe('Trail', () => {
  it('samples by distance, so the streak is the flight and not the frame rate', () => {
    // The same 100 units of flight, asked for four times as often.
    const coarse = flown(new Trail(50, 10), 11, 10);
    const fine = flown(new Trail(50, 10), 41, 2.5);
    expect(fine.samples).toEqual(coarse.samples);
  });

  it('drops a push that has not gone far enough, and keeps one that has', () => {
    const trail = new Trail(10, 5);
    trail.push({ x: 0, y: 0, z: 0 });
    trail.push({ x: 1, y: 0, z: 0 });
    trail.push({ x: 2, y: 0, z: 0 });
    expect(trail.samples).toHaveLength(1);
    trail.push({ x: 6, y: 0, z: 0 });
    expect(trail.samples).toHaveLength(2);
    // Newest first: the head is the end that is being drawn from.
    expect(trail.samples[0]?.x).toBe(6);
  });

  it('never grows past its capacity, and it is the oldest that goes', () => {
    const trail = flown(new Trail(4, 1), 20, 10);
    expect(trail.samples).toHaveLength(4);
    expect(trail.samples.map((sample) => sample.x)).toEqual([190, 180, 170, 160]);
  });

  it('refuses a sample that is not a place', () => {
    const trail = new Trail(8, 1);
    trail.push({ x: Number.NaN, y: 0, z: 0 });
    trail.push({ x: 0, y: Number.POSITIVE_INFINITY, z: 0 });
    trail.push({ x: 0, y: 0, z: Number.NaN });
    expect(trail.samples).toHaveLength(0);
  });

  it('clears', () => {
    const trail = flown(new Trail(8, 1), 5, 10);
    expect(trail.samples.length).toBeGreaterThan(0);
    trail.clear();
    expect(trail.samples).toHaveLength(0);
    expect(trail.ribbon(3, 1).positions).toHaveLength(0);
  });

  it('draws nothing until there is a direction to draw along', () => {
    const trail = new Trail(8, 1);
    expect(trail.ribbon(3, 1)).toEqual({ positions: [], alphas: [], indices: [] });
    trail.push({ x: 0, y: 0, z: 0 });
    // One point is a point, not a streak.
    expect(trail.ribbon(3, 1).indices).toHaveLength(0);
    trail.push({ x: 10, y: 0, z: 0 });
    expect(trail.ribbon(3, 1).indices.length).toBeGreaterThan(0);
  });

  it('is a well-formed strip: two vertices a sample, tapering to nothing', () => {
    const trail = flown(new Trail(6, 10), 6, 10);
    const ribbon = trail.ribbon(4, 2);
    const count = trail.samples.length;

    expect(ribbon.positions).toHaveLength(count * 2 * 3);
    expect(ribbon.alphas).toHaveLength(count * 2);
    expect(ribbon.indices).toHaveLength((count - 1) * 6);
    for (const value of [...ribbon.positions, ...ribbon.alphas]) {
      expect(Number.isFinite(value)).toBe(true);
    }
    // Every index addresses a vertex that exists.
    for (const index of ribbon.indices) {
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(count * 2);
    }

    // Opaque and full width at the head, gone at the tail, and monotone between.
    expect(ribbon.alphas[0]).toBe(1);
    expect(ribbon.alphas[ribbon.alphas.length - 1]).toBe(0);
    for (let i = 2; i < ribbon.alphas.length; i += 2) {
      expect(ribbon.alphas[i]).toBeLessThan(ribbon.alphas[i - 2] as number);
    }

    // Flight is along +x, so the strip spreads across y, and it narrows.
    const spread = (sample: number): number =>
      Math.abs((ribbon.positions[sample * 6 + 1] as number) - (ribbon.positions[sample * 6 + 4] as number));
    expect(spread(0)).toBeCloseTo(8, 9);
    expect(spread(count - 1)).toBeCloseTo(0, 9);
    expect(spread(1)).toBeLessThan(spread(0));
  });

  it('lifts the whole strip clear of the ground it is skimming', () => {
    const trail = flown(new Trail(4, 10), 4, 10);
    const ribbon = trail.ribbon(3, 2.5);
    for (let i = 2; i < ribbon.positions.length; i += 3) {
      // Every sample was pushed at z = 5.
      expect(ribbon.positions[i]).toBeCloseTo(7.5, 9);
    }
  });

  it('survives samples that repeat a position', () => {
    const trail = new Trail(6, 0);
    for (let i = 0; i < 5; i++) trail.push({ x: 3, y: 4, z: 1 });
    const ribbon = trail.ribbon(4, 1);
    expect(ribbon.positions).toHaveLength(5 * 2 * 3);
    for (const value of ribbon.positions) expect(Number.isFinite(value)).toBe(true);
  });

  it('holds a sane shape when asked for a nonsensical one', () => {
    const trail = flown(new Trail(Number.NaN, Number.NaN), 6, 10);
    expect(trail.samples.length).toBeGreaterThanOrEqual(2);
    const ribbon = trail.ribbon(4, 0);
    for (const value of ribbon.positions) expect(Number.isFinite(value)).toBe(true);
  });
});
