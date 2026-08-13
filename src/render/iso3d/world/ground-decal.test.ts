import { describe, expect, it } from 'vitest';

import type { AimShape } from './aim.js';
import {
  MAX_RINGS,
  MAX_SEGMENTS,
  SAMPLE_STEP,
  SLOPE_LIFT,
  SampledGround,
  aimTemplate,
  discTemplate,
  laneTemplate,
  projectDecal,
  ringTemplate,
  vertexCount,
  type DecalTemplate,
  type HeightAt,
} from './ground-decal.js';

/** A hillside: height rises with x, so a flat decal is wrong everywhere on it. */
const SLOPE: HeightAt = (x) => x * 0.4;
/** Something less obliging than a plane, to catch a fit that only works on one. */
const BUMPY: HeightAt = (x, z) => 30 * Math.sin(x / 37) + 18 * Math.cos(z / 23) + x * 0.1;
/**
 * A hard fold, and the one shape that catches a decal out: the ground is linear
 * everywhere except along one line, and a line has no width, so no finite set of
 * samples is guaranteed to land on it. Real terrain is full of these -- the
 * heightfield is piecewise linear, so every cell boundary is a crease -- but a
 * crease between two cells of a hillside is a slight one, and this is the worst
 * a crease can be: the gradient reverses across it.
 */
const RIDGE_GRADIENT = 0.7;
const RIDGE: HeightAt = (x, z) => 90 - Math.abs(x + z - 40) * RIDGE_GRADIENT;
const FLAT: HeightAt = () => 12;

function project(
  template: DecalTemplate,
  heightAt: HeightAt,
  placement: Partial<Parameters<typeof projectDecal>[1]> = {},
): Float32Array {
  return projectDecal(
    template,
    { x: 0, z: 0, heading: 0, lift: 1.2, ...placement },
    heightAt,
    new Float32Array(vertexCount(template) * 3),
  );
}

/** Every vertex of a projection, as XYZ triples. */
function points(world: Float32Array): { x: number; y: number; z: number }[] {
  const out: { x: number; y: number; z: number }[] = [];
  for (let i = 0; i < world.length; i += 3) {
    out.push({ x: world[i] ?? 0, y: world[i + 1] ?? 0, z: world[i + 2] ?? 0 });
  }
  return out;
}

/** Every vertex of a template, as local XZ pairs. */
function locals(template: DecalTemplate): { u: number; v: number }[] {
  const out: { u: number; v: number }[] = [];
  for (let i = 0; i < template.local.length; i += 2) {
    out.push({ u: template.local[i] ?? 0, v: template.local[i + 1] ?? 0 });
  }
  return out;
}

const SHAPES: readonly (readonly [string, DecalTemplate])[] = [
  ['quake', discTemplate(140)],
  ['slash cone', discTemplate(70, -Math.PI / 4, Math.PI / 4)],
  ['bolt lane', laneTemplate(700, 16)],
  ['range ring', ringTemplate(700 * 0.985, 700)],
  ['tiny', discTemplate(1)],
];

