import { hashUnit2 } from '../../shared/hash.js';

/**
 * The lobed canopy tree's shape, as arithmetic (spec 077).
 *
 * Pure -- no three.js, no DOM -- for the same reason `wind.ts` is: the numbers
 * here are the art direction, and a silhouette that decides how a whole forest
 * reads should be checkable in Node rather than by squinting at a frame. What
 * lives here is *where the vertices go*; `props.ts` turns that into buffers.
 *
* ## Why the outline is a cluster of discs, traced as arcs
 *
 * The reference is a canopy of a handful of **big round lumps** with **narrow
 * deep clefts** between them: wide convex arcs, and a sharp V only where two
 * lumps meet. Round almost everywhere, sharp in a few places. Two obvious
 * constructions each get exactly half of that, and neither can be pushed into
 * the other half:
 *
 * - A **polygon** -- vertices at alternating near and far radii -- is sharp
 *   *everywhere*. Its lobe tips are corners, so at eight or ten vertices it
 *   reads as a star, and adding vertices to round the tips shallows the clefts
 *   at the same rate, because both are made of the same thing.
 * - A **radially sampled union** of circles is round everywhere and sharp
 *   nowhere: a cleft is a cusp, a cusp is a single point, and evenly spaced
 *   samples land on one about never, so every cleft comes back with a chord
 *   across it.
 *
 * So the union is not sampled radially, it is **walked**. For each disc, the
 * stretches of its rim that no other disc buries are its share of the union's
 * boundary; each of those arcs is sampled along its own length, and each *ends*
 * exactly at a crossing with another disc. Roundness and sharpness stop
 * competing: the arc step buys the first, and the arc endpoints are the second,
 * exactly, for nothing.
 *
 * ## What keeps it star-shaped, and why that matters
 *
 * A slab's mesh is a fan from its centre, and the domed variant is that fan at
 * two or three shrunken rings -- both of which need the outline star-shaped
 * about the origin, or they fold through themselves.
 *
 * So the discs are a **core at the origin plus lobes around it**, and each lobe
 * is held to
 *
 *     |c|^2 <= coreRadius^2 + r^2
 *
 * which says the furthest along a ray that the ray can *enter* that lobe --
 * `sqrt(|c|^2 - r^2)`, the tangent case, imaginary when the origin is inside it
 * -- is no further out than the core, so the core has already covered the gap
 * and the ray never leaves the shape and comes back. Star-shaped, the boundary
 * has exactly one point per bearing, which is what lets the sampled arcs be
 * assembled by **sorting on bearing** rather than by chaining endpoints.
 */

const TAU = Math.PI * 2;

/** Seeds for the independent hashed channels, so one wobble does not imply another. */
const HASH_LOBE_BEARING = 0x10be01;
const HASH_LOBE_RADIUS = 0x10be02;
const HASH_LOBE_REACH = 0x10be03;
const HASH_SLAB_BEARING = 0x10be04;
const HASH_SLAB_REACH = 0x10be05;
const HASH_TRUNK_KINK = 0x10be06;
const HASH_TRUNK_BOW = 0x10be07;
const HASH_LOBE_COUNT = 0x10be08;
const HASH_LOBE_SQUASH = 0x10be09;

/** One vertex of a slab's outline: which way it lies, and how far out it reaches. */
export interface LobePoint {
  readonly angle: number;
  readonly radius: number;
}

/** One disc of the cluster a slab's silhouette is the union of. */
export interface LobeDisc {
  readonly x: number;
  readonly z: number;
  readonly r: number;
}

/** An angular interval of some disc's rim. Always `lo < hi`, never wrapping. */
export interface LobeArc {
  readonly lo: number;
  readonly hi: number;
}

/** Bearings nearer than this are one vertex, not two: no sliver triangles. */
const ANGLE_MERGE = 2e-3;

/**
 * The core disc's radius, as a fraction of the slab's own.
 *
 * How deep the clefts can cut, since a cleft bottoms out where the two lobes
 * beside it meet the core. Smaller and they bite deeper but the slab starts to
 * read as separate leaves; larger and the core swallows the lobes back into one
 * plain disc.
 */
