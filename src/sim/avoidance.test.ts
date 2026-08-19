/**
 * Reciprocal avoidance (spec 186).
 *
 * Most of these are *simulations* rather than single calls, and deliberately:
 * one solved velocity says almost nothing -- what the solver is for is what a
 * pair or a crowd does over a second of ticks, and every failure mode this
 * feature has (jitter, deadlock, a body stopping dead, a fast body trapped
 * behind a slow one) is a property of a trajectory rather than of a step.
 */

import { describe, expect, it } from 'vitest';
import { avoidanceVelocity, orcaLine, type AvoidanceParams, type CrowdAgent } from './avoidance.js';

const TICK = 1 / 60;
const PARAMS: AvoidanceParams = { horizon: 1.2, timeStep: TICK };

interface Walker extends CrowdAgent {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  pinned: boolean;
  readonly speed: number;
  /** Where it is trying to get to. */
  readonly goalX: number;
  readonly goalY: number;
}

function walker(over: Partial<Walker> & { x: number; y: number; goalX: number; goalY: number }): Walker {
  return {
    vx: 0,
    vy: 0,
    radius: 20,
    pinned: false,
    speed: 100,
    ...over,
  };
}

/** The velocity a walker wants: straight at its goal, at its own speed. */
function preferred(self: Walker): { x: number; y: number } {
  const dx = self.goalX - self.x;
  const dy = self.goalY - self.y;
  const length = Math.hypot(dx, dy);
  if (length < 1e-6) return { x: 0, y: 0 };
  const want = Math.min(self.speed, length / TICK);
  return { x: (dx / length) * want, y: (dy / length) * want };
}

interface Trace {
  /** Closest any two walkers came, as a fraction of the distance they should have kept. */
  readonly closest: number;
  /** Largest change in a single walker's velocity between consecutive ticks. */
  readonly jerk: number;
  /** How far each walker still is from its goal. */
  readonly remaining: readonly number[];
  readonly walkers: readonly Walker[];
}

/** Run everybody to their goals for `ticks`, solving every tick. */
function run(walkers: readonly Walker[], ticks: number): Trace {
  let closest = Infinity;
  let jerk = 0;

  for (let t = 0; t < ticks; t++) {
    const solved = walkers.map((self) =>
      self.pinned
        ? preferred(self)
        : avoidanceVelocity(self, walkers.filter((o) => o !== self), preferred(self), self.speed, PARAMS),
    );
    for (let i = 0; i < walkers.length; i++) {
      const self = walkers[i];
      const next = solved[i];
      if (!self || !next) continue;
      // Only while it is still travelling: arriving is a legitimate stop, and
      // counting it would make every trace's worst tick the last one.
      if (Math.hypot(self.goalX - self.x, self.goalY - self.y) > 60) {
        jerk = Math.max(jerk, Math.hypot(next.x - self.vx, next.y - self.vy));
      }
      self.vx = next.x;
      self.vy = next.y;
      self.x += self.vx * TICK;
      self.y += self.vy * TICK;
    }
    for (let i = 0; i < walkers.length; i++) {
      for (let j = i + 1; j < walkers.length; j++) {
        const a = walkers[i];
        const b = walkers[j];
        if (!a || !b) continue;
        closest = Math.min(closest, Math.hypot(a.x - b.x, a.y - b.y) / (a.radius + b.radius));
      }
    }
  }

  return {
    closest,
    jerk,
    remaining: walkers.map((w) => Math.hypot(w.goalX - w.x, w.goalY - w.y)),
    walkers,
  };
}

