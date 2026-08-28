import * as THREE from 'three';
import { PALETTE } from './palette.js';
import { hashUnit2 } from '../../shared/hash.js';
import {
  FENCE_KINDS,
  FENCE_TILE_LENGTH,
  FIXTURE_KINDS,
  fixtureLight,
  HOUSE_PLAN,
  STRUCTURE_KINDS,
  WELL_RADIUS,
  type FenceKind,
  type FixtureKind,
  type Prop,
  type StructureKind,
} from '../../terrain/vegetation.js';
import { propRegionKey, propRegionKeysIn } from './prop-regions.js';
import { applySwayBuffers, bakeBend, disposeSway, tiltReach, type SwayInstance } from './sway.js';
import { DEFAULT_CREASE_ANGLE, weldedNormals } from './shading.js';
import { stiffness } from './wind.js';
import { frondGap, frondHem, frondRim, type FrondPoint } from './frond.js';
import {
  LOBED,
  lobedCrownRadius,
  slabDrop,
  slabLayout,
  slabRise,
  trunkProfile,
  type LobedShape,
  type SlabSpec,
} from './lobe.js';

/**
 * Batched scenery for the whole world (spec 043/045). The scatter puts a
 * thousand-odd trees and bushes across the terrain, which is what turns a
 * heightfield into a place worth walking around in -- but as individual
 * `Group`s that would be thousands of draw calls. Each part of a tree or bush
 * therefore becomes an `InstancedMesh` carrying many copies of it.
 *
 * Those instanced meshes are **bucketed by region** rather than one per part for
 * the whole world. A single world-spanning batch has a world-spanning bounding
 * sphere, so the camera can never cull any of it and every tree is submitted
 * every frame no matter where the player is -- for a world this much wider than
 * the view, that is nearly all of them wasted. Per-region batches each get a
 * tight bounding sphere, so the ones behind the camera drop out for free.
 *
 * Instancing also buys the variety cheaply. Every instance gets its own colour,
 * so foliage drifts in shade across the world and the occasional tree turns
 * autumn; and every instance gets its own *shape* within its species, because
 * the matrix that places a part can also lean it, slide it off the trunk's axis,
 * or leave it out of that tree entirely.
 */

/**
 * The batching grid (spec 195), which lives in `prop-regions.ts` since spec 211
 * so the editor's pure half can ask where a region is without importing three.
 *
 * Re-exported rather than merely imported: every existing caller asks this
 * module for a region key, and moving the file it happens to be declared in is
 * not a reason to touch them.
 */
export {
  PROP_REGION_SIZE,
  propRegionBounds,
  propRegionKey,
  propRegionKeysIn,
  propRegionSize,
  setPropRegionSize,
} from './prop-regions.js';

/** Seeds for the per-instance variation hashes, so the draws stay independent. */
const HASH_SPECIES = 0x5eed01;
const HASH_TIERS = 0x5eed02;
const HASH_ASYMMETRY = 0x5eed03;
const HASH_LEAN = 0x5eed04;
/**
 * Base seeds for a part's own jitter; the part's index is mixed in (spec 058).
 *
 * Three independent channels rather than one (spec 059), because a single hash
 * correlates every wobble a part has: the board that came out widest would also
 * always be the one leaning furthest and the palest, which reads as a pattern
 * rather than as variation.
 */
const HASH_JITTER_POS = 0x5eed05;
const HASH_JITTER_ROT = 0x5eed06;
const HASH_JITTER_SIZE = 0x5eed07;
/** A tree's own offset into the wind's clock (spec 074). */
const HASH_WIND_PHASE = 0x5eed08;
/** Which way a frond is turned on this tree (spec 121) -- its own channel, as above. */
const HASH_SPIN = 0x5eed09;

/**
 * How the three species divide the forest, as cumulative shares of the position
 * hash. The lobed tree (spec 077) is the odd one out by construction, so it is
 * held to a bit over a quarter: enough that a walk through the woods runs into
 * one every few trees, few enough that the world still reads as coniferous.
 */
const LOBED_SHARE = 0.26;
const PINE_SHARE = 0.3;

/** Every species, in the order their batches are added to a region's group. */
export const TREE_SPECIES = ['fir', 'pine', 'lobed'] as const;

export type TreeSpecies = (typeof TREE_SPECIES)[number];

/** One part of a prop: a shared geometry plus where it sits in the prop's local space. */
interface PropPart {
  readonly geometry: THREE.BufferGeometry;
  readonly offsetY: number;
  /** Local XZ offset, for the bush's off-centre second blob. */
  readonly offsetX?: number;
  readonly offsetZ?: number;
  readonly scaleY?: number;
  /** Base colour, tinted per instance. `foliage` parts also take the autumn turn. */
  readonly color: number;
  readonly foliage: boolean;
  /**
   * Which foliage tier this is, counted from the bottom. A tree only grows the
   * part if its tier count reaches it, which is how one species covers saplings
   * and full-grown spires out of the same geometry.
   */
  readonly tier?: number;
  /**
   * The tier count at or above which this part is grown, defaulting to
   * `tier + 1` -- which is the rule every conifer has always used, written out.
   *
   * It is separate from `tier` because the lobed canopy (spec 077) needs the two
   * to disagree: its slab count fills in the *middle* of the cluster and always
   * keeps the topmost slab, since the trunk is one shared geometry and cannot
   * shorten with the canopy. Dropping slabs off the top would leave a three-slab
   * tree as a bare whip with a clump of foliage halfway up it.
   */
  readonly grownAt?: number;
  /**
   * The highest tier count this part is drawn for, `grownAt` being the floor
   * (spec 122). Set with it to pick out *exactly* one count: the conifer trunks
   * are one geometry per count, and a tree draws the one that ends in the frond
   * it grew.
   */
  readonly grownUpTo?: number;
  /**
   * Which entry of the autumn ramp this part takes, defaulting to `tier`. The
   * conifers want the ramp to climb with the tier, dark base to bright crown;
   * the lobed tree wants two tones alternating and nothing else.
   */
  readonly toneIndex?: number;
  /** How far this part may slide off the trunk's axis, at full asymmetry. */
  readonly driftMax?: number;
  /** How far this part may lean over, radians, at full asymmetry. */
  readonly leanMax?: number;
  /**
   * How far this instance's own colour may drift from `color`, for parts that
   * are not foliage (foliage has its own richer ramp). Driven by the prop's
   * `tint`, so one weathered plank differs from the next.
   */
  readonly tintAmount?: number;
  /**
   * Per-instance jitter, hashed from where the prop stands (spec 058).
   *
   * The variation a *repeated* part needs. A tree gets its variety from its
   * species, its tier count and its lean; a fence tile is the same tile stamped
   * fifty times down a run, and without this a drystone wall is fifty identical
   * boxes reading as one extruded ribbon. Hashed rather than drawn, so it is
   * stable across the rebuilds a stroke causes.
   */
  readonly jitterZ?: number;
  readonly jitterYaw?: number;
  readonly jitterScaleY?: number;
  /** Slide along the prop's run. Small: it eats into a neighbour's overlap. */
  readonly jitterX?: number;
  /** Width along the run -- a board that came out a little wider than its fellows. */
  readonly jitterScaleX?: number;
  /** Lean within the prop's own plane, radians: a board off the vertical. */
  readonly jitterRoll?: number;
  /** Colour drift that is this part's alone, on top of the prop's `tint`. */
  readonly jitterTint?: number;
  /**
   * The colour this part takes when its prop asked for one flat tone (spec 061).
   *
   * Only the parts whose colour is *decorative* need one -- a board drawn from
   * four timber tones, a brick from three fired bands. A part whose colour is
   * **structural** leaves this unset and keeps its own: a picket fence's posts
   * are darker than its rails because they are a different piece of timber, not
   * because that fence happened to vary.
   */
  readonly uniformColor?: number;
  /**
   * This part leans in the wind (spec 074). Set on tree parts and nothing else:
   * the geometry carries a baked `aBend` weight and the batch gets the sway
   * patch, its two shadow materials, and a bounding sphere with room in it for
   * the lean. A part without it is drawn exactly as it was before.
   */
  readonly sway?: boolean;
  /**
   * Seconds this part reads the wind behind the trunk it hangs off (spec 077),
   * on top of the per-tree phase the whole tree already carries.
   */
  readonly swayLag?: number;
  /**
   * Extra tilt about this part's own origin, as a multiple of the trunk's bend
   * angle there. Only a flat plate needs it -- see `sway.ts`.
   */
  readonly swayTilt?: number;
  /** How far this part's geometry reaches from its own origin, for those bounds. */
  readonly swayReach?: number;
  /**
   * A full-turn spin about this part's *own* axis, radians, hashed per instance
   * (spec 121).
   *
   * What makes one shared frond look like a forest of them: the geometry is the
   * same buffer on every tree in the world and only the instance matrix differs,
   * so the variety costs nothing to draw and nothing to store.
   *
   * Applied last in the quaternion chain and so *first* in the part's own frame,
   * which is the whole difference between this and {@link jitterYaw}: the frond
   * turns under the lean rather than turning the lean with it, so a tree's tiers
   * still drift and lean as one thing while none of them line up.
   */
  readonly spinYaw?: number;
}

/**
 * The two conifers, as (radius, height, baseY) per tier.
 *
 * Both are built to leave the trunk *showing*. The tree this replaces stacked
 * three cones flush onto a 26-high trunk box the bottom cone hid outright, so a
 * whole world of forest never showed one trunk. Here the lowest tier lifts clear
 * of the ground and each tier stops short of the next, so a dark column reads
 * under the canopy and again in the gaps between the fronds -- which is what
 * makes a conifer read as a tree rather than as a green triangle.
 *
 * The crowns are also much wider than the 34 they were. The scatter cannot pack
 * trunks closer than a body's width apart without walling the world off, so the
 * canopy has to close *across* that gap rather than by crowding the trunks: at
 * the separation a saturated grove settles at, crowns this wide overlap and the
 * ones they replaced did not.
 */
const FIR_TIERS: readonly (readonly [radius: number, height: number, baseY: number])[] = [
  [44, 34, 22],
  [34, 30, 59],
  [24, 25, 92],
  [15, 20, 108],
];

/** A bare column for the lower half, then fewer, wider, floppier fronds. */
const PINE_TIERS: readonly (readonly [radius: number, height: number, baseY: number])[] = [
  [41, 32, 44],
  [30, 28, 72],
  [19, 22, 96],
];

/** Tier ramp, dark at the base to bright at the crown, however many tiers there are. */
const TIER_COLORS = [PALETTE.leafDeep, PALETTE.leafMid, PALETTE.leafBright, PALETTE.leafBright] as const;

/** A stack of fronds on a round tapered column: the fir and the pine. */
interface ConiferShape {
  readonly kind: 'conifer';
  /** Trunk radius at the ground. Its height and its taper are derived, below. */
  readonly trunkRadius: number;
  /** Sides of the trunk's cross-section. */
  readonly trunkSegments: number;
  /** Rings up the trunk. What lets the wind *curve* it rather than tip it. */
  readonly trunkRings: number;
  readonly tiers: readonly (readonly [radius: number, height: number, baseY: number])[];
  /** The tier counts an instance may take; the hash picks one, so repeats weight it. */
  readonly tierCounts: readonly number[];
  readonly driftMax: number;
  readonly leanMax: number;
  /** Drives the hem each tier is cut with (spec 121); the tier index is mixed in. */
  readonly seed: number;
}

/**
 * A species, in whichever of the two constructions it is built from (spec 077).
 *
 * The union is the point: the conifers' `tiers` table cannot describe a trunk
 * that ends in a vertex or a canopy that is a set of flat blobs, and a shape
 * general enough to describe both would describe neither clearly. The exported
 * questions below -- how tall, how bare, how wide -- are what the rest of the
 * file asks, and each of them branches once.
 */
type SpeciesShape = ConiferShape | LobedShape;

const FIR: ConiferShape = {
  kind: 'conifer',
  trunkRadius: 6,
  trunkSegments: 7,
  // Enough rings that the wind's quadratic bend draws a curve up the trunk
  // rather than tipping a straight stick, and no more: a conifer's trunk is
  // drawn a thousand times over and most of its length is behind foliage.
  trunkRings: 4,
  tiers: FIR_TIERS,
  tierCounts: [2, 3, 3, 4],
  driftMax: 5,
  leanMax: 0.1,
  seed: 0xf12,
};

/**
 * Fewer, wider, floppier fronds on a long bare trunk -- and leaning harder,
 * since a drooping frond is most of what tells the two apart at this size.
 */
const PINE: ConiferShape = {
  kind: 'conifer',
  trunkRadius: 6,
  trunkSegments: 7,
  trunkRings: 4,
  tiers: PINE_TIERS,
  tierCounts: [2, 2, 3],
  driftMax: 9,
  leanMax: 0.19,
  seed: 0x9143,
};

const SPECIES: Record<TreeSpecies, SpeciesShape> = { fir: FIR, pine: PINE, lobed: LOBED };

/** Tips on a tier's frond, and so sides on the cone it is cut from. */
const CONE_SEGMENTS = 7;
/**
 * A cone's `radius` is the circumradius of that heptagon, so over a flat face
 * the foliage only reaches this fraction of it from the axis -- and a flat face
 * is what the trunk has to hide behind.
 *
 * Still exactly this once the hem is cut (spec 121), because a frond's vertices
 * all sit *on* that cone: a horizontal slice above the hem crosses every edge
 * from the apex to a rim vertex, an apex-to-surface edge lies on the cone, and
 * so the slice is a polygon at the full cone radius on the rim's own bearings.
 * A cleft only ever adds a bearing *within* a sector, so the widest gap is the
 * heptagon's own step and this is its half-angle. {@link frondGap} is what holds
 * that true, and `frond.test.ts` asserts it.
 */
const CONE_COVER = Math.cos(Math.PI / CONE_SEGMENTS);

/** Slack on the band edges, so a cone's own base does not round its way out of it. */
const EPSILON = 1e-6;

/**
 * The hem each tier of each conifer is cut with (spec 121), built once.
 *
 * One frond per (species, tier), shared by every tree in the world: the variety
 * between two of them is the per-instance spin, not a second buffer. Keyed by
 * the species' own seed with the tier mixed in, so a tree's fronds differ from
 * each other as well as from the cone they came from.
 */
const FROND_RIMS = new Map<string, readonly FrondPoint[]>();

function tierRim(shape: ConiferShape, tier: number): readonly FrondPoint[] {
  const key = `${shape.seed},${tier}`;
  const known = FROND_RIMS.get(key);
  if (known) return known;
  const rim = frondRim(shape.seed + tier * 0x1f1f, CONE_SEGMENTS);
  // Checked here rather than trusted, for the reason `sway.ts` checks its
  // splices at module load: {@link CONE_COVER} is the half-angle of the widest
  // gap in this rim, and a rim that opened one past the heptagon's step would
  // cover the trunk *less* than the cone did while every number downstream went
  // on saying it covered exactly as much.
  if (frondGap(rim) > (2 * Math.PI) / CONE_SEGMENTS + EPSILON) {
    throw new Error(`frond rim ${key} leaves a gap wider than the tip step`);
  }
  FROND_RIMS.set(key, rim);
  return rim;
}

/** How far a tier may swing off the trunk's axis at full asymmetry. */
function tierSway(shape: ConiferShape, tier: number): { drift: number; lean: number } {
  // The higher the frond, the further it may swing: a tier down at trunk height
  // that slid sideways would tear the tree in half, a crown tip flops.
  const top = Math.max(1, shape.tiers.length - 1);
  return {
    drift: shape.driftMax * (0.35 + 0.65 * (tier / top)),
    lean: shape.leanMax * (0.4 + 0.6 * (tier / top)),
  };
}