describe('a decal follows the ground it is laid on', () => {
  // The whole feature, and stated about the surface rather than about the
  // vertices: a vertex sitting exactly on the ground was never the problem, it
  // is the straight edge between two of them that cuts under whatever the ground
  // did in between, and a buried edge is a decal with a hole in it.
  for (const [name, template] of SHAPES) {
    for (const [groundName, heightAt] of [
      ['a slope', SLOPE],
      ['broken ground', BUMPY],
      ['a ridge', RIDGE],
    ] as const) {
      it(`never lets the ${name} sink into ${groundName}`, () => {
        const placement = { x: 120, z: -80, heading: 0.9, lift: 1.2 };
        const world = project(template, heightAt, placement);
        // What may be buried is never a vertex, so the samples are deliberately
        // taken between them.
        //
        // Smooth ground is cleared outright. A *crease* is not, and cannot be:
        // it is a line, and five point samples around a vertex can straddle it
        // without landing on it. What is asserted instead is the thing that
        // actually matters -- that what a crease costs is set by the sampling
        // step and by how sharply the ground folds, and by nothing about the
        // indicator. The old flat mesh's error scaled with the indicator's own
        // size, which is why it was tens of units wrong on a range ring; an
        // eighth of what the ground does across a crease over one step is a
        // number that stays the same whether the ring is 70 units across or 700.
        const crease = heightAt === RIDGE ? 2 * RIDGE_GRADIENT : 0;
        const allowed = (crease * template.step) / 8;
        for (let i = 0; i < template.index.length; i += 3) {
          for (let e = 0; e < 3; e++) {
            const va = template.index[i + e] ?? 0;
            const vb = template.index[i + ((e + 1) % 3)] ?? 0;
            for (const t of [0.17, 0.38, 0.5, 0.61, 0.83]) {
              const x = (world[va * 3] ?? 0) * (1 - t) + (world[vb * 3] ?? 0) * t;
              const z = (world[va * 3 + 2] ?? 0) * (1 - t) + (world[vb * 3 + 2] ?? 0) * t;
              const y = (world[va * 3 + 1] ?? 0) * (1 - t) + (world[vb * 3 + 1] ?? 0) * t;
              expect(y).toBeGreaterThanOrEqual(heightAt(x, z) - allowed);
            }
          }
        }
      });

      it(`keeps the ${name} within a step's worth of ${groundName}`, () => {
        // The other half of the same rule: clearing the ground is trivial if the
        // decal is allowed to fly, so how far it may be above is bounded too --
        // by whatever the ground itself does over half a step, and by nothing
        // else. Which is what makes the flying bounded on flat ground at zero.
        const placement = { x: 120, z: -80, heading: 0.9, lift: 1.2 };
        const world = project(template, heightAt, placement);
        const reach = template.step / 2;
        for (const point of points(world)) {
          const near = [
            heightAt(point.x, point.z),
            heightAt(point.x - reach, point.z),
            heightAt(point.x + reach, point.z),
            heightAt(point.x, point.z - reach),
            heightAt(point.x, point.z + reach),
          ];
          const spread = Math.max(...near) - Math.min(...near);
          expect(point.y).toBeLessThanOrEqual(
            Math.max(...near) + 1.2 + SLOPE_LIFT * spread + 1e-3,
          );
          expect(point.y).toBeGreaterThanOrEqual(heightAt(point.x, point.z) + 1.2 - 1e-3);
        }
      });
    }
  }

  it('is flat on flat ground, at the height the old flat mesh sat at', () => {
    // Level ground is where the old indicator was right, so it has to be exactly
    // where it was: the four extra samples agree with the centre and the lift is
    // the lift.
    const world = project(discTemplate(140), FLAT, { x: 300, z: 300, lift: 1.3 });
    for (const point of points(world)) expect(point.y).toBeCloseTo(13.3, 3);
  });

  it('is buried by the ground it used to be pinned to, which is the bug', () => {
    // The old placement, expressed as the height function it really was: one
    // sample under the indicator's centre, held across the whole of it. The
    // point of the test is that this is what the fix has to beat.
    const template = discTemplate(140);
    const pinned: HeightAt = () => SLOPE(120, -80);
    const flat = project(template, pinned, { x: 120, z: -80, heading: 0, lift: 1.2 });
    let worst = 0;
    for (const point of points(flat)) {
      worst = Math.max(worst, SLOPE(point.x, point.z) - point.y);
    }
    // Tens of units underground, on a slope a fifth as steep as the arena's
    // steepest -- and every unit of that is indicator drawn inside a hill.
    expect(worst).toBeGreaterThan(40);
  });

  it('refuses an output buffer that cannot hold the projection', () => {
    const template = discTemplate(140);
    expect(() =>
      projectDecal(
        template,
        { x: 0, z: 0, heading: 0, lift: 1 },
        FLAT,
        new Float32Array(vertexCount(template) * 3 - 1),
      ),
    ).toThrow(/need/);
  });
});