describe('avoidanceVelocity', () => {
  it('leaves a body with nobody near it exactly as it asked', () => {
    const self = walker({ x: 0, y: 0, goalX: 500, goalY: 0 });
    const got = avoidanceVelocity(self, [], { x: 100, y: 0 }, 100, PARAMS);
    expect(got.x).toBeCloseTo(100, 9);
    expect(got.y).toBeCloseTo(0, 9);
  });

  it('never answers faster than the body can go', () => {
    const self = walker({ x: 0, y: 0, goalX: 500, goalY: 0, speed: 60 });
    const got = avoidanceVelocity(self, [], { x: 1000, y: 1000 }, 60, PARAMS);
    expect(Math.hypot(got.x, got.y)).toBeCloseTo(60, 6);
  });

  it('answers something finite when a body is boxed in on every side', () => {
    // Five bodies pressed against one, so no velocity satisfies every
    // half-plane. The point of the fallback is that there is still an answer.
    const self = walker({ x: 0, y: 0, goalX: 500, goalY: 0 });
    const ring: Walker[] = [];
    for (let i = 0; i < 5; i++) {
      const angle = (i * 2 * Math.PI) / 5;
      ring.push(
        walker({
          x: Math.cos(angle) * 30,
          y: Math.sin(angle) * 30,
          goalX: -Math.cos(angle) * 500,
          goalY: -Math.sin(angle) * 500,
          vx: -Math.cos(angle) * 100,
          vy: -Math.sin(angle) * 100,
        }),
      );
    }
    const got = avoidanceVelocity(self, ring, { x: 100, y: 0 }, 100, PARAMS);
    expect(Number.isFinite(got.x)).toBe(true);
    expect(Number.isFinite(got.y)).toBe(true);
    expect(Math.hypot(got.x, got.y)).toBeLessThanOrEqual(100 + 1e-6);
  });

  it('gives the same answer for the same question, every time', () => {
    const build = (): Walker[] => [
      walker({ x: 0, y: 0, goalX: 400, goalY: 0, vx: 100, vy: 0 }),
      walker({ x: 200, y: 10, goalX: -200, goalY: 10, vx: -100, vy: 0 }),
      walker({ x: 100, y: 150, goalX: 100, goalY: -300, vx: 0, vy: -100 }),
    ];
    const first = run(build(), 90);
    const second = run(build(), 90);
    for (let i = 0; i < first.walkers.length; i++) {
      expect(second.walkers[i]?.x).toBe(first.walkers[i]?.x);
      expect(second.walkers[i]?.y).toBe(first.walkers[i]?.y);
    }
  });
});

describe('a pair on a collision course', () => {
  it('passes head-on without either walking through the other', () => {
    const trace = run(
      [
        // Not exactly collinear: two bodies aimed at each other's centres to the
        // last bit have no side to prefer, and the answer there is to slow down,
        // which is correct and is not what this test is about.
        walker({ x: -300, y: -3, goalX: 300, goalY: -3, vx: 100, vy: 0 }),
        walker({ x: 300, y: 3, goalX: -300, goalY: 3, vx: -100, vy: 0 }),
      ],
      420,
    );
    expect(trace.closest).toBeGreaterThan(0.98);
    // And both still got where they were going.
    expect(trace.remaining[0]).toBeLessThan(30);
    expect(trace.remaining[1]).toBeLessThan(30);
  });

  it('crosses at right angles without stopping', () => {
    const trace = run(
      [
        walker({ x: -300, y: 0, goalX: 300, goalY: 0, vx: 100, vy: 0 }),
        walker({ x: 4, y: -300, goalX: 4, goalY: 300, vx: 0, vy: 100 }),
      ],
      420,
    );
    expect(trace.closest).toBeGreaterThan(0.98);
    expect(trace.remaining[0]).toBeLessThan(30);
    expect(trace.remaining[1]).toBeLessThan(30);
  });

  /**
   * The one configuration the solver is genuinely slow on, recorded here rather
   * than papered over -- it is why `crowd.ts` gives every body a hair of
   * deterministic asymmetry before asking.
   *
   * Two bodies crossing in *exact* mirror symmetry have no side to prefer, so
   * both take the same answer, stay mirrored, and grind round each other for
   * seconds. The four units of offset in the test above is enough to break it;
   * so is a thousandth of a radian. Nothing is unsafe about it -- they never
   * touch, and they do get there -- it just reads as a long polite dance.
   */
  it('resolves an exactly mirrored crossing eventually, and slowly', () => {
    const slow = run(
      [
        walker({ x: -300, y: 0, goalX: 300, goalY: 0, vx: 100, vy: 0 }),
        walker({ x: 0, y: -300, goalX: 0, goalY: 300, vx: 0, vy: 100 }),
      ],
      420,
    );
    expect(slow.closest).toBeGreaterThan(0.98);
    // Nowhere near arriving in the time the offset pair needed.
    expect(slow.remaining[0]).toBeGreaterThan(100);
  });

  it('settles rather than shuddering: no tick swings the velocity by more than a fraction of top speed', () => {
    const trace = run(
      [
        walker({ x: -300, y: -3, goalX: 300, goalY: -3, vx: 100, vy: 0 }),
        walker({ x: 300, y: 3, goalX: -300, goalY: 3, vx: -100, vy: 0 }),
      ],
      420,
    );
    // A repulsion force swings the full speed back and forth across the pass.
    expect(trace.jerk).toBeLessThan(60);
  });
});