/**
 * How deep inside one tier's cone the trunk's corner sits at height `y`, in
 * prop-local units. Negative means the trunk is poking out through the frond;
 * `-Infinity` means this tier does not reach that height at all.
 *
 * The trunk box spins with the prop and the cone does too, so their relative
 * bearing is arbitrary and it is the box's *corner* against the cone's *flat
 * face* that has to clear. The tier's own drift and lean count against it: the
 * cone leans about its own centre, which both slides the axis sideways by
 * `dy * tan(lean)` and tips the slice being cut at `y` further up the cone.
 *
 * Below the frond's hem (spec 121) the answer is `-Infinity` rather than a
 * smaller number: down there the cutouts leave *nothing at all* at some
 * bearings, and the prop is spun arbitrarily, so a tier does not hide a trunk's
 * cap there at any depth. Saying so is what keeps the trunk's height derived
 * rather than derived-from-a-solid-that-is-no-longer-solid.
 */
function tierReach(shape: ConiferShape, tier: number, y: number, asymmetry: number): number {
  const tierSpec = shape.tiers[tier];
  if (!tierSpec) return -Infinity;
  const [radius, height, baseY] = tierSpec;
  const centre = baseY + height / 2;
  const sway = tierSway(shape, tier);
  const lean = sway.lean * asymmetry;
  const dy = y - centre;
  const along = height / 2 + dy / Math.cos(lean);
  if (along < frondHem(tierRim(shape, tier)) * height - EPSILON) return -Infinity;
  if (along > height + EPSILON) return -Infinity;
  const reach = radius * (1 - Math.min(Math.max(along, 0), height) / height) * CONE_COVER;
  const offAxis = Math.abs(sway.drift * asymmetry) + Math.abs(dy * Math.tan(lean));
  return reach - offAxis;
}

/**
 * How much foliage there is to spare around a trunk that ends at `y`.
 *
 * The frond's reach less the trunk's own -- a *radius* since spec 122 and not a
 * box's half-diagonal, which is half of where the room at the top of a tall
 * trunk comes from: a round column has no corner that has to clear as well.
 */
function tierCover(shape: ConiferShape, tier: number, y: number, asymmetry: number): number {
  return tierReach(shape, tier, y, asymmetry) - coniferTrunkRadius(shape, y);
}

/** Foliage left to spare around the trunk's buried top, in prop-local units. */
const TRUNK_BURIAL = 2;

/**
 * How tall a conifer's trunk stands -- derived per *tree*, not per species
 * (spec 122), because where it ends is not a free choice and the answer is
 * different for a sapling and for a full-grown spire.
 *
 * It ends at the **hem of the topmost frond this tree grew**: the height at
 * which that frond has closed all the way round (spec 121), and so the first
 * height at which it hides what is inside it. Lower and the cap shows through a
 * cutout; higher and the trunk is climbing through a crown it has already
 * reached. What it replaces was one number per species -- the highest point the
 * tiers *every* instance grows still covered -- which stopped a four-tier fir's
 * trunk inside its second frond with two more hanging above it off nothing.
 */
function coniferTrunkHeight(shape: ConiferShape, tierCount: number): number {
  const tier = Math.max(0, Math.min(tierCount, shape.tiers.length) - 1);
  const [, height, baseY] = shape.tiers[tier] ?? [0, 0, 0];
  const hem = frondHem(tierRim(shape, tier)) * height;
  // Measured on the *leaned* frond, at the worst lean an instance can take: the
  // tier tips about its own centre, so a fixed world height sits further down
  // the cone the harder it leans, and a trunk that ended at the upright hem
  // would stand a hair proud of the hem on the trees that lean furthest.
  const centre = baseY + height / 2;
  return centre + (hem - height / 2) * Math.cos(tierSway(shape, tier).lean);
}

/** The longest trunk a species grows: the profile every shorter one is a slice of. */
function coniferTrunkSpan(shape: ConiferShape): number {
  return Math.max(...shape.tierCounts.map((count) => coniferTrunkHeight(shape, count)));
}

/**
 * How much of its base radius a trunk loses over its species' longest trunk --
 * derived from the burial, for the same reason the height is (spec 122).
 *
 * The cap has to sit inside the frond above it by {@link TRUNK_BURIAL}, and at
 * that frond's hem the room is whatever the tier table and the drift leave: the
 * pine's topmost frond reaches 13.2 from the axis there and may slide 9 of that
 * off the trunk's own axis, which leaves about a unit of trunk. So the taper is
 * solved from the tightest variant the species grows, against the *species'*
 * longest trunk rather than each variant's own -- one profile, sliced at
 * different heights, so two neighbours of different sizes are the same
 * thickness at the same height.
 *
 * Clamped into a band at both ends: under {@link TAPER_MIN} there is no visible
 * taper at all, over {@link TAPER_MAX} the trunk is a spike, and a tier table
 * that asked for more than that is asking for a frond that cannot hide a trunk
 * -- which `trunkTopCover` is what says so, rather than this quietly obliging.
 */
const TAPER_MIN = 0.35;
const TAPER_MAX = 0.85;

function coniferTrunkTaper(shape: ConiferShape): number {
  const span = coniferTrunkSpan(shape);
  let taper = TAPER_MIN;
  for (const count of new Set(shape.tierCounts)) {
    const y = coniferTrunkHeight(shape, count);
    if (y <= EPSILON) continue;
    const tier = Math.min(count, shape.tiers.length) - 1;
    // At the worst lean and drift an instance can take: both terms only grow
    // with |asymmetry|, so 1 is the case to survive.
    const room = tierReach(shape, tier, y, 1) - TRUNK_BURIAL;
    const allowed = Math.max(0, room);
    taper = Math.max(taper, (1 - allowed / shape.trunkRadius) * (span / y));
  }
  return Math.min(TAPER_MAX, taper);
}

/** Solved once per species, on first use -- adding a third conifer cannot forget it. */
const TRUNK_TAPERS = new Map<ConiferShape, number>();

function trunkTaper(shape: ConiferShape): number {
  const known = TRUNK_TAPERS.get(shape);
  if (known !== undefined) return known;
  const taper = coniferTrunkTaper(shape);
  TRUNK_TAPERS.set(shape, taper);
  return taper;
}

/** The trunk's radius at height `y`, on the one profile the species' variants share. */
function coniferTrunkRadius(shape: ConiferShape, y: number): number {
  const u = Math.min(1, Math.max(0, y / coniferTrunkSpan(shape)));
  return shape.trunkRadius * (1 - trunkTaper(shape) * u);
}

/** How tall this tree's trunk stands, in prop-local units (before scale). */
export function trunkHeight(variant: TreeVariant): number {
  const shape = SPECIES[variant.species];
  // Nothing to bury: the lobed trunk narrows to a single vertex, so it runs the
  // whole height of the tree and its "top" is a point in open air by design.
  return shape.kind === 'lobed' ? shape.height : coniferTrunkHeight(shape, variant.tierCount);
}

/**
 * How deep inside the canopy the top of this tree's trunk sits, in prop-local
 * units. Positive means the foliage hides it; negative means the trunk clips
 * out through a frond. Scale-free: the trunk, the tiers and the drift all scale
 * with the prop together, so one number answers for every size it can grow to.
 *
 * `Infinity` for the lobed tree (spec 077), and that is the honest answer rather
 * than a dodge: the question is about a solid column's flat cap hanging out
 * through a sloped cone, and a trunk that tapers to a single vertex has none.
 * The invariant is vacuous there, not satisfied by luck.
 */
export function trunkTopCover(variant: TreeVariant): number {
  const shape = SPECIES[variant.species];
  if (shape.kind === 'lobed') return Infinity;
  const y = coniferTrunkHeight(shape, variant.tierCount);
  let best = -Infinity;
  const grown = Math.min(variant.tierCount, shape.tiers.length);
  for (let tier = 0; tier < grown; tier++) {
    best = Math.max(best, tierCover(shape, tier, y, variant.asymmetry));
  }
  return best;
}

/**
 * The tier counts an instance of a species may grow -- cones for a conifer,
 * canopy slabs for the lobed tree.
 */
export function speciesTierCounts(species: TreeSpecies): readonly number[] {
  const shape = SPECIES[species];
  return shape.kind === 'lobed' ? shape.slabCounts : shape.tierCounts;
}

/**
 * A triangle sink: positions pushed in winding order, turned into a
 * non-indexed buffer with normals computed from that winding.
 *
 * Non-indexed on purpose. `flatShading` reads the face normal, and the two
 * surfaces of a canopy slab meet at its rim with opposite normals -- shared
 * vertices there would average the two into a rim that lights like neither.
 */
function meshBuilder(): {
  tri: (a: Vec3, b: Vec3, c: Vec3) => void;
  quad: (a: Vec3, b: Vec3, c: Vec3, d: Vec3) => void;
  build: () => THREE.BufferGeometry;
} {
  const positions: number[] = [];
  const tri = (a: Vec3, b: Vec3, c: Vec3): void => {
    positions.push(...a, ...b, ...c);
  };
  return {
    tri,
    quad: (a, b, c, d): void => {
      tri(a, b, c);
      tri(a, c, d);
    },
    build: (): THREE.BufferGeometry => {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geometry.computeVertexNormals();
      return geometry;
    },
  };
}

type Vec3 = readonly [number, number, number];

/**
 * The lobed tree's trunk (spec 077): a round column that tapers to a point.
 *
 * Built ring by ring from {@link trunkProfile} with its origin at the **ground**,
 * so `offsetY` is zero and the baked bend weight is just the local height over
 * the species height. The rings are what make the wind's quadratic bend draw a
 * curve rather than tip a stick: with only a base and a tip there is nothing in
 * between to lag.
 *
 * The last band is a fan to one apex vertex rather than a strip to a degenerate
 * ring, so the tip really is a single point and not a cap collapsed to zero
 * width -- the difference shows up as a speck of Z-fighting at the top of every
 * tree in the world, which is exactly the kind of thing nobody finds later.
 */
function lobedTrunkGeometry(shape: LobedShape): THREE.BufferGeometry {
  const rings = trunkProfile(shape);
  const sides = shape.trunkSegments;
  const { tri, quad, build } = meshBuilder();
  const at = (ring: number, side: number): Vec3 => {
    const r = rings[ring] as (typeof rings)[number];
    const angle = (side / sides) * Math.PI * 2;
    return [r.x + Math.cos(angle) * r.radius, r.y, r.z + Math.sin(angle) * r.radius];
  };

  const base = rings[0] as (typeof rings)[number];
  for (let side = 0; side < sides; side++) {
    const next = (side + 1) % sides;
    // The base cap, wound downward. A trunk stands on ground sampled at one
    // point, so on a slope its foot is partly in the air; an open bottom would
    // show daylight straight up the inside of the tree.
    tri([base.x, base.y, base.z], at(0, side), at(0, next));
    for (let ring = 0; ring < rings.length - 1; ring++) {
      const top = rings[ring + 1] as (typeof rings)[number];
      if (top.radius === 0) {
        tri(at(ring, side), [top.x, top.y, top.z], at(ring, next));
      } else {
        quad(at(ring, side), at(ring + 1, side), at(ring + 1, next), at(ring, next));
      }
    }
  }
  return build();
}

/**
 * One canopy slab: a domed disc of the traced outline, duplicated a hair below
 * itself and joined at the rim.
 *
 * The dome is `rise * (1 - u^2)`: highest at the centre, exactly flat at the rim
 * so neighbouring slabs meet cleanly, and mirrored on the underside, which makes
 * the top gently convex and the underside gently concave out of one profile.
 *
 * A closed shell 2.2 units thick against a 44-unit radius is 5% and reads as a
 * sheet, while keeping three things a single surface does not have: it is
 * visible from below, it casts a shadow from every orientation, and -- the one
 * that turned out to matter most -- its facets face different ways, so it takes
 * light. A truly flat slab has one normal, and one normal is one shade for ever;
 * that is what a variant built on zero thickness was removed for (spec 077).
 */
function lobedSlabGeometry(slab: SlabSpec, shape: LobedShape): THREE.BufferGeometry {
  // However many vertices the outline turned out to need -- its corners and its
  // lobe tips, not a fixed step -- rather than `shape.lobeSegments`, which is
  // only the floor those were added on top of.
  const outline = slab.outline;
  const segments = outline.length;
  const rings = shape.lobeRings;
  const { tri, quad, build } = meshBuilder();

  const dome = (u: number): number => slab.rise * (1 - u * u);
  const at = (ring: number, side: number, lower: boolean): Vec3 => {
    const u = ring / rings;
    const point = outline[side % segments];
    const reach = (point?.radius ?? 0) * u;
    const angle = point?.angle ?? 0;
    return [Math.cos(angle) * reach, dome(u) - (lower ? shape.slabThickness : 0), Math.sin(angle) * reach];
  };

  for (let side = 0; side < segments; side++) {
    // The centre fan. Every vertex of ring 0 is the same point, so it is written
    // once rather than as a ring of coincident ones.
    tri(at(0, side, false), at(1, side + 1, false), at(1, side, false));
    tri(at(0, side, true), at(1, side, true), at(1, side + 1, true));
    for (let ring = 1; ring < rings; ring++) {
      quad(at(ring, side, false), at(ring, side + 1, false), at(ring + 1, side + 1, false), at(ring + 1, side, false));
      quad(at(ring, side, true), at(ring + 1, side, true), at(ring + 1, side + 1, true), at(ring, side + 1, true));
    }
    // The rim, facing out of the slab.
    quad(at(rings, side, false), at(rings, side + 1, false), at(rings, side + 1, true), at(rings, side, true));
  }
  return build();
}

/**
 * A conifer's trunk (spec 122): a round column that thins as it climbs, up to
 * the frond it ends inside.
 *
 * Standing on its own origin like the lobed trunk, so `offsetY` is zero and the
 * baked bend weight is the local height over the species height -- which is what
 * puts the trunk and the crown above it on one continuous curve rather than each
 * running 0..1 within itself.
 *
 * The rings up its length are the difference between the wind *bending* it and
 * the wind *tipping* it: the bend is quadratic in height, so with only a foot
 * and a cap there is nothing in between to lag. The foot is capped for the
 * reason the lobed trunk's is -- a tree stands on ground sampled at one point,
 * so on a slope its foot is partly in the air and an open bottom shows daylight
 * straight up the inside of it. The top is capped because that cap is the whole
 * subject of {@link trunkTopCover}: it is buried in a frond, and it is a
 * *surface* being buried rather than an absence.
 */
function coniferTrunkGeometry(shape: ConiferShape, height: number): THREE.BufferGeometry {
  const sides = shape.trunkSegments;
  const { tri, quad, build } = meshBuilder();
  const ringY = (ring: number): number => (height * ring) / shape.trunkRings;
  const at = (ring: number, side: number): Vec3 => {
    const y = ringY(ring);
    const radius = coniferTrunkRadius(shape, y);
    const angle = (side / sides) * Math.PI * 2;
    return [Math.cos(angle) * radius, y, Math.sin(angle) * radius];
  };

  const foot: Vec3 = [0, 0, 0];
  const cap: Vec3 = [0, height, 0];
  for (let side = 0; side < sides; side++) {
    const next = (side + 1) % sides;
    tri(foot, at(0, side), at(0, next));
    for (let ring = 0; ring < shape.trunkRings; ring++) {
      quad(at(ring, side), at(ring + 1, side), at(ring + 1, next), at(ring, next));
    }
    tri(cap, at(shape.trunkRings, next), at(shape.trunkRings, side));
  }
  return build();
}