describe('the tessellation bounds what is left uncorrected', () => {
  // What is not sampled is interpolated, so the error between two samples is
  // whatever the ground does between them -- which is only bounded if the
  // spacing is. A grid diagonal is the longest an edge may be.
  for (const [name, template] of SHAPES) {
    it(`spaces the ${name}'s samples no further apart than a grid diagonal`, () => {
      const limit = template.step * Math.SQRT2 + 1e-3;
      const local = locals(template);
      for (let i = 0; i < template.index.length; i += 3) {
        const tri = [
          local[template.index[i] ?? 0],
          local[template.index[i + 1] ?? 0],
          local[template.index[i + 2] ?? 0],
        ];
        for (let e = 0; e < 3; e++) {
          const a = tri[e];
          const b = tri[(e + 1) % 3];
          expect(a).toBeDefined();
          expect(b).toBeDefined();
          if (!a || !b) continue;
          expect(Math.hypot(a.u - b.u, a.v - b.v)).toBeLessThanOrEqual(limit);
        }
      }
    });

    it(`indexes only vertices the ${name} has`, () => {
      const count = vertexCount(template);
      expect(template.index.length % 3).toBe(0);
      for (const i of template.index) expect(i).toBeLessThan(count);
    });
  }

  it('samples about every half-cell until the caps take over', () => {
    // A quake's disc is small enough to get the spacing it asked for.
    expect(discTemplate(140).step).toBeLessThanOrEqual(SAMPLE_STEP + 1e-3);
    // The longest range in the table is not, and degrades rather than costing
    // an unbounded number of lookups.
    const ring = ringTemplate(700 * 0.985, 700);
    expect(ring.step).toBeGreaterThan(SAMPLE_STEP);
    expect(ring.step).toBeLessThan(2 * SAMPLE_STEP);
  });

  it('keeps the vertex count bounded for the largest indicator in the game', () => {
    const cap = (MAX_SEGMENTS + 1) * (MAX_RINGS + 1);
    expect(vertexCount(ringTemplate(700 * 0.985, 700))).toBeLessThanOrEqual(cap);
    expect(vertexCount(discTemplate(140))).toBeLessThanOrEqual(cap);
    expect(vertexCount(laneTemplate(700, 16))).toBeLessThanOrEqual(cap);
    // And an absurd one, so the cap is the cap rather than a coincidence.
    expect(vertexCount(discTemplate(100_000))).toBeLessThanOrEqual(cap);
  });
});

describe('tessellating did not change what is drawn', () => {
  it('draws a disc out to its radius and no further', () => {
    const template = discTemplate(140);
    const radii = locals(template).map(({ u, v }) => Math.hypot(u, v));
    expect(Math.max(...radii)).toBeCloseTo(140, 3);
    expect(Math.min(...radii)).toBeCloseTo(0, 3);
  });

  it('keeps a cone inside its half-angle, and reaches both edges of it', () => {
    const half = Math.PI / 5;
    const template = discTemplate(70, -half, half);
    const angles = locals(template)
      // The apex has no angle to speak of.
      .filter(({ u, v }) => Math.hypot(u, v) > 1e-6)
      .map(({ u, v }) => Math.atan2(v, u));
    for (const angle of angles) expect(Math.abs(angle)).toBeLessThanOrEqual(half + 1e-3);
    expect(Math.max(...angles)).toBeCloseTo(half, 3);
    expect(Math.min(...angles)).toBeCloseTo(-half, 3);
  });

  it('runs a lane from the caster rather than centring it on them', () => {
    const template = laneTemplate(700, 16);
    const local = locals(template);
    expect(Math.min(...local.map((p) => p.u))).toBeCloseTo(0, 3);
    expect(Math.max(...local.map((p) => p.u))).toBeCloseTo(700, 3);
    expect(Math.min(...local.map((p) => p.v))).toBeCloseTo(-8, 3);
    expect(Math.max(...local.map((p) => p.v))).toBeCloseTo(8, 3);
  });

  it('holds a ring between its two radii, touching both', () => {
    const template = ringTemplate(689.5, 700);
    const radii = locals(template).map(({ u, v }) => Math.hypot(u, v));
    for (const radius of radii) {
      expect(radius).toBeGreaterThanOrEqual(689.5 - 1e-3);
      expect(radius).toBeLessThanOrEqual(700 + 1e-3);
    }
    expect(Math.min(...radii)).toBeCloseTo(689.5, 3);
    expect(Math.max(...radii)).toBeCloseTo(700, 3);
  });

  it('reads an aim shape the way the flat geometry did', () => {
    const circle: AimShape = { kind: 'circle', radius: 90 };
    const cone: AimShape = { kind: 'cone', halfAngle: Math.PI / 4, length: 70 };
    const line: AimShape = { kind: 'line', length: 420, width: 14 };

    const circleRadii = locals(aimTemplate(circle)).map(({ u, v }) => Math.hypot(u, v));
    expect(Math.max(...circleRadii)).toBeCloseTo(90, 3);

    const coneLocals = locals(aimTemplate(cone)).filter(({ u, v }) => Math.hypot(u, v) > 1e-6);
    expect(Math.max(...coneLocals.map(({ u, v }) => Math.hypot(u, v)))).toBeCloseTo(70, 3);
    expect(Math.max(...coneLocals.map(({ u, v }) => Math.atan2(v, u)))).toBeCloseTo(Math.PI / 4, 3);

    const lineLocals = locals(aimTemplate(line));
    expect(Math.max(...lineLocals.map((p) => p.u))).toBeCloseTo(420, 3);
    expect(Math.max(...lineLocals.map((p) => p.v))).toBeCloseTo(7, 3);

    expect(vertexCount(aimTemplate({ kind: 'none' }))).toBe(0);
  });
});

