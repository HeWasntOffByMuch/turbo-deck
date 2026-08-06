import { describe, expect, it } from 'vitest';
import {
  LOBED,
  LOBED_FLAT,
  LOBED_SHAPES,
  lobeOutline,
  lobedCrownRadius,
  slabDrop,
  slabLayout,
  slabRise,
  trunkProfile,
  type LobePoint,
} from './lobe.js';

/**
 * The lobed tree's shape as arithmetic (spec 076).
 *
 * What is worth asserting here is only the things a screenshot cannot tell you
 * apart. How *deep* the outline's notches cut is one of them: a shallow scallop
 * and a deep one are the same picture at a glance and completely different at
 * the size a tree is actually drawn, so the depth is a number here rather than
 * an impression. That the trunk ends in one vertex is another -- a cap collapsed
 * to zero width draws identically and Z-fights.
 */

/** The shape the world actually grows, not a restatement of it. */
const SHAPE = LOBED;

const RADIUS = SHAPE.canopySpread;
/** A handful of independent slabs, so nothing below passes on one lucky draw. */
const SEEDS = [1, 7919, 15838, 23757, 31676, 404, 20260806];

describe('the slab outline', () => {
  /** The corner counts the shipped tree draws from, plus the ends of the band. */
  const COUNTS = [...new Set([...SHAPE.lobeVertices, 8, 14])];

  /** Every outline this suite sweeps: each count, at each seed. */
  const outlines = COUNTS.flatMap((count) => SEEDS.map((seed) => lobeOutline(seed, RADIUS, count)));

  it('is a simple polygon: bearings strictly increasing, all the way round', () => {
    // Not bookkeeping. A polygon given as (bearing, radius) with the bearings in
    // order cannot cross itself and is star-shaped about the origin -- which is
    // exactly what the mesh builder assumes when it fans the slab from its
    // centre. Out of order, that fan folds back through itself and the slab is
    // drawn inside out.
    for (const outline of outlines) {
      for (let i = 1; i < outline.length; i++) {
        expect((outline[i] as LobePoint).angle).toBeGreaterThan((outline[i - 1] as LobePoint).angle);
      }
      const first = outline[0] as LobePoint;
      const last = outline[outline.length - 1] as LobePoint;
      expect(first.angle).toBeGreaterThanOrEqual(0);
      // ...and the wrap from the last vertex back to the first closes the turn
      // rather than overshooting it or leaving a wedge missing.
      expect(last.angle - first.angle).toBeLessThan(Math.PI * 2);
      for (const point of outline) expect(point.radius).toBeGreaterThan(0);
    }
  });

  it('rounds the corner count down to even, so the alternation closes', () => {
    // At an odd count the last vertex and the first are both in the same band,
    // and the slab carries one long flat edge where a notch belongs.
    for (const asked of [7, 8, 9, 10, 11, 12, 13, 14]) {
      const outline = lobeOutline(4242, RADIUS, asked);
      expect(outline.length % 2).toBe(0);
      expect(outline.length).toBeLessThanOrEqual(asked);
      expect(outline.length).toBeGreaterThanOrEqual(asked - 1);
    }
  });

  it('alternates far and near, so every other vertex is a notch', () => {
    for (const outline of outlines) {
      const radii = outline.map((point) => point.radius);
      const far = radii.filter((_, i) => i % 2 === 0);
      const near = radii.filter((_, i) => i % 2 === 1);
      expect(Math.min(...far)).toBeGreaterThan(Math.max(...near));
      // Each band has width of its own, so the lobes are not all one length --
      // bands with no width would give a perfectly regular star.
      expect(Math.max(...far) - Math.min(...far)).toBeGreaterThan(0);
      expect(Math.max(...near) - Math.min(...near)).toBeGreaterThan(0);
    }
  });

  it('cuts notches deep enough to survive being drawn at the size of a tree', () => {
    // The number the shape exists to produce. A slab is drawn a few dozen pixels
    // across and foreshortened by an isometric camera on top of that, so a notch
    // worth a few percent of the radius is not a notch, it is an ellipse.
    for (const outline of outlines) {
      const n = outline.length;
      const depths: number[] = [];
      for (let i = 1; i < n; i += 2) {
        const before = (outline[i - 1] as LobePoint).radius;
        const here = (outline[i] as LobePoint).radius;
        const after = (outline[(i + 1) % n] as LobePoint).radius;
        depths.push((Math.min(before, after) - here) / RADIUS);
      }
      expect(depths.length).toBeGreaterThanOrEqual(4);
      expect(Math.min(...depths)).toBeGreaterThan(0.1);
      const mean = depths.reduce((a, b) => a + b, 0) / depths.length;
      expect(mean).toBeGreaterThan(0.2);
      // Bounded above as well, and that bound is not a formality. A notch reads
      // against the angular width of the lobe beside it, and at ten or twelve
      // corners those lobes are thirty-odd degrees wide -- so past about a third
      // the slab stops being a leaf mass with bumps and becomes a holly leaf.
      expect(mean).toBeLessThan(0.32);
    }
  });

  it('spaces the vertices unevenly, which is what stops it reading as a gear', () => {
    // The property that is easiest to lose and hardest to see in a still: evenly
    // spaced, a far/near alternation *is* a cog, and jittering the radii does not
    // hide it, because the eye locks onto the pitch and not the lengths.
    for (const outline of outlines) {
      const n = outline.length;
      const gaps = outline.map((point, i) =>
        i === n - 1 ? Math.PI * 2 - point.angle + (outline[0] as LobePoint).angle
          : (outline[i + 1] as LobePoint).angle - point.angle,
      );
      const even = (Math.PI * 2) / n;
      // The widest gap is at least half again the narrowest...
      expect(Math.max(...gaps) / Math.min(...gaps)).toBeGreaterThan(1.5);
      // ...and no gap is a sliver, which is a wasted triangle and a shading
      // artefact rather than character.
      expect(Math.min(...gaps)).toBeGreaterThan(even * 0.4);
      // The gaps still close the circle exactly, whatever they were drawn as.
      expect(gaps.reduce((a, b) => a + b, 0)).toBeCloseTo(Math.PI * 2, 9);
    }
  });

  it('is normalised so its widest point is exactly the radius asked for', () => {
    // What lets `crownRadius` be a fact about the mesh rather than an estimate.
    for (const seed of SEEDS) {
      for (const radius of [12, 44, 90]) {
        const outline = lobeOutline(seed, radius, 10);
        expect(Math.max(...outline.map((p) => p.radius))).toBeCloseTo(radius, 9);
      }
    }
  });

  it('is pure in its seed', () => {
    expect(lobeOutline(7919, RADIUS, 10)).toEqual(lobeOutline(7919, RADIUS, 10));
    expect(lobeOutline(7919, RADIUS, 10)).not.toEqual(lobeOutline(7920, RADIUS, 10));
  });

  it('turns out a different polygon for every slab of a tree', () => {
    // Five slabs stamped from one outline read as a stack of copies, however
    // well the outline itself is shaped.
    for (const shape of LOBED_SHAPES) {
      const shapes = slabLayout(shape).map((slab) =>
        slab.outline.map((p) => `${p.angle.toFixed(4)}:${(p.radius / slab.radius).toFixed(4)}`).join('|'),
      );
      expect(new Set(shapes).size).toBe(shapes.length);
    }
  });
});

