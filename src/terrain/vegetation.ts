import { Rng } from '../shared/prng.js';
import { PLAY_HEIGHT, PLAY_WIDTH } from '../shared/world.js';
import { PLAYER_RADIUS } from '../sim/constants.js';
import type { Circle, Vec2 } from '../sim/types.js';
import { worldMaterialAt } from './classify.js';
import type { TerrainWorld } from './types.js';
import { arenaBounds } from './world.js';

/**
 * Where the world's trees and bushes stand (spec 018/043/044).
 *
 * This used to be renderer-side decoration. It is world data now: since spec 044
 * a trunk blocks a unit and turns a hunter's path, so the sim and the renderer
 * have to be looking at the *same* list -- a tree that is drawn but not blocked
 * (or blocked but not drawn) is a bug either way. It lives here, beside the
 * terrain it grows on, and stays pure: seeded PRNG only, no DOM and no three.js,
 * so the same (seed, world) always yields the same arrangement and the whole
 * thing is unit-testable in Node.
 */

export type PropKind = 'tree' | 'bush';

export interface Prop {
  readonly kind: PropKind;
  /** Position on the sim ground plane, in world units. */
  readonly x: number;
  readonly y: number;
  /** Uniform size multiplier applied to the base mesh. */
  readonly scale: number;
  /** Y-axis spin (radians) so identical meshes don't look stamped. */
  readonly rotation: number;
  /** Small per-instance foliage tint offset, in [-1, 1]. */
  readonly tint: number;
  /**
   * Lie the prop along the ground instead of standing it upright (spec 051).
   *
   * The *intent*, not the resulting tilt. A stored normal would go stale the
   * moment the ground under the prop is sculpted, so the renderer re-resolves
   * this against the terrain every time it builds the field -- exactly as a
   * prop's height already is. Absent means upright, so the generated forest is
   * unaffected.
   */
  readonly alignToNormal?: boolean;
}

export interface ScatterOptions {
  /** How many trees to place. */
  readonly trees: number;
  /** How many bushes to place. */
  readonly bushes: number;
  /** No prop is placed within this radius of any keep-out point. */
  readonly keepOutRadius: number;
  /** No prop is placed within this radius of any already-placed prop. */
  readonly spacing: number;
  /** Inset from the arena edge so nothing clips the border. */
  readonly margin: number;
}

/** The size band a scattered prop is drawn from: `MIN + u * SPAN`. */
const MIN_PROP_SCALE = 0.75;
const PROP_SCALE_SPAN = 0.75;
const MAX_PROP_SCALE = MIN_PROP_SCALE + PROP_SCALE_SPAN;

const DEFAULTS: ScatterOptions = {
  trees: 14,
  bushes: 20,
  keepOutRadius: 160,
  spacing: 70,
  margin: 60,
};

const UNIT = 1 << 24;

/** Draw a float in [0, 1) from the immutable Rng, returning the advanced Rng. */
function nextUnit(rng: Rng): [number, Rng] {
  const [n, next] = rng.nextInt(0, UNIT - 1);
  return [n / UNIT, next];
}

function farEnough(x: number, y: number, points: readonly Vec2[], minDist: number): boolean {
  const min2 = minDist * minDist;
  for (const p of points) {
    const dx = x - p.x;
    const dy = y - p.y;
    if (dx * dx + dy * dy < min2) return false;
  }
  return true;
}

/**
 * Place trees then bushes across the `width` x `height` ground plane, avoiding
 * every `keepOut` point (e.g. the player spawn) and crowding onto each other.
 * Rejection sampling with a bounded attempt budget: deterministic, and it
 * simply stops early rather than looping forever on a dense arena.
 */
