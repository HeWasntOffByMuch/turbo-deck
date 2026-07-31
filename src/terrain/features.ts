import {
  distToPolyline,
  distToSegment,
  fbm,
  radialFalloff,
  terrace,
  type FbmParams,
} from './shaping.js';
import type { Rect, TerrainLayer, TerrainRegion, TerrainSample } from './types.js';

/**
 * Authored terrain features (spec 043) — the vocabulary a world is written in.
 *
 * Features are *data*, not closures, so a world reads as a literal that can be
 * reviewed, diffed, and one day loaded from a file or emitted by a generator.
 * Height contributions sum; region tags apply in list order so a later feature
 * wins (a path drawn last stays visible where it crosses a mesa); solidity
 * masks are unioned.
 *
 * This is deliberately hand-crafting rather than terrain simulation: the shapes
 * are placed on purpose and noise only roughens them, which is what keeps the
 * world readable and charming instead of uniformly bumpy.
 */

export type Point2 = readonly [number, number];

/** Low-amplitude fractal variation across the whole layer — the base "not flat". */
export interface RollingFeature {
  readonly kind: 'rolling';
  /** Peak deviation either side of 0, in world units. */
  readonly amplitude: number;
  readonly params?: Partial<FbmParams>;
}

/** A smooth rounded rise. Small = a knoll, large and shallow = a whole plain lifted. */
export interface HillFeature {
  readonly kind: 'hill';
  readonly x: number;
  readonly z: number;
  readonly radius: number;
  /** Width of the soft rim inside `radius` where it eases back to the surroundings. */
  readonly edge: number;
  readonly height: number;
}

/** A smooth depression: a valley, a bowl, or the bed a lake sits in. */
export interface BasinFeature {
  readonly kind: 'basin';
  readonly x: number;
  readonly z: number;
  readonly radius: number;
  readonly edge: number;
  readonly depth: number;
}

/** A flat-topped rise with terraced flanks — a mesa, a cliff shelf, high rocky ground. */
export interface PlateauFeature {
  readonly kind: 'plateau';
  readonly x: number;
  readonly z: number;
  readonly radius: number;
  readonly edge: number;
  readonly height: number;
  /** Terrace tread height; 0 disables terracing. */
  readonly terraceStep: number;
  /** 0 = smooth flanks, 1 = hard steps. */
  readonly terraceStrength: number;
  /** Mask weight above which the ground is tagged `rocky`. */
  readonly rockyAbove?: number;
}

/** A mountain spine along a segment: the building block for ranges and peaks. */
export interface RidgeFeature {
  readonly kind: 'ridge';
  readonly from: Point2;
  readonly to: Point2;
  /** Half-width of the range's footprint. */
  readonly width: number;
  readonly height: number;
  readonly terraceStep: number;
  readonly terraceStrength: number;
  /** Fraction of the peak height modulated by noise, so the crest isn't a smooth arc. */
  readonly craggy?: number;
  readonly rockyAbove?: number;
}

/** A worn route: carves a shallow trough along a polyline and tags it `path`. */
export interface PathFeature {
  readonly kind: 'path';
  readonly points: readonly Point2[];
  /** Half-width of the tagged surface. */
  readonly width: number;
  /** How far the route is worn down into the terrain. */
  readonly depth: number;
  readonly tagAbove?: number;
}

/**
 * A solidity mask: where any mask feature is present the layer has ground, and
 * where none is, it has none. A layer with no mask features is solid across its
 * whole bounds. This is what makes islands — and, on a raised layer, floating
 * islands — expressible without changing the representation.
 */
export interface IslandMaskFeature {
  readonly kind: 'islandMask';
  readonly x: number;
  readonly z: number;
  readonly radius: number;
  readonly edge: number;
  /** Mask weight above which ground exists. */
  readonly solidAbove?: number;
}

export type TerrainFeature =
  | RollingFeature
  | HillFeature
  | BasinFeature
  | PlateauFeature
  | RidgeFeature
  | PathFeature
  | IslandMaskFeature;

interface Accum {
  height: number;
  region: TerrainRegion;
  mask: number;
  hasMask: boolean;
}

