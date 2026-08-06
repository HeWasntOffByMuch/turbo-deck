import { hashUnit2 } from '../../shared/hash.js';

/**
 * The lobed canopy tree's shape, as arithmetic (spec 076).
 *
 * Pure -- no three.js, no DOM -- for the same reason `wind.ts` is: the numbers
 * here are the art direction, and a silhouette that decides how a whole forest
 * reads should be checkable in Node rather than by squinting at a frame. What
 * lives here is *where the vertices go*; `props.ts` turns that into buffers.
 *
 * ## Why the outline is a union of circles and not a curve
 *
 * The brief asks for a bumpy, scalloped edge -- an irregular blob rather than a
 * clean ellipse. A perturbed radius (`r(theta) = R * (1 + a*sin(k*theta))`)
 * gives a wobble, not a scallop: it has no *cusps*, and cusps are what read as
 * "several leaf masses merged" instead of "one squashed circle".
 *
 * So the outline is the genuine union of several overlapping circles, and the
 * one trick that makes that cheap is {@link lobeBlobs} placing every circle so
 * that it **contains the slab's origin**. A union of circles all containing one
 * point is star-shaped about that point, so along any ray from it the union's
 * boundary is simply the furthest of the individual circles' boundaries -- one
 * `max` over a closed form, with no marching squares and no polygon clipping,
 * and the cusps fall out for free where two circles cross.
 */

/** One circle of a slab's silhouette, in the slab's own plane. */
export interface LobeBlob {
  readonly x: number;
  readonly z: number;
  readonly r: number;
}

/**
 * The union's boundary distance from the origin, at `segments` angles.
 *
 * Exact, given that every blob contains the origin (see {@link lobeBlobs}): the
 * ray `t * d` meets a circle of centre `c` and radius `r` at
 * `t = c.d + sqrt(r^2 - |c|^2 + (c.d)^2)`, and the union's boundary is the
 * largest of those. A blob that does *not* contain the origin has a negative
 * discriminant along some rays and is skipped there, which is exactly the case
 * this cannot represent -- hence the placement rule.
 */
export function lobeOutline(blobs: readonly LobeBlob[], segments: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < segments; i++) {
    const angle = (i / segments) * Math.PI * 2;
    const dx = Math.cos(angle);
    const dz = Math.sin(angle);
    let reach = 0;
    for (const blob of blobs) {
      const along = blob.x * dx + blob.z * dz;
      const disc = blob.r * blob.r - (blob.x * blob.x + blob.z * blob.z) + along * along;
      if (disc <= 0) continue;
      reach = Math.max(reach, along + Math.sqrt(disc));
    }
    out.push(reach);
  }
  return out;
}

/** Seeds for the independent hashed channels, so one wobble does not imply another. */
const HASH_BLOB_ANGLE = 0x10be01;
const HASH_BLOB_RADIUS = 0x10be02;
const HASH_BLOB_OFFSET = 0x10be03;
const HASH_SLAB_BEARING = 0x10be04;
const HASH_SLAB_REACH = 0x10be05;
const HASH_TRUNK_KINK = 0x10be06;
const HASH_TRUNK_BOW = 0x10be07;

/** Circles to a slab. Fewer and it is a circle; more and the scallops average out. */
const BLOBS_PER_SLAB = 6;

/**
 * The circles one slab's silhouette is the union of, sized so that the sampled
 * outline's widest point is exactly `radius`.
 *
 * Two constraints, both load-bearing. Every centre sits closer to the origin
 * than its own radius, so the union stays star-shaped and {@link lobeOutline}
 * stays exact. And the *whole set* is scaled to fit `radius` afterwards rather
 * than each circle being clamped to it, because clamping is what would pull
 * every blob to the same size and turn the outline back into a circle.
 *
 * The scale is measured against the **sampled** outline rather than against
 * `max(|c| + r)`, so the number `crownRadius` reports is the widest point of the
 * mesh that actually gets built, not of the ideal curve behind it.
 */
export function lobeBlobs(seed: number, radius: number, segments: number, count = BLOBS_PER_SLAB): LobeBlob[] {
  const raw: LobeBlob[] = [];
  for (let i = 0; i < count; i++) {
    // Spread around the circle rather than drawn freely, so no slab comes out
    // with all six blobs stacked on one side and a flat back.
    const angle =
      (i / count) * Math.PI * 2 + (hashUnit2(i, seed, HASH_BLOB_ANGLE) * 2 - 1) * (Math.PI / count);
    // Smaller circles pushed further out than a "blobby circle" would want. Both
    // ends of that trade are visible in a silhouette: bigger circles nearer the
    // middle bury each other's crossings and the outline rounds off into an
    // ellipse, which is the one thing the brief rules out.
    const r = radius * (0.42 + 0.34 * hashUnit2(i, seed, HASH_BLOB_RADIUS));
    // Strictly inside its own circle: `0.92 * r` at the very most.
    const distance = r * (0.34 + 0.58 * hashUnit2(i, seed, HASH_BLOB_OFFSET));
    raw.push({ x: Math.cos(angle) * distance, z: Math.sin(angle) * distance, r });
  }
  const widest = Math.max(...lobeOutline(raw, segments));
  const fit = widest > 0 ? radius / widest : 1;
  return raw.map((blob) => ({ x: blob.x * fit, z: blob.z * fit, r: blob.r * fit }));
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
  /** Outline samples around a slab. */
  readonly lobeSegments: number;
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
 * The lobed canopy tree as the world grows it (spec 076): a pole that tapers to
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
  lobeSegments: 18,
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
  readonly blobs: readonly LobeBlob[];
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
      blobs: lobeBlobs(shape.seed + i * 7919, radius, shape.lobeSegments),
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
