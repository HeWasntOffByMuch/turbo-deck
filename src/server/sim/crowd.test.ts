/**
 * The four rules in `steer` (spec 184), each asked about the case it exists for.
 *
 * The one worth the most attention is reciprocity. Two bodies walking into each
 * other have to choose *opposite* sides without exchanging a word, or they
 * choose the same side, correct, choose the same side again, and dance -- which
 * is the failure ORCA spends a linear program avoiding. Here it falls out of
 * both of them evaluating one cross product over the same pair of vectors, so
 * the test is that the two answers have opposite signs, not that either has a
 * particular one.
 */

import { describe, expect, it } from 'vitest';

import { CROWD_MAX_AVOID } from '../../sim/constants.js';
import type { Vec2 } from '../../sim/types.js';
import { escapes, steer, type CrowdBody } from './crowd.js';

const RADIUS = 16;

function body(id: number, x: number, y: number, vx = 0, vy = 0, radius = RADIUS): CrowdBody {
  return { id, x, y, vx, vy, radius };
}

/** A body walking along `direction` at `speed` units per tick. */
function walker(id: number, x: number, y: number, direction: Vec2, speed = 1.5): CrowdBody {
  return body(id, x, y, direction.x * speed, direction.y * speed, RADIUS);
}

const EAST: Vec2 = { x: 1, y: 0 };
const WEST: Vec2 = { x: -1, y: 0 };

describe('steer', () => {
  it('leaves a body alone when nothing is near', () => {
    expect(steer(body(1, 0, 0, 1.5, 0), EAST, [])).toEqual(EAST);
  });

  it('always returns a unit vector, so nothing ever slows down', () => {
    // Speed is `stats.moveSpeed` and this function never sees it. A crowd may
    // turn a body; it may not slow one, because matching the pace of whatever
    // is in front is what makes a queue out of a crowd.
    const crowd = [body(2, 30, 8, 0, 0), body(3, 20, -20, 0, 0), body(4, 44, 4, -1, 0)];
    const out = steer(walker(1, 0, 0, EAST), EAST, crowd);
    expect(out).not.toBeNull();
    expect(Math.hypot(out?.x ?? 0, out?.y ?? 0)).toBeCloseTo(1, 12);
  });

  it('sends two bodies walking into each other down opposite sides', () => {
    const a = walker(1, 0, 0, EAST);
    const b = walker(2, 60, 2, WEST);
    const outA = steer(a, EAST, [b]);
    const outB = steer(b, WEST, [a]);
    expect(outA?.y).toBeLessThan(0);
    expect(outB?.y).toBeGreaterThan(0);
    // The property the pair rests on, stated as itself: they took opposite
    // sides. A scheme that got this wrong would still satisfy "both moved".
    expect(Math.sign(outA?.y ?? 0)).toBe(-Math.sign(outB?.y ?? 0));
  });

  it('sends exactly head-on bodies down opposite sides too', () => {
    // Dead on the line the cross product is zero and there is no side to
    // deduce, so the tie goes to a fixed handedness. Both take their own left,
    // and because they are pointing opposite ways that is opposite in the
    // world -- which is the whole reason the tie may not be broken on id.
    const a = walker(1, 0, 0, EAST);
    const b = walker(2, 60, 0, WEST);
    const outA = steer(a, EAST, [b]);
    const outB = steer(b, WEST, [a]);
    expect(outA?.y).not.toBe(0);
    expect(Math.sign(outA?.y ?? 0)).toBe(-Math.sign(outB?.y ?? 0));
  });

  it('does not weave two bodies travelling together', () => {
    // The herd rule. Both are permanently beside somebody, and without the
    // closing-speed term both would side-step for ever.
    const a = walker(1, 0, 0, EAST);
    const b = walker(2, 50, 0, EAST);
    expect(steer(a, EAST, [b])).toEqual(EAST);
    expect(steer(b, EAST, [a])).toEqual(EAST);
  });

  it('steps around a stationary body in the way', () => {
    const parked = body(2, 50, 0);
    const out = steer(walker(1, 0, 0, EAST), EAST, [parked]);
    expect(out?.y).not.toBe(0);
    // Still mostly going east: the route dominates the crowd.
    expect(out?.x).toBeGreaterThan(0.5);
  });

  it('lets a faster body pass a slower one going the same way', () => {
    // Closing on it because it is quicker, so it gets a side-step -- and keeps
    // every bit of its own speed while doing it.
    const slow = walker(2, 60, 0, EAST, 0.67);
    const out = steer(walker(1, 0, 0, EAST, 1.9), EAST, [slow]);
    expect(out?.y).not.toBe(0);
    expect(out?.x).toBeGreaterThan(0.5);
  });

  it('ignores a body it is walking away from', () => {
    const behind = body(2, -40, 0);
    expect(steer(walker(1, 0, 0, EAST), EAST, [behind])).toEqual(EAST);
  });

  it('never lets a crowd cancel a body’s route', () => {
    // The cap is strictly below 1, so `desired + avoid` cannot be zero. Ringed
    // by neighbours on every side, a body still walks.
    const ring: CrowdBody[] = [];
    for (let i = 0; i < 8; i++) {
      const angle = (i / 8) * Math.PI * 2;
      ring.push(body(i + 2, Math.cos(angle) * 26, Math.sin(angle) * 26, 0, 0));
    }
    const out = steer(walker(1, 0, 0, EAST), EAST, ring);
    expect(out).not.toBeNull();
    expect(Math.hypot(out?.x ?? 0, out?.y ?? 0)).toBeCloseTo(1, 12);
  });

  it('never bends a body further than the cap allows', () => {
    // What keeps a narrow passage passable: pressed from both sides, a body
    // still walks down the corridor rather than into a wall.
    const pressed = [body(2, 0, 30, 0, -1.5), body(3, 0, -30, 0, 1.5), body(4, 26, 6, -1.5, 0)];
    const out = steer(walker(1, 0, 0, EAST), EAST, pressed);
    // asin, not atan: the widest angle between `d` and `d + a` for a unit `d`
    // and an `a` capped at c is asin(c), reached when `a` is tangent to the
    // circle it sweeps rather than perpendicular to `d`.
    const bend = Math.atan2(Math.abs(out?.y ?? 0), out?.x ?? 0);
    expect(bend).toBeLessThanOrEqual(Math.asin(CROWD_MAX_AVOID) + 1e-9);
  });

  describe('with no route', () => {
    it('stands still when merely close to a neighbour', () => {
      // Bodies around a target are touching by design. A margin applied to a
      // body that has arrived is where idle jitter comes from, so it gets none.
      expect(steer(body(1, 0, 0), null, [body(2, 34, 0)])).toBeNull();
      expect(steer(body(1, 0, 0), null, [body(2, 33, 0)])).toBeNull();
    });

    it('walks out of a real overlap', () => {
      // Unstick, and it is an intent: the caller hands this to the same
      // movement pass everything else goes through, so the body walks out at
      // its own speed rather than being displaced.
      const out = steer(body(1, 0, 0), null, [body(2, 20, 0)]);
      expect(out?.x).toBeLessThan(0);
      expect(Math.hypot(out?.x ?? 0, out?.y ?? 0)).toBeCloseTo(1, 12);
    });

    it('splits two coincident bodies deterministically', () => {
      const a = body(1, 100, 100);
      const b = body(2, 100, 100);
      expect(steer(a, null, [b])).toEqual({ x: -1, y: 0 });
      expect(steer(b, null, [a])).toEqual({ x: 1, y: 0 });
    });
  });

  it('is a pure function of its arguments', () => {
    const crowd = [body(2, 40, 10, -1, 0), body(3, 12, -18, 0, 1)];
    const first = steer(walker(1, 0, 0, EAST), EAST, crowd);
    const second = steer(walker(1, 0, 0, EAST), EAST, crowd);
    expect(second).toEqual(first);
  });
});

