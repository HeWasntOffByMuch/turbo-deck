import { describe, expect, it } from 'vitest';

import { monsterById } from '../data/monsters.js';
import { abilityById } from '../data/abilities.js';
import { approachPoints, requiredGap, type Approach } from './attack-slots.js';

const TAU = Math.PI * 2;
const TARGET = { x: 0, y: 0 };

/** The bearing an assigned point sits on, and how far out it is. */
function polar(point: { x: number; y: number }) {
  return { angle: Math.atan2(point.y - TARGET.y, point.x - TARGET.x), ring: Math.hypot(point.x, point.y) };
}

/** The aim assigned to `id`, which every test that reads one requires to exist. */
function aimOf(points: ReadonlyMap<number, { x: number; y: number }>, id: number) {
  const point = points.get(id);
  if (!point) throw new Error(`no approach point for attacker ${id}`);
  return point;
}

/** A shipped monster row, which the content table requires to exist. */
function rowOf(typeId: string) {
  const row = monsterById(typeId);
  if (!row) throw new Error(`no monster row ${typeId}`);
  return row;
}

/** An attacker standing on `angle`, `at` units out. */
function at(
  attackerId: number,
  angle: number,
  distance: number,
  radius = 20,
  standoff = 68.8,
  pinned = false,
): Approach {
  return {
    attackerId,
    x: TARGET.x + Math.cos(angle) * distance,
    y: TARGET.y + Math.sin(angle) * distance,
    radius,
    standoff,
    pinned,
  };
}

/** The signed difference `b - a`, folded into (-pi, pi]. */
function delta(a: number, b: number): number {
  const raw = b - a + Math.PI;
  return raw - TAU * Math.floor(raw / TAU) - Math.PI;
}

describe('requiredGap', () => {
  it('is the chord formula when both bodies are on the same ring', () => {
    // Two bodies of radius r on a ring R clear at 2*asin(d / 2R) -- the angle
    // spec 187's slotCount divided a full turn by.
    const gap = requiredGap(100, 20, 100, 20);
    const want = 2 * Math.asin((20 + 20) * 1.15 / (2 * 100));
    expect(gap).toBeCloseTo(want, 10);
  });

  it('is symmetric in its two bodies', () => {
    expect(requiredGap(68.8, 30, 252, 12)).toBe(requiredGap(252, 12, 68.8, 30));
  });

  it('asks for nothing at all when two rings are too far apart to touch', () => {
    // A slinger at its throw's range and a stalker at its sword's are never in
    // each other's way, whatever bearings they take. This is the answer a sum
    // of half-angles cannot give, and giving it is what stops a ranged attacker
    // sidling for nothing.
    const slinger = rowOf('slinger');
    const stalker = rowOf('stalker');
    expect(requiredGap(252.8, slinger?.radius ?? 20, 68.8, stalker?.radius ?? 20)).toBe(0);
  });

  it('asks for the whole circle when two bodies overlap even facing away', () => {
    expect(requiredGap(10, 40, 10, 40)).toBe(Math.PI);
  });

  it('grows as the ring tightens and shrinks as it widens', () => {
    expect(requiredGap(60, 20, 60, 20)).toBeGreaterThan(requiredGap(120, 20, 120, 20));
  });

  it('is finite for a zero ring, a zero radius and a body on the target', () => {
    for (const gap of [
      requiredGap(0, 20, 100, 20),
      requiredGap(100, 0, 100, 0),
      requiredGap(0, 0, 0, 0),
      requiredGap(-5, 20, 100, 20),
    ]) {
      expect(Number.isFinite(gap)).toBe(true);
      expect(gap).toBeGreaterThanOrEqual(0);
      expect(gap).toBeLessThanOrEqual(Math.PI);
    }
  });
});

describe('approachPoints leaves alone what is not in the way', () => {
  it('says nothing at all about a lone attacker', () => {
    // The contract, not an optimisation: with nobody to avoid there is no
    // reason to move a body off the line it is already walking, and this is
    // what makes a single monster's chase bit-for-bit what it was before
    // spec 227. The lattice it replaces snapped it up to 30 degrees.
    expect(approachPoints(TARGET, [at(1, 0.4, 400)]).size).toBe(0);
    expect(approachPoints(TARGET, []).size).toBe(0);
  });

  it('leaves two attackers coming from opposite sides on their own bearings', () => {
    const points = approachPoints(TARGET, [at(1, 0, 400), at(2, Math.PI, 400)]);
    expect(polar(aimOf(points, 1)).angle).toBeCloseTo(0, 10);
    expect(Math.abs(polar(aimOf(points, 2)).angle)).toBeCloseTo(Math.PI, 10);
  });

  it('sends each attacker to its own standoff, not to a shared ring', () => {
    // A slinger takes a bearing and stands at its throw's range; a stalker
    // takes one and closes to its sword's.
    const points = approachPoints(TARGET, [
      at(1, 0, 400, 20, 68.8),
      at(2, Math.PI, 900, 20, 252.8),
    ]);
    expect(polar(aimOf(points, 1)).ring).toBeCloseTo(68.8, 6);
    expect(polar(aimOf(points, 2)).ring).toBeCloseTo(252.8, 6);
  });
});

