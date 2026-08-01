import { describe, expect, it } from 'vitest';
import { BONE_COUNT, FIGURE } from './figure.js';
import { buildRobePieces, type ClothGeometry } from './geometry.js';

/**
 * The robe's patterns (spec 046). These are built once at startup and then
 * indexed blindly by the solver at ~500 constraint reads per particle per frame,
 * so a single out-of-range index would not be a wrong-looking robe -- it would
 * be silent garbage propagating through the whole constraint graph. Everything
 * here is a structural guarantee the solver is allowed to assume.
 */

const pieces = buildRobePieces(FIGURE);

/** Walk the link graph from the pinned particles and report what it reaches. */
function reachableFromPins(g: ClothGeometry): boolean[] {
  const seen = new Array<boolean>(g.count).fill(false);
  const stack: number[] = [];
  for (let i = 0; i < g.count; i++) {
    if (g.pinned[i]) {
      seen[i] = true;
      stack.push(i);
    }
  }
  // Adjacency built on the fly: the pieces are small enough that a rescan per
  // pop is cheaper to write than an index, and this only runs in tests.
  while (stack.length > 0) {
    const cur = stack.pop() as number;
    for (let k = 0; k < g.linkCount; k++) {
      const a = g.link[k * 2] as number;
      const b = g.link[k * 2 + 1] as number;
      const other = a === cur ? b : b === cur ? a : -1;
      if (other >= 0 && !seen[other]) {
        seen[other] = true;
        stack.push(other);
      }
    }
  }
  return seen;
}

describe('robe cloth patterns', () => {
  it('builds all five garment pieces', () => {
    expect(pieces.map((p) => p.name)).toEqual(['robe', 'cape', 'hood', 'sleeveL', 'sleeveR']);
  });

  for (const g of pieces) {
    describe(g.name, () => {
      it('has count == rows * cols and finite bind positions', () => {
        expect(g.count).toBe(g.rows * g.cols);
        expect(g.bind.length).toBe(g.count * 3);
        for (const v of g.bind) expect(Number.isFinite(v)).toBe(true);
      });

      it('binds every particle to a real bone', () => {
        expect(g.bone.length).toBe(g.count);
        for (let i = 0; i < g.count; i++) {
          const b = g.bone[i] as number;
          expect(b).toBeGreaterThanOrEqual(0);
          expect(b).toBeLessThan(BONE_COUNT);
        }
      });

      it('keeps every link index in range with a positive rest length', () => {
        expect(g.link.length).toBe(g.linkCount * 2);
        expect(g.linkCount).toBeGreaterThan(0);
        for (let k = 0; k < g.linkCount; k++) {
          const a = g.link[k * 2] as number;
          const b = g.link[k * 2 + 1] as number;
          expect(a).toBeGreaterThanOrEqual(0);
          expect(a).toBeLessThan(g.count);
          expect(b).toBeGreaterThanOrEqual(0);
          expect(b).toBeLessThan(g.count);
          expect(a).not.toBe(b);
          expect(g.linkRest[k] as number).toBeGreaterThan(0);
        }
      });

      it('has at least one pinned particle, and pins anchor to themselves', () => {
        let pins = 0;
        for (let i = 0; i < g.count; i++) if (g.pinned[i]) pins++;
        expect(pins).toBeGreaterThan(0);
        for (let i = 0; i < g.count; i++) {
          if (!g.pinned[i]) continue;
          expect(g.anchor[i] as number).toBe(i);
          expect(g.anchorRest[i] as number).toBe(0);
        }
      });

      it('tethers every free particle to a pinned anchor at a positive distance', () => {
        for (let i = 0; i < g.count; i++) {
          if (g.pinned[i]) continue;
          const a = g.anchor[i] as number;
          expect(g.pinned[a]).toBe(1);
          expect(g.anchorRest[i] as number).toBeGreaterThan(0);
        }
      });

      it('connects every particle to a pin through the link graph', () => {
        const seen = reachableFromPins(g);
        expect(seen.every(Boolean)).toBe(true);
      });

      it('triangulates without degenerate faces or out-of-range indices', () => {
        expect(g.index.length % 3).toBe(0);
        expect(g.index.length).toBeGreaterThan(0);
        for (let k = 0; k < g.index.length; k += 3) {
          const a = g.index[k] as number;
          const b = g.index[k + 1] as number;
          const c = g.index[k + 2] as number;
          for (const v of [a, b, c]) {
            expect(v).toBeGreaterThanOrEqual(0);
            expect(v).toBeLessThan(g.count);
          }
          expect(new Set([a, b, c]).size).toBe(3);
          // Non-zero area in the bind pose.
          const ux = (g.bind[b * 3] as number) - (g.bind[a * 3] as number);
          const uy = (g.bind[b * 3 + 1] as number) - (g.bind[a * 3 + 1] as number);
          const uz = (g.bind[b * 3 + 2] as number) - (g.bind[a * 3 + 2] as number);
          const vx = (g.bind[c * 3] as number) - (g.bind[a * 3] as number);
          const vy = (g.bind[c * 3 + 1] as number) - (g.bind[a * 3 + 1] as number);
          const vz = (g.bind[c * 3 + 2] as number) - (g.bind[a * 3 + 2] as number);
          const area = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
          expect(area).toBeGreaterThan(1e-6);
        }
      });

      it('weights the reference pose from held at the seam to loose at the hem', () => {
        for (let c = 0; c < g.cols; c++) {
          const top = g.refWeight[c] as number;
          const hem = g.refWeight[(g.rows - 1) * g.cols + c] as number;
          expect(top).toBeGreaterThan(hem);
          expect(hem).toBeGreaterThanOrEqual(0);
          expect(top).toBeLessThanOrEqual(1);
        }
      });

      it('gives every particle a distinct noise seed', () => {
        expect(new Set(Array.from(g.seed)).size).toBe(g.count);
      });
    });
  }

  it('gives the two sleeves disjoint noise streams', () => {
    const [, , , left, right] = pieces;
    const shared = new Set(Array.from((left as ClothGeometry).seed));
    for (const s of (right as ClothGeometry).seed) expect(shared.has(s)).toBe(false);
  });

  it('stays small enough to solve cheaply', () => {
    const particles = pieces.reduce((n, p) => n + p.count, 0);
    const links = pieces.reduce((n, p) => n + p.linkCount, 0);
    expect(particles).toBeLessThan(500);
    expect(links).toBeLessThan(4000);
  });
});
