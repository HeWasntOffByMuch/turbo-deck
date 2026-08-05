/**
 * The server's view of the ground (spec 056).
 *
 * Narrowed to the one question movement validation asks -- "how high is the
 * ground here" -- so the sim depends on an interface it can be handed a flat
 * plane for in a test, rather than on the terrain generator. The real adapter
 * is three lines at the bottom.
 */

import type { TerrainWorld } from '../../terrain/types.js';
import { WATER_LEVEL } from '../../terrain/world.js';

export interface TerrainSampler {
  /**
   * Ground height at a world point. `y` here is the ground-plane second axis --
   * what the terrain module calls `z`. See {@link import('../state/types.js').Vec3}.
   */
  heightAt(x: number, y: number): number;
}

/** A featureless plane, for tests and for a server booted without terrain. */
export const FLAT_TERRAIN: TerrainSampler = { heightAt: () => 0 };

/**
 * The steepest single-tick climb a body may make. A move that would gain more
 * height than this is a cliff, and refusing it is what stops a client walking
 * up a wall -- the heightfield half of collision, next to the collider half in
 * `src/sim/collision.ts`.
 */
export const MAX_STEP_HEIGHT = 24;

/** Ground at or below this is deep water; nothing walks there. */
export const WALKABLE_MIN_HEIGHT = WATER_LEVEL;

export function terrainSamplerFrom(world: TerrainWorld): TerrainSampler {
  return { heightAt: (x, y) => world.heightAt(x, y) };
}