describe.each(LOBED_SHAPES.map((shape) => [shape.slabPitch === 0 ? 'domed' : 'flat', shape] as const))(
  'the canopy layout (%s)',
  (_name, SHAPE) => {
  const slabs = slabLayout(SHAPE);

  it('climbs the upper trunk, largest at the bottom of the cluster', () => {
    for (let i = 1; i < slabs.length; i++) {
      expect((slabs[i] as (typeof slabs)[number]).y).toBeGreaterThan((slabs[i - 1] as (typeof slabs)[number]).y);
      expect((slabs[i] as (typeof slabs)[number]).radius).toBeLessThan(
        (slabs[i - 1] as (typeof slabs)[number]).radius,
      );
    }
    expect((slabs[0] as (typeof slabs)[number]).y).toBeCloseTo(SHAPE.height * SHAPE.canopyBase, 9);
    expect((slabs[slabs.length - 1] as (typeof slabs)[number]).y).toBeCloseTo(SHAPE.height * SHAPE.canopyTop, 9);
    // ...and the tapered tip carries on above the highest of them.
    expect((slabs[slabs.length - 1] as (typeof slabs)[number]).y).toBeLessThan(SHAPE.height);
  });

  it('rises and drops by the dome and the pitch together', () => {
    for (const slab of slabs) {
      // The dome is the brief's 10-20% of slab width where there is one at all,
      // and the flat variant's is exactly nothing.
      const ofWidth = slab.rise / (2 * slab.radius);
      if (SHAPE.domeRise > 0) {
        expect(ofWidth).toBeGreaterThanOrEqual(0.1);
        expect(ofWidth).toBeLessThanOrEqual(0.2);
      } else {
        expect(ofWidth).toBe(0);
      }
      // Whatever the dome does, the pitch lifts the far rim and drops the near
      // one -- which is what the canopy's vertical extent is actually made of.
      const pitched = slab.radius * Math.sin(SHAPE.slabPitch);
      expect(slabRise(slab, SHAPE)).toBeCloseTo(slab.rise + pitched, 9);
      expect(slabDrop(slab, SHAPE)).toBeCloseTo(SHAPE.slabThickness + pitched, 9);
      // Neither is ever zero: a slab always occupies some height, by one route
      // or the other, and something that occupied none would be invisible edge on
      // from every bearing at once.
      expect(slabRise(slab, SHAPE)).toBeGreaterThan(0);
      expect(slabDrop(slab, SHAPE)).toBeGreaterThan(0);
    }
  });

  it('slides every slab off the trunk, in varying directions', () => {
    const bearings = slabs.map((slab) => Math.atan2(slab.offsetZ, slab.offsetX));
    for (const slab of slabs) {
      const reach = Math.hypot(slab.offsetX, slab.offsetZ);
      expect(reach).toBeGreaterThan(0);
      expect(reach).toBeLessThanOrEqual(SHAPE.slabOffset + 1e-9);
      // Off the axis but never off the slab: a centre further out than its own
      // radius would hang the canopy beside the trunk instead of around it.
      expect(reach).toBeLessThan(slab.radius);
    }
    // No two consecutive slabs slide the same way, or one side of the trunk
    // stays bare all the way up the cluster.
    for (let i = 1; i < bearings.length; i++) {
      const gap = Math.abs(((bearings[i] as number) - (bearings[i - 1] as number) + Math.PI) % (2 * Math.PI)) - Math.PI;
      expect(Math.abs(gap)).toBeGreaterThan(0.6);
    }
  });

  it('overlaps its slabs in plan view, at every count it can grow', () => {
    // What makes the canopy one mass rather than a stack of separate plates.
    for (const count of SHAPE.slabCounts) {
      const drawn = slabs.filter((slab) => slab.grownAt <= count);
      for (let i = 1; i < drawn.length; i++) {
        const a = drawn[i - 1] as (typeof drawn)[number];
        const b = drawn[i] as (typeof drawn)[number];
        expect(Math.hypot(a.offsetX - b.offsetX, a.offsetZ - b.offsetZ)).toBeLessThan(a.radius + b.radius);
      }
    }
  });

  it('grows exactly as many slabs as the count asks for, and always the top one', () => {
    // The reason `grownAt` exists at all. Dropping slabs off the *top* instead
    // would leave a three-slab tree as a bare whip with foliage halfway up it,
    // because the trunk is one shared geometry and cannot shorten with the
    // canopy.
    const top = (slabs[slabs.length - 1] as (typeof slabs)[number]).index;
    for (const count of new Set(SHAPE.slabCounts)) {
      const drawn = slabs.filter((slab) => slab.grownAt <= count);
      expect(drawn).toHaveLength(count);
      expect(drawn.map((slab) => slab.index)).toContain(top);
      expect(drawn.map((slab) => slab.index)).toContain(0);
    }
  });

  it('reports a crown wide enough to be worth calling a canopy', () => {
    const widest = Math.max(...slabs.map((slab) => Math.hypot(slab.offsetX, slab.offsetZ) + slab.radius));
    expect(lobedCrownRadius(SHAPE)).toBeCloseTo(widest, 9);
    expect(lobedCrownRadius(SHAPE)).toBeGreaterThan(SHAPE.canopySpread);
  });
});

