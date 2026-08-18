/**
 * The one thing this feature can actually get wrong (spec 175).
 *
 * A mark that clips the ground is invisible on the flat terrain a change is
 * checked on and obvious on the hillside somebody plays on afterwards, which is
 * exactly the shape of fault spec 153 was written about. So the assertion is a
 * *sweep* over every gradient the arena has, rather than one placement somebody
 * eyeballed -- and it samples the ground far finer than the clearance itself
 * does, because nine samples still have to be right about all of it.
 */

import { describe, expect, it } from 'vitest';
import { CLEARANCE_SAMPLES, MARK_MARGIN, markClearance, markOriginY } from './order-mark.js';
import { CROSS_YAWS, ORDER_MARK_REACH } from '../vfx/brush.js';

/** A hillside of a stated gradient, running up +X. */
const ramp = (gradient: number) => (x: number): number => x * gradient;

/** A wall at x = 0: flat either side, a step between them. */
const step = (height: number) => (x: number): number => (x >= 0 ? height : 0);

describe('markClearance', () => {
  it('answers the ground when the ground is flat', () => {
    expect(markClearance(120, -40, ORDER_MARK_REACH, () => 17)).toBe(17);
  });

  it('takes the highest ground under the mark, not the ground at its middle', () => {
    // The fault it exists to prevent: a click at the foot of a bank has
    // perfectly ordinary ground under its own centre and a wall a few units
    // away, and a clearance measured at the centre puts half the cross inside.
    const height = ramp(0.8);
    const at = markClearance(0, 0, ORDER_MARK_REACH, (x) => height(x));
    expect(at).toBeGreaterThan(height(0));
    expect(at).toBeCloseTo(ORDER_MARK_REACH * 0.8, 6);
  });

  it('finds a step that the centre sample cannot see', () => {
    const wall = step(400);
    // Just downhill of the wall: the centre is on the flat and the mark is not.
    expect(markClearance(-1, 0, ORDER_MARK_REACH, (x) => wall(x))).toBe(400);
    expect(wall(-1)).toBe(0);
  });

  it('asks nothing beyond its own footprint', () => {
    let furthest = 0;
    markClearance(0, 0, ORDER_MARK_REACH, (x, z) => {
      furthest = Math.max(furthest, Math.hypot(x, z));
      return 0;
    });
    expect(furthest).toBeCloseTo(ORDER_MARK_REACH, 6);
  });

  it('samples the middle and a ring around it, and nothing more', () => {
    let calls = 0;
    markClearance(0, 0, ORDER_MARK_REACH, () => {
      calls += 1;
      return 0;
    });
    expect(calls).toBe(CLEARANCE_SAMPLES + 1);
  });

  it('degenerates to one sample when there is no mark to clear', () => {
    let calls = 0;
    markClearance(0, 0, 0, () => {
      calls += 1;
      return 5;
    });
    expect(calls).toBe(1);
  });
});

describe('the mark clears every ground the arena has', () => {
  /**
   * The lowest world y any ink reaches, for a cross whose origin is at `originY`.
   *
   * The origin itself, and that IS the measurement: the mark is laid flat, and
   * `groundBasis` sends a stroke's arch to world up rather than down, so nothing
   * about it is below the plane it sits in. `brush.test.ts` is where that is
   * measured against the real geometry; this uses it.
   */
  const lowestInk = (originY: number): number => originY;

  const grounds: [string, (x: number, z: number) => number][] = [
    ['flat', () => 0],
    ['a gentle ramp', (x) => ramp(0.2)(x)],
    ['the steepest ground on the map', (x) => ramp(1.2)(x)],
    ['a ramp the other way', (x) => ramp(-1.2)(x)],
    ['a ramp across z', (_x, z) => z * 0.9],
    ['a ridge', (x, z) => -Math.hypot(x, z) * 0.7],
    ['a gully', (x, z) => Math.hypot(x, z) * 0.7],
    ['a step', (x) => step(300)(x)],
    ['a step down', (x) => step(-300)(x)],
  ];

  for (const [name, heightAt] of grounds) {
    it(`clears ${name}`, () => {
      const floor = lowestInk(markOriginY(0, 0, ORDER_MARK_REACH, heightAt));
      // Every piece of ground the mark covers, sampled far finer than the
      // clearance itself samples it.
      for (let i = 0; i <= 24; i++) {
        const angle = (i / 24) * Math.PI * 2;
        for (let step = 0; step <= 6; step++) {
          const radius = (ORDER_MARK_REACH * step) / 6;
          const ground = heightAt(Math.cos(angle) * radius, Math.sin(angle) * radius);
          expect(floor, `${name} at ${radius.toFixed(1)}`).toBeGreaterThanOrEqual(ground);
        }
      }
    });
  }

  it('sits the mark on the ground rather than over it, on the flat', () => {
    // The other half of the same requirement: clearing it by a mile is a marker
    // floating above the point somebody clicked. On level ground the whole lift
    // is the margin, which is what the wavefront this replaces was laid at.
    expect(markOriginY(0, 0, ORDER_MARK_REACH, () => 0)).toBe(MARK_MARGIN);
  });

  it('costs, on a hillside, exactly what the ground fell across the mark', () => {
    // The trade the flat mark makes and the one thing it cannot do anything
    // about: level at the top of the slope means floating at the bottom of it.
    // Stated as a number so a change to the mark's size is a change to this.
    const gradient = 0.6;
    const originY = markOriginY(0, 0, ORDER_MARK_REACH, (x) => x * gradient);
    expect(originY - MARK_MARGIN).toBeCloseTo(ORDER_MARK_REACH * gradient, 6);
  });

  it('is the two authored yaws this was measured for', () => {
    // Everything above rests on `ORDER_MARK_REACH` bounding the mark's footprint,
    // and that is a claim about a cross at CROSS_YAWS. A third arm or a
    // re-authored angle invalidates it. `brush.test.ts` measures it against the
    // real geometry; this names the dependency.
    expect(CROSS_YAWS).toHaveLength(2);
  });
});