const CORE_SHARE = 0.46;

/** A lobe's radius, against the slab's. Big: these are lumps, not bumps on a disc. */
const LOBE_MIN = 0.36;
const LOBE_SPAN = 0.22;

/**
 * How much of the star-shape limit a lobe uses. Near the top of it, because that
 * is where two neighbours cross deepest and the cleft between them is narrowest
 * -- which is the shape of the reference: wide lumps, thin partings.
 */
const REACH_MIN = 0.84;
const REACH_SPAN = 0.15;

/** The bearing gaps between lobes, as ratios before they are scaled to a turn. */
const GAP_MIN = 0.6;
const GAP_SPAN = 0.85;

/** How far the cluster may be drawn out along one axis, so it reads as a clump. */
const SQUASH_MIN = 0.05;
const SQUASH_SPAN = 0.16;

/**
 * How far from the origin a lobe of radius `r` may sit and leave the union
 * star-shaped, given a core of radius `core`.
 *
 * The furthest a ray can *enter* the lobe is at the tangent, `sqrt(|c|^2 - r^2)`
 * from the origin; requiring that to be at most `core` rearranges to this. When
 * the origin is inside the lobe the requirement is met trivially, and this
 * returns the larger distance that says so.
 */
export function lobeReachLimit(core: number, r: number): number {
  return Math.hypot(core, r);
}

/**
 * Merge angular intervals, splitting any that wrap past a full turn. The result
 * is sorted, disjoint and non-wrapping.
 */
function mergeArcs(raw: readonly LobeArc[]): LobeArc[] {
  const split: LobeArc[] = [];
  for (const arc of raw) {
    if (arc.hi - arc.lo >= TAU) return [{ lo: 0, hi: TAU }];
    // Everything arrives centred on some bearing and can hang off either end of
    // [0, TAU). Cut those in two rather than carrying a wrap flag through the
    // merge, where it would have to be special-cased at every comparison.
    const lo = ((arc.lo % TAU) + TAU) % TAU;
    const hi = lo + (arc.hi - arc.lo);
    if (hi > TAU) split.push({ lo, hi: TAU }, { lo: 0, hi: hi - TAU });
    else split.push({ lo, hi });
  }
  split.sort((a, b) => a.lo - b.lo);

  const merged: LobeArc[] = [];
  for (const arc of split) {
    const last = merged[merged.length - 1];
    if (last && arc.lo <= last.hi) {
      if (arc.hi > last.hi) merged[merged.length - 1] = { lo: last.lo, hi: arc.hi };
    } else {
      merged.push(arc);
    }
  }
  return merged;
}

/**
 * The stretches of disc `i`'s rim that no other disc buries -- its share of the
 * union's boundary.
 *
 * Three arrangements have to be told apart and only one of them is interesting.
 * A disc swallowed whole by another contributes nothing; a disc that swallows
 * another loses nothing to it; and two that genuinely cross hide the arc of one
 * within `acos((d^2 + r^2 - other^2) / 2dr)` of the bearing toward the other.
 * Confusing the first two is how a slab comes out either missing a lobe or drawn
 * with a stray rim through its middle.
 */
export function lobeFreeArcs(discs: readonly LobeDisc[], i: number): LobeArc[] {
  const a = discs[i];
  if (!a) return [];
  const covered: LobeArc[] = [];
  for (let j = 0; j < discs.length; j++) {
    if (j === i) continue;
    const b = discs[j] as LobeDisc;
    const span = Math.hypot(b.x - a.x, b.z - a.z);
    if (span + a.r <= b.r) return [];
    if (span >= a.r + b.r || span + b.r <= a.r) continue;
    const mid = Math.atan2(b.z - a.z, b.x - a.x);
    const cosHalf = (span * span + a.r * a.r - b.r * b.r) / (2 * span * a.r);
    const half = Math.acos(Math.min(1, Math.max(-1, cosHalf)));
    covered.push({ lo: mid - half, hi: mid + half });
  }

  const merged = mergeArcs(covered);
  if (merged.length === 0) return [{ lo: 0, hi: TAU }];
  const free: LobeArc[] = [];
  let at = 0;
  for (const arc of merged) {
    if (arc.lo > at) free.push({ lo: at, hi: arc.lo });
    at = Math.max(at, arc.hi);
  }
  if (at < TAU) free.push({ lo: at, hi: TAU });
  return free;
}

