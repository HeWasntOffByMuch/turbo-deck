/**
 * The ring around a target (spec 186).
 *
 * The properties worth asserting are the ones that made angular separation
 * preferable to a lattice of slots, so most of this file is about what *does
 * not* move: a lone attacker, a pair already on opposite sides, and the
 * survivors of a death.
 */

import { describe, expect, it } from 'vitest';

import type { Vec2 } from '../../sim/types.js';
import { approachPoints, type Approach } from './attack-slots.js';

const TARGET: Vec2 = { x: 500, y: 500 };
const STANDOFF = 90;
const RADIUS = 20;

function attacker(id: number, bearingDeg: number, distance = 300): Approach {
  const angle = (bearingDeg * Math.PI) / 180;
  return {
    attackerId: id,
    x: TARGET.x + Math.cos(angle) * distance,
    y: TARGET.y + Math.sin(angle) * distance,
    radius: RADIUS,
    standoff: STANDOFF,
  };
}

function bearingDegOf(point: Vec2): number {
  const deg = (Math.atan2(point.y - TARGET.y, point.x - TARGET.x) * 180) / Math.PI;
  return ((deg % 360) + 360) % 360;
}

/** Smallest angle between two bearings, in degrees. */
function apart(a: number, b: number): number {
  const raw = Math.abs(a - b) % 360;
  return raw > 180 ? 360 - raw : raw;
}

function bearings(points: ReadonlyMap<number, Vec2>): Map<number, number> {
  return new Map([...points].map(([id, point]) => [id, bearingDegOf(point)]));
}