describe('escapes', () => {
  const EAST: Vec2 = { x: 1, y: 0 };

  function fan(direction: Vec2, tieBreak: number): Vec2[] {
    return [...escapes(direction, tieBreak)];
  }

  it('offers the unbent route first', () => {
    // Avoidance is a preference and never a veto: a crowd that has steered a
    // body into a wall must not also be what keeps it there, so the first thing
    // a stuck body tries is where it actually wanted to go.
    expect(fan(EAST, 0)[0]).toEqual(EAST);
  });

  it('opens outwards, nearest to the route first', () => {
    const offsets = fan(EAST, 0).map(
      (candidate) => Math.abs(Math.atan2(candidate.y, candidate.x)) * (180 / Math.PI),
    );
    for (let i = 1; i < offsets.length; i++) {
      expect(offsets[i] ?? 0).toBeGreaterThanOrEqual((offsets[i - 1] ?? 0) - 1e-9);
    }
  });

  it('is willing to back out, but never straight back the way it came', () => {
    // The widest candidates point backwards on purpose: a body wedged on a
    // corner usually has no forward or sideways step at all, and measured
    // against a pack filing through a two-body gap, a fan that stops at
    // sideways gets two of sixteen through where this one gets all sixteen.
    const candidates = fan(EAST, 0);
    expect(candidates.some((one) => one.x < 0)).toBe(true);
    // A full reversal is the one direction that cannot be a way past anything.
    for (const candidate of candidates) {
      expect(candidate.x).toBeGreaterThan(-1 + 1e-6);
    }
  });

  it('keeps every candidate a unit vector', () => {
    for (const candidate of fan({ x: 0.6, y: 0.8 }, 3)) {
      expect(Math.hypot(candidate.x, candidate.y)).toBeCloseTo(1, 12);
    }
  });

  it('sends two wedged bodies to opposite sides first', () => {
    // The opposite of the side-step's rule, and deliberately so. Two bodies
    // passing each other need the *same* handedness; two bodies wedged against
    // the same obstacle are pointing the same way, so a shared rule sends them
    // both at the same gap and neither gets through. Here the ids break the
    // symmetry rather than preserving it.
    const even = fan(EAST, 2)[1];
    const odd = fan(EAST, 3)[1];
    expect(Math.sign(even?.y ?? 0)).toBe(-Math.sign(odd?.y ?? 0));
  });

  it('is the same fan every time', () => {
    expect(fan(EAST, 7)).toEqual(fan(EAST, 7));
  });
});