/**
 * The discs one slab's silhouette is the union of: a core at the origin and a
 * few big lobes around it.
 *
 * The lobes are **big** -- comparable to the core rather than decorations on it
 * -- which is what makes the finished outline a handful of round lumps instead
 * of a disc with bumps. And they are pushed out to most of
 * {@link lobeReachLimit}, because that is where two neighbours cross deepest and
 * the cleft between them is narrowest.
 *
 * The bearings are drawn as *gaps* and scaled to close the circle, so they can
 * be as uneven as they like and still come out spread. Jittering each lobe off
 * an even step cannot promise that, and the lobe that lands doubled with its
 * neighbour merges into it and quietly reduces the count by one.
 */
export function lobeDiscs(seed: number, radius: number, lobes: number): LobeDisc[] {
  const core = radius * CORE_SHARE;
  // The core is a disc like any other, so the arc walk, the normalisation and
  // the star-shape rule all treat it as one and nothing needs a special case.
  const out: LobeDisc[] = [{ x: 0, z: 0, r: core }];

  const gaps: number[] = [];
  let total = 0;
  for (let i = 0; i < lobes; i++) {
    const gap = GAP_MIN + GAP_SPAN * hashUnit2(i, seed, HASH_LOBE_BEARING);
    gaps.push(gap);
    total += gap;
  }

  // How far the cluster is drawn out along one axis, and which axis. Lobes all
  // at one distance make a rosette; the point of this is that a canopy read from
  // above is a clump, and a clump is longer one way than the other.
  const squash = SQUASH_MIN + SQUASH_SPAN * hashUnit2(lobes, seed, HASH_LOBE_SQUASH);
  const squashAxis = hashUnit2(lobes + 1, seed, HASH_LOBE_SQUASH) * TAU;

  let bearing = hashUnit2(lobes + 2, seed, HASH_LOBE_BEARING) * TAU;
  for (let i = 0; i < lobes; i++) {
    const r = radius * (LOBE_MIN + LOBE_SPAN * hashUnit2(i, seed, HASH_LOBE_RADIUS));
    const limit = lobeReachLimit(core, r);
    const wanted = limit * (REACH_MIN + REACH_SPAN * hashUnit2(i, seed, HASH_LOBE_REACH));
    // Elliptical, then clamped back inside the limit -- so the squash can never
    // be the thing that breaks star-shapedness.
    const stretch = 1 + squash * Math.cos(2 * (bearing - squashAxis));
    const distance = Math.min(limit, wanted * stretch);
    out.push({ x: Math.cos(bearing) * distance, z: Math.sin(bearing) * distance, r });
    bearing += ((gaps[i] as number) / total) * TAU;
  }
  return out;
}

/**
 * The union's boundary as a closed polygon, in order of bearing.
 *
 * Each disc's free arcs are sampled along their own length at `arcStep`, so a
 * long arc gets many points and reads as round, and every arc contributes its
 * two endpoints -- which are crossings with another disc, and so are the clefts,
 * exactly, without being searched for.
 *
 * Assembled by **sorting on bearing**, which works because the union is
 * star-shaped about the origin and its boundary therefore has one point per
 * bearing. Without that guarantee the arcs would have to be chained end to end,
 * and the arithmetic deciding which endpoint meets which is where this kind of
 * code goes wrong.
 */