describe('approachPoints', () => {
  it('says nothing about a lone attacker', () => {
    // The contract, not an optimisation: with nobody to avoid there is no
    // reason to move a body off the line it is walking, and the caller falling
    // through to its old behaviour is what keeps a single monster's approach
    // bit-for-bit what it was before this spec.
    expect(approachPoints(TARGET, [attacker(1, 0)]).size).toBe(0);
    expect(approachPoints(TARGET, []).size).toBe(0);
  });

  it('leaves two attackers that are already clear of each other alone', () => {
    const found = bearings(approachPoints(TARGET, [attacker(1, 0), attacker(2, 180)]));
    expect(found.get(1)).toBeCloseTo(0, 6);
    expect(found.get(2)).toBeCloseTo(180, 6);
  });

  it('spreads attackers that arrive on the same bearing', () => {
    const crowd = [attacker(1, 90), attacker(2, 90), attacker(3, 90), attacker(4, 90)];
    const found = bearings(approachPoints(TARGET, crowd));
    expect(found.size).toBe(4);
    const angles = [...found.values()];
    for (let i = 0; i < angles.length; i++) {
      for (let j = i + 1; j < angles.length; j++) {
        // Two bodies of radius 20 at 90 units subtend about 26 degrees between
        // their centres; anything at least that far apart does not overlap.
        expect(apart(angles[i] ?? 0, angles[j] ?? 0)).toBeGreaterThan(25);
      }
    }
  });

  it('places bodies far enough apart that they do not overlap', () => {
    const crowd = Array.from({ length: 6 }, (_, i) => attacker(i + 1, i * 7));
    const points = [...approachPoints(TARGET, crowd).values()];
    expect(points).toHaveLength(6);
    for (let i = 0; i < points.length; i++) {
      for (let j = i + 1; j < points.length; j++) {
        const a = points[i];
        const b = points[j];
        if (!a || !b) continue;
        expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(RADIUS * 2);
      }
    }
  });

  it('keeps every attacker at its own reach', () => {
    // A slinger takes an angle and stands at its throw's range; a stalker takes
    // one and closes to its sword's. The ring decides a bearing, never a
    // distance.
    const melee: Approach = { ...attacker(1, 0), standoff: 90 };
    const ranged: Approach = { ...attacker(2, 10), standoff: 400 };
    const points = approachPoints(TARGET, [melee, ranged]);
    const meleeAt = points.get(1);
    const rangedAt = points.get(2);
    expect(Math.hypot((meleeAt?.x ?? 0) - TARGET.x, (meleeAt?.y ?? 0) - TARGET.y)).toBeCloseTo(90, 6);
    expect(Math.hypot((rangedAt?.x ?? 0) - TARGET.x, (rangedAt?.y ?? 0) - TARGET.y)).toBeCloseTo(400, 6);
  });

  it('does not re-shuffle the survivors when an attacker dies', () => {
    // A lattice re-indexes everybody behind the gap. Here gaps only ever grow,
    // so the bodies that are left keep the bearings they had.
    const crowd = [attacker(1, 0), attacker(2, 40), attacker(3, 80), attacker(4, 120)];
    const before = bearings(approachPoints(TARGET, crowd));
    const after = bearings(approachPoints(TARGET, crowd.filter((one) => one.attackerId !== 2)));
    for (const id of [1, 3, 4]) {
      expect(apart(after.get(id) ?? 0, before.get(id) ?? 0)).toBeLessThan(1e-6);
    }
  });

  it('settles rather than creeping when its own answer is fed back', () => {
    // The bearing being assigned is the bearing the body already has, which
    // makes feeding the answer back in very nearly a fixed point -- but only
    // *nearly*, because the relaxation is capped at a dozen passes and the
    // worst case (a whole pack arriving on one bearing) has not quite finished
    // converging when it stops.
    //
    // So the property is a contraction rather than a fixed point, and that is
    // what is asserted: each round moves the ring less than the one before, and
    // the total is a rounding error on a body's position. A scheme that drifted
    // would pass a single-step test and fail this one.
    const crowd = [attacker(1, 90), attacker(2, 90), attacker(3, 90), attacker(4, 90)];
    let placed: Approach[] = crowd;
    let previous = bearings(approachPoints(TARGET, crowd));
    const first = previous;
    let lastMove = Infinity;

    for (let round = 0; round < 5; round++) {
      placed = placed.map((one) => {
        const at = approachPoints(TARGET, placed).get(one.attackerId);
        return at ? { ...one, x: at.x, y: at.y } : one;
      });
      const now = bearings(approachPoints(TARGET, placed));
      const move = Math.max(...[...now].map(([id, angle]) => apart(angle, previous.get(id) ?? 0)));
      expect(move).toBeLessThanOrEqual(lastMove + 1e-9);
      lastMove = move;
      previous = now;
    }

    // A twentieth of a degree, which at a 90-unit standoff is under a
    // thousandth of a world unit -- far below anything a body could be drawn at.
    for (const [id, angle] of first) {
      expect(apart(previous.get(id) ?? 0, angle)).toBeLessThan(0.05);
    }
  });

  it('puts the overflow on an outer ring rather than in the inner one', () => {
    // Fourteen bodies of radius 20 cannot stand on a circle of radius 90.
    // Somebody waits, which is the honest consequence of a game with no
    // shoving in it -- and they wait outside rather than inside each other.
    const crowd = Array.from({ length: 14 }, (_, i) => attacker(i + 1, i * 25, 300 + i));
    const points = approachPoints(TARGET, crowd);
    expect(points.size).toBe(14);
    const radii = [...points.values()].map((at) =>
      Math.hypot(at.x - TARGET.x, at.y - TARGET.y),
    );
    expect(Math.max(...radii)).toBeGreaterThan(STANDOFF + 1);
    // Still nobody standing inside anybody, across both rings.
    const all = [...points.values()];
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        const a = all[i];
        const b = all[j];
        if (!a || !b) continue;
        expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(RADIUS * 2 - 1e-6);
      }
    }
  });

  it('survives an attacker standing exactly on its target', () => {
    // No bearing to read, and `asin` of anything past 1 is NaN -- which would
    // spread through every angle in the ring rather than through one.
    const onTop: Approach = { ...attacker(1, 0), x: TARGET.x, y: TARGET.y };
    const points = approachPoints(TARGET, [onTop, attacker(2, 45)]);
    for (const at of points.values()) {
      expect(Number.isFinite(at.x)).toBe(true);
      expect(Number.isFinite(at.y)).toBe(true);
    }
  });

  it('is a pure function of its arguments', () => {
    const crowd = [attacker(1, 12), attacker(2, 18), attacker(3, 200), attacker(4, 205)];
    expect(approachPoints(TARGET, crowd)).toEqual(approachPoints(TARGET, crowd));
    // And of the argument order, since the caller's iteration order is an
    // artefact of entity creation.
    expect(approachPoints(TARGET, [...crowd].reverse())).toEqual(approachPoints(TARGET, crowd));
  });
});
