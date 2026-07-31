/**
 * The terrain foundation (spec 043): pure, deterministic world data with no
 * rendering dependency. `src/render/iso3d/terrain-mesh.ts` is the only thing
 * that turns any of it into geometry.
 */
export * from './types.js';
export * from './shaping.js';
export * from './features.js';
export * from './classify.js';
export * from './chunk.js';
export * from './world.js';