export function lobeOutline(seed: number, radius: number, lobes: number, arcStep: number): LobePoint[] {
  const discs = lobeDiscs(seed, radius, lobes);
  const points: LobePoint[] = [];
  discs.forEach((disc, i) => {
    for (const arc of lobeFreeArcs(discs, i)) {
      const steps = Math.max(1, Math.ceil((arc.hi - arc.lo) / arcStep));
      for (let k = 0; k <= steps; k++) {
        const at = arc.lo + ((arc.hi - arc.lo) * k) / steps;
        const x = disc.x + Math.cos(at) * disc.r;
        const z = disc.z + Math.sin(at) * disc.r;
        points.push({ angle: ((Math.atan2(z, x) % TAU) + TAU) % TAU, radius: Math.hypot(x, z) });
      }
    }
  });
  points.sort((a, b) => a.angle - b.angle);

  const kept: LobePoint[] = [];
  for (const point of points) {
    const last = kept[kept.length - 1];
    if (last && point.angle - last.angle < ANGLE_MERGE) {
      // Two samples at one bearing: an arc's endpoint and the neighbouring
      // disc's copy of the same crossing, to within the arithmetic. Keep the
      // outer -- on a star-shaped union they are the same point, and taking the
      // inner one would nick the cleft.
      if (point.radius > last.radius) kept[kept.length - 1] = point;
      continue;
    }
    kept.push(point);
  }
  const first = kept[0];
  const final = kept[kept.length - 1];
  if (kept.length > 2 && first && final && TAU - final.angle + first.angle < ANGLE_MERGE) kept.pop();

  const widest = kept.reduce((wide, point) => Math.max(wide, point.radius), 0);
  const fit = widest > 0 ? radius / widest : 1;
  return kept.map((point) => ({ angle: point.angle, radius: point.radius * fit }));
}

/** The lobed tree's authored parameters -- the knobs the brief asks to expose. */
export interface LobedShape {
  readonly kind: 'lobed';
  /** Total height, prop-local units, tip included. */
  readonly height: number;
  /** Trunk radius at the ground. The tip is a point, so this is the whole taper. */
  readonly trunkRadius: number;
  /** `radius = trunkRadius * (1 - u)^taperPower`. Above 1 it thins early. */
  readonly taperPower: number;
  /** Sides of the trunk's cross-section. */
  readonly trunkSegments: number;
  /** Rings up the trunk. What lets the wind *curve* it rather than tip it. */
  readonly trunkRings: number;
  /** How far the tip drifts off the axis, as a fraction of height. Small. */
  readonly trunkBow: number;
  /**
   * The lobe counts a slab's cluster may take -- the hash picks one per slab, so
   * repeats in the list weight it. The core is not one of them.
   *
   * Four to six is the band the shape reads in. Below it a slab is a clover;
   * above it the lobes are narrow enough that at the size a tree is drawn the
   * clefts between them close up and the outline is a disc again.
   */
  readonly lobeCounts: readonly number[];
  /**
   * Radians between samples along a boundary arc. What buys the roundness: the
   * clefts are exact whatever this is, because they are arc *endpoints*.
   */
  readonly lobeArcStep: number;
  /** Rings from a slab's centre to its rim, so the dome is a dome. */
  readonly lobeRings: number;
  /** Slabs authored. An instance draws a subset -- see {@link slabLayout}. */
  readonly slabs: number;
  /** The slab counts an instance may take; repeats in the list weight it. */
  readonly slabCounts: readonly number[];
  /** Fraction of height the lowest slab's plane sits at... */
  readonly canopyBase: number;
  /** ...and the highest, leaving the tapered tip above it. */
  readonly canopyTop: number;
  /** Radius of the widest slab, prop-local units. */
  readonly canopySpread: number;
  /** How much narrower the topmost slab is, as a fraction. */
  readonly canopyTaper: number;
  /** How far a slab's centre may sit off the trunk's axis. */
  readonly slabOffset: number;
  /** Dome rise as a fraction of the slab's *width*. The brief asks for 10-20%. */
  readonly domeRise: number;
  /** Slab thickness. Near zero: this is a sheet with a rim, not a slab of cake. */
  readonly slabThickness: number;
  /** How far a slab may swing off the axis at full instance asymmetry. */
  readonly driftMax: number;
  /** ...and how far it may lean, radians. */
  readonly leanMax: number;
  /** Drives the blobs, the slab bearings and the trunk's kinks. */
  readonly seed: number;
}

