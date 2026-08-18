/**
 * The one thing this feature can actually get wrong (spec 175).
 *
 * A mark that clips the ground is invisible on the flat terrain a change is
 * checked on and obvious on the hillside somebody plays on afterwards, which is
 * exactly the shape of fault spec 153 was written about. So the assertion is a
 * *sweep* -- every gradient the arena has against every pitch the camera slider
 * allows -- rather than one placement somebody eyeballed.
 */

import { describe, expect, it } from 'vitest';
import {
  CLEARANCE_SAMPLES,
  MARK_MARGIN,
  markClearance,
  markLift,
  markOriginY,
} from './order-mark.js';
import { CAMERA_ELEVATION_MAX_DEG, CAMERA_ELEVATION_MIN_DEG } from '../view-settings.js';
import { CROSS_ROLLS, ORDER_MARK_REACH } from '../vfx/brush.js';

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

describe('markLift', () => {
  const upY = (degrees: number): number => Math.cos((degrees * Math.PI) / 180);

  it('owes the whole reach when the camera is nearly level with the ground', () => {
    const lift = markLift(ORDER_MARK_REACH, upY(CAMERA_ELEVATION_MIN_DEG));
    expect(lift).toBeGreaterThan(ORDER_MARK_REACH * 0.98);
  });

  it('all but lies the mark down when the camera is overhead', () => {
    // The card's plane is the screen's, so a top-down camera is a mark lying on
    // the ground it is marking -- which is the right answer and one nobody had
    // to author.
    const lift = markLift(ORDER_MARK_REACH, upY(CAMERA_ELEVATION_MAX_DEG));
    expect(lift - MARK_MARGIN).toBeLessThan(ORDER_MARK_REACH * 0.1);
  });

  it('is never negative and never below the margin', () => {
    for (const up of [-1, -0.5, 0, 0.5, 1]) {
      expect(markLift(ORDER_MARK_REACH, up)).toBeGreaterThanOrEqual(MARK_MARGIN);
    }
    expect(markLift(-50, 1)).toBe(MARK_MARGIN);
  });

  it('rises with the camera coming down, monotonically', () => {
    let last = -Infinity;
    for (let degrees = CAMERA_ELEVATION_MAX_DEG; degrees >= CAMERA_ELEVATION_MIN_DEG; degrees -= 5) {
      const lift = markLift(ORDER_MARK_REACH, upY(degrees));
      expect(lift).toBeGreaterThan(last);
      last = lift;
    }
  });
});

describe('the mark clears every ground the arena has', () => {
  /**
   * The lowest world y any ink reaches, for a cross whose origin is at `originY`.
   *
   * The card spans camera right -- which has no y in it, this camera never rolls
   * -- and camera up, so a point's height is its card-up coordinate times
   * `cameraUpY`, and no point's card-up coordinate is beyond the mark's own
   * reach. `brush.test.ts` is where that bound is measured against the real
   * geometry; this uses it.
   */
  const lowestInk = (originY: number, cameraUpY: number): number =>
    originY - ORDER_MARK_REACH * Math.abs(cameraUpY);

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
    it(`clears ${name}, at every pitch the slider allows`, () => {
      for (let degrees = CAMERA_ELEVATION_MIN_DEG; degrees <= CAMERA_ELEVATION_MAX_DEG; degrees += 5) {
        const cameraUpY = Math.cos((degrees * Math.PI) / 180);
        const originY = markOriginY(0, 0, ORDER_MARK_REACH, cameraUpY, heightAt);
        const floor = lowestInk(originY, cameraUpY);
        // Every piece of ground the mark covers, sampled far finer than the
        // clearance itself does -- the clearance may take nine samples, but it
        // has to be right about all of it.
        for (let i = 0; i <= 24; i++) {
          const angle = (i / 24) * Math.PI * 2;
          for (const radius of [0, ORDER_MARK_REACH * 0.5, ORDER_MARK_REACH]) {
            const ground = heightAt(Math.cos(angle) * radius, Math.sin(angle) * radius);
            expect(floor, `${name} at ${degrees}deg`).toBeGreaterThanOrEqual(ground);
          }
        }
      }
    });
  }

  it('sits the mark on the ground rather than over it, on the flat', () => {
    // The other half of the same requirement: clearing it by a mile is a marker
    // floating above the point somebody clicked.
    const originY = markOriginY(0, 0, ORDER_MARK_REACH, Math.cos((27 * Math.PI) / 180), () => 0);
    expect(lowestInk(originY, Math.cos((27 * Math.PI) / 180))).toBeLessThanOrEqual(MARK_MARGIN);
  });

  it('is the two authored rolls this was measured for', () => {
    // Everything above rests on `ORDER_MARK_REACH` bounding how far the cross
    // hangs below itself, and that is a claim about a cross at CROSS_ROLLS. A
    // third arm or a re-authored angle invalidates it. `brush.test.ts` measures
    // it against the real geometry; this names the dependency.
    expect(CROSS_ROLLS).toHaveLength(2);
  });
});
