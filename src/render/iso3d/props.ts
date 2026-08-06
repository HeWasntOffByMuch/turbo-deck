import * as THREE from 'three';
import { PALETTE } from './palette.js';
import { hashUnit2 } from '../../shared/hash.js';
import { FENCE_KINDS, FENCE_TILE_LENGTH, type FenceKind, type Prop } from '../../terrain/vegetation.js';
import { applySway, bakeBend, disposeSway, type SwayInstance } from './sway.js';
import { stiffness } from './wind.js';

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
 * Edge of one batching region, in world units. Big enough that the view holds
 * only a few (so the draw-call count stays low), small enough that a region is
 * a meaningful fraction of what is on screen (so culling actually bites).
 */
const REGION_SIZE = 1100;

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

/** Fraction of trees that are pines rather than firs. */
const PINE_SHARE = 0.38;

export type TreeSpecies = 'fir' | 'pine';

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

interface SpeciesShape {
  /** Trunk box: a square column this wide. Its height is derived, below. */
  readonly trunkWidth: number;
  readonly tiers: readonly (readonly [radius: number, height: number, baseY: number])[];
  /** The tier counts an instance may take; the hash picks one, so repeats weight it. */
  readonly tierCounts: readonly number[];
  readonly driftMax: number;
  readonly leanMax: number;
}

const SPECIES: Record<TreeSpecies, SpeciesShape> = {
  fir: { trunkWidth: 12, tiers: FIR_TIERS, tierCounts: [2, 3, 3, 4], driftMax: 5, leanMax: 0.1 },
  // Fewer, wider, floppier fronds on a long bare trunk -- and leaning harder,
  // since a drooping frond is most of what tells the two apart at this size.
  pine: { trunkWidth: 12, tiers: PINE_TIERS, tierCounts: [2, 2, 3], driftMax: 9, leanMax: 0.19 },
};

/** Sides on a tier's cone. */
const CONE_SEGMENTS = 7;
/**
 * A cone's `radius` is the circumradius of that heptagon, so over a flat face
 * the foliage only reaches this fraction of it from the axis -- and a flat face
 * is what the trunk has to hide behind.
 */
const CONE_COVER = Math.cos(Math.PI / CONE_SEGMENTS);

/** Slack on the band edges, so a cone's own base does not round its way out of it. */
const EPSILON = 1e-6;