export function scatterProps(
  seed: number,
  width: number,
  height: number,
  keepOut: readonly Vec2[],
  options: Partial<ScatterOptions> = {},
): Prop[] {
  const opt = { ...DEFAULTS, ...options };
  let rng = Rng.fromSeed(seed);
  const props: Prop[] = [];
  const placed: Vec2[] = [];

  const place = (kind: PropKind, count: number): void => {
    for (let i = 0; i < count; i++) {
      for (let attempt = 0; attempt < 24; attempt++) {
        let ux: number, uy: number, us: number, ur: number, ut: number;
        [ux, rng] = nextUnit(rng);
        [uy, rng] = nextUnit(rng);
        [us, rng] = nextUnit(rng);
        [ur, rng] = nextUnit(rng);
        [ut, rng] = nextUnit(rng);
        const x = opt.margin + ux * (width - 2 * opt.margin);
        const y = opt.margin + uy * (height - 2 * opt.margin);
        if (!farEnough(x, y, keepOut, opt.keepOutRadius)) continue;
        if (!farEnough(x, y, placed, opt.spacing)) continue;
        props.push({
          kind,
          x,
          y,
          scale: 0.8 + us * 0.6,
          rotation: ur * Math.PI * 2,
          tint: ut * 2 - 1,
        });
        placed.push({ x, y });
        break;
      }
    }
  };

  place('tree', opt.trees);
  place('bush', opt.bushes);
  return props;
}

/**
 * Ground-footprint radius a prop blocks: what the unwalkable overlay draws
 * (spec 034) and, since spec 044, what the sim collides against.
 */
const FOOTPRINT_BASE: Record<PropKind, number> = { tree: 24, bush: 16 };
export function footprintRadius(prop: Prop): number {
  return FOOTPRINT_BASE[prop.kind] * prop.scale;
}

/** The props as sim obstacles: one circle per footprint (spec 044). */
export function vegetationColliders(props: readonly Prop[]): Circle[] {
  return props.map((prop) => ({ x: prop.x, y: prop.y, r: footprintRadius(prop) }));
}

export interface BoundsScatterOptions {
  readonly trees: number;
  readonly bushes: number;
  /**
   * Clear ground left between two props' footprints. The rejection rule is
   * `distance >= footprint(a) + footprint(b) + walkGap`, so it scales with the
   * props being placed rather than being one flat number for all of them.
   */
  readonly walkGap: number;
  /** How many grove centres the props are drawn toward. */
  readonly clusters: number;
  /** How far from its centre a grove's members land. */
  readonly clusterRadius: number;
  /** Fraction of props placed anywhere at all, as lone trees between the groves. */
  readonly strays: number;
  /** Placement attempts per prop before giving up on it. */
  readonly attempts: number;
}

/**
 * Trees enough to make a forest rather than an orchard (spec 045). The old 460
 * over a 4400x4100 world was one tree per ~39,000 square units -- an average
 * spacing near 200 against a crown radius of 34, so no two crowns ever met.
 *
 * `walkGap` is a body's width: two trunks are never left closer together than a
 * unit can walk between. That is *stricter* than the flat 76 it replaces, which
 * let two full-grown trees (footprint 36 apiece) stand 4 units apart and wall
 * the ground off. Scaling to the props being placed is what lets a grove of
 * saplings pack in tight while the big ones keep their room.
 */
const BOUNDS_DEFAULTS: BoundsScatterOptions = {
  trees: 2200,
  bushes: 600,
  walkGap: 2 * PLAYER_RADIUS,
  clusters: 150,
  clusterRadius: 260,
  strays: 0.2,
  attempts: 40,
};

/** A prop already standing: where it is and how much ground it takes. */
interface Placed {
  readonly x: number;
  readonly z: number;
  readonly r: number;
}

/**
 * The props placed so far, bucketed into square cells so a candidate only has
 * to be tested against its neighbours.
 *
 * Worth the machinery at this density: the old scatter compared each of 800
 * candidates against every prop already down, and at 2100 props with 16
 * attempts apiece that quadratic sweep is tens of millions of distance tests
 * every time a scene is built. The cell is sized to the largest separation any
 * pair can demand, so a 3x3 neighbourhood is guaranteed to hold every prop that
 * could possibly conflict.
 */
class PlacementGrid {
  private readonly cells = new Map<number, Placed[]>();

  constructor(private readonly cellSize: number) {}

  private key(col: number, row: number): number {
    // Both coordinates fit a signed 16-bit cell index over any plausible world.
    return ((col & 0xffff) << 16) | (row & 0xffff);
  }

