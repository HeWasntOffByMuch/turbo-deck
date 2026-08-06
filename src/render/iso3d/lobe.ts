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
 * trick that makes that cheap is keeping the union **star-shaped about the
 * origin**: along any ray from the centre the union is then one unbroken
 * interval, so its boundary is simply the furthest of the individual circles'
 * boundaries -- one `max` over a closed form, with no marching squares and no
 * polygon clipping, and the corners fall out for free where two circles cross.
 *
 * ## How the circles are allowed to sit
 *
 * A slab is a **core circle at the origin plus a ring of lobes** around it, and
 * the star-shape condition on each lobe is
 *
 *     |c|^2 <= coreRadius^2 + r^2
 *
 * which says: the furthest along a ray that the ray can *enter* this lobe --
 * `sqrt(|c|^2 - r^2)`, the tangent case, and imaginary when the origin is inside
 * it -- is still no further out than the core, so the core has already covered
 * the gap and the ray never leaves the shape and re-enters it.
 *
 * The obvious stricter rule, "every circle contains the origin", is what this
 * replaces, and the difference is the whole look. A circle containing the origin
 * spans more than half the compass from it, so neighbouring circles overlap
 * enormously and cross each other close to the rim: the scallops come out about
 * 6% of the radius deep, which at the size a tree is drawn is nothing, and the
 * silhouette reads as the clean ellipse the brief rules out. Lobes held only to
 * the condition above sit right out at the rim, and their notches cut about a
 * quarter of the radius.
 */

/** One circle of a slab's silhouette, in the slab's own plane. */
export interface LobeBlob {
  readonly x: number;
  readonly z: number;
  readonly r: number;
}

const TAU = Math.PI * 2;

/** One vertex of a slab's outline: which way it lies, and how far out it reaches. */
export interface LobePoint {
  readonly angle: number;
  readonly radius: number;
}

/**
 * How far the union's boundary is from the origin along one ray.
 *
 * Exact, given the star-shape condition {@link lobeBlobs} places the circles
 * under: the ray `t * d` meets a circle of centre `c` and radius `r` at
 * `t = c.d +- sqrt(r^2 - |c|^2 + (c.d)^2)`, and the union's boundary is the
 * largest of the far roots. A ray that misses a circle has a negative
 * discriminant and skips it; one whose two roots are both behind the origin
 * yields a negative reach, which the `max` discards -- the core is always in
 * front, so the answer is never that.
 */
export function lobeReach(blobs: readonly LobeBlob[], angle: number): number {
  const dx = Math.cos(angle);
  const dz = Math.sin(angle);
  let reach = 0;
  for (const blob of blobs) {
    const along = blob.x * dx + blob.z * dz;
    const disc = blob.r * blob.r - (blob.x * blob.x + blob.z * blob.z) + along * along;
    if (disc <= 0) continue;
    reach = Math.max(reach, along + Math.sqrt(disc));
  }
  return reach;
}

/** Angles nearer than this are one vertex, not two: no sliver triangles. */
const ANGLE_MERGE = 2e-3;
/** Slack when asking whether a crossing point is buried inside a third circle. */
const BURIED = 1e-9;

/**
 * The bearings at which the union's boundary has a **corner**.
 *
 * These are the whole point of the construction and the easiest thing in it to
 * throw away. Where two circles cross, the boundary switches from one arc to the
 * other and its tangent jumps -- a notch, and a row of notches is what the word
 * "scalloped" means. But a corner is a single point, so an outline sampled at
 * fixed angular steps essentially never lands on one: every notch gets cut
 * across by a chord and the silhouette comes back rounded. That is a union of
 * circles rendered as the ellipse it was specifically not supposed to be.
 *
 * So the crossings are solved for rather than sampled at. Two circles meet where
 * `|p - cA| = rA` and `|p - cB| = rB`, which is the standard two-point solution
 * below; the pair is on the *union's* boundary only if no third circle has
 * swallowed it.
 */
export function lobeCusps(blobs: readonly LobeBlob[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < blobs.length; i++) {
    for (let k = i + 1; k < blobs.length; k++) {
      const a = blobs[i] as LobeBlob;
      const b = blobs[k] as LobeBlob;
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const span = Math.hypot(dx, dz);
      // Concentric, disjoint, or one wholly inside the other: no crossing, and
      // in the last case the inner circle contributes no boundary at all.
      if (span === 0 || span > a.r + b.r || span < Math.abs(a.r - b.r)) continue;
      const along = (span * span + a.r * a.r - b.r * b.r) / (2 * span);
      const across = a.r * a.r - along * along;
      if (across <= 0) continue;
      const h = Math.sqrt(across);
      const ux = dx / span;
      const uz = dz / span;
      const mx = a.x + ux * along;
      const mz = a.z + uz * along;
      for (const side of [1, -1]) {
        const px = mx - uz * h * side;
        const pz = mz + ux * h * side;
        let onEdge = true;
        for (let j = 0; j < blobs.length && onEdge; j++) {
          if (j === i || j === k) continue;
          const other = blobs[j] as LobeBlob;
          if (Math.hypot(px - other.x, pz - other.z) < other.r - BURIED) onEdge = false;
        }
        if (onEdge) out.push(Math.atan2(pz, px));
      }
    }
  }
  return out;
}

/**
 * The union's boundary as a closed polygon, in order of bearing.
 *
 * Three sets of vertices, and each is there for its own reason:
 *
 * - **The crossings** ({@link lobeCusps}), so every notch between two circles is
 *   a real corner of the mesh rather than a chord cutting the corner off.
 * - **Each circle's own bearing**, which is where that circle reaches furthest
 *   from the origin -- the tip of its lobe. Without it a lobe's apex is flattened
 *   in exactly the way its notches were.
 * - **`segments` even steps**, so the arcs between all that are still arcs and
 *   not long straight chords across a bulge.
 *
 * So the vertex count is not `segments`; it is however many the shape turns out
 * to need, which for a six-circle slab is around thirty.
 */