/** Roughen a ridge crest so a range isn't a smooth extruded arc. */
function craggyScale(x: number, z: number, seed: number, amount: number): number {
  if (amount <= 0) return 1;
  return 1 - amount + amount * fbm(x, z, seed + 7717, { octaves: 3, frequency: 1 / 210, lacunarity: 2.3, gain: 0.55 });
}

function applyFeature(acc: Accum, f: TerrainFeature, x: number, z: number, seed: number): void {
  switch (f.kind) {
    case 'rolling': {
      const n = fbm(x, z, seed, { octaves: 3, frequency: 1 / 300, lacunarity: 2.1, gain: 0.5, ...f.params });
      acc.height += (n * 2 - 1) * f.amplitude;
      return;
    }
    case 'hill': {
      const w = radialFalloff(Math.hypot(x - f.x, z - f.z), f.radius, f.edge);
      acc.height += f.height * w;
      return;
    }
    case 'basin': {
      const w = radialFalloff(Math.hypot(x - f.x, z - f.z), f.radius, f.edge);
      acc.height -= f.depth * w;
      return;
    }
    case 'plateau': {
      const w = radialFalloff(Math.hypot(x - f.x, z - f.z), f.radius, f.edge);
      if (w <= 0) return;
      acc.height += terrace(f.height * w, f.terraceStep, f.terraceStrength);
      if (w >= (f.rockyAbove ?? 0.35)) acc.region = 'rocky';
      return;
    }
    case 'ridge': {
      const d = distToSegment(x, z, f.from[0], f.from[1], f.to[0], f.to[1]);
      const w = radialFalloff(d, f.width, f.width * 0.92);
      if (w <= 0) return;
      const peak = f.height * craggyScale(x, z, seed, f.craggy ?? 0);
      acc.height += terrace(peak * w, f.terraceStep, f.terraceStrength);
      if (w >= (f.rockyAbove ?? 0.3)) acc.region = 'rocky';
      return;
    }
    case 'path': {
      const w = radialFalloff(distToPolyline(x, z, f.points), f.width, f.width * 0.55);
      if (w <= 0) return;
      acc.height -= f.depth * w;
      if (w >= (f.tagAbove ?? 0.3)) acc.region = 'path';
      return;
    }
    case 'islandMask': {
      acc.hasMask = true;
      const w = radialFalloff(Math.hypot(x - f.x, z - f.z), f.radius, f.edge);
      const solidAbove = f.solidAbove ?? 0.5;
      // Track the strongest mask, normalised so the union's threshold is 0.5.
      acc.mask = Math.max(acc.mask, w >= solidAbove ? 1 : 0);
      return;
    }
  }
}

export interface LayerDef {
  readonly id: string;
  readonly bounds: Rect;
  readonly baseY: number;
  readonly waterLevel: number | null;
  readonly seed: number;
  /** Applied in order: heights sum, later region tags win, masks union. */
  readonly features: readonly TerrainFeature[];
  /** Constant added to every height, i.e. the layer's nominal ground level. */
  readonly elevation?: number;
  /**
   * World-wide terracing of the composed height — the art-direction knob for the
   * whole layer. Individual features shape their own contribution; this quantises
   * the *result*, so every slope in the layer comes out as flat treads separated
   * by short risers instead of a smooth ramp. It is what makes the world read as
   * stacked stylized shelves rather than a gently dented sheet, and it lands the
   * classifier's slope test squarely on the risers, so cliff faces turn to rock
   * while the treads above and below stay grass.
   */
  readonly terrace?: { readonly step: number; readonly strength: number };
}

/**
 * Build a layer whose field is the composition of its features. Sampling is
 * pure and allocation-light; nothing is cached, because `chunk.ts` samples each
 * point once and there is no runtime editing yet.
 */
export function createLayer(def: LayerDef): TerrainLayer {
  return {
    id: def.id,
    bounds: def.bounds,
    seed: def.seed,
    baseY: def.baseY,
    waterLevel: def.waterLevel,
    sample(x: number, z: number): TerrainSample {
      const acc: Accum = { height: def.elevation ?? 0, region: 'default', mask: 0, hasMask: false };
      for (const f of def.features) applyFeature(acc, f, x, z, def.seed);
      const height = def.terrace ? terrace(acc.height, def.terrace.step, def.terrace.strength) : acc.height;
      return { height, solid: acc.hasMask ? acc.mask >= 0.5 : true, region: acc.region };
    },
  };
}