  /** True when nothing nearby is closer than the two footprints plus `gap`. */
  clearFor(x: number, z: number, radius: number, gap: number): boolean {
    const col = Math.floor(x / this.cellSize);
    const row = Math.floor(z / this.cellSize);
    for (let dc = -1; dc <= 1; dc++) {
      for (let dr = -1; dr <= 1; dr++) {
        const bucket = this.cells.get(this.key(col + dc, row + dr));
        if (!bucket) continue;
        for (const p of bucket) {
          const need = radius + p.r + gap;
          const dx = x - p.x;
          const dz = z - p.z;
          if (dx * dx + dz * dz < need * need) return false;
        }
      }
    }
    return true;
  }

  add(x: number, z: number, radius: number): void {
    const key = this.key(Math.floor(x / this.cellSize), Math.floor(z / this.cellSize));
    const bucket = this.cells.get(key);
    if (bucket) bucket.push({ x, z, r: radius });
    else this.cells.set(key, [{ x, z, r: radius }]);
  }
}

/**
 * Cell size for the placement grid: the widest separation the rejection rule
 * can ask for, so a candidate never conflicts with a prop more than one cell
 * away. Two of the largest trees the scatter can grow, plus the gap.
 */
function placementCellSize(walkGap: number): number {
  const widest = Math.max(...Object.values(FOOTPRINT_BASE)) * MAX_PROP_SCALE;
  return 2 * widest + Math.max(0, walkGap);
}

/**
 * Scatter decoration over an arbitrary rectangle, keeping only the points a
 * caller-supplied predicate accepts -- which is how vegetation ends up on the
 * meadows and the low slopes and stays off cliffs, water and the arena floor,
 * without this module knowing anything about terrain.
 *
 * Placement is **clustered**, not uniform. Uniform rejection sampling over an
 * area this large is the reason the world reads as an orchard: every prop is
 * about the same distance from its neighbours, so there are no groves and no
 * clearings, just an even sprinkle. Instead, grove centres are drawn across the
 * bounds and each prop picks one and lands near it, with a minority scattered
 * anywhere at all so single trees still stand in the open.
 *
 * A prop redraws its grove on every attempt, so a centre that landed in the sea
 * or on a cliff costs that prop a try rather than swallowing it -- the predicate
 * and the clustering stay independent, and this module still knows nothing
 * about terrain. The attempt budget is what bounds the work: a hostile
 * predicate makes it place fewer props, never loop forever.
 *
 * Pure and deterministic: seeded PRNG only, so the same (seed, bounds,
 * predicate) always yields the same arrangement.
 */