describe('a heading aims the shape', () => {
  it('rotates local +X onto the world direction it names', () => {
    for (const heading of [0, 0.4, Math.PI / 2, 2.7, -1.9]) {
      const world = project(laneTemplate(400, 10), FLAT, { x: 50, z: -25, heading });
      const far = points(world).reduce((best, point) =>
        Math.hypot(point.x - 50, point.z + 25) > Math.hypot(best.x - 50, best.z + 25) ? point : best,
      );
      // The far end of a lane is `length` away along the heading, plus half the
      // lane's width sideways -- so its *direction* is what is asserted, within
      // the angle that half-width subtends.
      const bearing = Math.atan2(far.z + 25, far.x - 50);
      const wobble = Math.atan2(5, 400);
      expect(Math.abs(Math.atan2(Math.sin(bearing - heading), Math.cos(bearing - heading)))).toBeLessThan(        wobble + 1e-6,
      );
    }
  });

  it('puts a circle where it was placed, whatever the heading', () => {
    const template = discTemplate(140);
    const straight = project(template, BUMPY, { x: 200, z: 90, heading: 0 });
    const turned = project(template, BUMPY, { x: 200, z: 90, heading: 1.1 });
    // A disc is symmetric: turning it moves vertices around the rim but not the
    // ground it covers, so the two projections span the same box.
    const box = (world: Float32Array): number[] => {
      const p = points(world);
      return [
        Math.min(...p.map((q) => q.x)),
        Math.max(...p.map((q) => q.x)),
        Math.min(...p.map((q) => q.z)),
        Math.max(...p.map((q) => q.z)),
      ];
    };
    const [ax0, ax1, az0, az1] = box(straight);
    const [bx0, bx1, bz0, bz1] = box(turned);
    expect(bx0).toBeCloseTo(ax0 ?? 0, 3);
    expect(bx1).toBeCloseTo(ax1 ?? 0, 3);
    expect(bz0).toBeCloseTo(az0 ?? 0, 3);
    expect(bz1).toBeCloseTo(az1 ?? 0, 3);
  });

  it('projects the same buffer twice for the same input', () => {
    const template = discTemplate(140);
    const once = project(template, BUMPY, { x: 12, z: 34, heading: 0.7 });
    const twice = project(template, BUMPY, { x: 12, z: 34, heading: 0.7 });
    expect(Array.from(twice)).toEqual(Array.from(once));
  });
});