describe.each(LOBED_SHAPES.map((shape) => [shape.slabPitch === 0 ? 'domed' : 'flat', shape] as const))(
  'the trunk profile (%s)',
  (_name, SHAPE) => {
  const rings = trunkProfile(SHAPE);

  it('stands on the ground and ends at the tree height', () => {
    expect((rings[0] as (typeof rings)[number]).y).toBe(0);
    expect((rings[rings.length - 1] as (typeof rings)[number]).y).toBeCloseTo(SHAPE.height, 9);
    expect(rings).toHaveLength(SHAPE.trunkRings + 1);
  });

  it('tapers to a point, with no ring left over to cap', () => {
    // "No flat cap, the tip terminates in a single vertex": the last ring has
    // radius exactly zero, so the band below it is a fan to one apex rather than
    // a strip to a ring of coincident vertices that would Z-fight forever.
    expect((rings[rings.length - 1] as (typeof rings)[number]).radius).toBe(0);
    for (let i = 1; i < rings.length; i++) {
      expect((rings[i] as (typeof rings)[number]).radius).toBeLessThan(
        (rings[i - 1] as (typeof rings)[number]).radius,
      );
    }
  });

  it('reads as a pole rather than as a column', () => {
    // The slenderness the brief asks for, stated as the ratio it is about. The
    // conifers sit at 4.7%; anything near a tenth is a post.
    expect(SHAPE.trunkRadius / SHAPE.height).toBeLessThan(0.05);
  });

  it('is planted where it says it is, and leans only slightly', () => {
    const base = rings[0] as (typeof rings)[number];
    expect(Math.hypot(base.x, base.z)).toBe(0);
    // Mostly straight: the whole trunk stays inside a narrow cylinder about its
    // own axis, so it reads as a tree that grew rather than one that fell over.
    for (const ring of rings) {
      expect(Math.hypot(ring.x, ring.z)).toBeLessThan(SHAPE.trunkBow * SHAPE.height + SHAPE.trunkRadius);
    }
    // ...but it does drift: a perfectly straight pole is the thing this is not.
    const tip = rings[rings.length - 1] as (typeof rings)[number];
    expect(Math.hypot(tip.x, tip.z)).toBeGreaterThan(SHAPE.trunkRadius / 2);
  });

  it('is pure in the shape it was given', () => {
    expect(trunkProfile(SHAPE)).toEqual(trunkProfile(SHAPE));
    expect(trunkProfile({ ...SHAPE, seed: SHAPE.seed + 1 })).not.toEqual(rings);
  });
});