/**
 * One tier's frond: the cone it has always been, with its hem cut away
 * (spec 121).
 *
 * Built about the same origin `THREE.ConeGeometry` used -- apex at `+height/2`,
 * base plane at `-height/2` -- so every `offsetY`, every bend weight and every
 * bounding sphere in the file goes on meaning what it meant.
 *
 * Each rim vertex sits on the cone's own surface at its own height, so its
 * radius is `radius * (1 - lift)` and nothing here can put a vertex outside the
 * silhouette it replaces. The triangles are chords of that cone, which is also
 * what makes the faces between a low tip and a high cleft slant: a frond takes
 * light unevenly for the same reason it reads as bitten.
 *
 * The underside is a fan from the base plane's centre out to the same rim. It is
 * never seen from this camera -- it faces down -- but it is what the shadow pass
 * casts from and what stops the frond being a shell you can see up the inside of
 * from a hillside below.
 */
function frondGeometry(radius: number, height: number, rim: readonly FrondPoint[]): THREE.BufferGeometry {
  const { tri, build } = meshBuilder();
  const apex: Vec3 = [0, height / 2, 0];
  const foot: Vec3 = [0, -height / 2, 0];
  const at = (point: FrondPoint): Vec3 => {
    const reach = radius * (1 - point.lift);
    return [Math.cos(point.angle) * reach, -height / 2 + point.lift * height, Math.sin(point.angle) * reach];
  };

  for (let i = 0; i < rim.length; i++) {
    const here = at(rim[i] as FrondPoint);
    const next = at(rim[(i + 1) % rim.length] as FrondPoint);
    // Wound the way `lobedSlabGeometry` winds its two faces: inner vertex first,
    // then round the rim the one way for a surface facing up and out, the other
    // for one facing down.
    tri(apex, next, here);
    tri(foot, here, next);
  }
  return build();
}

/** Two tones and no more, alternating up the cluster: the brief's flat palette. */
const LOBED_TONES = [PALETTE.leafMid, PALETTE.leafBright] as const;

/**
 * How the canopy trails the trunk in the wind (spec 077).
 *
 * `tilt` is a multiple of the trunk's bend *angle* at the slab's height, and
 * the trunk's local inclination there is around three times that angle -- the
 * bend is quadratic in height, so its slope is not its value. Between 1.5 and
 * 1.9 the slabs read as hinged to a stem that is leaning, without the plate
 * flapping past what the stem is doing. The lag climbs with the slab because a
 * gust reaches the top of a tree last.
 */
const SLAB_LAG_BASE = 0.05;
const SLAB_LAG_STEP = 0.035;
const SLAB_TILT_BASE = 1.5;
const SLAB_TILT_STEP = 0.1;

/**
 * The most any canopy slab's tilt asks of a bounding sphere, at `scale`.
 *
 * Exported because it is half of what a batch's inflated sphere is made of, and
 * a test that brackets those spheres against the lean alone would pass happily
 * while the widest slab in the world swung out of frame at full wind.
 */
export function maxCanopyTiltReach(scale = 1): number {
  return slabLayout(LOBED).reduce(
    (most, slab) => Math.max(most, tiltReach(SLAB_TILT_BASE + SLAB_TILT_STEP * slab.index, slab.radius * scale)),
    0,
  );
}

function lobedParts(shape: LobedShape): PropPart[] {
  const full = shape.height;
  const parts: PropPart[] = [
    {
      geometry: lobedTrunkGeometry(shape),
      // Built standing on its own origin, so nothing to offset.
      offsetY: 0,
      color: PALETTE.trunk,
      foliage: false,
      sway: true,
    },
  ];
  slabLayout(shape).forEach((slab) => {
    // Higher slabs swing further off the axis, for the reason a conifer's upper
    // fronds do: a slab down at the first fork that slid sideways would tear the
    // canopy off the trunk, and one near the tip just nods.
    const t = slab.index / Math.max(1, shape.slabs - 1);
    parts.push({
      geometry: lobedSlabGeometry(slab, shape),
      offsetY: slab.y,
      offsetX: slab.offsetX,
      offsetZ: slab.offsetZ,
      color: LOBED_TONES[slab.index % LOBED_TONES.length] ?? PALETTE.leafMid,
      foliage: true,
      tier: slab.index,
      grownAt: slab.grownAt,
      toneIndex: slab.index % LOBED_TONES.length,
      driftMax: shape.driftMax * (0.35 + 0.65 * t),
      leanMax: shape.leanMax * (0.4 + 0.6 * t),
      sway: true,
      swayLag: SLAB_LAG_BASE + SLAB_LAG_STEP * slab.index,
      swayTilt: SLAB_TILT_BASE + SLAB_TILT_STEP * slab.index,
      swayReach: slab.radius,
    });
  });
  for (const part of parts) bakeBend(part.geometry, part.offsetY, full);
  return parts;
}

/**
 * The part tables, built once each (spec 181).
 *
 * `buildRegion` called these *per region* -- three species, the bushes and every
 * fence kind, ninety times over -- and each call built `THREE.BufferGeometry`
 * from scratch and welded it again afterwards. Measured at 6.7ms of a 32.7ms
 * region rebuild, with the weld another 5.9ms beside it.
 *
 * What made that look necessary is `applySway`, which writes instanced
 * attributes onto `mesh.geometry`: a geometry object shared between regions is
 * ninety regions swaying around whichever was built last. The answer is a
 * per-batch *shell* over these shared attributes rather than a per-region
 * rebuild of them -- see {@link shellOf}.
 */
const TREE_PARTS = new Map<TreeSpecies, PropPart[]>();
function treeParts(species: TreeSpecies): PropPart[] {
  let held = TREE_PARTS.get(species);
  if (!held) {
    held = buildTreeParts(species);
    TREE_PARTS.set(species, held);
  }
  return held;
}

function buildTreeParts(species: TreeSpecies): PropPart[] {
  const shape = SPECIES[species];
  if (shape.kind === 'lobed') return lobedParts(shape);
  // The bend weight is measured against the tallest the species reaches, not
  // against the part, so the trunk and the crown above it lie on one continuous
  // curve rather than each running 0..1 within itself.
  const full = speciesHeight(species);
  // One trunk per tier count rather than one per species (spec 122): a tree ends
  // its trunk in the frond it actually grew, and a sapling's is not a tall
  // tree's cut short -- it is the same profile, stopped lower. The counts
  // partition the trees between these batches, so a tree still draws exactly
  // one and the world draws no more trunks than it did.
  const parts: PropPart[] = [...new Set(shape.tierCounts)].map((count) => ({
    geometry: coniferTrunkGeometry(shape, coniferTrunkHeight(shape, count)),
    // Built standing on its own origin, so nothing to offset.
    offsetY: 0,
    color: PALETTE.trunk,
    foliage: false,
    sway: true,
    grownAt: count,
    grownUpTo: count,
  }));
  shape.tiers.forEach(([radius, tierHeight, baseY], tier) => {
    const sway = tierSway(shape, tier);
    parts.push({
      geometry: frondGeometry(radius, tierHeight, tierRim(shape, tier)),
      offsetY: baseY + tierHeight / 2,
      color: TIER_COLORS[Math.min(tier, TIER_COLORS.length - 1)] ?? PALETTE.leafMid,
      foliage: true,
      tier,
      driftMax: sway.drift,
      leanMax: sway.lean,
      sway: true,
      // One frond per tier, turned differently on every tree it is drawn on
      // (spec 121). A cone had nothing to turn.
      spinYaw: Math.PI,
    });
  });
  for (const part of parts) bakeBend(part.geometry, part.offsetY, full);
  return parts;
}

/** A species' trunk radius at the ground, whichever construction it is. */
function speciesTrunkRadius(species: TreeSpecies): number {
  return SPECIES[species].trunkRadius;
}

/**
 * How stiff each species is, from its trunk against its full height. Both
 * conifers carry the same 12-unit trunk today, so the two answers are within a
 * hair of each other -- the term is here because a species that grows a stouter
 * trunk should sway less for it, and that should not need a second edit here to
 * take effect. The lobed tree is the first one to collect: its trunk is thinner
 * under a taller tree, so it sways measurably more for the same gust.
 */
const SPECIES_STIFFNESS: Record<TreeSpecies, number> = {
  fir: stiffness(speciesTrunkRadius('fir'), speciesHeight('fir')),
  pine: stiffness(speciesTrunkRadius('pine'), speciesHeight('pine')),
  lobed: stiffness(speciesTrunkRadius('lobed'), speciesHeight('lobed')),
};

/**
 * Seconds either side of the shared clock a tree's own sway may sit. Small: the
 * travelling wave is what should decorrelate a grove, and a large offset would
 * dissolve the wave into noise. This only breaks the tie between two trees the
 * wave reaches at the same moment.
 */
const PHASE_SPREAD = 0.25;

let BUSH_PARTS: PropPart[] | null = null;
function bushParts(): PropPart[] {
  BUSH_PARTS ??= buildBushParts();
  return BUSH_PARTS;
}

function buildBushParts(): PropPart[] {
  return [
    { geometry: new THREE.IcosahedronGeometry(20, 0), offsetY: 14, scaleY: 0.7, color: PALETTE.bush, foliage: true },
    {
      geometry: new THREE.IcosahedronGeometry(13, 0),
      offsetX: 9,
      offsetY: 20,
      offsetZ: -4,
      scaleY: 0.7,
      color: PALETTE.bushBright,
      foliage: true,
    },
  ];
}

/**
 * One tile of fence, in the prop's local space (spec 058).
 *
 * The tile runs along local **+X**, spanning exactly `[-L/2, +L/2]` and no
 * further, where `L` is `FENCE_TILE_LENGTH`. That is the contract with
 * `fence.ts`, which lays tiles exactly `L` apart along the drag: parts drawn
 * inside that span meet their neighbours' and nothing has to know a junction
 * from an end.
 *
 * The uprights are spaced `L/3` apart and inset by half of that, so the spacing
 * carries *across* a tile boundary too -- posts at the tile edges would double
 * up at every junction and read as a stutter.
 *
 * Everything sinks a little below y=0. A tile stands upright on ground sampled
 * at its centre, so on a slope one end is above the ground it should be standing
 * on; the buried skirt is what stops daylight showing under a hillside run.
 */
const FENCE_SPAN = FENCE_TILE_LENGTH / 3;
const FENCE_SINK = 7;

function woodFenceParts(): PropPart[] {
  const half = FENCE_TILE_LENGTH / 2;
  const postHeight = 56 + FENCE_SINK;
  const picketHeight = 44 + FENCE_SINK;
  const parts: PropPart[] = [
    {
      // The post: one per tile, at the tile's leading edge, so a run gets a
      // heavier upright every L and lighter pickets between.
      geometry: new THREE.BoxGeometry(9, postHeight, 9),
      offsetX: -half,
      offsetY: postHeight / 2 - FENCE_SINK,
      color: PALETTE.post,
      foliage: false,
      tintAmount: 0.1,
    },
  ];
  for (const at of [-half + FENCE_SPAN, -half + 2 * FENCE_SPAN]) {
    parts.push({
      geometry: new THREE.BoxGeometry(6.5, picketHeight, 4),
      offsetX: at,
      offsetY: picketHeight / 2 - FENCE_SINK,
      color: PALETTE.plank,
      foliage: false,
      tintAmount: 0.12,
      // A hand-nailed picket is never quite square to the run.
      jitterYaw: 0.05,
      jitterScaleY: 0.04,
    });
  }
  // Two rails, spanning the tile end to end so they continue through a junction.
  // Deep enough to read between the pickets at the zoom the game plays at --
  // thinner and a fence is a row of unconnected stakes.
  for (const y of [16, 36]) {
    parts.push({
      geometry: new THREE.BoxGeometry(FENCE_TILE_LENGTH, 7.5, 3.5),
      offsetY: y,
      // Behind the pickets rather than through them, so the two read apart.
      offsetZ: 3.5,
      color: PALETTE.plank,
      foliage: false,
      tintAmount: 0.12,
    });
  }
  return parts;
}

/**
 * A brick wall (spec 060), the built counterpart to the rubble one.
 *
 * A mortar core spanning the tile, with brick faces standing proud of it on both
 * sides in six courses -- so the wall is solid by construction and the joints are
 * recesses between bricks rather than gaps through to the far side.
 *
 * The **top course is laid across the wall** rather than on its faces: full-depth
 * bricks, wider than the core, so what you see from above is brick and not the
 * core's grey top. A wall of face bricks alone has to be capped by something, and
 * the something should be more brick.
 *
 * **The bond carries across a tile boundary.** Even courses hold three whole
 * bricks; odd courses hold two whole bricks and a *half* at each end, so the half
 * at this tile's edge and the half at its neighbour's meet to make one brick with
 * no joint between them. Whole bricks at the edge would instead land in exactly
 * the same world space as the neighbour's and z-fight the length of the run.
 *
 * The bricks are merged into three colour bands rather than kept as a part each:
 * forty-odd parts would be forty-odd instanced meshes per region, and a brick is
 * far too small on screen to need its own instance matrix. What is worth having
 * is the batch variation, which the bands give.
 */
const BRICK_COURSES = 6;
const BRICK_PITCH = 8;
/** Three bricks to a course, so the length divides the tile exactly. */
const BRICK_RUN = FENCE_TILE_LENGTH / 3;
/**
 * The joint is wider than the bricks are proud, and deliberately so.
 *
 * The camera looks along the wall at an angle, so a joint narrower than the
 * relief is completely occluded by the brick beside it: what you see in the
 * gap is that brick's own side face, not the mortar behind. That is invisible
 * while every brick is a different tone -- the bond reads by colour instead --
 * and turns the wall into a flat slab with horizontal stripes the moment the
 * colour variety is switched off (spec 061). Wider than deep, the mortar shows
 * and the bond reads from the geometry, whatever the colours are doing.
 */
const BRICK_JOINT = 2;
const BRICK_PROUD = 1.2;
const BRICK_CORE_DEPTH = 13;
const BRICK_TONES = [PALETTE.brick, PALETTE.brickDark, PALETTE.brickPale] as const;

interface Box {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly w: number;
  readonly h: number;
  readonly d: number;
}

/**
 * Boxes merged into one buffer, wound so every face points out of its box.
 *
 * Named for the shape rather than for the brick it was written for: a hut's four
 * corner posts and a well's two uprights want the same thing a course of bricks
 * does, which is to be one batch instead of one each (spec 224).
 */