describe('a body that will not deviate', () => {
  it('is given way to entirely rather than half way', () => {
    // Close enough that the standing body is inside the horizon: at 100 units a
    // second with a second of lookahead, anything past ~120 units is not yet a
    // constraint on anybody.
    const mover = walker({ x: -90, y: 6, goalX: 200, goalY: 6, vx: 100, vy: 0 });
    const free = walker({ x: 0, y: 0, goalX: 0, goalY: 0, vx: 0, vy: 0 });
    const pinnedOne = walker({ x: 0, y: 0, goalX: 0, goalY: 0, vx: 0, vy: 0, pinned: true });

    const againstFree = avoidanceVelocity(mover, [free], preferred(mover), mover.speed, PARAMS);
    const againstPinned = avoidanceVelocity(mover, [pinnedOne], preferred(mover), mover.speed, PARAMS);

    const wanted = preferred(mover);
    const deviationFree = Math.hypot(againstFree.x - wanted.x, againstFree.y - wanted.y);
    const deviationPinned = Math.hypot(againstPinned.x - wanted.x, againstPinned.y - wanted.y);
    expect(deviationPinned).toBeGreaterThan(deviationFree * 1.9);
  });

  it('is walked around, not into', () => {
    const mover = walker({ x: -300, y: 1, goalX: 300, goalY: 1, vx: 100, vy: 0 });
    const standing = walker({ x: 0, y: 0, goalX: 0, goalY: 0, pinned: true });
    const trace = run([mover, standing], 420);
    expect(trace.closest).toBeGreaterThan(0.98);
    expect(trace.remaining[0]).toBeLessThan(30);
    // The pinned body did not budge.
    expect(standing.x).toBe(0);
    expect(standing.y).toBe(0);
  });
});

describe('bodies of different speeds', () => {
  it('lets a fast body overtake a slow one rather than queue behind it', () => {
    const slow = walker({ x: 0, y: 0, goalX: 900, goalY: 0, vx: 40, vy: 0, speed: 40 });
    const fast = walker({ x: -80, y: 0, goalX: 900, goalY: 0, vx: 115, vy: 0, speed: 115 });
    run([slow, fast], 600);
    // The fast one is in front, and it got there by going round: it never
    // dropped to the slow one's pace for long enough to be stuck behind it.
    expect(fast.x).toBeGreaterThan(slow.x + 100);
  });

  it('does not make the slow body faster or the fast body slower than its own cap', () => {
    const slow = walker({ x: 0, y: 0, goalX: 900, goalY: 0, vx: 40, vy: 0, speed: 40 });
    const fast = walker({ x: -80, y: 0, goalX: 900, goalY: 0, vx: 115, vy: 0, speed: 115 });
    run([slow, fast], 600);
    expect(Math.hypot(slow.vx, slow.vy)).toBeLessThanOrEqual(40 + 1e-6);
    expect(Math.hypot(fast.vx, fast.vy)).toBeLessThanOrEqual(115 + 1e-6);
  });
});

describe('bodies that already overlap', () => {
  it('are told to separate rather than to hold still', () => {
    // Two bodies inside each other with no velocity: the cone has no tip to be
    // outside of, and the one-tick horizon is what gives an answer at all.
    const a: CrowdAgent = { x: 0, y: 0, vx: 0, vy: 0, radius: 20, pinned: false };
    const b: CrowdAgent = { x: 8, y: 0, vx: 0, vy: 0, radius: 20, pinned: false };
    const got = avoidanceVelocity(a, [b], { x: 0, y: 0 }, 100, PARAMS);
    expect(got.x).toBeLessThan(0);
  });

  it('build a half-plane at all when a pair is exactly coincident', () => {
    const a: CrowdAgent = { x: 0, y: 0, vx: 0, vy: 0, radius: 20, pinned: false };
    const b: CrowdAgent = { x: 0, y: 0, vx: 0, vy: 0, radius: 20, pinned: false };
    // No direction to separate along and nothing to invent one from: the honest
    // answer is no constraint, and the positional pass in `crowd.ts` is what
    // splits a coincident pair.
    expect(orcaLine(a, b, PARAMS)).toBeNull();
  });
});

describe('a crowd', () => {
  it('gets twenty bodies through each other without a collision', () => {
    const walkers: Walker[] = [];
    for (let i = 0; i < 10; i++) {
      walkers.push(walker({ x: -400, y: (i - 4.5) * 55, goalX: 400, goalY: (i - 4.5) * 55, vx: 100, vy: 0 }));
    }
    for (let i = 0; i < 10; i++) {
      walkers.push(walker({ x: 400, y: (i - 4.5) * 55 + 12, goalX: -400, goalY: (i - 4.5) * 55 + 12, vx: -100, vy: 0 }));
    }
    const trace = run(walkers, 900);
    expect(trace.closest).toBeGreaterThan(0.9);
    // Everyone crossed.
    for (const left of trace.remaining) expect(left).toBeLessThan(60);
  });
});