export function scatterInBounds(
  seed: number,
  minX: number,
  minZ: number,
  maxX: number,
  maxZ: number,
  canPlace: (x: number, z: number) => boolean,
  options: Partial<BoundsScatterOptions> = {},
): Prop[] {
  const opt = { ...BOUNDS_DEFAULTS, ...options };
  let rng = Rng.fromSeed(seed);
  const props: Prop[] = [];
  const placed = new PlacementGrid(placementCellSize(opt.walkGap));
  const width = maxX - minX;
  const depth = maxZ - minZ;

  // Grove centres, drawn up front so every prop is choosing from the same set
  // and the groves come out shared between trees and bushes -- undergrowth
  // belongs under the canopy, not in the gaps between stands.
  const centres: Vec2[] = [];
  for (let i = 0; i < Math.max(1, opt.clusters); i++) {
    let cx: number, cz: number;
    [cx, rng] = nextUnit(rng);
    [cz, rng] = nextUnit(rng);
    centres.push({ x: minX + cx * width, y: minZ + cz * depth });
  }

  const place = (kind: PropKind, count: number): void => {
    for (let i = 0; i < count; i++) {
      for (let attempt = 0; attempt < opt.attempts; attempt++) {
        let uc: number, ua: number, ud: number, us: number, ur: number, ut: number, ustray: number;
        [uc, rng] = nextUnit(rng);
        [ua, rng] = nextUnit(rng);
        [ud, rng] = nextUnit(rng);
        [us, rng] = nextUnit(rng);
        [ur, rng] = nextUnit(rng);
        [ut, rng] = nextUnit(rng);
        [ustray, rng] = nextUnit(rng);

        let x: number;
        let z: number;
        if (ustray < opt.strays) {
          x = minX + uc * width;
          z = minZ + ua * depth;
        } else {
          const centre = centres[Math.min(centres.length - 1, Math.floor(uc * centres.length))] as Vec2;
          // `ud * ud` rather than `sqrt(ud)`: a disc sampled uniformly by area
          // puts most points near its rim, which draws rings rather than
          // groves. Squaring pulls the mass into the middle instead.
          const distance = ud * ud * opt.clusterRadius;
          const angle = ua * Math.PI * 2;
          x = centre.x + Math.cos(angle) * distance;
          z = centre.y + Math.sin(angle) * distance;
          if (x < minX || x > maxX || z < minZ || z > maxZ) continue;
        }

        const prop: Prop = {
          kind,
          x,
          y: z,
          scale: MIN_PROP_SCALE + us * PROP_SCALE_SPAN,
          rotation: ur * Math.PI * 2,
          tint: ut * 2 - 1,
        };
        // Grid first, predicate second: the grid is a handful of distance tests
        // against one 3x3 neighbourhood, while the predicate samples the
        // terrain, and inside a saturated grove most candidates fail the grid.
        const radius = footprintRadius(prop);
        if (!placed.clearFor(x, z, radius, opt.walkGap)) continue;
        if (!canPlace(x, z)) continue;
        props.push(prop);
        placed.add(x, z, radius);
        break;
      }
    }
  };

  // Interleaved rather than all the trees and then all the bushes. Placed in
  // sequence the trees saturate every grove first and the undergrowth has
  // nowhere left to stand -- it ends up only in the clearings, which is exactly
  // backwards. Alternating in proportion lets both claim room in the same pass.
  const total = opt.trees + opt.bushes;
  let treesLeft = opt.trees;
  let bushesLeft = opt.bushes;
  for (let i = 0; i < total; i++) {
    const wantsTree = treesLeft > 0 && (bushesLeft <= 0 || treesLeft * opt.bushes >= bushesLeft * opt.trees);
    if (wantsTree) {
      treesLeft--;
      place('tree', 1);
    } else {
      bushesLeft--;
      place('bush', 1);
    }
  }
  return props;
}

/**
 * How far vegetation stays clear of the play area. The world's dense scatter
 * would otherwise crowd right up to the fight; the play area keeps its own,
 * much sparser one.
 */
export const PLANT_PLAY_AREA_MARGIN = 90;

/**
 * Every tree and bush in the world, for a seed and the terrain they grow on.
 *
 * Two scatters, for two jobs: the play area's own sparse stand, kept clear of
 * the spawn at its centre, and a much denser spread across the surrounding
 * world, filtered to ground that would actually grow something -- meadow and
 * worn earth, never a cliff face, a snowfield or open water.
 *
 * One function, because there is now one answer: the renderer batches this list
 * into its instanced field and the sim takes the same list as obstacles.
 */
export function worldVegetation(seed: number, world: TerrainWorld): Prop[] {
  const playArea = scatterProps(seed, PLAY_WIDTH, PLAY_HEIGHT, [{ x: PLAY_WIDTH / 2, y: PLAY_HEIGHT / 2 }]);
  const bounds = arenaBounds();
  const surrounding = scatterInBounds(
    seed ^ 0x9e3779b1,
    bounds.minX,
    bounds.minZ,
    bounds.maxX,
    bounds.maxZ,
    (x, z) => {
      if (
        x > -PLANT_PLAY_AREA_MARGIN &&
        x < PLAY_WIDTH + PLANT_PLAY_AREA_MARGIN &&
        z > -PLANT_PLAY_AREA_MARGIN &&
        z < PLAY_HEIGHT + PLANT_PLAY_AREA_MARGIN
      ) {
        return false;
      }
      const material = worldMaterialAt(world, x, z);
      return material === 'grass' || material === 'dirt';
    },
  );
  return [...playArea, ...surrounding];
}