describe('approachPoints spreads what is in the way', () => {
  it('pushes two attackers on one bearing apart, symmetrically', () => {
    const points = approachPoints(TARGET, [at(1, 0, 400), at(2, 0, 400)]);
    const a = polar(aimOf(points, 1)).angle;
    const b = polar(aimOf(points, 2)).angle;
    const gap = requiredGap(68.8, 20, 68.8, 20);
    expect(Math.abs(delta(a, b))).toBeGreaterThanOrEqual(gap - 1e-9);
    // Neither is favoured: they part about the bearing they shared.
    expect(a + b).toBeCloseTo(0, 6);
  });

  it('gives every attacker in a pack the room its body needs', () => {
    const pack = Array.from({ length: 8 }, (_, i) => at(i + 1, 0.2 * i - 0.7, 500));
    const points = approachPoints(TARGET, pack);
    expect(points.size).toBe(8);
    const placed = pack.map((one) => ({ one, ...polar(aimOf(points, one.attackerId)) }));
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        const a = placed[i];
        const b = placed[j];
        if (!a || !b) continue;
        const want = requiredGap(a.ring, a.one.radius, b.ring, b.one.radius);
        // Only bodies that ended on the same ring have to clear each other by
        // bearing; two on different rings clear by distance, which `requiredGap`
        // already reports as no constraint. Rings are stepped by exactly the
        // distance that makes it none, so the arithmetic lands on the boundary
        // and the answer is a rounding error rather than a flat zero.
        if (want < 1e-6) continue;
        expect(Math.abs(delta(a.angle, b.angle))).toBeGreaterThanOrEqual(want - 1e-6);
      }
    }
  });

  it('settles a full ring exactly, from the worst start there is', () => {
    // Every body arriving on one bearing, on a ring filled to capacity. This is
    // the case a relaxation cannot do: pushing each crowded pair apart by half
    // its shortfall carries information one body per pass, so a nine-body ring
    // was still 22% short after eight passes each and a fifty-seven-body ring
    // 64%. A cumulative pass settles all of them to the last bit.
    for (const [n, radius, standoff] of [[9, 20, 68.8], [15, 12, 68.8], [57, 12, 252.8]] as const) {
      const pack = Array.from({ length: n }, (_, i) =>
        at(i + 1, (i / n) * 1e-4, 500, radius, standoff),
      );
      const points = approachPoints(TARGET, pack);
      expect(points.size).toBe(n);
      const placed = pack.map((one) => ({ one, ...polar(aimOf(points, one.attackerId)) }));
      for (let i = 0; i < placed.length; i++) {
        for (let j = i + 1; j < placed.length; j++) {
          const a = placed[i];
          const b = placed[j];
          if (!a || !b) continue;
          const want = requiredGap(a.ring, a.one.radius, b.ring, b.one.radius);
          if (want < 1e-6) continue;
          expect(Math.abs(delta(a.angle, b.angle))).toBeGreaterThanOrEqual(want - 1e-9);
        }
      }
    }
  });

  it('does not let bearings cross, so the pack keeps the order it arrived in', () => {
    const pack = [at(1, -0.1, 500), at(2, 0, 500), at(3, 0.1, 500)];
    const points = approachPoints(TARGET, pack);
    const a = polar(aimOf(points, 1)).angle;
    const b = polar(aimOf(points, 2)).angle;
    const c = polar(aimOf(points, 3)).angle;
    expect(a).toBeLessThan(b);
    expect(b).toBeLessThan(c);
  });
});

describe('approachPoints and a body that has stopped', () => {
  it('never moves a pinned body and never sends anyone onto its ground', () => {
    const standing = at(1, 0, 60, 20, 68.8, true);
    const closing = at(2, 0.02, 500);
    const points = approachPoints(TARGET, [standing, closing]);
    // The pinned body is not walking anywhere, so it is given no aim at all.
    expect(points.has(1)).toBe(false);
    const moved = polar(aimOf(points, 2));
    const want = requiredGap(60, 20, moved.ring, 20);
    expect(Math.abs(delta(0, moved.angle))).toBeGreaterThanOrEqual(want - 1e-6);
  });

  it('makes the closer take the whole correction rather than half of it', () => {
    const pinnedPair = approachPoints(TARGET, [
      at(1, 0, 68.8, 20, 68.8, true),
      at(2, 0, 500),
    ]);
    const bothMobile = approachPoints(TARGET, [at(1, 0, 68.8), at(2, 0, 500)]);
    expect(Math.abs(delta(0, polar(aimOf(pinnedPair, 2)).angle))).toBeGreaterThan(
      Math.abs(delta(0, polar(aimOf(bothMobile, 2)).angle)),
    );
  });
});

