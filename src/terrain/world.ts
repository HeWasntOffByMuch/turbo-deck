import { createLayer, type TerrainFeature } from './features.js';
import { createWorld, type Rect, type TerrainWorld } from './types.js';

/**
 * The first authored world (spec 043): one ground layer, hand-placed, that
 * exercises every part of the foundation while leaving combat alone.
 *
 * The shape of it: the play area sits on a broad, gently rolling rise crossed by
 * two worn paths and dipped by one shallow valley — all low relief, because the
 * sim is still flat and the fight has to stay readable. Everything dramatic is
 * pushed into the surrounding bleed the camera frames but the player never
 * reaches: a terraced rocky mesa east, a snow-capped range north, a lower range
 * west, a lake, and a sea in the south-east with two islands standing out of it.
 * That ring is the backdrop today and the first thing exploration opens up later.
 *
 * The islands are worth noting because of what they *don't* need: a hill placed
 * inside a flooded basin is already a natural island. Only terrain with nothing
 * under it — a floating island, a sea arch — needs the solidity mask.
 *
 * The numbers below are the tuning surface. Nothing here is generated — the
 * point of the exercise is that a hand-authored world and a procedural one are
 * the same list of features, so a generator can be dropped in later without the
 * representation, the meshing, or the classification changing.
 */

export interface ArenaWorldOptions {
  /** The sim's playable rectangle, from (0, 0). */
  readonly playWidth: number;
  readonly playHeight: number;
  /** How far the terrain extends past the play area on all sides. */
  readonly bleed: number;
}

/**
 * `bleed` matches the ground the flat slab used to cover: at the widest zoom the
 * camera reaches well over a thousand units past a player standing on the arena's
 * edge, and terrain has to be there when it does.
 */
export const DEFAULT_ARENA_WORLD: ArenaWorldOptions = { playWidth: 1200, playHeight: 900, bleed: 1600 };

/** Sea level. Below the play area's lowest ground, so only the basins flood. */
export const WATER_LEVEL = -60;
/** Underside of the ground layer; open edges skirt down to it. */
const BASE_Y = -260;
/**
 * World-wide terracing, kept deliberately light. Terracing a *shallow* slope
 * spreads each riser over a huge horizontal band -- run it hard here and the
 * gentle play area comes out banded in contour lines rather than shelved. So the
 * global pass only firms up the ground's structure, and the dramatic strata are
 * left to the mesa and the ranges, whose own terracing has hundreds of units of
 * relief to bite on and produces narrow, readable risers.
 */
const TERRACE = { step: 30, strength: 0.35 };

export function arenaBounds(opt: ArenaWorldOptions = DEFAULT_ARENA_WORLD): Rect {
  return {
    minX: -opt.bleed,
    minZ: -opt.bleed,
    maxX: opt.playWidth + opt.bleed,
    maxZ: opt.playHeight + opt.bleed,
  };
}

/**
 * Feature list for the ground layer. Order matters: heights sum, but region tags
 * apply in sequence, so the paths come last and stay visible wherever they run.
 */
function arenaFeatures(opt: ArenaWorldOptions): TerrainFeature[] {
  const cx = opt.playWidth / 2;
  const cz = opt.playHeight / 2;
  return [
    // Base variation: enough to kill the "flat slab" read, small enough that
    // nothing in the play area becomes a wall.
    { kind: 'rolling', amplitude: 15, params: { frequency: 1 / 340, octaves: 3 } },

    // The play area rides on a broad soft rise, so the arena reads as raised
    // land with the world falling away around it rather than a cut-out.
    { kind: 'hill', x: cx, z: cz, radius: 980, edge: 520, height: 48 },
    // ...dipped by one shallow valley and lifted by one knoll: slopes, a low
    // point and a high point, all inside a ~90-unit band.
    { kind: 'basin', x: 400, z: 620, radius: 320, edge: 280, depth: 32 },
    { kind: 'hill', x: 890, z: 250, radius: 250, edge: 210, height: 28 },

    // East: a terraced mesa. Flat top, stratified flanks, tagged rocky so the
    // top is bare stone even where it is level.
    {
      kind: 'plateau',
      x: 1850,
      z: 300,
      radius: 700,
      edge: 420,
      height: 200,
      terraceStep: 30,
      terraceStrength: 0.8,
    },
    // North: a snow-capped range. The crest is noise-modulated so it isn't a
    // smooth extruded arc, and it crosses the snow line only at its highest.
    {
      kind: 'ridge',
      from: [-700, -900],
      to: [1100, -1050],
      width: 520,
      height: 460,
      terraceStep: 60,
      terraceStrength: 0.6,
      craggy: 0.45,
    },
    // West: a lower, barer range — rock rather than snow, so the two read apart.
    {
      kind: 'ridge',
      from: [-1250, -200],
      to: [-1050, 800],
      width: 420,
      height: 300,
      terraceStep: 60,
      terraceStrength: 0.6,
      craggy: 0.5,
    },
    // South-west: a basin deep enough to flood, giving a lake with a sand shore.
    { kind: 'basin', x: -520, z: 1700, radius: 620, edge: 420, depth: 190 },
    // South-east: open sea, with two hills inside it that clear the water line —
    // natural islands, out of the same two pieces as everything else.
    { kind: 'basin', x: 2100, z: 1900, radius: 940, edge: 520, depth: 210 },
    { kind: 'hill', x: 2120, z: 1860, radius: 270, edge: 190, height: 300 },
    { kind: 'hill', x: 1720, z: 2150, radius: 160, edge: 115, height: 260 },

    // Worn routes across the play area, carved shallow and tagged as dirt.
    // Narrow: a trail someone walks, not a road -- two wide ones meeting at the
    // arena's centre read as one big clearing rather than as routes.
    {
      kind: 'path',
      points: [
        [80, 140],
        [360, 330],
        [640, 470],
        [900, 600],
        [1120, 780],
      ],
      width: 38,
      depth: 7,
    },
    {
      kind: 'path',
      points: [
        [640, 470],
        [760, 240],
        [880, 60],
        [980, -160],
      ],
      width: 30,
      depth: 6,
    },
  ];
}

/** Build the arena world for a seed. Pure: same seed → identical terrain. */
export function createArenaWorld(seed: number, opt: ArenaWorldOptions = DEFAULT_ARENA_WORLD): TerrainWorld {
  return createWorld([
    createLayer({
      id: 'ground',
      bounds: arenaBounds(opt),
      baseY: BASE_Y,
      waterLevel: WATER_LEVEL,
      seed,
      features: arenaFeatures(opt),
      terrace: TERRACE,
    }),
  ]);
}
