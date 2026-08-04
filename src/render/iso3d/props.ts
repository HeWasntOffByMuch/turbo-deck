import * as THREE from 'three';
import { PALETTE } from './palette.js';
import { hashUnit2 } from '../../shared/hash.js';
import type { Prop } from '../../terrain/vegetation.js';

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
  const parts: PropPart[] = [
    {
      geometry: new THREE.BoxGeometry(trunkWidth, height, trunkWidth),
      offsetY: height / 2,
      color: PALETTE.trunk,
      foliage: false,
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
    });
  });
  return parts;
}

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

/** Warm autumn foliage, for the fraction of trees that turn. */
const AUTUMN = [0xb8502a, 0xd0722c, 0xe0a334] as const;
/** Tint above which a prop goes autumn. ~18% of them, so it stays an accent. */
const AUTUMN_ABOVE = 0.64;

/**
 * The colour one instance of a foliage part takes. Most props only drift a
 * little either side of the base green; the ones past the autumn threshold swap
 * to the warm ramp instead, keeping the same dark-to-bright tier ordering.
 */
function foliageColor(base: number, tier: number, tint: number): number {
  if (tint > AUTUMN_ABOVE) return AUTUMN[Math.min(tier, AUTUMN.length - 1)] ?? base;
  const scale = 0.88 + 0.24 * ((tint + 1) / 2);
  const r = Math.min(255, Math.round(((base >> 16) & 0xff) * scale));
  const g = Math.min(255, Math.round(((base >> 8) & 0xff) * scale));
  const b = Math.min(255, Math.round((base & 0xff) * scale));
  return (r << 16) | (g << 8) | b;
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
  dispose(): void;
}

/**
 * Build the instanced meshes for a list of scattered props, standing each one on
 * the terrain via `heightAt`. Static: instance matrices are written once, since
 * scenery never moves.
 */
export function buildPropField(props: readonly Prop[], heightAt: (x: number, z: number) => number): PropFieldHandle {
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
    for (const part of parts) {
      const tier = part.tier;
      const grown =
        tier === undefined || !variants ? of : of.filter((prop) => (variants.get(prop)?.tierCount ?? 0) > tier);
      if (grown.length === 0) continue;

      const material = new THREE.MeshLambertMaterial({ flatShading: true });
      const mesh = new THREE.InstancedMesh(part.geometry, material, grown.length);
      mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
      // Scenery is the bulk of the shadow pass (spec 045): a canopy that throws
      // dappled shade onto the ground is what stops props reading as decals.
      mesh.castShadow = true;
      mesh.receiveShadow = true;

      grown.forEach((prop, i) => {
        const s = prop.scale;
        const variant = variants?.get(prop);
        const asymmetry = variant?.asymmetry ?? 0;

        // Local offset, scaled with the prop and spun by its rotation. The
        // per-instance drift rides in that same local frame, so a leaning tree
        // leans consistently however it happens to be turned.
        const lx = ((part.offsetX ?? 0) + (part.driftMax ?? 0) * asymmetry) * s;
        const lz = (part.offsetZ ?? 0) * s;
        const cos = Math.cos(prop.rotation);
        const sin = Math.sin(prop.rotation);
        position.set(
          prop.x + lx * cos - lz * sin,
          heightAt(prop.x, prop.y) + part.offsetY * s,
          prop.y + lx * sin + lz * cos,
        );

        quaternion.setFromAxisAngle(up, prop.rotation);
        const lean = (part.leanMax ?? 0) * asymmetry;
        if (lean !== 0 && variant) {
          leanAxis.set(Math.cos(variant.leanAngle), 0, Math.sin(variant.leanAngle));
          quaternion.multiply(tilt.setFromAxisAngle(leanAxis, lean));
        }

        scale.set(s, s * (part.scaleY ?? 1), s);
        mesh.setMatrixAt(i, matrix.compose(position, quaternion, scale));
        color.setHex(part.foliage ? foliageColor(part.color, tier ?? 0, prop.tint) : part.color);
        mesh.setColorAt(i, color);
      });

      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      group.add(mesh);
      geometries.push(part.geometry);
      materials.push(material);
    }
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
  }

  return {
    group,
    dispose(): void {
      for (const geo of geometries) geo.dispose();
      for (const mat of materials) mat.dispose();
      group.clear();
    },
  };
}
