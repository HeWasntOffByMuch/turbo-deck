import { describe, expect, it } from 'vitest';
import { assignLights, type LightLimits, type LightRequest } from './light-residency.js';

const LIMITS: LightLimits = {
  slots: 5,
  activateRadius: 1000,
  releaseRadius: 1400,
  swapMargin: 200,
};

function light(key: string, x: number): LightRequest {
  return { key, x, y: 20, z: 0, color: 0xffffff, brightness: 1, radius: 300 };
}

const ORIGIN = { x: 0, z: 0 };
const EMPTY: readonly (string | null)[] = [null, null, null, null, null];

describe('assignLights (spec 250)', () => {
  it('answers one entry per slot, always', () => {
    expect(assignLights([], EMPTY, ORIGIN, LIMITS)).toHaveLength(LIMITS.slots);
    expect(assignLights([light('a', 10)], EMPTY, ORIGIN, LIMITS)).toHaveLength(LIMITS.slots);
  });

  it('never claims anything past the activate radius', () => {
    const far = light('far', LIMITS.activateRadius + 1);
    expect(assignLights([far], EMPTY, ORIGIN, LIMITS)).not.toContain('far');
  });

  it('keeps a light already in a slot until it is past the release radius', () => {
    const held = ['a', null, null, null, null];
    // Between the two radii: too far to be claimed, near enough to be kept.
    const between = light('a', (LIMITS.activateRadius + LIMITS.releaseRadius) / 2);
    expect(assignLights([between], held, ORIGIN, LIMITS)[0]).toBe('a');
    // And past the release radius it goes, even though nothing else wants it.
    const gone = light('a', LIMITS.releaseRadius + 1);
    expect(assignLights([gone], held, ORIGIN, LIMITS)[0]).toBeNull();
  });

  it('drops a slot whose light is no longer offered', () => {
    expect(assignLights([], ['a', null, null, null, null], ORIGIN, LIMITS)[0]).toBeNull();
  });

  it('takes an occupied slot only for a candidate nearer by more than the margin', () => {
    const limits: LightLimits = { ...LIMITS, slots: 1 };
    const held = ['sitting'];
    const sitting = light('sitting', 500);
    // Nearer, but not by enough: the sitting light keeps its slot.
    const nudge = [sitting, light('nudge', 500 - limits.swapMargin + 1)];
    expect(assignLights(nudge, held, ORIGIN, limits)[0]).toBe('sitting');
    // Nearer by more than the margin: worth the re-bake.
    const closer = [sitting, light('closer', 500 - limits.swapMargin - 1)];
    expect(assignLights(closer, held, ORIGIN, limits)[0]).toBe('closer');
  });

  /**
   * The property the bake cost is actually paid on. A walk that crosses the
   * boundary between two lights over and over must not reassign the slot every
   * step -- a swap is a cube map, and one per frame is the failure this whole
   * module exists to prevent.
   */
  it('does not reassign while a walk crosses the boundary between two lights', () => {
    const limits: LightLimits = { ...LIMITS, slots: 1 };
    let held: readonly (string | null)[] = ['left'];
    let swaps = 0;
    for (let step = 0; step < 60; step++) {
      // A body pacing back and forth across the midpoint of two lights 600 apart.
      const x = Math.sin(step) * 60;
      const next = assignLights(
        [light('left', -300), light('right', 300)],
        held,
        { x, z: 0 },
        limits,
      );
      if (next[0] !== held[0]) swaps++;
      held = next;
    }
    expect(swaps).toBe(0);
  });

  it('fills the nearest first', () => {
    const limits: LightLimits = { ...LIMITS, slots: 2 };
    const out = assignLights(
      [light('far', 800), light('near', 100), light('mid', 400)],
      [null, null],
      ORIGIN,
      limits,
    );
    expect(out).toEqual(['near', 'mid']);
  });

  it('does not depend on the order the requests arrive in', () => {
    const requests = [light('a', 100), light('b', 200), light('c', 300), light('d', 400)];
    const forwards = assignLights(requests, EMPTY, ORIGIN, LIMITS);
    const backwards = assignLights([...requests].reverse(), EMPTY, ORIGIN, LIMITS);
    expect(backwards).toEqual(forwards);
  });

  it('breaks a distance tie on the key rather than on arrival', () => {
    const limits: LightLimits = { ...LIMITS, slots: 1 };
    const pair = [light('b', 100), light('a', 100)];
    expect(assignLights(pair, [null], ORIGIN, limits)[0]).toBe('a');
    expect(assignLights([...pair].reverse(), [null], ORIGIN, limits)[0]).toBe('a');
  });

  /**
   * Every slot is the same slot.
   *
   * There was a shadow-casting prefix here, and three tests about which lights
   * were allowed into it. Nothing casts now, so the whole split is gone -- and
   * what replaces those three is this one: the pool fills from the front, in
   * distance order, with nothing skipped.
   */
  it('fills from the front, with no slot reserved for anything', () => {
    const out = assignLights(
      [light('p1', 10), light('p2', 20), light('p3', 30), light('p4', 40)],
      EMPTY,
      ORIGIN,
      LIMITS,
    );
    expect(out).toEqual(['p1', 'p2', 'p3', 'p4', null]);
  });

  it('holds no key that is not on offer', () => {
    const out = assignLights([light('a', 10), light('b', 20)], EMPTY, ORIGIN, LIMITS);
    for (const key of out) expect(key === null || key === 'a' || key === 'b').toBe(true);
  });

  it('assigns each light at most one slot', () => {
    const out = assignLights(
      [light('a', 10), light('b', 20), light('c', 30), light('d', 40)],
      ['a', 'a', 'a', null, null],
      ORIGIN,
      LIMITS,
    );
    const keys = out.filter((key): key is string => key !== null);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