/**
 * The lobed canopy tree as the world grows it (spec 077): a pole that tapers to
 * a point, carrying a scatter of flat lobed slabs up its top half.
 *
 * Slender is the whole read -- 4.6 units of radius under 136 of height, against
 * the conifers' 6 under 128 -- and it only survives because the trunk is round
 * and tapered rather than a box: a 9-unit box at this height reads as a post,
 * and the same volume spun into a cone reads as a stem.
 *
 * The canopy starts at half the height, which is a much longer bare trunk than
 * either conifer's, and tops out at 0.88 so the last stretch of taper shows
 * above the foliage as a point. `canopySpread` is set wide for the reason
 * `FIR_TIERS` in `props.ts` is: the scatter cannot pack trunks closer than a
 * body's width, so a canopy only closes over a stand if it reaches across that
 * gap.
 *
 * It lives here rather than beside the conifers because it is the *input* to
 * everything else in this file, and a test that had to restate it to check it
 * would only ever be checking its own copy.
 */
export const LOBED: LobedShape = {
  kind: 'lobed',
  height: 136,
  trunkRadius: 4.6,
  // Slightly over 1, so the taper is a shade concave and the trunk is thin for
  // most of its length rather than only near the tip.
  taperPower: 1.15,
  trunkSegments: 7,
  // Enough rings that the wind's quadratic bend draws a curve up the trunk. Two
  // rings would give the same lean as a straight stick tipped over.
  trunkRings: 8,
  trunkBow: 0.035,
  lobeCounts: [4, 5, 5, 6],
  lobeArcStep: (20 * Math.PI) / 180,
  lobeRings: 2,
  slabs: 5,
  slabCounts: [3, 4, 4, 5],
  canopyBase: 0.5,
  canopyTop: 0.88,
  canopySpread: 44,
  canopyTaper: 0.46,
  slabOffset: 13,
  // The middle of the 10-20% the brief asks for, measured against slab width.
  domeRise: 0.15,
  slabThickness: 2.2,
  driftMax: 6,
  leanMax: 0.12,
  seed: 0x10bed7,
};

/**
 * How far a slab's surface stands above the plane it is nominally placed at:
 * its dome, which is highest at the centre and nothing at the rim.
 */
export function slabRise(slab: SlabSpec): number {
  return slab.rise;
}

/** ...and how far it hangs below it, which is its thickness and nothing else. */
export function slabDrop(shape: LobedShape): number {
  return shape.slabThickness;
}

/** One canopy slab, placed and shaped. */
export interface SlabSpec {
  /** Index from the bottom of the cluster. Also the tone and the wind lag. */
  readonly index: number;
  /** Height of the slab's plane, prop-local. */
  readonly y: number;
  readonly radius: number;
  readonly offsetX: number;
  readonly offsetZ: number;
  /** How far the dome's centre stands above its rim. */
  readonly rise: number;
  /** The closed polygon the slab's mesh is built from, in order of bearing. */
  readonly outline: readonly LobePoint[];
  /**
   * The slab count at or above which this slab is grown.
   *
   * The bottom slab, the middle one and the **top** one are grown by every
   * instance; the count only fills in between them. A scheme that simply dropped
   * the top slabs would make a 3-slab tree a tall bare whip with a clump of
   * foliage halfway up, because the trunk's height is one geometry shared by
   * every instance and cannot shorten with the canopy.
   */
  readonly grownAt: number;
}

/**
 * Which slabs every instance grows, by index, for a shape with `slabs` of them.
 *
 * The rule is stated as a table rather than derived, because the property that
 * matters is arithmetic on the *counts* -- exactly `n` slabs are grown at count
 * `n`, and index `slabs - 1` is always among them -- and a clever derivation
 * that got it wrong would fail as a canopy that quietly loses its crown.
 */
function grownAtFor(index: number, slabs: number, counts: readonly number[]): number {
  const lowest = Math.min(...counts);
  const top = slabs - 1;
  const middle = Math.floor(top / 2);
  if (index === 0 || index === top || index === middle) return lowest;
  // The rest fill in one at a time, in order, as the count climbs.
  const rest = [...Array(slabs).keys()].filter((i) => i !== 0 && i !== top && i !== middle);
  return lowest + 1 + rest.indexOf(index);
}