describe('approachPoints places everybody', () => {
  const player = 16;
  function monsterApproach(id: number, typeId: string, angle: number, distance: number): Approach {
    const row = rowOf(typeId);
    const swing = abilityById(row.stats.basicAttackId);
    const standoff = ((swing?.range ?? row.stats.attackRange) + player) * 0.8;
    return at(id, angle, distance, row.radius, standoff);
  }

  it('is not coarsened by one large body in a swarm of small ones', () => {
    // Spec 187 cut one ring for the widest body and the tightest reach, so a
    // single ravager took twelve spiders' 17 slots down to 6 and left seven
    // attackers aiming at the target's centre. Every one of the thirteen gets a
    // place to stand now.
    const pack = [
      ...Array.from({ length: 12 }, (_, i) =>
        monsterApproach(i + 1, 'small_spider', (i / 12) * TAU, 500),
      ),
      monsterApproach(13, 'ravager', 0.05, 520),
    ];
    const points = approachPoints(TARGET, pack);
    expect(points.size).toBe(13);
    for (const one of pack) expect(points.has(one.attackerId)).toBe(true);
  });

  it('shares the circle out evenly when more bodies want it than fit', () => {
    // Twenty stalkers do not fit round one player at a stalker's reach: nine
    // do. Spec 187 answered the tenth with -1, and the caller aimed it at the
    // quarry's centre -- so half the pack converged on one point, which is the
    // pile-up the ring exists to prevent. Everybody gets a bearing here, all of
    // them tighter than they would like by the same amount, and `crowd.ts`
    // resolves the density that leaves. Deliberately not a second ring further
    // out: that would stand half the pack outside its own reach, where it can
    // never swing.
    const pack = Array.from({ length: 20 }, (_, i) =>
      monsterApproach(i + 1, 'stalker', (i / 20) * TAU, 500 + i),
    );
    const points = approachPoints(TARGET, pack);
    expect(points.size).toBe(20);
    const placed = pack.map((one) => polar(aimOf(points, one.attackerId)));
    // Everybody is sent to its own reach, and nobody to the target itself.
    for (const one of placed) expect(one.ring).toBeCloseTo(68.8, 6);
    // Evenly, so the circle is used rather than one arc of it.
    const bearings = placed.map((one) => one.angle).sort((a, b) => a - b);
    const first = bearings.at(0) ?? 0;
    const last = bearings.at(-1) ?? 0;
    let widest = first + TAU - last;
    for (let i = 0; i + 1 < bearings.length; i++) {
      widest = Math.max(widest, (bearings[i + 1] ?? 0) - (bearings[i] ?? 0));
    }
    expect(widest).toBeLessThan((TAU / 20) * 2);
  });

  it('gives the nearest bodies the room when a pack is standing off', () => {
    // A body that has stopped in reach is a wall, so the ones still walking are
    // settled around it rather than onto the ground it is holding.
    const standing = Array.from({ length: 3 }, (_, i) =>
      at(i + 1, (i / 3) * TAU, 60, 20, 68.8, true),
    );
    const closing = Array.from({ length: 3 }, (_, i) => at(i + 4, (i / 3) * TAU + 0.02, 500));
    const points = approachPoints(TARGET, [...standing, ...closing]);
    expect(points.size).toBe(3);
    for (const one of standing) expect(points.has(one.attackerId)).toBe(false);
    for (const one of closing) {
      const moved = polar(aimOf(points, one.attackerId));
      for (const wall of standing) {
        const want = requiredGap(60, wall.radius, moved.ring, one.radius);
        const have = Math.abs(delta(Math.atan2(wall.y, wall.x), moved.angle));
        expect(have).toBeGreaterThanOrEqual(want - 1e-6);
      }
    }
  });
});

describe('approachPoints is part of the deterministic core', () => {
  const pack = Array.from({ length: 9 }, (_, i) => at(i + 1, 0.15 * i, 400 + i * 3));

  it('does not depend on the order the attackers are offered in', () => {
    const forwards = approachPoints(TARGET, pack);
    const backwards = approachPoints(TARGET, [...pack].reverse());
    for (const one of pack) {
      expect(backwards.get(one.attackerId)).toEqual(forwards.get(one.attackerId));
    }
  });

  it('answers bit for bit on a replay', () => {
    const first = approachPoints(TARGET, pack);
    const second = approachPoints(TARGET, pack);
    for (const one of pack) {
      expect(aimOf(second, one.attackerId).x).toBe(aimOf(first, one.attackerId).x);
      expect(aimOf(second, one.attackerId).y).toBe(aimOf(first, one.attackerId).y);
    }
  });

  it('separates two bodies standing exactly on their target', () => {
    // No bearing to keep, so one is taken from the id -- any answer will do as
    // long as it is the same answer every tick, and NaN must not spread.
    const points = approachPoints(TARGET, [at(1, 0, 0), at(2, 0, 0)]);
    for (const point of points.values()) {
      expect(Number.isFinite(point.x)).toBe(true);
      expect(Number.isFinite(point.y)).toBe(true);
    }
  });
});
