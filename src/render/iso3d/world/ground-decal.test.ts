import { describe, expect, it } from 'vitest';

import type { AimShape } from './aim.js';
import {
  BODY_RING_INNER,
  BODY_RING_MIN_RADIUS,
  MAX_RINGS,
  MAX_SEGMENTS,
  MAX_SEGMENT_ANGLE,
  SAMPLE_STEP,
  SLOPE_LIFT,
  SampledGround,
  aimTemplate,
  bodyRingRadius,
  bodyRingTemplate,
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
  // The smallest decal in the game and the one spec 153 left behind (spec 164).
  // In this list so that every invariant above holds of it by construction
  // rather than by a second copy of the assertions further down.
  ['ravager target ring', bodyRingTemplate(bodyRingRadius(30, 8))],
  ['grazer aim ring', bodyRingTemplate(bodyRingRadius(12, 10))],
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

describe('a curve is also bounded as an angle, not only as a distance', () => {
  // Spec 164. Sampling derived from size is exactly the right rule for
  // following the ground and says nothing at all about whether a circle still
  // looks like a circle -- which never bound on anything spec 153 converted,
  // because they are all large enough that the ground rule asks for more.

  /**
   * The angles of the vertices on a template's outer edge, in order.
   *
   * The rim is picked with a *relative* tolerance because `local` is a
   * `Float32Array`: a vertex on a 700-unit ring is a good 4e-5 off the radius it
   * was computed at, purely from being stored, and an absolute epsilon here
   * silently keeps four of the two hundred and fifty-seven.
   */
  function rimAngles(template: DecalTemplate): number[] {
    const local = locals(template);
    const outer = Math.max(...local.map((p) => Math.hypot(p.u, p.v)));
    return local
      .filter((p) => Math.hypot(p.u, p.v) > outer * (1 - 1e-4))
      .map((p) => Math.atan2(p.v, p.u))
      .sort((a, b) => a - b);
  }

  /** The widest turn between two neighbouring vertices on that edge. */
  function widestAngle(template: DecalTemplate): number {
    const angles = rimAngles(template);
    let widest = 0;
    for (let i = 1; i < angles.length; i++) {
      widest = Math.max(widest, (angles[i] ?? 0) - (angles[i - 1] ?? 0));
    }
    return widest;
  }

  for (const [name, template] of [
    ['a body ring', bodyRingTemplate(30)],
    ['a range ring', ringTemplate(420 * 0.985, 420)],
    ['a quake disc', discTemplate(140)],
    ['a small aim circle', discTemplate(20)],
    ['a slash cone', discTemplate(70, -Math.PI / 4, Math.PI / 4)],
  ] as const) {
    it(`never lets ${name} turn more than the limit between two vertices`, () => {
      expect(widestAngle(template)).toBeLessThanOrEqual(MAX_SEGMENT_ANGLE + 1e-6);
    });
  }

  it('leaves every shape spec 153 measured exactly as it tessellated them', () => {
    // Hardcoded rather than re-derived, so that changing the tessellation fails
    // here and sends somebody to spec 153's acceptance table -- which quotes
    // 482 vertices for the range ring and "about 1100" for the quake disc, and
    // would otherwise silently stop describing the code.
    expect(vertexCount(ringTemplate(420 * 0.985, 420))).toBe(482);
    expect(vertexCount(ringTemplate(700 * 0.985, 700))).toBe(514);
    expect(vertexCount(discTemplate(140))).toBe(1134);
    expect(vertexCount(discTemplate(70, -Math.PI / 4, Math.PI / 4))).toBe(88);
  });

  it('leaves a lane alone, because a straight edge has no curvature', () => {
    // The bound is applied by the arc builders rather than inside `segmentsFor`
    // for exactly this reason: flooring a lane's columns would buy nothing and
    // cost five height samples per vertex it added.
    expect(vertexCount(laneTemplate(700, 16))).toBe(195);
    expect(vertexCount(laneTemplate(60, 16))).toBe(21);
  });

  it('costs a sector proportionally, which a minimum count would not', () => {
    // A quarter turn gets a quarter of the segments a full turn does. Stated
    // because the obvious implementation -- `Math.max(24, ...)` -- gets this
    // wrong by a factor of four and no other test here would notice.
    expect(rimAngles(discTemplate(20)).length - 1).toBe(24);
    expect(rimAngles(discTemplate(20, -Math.PI / 4, Math.PI / 4)).length - 1).toBe(6);
  });
});

describe('the ring under a body', () => {
  // Spec 164: the two indicators spec 153 left on flat meshes, on the grounds
  // that they are small. What buries a flat mesh is its half-width times the
  // gradient under it, and only the half-width had been counted.

  it('was buried by its own body-sized flatness on ground this game really has', () => {
    // The arena's steepest ground falls 430 units within 260 -- a gradient of
    // about 1.65 -- and this is a slope less than half that steep.
    const outer = bodyRingRadius(30, 8);
    const template = bodyRingTemplate(outer);
    const pinned: HeightAt = () => SLOPE(120, -80);
    const flat = project(template, pinned, { x: 120, z: -80, heading: 0, lift: 1.6 });
    let worst = 0;
    for (const point of points(flat)) worst = Math.max(worst, SLOPE(point.x, point.z) - point.y);
    // Deep enough to swallow the ring whole at its uphill edge -- the lift plus
    // the entire thickness of the band, so what is left there is nothing at all
    // rather than a thinner ring.
    expect(worst).toBeGreaterThan(1.6 + outer * (1 - BODY_RING_INNER));
    expect(worst).toBeGreaterThan(12);
  });

  it('is where the scaled flat geometry drew it, on ground that was level', () => {
    // The conversion may not move the picture on the terrain the old one was
    // right about. `RingGeometry(22, 27)` scaled by `(radius + margin) / 27`.
    for (const [bodyRadius, margin] of [
      [30, 8],
      [22, 8],
      [12, 10],
      [20, 10],
    ] as const) {
      const scale = Math.max(0.6, (bodyRadius + margin) / 27);
      const outer = bodyRingRadius(bodyRadius, margin);
      expect(outer).toBeCloseTo(27 * scale, 0);

      const radii = locals(bodyRingTemplate(outer)).map((p) => Math.hypot(p.u, p.v));
      expect(Math.max(...radii)).toBeCloseTo(27 * scale, 0);
      expect(Math.min(...radii)).toBeCloseTo(22 * scale, 0);
    }
  });

  it('keeps the same proportions however big the body is', () => {
    for (const outer of [17, 20, 30, 40]) {
      const radii = locals(bodyRingTemplate(outer)).map((p) => Math.hypot(p.u, p.v));
      expect(Math.min(...radii) / Math.max(...radii)).toBeCloseTo(BODY_RING_INNER, 6);
    }
  });

  it('never draws smaller than the floor the old scale clamped to', () => {
    // `max(0.6, ...)` was a floor on the scale; here it is a floor on a radius,
    // so a very small body still gets a ring somebody can see.
    expect(bodyRingRadius(0, 0)).toBe(Math.round(BODY_RING_MIN_RADIUS));
    expect(bodyRingRadius(2, 3)).toBe(Math.round(BODY_RING_MIN_RADIUS));
    expect(bodyRingRadius(30, 8)).toBe(38);
  });

  it('re-uses its template while a body radius only wanders by a fraction', () => {
    // What keeps `GroundDecal.lay` from re-tessellating every frame: it holds
    // one template, keyed by this number.
    expect(bodyRingRadius(29.98, 8)).toBe(bodyRingRadius(30.02, 8));
    expect(bodyRingRadius(30, 8)).not.toBe(bodyRingRadius(31, 8));
  });

  it('stays cheap enough to draw two of, every frame', () => {
    // Two rings of this size against the 482 vertices the range ring beside
    // them already costs.
    expect(vertexCount(bodyRingTemplate(bodyRingRadius(30, 10)))).toBeLessThan(60);
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