function boxesGeometry(boxes: readonly Box[]): THREE.BufferGeometry {
  const positions: number[] = [];
  for (const b of boxes) {
    const x0 = b.x - b.w / 2;
    const x1 = b.x + b.w / 2;
    const y0 = b.y - b.h / 2;
    const y1 = b.y + b.h / 2;
    const z0 = b.z - b.d / 2;
    const z1 = b.z + b.d / 2;
    const v = (x: number, y: number, z: number): readonly [number, number, number] => [x, y, z];
    const quad = (
      a: readonly [number, number, number],
      c: readonly [number, number, number],
      d: readonly [number, number, number],
      e: readonly [number, number, number],
    ): void => {
      positions.push(...a, ...c, ...d, ...a, ...d, ...e);
    };
    quad(v(x0, y0, z0), v(x1, y0, z0), v(x1, y0, z1), v(x0, y0, z1)); // underside
    quad(v(x0, y1, z0), v(x0, y1, z1), v(x1, y1, z1), v(x1, y1, z0)); // top
    quad(v(x0, y0, z1), v(x1, y0, z1), v(x1, y1, z1), v(x0, y1, z1)); // front
    quad(v(x1, y0, z0), v(x0, y0, z0), v(x0, y1, z0), v(x1, y1, z0)); // back
    quad(v(x0, y0, z0), v(x0, y0, z1), v(x0, y1, z1), v(x0, y1, z0)); // left
    quad(v(x1, y0, z1), v(x1, y0, z0), v(x1, y1, z0), v(x1, y1, z1)); // right
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * Where the bricks of one course sit, as (centre, length) along the run.
 *
 * Exported for the test that checks the bond survives a junction, which is the
 * one property here a screenshot cannot show: two tiles' bricks either meet
 * exactly or overlap and z-fight down the whole wall, and at this size the
 * difference is a shimmer you would blame on the renderer.
 */
export function brickCourse(course: number): readonly (readonly [number, number])[] {
  const half = FENCE_TILE_LENGTH / 2;
  const whole = BRICK_RUN - BRICK_JOINT;
  if (course % 2 === 0) {
    return [-BRICK_RUN, 0, BRICK_RUN].map((x) => [x, whole] as const);
  }
  // Offset half a brick, with the two ends halved so the bond continues into the
  // next tile instead of doubling up on its bricks.
  // Each stub reaches exactly to the tile edge, so it and the neighbour tile's
  // stub form one whole brick across the join -- with no joint between them,
  // because the joint they would share falls inside the brick they make.
  const stub = BRICK_RUN / 2 - BRICK_JOINT / 2;
  return [
    [-half + stub / 2, stub],
    [-BRICK_RUN / 2, whole],
    [BRICK_RUN / 2, whole],
    [half - stub / 2, stub],
  ];
}

function brickFenceParts(): PropPart[] {
  const brickHeight = BRICK_PITCH - BRICK_JOINT;
  const faceZ = BRICK_CORE_DEPTH / 2 + BRICK_PROUD / 2;
  const wallDepth = BRICK_CORE_DEPTH + 2 * BRICK_PROUD;
  // Where the capping course starts, and so where the core stops: the core is
  // narrower than the cap, so ending it here leaves nothing of it in view from
  // above except the joints between cap bricks -- which is where mortar belongs.
  const capBottom = (BRICK_COURSES - 1) * BRICK_PITCH + BRICK_JOINT / 2;
  // One list of boxes per colour band; which band a brick joins is hashed from
  // where it sits, so the mottling is fixed rather than drawn afresh.
  const bands: Box[][] = BRICK_TONES.map(() => []);
  for (let course = 0; course < BRICK_COURSES; course++) {
    const top = course * BRICK_PITCH + BRICK_JOINT / 2 + brickHeight;
    // The bottom course runs down past the ground instead of stopping at a
    // joint, so the wall meets the earth as brick rather than as a pale strip of
    // core -- and keeps meeting it as brick where a run steps down a slope.
    const bottom = course === 0 ? -FENCE_SINK : top - brickHeight;
    const y = (top + bottom) / 2;
    const h = top - bottom;
    const capping = course === BRICK_COURSES - 1;
    brickCourse(course).forEach(([x, run], i) => {
      const band = Math.floor(hashUnit2(course, i * 7 + 1, HASH_BRICK) * BRICK_TONES.length) % BRICK_TONES.length;
      if (capping) {
        (bands[band] as Box[]).push({ x, y, z: 0, w: run, h, d: wallDepth });
        return;
      }
      for (const z of [faceZ, -faceZ]) {
        (bands[band] as Box[]).push({ x, y, z, w: run, h, d: BRICK_PROUD });
      }
    });
  }

  const parts: PropPart[] = [
    {
      // The core: mortar seen only through the joints, and what makes the wall
      // solid rather than two rows of bricks with daylight between them.
      geometry: new THREE.BoxGeometry(FENCE_TILE_LENGTH, capBottom + FENCE_SINK, BRICK_CORE_DEPTH),
      offsetY: (capBottom - FENCE_SINK) / 2,
      color: PALETTE.mortar,
      foliage: false,
      tintAmount: 0.08,
    },
  ];
  bands.forEach((boxes, i) => {
    if (boxes.length === 0) return;
    parts.push({
      geometry: boxesGeometry(boxes),
      offsetY: 0,
      color: BRICK_TONES[i] ?? PALETTE.brick,
      uniformColor: PALETTE.brick,
      foliage: false,
      // No positional jitter anywhere on this style: a brick wall is laid, and a
      // course that wanders reads as a mistake rather than as character. The
      // variation is the three bands and the tile's own tint.
      tintAmount: 0.1,
      jitterTint: 0.05,
    });
  });
  return parts;
}

/**
 * A board (spec 059): eight corners placed one at a time rather than a box
 * scaled, so it can taper toward the top, lean its top edge along the run, and
 * be cut off at a slant. A palisade of boxes is a barcode; the whole point of
 * this style is that no two boards are the same shape.
 *
 * Built with its origin at **ground level** and its foot below that, so scaling
 * an instance taller grows it upward instead of pushing it into the ground.
 */
interface BoardSpec {
  readonly width: number;
  /** Width at the top: under 1:1 it tapers, which is what stops it reading as a box. */
  readonly topWidth: number;
  readonly depth: number;
  readonly height: number;
  /** How much lower the left top corner sits than the right: the slant of the cut. */
  readonly slant: number;
  /** How far the top slides along the run: a board that is not quite plumb. */
  readonly lean: number;
  readonly sink: number;
}

function boardGeometry(spec: BoardSpec): THREE.BufferGeometry {
  const hw = spec.width / 2;
  const ht = spec.topWidth / 2;
  const hd = spec.depth / 2;
  const foot = -spec.sink;
  const leftY = spec.height - Math.max(0, spec.slant);
  const rightY = spec.height + Math.min(0, spec.slant);
  const v = (x: number, y: number, z: number): readonly [number, number, number] => [x, y, z];
  const b00 = v(-hw, foot, -hd);
  const b10 = v(hw, foot, -hd);
  const b11 = v(hw, foot, hd);
  const b01 = v(-hw, foot, hd);
  const t00 = v(-ht + spec.lean, leftY, -hd);
  const t10 = v(ht + spec.lean, rightY, -hd);
  const t11 = v(ht + spec.lean, rightY, hd);
  const t01 = v(-ht + spec.lean, leftY, hd);

  const positions: number[] = [];
  // Wound so the face normal points out of the solid; `computeVertexNormals`
  // then reads the winding, and a face wound the other way is invisible.
  const quad = (
    a: readonly [number, number, number],
    b: readonly [number, number, number],
    c: readonly [number, number, number],
    d: readonly [number, number, number],
  ): void => {
    positions.push(...a, ...b, ...c, ...a, ...c, ...d);
  };
  quad(b00, b10, b11, b01); // underside
  quad(t00, t01, t11, t10); // top
  quad(b01, b11, t11, t01); // front
  quad(b10, b00, t00, t10); // back
  quad(b00, b01, t01, t00); // left
  quad(b11, b10, t10, t11); // right

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * A stone (spec 059): an icosahedron with every vertex pushed in or out, then
 * squashed to the size wanted.
 *
 * The perturbation is a hash of the vertex **position**, never of its index. The
 * geometry is non-indexed, so a corner shared by five faces exists five times
 * over; keyed by index those five copies would move apart and tear the stone
 * open along every edge meeting there.
 */
function rockGeometry(seed: number, rx: number, ry: number, rz: number, rough = 0.24): THREE.BufferGeometry {
  // `IcosahedronGeometry` is already non-indexed, which is exactly why the hash
  // below has to be keyed by position.
  const geometry = new THREE.IcosahedronGeometry(1, 0);
  const position = geometry.getAttribute('position');
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i);
    const y = position.getY(i);
    const z = position.getZ(i);
    const key = hashUnit2(
      Math.round(x * 997) + Math.round(y * 131),
      Math.round(z * 997) + Math.round(y * 17),
      seed,
    );
    // Never below 1 - rough, so a stone sized to overlap its neighbours still
    // does after being knocked about -- a shrunken one opens a hole in the wall.
    const knock = 1 - rough / 2 + rough * key;
    position.setXYZ(i, x * knock * rx, y * knock * ry, z * knock * rz);
  }
  geometry.computeVertexNormals();
  return geometry;
}

/** A deterministic unit value for authoring layouts at module load. */
const authored = (index: number, seed: number): number => hashUnit2(index, index * 7 + 1, seed);

const HASH_BOARD = 0xb0a2d5;
const HASH_STONE = 0x57012e;
const HASH_BRICK = 0xb21c14;

/** Boards to a tile, and how far each overlaps the one before it. */
const BOARD_COUNT = 7;
const BOARD_OVERLAP = 1.2;
const BOARD_TONES = [PALETTE.plank, PALETTE.plankPale, PALETTE.plankGrey, PALETTE.post] as const;

/**
 * A palisade of vertical boards, no rails and no posts (spec 059).
 *
 * The widths are drawn from a hash and then **normalised so the advances sum to
 * exactly one tile**, which is the whole trick: the boards can be any widths at
 * all and a run still has neither a seam nor a doubled board at each junction.
 * Each board keeps the overlap it was given, so its neighbour is always behind
 * its edge rather than beside it.
 */
function boardFenceParts(): PropPart[] {
  const widths: number[] = [];
  for (let i = 0; i < BOARD_COUNT; i++) widths.push(5.8 + authored(i, HASH_BOARD) * 3.6);
  const advances = widths.map((w) => w - BOARD_OVERLAP);
  const total = advances.reduce((sum, a) => sum + a, 0);
  const fit = FENCE_TILE_LENGTH / total;

  const parts: PropPart[] = [];
  let at = -FENCE_TILE_LENGTH / 2;
  advances.forEach((advance, i) => {
    const step = advance * fit;
    const width = step + BOARD_OVERLAP;
    const u = (n: number): number => authored(i * 13 + n, HASH_BOARD);
    const height = 43 + u(1) * 15;
    parts.push({
      geometry: boardGeometry({
        width,
        // Tapered, slanted and out of plumb by an amount that is this board's
        // own -- authored once, so the shape is stable, and added to by the
        // per-instance jitter below so tiles still differ from each other.
        topWidth: width * (0.84 + u(2) * 0.16),
        depth: 4.2 + u(3) * 1.6,
        height,
        slant: (u(4) * 2 - 1) * 5,
        lean: (u(5) * 2 - 1) * 1.8,
        sink: FENCE_SINK,
      }),
      // The geometry stands on the origin, so nothing to offset vertically.
      offsetY: 0,
      offsetX: at + width / 2 - BOARD_OVERLAP / 2,
      color: BOARD_TONES[Math.floor(u(6) * BOARD_TONES.length) % BOARD_TONES.length] ?? PALETTE.plank,
      uniformColor: PALETTE.plank,
      foliage: false,
      tintAmount: 0.1,
      jitterX: 0.5,
      jitterYaw: 0.05,
      jitterRoll: 0.055,
      jitterScaleX: 0.09,
      jitterScaleY: 0.08,
      jitterTint: 0.13,
    });
    at += step;
  });
  return parts;
}

/**
 * A wall of stones and nothing else (spec 059).
 *
 * Three staggered rows, each stone wide enough that it still overlaps its
 * neighbours after `rockGeometry` has knocked it about and the per-instance
 * jitter has shifted it -- a rubble wall with a hole in it is a fence, not a
 * wall, and the hole is what you see rather than the ninety stones around it.
 *
 * The middle row is offset by half a stone, so its end stone reaches past the
 * tile edge and interlocks with the next tile's rather than butting it. The top
 * row is deliberately uneven: that is what a drystone wall's top looks like, and
 * a level one reads as a kerb.
 */
function rubbleFenceParts(): PropPart[] {
  const rows: readonly {
    readonly xs: readonly number[];
    readonly y: number;
    readonly ry: number;
    /** Per-stone height offsets, so the row's top is not a straight line. */
    readonly rise?: readonly number[];
  }[] = [
    { xs: [-16, 0, 16], y: 7, ry: 9 },
    // Offset half a stone: the joints of one course sit over the middles of the
    // one below, which is the thing that makes stacked stone read as stacked
    // rather than as a heap. An offset row's end stones sit *at* the tile edge
    // (as far out as the jitter below still leaves them inside it) and their
    // geometry reaches over it, so consecutive tiles interlock rather than butt.
    { xs: [-23.3, -7.8, 7.8, 23.3], y: 17, ry: 8.5 },
    { xs: [-16, 0, 16], y: 27.5, ry: 8.5 },
    { xs: [-23.3, -7.8, 7.8, 23.3], y: 38, ry: 8, rise: [-1.5, 2.5, -2.5, 1.5] },
  ];
  // Wider than they are tall and flattened across the wall: a stone laid in a
  // wall is a slab with a face, and a ball of rock reads as scree.
  const STONE_RX = 12.5;
  const STONE_RZ = 8.5;
  const parts: PropPart[] = [];
  rows.forEach((row, r) => {
    row.xs.forEach((x, i) => {
      const u = (n: number): number => authored(r * 17 + i * 5 + n, HASH_STONE);
      parts.push({
        geometry: rockGeometry(
          HASH_STONE + r * 31 + i,
          STONE_RX * (0.94 + u(1) * 0.14),
          row.ry * (0.92 + u(2) * 0.18),
          STONE_RZ * (0.94 + u(3) * 0.12),
          0.16,
        ),
        offsetY: row.y + (row.rise?.[i] ?? 0),
        offsetX: x,
        color: [PALETTE.drystone, PALETTE.drystonePale, PALETTE.drystoneWarm][
          Math.floor(u(4) * 3) % 3
        ] as number,
        uniformColor: PALETTE.drystone,
        foliage: false,
        tintAmount: 0.1,
        // All small: the sizes above are chosen so neighbours overlap, and jitter
        // this side of that margin varies the wall without opening it.
        jitterX: 0.6,
        jitterZ: 0.35,
        jitterYaw: 0.22,
        jitterRoll: 0.08,
        jitterScaleY: 0.06,
        jitterTint: 0.11,
      });
    });
  });
  return parts;
}

const FENCE_PARTS = new Map<FenceKind, PropPart[]>();
function fenceParts(kind: FenceKind): PropPart[] {
  let held = FENCE_PARTS.get(kind);
  if (!held) {
    held = buildFenceParts(kind);
    FENCE_PARTS.set(kind, held);
  }
  return held;
}

function buildFenceParts(kind: FenceKind): PropPart[] {
  switch (kind) {
    case 'fence-boards':
      return boardFenceParts();
    case 'fence-brick':
      return brickFenceParts();
    case 'fence-rubble':
      return rubbleFenceParts();
    default:
      return woodFenceParts();
  }
}

/**
 * The buildings (spec 224): a timber hut under a straw roof, and a well.
 *
 * Everything else in this file grows or fences something off. These two are the
 * first props somebody *lives* in, and what they are for is a playtest village
 * -- a handful of huts round a square with a well in the middle -- so they are
 * built to read at the game's isometric bearing from a hundred units up, and
 * not to be looked at closely.
 *
 * They are ordinary `PropPart` lists and nothing about them is special-cased
 * anywhere: same batching, same per-instance tint, same region grid. The one
 * thing they deliberately do *not* set is `sway`. A tree leans in the wind
 * because it is alive; a house that did would be a house falling down.
 */

/** How far a building's walls are buried, so a slope shows no daylight under
 *  them. The fence's `FENCE_SINK` for the same reason, a little deeper because
 *  a building's footprint is wider and so spans more fall. */
const BUILDING_SINK = 9;

/**
 * Eaves height, and how far the ridge stands above them.
 *
 * Measured against the body, not chosen: a unit is about 56 tall, so eaves at
 * 58 put the roofline at head height and the doorway under it -- a hut somebody
 * would have to duck into, which reads as a toy rather than as a house. 64
 * clears a standing figure with the door under it, and the ridge takes the
 * silhouette to a little over two bodies, which is what a one-room cottage is.
 */
const HOUSE_WALL_HEIGHT = 64;
const HOUSE_RIDGE_RISE = 62;
/**
 * How far the thatch reaches past the walls on every side.
 *
 * The number that does most of the work in the silhouette: from above -- which
 * is most of what this camera sees -- a hut is very nearly all roof, and an
 * overhang is what stops the roof reading as a lid sitting exactly on a box.
 */
const HOUSE_EAVE = 16;
/** How thick the straw is at the eaves. A thatch edge is a slab, not a line. */
const THATCH_LIP = 11;

/**
 * A gabled straw roof, as two geometries.
 *
 * The slopes and the gable ends are separate parts because they want separate
 * tones: the slopes face the sky and the ends face along the ridge, so on a
 * single-colour roof the ends go the same value as the slope beside them and
 * the whole thing flattens into one lump. Two tones and it reads as a roof.
 *
 * Both are closed against the eaves plate below them, so the underside is never
 * seen and is drawn anyway -- two triangles against a hole in a silhouette if
 * anybody ever looks up a hillside at one.
 */
function gableRoof(halfLength: number, halfDepth: number, rise: number): {
  slopes: THREE.BufferGeometry;
  gables: THREE.BufferGeometry;
} {
  const l = halfLength;
  const d = halfDepth;
  const slopeMesh = meshBuilder();
  // Wound counter-clockwise seen from outside, so `computeVertexNormals` reads
  // the winding and gives each face a normal pointing out of the roof.
  slopeMesh.quad([-l, 0, d], [l, 0, d], [l, rise, 0], [-l, rise, 0]);
  slopeMesh.quad([l, 0, -d], [-l, 0, -d], [-l, rise, 0], [l, rise, 0]);
  slopeMesh.quad([-l, 0, -d], [l, 0, -d], [l, 0, d], [-l, 0, d]);

  const gableMesh = meshBuilder();
  gableMesh.tri([l, 0, d], [l, 0, -d], [l, rise, 0]);
  gableMesh.tri([-l, 0, -d], [-l, 0, d], [-l, rise, 0]);

  return { slopes: slopeMesh.build(), gables: gableMesh.build() };
}

/** The straw parts of a roof, at `eaves` above the prop's ground point. */
function thatchParts(
  halfLength: number,
  halfDepth: number,
  rise: number,
  eaves: number,
  lip: number,
): PropPart[] {
  const { slopes, gables } = gableRoof(halfLength, halfDepth, rise);
  return [
    {
      // The eaves plate: the thickness of the straw where it is cut off, and
      // what the prism above stands on. Dark, because it is the one face of a
      // roof that is always in its own shadow.
      geometry: new THREE.BoxGeometry(halfLength * 2, lip, halfDepth * 2),
      offsetY: eaves + lip / 2,
      color: PALETTE.thatchDeep,
      foliage: false,
      tintAmount: 0.08,
    },
    { geometry: slopes, offsetY: eaves + lip, color: PALETTE.thatch, foliage: false, tintAmount: 0.1 },
    { geometry: gables, offsetY: eaves + lip, color: PALETTE.thatchDeep, foliage: false, tintAmount: 0.1 },
    {
      // The ridge roll. Pale, and the only part of a hut that says which way it
      // is turned once the camera is high enough that the walls are a sliver.
      geometry: new THREE.BoxGeometry(halfLength * 2, 9, 13),
      offsetY: eaves + lip + rise - 3,
      color: PALETTE.thatchPale,
      foliage: false,
      tintAmount: 0.1,
    },
  ];
}

let HOUSE_PARTS: PropPart[] | null = null;
function houseParts(): PropPart[] {
  HOUSE_PARTS ??= buildHouseParts();
  return HOUSE_PARTS;
}

/**
 * One hut: a timber box with a door in its front wall and a straw roof over it.
 *
 * The plan comes from {@link HOUSE_PLAN} rather than from numbers typed here,
 * because the collider is derived from the same constant -- a wall drawn
 * somewhere its footprint does not reach is a building you can stand inside.
 * The ridge runs down the plan's `width` and the door faces its `depth`, which
 * is what the editor's yaw turns.
 */
function buildHouseParts(): PropPart[] {
  const hw = HOUSE_PLAN.width / 2;
  const hd = HOUSE_PLAN.depth / 2;
  const wallSpan = HOUSE_WALL_HEIGHT + BUILDING_SINK;
  // Tall enough for the body that walks through it. See HOUSE_WALL_HEIGHT.
  const doorHeight = 50;
  const doorWidth = 34;
  const parts: PropPart[] = [
    {
      geometry: new THREE.BoxGeometry(HOUSE_PLAN.width, wallSpan, HOUSE_PLAN.depth),
      offsetY: wallSpan / 2 - BUILDING_SINK,
      color: PALETTE.hutWall,
      foliage: false,
      // A little more drift than a fence rail gets: a row of huts wants to look
      // like separate houses somebody built, and this is the whole of what
      // separates one from the next.
      tintAmount: 0.14,
    },
    {
      // Four corner posts, merged: one batch rather than four, for the reason a
      // course of bricks is one. Centred *on* the corner, so half of each post
      // stands proud of both walls it meets and the box reads as framed.
      geometry: boxesGeometry(
        [-1, 1].flatMap((sx) =>
          [-1, 1].map((sz) => ({
            x: sx * hw,
            y: (wallSpan + 4) / 2 - BUILDING_SINK,
            z: sz * hd,
            w: 12,
            h: wallSpan + 4,
            d: 12,
          })),
        ),
      ),
      offsetY: 0,
      color: PALETTE.post,
      foliage: false,
      tintAmount: 0.1,
    },
    {
      // The doorway. Near-black and standing a little proud of the wall, which
      // is a cheat and the right one: a recess would need a hole in the wall
      // box, and at this size what says "door" is the dark rectangle rather
      // than the depth of it.
      geometry: new THREE.BoxGeometry(doorWidth, doorHeight, 5),
      offsetY: doorHeight / 2,
      offsetZ: hd + 1,
      color: PALETTE.hollow,
      foliage: false,
    },
    {
      // Lintel and jambs, as one merged geometry: the frame is what stops the
      // dark rectangle reading as a stain on the wall.
      geometry: boxesGeometry([
        { x: 0, y: doorHeight + 3, z: hd + 2, w: doorWidth + 14, h: 7, d: 7 },
        { x: -(doorWidth / 2 + 3.5), y: doorHeight / 2, z: hd + 2, w: 7, h: doorHeight, d: 7 },
        { x: doorWidth / 2 + 3.5, y: doorHeight / 2, z: hd + 2, w: 7, h: doorHeight, d: 7 },
      ]),
      offsetY: 0,
      color: PALETTE.post,
      foliage: false,
      tintAmount: 0.1,
    },
  ];
  parts.push(
    ...thatchParts(hw + HOUSE_EAVE, hd + HOUSE_EAVE, HOUSE_RIDGE_RISE, HOUSE_WALL_HEIGHT, THATCH_LIP),
  );
  return parts;
}

/** The well's stonework, and how high its uprights carry the roof. */
const WELL_KERB_HEIGHT = 40;
/**
 * How high the uprights carry the roof.
 *
 * A little over a body, and no more. The first cut was 96 -- more than two
 * kerbs -- and photographed in the editor as a stone ring with a hat floating
 * above it, because at that separation nothing connects the two: the posts are
 * a few pixels wide at the zoom the game plays at, and the mass at the bottom
 * and the mass at the top read as two props.
 */
const WELL_POST_HEIGHT = 84;
/**
 * How far the roof reaches across the well, as a fraction of the kerb.
 *
 * **Under one, and that is the whole of what makes a well readable.** A roof
 * wide enough to actually keep rain off is a roof that, seen from a camera
 * looking down at the ground, covers the drum, the uprights, the winch and the
 * bucket completely -- and a well whose stonework you cannot see is a tan slab
 * floating over a village square. The first cut was 1.05 and photographed as
 * exactly that. Under one, the kerb stands out in front of the eaves at every
 * bearing this camera has.
 */
const WELL_ROOF_REACH = 0.86;
/** Radial segments in the kerb. Ten reads as laid stone at the zoom the game
 *  plays at; smooth would read as a pipe. */
const WELL_SIDES = 10;

let WELL_PARTS: PropPart[] | null = null;
function wellParts(): PropPart[] {
  WELL_PARTS ??= buildWellParts();
  return WELL_PARTS;
}

/**
 * The well: a stone drum, two uprights carrying a small straw roof, a winch
 * across them and a bucket on the rope.
 *
 * The bucket is not decoration. A stone ring with a roof over it is a shrine or
 * a planter; what makes it a well is the thing on the end of the rope, and it
 * costs one part.
 *
 * What the shaft is *not* is a hole. The kerb is a solid drum with a dark disc
 * standing a little proud of its rim, because the roof is directly over the
 * opening and no camera in this game can see down it -- an open annulus would
 * be three more parts and two more inner walls to draw, all of them for a view
 * nobody has.
 */
function buildWellParts(): PropPart[] {
  const kerbSpan = WELL_KERB_HEIGHT + BUILDING_SINK;
  const postSpan = WELL_POST_HEIGHT + BUILDING_SINK;
  // On the rim rather than inside it, and thick enough to be seen: a 10-unit
  // post is six pixels at the zoom this is looked at, and a roof held up by
  // something invisible is a roof floating in the air.
  const postAt = WELL_RADIUS - 4;
  const postWidth = 14;
  // Just under the eaves, so the rope has the whole drop to hang down.
  const winchAt = WELL_POST_HEIGHT - 12;
  const bucketHeight = 15;
  const bucketAt = WELL_KERB_HEIGHT + 10;
  const ropeTop = winchAt;
  const ropeFoot = bucketAt + bucketHeight / 2;
  // Lying along the prop's own X, between the two uprights: a cylinder is built
  // standing up, and a part has no fixed rotation of its own, so the turn is
  // baked into the buffer.
  const drum = new THREE.CylinderGeometry(7, 7, postAt * 2, 8);
  drum.rotateZ(Math.PI / 2);
  return [
    {
      // Battered slightly -- wider at the foot than at the rim -- which is how
      // drystone is laid and what stops the drum reading as a barrel.
      geometry: new THREE.CylinderGeometry(WELL_RADIUS, WELL_RADIUS + 3, kerbSpan, WELL_SIDES),
      offsetY: kerbSpan / 2 - BUILDING_SINK,
      color: PALETTE.drystone,
      foliage: false,
      tintAmount: 0.1,
    },
    {
      geometry: new THREE.CylinderGeometry(WELL_RADIUS - 9, WELL_RADIUS - 9, 4, WELL_SIDES),
      offsetY: WELL_KERB_HEIGHT,
      color: PALETTE.hollow,
      foliage: false,
    },
    {
      geometry: boxesGeometry(
        [-1, 1].map((sx) => ({
          x: sx * postAt,
          y: postSpan / 2 - BUILDING_SINK,
          z: 0,
          w: postWidth,
          h: postSpan,
          d: postWidth,
        })),
      ),
      offsetY: 0,
      color: PALETTE.post,
      foliage: false,
      tintAmount: 0.1,
    },
    { geometry: drum, offsetY: winchAt, color: PALETTE.plank, foliage: false, tintAmount: 0.12 },
    {
      // Rope and bucket, hung in the gap between the winch and the rim -- which
      // is the only place either of them is visible, and why the winch sits
      // just under the eaves rather than halfway down the posts.
      geometry: new THREE.BoxGeometry(2.6, ropeTop - ropeFoot, 2.6),
      offsetY: (ropeTop + ropeFoot) / 2,
      color: PALETTE.post,
      foliage: false,
    },
    {
      geometry: new THREE.CylinderGeometry(9, 7.5, bucketHeight, 8),
      offsetY: bucketAt,
      color: PALETTE.plank,
      foliage: false,
      tintAmount: 0.12,
    },
    ...thatchParts(
      WELL_RADIUS + 8,
      WELL_RADIUS * WELL_ROOF_REACH,
      30,
      WELL_POST_HEIGHT,
      7,
    ),
  ];
}

/**
 * The light fixtures (spec 248): a campfire, a street lamp on a stake, and a
 * standing torch.
 *
 * They are `PropPart` lists like the buildings beside them and nothing about
 * them is special-cased anywhere -- same batching, same per-instance tint, same
 * region grid, same eraser. What makes one a *light* is a row in
 * `FIXTURE_LIGHTS` and a `PointLight` the scene hangs at the height that row
 * names; the geometry here is only what the light is coming *out of*, and it
 * has to read as that from a hundred units up at the game's isometric bearing.
 *
 * Two rules they share with the hut. Neither `sway`s -- a tree leans in the wind
 * because it is alive, and a lamp post that did would be a lamp post falling
 * over. And each sinks a little into the ground, so a fixture on a slope shows
 * no daylight under its base.
 *
 * The one thing worth knowing about their *colour*: the burning parts are drawn
 * bright rather than emissive, because a prop batch is `MeshLambertMaterial` and
 * an unlit material here would be a fifth kind of batch for three props. They
 * are standing inside their own point light, which is what actually makes them
 * the brightest thing in the frame -- so the geometry only has to be pale enough
 * not to fight it.
 */

/** How far a fixture's base is buried. `BUILDING_SINK`'s reason, less deep. */
const FIXTURE_SINK = 5;

let CAMPFIRE_PARTS: PropPart[] | null = null;
function campfireParts(): PropPart[] {
  CAMPFIRE_PARTS ??= buildCampfireParts();
  return CAMPFIRE_PARTS;
}

/**
 * A campfire: a ring of stones, four logs leaning into the middle, and a bed of
 * embers with a flame standing out of it.
 *
 * The ring is eight stones rather than a drum, and that is what says *fire*
 * rather than *well* at this distance: a continuous kerb reads as stonework
 * somebody built, and eight lumps at slightly different sizes read as stones
 * somebody carried. They are hashed to no two the same by the batch's own
 * per-instance jitter; the *ring* itself is fixed, because a fire is round.
 */
function buildCampfireParts(): PropPart[] {
  const ring = 30;
  const stones = Array.from({ length: 8 }, (_, i) => {
    const a = (i / 8) * Math.PI * 2;
    // Alternating sizes, so the ring has a rhythm rather than eight identical
    // teeth. Hashed jitter varies it further per fire.
    const big = i % 2 === 0;
    return {
      x: Math.cos(a) * ring,
      y: (big ? 13 : 10) / 2 - FIXTURE_SINK,
      z: Math.sin(a) * ring,
      w: big ? 17 : 13,
      h: big ? 13 : 10,
      d: big ? 15 : 12,
    };
  });
  // Four logs, laid across each other into the middle. Each is a long thin box
  // rolled about its own length and yawed round the fire -- a cone of sticks
  // would be a cone, and what a spent fire looks like is timber that has fallen
  // in on itself.
  const logs = Array.from({ length: 4 }, (_, i) => {
    const a = (i / 4) * Math.PI + Math.PI / 8;
    const reach = 22;
    return {
      x: Math.cos(a) * reach * 0.35,
      y: 9 - FIXTURE_SINK,
      z: Math.sin(a) * reach * 0.35,
      w: 8,
      h: 8,
      d: 8,
    };
  });
  return [
    {
      geometry: boxesGeometry(stones),
      offsetY: 0,
      // The warm stone rather than the pale one, and that is a decision the
      // preview made: at `drystone` the ring is the brightest thing in the prop
      // and a campfire photographs as a white splat with a small flame in it.
      // What has to be brightest is the fire.
      color: PALETTE.drystoneWarm,
      foliage: false,
      // The widest drift of any fixture part: a fire is made of stones somebody
      // found, so one being greyer than the next is the point.
      tintAmount: 0.16,
    },
    {
      // The logs, merged into one geometry and turned as a group. Turning each
      // one separately would need four parts, and what the eye reads from above
      // is a dark cross in a bright ring rather than which log is on top.
      geometry: boxesGeometry([
        ...logs,
        { x: 0, y: 12 - FIXTURE_SINK, z: 0, w: 46, h: 7, d: 7 },
        { x: 0, y: 16 - FIXTURE_SINK, z: 0, w: 7, h: 7, d: 46 },
      ]),
      offsetY: 0,
      color: PALETTE.charred,
      foliage: false,
      tintAmount: 0.08,
      jitterYaw: 0.5,
    },
    {
      // The ember bed: a low disc filling the ring, so a fire seen from directly
      // above is not a hole with sticks over it.
      geometry: new THREE.CylinderGeometry(ring * 0.62, ring * 0.72, 5, 10),
      offsetY: 3 - FIXTURE_SINK,
      color: PALETTE.emberBed,
      foliage: false,
      tintAmount: 0.1,
    },
    {
      // The flame. A cone, because a cone with three sides is what this game
      // already draws a tree's crown with and it reads as a shape rather than as
      // a sprite -- and it is not what lights anything, so it is allowed to be
      // this simple.
      geometry: new THREE.ConeGeometry(13, 34, 5),
      offsetY: 26,
      color: PALETTE.torchCore,
      foliage: false,
      jitterYaw: 0.9,
    },
  ];
}

let LAMP_POST_PARTS: PropPart[] | null = null;
function lampPostParts(): PropPart[] {
  LAMP_POST_PARTS ??= buildLampPostParts();
  return LAMP_POST_PARTS;
}

/**
 * How high a street lamp carries its light.
 *
 * Measured against the body rather than chosen: a unit is about 56 tall, so a
 * lamp head at 122 is a little over two of them -- high enough that a figure
 * walking under it does not block its own pool of light, and low enough that it
 * still reads as something a person put there rather than as a pylon.
 *
 * It has to agree with `FIXTURE_LIGHTS['lamp-post'].height`, which is what the
 * light is actually hung at: a lamp whose flame is not inside its own lantern is
 * the one mistake in this file nobody would think to look for.
 */
const LAMP_HEAD_HEIGHT = 122;

function buildLampPostParts(): PropPart[] {
  const stakeHeight = LAMP_HEAD_HEIGHT - 8 + FIXTURE_SINK;
  return [
    {
      // The stake. Square rather than round, and slightly tapered by nothing at
      // all: a fence post in this game is a box, and a lamp on a wooden stake
      // should look like it came out of the same yard.
      geometry: new THREE.BoxGeometry(9, stakeHeight, 9),
      offsetY: stakeHeight / 2 - FIXTURE_SINK,
      color: PALETTE.post,
      foliage: false,
      tintAmount: 0.12,
      jitterYaw: 0.25,
    },
    {
      // A cross-brace near the foot, which is the whole of what stops the stake
      // reading as a stick pushed into the mud.
      geometry: boxesGeometry([
        { x: 0, y: 26, z: 0, w: 30, h: 5, d: 5 },
        { x: 0, y: 26, z: 0, w: 5, h: 5, d: 30 },
      ]),
      offsetY: 0,
      color: PALETTE.post,
      foliage: false,
      tintAmount: 0.1,
    },
    {
      // The lantern's iron: a cage under a cap, drawn as two boxes because at
      // this size the bars are one pixel and the silhouette is the whole of it.
      geometry: boxesGeometry([
        { x: 0, y: LAMP_HEAD_HEIGHT + 15, z: 0, w: 26, h: 6, d: 26 },
        { x: 0, y: LAMP_HEAD_HEIGHT - 14, z: 0, w: 18, h: 5, d: 18 },
      ]),
      offsetY: 0,
      color: PALETTE.ironDark,
      foliage: false,
    },
    {
      // The mantle, inside the cage. Pale rather than flame-coloured, because a
      // lamp is a made thing: what separates it from the torch stand beside it
      // at a hundred units is that this one is white and steady.
      geometry: new THREE.BoxGeometry(19, 24, 19),
      offsetY: LAMP_HEAD_HEIGHT,
      color: PALETTE.lampMantle,
      foliage: false,
    },
  ];
}

let TORCH_STAND_PARTS: PropPart[] | null = null;
function torchStandParts(): PropPart[] {
  TORCH_STAND_PARTS ??= buildTorchStandParts();
  return TORCH_STAND_PARTS;
}

/** Where the standing torch's flame sits. See {@link LAMP_HEAD_HEIGHT}. */
const TORCH_HEAD_HEIGHT = 78;

function buildTorchStandParts(): PropPart[] {
  const shaftHeight = TORCH_HEAD_HEIGHT - 6 + FIXTURE_SINK;
  return [
    {
      geometry: new THREE.BoxGeometry(7, shaftHeight, 7),
      offsetY: shaftHeight / 2 - FIXTURE_SINK,
      color: PALETTE.post,
      foliage: false,
      tintAmount: 0.12,
      jitterYaw: 0.3,
    },
    {
      // Three legs splayed off the foot. A torch stand has to stand up, and a
      // single stake in the ground is the lamp post one prop over.
      geometry: boxesGeometry(
        Array.from({ length: 3 }, (_, i) => {
          const a = (i / 3) * Math.PI * 2;
          return { x: Math.cos(a) * 9, y: 9, z: Math.sin(a) * 9, w: 5, h: 24, d: 5 };
        }),
      ),
      offsetY: 0,
      color: PALETTE.post,
      foliage: false,
      tintAmount: 0.1,
    },
    {
      // The head: a pitch-soaked bowl. Wider than the shaft, so the flame has
      // something to sit in rather than balancing on a point.
      geometry: new THREE.CylinderGeometry(12, 6, 14, 6),
      offsetY: TORCH_HEAD_HEIGHT - 8,
      color: PALETTE.charred,
      foliage: false,
    },
    {
      geometry: new THREE.ConeGeometry(9, 24, 5),
      offsetY: TORCH_HEAD_HEIGHT + 9,
      color: PALETTE.torchCore,
      foliage: false,
      jitterYaw: 0.9,
    },
  ];
}

/** Warm autumn foliage, for the fraction of trees that turn. */
const AUTUMN = [0xb8502a, 0xd0722c, 0xe0a334] as const;
/** Tint above which a prop goes autumn. ~18% of them, so it stays an accent. */
const AUTUMN_ABOVE = 0.64;

/**
 * The colour one instance of a foliage part takes. Most props only drift a
 * little either side of the base green; the ones past the autumn threshold swap
 * to the warm ramp instead, keeping the same dark-to-bright tier ordering.
 */
function scaleColor(base: number, scale: number): number {
  const r = Math.min(255, Math.round(((base >> 16) & 0xff) * scale));
  const g = Math.min(255, Math.round(((base >> 8) & 0xff) * scale));
  const b = Math.min(255, Math.round((base & 0xff) * scale));
  return (r << 16) | (g << 8) | b;
}

function foliageColor(base: number, tier: number, tint: number): number {
  if (tint > AUTUMN_ABOVE) return AUTUMN[Math.min(tier, AUTUMN.length - 1)] ?? base;
  return scaleColor(base, 0.88 + 0.24 * ((tint + 1) / 2));
}

/**
 * The colour a non-foliage part takes: `base`, drifted by `amount` of the prop's
 * own tint (so one tile differs from the next) plus `extra` (so one part differs
 * from its neighbours on the same tile).
 */
function shadedColor(base: number, tint: number, amount: number, extra = 0): number {
  const drift = amount * Math.max(-1, Math.min(1, tint)) + extra;
  return drift === 0 ? base : scaleColor(base, 1 + drift);
}

/** How one tree differs from the rest of its species. */
export interface TreeVariant {
  readonly species: TreeSpecies;
  readonly tierCount: number;
  /** Which way and how hard the fronds lean, in [-1, 1]. */
  readonly asymmetry: number;
  /** Compass direction of the lean, radians. */
  readonly leanAngle: number;
}

/**
 * Pick a tree's variant from a spatial hash of where it stands -- not from the
 * `Prop`'s own fields, because `tint` already drives the autumn turn and keying
 * the species off it too would make every autumn tree the same shape.
 *
 * Pure in the position, so the same world always grows the same forest, the
 * batching can ask twice and get the same answer, and the terrain module stays
 * unaware that species exist at all.
 */
export function treeVariant(prop: Prop): TreeVariant {
  // A lattice coarse enough to be cheap and fine enough that two props never
  // collide on it: the scatter keeps trunks much further apart than this.
  const x = Math.round(prop.x / 8);
  const z = Math.round(prop.y / 8);
  const roll = hashUnit2(x, z, HASH_SPECIES);
  const species: TreeSpecies = roll < LOBED_SHARE ? 'lobed' : roll < LOBED_SHARE + PINE_SHARE ? 'pine' : 'fir';
  const counts = speciesTierCounts(species);
  const pick = Math.min(counts.length - 1, Math.floor(hashUnit2(x, z, HASH_TIERS) * counts.length));
  return {
    species,
    tierCount: counts[pick] ?? counts.length,
    asymmetry: hashUnit2(x, z, HASH_ASYMMETRY) * 2 - 1,
    leanAngle: hashUnit2(x, z, HASH_LEAN) * Math.PI * 2,
  };
}

/** The tallest a tree of a species can stand, in prop-local units (before scale). */
export function speciesHeight(species: TreeSpecies): number {
  const shape = SPECIES[species];
  if (shape.kind === 'lobed') {
    // The tip is the top of a lobed tree by construction, but a slab's dome
    // could in principle reach past it, so ask rather than assert.
    const crown = slabLayout(shape).reduce((high, slab) => Math.max(high, slab.y + slabRise(slab)), 0);
    return Math.max(crown, shape.height);
  }
  // The crown alone, since spec 122: the trunk ends inside the topmost frond a
  // tree grew, so it can no longer be the tallest thing on the tree. Asked as a
  // maximum anyway rather than as the last tier's top, because which tier is
  // tallest is the tier table's business.
  return shape.tiers.reduce((high, [, height, baseY]) => Math.max(high, baseY + height), 0);
}

/**
 * How much bare trunk stands below the lowest foliage, in prop-local units.
 * The number this whole reshape is about: it used to be zero.
 */
export function bareTrunkHeight(species: TreeSpecies): number {
  const shape = SPECIES[species];
  // The lowest slab's *lowest point*, not the plane it is placed at: the
  // underside is what you see the trunk against, and it hangs below that plane
  // by the slab's own thickness and by however far its pitch drops the near rim.
  if (shape.kind === 'lobed') return shape.height * shape.canopyBase - slabDrop(shape);
  return shape.tiers[0]?.[2] ?? 0;
}

/** The widest a species' crown gets, for reasoning about canopy overlap. */
export function crownRadius(species: TreeSpecies): number {
  const shape = SPECIES[species];
  if (shape.kind === 'lobed') return lobedCrownRadius(shape);
  return shape.tiers.reduce((wide, [radius]) => Math.max(wide, radius), 0);
}

/** A world-space rectangle, as {@link PropFieldHandle.rebuildWithin} reads one. */
export interface PropRect {
  readonly minX: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxZ: number;
}

export interface PropFieldHandle {
  readonly group: THREE.Group;
  /**
   * Props this build has no geometry for, and so did not draw.
   *
   * Zero in a consistent build -- every `PropKind` has parts. It is not zero
   * when a map written by a newer build is opened in an older one, or when a dev
   * server hands the page a half-updated module graph, and in both cases the
   * symptom without this is a tool that appears to do nothing at all: the props
   * are placed, saved and reloaded correctly and simply never appear. Surfaced
   * so the editor can say so rather than leaving you to guess.
   */
  undrawn: number;
  /**
   * Rebuild only the batching regions overlapping a world rectangle (spec 086).
   *
   * The field is already grouped into regions so the camera can cull them; this
   * makes that grouping the unit of *invalidation* too. Adding a map part used
   * to rebuild every batch in the world -- 402 of them and 143k vertices on the
   * shipped map, ~330ms and rising with the map -- to redraw the handful of
   * trees the part had just planted.
   *
   * `props` is the full, current list: the region is re-bucketed from it, so a
   * caller never has to work out which props belong where.
   *
   * Several rectangles may be given at once (spec 165). That is not a
   * convenience: re-bucketing is a pass over every prop in the world, so a
   * streaming client with eight scattered regions to redraw would pay for eight
   * of them -- and merging them into one bounding box instead would redraw every
   * region in between, which on a cold start is the whole map. One pass, the
   * union of the regions the rectangles touch.
   */
  rebuildWithin(props: readonly Prop[], rect: PropRect | readonly PropRect[]): void;
  /**
   * Hang one region's batches on the scene graph, from instances composed
   * elsewhere (spec 181).
   *
   * The seam the map worker enters through. `rebuildWithin` is this with
   * {@link buildRegionInstances} in front of it, so a field built on this thread
   * and one built on the worker are the same field by construction rather than
   * by two implementations agreeing.
   */
  adoptRegion(key: string, instances: RegionInstances): void;
  /**
   * Stop drawing one region, and free everything only it owned (spec 211).
   *
   * The counterpart to {@link adoptRegion}, and the takedown that function has
   * always performed on the way past: it frees the held region before hanging
   * up the new one, so an empty reply was already a clean removal. What this
   * adds is a way to reach it without composing an empty region on another
   * thread first -- which matters because the reason to take a region down is
   * that its ground has gone, and there is nothing left over there to compose
   * it from.
   *
   * Answers whether anything was there, since disposal is a call rather than a
   * value and a caller reconciling against held ground has no other way to
   * count what it dropped.
   */
  dropRegion(key: string): boolean;
  /** Region keys with batches on the scene graph. For the drop pass. */
  heldRegions(): readonly string[];
  /**
   * Every light fixture standing on ground this field is currently drawing
   * (spec 248).
   *
   * Read off the held regions rather than kept as a list of its own, which is
   * what makes a fixture on forgotten ground stop being lit *by construction*:
   * spec 215's rule is that a region is drawn because a chunk under it is held,
   * so a light that outlived its region would be a second residency rule with
   * nothing keeping it in step with the first.
   */
  lights(): readonly RegionLight[];
  dispose(): void;
}

/** The kinds `buildPropField` knows how to draw. */
const DRAWN_KINDS: ReadonlySet<string> = new Set<string>([
  'tree',
  'bush',
  ...FENCE_KINDS,
  ...STRUCTURE_KINDS,
  ...FIXTURE_KINDS,
]);

/** The unit surface normal of the ground, for props that lie along it. */
export type NormalAt = (x: number, z: number) => readonly [number, number, number];

/**
 * How the prop field shades itself (spec 097, step 2).
 *
 * Props are where this question has an answer worth asking: they are the only
 * curved surfaces in the world that are not the terrain. The terrain's surface is
 * already smooth from its own corner normals and its cliffs are flat by
 * construction, and rigs and critters are boxes, on which averaging a normal
 * means nothing.
 */
export interface PropShading {
  /**
   * Weld and average normals across the crease angle instead of flat-shading
   * every face.
   *
   * On this geometry that reaches almost nothing: only the canopy slabs are
   * tessellated finer than the crease, so trunks, cones and stones keep their
   * facets. See the table in `shading.ts` -- the coarseness is the style, and
   * this switch is here to make that visible rather than to change it.
   */
  readonly smooth: boolean;
  /** Faces meeting at a sharper angle than this stay split. In radians. */
  readonly creaseAngle: number;
  /** Rotate vertex normals with the wind's bend. Inert while `smooth` is false. */
  readonly swayNormals: boolean;
}

/**
 * What the field has always done, and still does unless told otherwise: every
 * face flat, nothing welded.
 */
export const FLAT_SHADING: PropShading = {
  smooth: false,
  creaseAngle: DEFAULT_CREASE_ANGLE,
  swayNormals: false,
};

/**
 * The geometry to draw a part with under smooth shading: the same one with
 * welded, crease-split normals.
 *
 * **Indexed geometry is expanded first.** `weldedNormals` needs one vertex slot
 * per triangle corner, because a crease is expressed by two slots at one
 * position disagreeing -- an indexed mesh has a single slot there and physically
 * cannot record the split. three.js's `ConeGeometry` is indexed, so without this
 * the conifers came out smooth around their circumference under a crease angle
 * that says they should stay faceted. `toNonIndexed` carries every attribute
 * across, including the `aBend` the wind sway needs.
 *
 * Returns the geometry to use, which may be a new object; the caller owns it and
 * disposes it with the batch. Marked as done so a geometry handed out twice is
 * welded once.
 */
const WELDED = new Map<THREE.BufferGeometry, Map<number, THREE.BufferGeometry>>();

/**
 * The vertex data a batch draws, built once per `(part, crease angle)`
 * (spec 181).
 *
 * Memoized rather than re-welded per region, which is 5.9ms of a 32.7ms region
 * rebuild. Under flat shading this is the part's own geometry, which was already
 * shared -- the sharing is not new, only the welded case is.
 *
 * Nothing disposes what this holds: it is one geometry per part per angle for
 * the life of the page, the same lifetime the part tables have. A crease angle
 * the panel visits and leaves keeps its entry, which is a handful of small
 * geometries against re-welding on every region for the rest of the session.
 */
function sharedGeometry(
  geometry: THREE.BufferGeometry,
  creaseCos: number,
  smooth: boolean,
): THREE.BufferGeometry {
  if (!smooth) return geometry;
  let byAngle = WELDED.get(geometry);
  if (!byAngle) {
    byAngle = new Map();
    WELDED.set(geometry, byAngle);
  }
  let held = byAngle.get(creaseCos);
  if (!held) {
    held = smoothGeometry(geometry, creaseCos);
    byAngle.set(creaseCos, held);
  }
  return held;
}

/**
 * A geometry of this batch's own, over vertex data it shares with every other
 * batch of the same part (spec 181).
 *
 * An `InstancedMesh`'s per-instance attributes live on its *geometry*, and
 * `applySway` writes two of them -- so batches cannot share a geometry object
 * however identical their vertices are. They can share the `BufferAttribute`
 * objects underneath, which is where all the cost was: a shell is an object and
 * a handful of assignments and does no vertex work at all.
 *
 * The bounding sphere is cloned rather than shared. Nothing mutates it today --
 * `InstancedMesh.computeBoundingSphere` reads the geometry's and writes the
 * mesh's -- and one `Sphere` per batch is not worth being right about later.
 */
function shellOf(shared: THREE.BufferGeometry): THREE.BufferGeometry {
  const shell = new THREE.BufferGeometry();
  for (const [name, attribute] of Object.entries(shared.attributes)) {
    shell.setAttribute(name, attribute);
  }
  if (shared.index) shell.setIndex(shared.index);
  if (shared.boundingSphere) shell.boundingSphere = shared.boundingSphere.clone();
  if (shared.groups.length > 0) {
    for (const g of shared.groups) shell.addGroup(g.start, g.count, g.materialIndex);
  }
  return shell;
}

/**
 * Free what a batch owns, and nothing it borrows (spec 181).
 *
 * three's `onGeometryDispose` walks `geometry.attributes` and removes the GPU
 * buffer of every one it finds, so disposing a shell as-is would free the
 * *shared* attributes and force every other region holding that part to
 * re-upload -- a hitch caused by the very rebuild this is meant to make cheap,
 * and one that no headless test could see. So the borrowed attributes are taken
 * off the shell first, and what is disposed is what this batch added:
 * `aWindBase` and `aWindTune`.
 */
function disposeShell(shell: THREE.BufferGeometry, shared: THREE.BufferGeometry): void {
  for (const name of Object.keys(shared.attributes)) shell.deleteAttribute(name);
  if (shared.index) shell.setIndex(null);
  shell.dispose();
}

function smoothGeometry(geometry: THREE.BufferGeometry, creaseCos: number): THREE.BufferGeometry {
  if (geometry.userData['weldedNormals'] === creaseCos) return geometry;
  if (!geometry.getAttribute('position')) return geometry;

  let target = geometry;
  if (geometry.getIndex()) {
    target = geometry.toNonIndexed();
    // Never uploaded, so this frees bookkeeping rather than GPU memory -- but a
    // geometry nothing will ever draw should not be left in the batch's list.
    geometry.dispose();
  }
  const position = target.getAttribute('position');
  const normals = weldedNormals(position.array as ArrayLike<number>, creaseCos);
  target.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  target.userData['weldedNormals'] = creaseCos;
  return target;
}


/**
 * Which batch is which, on both sides of a thread boundary (spec 181).
 *
 * The order `buildRegion` has always walked -- one batch per tree species, then
 * the bushes, then each fence kind -- named once so an index into it means the
 * same thing wherever it is read. Both the worker composing instances and the
 * renderer hanging them on a mesh enumerate this same list from this same
 * module, so a `(group, part)` pair cannot mean two things.
 */
const PROP_GROUPS: readonly (
  | { readonly kind: 'tree'; readonly species: TreeSpecies }
  | { readonly kind: 'bush' }
  | { readonly kind: 'fence'; readonly fence: FenceKind }
  | { readonly kind: 'structure'; readonly structure: StructureKind }
  | { readonly kind: 'fixture'; readonly fixture: FixtureKind }
)[] = [
  ...TREE_SPECIES.map((species) => ({ kind: 'tree' as const, species })),
  { kind: 'bush' as const },
  ...FENCE_KINDS.map((fence) => ({ kind: 'fence' as const, fence })),
  // Appended, never inserted: an index into this list crosses a thread, so a
  // group that moved would hand the worker's matrices to the wrong geometry.
  ...STRUCTURE_KINDS.map((structure) => ({ kind: 'structure' as const, structure })),
  ...FIXTURE_KINDS.map((fixture) => ({ kind: 'fixture' as const, fixture })),
];

/** How many batches a region can have, before its props are looked at. */
export const PROP_GROUP_COUNT = PROP_GROUPS.length;

/** The parts a batch group draws with. Memoized; see {@link treeParts}. */
export function propGroupParts(group: number): readonly PropPart[] {
  const of = PROP_GROUPS[group];
  if (!of) return [];
  if (of.kind === 'tree') return treeParts(of.species);
  if (of.kind === 'bush') return bushParts();
  if (of.kind === 'structure') return of.structure === 'well' ? wellParts() : houseParts();
  if (of.kind === 'fixture') return fixtureParts(of.fixture);
  return fenceParts(of.fence);
}

/** The parts one light fixture draws with (spec 248). Memoized; see {@link treeParts}. */
function fixtureParts(kind: FixtureKind): readonly PropPart[] {
  if (kind === 'campfire') return campfireParts();
  if (kind === 'lamp-post') return lampPostParts();
  return torchStandParts();
}

/** The props in this bucket that a batch group draws. */
function propGroupMembers(
  group: number,
  bucket: readonly Prop[],
  variants: ReadonlyMap<Prop, TreeVariant>,
): readonly Prop[] {
  const of = PROP_GROUPS[group];
  if (!of) return [];
  if (of.kind === 'tree') {
    return bucket.filter((p) => p.kind === 'tree' && variants.get(p)?.species === of.species);
  }
  if (of.kind === 'bush') return bucket.filter((p) => p.kind === 'bush');
  if (of.kind === 'structure') return bucket.filter((p) => p.kind === of.structure);
  if (of.kind === 'fixture') return bucket.filter((p) => p.kind === of.fixture);
  return bucket.filter((p) => p.kind === of.fence);
}

/** One batch's per-instance data, as arrays that can cross a thread. */
export interface PropBatchInstances {
  /** Index into the batch enumeration. See {@link propGroupParts}. */
  readonly group: number;
  /** Index into that group's part list. */
  readonly part: number;
  readonly count: number;
  /** 16 floats per instance, in `Matrix4` order. */
  readonly matrices: Float32Array;
  /** 3 per instance, linear RGB. */
  readonly colors: Float32Array;
  /** Present only where every instance in the batch sways. */
  readonly sway: {
    readonly base: Float32Array;
    readonly tune: Float32Array;
    readonly height: number;
    readonly reach: number;
  } | null;
}

/** Instances as the two flat arrays `applySwayBuffers` wants. */
function packSway(instances: readonly SwayInstance[]): { base: Float32Array; tune: Float32Array } {
  const base = new Float32Array(instances.length * 3);
  const tune = new Float32Array(instances.length * 2);
  instances.forEach((instance, i) => {
    base[i * 3] = instance.baseX;
    base[i * 3 + 1] = instance.baseY;
    base[i * 3 + 2] = instance.baseZ;
    tune[i * 2] = instance.stiffness;
    tune[i * 2 + 1] = instance.phase;
  });
  return { base, tune };
}

/**
 * Where every prop in one region stands, as arrays (spec 181).
 *
 * This is the 16.2ms half of a 32.7ms region rebuild: a position, a quaternion
 * chain, a scale and a colour per instance, and nothing that needs a scene
 * graph. It uses three's maths classes and none of its objects, which is what
 * lets it run on the map worker and hand back the result.
 *
 * The shading settings are deliberately not an argument. Nothing in here reads
 * them -- `smooth` picks a geometry and `swayNormals` patches a material, and
 * both of those happen where the mesh is made.
 */
/**
 * One light fixture in a region, ready to be hung on a `PointLight` (spec 248).
 *
 * Composed here rather than in the scene for one reason: this runs on the map
 * worker, and the worker is where a prop's ground height is already being looked
 * up. Working it out again on the render thread would be a second answer to
 * "how high is the ground under that campfire", and the two would agree right up
 * until the terrain changed under one of them.
 *
 * The position is where the *flame* is -- ground plus the row's height, scaled
 * with the prop -- so nothing downstream has to know what a fixture is made of.
 */
export interface RegionLight {
  /**
   * Stable across a rebuild of the same region from the same document.
   *
   * The pool's residency is keyed on this, and a key that changed every time a
   * region was recomposed would re-bake a shadow map on every stream event.
   * Position and index, so two fixtures on one spot are still two keys.
   */
  readonly key: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Packed RGB, from the kind's row. */
  readonly color: number;
  readonly brightness: number;
  readonly radius: number;
  /** Whether this one is worth a baked cube map. */
  readonly shadow: boolean;
}

export interface RegionInstances {
  readonly batches: readonly PropBatchInstances[];
  /**
   * The light fixtures standing in this region (spec 248).
   *
   * Beside the batches rather than derived from them, because a batch is
   * matrices and a light is a place: `PropBatchInstances` has already thrown
   * away which prop each matrix came from by the time it crosses the thread.
   */
  readonly lights: readonly RegionLight[];
  /**
   * Prop kinds in this region with no geometry to draw them with.
   *
   * Carried rather than warned about here, because this runs on the worker and
   * a warning is for a person. The renderer says it once when it adopts -- the
   * alternative is silence, which is nothing on screen and no error (spec 086).
   */
  readonly undrawnKinds: readonly string[];
}

export function buildRegionInstances(
  bucket: readonly Prop[],
  heightAt: (x: number, z: number) => number,
  normalAt?: NormalAt,
): RegionInstances {
  // Reused across every instance of every part.
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const tilt = new THREE.Quaternion();
  const leanAxis = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  // The axis a board leans about: across the fence's face, in the part's frame.
  const rollAxis = new THREE.Vector3(0, 0, 1);
  const groundUp = new THREE.Vector3();
  const align = new THREE.Quaternion();
  const offset = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const color = new THREE.Color();

  // Hashed once per tree rather than once per part per tree.
  const variants = new Map<Prop, TreeVariant>();
  for (const prop of bucket) {
    if (prop.kind === 'tree') variants.set(prop, treeVariant(prop));
  }

  const out: PropBatchInstances[] = [];
  const undrawnKinds = new Set<string>();
  for (const prop of bucket) {
    if (!DRAWN_KINDS.has(prop.kind)) undrawnKinds.add(prop.kind);
  }
  for (let group = 0; group < PROP_GROUPS.length; group++) {
    const of = propGroupMembers(group, bucket, variants);
    if (of.length === 0) continue;
    propGroupParts(group).forEach((part, partIndex) => {
      const tier = part.tier;
      // `tier + 1` is the rule the conifers have always used; `grownAt` is what
      // lets the lobed canopy keep its topmost slab at every count (spec 077),
      // and `grownUpTo` is the ceiling that picks out one count exactly, which
      // is how a trunk knows which frond it is ending in (spec 122).
      const needs = part.grownAt ?? (tier === undefined ? 0 : tier + 1);
      const upTo = part.grownUpTo ?? Infinity;
      const bounded = needs > 0 || upTo < Infinity;
      const grown =
        !bounded || !variants
          ? of
          : of.filter((prop) => {
              const count = variants.get(prop)?.tierCount ?? 0;
              return count >= needs && count <= upTo;
            });
      if (grown.length === 0) return;
      const jitterPos = part.jitterX !== undefined || part.jitterZ !== undefined;
      const jitterRot = part.jitterYaw !== undefined || part.jitterRoll !== undefined;
      const jitterSize =
        part.jitterScaleX !== undefined || part.jitterScaleY !== undefined || part.jitterTint !== undefined;

      const matrices = new Float32Array(grown.length * 16);
      const colors = new Float32Array(grown.length * 3);
      // What the wind is sampled with, once per tree (spec 074). Gathered
      // alongside the matrices rather than in a second pass, because it is the
      // same three numbers the matrix is being composed from.
      const swaying: SwayInstance[] = [];
      let swayHeight = 0;
      // How far this part's geometry stands from its own origin on the *largest*
      // instance in the batch -- the bounding sphere has to hold the biggest of
      // them, and a batch mixes every scale the scatter drew.
      let swayReach = 0;

      grown.forEach((prop, i) => {
        const s = prop.scale;
        const variant = variants?.get(prop);
        const asymmetry = variant?.asymmetry ?? 0;
        // This part's own wobble on this instance, in [-1, 1] per channel. Keyed
        // off where the prop stands, on a lattice fine enough that no two props
        // share a cell, plus the part's index so a tile's boards or courses
        // wobble independently of each other.
        const cellX = Math.round(prop.x / 4);
        const cellZ = Math.round(prop.y / 4);
        const wobble = (base: number): number =>
          hashUnit2(cellX, cellZ, base + partIndex * 0x9e37) * 2 - 1;
        const wobblePos = jitterPos ? wobble(HASH_JITTER_POS) : 0;
        const wobbleRot = jitterRot ? wobble(HASH_JITTER_ROT) : 0;
        const wobbleSize = jitterSize ? wobble(HASH_JITTER_SIZE) : 0;
        const wobbleSpin = part.spinYaw === undefined ? 0 : wobble(HASH_SPIN);

        // Local offset, scaled with the prop and spun by its rotation. The
        // per-instance drift rides in that same local frame, so a leaning tree
        // leans consistently however it happens to be turned.
        //
        // Rotated by three.js's own +Y convention (`x' = x cos + z sin`,
        // `z' = -x sin + z cos`) -- the same one the quaternion below turns the
        // *mesh* by. It used to be the mirror of that, so a part's mesh and the
        // point it was placed at turned opposite ways. Nothing noticed while the
        // only offset part was a bush's second blob sitting in an arbitrary
        // direction anyway; a fence tile notices at once, because it is not
        // symmetric along its run -- a mirrored tile puts the post at the far
        // end and the rails on the wrong face, and on a diagonal run reflects
        // the whole tile off the line being drawn.
        const lx = ((part.offsetX ?? 0) + (part.driftMax ?? 0) * asymmetry + (part.jitterX ?? 0) * wobblePos) * s;
        const lz = ((part.offsetZ ?? 0) + (part.jitterZ ?? 0) * wobblePos) * s;
        const cos = Math.cos(prop.rotation);
        const sin = Math.sin(prop.rotation);
        position.set(
          prop.x + lx * cos + lz * sin,
          heightAt(prop.x, prop.y) + part.offsetY * s,
          prop.y - lx * sin + lz * cos,
        );

        quaternion.setFromAxisAngle(up, prop.rotation + (part.jitterYaw ?? 0) * wobbleRot);
        // Applied after the yaw and so in the part's own frame: a board leans
        // within the plane of the fence rather than out of it, whichever way the
        // run happens to be pointing.
        if (part.jitterRoll) quaternion.multiply(tilt.setFromAxisAngle(rollAxis, part.jitterRoll * wobbleRot));
        const lean = (part.leanMax ?? 0) * asymmetry;
        if (lean !== 0 && variant) {
          leanAxis.set(Math.cos(variant.leanAngle), 0, Math.sin(variant.leanAngle));
          quaternion.multiply(tilt.setFromAxisAngle(leanAxis, lean));
        }
        // Last in the chain and so first in the part's own frame (spec 121): the
        // frond turns *under* the lean. Multiplied the other way round it would
        // carry the lean's axis with it, and a tree's tiers would each drift one
        // way while leaning another -- the frond tearing off the trunk it hangs
        // on, which is the one thing the drift and the lean exist to avoid.
        if (part.spinYaw) quaternion.multiply(tilt.setFromAxisAngle(up, part.spinYaw * wobbleSpin));
        if (prop.alignToNormal && normalAt) {
          const [nx, ny, nz] = normalAt(prop.x, prop.y);
          groundUp.set(nx, ny, nz);
          if (groundUp.lengthSq() > 0) {
            // Tip world-up onto the ground's normal, applied *before* the yaw so
            // the prop still spins about its own new axis rather than the world's.
            align.setFromUnitVectors(up, groundUp.normalize());
            quaternion.premultiply(align);
            // The part's local offset has to ride the same tilt, or a bush's
            // second blob floats off the side of the slope it is lying on.
            offset.set(lx * cos + lz * sin, part.offsetY * s, -lx * sin + lz * cos).applyQuaternion(align);
            position.set(prop.x + offset.x, heightAt(prop.x, prop.y) + offset.y, prop.y + offset.z);
          }
        }

        scale.set(
          s * (1 + (part.jitterScaleX ?? 0) * wobbleSize),
          s * (part.scaleY ?? 1) * (1 + (part.jitterScaleY ?? 0) * wobbleSize),
          s,
        );
        matrix.compose(position, quaternion, scale).toArray(matrices, i * 16);
        // A uniform prop takes the part's flat tone and neither drift, so two
        // tiles of a run come out identical however far apart they stand.
        color.setHex(
          part.foliage
            ? foliageColor(part.color, part.toneIndex ?? tier ?? 0, prop.tint)
            : prop.uniform
              ? part.uniformColor ?? part.color
              : shadedColor(part.color, prop.tint, part.tintAmount ?? 0, (part.jitterTint ?? 0) * wobbleSize),
        );
        color.toArray(colors, i * 3);

        if (part.sway && variant) {
          // The tree's *ground point*, not this part's origin. Every batch a
          // tree appears in writes the same three numbers here, which is what
          // makes the trunk and the four cones above it lean as one thing.
          const treeHeight = speciesHeight(variant.species) * s;
          swayHeight = Math.max(swayHeight, treeHeight);
          swayReach = Math.max(swayReach, (part.swayReach ?? 0) * s);
          swaying.push({
            baseX: prop.x,
            baseY: heightAt(prop.x, prop.y),
            baseZ: prop.y,
            stiffness: SPECIES_STIFFNESS[variant.species],
            phase: hashUnit2(cellX, cellZ, HASH_WIND_PHASE) * 2 * PHASE_SPREAD - PHASE_SPREAD,
          });
        }
      });

      // A batch sways only when *every* instance in it does. A partial set would
      // put the attributes out of step with the instances they belong to.
      const sway =
        swaying.length === grown.length && swaying.length > 0
          ? { ...packSway(swaying), height: swayHeight, reach: swayReach }
          : null;
      out.push({ group, part: partIndex, count: grown.length, matrices, colors, sway });
    });
  }
  return { batches: out, lights: composeLights(bucket, heightAt), undrawnKinds: [...undrawnKinds] };
}

/**
 * Where the flames are in one region (spec 248).
 *
 * Walks the bucket in its own order and indexes into it, so a key names the same
 * fixture on every rebuild of the same document -- which is what stops a stream
 * event from re-baking every shadow map near the player.
 */
function composeLights(
  bucket: readonly Prop[],
  heightAt: (x: number, z: number) => number,
): readonly RegionLight[] {
  const out: RegionLight[] = [];
  bucket.forEach((prop, index) => {
    const light = fixtureLight(prop);
    if (!light) return;
    const scale = Number.isFinite(prop.scale) ? prop.scale : 1;
    out.push({
      key: `${Math.round(prop.x)}:${Math.round(prop.y)}:${index}`,
      x: prop.x,
      y: heightAt(prop.x, prop.y) + light.height * scale,
      z: prop.y,
      color: light.color,
      brightness: light.brightness,
      // Scaled with the prop, like everything else about it: a campfire dragged
      // out to twice the size is twice the fire, and a reach that stayed put
      // would make the big one look like a picture of a fire rather than one.
      radius: light.radius * scale,
      shadow: light.shadow,
    });
  });
  return out;
}

/** How a field is built, as opposed to what it is built from. */
export interface PropFieldOptions {
  /**
   * Compose nothing now. The handle comes back with its group attached and no
   * batches in it, and regions arrive later through `adoptRegion` (spec 211).
   *
   * For the editor, which pays this whole function in its constructor before it
   * can draw a frame: 4.5s on the map we ship and about half of everything
   * opening the editor costs, at every world size `bench-editor.ts` measures.
   * Deferred, the same regions are composed a few per frame, nearest what the
   * camera is pointed at first.
   *
   * It changes *when* and never *what*: a deferred field drained of everything
   * it owes is the field this would have returned, batch for batch, and there
   * is a test that says so.
   *
   * `undrawn` is deliberately still counted up front. It answers "does this map
   * hold props this build cannot draw", which is a fact about the list rather
   * than about what has been composed so far -- and answering it late would
   * mean a tool looked broken for as long as the region holding the undrawn
   * props had not arrived yet, which is the failure the count exists to prevent.
   */
  readonly deferred?: boolean;
}

/**
 * Build the instanced meshes for a list of scattered props, standing each one on
 * the terrain via `heightAt`. Static: instance matrices are written once, since
 * scenery never moves.
 *
 * `normalAt` is optional and only consulted for props that ask to be aligned to
 * the ground (spec 051). Without it every prop stands upright, whatever it asked
 * for -- so a caller that has no terrain normals to offer degrades to the
 * behaviour that existed before the flag did.
 */
export function buildPropField(
  props: readonly Prop[],
  heightAt: (x: number, z: number) => number,
  normalAt?: NormalAt,
  shading?: PropShading,
  options?: PropFieldOptions,
): PropFieldHandle {
  const group = new THREE.Group();
  const shade = shading ?? FLAT_SHADING;
  const creaseCos = Math.cos(shade.creaseAngle);

  /**
   * One batching region's meshes and the resources only it owns.
   *
   * Kept per region rather than in one flat list, so a region can be freed and
   * rebuilt on its own (spec 086). The geometries and materials are built per
   * batch, so each belongs to exactly one region and freeing it frees them.
   */
  interface Region {
    readonly group: THREE.Group;
    /**
     * This region's geometries, paired with the shared vertex data each borrows
     * (spec 181). The pair is what `disposeShell` needs: free the instanced
     * attributes this batch added, leave the ones every other region is using.
     */
    readonly shells: { shell: THREE.BufferGeometry; shared: THREE.BufferGeometry }[];
    readonly materials: THREE.Material[];
    /** The fixtures standing in it, as composed (spec 248). */
    readonly lights: readonly RegionLight[];
  }
  const regions = new Map<string, Region>();
  let current: Region = { group, shells: [], materials: [], lights: [] };

  /**
   * One `InstancedMesh` per batch, from arrays somebody else composed.
   *
   * What is left here after spec 181 is the half that needs the scene graph:
   * the shell, the material, the mesh, and the sway patch. The 16.2ms of matrix
   * and colour arithmetic that used to sit in the middle of this is
   * {@link buildRegionInstances}, and on the shipped client it runs on the map
   * worker.
   */
  const build = (batch: PropBatchInstances): void => {
    const part = propGroupParts(batch.group)[batch.part];
    if (!part || batch.count === 0) return;

    const shared = sharedGeometry(part.geometry, creaseCos, shade.smooth);
    const geometry = shellOf(shared);
    const material = new THREE.MeshLambertMaterial({ flatShading: !shade.smooth });
    const mesh = new THREE.InstancedMesh(geometry, material, batch.count);
    // Assigned rather than filled, so the arrays the worker transferred are the
    // arrays the attribute holds -- `set` would copy 16 floats per instance back
    // over the boundary the transfer just avoided.
    mesh.instanceMatrix = new THREE.InstancedBufferAttribute(batch.matrices, 16);
    mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(batch.colors, 3);
    // Scenery is the bulk of the shadow pass (spec 045): a canopy that throws
    // dappled shade onto the ground is what stops props reading as decals.
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    if (batch.sway) {
      applySwayBuffers(
        mesh,
        batch.sway.base,
        batch.sway.tune,
        batch.sway.height,
        { lag: part.swayLag ?? 0, tilt: part.swayTilt ?? 0, reach: batch.sway.reach },
        shade.swayNormals,
      );
    }
    current.group.add(mesh);
    current.shells.push({ shell: geometry, shared });
    current.materials.push(material);
  };

  // Group props into square regions, then batch each region's trees (split by
  // species) and bushes separately, so each batch's bounds stay small enough for
  // the camera to cull. Two species is two more batches per region, not two more
  // per tree: the count is set by (region x species x part), never by the props.
  /** Bucket props by the region they stand in. */
  const bucketize = (of: readonly Prop[]): Map<string, Prop[]> => {
    const out = new Map<string, Prop[]>();
    for (const prop of of) {
      const key = propRegionKey(prop.x, prop.y);
      const bucket = out.get(key);
      if (bucket) bucket.push(prop);
      else out.set(key, [prop]);
    }
    return out;
  };

  /** Build one region's batches into a group of its own. */
  const buildRegion = (key: string, bucket: readonly Prop[]): void => {
    adoptRegion(key, buildRegionInstances(bucket, heightAt, normalAt));
  };

  /**
   * Hang one region's batches on the scene graph (spec 181).
   *
   * The seam the map worker enters through: `buildRegion` above composes the
   * instances here and then calls this, and the shipped client has the worker
   * compose them and calls this with what came back. One path either way, so a
   * field built on this thread and one built on the other are the same field by
   * construction rather than by two implementations agreeing.
   */
  const adoptRegion = (key: string, instances: RegionInstances): void => {
    const held = regions.get(key);
    if (held) {
      disposeRegion(held);
      regions.delete(key);
    }
    if (instances.undrawnKinds.length > 0) {
      // Loud, because the alternative is silence: nothing on screen and no error.
      console.warn(`buildPropField: no geometry for ${instances.undrawnKinds.join(', ')}`);
    }
    const batches = instances.batches;
    if (batches.length === 0) return;
    const region: Region = {
      group: new THREE.Group(),
      shells: [],
      materials: [],
      lights: instances.lights,
    };
    current = region;
    for (const batch of batches) build(batch);
    regions.set(key, region);
    group.add(region.group);
  };

  /** Free one region's meshes, the sway patch included. */
  const disposeRegion = (region: Region): void => {
    // The sway patch hangs two shadow materials off each swaying batch that
    // nothing else owns (spec 074), so they are freed with the batch.
    for (const child of region.group.children) {
      if (child instanceof THREE.InstancedMesh) disposeSway(child);
    }
    for (const { shell, shared } of region.shells) disposeShell(shell, shared);
    for (const mat of region.materials) mat.dispose();
    region.group.clear();
    group.remove(region.group);
  };

  const countUndrawn = (of: readonly Prop[]): number => {
    const missing = of.filter((prop) => !DRAWN_KINDS.has(prop.kind));
    if (missing.length > 0) {
      const kinds = [...new Set(missing.map((p) => p.kind))];
      // Loud, because the alternative is silence: nothing on screen and no error.
      console.warn(`buildPropField: no geometry for ${kinds.join(', ')} -- ${missing.length} props not drawn`);
    }
    return missing.length;
  };

  if (!options?.deferred) {
    const buckets = bucketize(props);
    // Sorted, so the scene graph is built in the same order for the same input.
    for (const key of [...buckets.keys()].sort()) buildRegion(key, buckets.get(key) ?? []);
  }

  const handle: PropFieldHandle = {
    group,
    undrawn: countUndrawn(props),
    adoptRegion,
    dropRegion(key): boolean {
      const held = regions.get(key);
      if (!held) return false;
      disposeRegion(held);
      regions.delete(key);
      return true;
    },
    heldRegions(): readonly string[] {
      return [...regions.keys()];
    },
    lights(): readonly RegionLight[] {
      // Region order, and region order is the sorted key order every build path
      // here already walks -- so the list a residency pass is handed does not
      // depend on which region happened to stream in first.
      const out: RegionLight[] = [];
      for (const key of [...regions.keys()].sort()) {
        const held = regions.get(key);
        if (held) out.push(...held.lights);
      }
      return out;
    },
    rebuildWithin(next, rect): void {
      const rects = Array.isArray(rect) ? (rect as readonly PropRect[]) : [rect as PropRect];
      const wanted = new Set<string>();
      for (const one of rects) {
        for (const key of propRegionKeysIn(one)) wanted.add(key);
      }
      if (wanted.size === 0) return;

      // Bucketed over the *wanted* regions only (spec 165 follow-up). A full
      // `bucketize` builds a list for all 66 regions of the grown map to read
      // the handful being rebuilt, and pays it again for `countUndrawn` -- which
      // is the fixed cost that made rebuilding one region nearly as expensive as
      // rebuilding four.
      const fresh = new Map<string, Prop[]>();
      let undrawn = 0;
      for (const prop of next) {
        if (!DRAWN_KINDS.has(prop.kind)) undrawn++;
        const key = propRegionKey(prop.x, prop.y);
        if (!wanted.has(key)) continue;
        const bucket = fresh.get(key);
        if (bucket) bucket.push(prop);
        else fresh.set(key, [prop]);
      }

      for (const key of [...wanted].sort()) {
        // A region emptied by an erase or a removed part is dropped rather than
        // rebuilt as nothing, so the scene graph does not fill with empty
        // groups: `adoptRegion` frees whatever was there and returns.
        buildRegion(key, fresh.get(key) ?? []);
      }
      handle.undrawn = undrawn;
    },
    dispose(): void {
      for (const region of regions.values()) disposeRegion(region);
      regions.clear();
      group.clear();
    },
  };
  return handle;
}
