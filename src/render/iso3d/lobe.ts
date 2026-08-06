import { hashUnit2 } from '../../shared/hash.js';

/**
 * The lobed canopy tree's shape, as arithmetic (spec 076).
 *
 * Pure -- no three.js, no DOM -- for the same reason `wind.ts` is: the numbers
 * here are the art direction, and a silhouette that decides how a whole forest
 * reads should be checkable in Node rather than by squinting at a frame. What
 * lives here is *where the vertices go*; `props.ts` turns that into buffers.
 *
* ## Why the outline is an irregular n-gon
 *
 * The brief asks for a bumpy, scalloped edge -- an irregular blob rather than a
 * clean ellipse. A perturbed radius (`r(theta) = R * (1 + a*sin(k*theta))`)
 * gives a wobble, not a scallop: its notches are as smooth as its bulges, and it
 * has a *period*, which the eye finds immediately and reads as a machined part.
 *
 * So the outline is a polygon of seven to fourteen vertices whose radii
 * alternate between a **far** band and a **near** band, placed at **uneven**
 * angular intervals and joined by straight edges. Three properties, each doing
 * one job:
 *
 * - The **alternation** is where the notches come from, and they come for free
 *   and at full depth: a near vertex between two far ones is a notch cutting a
 *   third of the radius, with nothing to compute and nothing to sample.
 * - The **uneven angles** are what stop it reading as a gear. Evenly spaced, a
 *   far/near alternation is exactly a cog, and no amount of radius jitter hides
 *   the regular pitch; it is the spacing the eye locks onto, not the radii.
 * - **Straight edges and no smoothing**, so every vertex is a corner. A corner
 *   is the whole point -- it is what says "leaf mass" rather than "squashed
 *   circle" -- and the previous construction here spent most of its complexity
 *   on not losing the corners it had.
 *
 * This replaces a union of overlapping circles, which produced the right shape
 * and paid a great deal for it: circle-circle crossings solved algebraically so
 * the corners survived sampling, and a star-shape condition on where every
 * circle was allowed to sit so that the union stayed a single interval along
 * each ray. A polygon defined directly as (bearing, radius) with the bearings
 * increasing is star-shaped by construction and simple by construction, so both
 * of those problems stop existing rather than being solved.
 *
 * The vertex count is even. Odd, the alternation cannot close: the last vertex
 * and the first are neighbours, so one adjacent pair ends up in the same band
 * and the shape carries a single long flat edge where a notch should be.
 */

const TAU = Math.PI * 2;

/** Seeds for the independent hashed channels, so one wobble does not imply another. */
const HASH_LOBE_GAP = 0x10be01;
const HASH_LOBE_RADIUS = 0x10be02;
const HASH_LOBE_START = 0x10be03;
const HASH_LOBE_COUNT = 0x10be08;
const HASH_SLAB_BEARING = 0x10be04;
const HASH_SLAB_REACH = 0x10be05;
const HASH_TRUNK_KINK = 0x10be06;
const HASH_TRUNK_BOW = 0x10be07;

/** One vertex of a slab's outline: which way it lies, and how far out it reaches. */
export interface LobePoint {
  readonly angle: number;
  readonly radius: number;
}

/**
 * The angular gap between one vertex and the next, before the gaps are
 * normalised to close the circle -- so these are ratios, not radians.
 *
 * The spread is the single number that decides whether the slab reads as
 * hand-drawn or as machined, and it is bounded at *both* ends. Too narrow and
 * the vertices are evenly spaced, which with an alternating radius is a cog.
 * Too wide and the smallest gap becomes a sliver: two vertices a couple of
 * degrees apart, which is a wasted triangle at best and a shading artefact at
 * worst. From 0.55 to 1.45 the widest gap is not quite three times the
 * narrowest, and at fourteen vertices the narrowest is still 14 degrees.
 */
const GAP_MIN = 0.55;
const GAP_SPAN = 0.9;

/**
 * The two radius bands, as fractions of the slab's radius.
 *
 * The gap between them *is* the notch depth, and it is the number the whole
 * shape exists to produce: between 0.11 and 0.38 of the radius, around a quarter
 * on average. Each band has width of its own as well, so the lobes are not all
 * the same length as each other -- the brief's "randomized radius", where a band
 * with no width would give a perfectly regular star.
 *
 * Deeper is not better, and this is the second setting rather than the first.
 * At a near band down around 0.46 the notches cut a third of the radius and the
 * slab stops reading as a leaf mass with bumps on it and starts reading as a
 * holly leaf -- a spike between every pair of clefts. What makes a notch read as
 * a notch is its depth against the *angular width of the lobe beside it*, and at
 * ten to fourteen corners those lobes are only thirty or forty degrees wide.
 */
const FAR_MIN = 0.87;
const FAR_SPAN = 0.13;
const NEAR_MIN = 0.62;
const NEAR_SPAN = 0.14;

/**
 * One slab's silhouette: an irregular n-gon of `vertices` corners, normalised so
 * its widest reaches exactly `radius`.
 *
 * The count is rounded **down to even**, because the alternation has to close
 * around the ring: at an odd count the last vertex and the first are both in the
 * same band, and the slab carries one long flat edge where a notch belongs.
 *
 * Normalising against the widest vertex is what lets `crownRadius` be a fact
 * about the mesh rather than an estimate -- and it has to be done afterwards,
 * because clamping each vertex to `radius` as it was drawn would pile the whole
 * far band onto the limit and flatten the lobes to one length.
 */
