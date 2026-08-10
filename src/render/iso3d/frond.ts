import { hashUnit2 } from '../../shared/hash.js';

/**
 * The conifer frond's hem, as arithmetic (spec 121).
 *
 * Pure -- no three.js, no DOM -- for the reason `lobe.ts` is: the outline is the
 * art direction, and a silhouette that decides how a whole forest reads should
 * be checkable in Node rather than by squinting at a frame. What lives here is
 * *where the hem's vertices go*; `props.ts` turns that into buffers.
 *
 * ## Every vertex is a point on the cone
 *
 * A frond is not a new solid. It is the seven-sided cone the fir and the pine
 * have always been, with its lower edge cut away: each rim vertex sits **on the
 * cone's surface**, at its own height, so its radius follows from that height
 * and nothing else --
 *
 *     radius = R * (1 - lift)
 *
 * A vertex that is lifted is pulled in for free, because that is what a cone
 * does. Which is the whole reason the hem is described as *lifts* rather than as
 * radii: three properties that would otherwise each need a tolerance and a test
 * to keep true instead cannot be made false by tuning the numbers below.
 *
 * - **The frond stays inside the cone it replaces.** Every vertex is on that
 *   surface and every triangle is a chord of it. So the crown radius, the
 *   batches' bounding spheres and the canopy-overlap reasoning are all still
 *   true of it.
 * - **The trunk is covered exactly as well as before, above the hem.** A
 *   horizontal slice above the hem crosses every edge from the apex to a rim
 *   vertex, and an apex-to-surface edge lies *on* the cone -- so the slice is a
 *   polygon at the full cone radius on the rim's own bearings, and its inradius
 *   is `R (1-u) cos(halfGap)`. Hold every gap to the tip step or under
 *   ({@link frondGap}, asserted in the tests) and that is the cone's own
 *   `CONE_COVER`, unchanged. `trunkHeight` does not move for a cutout.
 * - **A crown still reaches its species' width.** One tip is always at zero
 *   lift, because the lifts are normalized to their own minimum.
 *
 * Below the hem there are real gaps, and that is the point -- the trunk and the
 * tier beneath show through the bite. `props.ts` answers `-Infinity` for cover
 * below a tier's hem rather than letting the derivation quietly assume the frond
 * is solid all the way round down there.
 *
 * ## Why a cleft is a vertex of its own and a tip is not enough
 *
 * Pulling one tip of seven inward drags both the faces beside it: a 51-degree
 * sector goes shallow and the frond reads as lumpy rather than as bitten. A cut
 * needs its own vertex *between* two tips, lifted well above both, so the two
 * short faces either side of it are steep and the gap has an edge. That is what
 * a fir's frond actually does, and it costs two triangles.
 */

const TAU = Math.PI * 2;

/** Independent hashed channels, so one wobble never implies another. */
const HASH_TIP_LIFT = 0xf20d01;
const HASH_CLEFT_ROLL = 0xf20d02;
const HASH_CLEFT_LIFT = 0xf20d03;
const HASH_CLEFT_BEARING = 0xf20d04;

/**
 * The most a tip may ride up the cone, as a fraction of the tier's height.
 *
 * Small on purpose: this is the *unevenness* of the hem, not the bite. At 0.16
 * the widest tip of a frond stands about a sixth further out than the shyest,
 * which breaks the seven-fold symmetry at a glance and takes nothing off the
 * canopy's mass.
 */
const TIP_LIFT_MAX = 0.16;

/** How often a sector carries a cleft, before the no-neighbours rule thins them. */
const CLEFT_CHANCE = 0.5;

/**
 * How far a cleft cuts up into the frond, as a fraction of the tier's height.
 *
 * Comfortably above {@link TIP_LIFT_MAX}, which is what makes "a cleft is higher
 * than both the tips it separates" true by construction rather than by luck --
 * a cleft at tip height is not a cut, it is an eighth tip.
 */
const CLEFT_LIFT_MIN = 0.2;
const CLEFT_LIFT_SPAN = 0.1;

/**
 * Where in its sector a cleft sits, as a fraction of the step. Kept off the
 * midpoint so the two faces it makes are of different widths -- a cleft exactly
 * halfway reads as a symmetric notch, which is the regularity being escaped.
 */