/**
 * Where a lobed tree's canopy slabs sit.
 *
 * Slabs climb the upper trunk, shrinking as they go, each offset off the axis in
 * its own direction so the cluster reads as a scatter of leaf masses rather than
 * as a stack of plates on a skewer. The offsets are spread by the golden angle
 * before being jittered, which is what stops two consecutive slabs sliding the
 * same way and leaving one side of the trunk bare all the way up.
 */
export function slabLayout(shape: LobedShape): SlabSpec[] {
  const out: SlabSpec[] = [];
  const last = Math.max(1, shape.slabs - 1);
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < shape.slabs; i++) {
    const t = i / last;
    const radius = shape.canopySpread * (1 - shape.canopyTaper * t);
    const lobes =
      shape.lobeCounts[Math.floor(hashUnit2(i, shape.seed, HASH_LOBE_COUNT) * shape.lobeCounts.length) %
        shape.lobeCounts.length] ?? 5;
    const bearing = i * golden + (hashUnit2(i, shape.seed, HASH_SLAB_BEARING) * 2 - 1) * 0.8;
    const reach = shape.slabOffset * (0.35 + 0.65 * hashUnit2(i, shape.seed, HASH_SLAB_REACH));
    out.push({
      index: i,
      y: shape.height * (shape.canopyBase + (shape.canopyTop - shape.canopyBase) * t),
      radius,
      offsetX: Math.cos(bearing) * reach,
      offsetZ: Math.sin(bearing) * reach,
      // Against the slab's *width*, which is what the brief measures it against.
      rise: shape.domeRise * 2 * radius,
      outline: lobeOutline(shape.seed + i * 7919, radius, lobes, shape.lobeArcStep),
      grownAt: grownAtFor(i, shape.slabs, shape.slabCounts),
    });
  }
  return out;
}

/** One cross-section of the trunk: where its centre is and how thick it is there. */
export interface TrunkRing {
  readonly y: number;
  readonly radius: number;
  /** Centre offset, prop-local. Both zero at the base, by construction. */
  readonly x: number;
  readonly z: number;
}

/**
 * The trunk, ring by ring, from the ground to a single point at the top.
 *
 * `radius` reaches exactly 0 on the last ring: the tip is a vertex, not a cap,
 * so nothing has to be buried inside a frond the way a conifer's flat-topped
 * column does (`buriedTrunkHeight` in `props.ts` exists entirely for that).
 *
 * The lean is deliberately slight and deliberately *smooth*: a bow that grows as
 * `u^1.7` so the base stays planted and the drift accumulates up the length,
 * plus a kink per ring under a fifth of the local radius. Any more and it reads
 * as a broken tree rather than as one that grew.
 */
export function trunkProfile(shape: LobedShape): TrunkRing[] {
  const rings: TrunkRing[] = [];
  const bearing = hashUnit2(0, shape.seed, HASH_TRUNK_BOW) * Math.PI * 2;
  const bowX = Math.cos(bearing);
  const bowZ = Math.sin(bearing);
  for (let i = 0; i <= shape.trunkRings; i++) {
    const u = i / shape.trunkRings;
    const radius = i === shape.trunkRings ? 0 : shape.trunkRadius * Math.pow(1 - u, shape.taperPower);
    const bow = shape.trunkBow * shape.height * Math.pow(u, 1.7);
    // Zero at the base, so the trunk still meets the ground where it is planted.
    const kink = u === 0 ? 0 : (hashUnit2(i, shape.seed, HASH_TRUNK_KINK) * 2 - 1) * shape.trunkRadius * 0.18;
    rings.push({
      y: shape.height * u,
      // The kink runs across the bow rather than along it, so it reads as
      // irregularity in the growth and never as the bow simply stuttering.
      x: bowX * bow - bowZ * kink,
      z: bowZ * bow + bowX * kink,
      radius,
    });
  }
  return rings;
}

/** The widest the canopy reaches from the trunk's axis, prop-local units. */
export function lobedCrownRadius(shape: LobedShape): number {
  return slabLayout(shape).reduce(
    (wide, slab) => Math.max(wide, Math.hypot(slab.offsetX, slab.offsetZ) + slab.radius),
    0,
  );
}