export function lobeOutline(seed: number, radius: number, vertices: number): LobePoint[] {
  const count = Math.max(4, vertices - (vertices % 2));

  // Drawn as ratios and then scaled to sum to a full turn, so the gaps can be as
  // uneven as they like and the polygon still closes exactly. Distributing a
  // fixed step and jittering each vertex off it cannot promise that: the last
  // gap is whatever is left over, and it is the one that comes out a sliver.
  const gaps: number[] = [];
  let total = 0;
  for (let i = 0; i < count; i++) {
    const gap = GAP_MIN + GAP_SPAN * hashUnit2(i, seed, HASH_LOBE_GAP);
    gaps.push(gap);
    total += gap;
  }

  const points: LobePoint[] = [];
  // Where the first vertex sits. Without it every slab in the world would have a
  // corner pointing along its own local +X, which the slabs' shared drift and
  // lean would then line up into a pattern across a whole tree.
  let angle = hashUnit2(count, seed, HASH_LOBE_START) * TAU;
  let widest = 0;
  for (let i = 0; i < count; i++) {
    const far = i % 2 === 0;
    const u = hashUnit2(i, seed, HASH_LOBE_RADIUS);
    const reach = radius * (far ? FAR_MIN + FAR_SPAN * u : NEAR_MIN + NEAR_SPAN * u);
    widest = Math.max(widest, reach);
    points.push({ angle, radius: reach });
    angle += ((gaps[i] as number) / total) * TAU;
  }

  const fit = widest > 0 ? radius / widest : 1;
  return points.map((point) => ({ angle: point.angle, radius: point.radius * fit }));
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
   * The corner counts a slab's outline may take -- the hash picks one per slab,
   * so repeats in the list weight it.
   *
   * Seven to fourteen is the band the shape reads in. Below it the slab is a
   * crude star with three or four points; above it the notches get narrow enough
   * that at the size a tree is drawn they close up into a rim again. Every entry
   * is even, because the far/near alternation has to close around the ring.
   */
  readonly lobeVertices: readonly number[];
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
  /**
   * Slab thickness. Near zero: this is a sheet with a rim, not a slab of cake.
   *
   * Exactly zero means something stronger -- a *single* sheet, with no underside
   * and no rim at all. Two surfaces placed zero apart are not a very thin slab,
   * they are two coincident sheets Z-fighting over every pixel they cover.
   */
  readonly slabThickness: number;
  /**
   * Radians the slab is tipped toward the camera's bearing.
   *
   * Applied in world space when the instance is placed, never baked into the
   * geometry: the prop carries a random yaw of its own, and a tilt baked into
   * the mesh would be spun to a different direction on every tree.
   *
   * Static, and knowingly so. The camera's azimuth is a slider, so this faces
   * the viewer at the default bearing and not at all of them -- a slab that
   * tracked the camera would be a billboard, which is the thing this species is
   * built not to be.
   */
  readonly slabPitch: number;
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
  lobeVertices: [8, 10, 10, 12],
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
  slabPitch: 0,
  driftMax: 6,
  leanMax: 0.12,
  seed: 0x10bed7,
};

/** How far toward the camera the flat variant's leaves are tipped. */
const FLAT_PITCH = (30 * Math.PI) / 180;

/**
 * The same tree with flat leaves: no dome, no thickness, tipped 30 degrees
 * toward the camera.
 *
 * Every proportion is {@link LOBED}'s -- the same trunk, the same slab heights,
 * the same spread and taper -- because the two are meant to read as one plant
 * built two ways, not as two plants. Only the leaves differ, which is the whole
 * point of it being a variant.
 *
 * `lobeRings` drops to 1 with the dome. Interior rings exist to subdivide a
 * curve, and a plane has no curve to subdivide, so a flat slab is one fan of
 * `lobeSegments` triangles and nothing else -- an eighth of the domed one's
 * geometry for a species that is on a quarter of the world's trees.
 *
 * The seed is its own, so the two stand side by side with different outlines
 * rather than as the same blob at two thicknesses.
 */
export const LOBED_FLAT: LobedShape = {
  ...LOBED,
  domeRise: 0,
  slabThickness: 0,
  lobeRings: 1,
  slabPitch: FLAT_PITCH,
  seed: 0xf1a7ee,
};

/** Every shape built the lobed way, for the callers that must cover all of them. */
export const LOBED_SHAPES = [LOBED, LOBED_FLAT] as const;

/**
 * How far a slab's surface stands above the plane it is nominally placed at.
 *
 * Not the dome alone: a pitched slab lifts its upwind rim by `radius * sin`, and
 * for the flat variant that is the *only* thing it has. An upper bound rather
 * than the exact maximum -- the two terms peak at different points of the disc,
 * so adding them over-counts slightly, and over-counting is the safe direction
 * for everything that reads this.
 */
export function slabRise(slab: SlabSpec, shape: LobedShape): number {
  return slab.rise + slab.radius * Math.sin(shape.slabPitch);
}

/** ...and how far it hangs below it: its thickness, plus the pitched rim again. */
export function slabDrop(slab: SlabSpec, shape: LobedShape): number {
  return shape.slabThickness + slab.radius * Math.sin(shape.slabPitch);
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
    const corners =
      shape.lobeVertices[Math.floor(hashUnit2(i, shape.seed, HASH_LOBE_COUNT) * shape.lobeVertices.length) %
        shape.lobeVertices.length] ?? 10;
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
      outline: lobeOutline(shape.seed + i * 7919, radius, corners),
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
