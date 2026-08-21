/**
 * `segmentClear` off the index, against the walk it replaces (spec 205).
 *
 * The whole change is a claim that the same answer is reached by less work, so
 * the test is equality against the walk -- written out here, because the walk no
 * longer exists in the source. Equality and never a tolerance: this is the
 * deterministic core, and a sight check that is right almost always is a replay
 * that diverges eventually.
 */

import { describe, expect, it } from 'vitest';

import { buildColliderIndex } from './collider-index.js';
import { segmentClear } from './collision.js';
import { loadMapFile } from '../server/world/map-file.js';
import { buildWorldFromMap } from '../server/world/build.js';
import type { Circle, Rect, Vec2, WorldColliders } from './types.js';

const SHIPPED = (() => {
  const loaded = loadMapFile();
  return buildWorldFromMap(loaded.doc, loaded.mapId).colliders;
})();

/** What `segmentClear` was before the index: every rect, then every circle. */
function walked(a: Vec2, b: Vec2, radius: number, world: WorldColliders): boolean {
  for (const rect of world.rects) {
    if (hitsBox(a, b, rect.x - radius, rect.y - radius, rect.x + rect.w + radius, rect.y + rect.h + radius)) {
      return false;
    }
  }
  for (const circle of world.circles) {
    if (hitsCircle(a, b, radius, circle)) return false;
  }
  return true;
}

/** The same predicates, transcribed, so the comparison is against the geometry. */
function hitsCircle(a: Vec2, b: Vec2, radius: number, circle: Circle): boolean {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const lenSq = abx * abx + aby * aby;
  const raw = lenSq < 1e-12 ? 0 : ((circle.x - a.x) * abx + (circle.y - a.y) * aby) / lenSq;
  const t = raw < 0 ? 0 : raw > 1 ? 1 : raw;
  const dx = a.x + abx * t - circle.x;
  const dy = a.y + aby * t - circle.y;
  const reach = radius + circle.r;
  return dx * dx + dy * dy < reach * reach;
}

function hitsBox(a: Vec2, b: Vec2, minX: number, minY: number, maxX: number, maxY: number): boolean {
  // Only used for the handful of arena rects, and only to keep the reference
  // implementation whole; the rect half of `segmentClear` did not change.
  const steps = 512;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = a.x + (b.x - a.x) * t;
    const y = a.y + (b.y - a.y) * t;
    if (x >= minX && x <= maxX && y >= minY && y <= maxY) return true;
  }
  return false;
}

/** A deterministic spread of segments, so the fixture is the same forever. */
function segments(count: number, span: number, minLen: number, maxLen: number): [Vec2, Vec2][] {
  let h = 0x9e3779b9;
  const next = (): number => {
    h ^= h << 13;
    h ^= h >>> 17;
    h ^= h << 5;
    return ((h >>> 0) % 1000003) / 1000003;
  };
  const out: [Vec2, Vec2][] = [];
  for (let i = 0; i < count; i++) {
    const x = -span + next() * 2 * span;
    const y = -span + next() * 2 * span;
    const angle = next() * Math.PI * 2;
    const len = minLen + next() * (maxLen - minLen);
    out.push([{ x, y }, { x: x + Math.cos(angle) * len, y: y + Math.sin(angle) * len }]);
  }
  return out;
}

/** How many of a set came back blocked, so a test can say the fixture is live. */
function blockedCount(pairs: readonly [Vec2, Vec2][], radius: number, world: WorldColliders): number {
  let n = 0;
  for (const [a, b] of pairs) if (!segmentClear(a, b, radius, world)) n += 1;
  return n;
}