describe('the ground is memoized, because asking it is expensive', () => {
  /** A height function that counts, so the memo can be asserted rather than assumed. */
  function counted(heightAt: HeightAt): { at: HeightAt; calls: () => number } {
    let calls = 0;
    return {
      at: (x, z) => {
        calls++;
        return heightAt(x, z);
      },
      calls: () => calls,
    };
  }

  it('is exact on its own lattice', () => {
    const source = counted(BUMPY);
    const ground = new SampledGround(source.at, 11);
    for (const [i, j] of [
      [0, 0],
      [3, -7],
      [-12, 40],
    ] as const) {
      expect(ground.at(i * 11, j * 11)).toBeCloseTo(BUMPY(i * 11, j * 11), 9);
    }
  });

  it('blends between lattice points rather than snapping to one', () => {
    // A staircase would be the cheap wrong answer here, and it would show:
    // every vertex inside a lattice cell would take the same height and a decal
    // on a hillside would come out terraced.
    const ground = new SampledGround(SLOPE, 11);
    const a = ground.at(0, 0);
    const b = ground.at(11, 0);
    for (const t of [0.2, 0.5, 0.9]) {
      expect(ground.at(11 * t, 0)).toBeCloseTo(a + (b - a) * t, 6);
    }
  });

  it('asks the heightfield once per lattice point, however often it is read', () => {
    const source = counted(BUMPY);
    const ground = new SampledGround(source.at, 11);
    for (let k = 0; k < 500; k++) ground.at(3 + (k % 7) * 0.4, 5 - (k % 5) * 0.3);
    // One lattice cell: its four corners, and nothing else, ever.
    expect(source.calls()).toBe(4);
    expect(ground.size).toBe(4);
  });

  it('is warm for an aim that is moving, which is the case that matters', () => {
    const source = counted(BUMPY);
    const ground = new SampledGround(source.at, SAMPLE_STEP);
    const template = ringTemplate(420 * 0.985, 420);
    const out = new Float32Array(vertexCount(template) * 3);
    const frame = (f: number): void => {
      projectDecal(template, { x: f * 3, z: f * 2, heading: 0, lift: 1.1 }, ground.at, out);
    };
    for (let f = 0; f < 20; f++) frame(f);
    const warm = source.calls();
    for (let f = 20; f < 40; f++) frame(f);
    const perFrame = (source.calls() - warm) / 20;
    // Thousands of reads a frame; a couple of hundred fresh samples at most,
    // because a ring that moved three units is asking about the ground it was
    // asking about last frame.
    expect(perFrame).toBeLessThan(200);
    expect(perFrame).toBeGreaterThan(0);
  });

  it('forgets everything when the ground changes under it', () => {
    let height = 10;
    const ground = new SampledGround(() => height, 11);
    expect(ground.at(5, 5)).toBe(10);
    height = 40;
    // Still the old answer: that is what a memo is.
    expect(ground.at(5, 5)).toBe(10);
    ground.invalidate();
    expect(ground.at(5, 5)).toBe(40);
    expect(ground.size).toBe(4);
  });

  it('starts over rather than growing without bound', () => {
    const ground = new SampledGround(BUMPY, 11, 64);
    for (let k = 0; k < 4000; k++) ground.at(k * 37, k * 53);
    expect(ground.size).toBeLessThanOrEqual(64 + 4);
  });

  it('places a decal where the heightfield itself would have', () => {
    // The memo is an approximation, and this is the size of it: sampling a
    // heightfield with 22-unit cells every 11 and blending loses very little,
    // and what it does lose is absorbed by the lift.
    const template = discTemplate(140);
    const exact = project(template, BUMPY, { x: 40, z: -60, heading: 0.4, lift: 1.3 });
    const ground = new SampledGround(BUMPY, SAMPLE_STEP);
    const memo = project(template, ground.at, { x: 40, z: -60, heading: 0.4, lift: 1.3 });
    let worst = 0;
    for (let i = 1; i < exact.length; i += 3) {
      worst = Math.max(worst, Math.abs((exact[i] ?? 0) - (memo[i] ?? 0)));
    }
    expect(worst).toBeLessThan(2);
  });
});
