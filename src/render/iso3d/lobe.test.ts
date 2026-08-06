import { describe, expect, it } from 'vitest';
import {
  LOBED,
  LOBED_FLAT,
  LOBED_SHAPES,
  lobeBlobs,
  lobeOutline,
  lobedCrownRadius,
  slabDrop,
  slabLayout,
  slabRise,
  trunkProfile,
} from './lobe.js';

/**
 * The lobed tree's shape as arithmetic (spec 076).
 *
 * What is worth asserting here is only the things a screenshot cannot tell you
 * apart. That the outline is a *union* rather than a wobble is one of them: a
 * perturbed radius and a genuine union look broadly similar in one frame and are
 * completely different at the edge, where the union has cusps and the wobble
 * does not. That the trunk ends in one vertex is another -- a cap collapsed to
 * zero width draws identically and Z-fights.
 */

/** The shape the world actually grows, not a restatement of it. */
const SHAPE = LOBED;

const RADIUS = SHAPE.canopySpread;
const SEGMENTS = SHAPE.lobeSegments;
/** A handful of independent slabs, so nothing below passes on one lucky draw. */
const SEEDS = [1, 7919, 15838, 23757, 31676, 404, 20260806];

describe('the blob outline', () => {
  it('places every circle so the slab origin is inside it', () => {
    // Not decoration: it is what makes the radial max below an *exact* union
    // rather than an approximation of one. A circle that missed the origin
    // would be invisible along the rays that do not reach it, and the outline
    // would develop a chord where its arc should be.
    for (const seed of SEEDS) {
      for (const blob of lobeBlobs(seed, RADIUS, SEGMENTS)) {
        expect(Math.hypot(blob.x, blob.z)).toBeLessThan(blob.r);
      }
    }
  });

  it('is the union: on the boundary of one circle, and outside all the rest', () => {
    for (const seed of SEEDS) {
      const blobs = lobeBlobs(seed, RADIUS, SEGMENTS);
      const outline = lobeOutline(blobs, SEGMENTS);
      outline.forEach((reach, i) => {
        const angle = (i / SEGMENTS) * Math.PI * 2;
        const x = Math.cos(angle) * reach;
        const z = Math.sin(angle) * reach;
        // How far outside each circle the outline point sits. Never negative --
        // that would be a boundary point inside the shape it bounds.
        const outside = blobs.map((b) => Math.hypot(x - b.x, z - b.z) - b.r);
        expect(Math.min(...outside)).toBeGreaterThan(-1e-9);
        // ...and it rests on at least one of them, so the outline is the union's
        // boundary rather than something merely containing it.
        expect(Math.min(...outside)).toBeLessThan(1e-9);
      });
    }
  });

  it('is bumpy rather than elliptical', () => {
    // The property the whole construction exists for. An ellipse has exactly two
    // local maxima and a modest long/short ratio; a union of six offset circles
    // has more of the first and much more of the second.
    for (const seed of SEEDS) {
      const outline = lobeOutline(lobeBlobs(seed, RADIUS, SEGMENTS), SEGMENTS);
      let maxima = 0;
      for (let i = 0; i < outline.length; i++) {
        const before = outline[(i - 1 + outline.length) % outline.length] as number;
        const here = outline[i] as number;
        const after = outline[(i + 1) % outline.length] as number;
        if (here > before && here >= after) maxima++;
      }
      expect(maxima).toBeGreaterThanOrEqual(2);
      const ratio = Math.max(...outline) / Math.min(...outline);
      // Well off round, and still recognisably a canopy rather than a shard.
      expect(ratio).toBeGreaterThan(1.25);
      expect(ratio).toBeLessThan(2.6);
    }
  });

  it('is normalised so its widest point is exactly the radius asked for', () => {
    // What lets `crownRadius` be a fact about the mesh rather than an estimate.
    for (const seed of SEEDS) {
      for (const radius of [12, 44, 90]) {
        const outline = lobeOutline(lobeBlobs(seed, radius, SEGMENTS), SEGMENTS);
        expect(Math.max(...outline)).toBeCloseTo(radius, 9);
      }
    }
  });

  it('is pure in its seed', () => {
    expect(lobeBlobs(7919, RADIUS, SEGMENTS)).toEqual(lobeBlobs(7919, RADIUS, SEGMENTS));
    expect(lobeBlobs(7919, RADIUS, SEGMENTS)).not.toEqual(lobeBlobs(7920, RADIUS, SEGMENTS));
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
    // wood, and identical blobs at two thicknesses would read as a mistake.
    const domed = slabLayout(LOBED).map((slab) => lobeOutline(slab.blobs, LOBED.lobeSegments));
    const flat = slabLayout(LOBED_FLAT).map((slab) => lobeOutline(slab.blobs, LOBED_FLAT.lobeSegments));
    expect(flat).not.toEqual(domed);
  });
});