describe('the indexed answer is the walked answer', () => {
  it('agrees over thousands of segments on the shipped map', () => {
    const pairs = segments(4000, 6000, 100, 800);
    let disagreed = 0;
    for (const [a, b] of pairs) {
      if (segmentClear(a, b, 16, SHIPPED) !== walked(a, b, 16, SHIPPED)) disagreed += 1;
    }
    expect(disagreed).toBe(0);
    // The fixture has to actually hit things, or agreement is agreement about
    // nothing -- which is what an equivalence test over open ground would be.
    const blocked = blockedCount(pairs, 16, SHIPPED);
    expect(blocked).toBeGreaterThan(pairs.length / 4);
    expect(blocked).toBeLessThan(pairs.length);
  });

  it('agrees at every body radius the sim routes with', () => {
    const pairs = segments(600, 5000, 50, 400);
    for (const radius of [12, 16, 20, 22, 30]) {
      for (const [a, b] of pairs) {
        expect(segmentClear(a, b, radius, SHIPPED)).toBe(walked(a, b, radius, SHIPPED));
      }
    }
  });

  it('agrees on a zero-length segment', () => {
    // `lenSq < 1e-12` is its own branch in the predicate, and a body asking
    // whether it can see where it already stands is an ordinary tick.
    const pairs = segments(400, 5000, 0, 0);
    for (const [a, b] of pairs) {
      expect(segmentClear(a, b, 16, SHIPPED)).toBe(walked(a, b, 16, SHIPPED));
    }
  });

  it('agrees on a segment far outside the index, in every direction', () => {
    // The index's extent is the circles' bounding box, and the query clamps its
    // cell block into it -- so a segment entirely outside must come back clear
    // rather than come back with whatever the nearest cell happened to hold.
    const far = 400000;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]] as const) {
      const a = { x: dx * far, y: dy * far };
      const b = { x: dx * far + 500, y: dy * far + 500 };
      expect(segmentClear(a, b, 16, SHIPPED)).toBe(walked(a, b, 16, SHIPPED));
      expect(segmentClear(a, b, 16, SHIPPED)).toBe(true);
    }
  });

  it('agrees on a segment that starts inside a collider', () => {
    // A body pushed into a tree asks this every tick until it is out again.
    let checked = 0;
    for (const circle of SHIPPED.circles.slice(0, 300)) {
      const a = { x: circle.x, y: circle.y };
      for (const [dx, dy] of [[1, 0], [0, 1], [-1, -1]] as const) {
        const b = { x: a.x + dx * 600, y: a.y + dy * 600 };
        expect(segmentClear(a, b, 16, SHIPPED)).toBe(walked(a, b, 16, SHIPPED));
        expect(segmentClear(a, b, 16, SHIPPED)).toBe(false);
        checked += 1;
      }
    }
    expect(checked).toBe(900);
  });

  it('agrees on a segment far longer than anything the sim asks about', () => {
    // Not because the sim does it, but because the bounding box is the whole
    // approximation: a long diagonal over-fetches, and over-fetching must never
    // change an answer.
    const pairs = segments(200, 2000, 8000, 16000);
    for (const [a, b] of pairs) {
      expect(segmentClear(a, b, 16, SHIPPED)).toBe(walked(a, b, 16, SHIPPED));
    }
  });

  it('agrees on a world with no circles at all', () => {
    const rects: Rect[] = [{ x: 0, y: 0, w: 100, h: 100 }];
    const bare: WorldColliders = {
      bounds: { x: -500, y: -500, w: 1000, h: 1000 },
      rects,
      circles: [],
      index: buildColliderIndex([]),
    };
    expect(segmentClear({ x: -200, y: 50 }, { x: 300, y: 50 }, 4, bare)).toBe(false);
    expect(segmentClear({ x: -200, y: 400 }, { x: 300, y: 400 }, 4, bare)).toBe(true);
  });

  it('is not confused by being called again while its scratch is warm', () => {
    // The gathered set is a module-level array reused across calls. It is safe
    // because the function never yields -- stated as a test so that a future
    // `await` in here fails rather than corrupting a neighbouring answer.
    const pairs = segments(500, 5000, 100, 700);
    const once = pairs.map(([a, b]) => segmentClear(a, b, 16, SHIPPED));
    const twice = pairs.map(([a, b]) => segmentClear(a, b, 16, SHIPPED));
    expect(twice).toEqual(once);
  });
});
