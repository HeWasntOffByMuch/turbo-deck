import { describe, expect, it } from 'vitest';
import {
  LOBED,
  lobeDiscs,
  lobeFreeArcs,
  lobeOutline,
  lobeReachLimit,
  lobedCrownRadius,
  slabDrop,
  slabLayout,
  slabRise,
  trunkProfile,
  type LobeDisc,
  type LobePoint,
} from './lobe.js';

/**
 * The lobed tree's shape as arithmetic (spec 076).
 *
 * What is worth asserting here is only the things a screenshot cannot tell you
 * apart. Where the outline is *round* and where it is *sharp* is the one this
 * shape lives or dies on: sharp everywhere is a star, round everywhere is an
 * ellipse, and both look broadly like the intended thing until you look at the
 * edge. So it is measured -- as a turn angle per vertex -- rather than admired.
 * That the trunk ends in one vertex is another such thing: a cap collapsed to
 * zero width draws identically and Z-fights.
 */

/** The shape the world actually grows, not a restatement of it. */
const SHAPE = LOBED;

const RADIUS = SHAPE.canopySpread;
/** A handful of independent slabs, so nothing below passes on one lucky draw. */
const SEEDS = [1, 7919, 15838, 23757, 31676, 404, 20260806];

describe('the slab outline', () => {
  /** The lobe counts the shipped tree draws from, plus the ends of the band. */
  const COUNTS = [...new Set([...SHAPE.lobeCounts, 4, 6])];
  const STEP = SHAPE.lobeArcStep;

  /** Every outline this suite sweeps: each lobe count, at each seed. */
  const outlines = COUNTS.flatMap((lobes) => SEEDS.map((seed) => lobeOutline(seed, RADIUS, lobes, STEP)));

  /** An outline vertex in the slab's own plane. */
  const at = (point: LobePoint): { x: number; z: number } => ({
    x: Math.cos(point.angle) * point.radius,
    z: Math.sin(point.angle) * point.radius,
  });

  /**
   * How far the boundary turns at each vertex, radians, signed: positive where
   * it bends the way a convex outline does, negative at a reflex corner.
   */
  function turns(outline: readonly LobePoint[]): number[] {
    const n = outline.length;
    return outline.map((_, i) => {
      const before = at(outline[(i - 1 + n) % n] as LobePoint);
      const here = at(outline[i] as LobePoint);
      const after = at(outline[(i + 1) % n] as LobePoint);
      const ax = here.x - before.x;
      const az = here.z - before.z;
      const bx = after.x - here.x;
      const bz = after.z - here.z;
      return Math.atan2(ax * bz - az * bx, ax * bx + az * bz);
    });
  }

  it('is a simple polygon: bearings strictly increasing, all the way round', () => {
    // Not bookkeeping. A polygon given as (bearing, radius) with the bearings in
    // order cannot cross itself and is star-shaped about the origin -- which is
    // exactly what the mesh builder assumes when it fans the slab from its
    // centre. Out of order, that fan folds back through itself and the slab is
    // drawn inside out.
    for (const outline of outlines) {
      expect(outline.length).toBeGreaterThan(12);
      for (let i = 1; i < outline.length; i++) {
        expect((outline[i] as LobePoint).angle).toBeGreaterThan((outline[i - 1] as LobePoint).angle);
      }
      const first = outline[0] as LobePoint;
      const last = outline[outline.length - 1] as LobePoint;
      expect(first.angle).toBeGreaterThanOrEqual(0);
      expect(last.angle - first.angle).toBeLessThan(Math.PI * 2);
      for (const point of outline) expect(point.radius).toBeGreaterThan(0);
    }
  });

  it('is round almost everywhere and sharp in a few places', () => {
    // The property that separates this construction from both of the ones it
    // replaced, and the reason it exists. A polygon of alternating radii is
    // sharp at *every* vertex, so its lobe tips are corners and it reads as a
    // star; a radially sampled union is round at every vertex including the
    // clefts, so it reads as an ellipse. Walking the arcs gives gentle turns
    // along a lobe and a handful of hard reflex turns between them.
    for (const outline of outlines) {
      const bend = turns(outline);
      const reflex = bend.filter((turn) => turn < -0.2);
      const convex = bend.filter((turn) => turn > 0);
      // A cleft per pair of neighbouring lobes, give or take the ones that
      // merged -- never none, and never one at every vertex.
      expect(reflex.length).toBeGreaterThanOrEqual(2);
      expect(reflex.length).toBeLessThanOrEqual(8);
      // The rest of the boundary is arc, and turns by about the arc step.
      expect(convex.length / bend.length).toBeGreaterThan(0.7);
      const gentle = convex.reduce((a, b) => a + b, 0) / convex.length;
      expect(gentle).toBeLessThan(STEP * 1.6);
      // ...and the clefts turn several times harder than the arcs do, which is
      // what "sharp" means when every vertex is technically a corner.
      expect(Math.abs(Math.min(...bend))).toBeGreaterThan(gentle * 2.5);
    }
  });

  it('cuts clefts deep enough to survive being drawn at the size of a tree', () => {
    // A slab is drawn a few dozen pixels across and foreshortened by an
    // isometric camera on top of that, so a notch worth a few percent of the
    // radius is not a notch, it is an ellipse.
    for (const outline of outlines) {
      const n = outline.length;
      const depths: number[] = [];
      for (let i = 0; i < n; i++) {
        const here = (outline[i] as LobePoint).radius;
        if (here >= (outline[(i - 1 + n) % n] as LobePoint).radius) continue;
        if (here > (outline[(i + 1) % n] as LobePoint).radius) continue;
        // Climb out of the cleft both ways; the shallower rim is its depth.
        let up = i;
        let down = i;
        const radiusAt = (k: number): number => (outline[((k % n) + n) % n] as LobePoint).radius;
        while (radiusAt(up + 1) >= radiusAt(up)) up++;
        while (radiusAt(down - 1) >= radiusAt(down)) down--;
        depths.push((Math.min(radiusAt(up), radiusAt(down)) - here) / RADIUS);
      }
      expect(depths.length).toBeGreaterThanOrEqual(2);
      // Shallower at six lobes than at four, necessarily: the same rim divided
      // more ways leaves each neighbour pair less room to part company.
      expect(Math.max(...depths)).toBeGreaterThan(0.15);
    }
  });

  it('keeps the lumps wide and the partings thin', () => {
    // The other half of the reference's look, and the one a depth number alone
    // does not pin: clefts that deep spread evenly around the rim is a starfish.
    // Most of the boundary has to be out near full reach, with the clefts narrow
    // -- so the *average* radius sits high even though a few vertices dive.
    for (const outline of outlines) {
      const mean = outline.reduce((sum, point) => sum + point.radius, 0) / outline.length;
      expect(mean / RADIUS).toBeGreaterThan(0.65);
    }
  });

  it('agrees with the union worked out the other way round', () => {
    // The arc walk checked against an independent computation of the same shape:
    // the radial max, which is exact on a star-shaped union and is what the
    // outline used to be built from before roundness and sharpness had to stop
    // competing. Every traced vertex must sit on the boundary that gives at its
    // own bearing -- to a single global factor, since the traced outline is
    // normalised and the raw discs are not.
    for (const lobes of COUNTS) {
      for (const seed of SEEDS) {
        const discs = lobeDiscs(seed, RADIUS, lobes);
        const reachAt = (angle: number): number => {
          let reach = 0;
          for (const d of discs) {
            const along = d.x * Math.cos(angle) + d.z * Math.sin(angle);
            const under = d.r * d.r - (d.x * d.x + d.z * d.z) + along * along;
            if (under > 0) reach = Math.max(reach, along + Math.sqrt(under));
          }
          return reach;
        };
        const ratios = lobeOutline(seed, RADIUS, lobes, STEP).map((p) => p.radius / reachAt(p.angle));
        // Not exact to the last bit, and could not be: at a cleft the two discs
        // give the same reach by two different routes through atan2 and hypot.
        expect(Math.max(...ratios) - Math.min(...ratios)).toBeLessThan(1e-6);
        expect(Math.min(...ratios)).toBeGreaterThan(0);
      }
    }
  });

  it('is one unbroken interval along every ray, which is what star-shaped means', () => {
    // The condition the mesh's centre fan rests on, checked by its consequence
    // rather than by restating the formula: walk out along a ray to the boundary
    // and every point on the way must be inside *something*. A gap here is a
    // slab with a ring-shaped hole in it.
    for (const lobes of COUNTS) {
      for (const seed of SEEDS) {
        const discs = lobeDiscs(seed, RADIUS, lobes);
        const core = discs[0] as LobeDisc;
        expect(core.x).toBe(0);
        expect(core.z).toBe(0);
        for (const disc of discs) {
          expect(Math.hypot(disc.x, disc.z)).toBeLessThanOrEqual(lobeReachLimit(core.r, disc.r) + 1e-9);
        }
        for (let i = 0; i < 180; i++) {
          const angle = (i / 180) * Math.PI * 2;
          let reach = 0;
          for (const disc of discs) {
            const along = disc.x * Math.cos(angle) + disc.z * Math.sin(angle);
            const disc2 = disc.r * disc.r - (disc.x * disc.x + disc.z * disc.z) + along * along;
            if (disc2 > 0) reach = Math.max(reach, along + Math.sqrt(disc2));
          }
          expect(reach).toBeGreaterThan(0);
          for (let step = 0; step <= 24; step++) {
            const t = (step / 24) * reach;
            const x = Math.cos(angle) * t;
            const z = Math.sin(angle) * t;
            expect(discs.some((d) => Math.hypot(x - d.x, z - d.z) <= d.r + 1e-9)).toBe(true);
          }
        }
      }
    }
  });

  it('is normalised so its widest point is exactly the radius asked for', () => {
    // What lets `crownRadius` be a fact about the mesh rather than an estimate.
    for (const seed of SEEDS) {
      for (const radius of [12, 44, 90]) {
        const outline = lobeOutline(seed, radius, 5, STEP);
        expect(Math.max(...outline.map((p) => p.radius))).toBeCloseTo(radius, 9);
      }
    }
  });

  it('is pure in its seed', () => {
    expect(lobeOutline(7919, RADIUS, 5, STEP)).toEqual(lobeOutline(7919, RADIUS, 5, STEP));
    expect(lobeOutline(7919, RADIUS, 5, STEP)).not.toEqual(lobeOutline(7920, RADIUS, 5, STEP));
  });

  it('turns out a different outline for every slab of a tree', () => {
    // Five slabs stamped from one outline read as a stack of copies, however
    // well the outline itself is shaped.
    const shapes = slabLayout(SHAPE).map((slab) =>
      slab.outline.map((p) => `${p.angle.toFixed(4)}:${(p.radius / slab.radius).toFixed(4)}`).join('|'),
    );
    expect(new Set(shapes).size).toBe(shapes.length);
  });
});