const CLEFT_BEARING_MIN = 0.34;
const CLEFT_BEARING_SPAN = 0.32;

/** One vertex of a frond's hem. */
export interface FrondPoint {
  /** Bearing, radians. Strictly increasing round the rim, within one turn. */
  readonly angle: number;
  /** How far up the cone this vertex sits, as a fraction of the tier's height. */
  readonly lift: number;
  /** A cut between two tips, rather than a tip. */
  readonly cleft: boolean;
}

/**
 * One frond's hem: `segments` tips at the cone's own bearings, with a cleft cut
 * into some of the sectors between them.
 *
 * Pure in `(seed, segments)`, so a species' tier is the same frond every time it
 * is built -- the geometry is shared across every instance in the world, and the
 * variety between two trees comes from the per-instance spin instead (spec 121).
 */
export function frondRim(seed: number, segments: number): FrondPoint[] {
  const step = TAU / segments;

  // Normalized to the shyest tip, so one tip of every frond sits at zero lift
  // and the crown reaches the radius its species table says it does.
  const raw: number[] = [];
  for (let i = 0; i < segments; i++) raw.push(hashUnit2(i, seed, HASH_TIP_LIFT) * TIP_LIFT_MAX);
  const shyest = Math.min(...raw);
  const lifts = raw.map((lift) => lift - shyest);

  // Which sectors are bitten. Never two in a row -- adjacent clefts leave the
  // tip between them stranded on a spike, and a run of them is a saw blade
  // rather than a frond that something has been taken out of.
  const rolls: number[] = [];
  for (let i = 0; i < segments; i++) rolls.push(hashUnit2(i, seed, HASH_CLEFT_ROLL));
  const bitten = rolls.map((roll) => roll < CLEFT_CHANCE);
  for (let i = 0; i < segments; i++) {
    const before = bitten[(i + segments - 1) % segments] ?? false;
    if (before && bitten[i]) bitten[i] = false;
  }
  // A frond with no cleft at all is the cone this replaces, so the quietest
  // sector takes one rather than the tree coming out unbitten.
  if (!bitten.some(Boolean)) {
    let quietest = 0;
    for (let i = 1; i < segments; i++) if ((rolls[i] ?? 1) < (rolls[quietest] ?? 1)) quietest = i;
    bitten[quietest] = true;
  }

  const rim: FrondPoint[] = [];
  for (let i = 0; i < segments; i++) {
    rim.push({ angle: i * step, lift: lifts[i] ?? 0, cleft: false });
    if (!bitten[i]) continue;
    const where = CLEFT_BEARING_MIN + hashUnit2(i, seed, HASH_CLEFT_BEARING) * CLEFT_BEARING_SPAN;
    rim.push({
      angle: (i + where) * step,
      lift: CLEFT_LIFT_MIN + hashUnit2(i, seed, HASH_CLEFT_LIFT) * CLEFT_LIFT_SPAN,
      cleft: true,
    });
  }
  return rim;
}

/**
 * The height, as a fraction of the tier's, below which the frond has gaps in it.
 *
 * The one number the trunk's derivation needs from here: above it the frond
 * closes all the way round and covers what it always did, below it there is a
 * bearing where there is nothing at all.
 */
export function frondHem(rim: readonly FrondPoint[]): number {
  return rim.reduce((most, point) => Math.max(most, point.lift), 0);
}

/**
 * The widest bearing gap between neighbouring vertices, radians -- the wrap from
 * the last back to the first included.
 *
 * What the cover claim rests on: a slice above the hem is a polygon at the full
 * cone radius on these bearings, so its inradius is `R (1-u) cos(gap/2)`, and
 * the cone's own `CONE_COVER` survives only while this stays at the tip step or
 * under. A cleft adds vertices *within* a sector and so can only shrink it.
 */
export function frondGap(rim: readonly FrondPoint[]): number {
  let widest = 0;
  for (let i = 0; i < rim.length; i++) {
    const here = rim[i]?.angle ?? 0;
    const next = rim[(i + 1) % rim.length]?.angle ?? 0;
    widest = Math.max(widest, i + 1 === rim.length ? next + TAU - here : next - here);
  }
  return widest;
}