/** How far a tier may swing off the trunk's axis at full asymmetry. */
function tierSway(shape: SpeciesShape, tier: number): { drift: number; lean: number } {
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
 */
function tierCover(shape: SpeciesShape, tier: number, y: number, asymmetry: number): number {
  const tierSpec = shape.tiers[tier];
  if (!tierSpec) return -Infinity;
  const [radius, height, baseY] = tierSpec;
  const centre = baseY + height / 2;
  const sway = tierSway(shape, tier);
  const lean = sway.lean * asymmetry;
  const dy = y - centre;
  const along = height / 2 + dy / Math.cos(lean);
  if (along < -EPSILON || along > height + EPSILON) return -Infinity;
  const reach = radius * (1 - Math.min(Math.max(along, 0), height) / height) * CONE_COVER;
  const offAxis = Math.abs(sway.drift * asymmetry) + Math.abs(dy * Math.tan(lean));
  return reach - offAxis - (shape.trunkWidth / 2) * Math.SQRT2;
}

/** Foliage left to spare around the trunk's buried top, in prop-local units. */
const TRUNK_BURIAL = 2;

/**
 * How tall the trunk stands -- derived, not authored, because where it *ends*
 * is not a free choice. A trunk is a solid column that stops in mid-air, so
 * unless its top is buried inside a frond the cap and its corners hang out
 * through the cone's sloped side: the bug this replaces stood the fir's trunk
 * up to 86, where the frond around it has narrowed to a 3-unit radius, and the
 * top 5 units of column stuck out into open air on every fir in the world.
 *
 * So the trunk grows to the highest point its own species still covers: the
 * last height where a tier's cone clears the trunk's corner with room to spare,
 * at the worst lean and drift an instance can take (|asymmetry| = 1, which is
 * the worst case -- both terms only grow with it). Only the tiers *every*
 * instance grows count, since a two-tier sapling has no crown to hide in.
 */
function buriedTrunkHeight(shape: SpeciesShape): number {
  const guaranteed = Math.min(...shape.tierCounts);
  let best = 0;
  for (let tier = 0; tier < guaranteed; tier++) {
    const [, height, baseY] = shape.tiers[tier] ?? [0, 0, 0];
    // The tier leans about its own centre, so its base sits here rather than at
    // `baseY`. A cone narrows with height far faster than leaning slides it
    // sideways, so cover falls off monotonically from that base to the tip: a
    // tier covers the trunk at all only if it covers it down there, and one
    // bisection then finds the height where it stops.
    const centre = baseY + height / 2;
    let lo = centre - (height / 2) * Math.cos(tierSway(shape, tier).lean);
    let hi = baseY + height;
    if (tierCover(shape, tier, lo, 1) < TRUNK_BURIAL) continue;
    for (let i = 0; i < 48; i++) {
      const mid = (lo + hi) / 2;
      if (tierCover(shape, tier, mid, 1) >= TRUNK_BURIAL) lo = mid;
      else hi = mid;
    }
    best = Math.max(best, lo);
  }
  return best;
}

const TRUNK_HEIGHT: Record<TreeSpecies, number> = {
  fir: buriedTrunkHeight(SPECIES.fir),
  pine: buriedTrunkHeight(SPECIES.pine),
};

/** How tall a species' trunk box stands, in prop-local units (before scale). */
export function trunkHeight(species: TreeSpecies): number {
  return TRUNK_HEIGHT[species];
}

/**
 * How deep inside the canopy the top of this tree's trunk sits, in prop-local
 * units. Positive means the foliage hides it; negative means the trunk clips
 * out through a frond. Scale-free: the trunk, the tiers and the drift all scale
 * with the prop together, so one number answers for every size it can grow to.
 */
export function trunkTopCover(variant: TreeVariant): number {
  const shape = SPECIES[variant.species];
  const y = TRUNK_HEIGHT[variant.species];
  let best = -Infinity;
  const grown = Math.min(variant.tierCount, shape.tiers.length);
  for (let tier = 0; tier < grown; tier++) {
    best = Math.max(best, tierCover(shape, tier, y, variant.asymmetry));
  }
  return best;
}

/** The tier counts an instance of a species may grow. */
export function speciesTierCounts(species: TreeSpecies): readonly number[] {
  return SPECIES[species].tierCounts;
}

function treeParts(species: TreeSpecies): PropPart[] {
  const shape = SPECIES[species];
  const trunkWidth = shape.trunkWidth;
  const height = trunkHeight(species);
  // The bend weight is measured against the tallest the species reaches, not
  // against the part, so the trunk and the crown above it lie on one continuous
  // curve rather than each running 0..1 within itself.
  const full = speciesHeight(species);
  const parts: PropPart[] = [
    {
      geometry: new THREE.BoxGeometry(trunkWidth, height, trunkWidth),
      offsetY: height / 2,
      color: PALETTE.trunk,
      foliage: false,
      sway: true,
    },
  ];
  shape.tiers.forEach(([radius, tierHeight, baseY], tier) => {
    const sway = tierSway(shape, tier);
    parts.push({
      geometry: new THREE.ConeGeometry(radius, tierHeight, CONE_SEGMENTS),
      offsetY: baseY + tierHeight / 2,
      color: TIER_COLORS[Math.min(tier, TIER_COLORS.length - 1)] ?? PALETTE.leafMid,
      foliage: true,
      tier,
      driftMax: sway.drift,
      leanMax: sway.lean,
      sway: true,
    });
  });
  for (const part of parts) bakeBend(part.geometry, part.offsetY, full);
  return parts;
}

/**
 * How stiff each species is, from its trunk against its full height. Both
 * conifers carry the same 12-unit trunk today, so the two answers are within a
 * hair of each other -- the term is here because a species that grows a stouter
 * trunk should sway less for it, and that should not need a second edit here to
 * take effect.
 */
const SPECIES_STIFFNESS: Record<TreeSpecies, number> = {
  fir: stiffness(SPECIES.fir.trunkWidth / 2, speciesHeight('fir')),
  pine: stiffness(SPECIES.pine.trunkWidth / 2, speciesHeight('pine')),
};

/**
 * Seconds either side of the shared clock a tree's own sway may sit. Small: the
 * travelling wave is what should decorrelate a grove, and a large offset would
 * dissolve the wave into noise. This only breaks the tie between two trees the
 * wave reaches at the same moment.
 */
const PHASE_SPREAD = 0.25;

function bushParts(): PropPart[] {
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

/** Boxes merged into one buffer, wound so every face points out of its box. */
function brickGeometry(boxes: readonly Box[]): THREE.BufferGeometry {
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
      geometry: brickGeometry(boxes),
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

function fenceParts(kind: FenceKind): PropPart[] {
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
  const species: TreeSpecies = hashUnit2(x, z, HASH_SPECIES) < PINE_SHARE ? 'pine' : 'fir';
  const counts = SPECIES[species].tierCounts;
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
  const crown = shape.tiers.reduce((high, [, height, baseY]) => Math.max(high, baseY + height), 0);
  return Math.max(crown, trunkHeight(species));
}

/**
 * How much bare trunk stands below the lowest foliage, in prop-local units.
 * The number this whole reshape is about: it used to be zero.
 */
export function bareTrunkHeight(species: TreeSpecies): number {
  return SPECIES[species].tiers[0]?.[2] ?? 0;
}

/** The widest a species' crown gets, for reasoning about canopy overlap. */
export function crownRadius(species: TreeSpecies): number {
  return SPECIES[species].tiers.reduce((wide, [radius]) => Math.max(wide, radius), 0);
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
  readonly undrawn: number;
  dispose(): void;
}

/** The kinds `buildPropField` knows how to draw. */
const DRAWN_KINDS: ReadonlySet<string> = new Set<string>(['tree', 'bush', ...FENCE_KINDS]);

/** The unit surface normal of the ground, for props that lie along it. */
export type NormalAt = (x: number, z: number) => readonly [number, number, number];

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
): PropFieldHandle {
  const group = new THREE.Group();
  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];

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

  /**
   * One `InstancedMesh` per part, over the props that actually grow it. A tier
   * above a tree's count is left out of that batch rather than written at zero
   * scale, so a stand of saplings costs a small batch instead of a full-size one
   * padded with degenerate triangles.
   */
  const build = (
    parts: readonly PropPart[],
    of: readonly Prop[],
    variants?: ReadonlyMap<Prop, TreeVariant>,
  ): void => {
    if (of.length === 0) return;
    parts.forEach((part, partIndex) => {
      const tier = part.tier;
      const grown =
        tier === undefined || !variants ? of : of.filter((prop) => (variants.get(prop)?.tierCount ?? 0) > tier);
      if (grown.length === 0) return;
      const jitterPos = part.jitterX !== undefined || part.jitterZ !== undefined;
      const jitterRot = part.jitterYaw !== undefined || part.jitterRoll !== undefined;
      const jitterSize =
        part.jitterScaleX !== undefined || part.jitterScaleY !== undefined || part.jitterTint !== undefined;

      const material = new THREE.MeshLambertMaterial({ flatShading: true });
      const mesh = new THREE.InstancedMesh(part.geometry, material, grown.length);
      mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
      // Scenery is the bulk of the shadow pass (spec 045): a canopy that throws
      // dappled shade onto the ground is what stops props reading as decals.
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      // What the wind is sampled with, once per tree (spec 074). Gathered
      // alongside the matrices rather than in a second pass, because it is the
      // same three numbers the matrix is being composed from.
      const swaying: SwayInstance[] = [];
      let swayHeight = 0;

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
        mesh.setMatrixAt(i, matrix.compose(position, quaternion, scale));
        // A uniform prop takes the part's flat tone and neither drift, so two
        // tiles of a run come out identical however far apart they stand.
        color.setHex(
          part.foliage
            ? foliageColor(part.color, tier ?? 0, prop.tint)
            : prop.uniform
              ? part.uniformColor ?? part.color
              : shadedColor(part.color, prop.tint, part.tintAmount ?? 0, (part.jitterTint ?? 0) * wobbleSize),
        );
        mesh.setColorAt(i, color);

        if (part.sway && variant) {
          // The tree's *ground point*, not this part's origin. Every batch a
          // tree appears in writes the same three numbers here, which is what
          // makes the trunk and the four cones above it lean as one thing.
          const treeHeight = speciesHeight(variant.species) * s;
          swayHeight = Math.max(swayHeight, treeHeight);
          swaying.push({
            baseX: prop.x,
            baseY: heightAt(prop.x, prop.y),
            baseZ: prop.y,
            stiffness: SPECIES_STIFFNESS[variant.species],
            phase: hashUnit2(cellX, cellZ, HASH_WIND_PHASE) * 2 * PHASE_SPREAD - PHASE_SPREAD,
          });
        }
      });

      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      if (swaying.length === grown.length && swaying.length > 0) {
        applySway(mesh, swaying, swayHeight);
      }
      group.add(mesh);
      geometries.push(part.geometry);
      materials.push(material);
    });
  };

  // Group props into square regions, then batch each region's trees (split by
  // species) and bushes separately, so each batch's bounds stay small enough for
  // the camera to cull. Two species is two more batches per region, not two more
  // per tree: the count is set by (region x species x part), never by the props.
  const regions = new Map<string, Prop[]>();
  for (const prop of props) {
    const key = `${Math.floor(prop.x / REGION_SIZE)},${Math.floor(prop.y / REGION_SIZE)}`;
    const bucket = regions.get(key);
    if (bucket) bucket.push(prop);
    else regions.set(key, [prop]);
  }
  // Sorted, so the scene graph is built in the same order for the same input.
  for (const key of [...regions.keys()].sort()) {
    const bucket = regions.get(key) ?? [];
    // Hashed once per tree rather than once per part per tree.
    const variants = new Map<Prop, TreeVariant>();
    const trees = bucket.filter((p) => p.kind === 'tree');
    for (const tree of trees) variants.set(tree, treeVariant(tree));
    for (const species of ['fir', 'pine'] as const) {
      build(treeParts(species), trees.filter((p) => variants.get(p)?.species === species), variants);
    }
    build(bushParts(), bucket.filter((p) => p.kind === 'bush'));
    // Fences batch per region and per style like everything else. A tile carries
    // no variant: what makes one differ from the next is its own tint and the
    // per-part jitter hashed from where it stands.
    for (const kind of FENCE_KINDS) {
      build(fenceParts(kind), bucket.filter((p) => p.kind === kind));
    }
  }

  const undrawn = props.filter((prop) => !DRAWN_KINDS.has(prop.kind)).length;
  if (undrawn > 0) {
    const kinds = [...new Set(props.filter((p) => !DRAWN_KINDS.has(p.kind)).map((p) => p.kind))];
    // Loud, because the alternative is silence: nothing on screen and no error.
    console.warn(`buildPropField: no geometry for ${kinds.join(', ')} -- ${undrawn} props not drawn`);
  }

  return {
    group,
    undrawn,
    dispose(): void {
      // The sway patch hangs two shadow materials off each swaying batch that
      // nothing else owns (spec 074), so they are freed with the batch.
      for (const child of group.children) {
        if (child instanceof THREE.InstancedMesh) disposeSway(child);
      }
      for (const geo of geometries) geo.dispose();
      for (const mat of materials) mat.dispose();
      group.clear();
    },
  };
}