describe('walking one disc of the cluster', () => {
  const disc = (x: number, z: number, r: number): LobeDisc => ({ x, z, r });

  it('gives a lone disc its whole rim', () => {
    const arcs = lobeFreeArcs([disc(0, 0, 10)], 0);
    expect(arcs).toHaveLength(1);
    expect((arcs[0] as { lo: number; hi: number }).hi - (arcs[0] as { lo: number; hi: number }).lo)
      .toBeCloseTo(Math.PI * 2, 9);
  });

  it('gives a swallowed disc none of it, and its swallower all of it', () => {
    // The two cases that look alike in the arithmetic and are opposite in the
    // result. Confusing them is how a slab comes out either missing a lobe or
    // drawn with a stray rim through its middle.
    const discs = [disc(0, 0, 20), disc(2, 0, 5)];
    expect(lobeFreeArcs(discs, 1)).toHaveLength(0);
    const outer = lobeFreeArcs(discs, 0);
    expect(outer).toHaveLength(1);
    expect((outer[0] as { lo: number; hi: number }).hi - (outer[0] as { lo: number; hi: number }).lo)
      .toBeCloseTo(Math.PI * 2, 9);
  });

  it('leaves disjoint discs alone', () => {
    const discs = [disc(0, 0, 5), disc(40, 0, 5)];
    for (const i of [0, 1]) expect(lobeFreeArcs(discs, i)).toHaveLength(1);
  });

  it('hides the arc a crossing disc covers, and only that', () => {
    // Two equal discs offset along +x: each hides exactly the third of the
    // other's rim facing it. `acos(d / 2r)` at d = r is 60 degrees either side.
    const discs = [disc(0, 0, 10), disc(10, 0, 10)];
    const free = lobeFreeArcs(discs, 0);
    const covered = free.reduce((sum, arc) => sum - (arc.hi - arc.lo), Math.PI * 2);
    expect(covered).toBeCloseTo((2 * Math.PI) / 3, 9);
    // ...and what is hidden is the side facing the neighbour, not the far side.
    for (const arc of free) {
      for (const t of [arc.lo + 1e-6, arc.hi - 1e-6]) {
        expect(Math.hypot(Math.cos(t) * 10 - 10, Math.sin(t) * 10)).toBeGreaterThan(10 - 1e-6);
      }
    }
  });

  it('handles a covered arc that straddles the seam at zero', () => {
    // A neighbour due +x hides an interval centred on bearing 0, so it hangs off
    // both ends of [0, TAU) at once. Carried through the merge as a wrapping
    // interval that would have to be special-cased at every comparison; split in
    // two instead, and this is the case that says the split happened.
    const free = lobeFreeArcs([disc(0, 0, 10), disc(10, 0, 10)], 0);
    const covered = free.reduce((sum, arc) => sum - (arc.hi - arc.lo), Math.PI * 2);
    expect(covered).toBeCloseTo((2 * Math.PI) / 3, 9);
    // Nothing survives at bearing 0 itself, which is the middle of the hidden arc.
    expect(free.some((arc) => arc.lo <= 1e-9 && arc.hi >= 1e-9)).toBe(false);
  });
});

describe('the canopy layout', () => {
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

  it('domes each slab by a tenth to a fifth of its own width', () => {
    for (const slab of slabs) {
      const ofWidth = slab.rise / (2 * slab.radius);
      expect(ofWidth).toBeGreaterThanOrEqual(0.1);
      expect(ofWidth).toBeLessThanOrEqual(0.2);
      // A slab always occupies some height, above its plane and below it. One
      // that occupied none would have a single normal, and a single normal is a
      // single shade for ever -- which is what a flat variant was removed for.
      expect(slabRise(slab)).toBeGreaterThan(0);
      expect(slabDrop(SHAPE)).toBeGreaterThan(0);
      expect(slabRise(slab)).toBeCloseTo(slab.rise, 9);
      expect(slabDrop(SHAPE)).toBeCloseTo(SHAPE.slabThickness, 9);
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

describe('the trunk profile', () => {
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

