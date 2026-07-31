import { Rng } from '../shared/prng.js';
import { PLAY_HEIGHT, PLAY_WIDTH } from '../shared/world.js';
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
  /** No prop is placed within this radius of any already-placed prop. */
  readonly spacing: number;
  /** Placement attempts per prop before giving up on it. */
  readonly attempts: number;
}

const BOUNDS_DEFAULTS: BoundsScatterOptions = { trees: 460, bushes: 340, spacing: 76, attempts: 14 };

/**
 * Scatter decoration over an arbitrary rectangle, keeping only the points a
 * caller-supplied predicate accepts -- which is how vegetation ends up on the
 * meadows and the low slopes and stays off cliffs, water and the arena floor,
 * without this module knowing anything about terrain.
 *
 * Same rejection sampling as {@link scatterProps}, with a bounded attempt budget
 * so a hostile predicate makes it place fewer props rather than loop forever.
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
  const placed: Vec2[] = [];
  const width = maxX - minX;
  const depth = maxZ - minZ;

  const place = (kind: PropKind, count: number): void => {
    for (let i = 0; i < count; i++) {
      for (let attempt = 0; attempt < opt.attempts; attempt++) {
        let ux: number, uz: number, us: number, ur: number, ut: number;
        [ux, rng] = nextUnit(rng);
        [uz, rng] = nextUnit(rng);
        [us, rng] = nextUnit(rng);
        [ur, rng] = nextUnit(rng);
        [ut, rng] = nextUnit(rng);
        const x = minX + ux * width;
        const z = minZ + uz * depth;
        if (!canPlace(x, z)) continue;
        if (!farEnough(x, z, placed, opt.spacing)) continue;
        props.push({ kind, x, y: z, scale: 0.75 + us * 0.75, rotation: ur * Math.PI * 2, tint: ut * 2 - 1 });
        placed.push({ x, y: z });
        break;
      }
    }
  };

  place('tree', opt.trees);
  place('bush', opt.bushes);
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
