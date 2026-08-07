import { describe, expect, it } from 'vitest';
import {
  ARROW_DRAW_SCALE,
  arrowProfile,
  SHURIKEN_DRAW_SCALE,
  SHURIKEN_POINTS,
  SHURIKEN_WAIST,
  shurikenDrawRadius,
  shurikenOutline,
  shurikenThickness,
} from './projectile-shape.js';

describe('arrowProfile', () => {
  it('is an arrow: a head in front, a shaft, and fletching behind', () => {
    const arrow = arrowProfile(7);
    for (const [name, value] of Object.entries(arrow)) {
      expect(Number.isFinite(value), name).toBe(true);
      expect(value, name).toBeGreaterThan(0);
    }
    // The head is the wide end and the shaft the thin one, or it reads as a
    // pencil flying backwards.
    expect(arrow.headRadius).toBeGreaterThan(arrow.shaftRadius);
    // Fletching lives on the shaft, so it cannot be longer than one.
    expect(arrow.fletchLength).toBeLessThan(arrow.shaftLength);
    expect(arrow.length).toBeCloseTo(arrow.headLength + arrow.shaftLength, 9);
    // Hung off its middle, because the sim moves a point rather than a nose.
    expect(arrow.centreOffset).toBeCloseTo(arrow.length / 2, 9);
    // Long enough to read as pointing somewhere at the size it flies at.
    expect(arrow.length).toBeGreaterThan(arrow.headRadius * 3);
  });

  it('draws smaller than it collides, and still reads as an arrow (spec 082)', () => {
    const arrow = arrowProfile(7);
    expect(ARROW_DRAW_SCALE).toBeLessThan(1);
    // Small, but not a speck: still clearly longer than it is thick, or the
    // shape stops being what tells it from a bolt.
    expect(arrow.length).toBeGreaterThan(arrow.headRadius * 4);
    // And smaller than the shot's own hit radius suggests -- it was drawn at
    // about seven times it, which read as a javelin.
    expect(arrow.length).toBeLessThan(7 * 3);
    expect(arrowProfile(Number.NaN).length).toBeGreaterThan(0);
  });

  it('scales linearly, so a bigger arrow is the same arrow bigger', () => {
    const small = arrowProfile(4);
    const large = arrowProfile(12);
    for (const key of Object.keys(small) as (keyof typeof small)[]) {
      expect(large[key] / small[key], key).toBeCloseTo(3, 9);
    }
  });

  it('still yields an arrow for a radius that makes no sense', () => {
    for (const radius of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const arrow = arrowProfile(radius);
      expect(Number.isFinite(arrow.length), String(radius)).toBe(true);
      expect(arrow.length, String(radius)).toBeGreaterThan(0);
    }
  });
});

describe('shurikenOutline', () => {
  it('alternates tips and valleys around a closed star', () => {
    const radius = 6;
    const points = shurikenOutline(radius);
    expect(points).toHaveLength(SHURIKEN_POINTS * 2);

    points.forEach((point, i) => {
      const r = Math.hypot(point.x, point.y);
      expect(Number.isFinite(r)).toBe(true);
      // Even indices are the tips, odd the valleys between them -- and a valley
      // that is not strictly nearer than a tip is not a star, it is a polygon.
      expect(r).toBeCloseTo(i % 2 === 0 ? radius : radius * SHURIKEN_WAIST, 9);
    });
    expect(SHURIKEN_WAIST).toBeGreaterThan(0);
    expect(SHURIKEN_WAIST).toBeLessThan(1);
  });

  it('is centred on the origin and evenly spun about it', () => {
    const points = shurikenOutline(9, 5);
    expect(points).toHaveLength(10);

    const sumX = points.reduce((total, point) => total + point.x, 0);
    const sumY = points.reduce((total, point) => total + point.y, 0);
    expect(sumX).toBeCloseTo(0, 6);
    expect(sumY).toBeCloseTo(0, 6);

    // Every step around the star turns by the same angle.
    const step = Math.PI / 5;
    points.forEach((point, i) => {
      expect(Math.atan2(point.y, point.x)).toBeCloseTo(
        Math.atan2(Math.sin(step * i), Math.cos(step * i)),
        6,
      );
    });
  });

  it('scales with the shot it belongs to, and survives nonsense', () => {
    const small = shurikenOutline(3);
    const large = shurikenOutline(12);
    small.forEach((point, i) => {
      expect(Math.hypot(large[i]?.x ?? 0, large[i]?.y ?? 0)).toBeCloseTo(
        Math.hypot(point.x, point.y) * 4,
        9,
      );
    });

    for (const radius of [0, -1, Number.NaN]) {
      const points = shurikenOutline(radius);
      expect(points.length, String(radius)).toBe(SHURIKEN_POINTS * 2);
      for (const point of points) expect(Number.isFinite(point.x) && Number.isFinite(point.y)).toBe(true);
    }
    // A "star" with fewer than three points is not one; it falls back.
    expect(shurikenOutline(6, 2)).toHaveLength(SHURIKEN_POINTS * 2);
    expect(shurikenOutline(6, Number.NaN)).toHaveLength(SHURIKEN_POINTS * 2);
  });

  it('draws larger than it collides, so a small object still reads', () => {
    expect(shurikenDrawRadius(6)).toBeGreaterThan(6);
    expect(shurikenDrawRadius(6)).toBeCloseTo(6 * SHURIKEN_DRAW_SCALE, 9);
    expect(shurikenDrawRadius(12)).toBeCloseTo(shurikenDrawRadius(6) * 2, 9);
    // Generous, not a lie about where the hit is: nothing like a body's width.
    expect(SHURIKEN_DRAW_SCALE).toBeLessThan(3);
    expect(shurikenDrawRadius(Number.NaN)).toBeGreaterThan(0);
  });

  it('is a plate rather than a sheet, at every size', () => {
    expect(shurikenThickness(6)).toBeGreaterThan(0);
    expect(shurikenThickness(12)).toBeCloseTo(shurikenThickness(6) * 2, 9);
    // Thin against its own width, or it is a coin and not a throwing star.
    expect(shurikenThickness(6)).toBeLessThan(6);
    expect(shurikenThickness(Number.NaN)).toBeGreaterThan(0);
  });
});