export function lobeOutline(blobs: readonly LobeBlob[], segments: number): LobePoint[] {
  const wrap = (angle: number): number => ((angle % TAU) + TAU) % TAU;
  const angles: number[] = [];
  for (let i = 0; i < segments; i++) angles.push((i / segments) * TAU);
  for (const blob of blobs) {
    if (blob.x !== 0 || blob.z !== 0) angles.push(wrap(Math.atan2(blob.z, blob.x)));
  }
  for (const cusp of lobeCusps(blobs)) angles.push(wrap(cusp));
  angles.sort((a, b) => a - b);

  const points: LobePoint[] = [];
  for (const angle of angles) {
    const last = points[points.length - 1];
    if (last && angle - last.angle < ANGLE_MERGE) continue;
    points.push({ angle, radius: lobeReach(blobs, angle) });
  }
  // The seam: the last vertex and the first are neighbours too, and two of them
  // a hair apart there is the same sliver triangle as anywhere else.
  const first = points[0];
  const final = points[points.length - 1];
  if (points.length > 2 && first && final && TAU - final.angle + first.angle < ANGLE_MERGE) points.pop();
  return points;
}

/** Seeds for the independent hashed channels, so one wobble does not imply another. */
const HASH_BLOB_ANGLE = 0x10be01;
const HASH_BLOB_RADIUS = 0x10be02;
const HASH_BLOB_OFFSET = 0x10be03;
const HASH_SLAB_BEARING = 0x10be04;
const HASH_SLAB_REACH = 0x10be05;
const HASH_TRUNK_KINK = 0x10be06;
const HASH_TRUNK_BOW = 0x10be07;

/**
 * The core circle's radius, as a fraction of the slab's own.
 *
 * It sets how deep the notches between lobes can cut, because a notch bottoms
 * out where the lobes on either side of it meet the core. Smaller and the
 * scallops bite deeper but the slab starts to read as separate leaves rather
 * than one mass; larger and it swallows the lobes back into a disc.
 */
const CORE_SHARE = 0.44;

/** Lobes around that core. Fewer and each is a bulge; more and they average out. */
const LOBES_PER_SLAB = 5;

/**
 * How much of the star-shape limit a lobe is allowed to use.
 *
 * At 1 a lobe sits exactly at the limit, where a grazing ray enters it precisely
 * at the core's edge; the margin below that is for the floating point, and for
 * the fact that a lobe right on the limit meets the core tangentially and its
 * notch degenerates into a cusp of zero width.
 */
const LOBE_REACH_MIN = 0.82;
const LOBE_REACH_SPAN = 0.17;

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
 * The circles one slab's silhouette is the union of: a core at the origin and a
 * ring of lobes around it, scaled so the outline's widest point is exactly
 * `radius`.
 *
 * Two constraints, both load-bearing. Every lobe sits within
 * {@link lobeReachLimit} of the origin, which is what keeps the union
 * star-shaped and {@link lobeOutline} exact. And the *whole set* is scaled to
 * fit `radius` afterwards rather than each circle being clamped to it, because
 * clamping is what would pull every lobe to the same size and turn the outline
 * back into a circle.
 *
 * The scale is measured against the **sampled** outline rather than against
 * `max(|c| + r)`, so the number `crownRadius` reports is the widest point of the
 * mesh that actually gets built, not of the ideal curve behind it.
 */
export function lobeBlobs(seed: number, radius: number, segments: number, count = LOBES_PER_SLAB): LobeBlob[] {
  const core = radius * CORE_SHARE;
  // The core is a blob like any other, so the outline, the crossings and the
  // normalisation below all treat it as one and nothing needs a special case.
  const raw: LobeBlob[] = [{ x: 0, z: 0, r: core }];
  for (let i = 0; i < count; i++) {
    // Spread around the circle rather than drawn freely, so no slab comes out
    // with every lobe stacked on one side and a flat back.
    const angle =
      (i / count) * Math.PI * 2 + (hashUnit2(i, seed, HASH_BLOB_ANGLE) * 2 - 1) * (Math.PI / count);
    // Varying radius, which is what the brief asks for and what stops the lobes
    // reading as a cog: the largest is nearly twice the smallest.
    const r = radius * (0.29 + 0.21 * hashUnit2(i, seed, HASH_BLOB_RADIUS));
    // ...pushed out to most of the distance the star-shape rule allows, which is
    // where the notch between two neighbours is deepest.
    const distance =
      lobeReachLimit(core, r) * (LOBE_REACH_MIN + LOBE_REACH_SPAN * hashUnit2(i, seed, HASH_BLOB_OFFSET));
    raw.push({ x: Math.cos(angle) * distance, z: Math.sin(angle) * distance, r });
  }
  const widest = Math.max(...lobeOutline(raw, segments).map((point) => point.radius));
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
  /**
   * Even steps around a slab's outline, *before* its corners are added.
   *
   * A floor on the sampling rather than the sampling itself: the crossings
   * between circles and the tip of each lobe are solved for and inserted on top,
   * so a slab ends up with rather more vertices than this and they land where
   * the shape actually turns.
   */
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
  readonly blobs: readonly LobeBlob[];
  /** The union of those blobs, as the closed polygon the mesh is built from. */
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
    const blobs = lobeBlobs(shape.seed + i * 7919, radius, shape.lobeSegments);
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
      blobs,
      outline: lobeOutline(blobs, shape.lobeSegments),
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