describe('the flat variant', () => {
  it('is the domed tree in every proportion but its leaves', () => {
    // "Just like it, but flat." Everything that is not about the leaves is the
    // same number, so the two read as one plant built two ways rather than as
    // two plants -- and so that retuning the tree does not mean retuning it
    // twice and discovering later that only one of them was done.
    const leafFields = new Set(['domeRise', 'slabThickness', 'lobeRings', 'slabPitch', 'seed']);
    for (const key of Object.keys(LOBED) as (keyof typeof LOBED)[]) {
      if (leafFields.has(key)) continue;
      expect(LOBED_FLAT[key]).toEqual(LOBED[key]);
    }
  });

  it('has no dome, no thickness and no interior rings', () => {
    expect(LOBED_FLAT.domeRise).toBe(0);
    // Exactly zero, not merely small: the geometry builder reads it as "one
    // sheet", and a hair above zero would be two coincident ones instead.
    expect(LOBED_FLAT.slabThickness).toBe(0);
    // Interior rings subdivide a curve, and a plane has none to subdivide.
    expect(LOBED_FLAT.lobeRings).toBe(1);
    for (const slab of slabLayout(LOBED_FLAT)) expect(slab.rise).toBe(0);
  });

  it('tips its leaves 30 degrees, and the domed one not at all', () => {
    expect((LOBED_FLAT.slabPitch * 180) / Math.PI).toBeCloseTo(30, 9);
    expect(LOBED.slabPitch).toBe(0);
  });

  it('draws its own outlines rather than the domed tree\'s', () => {
    // Same proportions, different seed: the two stand side by side in the same
    // wood, and identical polygons at two thicknesses would read as a mistake.
    const shapesOf = (shape: typeof LOBED): string[] =>
      slabLayout(shape).map((slab) =>
        slab.outline.map((p) => `${p.angle.toFixed(4)}:${(p.radius / slab.radius).toFixed(4)}`).join('|'),
      );
    expect(shapesOf(LOBED_FLAT)).not.toEqual(shapesOf(LOBED));
  });
});
