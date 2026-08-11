/**
 * The server's view of the ground (spec 056).
 *
 * Narrowed to the one question movement validation asks -- "how high is the
 * ground here" -- so the sim depends on an interface it can be handed a flat
 * plane for in a test, rather than on the terrain generator. The real adapter
 * is three lines at the bottom.
 */

import { MAX_STEP_HEIGHT, WALKABLE_MIN_HEIGHT } from '../../sim/constants.js';
import type { TerrainWorld } from '../../terrain/types.js';

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
 * The walkability contract, re-exported from where it now lives (spec 130).
 *
 * Both numbers moved into `src/sim/constants.ts` when the router started having
 * to refuse exactly the steps this file's callers refuse. They are still named
 * here because this is where the server's half of the question is asked, and
 * because moving a constant should not be a diff across a dozen call sites.
 */
export { MAX_STEP_HEIGHT, WALKABLE_MIN_HEIGHT };

export function terrainSamplerFrom(world: TerrainWorld): TerrainSampler {
  return { heightAt: (x, y) => world.heightAt(x, y) };
}
