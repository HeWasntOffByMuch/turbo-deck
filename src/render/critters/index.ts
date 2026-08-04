/**
 * The critter registry (spec 049): every playable animal, keyed by id.
 *
 * Adding a species is a new data file plus one line here. Nothing downstream --
 * the rig, the unit picker, the coat swatches, the tests -- enumerates species
 * by hand; they all read {@link CRITTER_IDS}, so a new animal appears in the
 * sandbox, gets contrast-checked against all twelve coats and gets its
 * silhouette measured without any of those files changing.
 */

import { COW } from './cow.js';
import { PIG } from './pig.js';
import type { CritterId, CritterSpecies } from './types.js';

export const CRITTERS: Record<CritterId, CritterSpecies> = {
  pig: PIG,
  cow: COW,
};

/** Every species, in picker order. */
export const CRITTER_IDS: readonly CritterId[] = ['pig', 'cow'];

/** Whether `kind` names a critter species. Narrows a sandbox unit kind. */
export function isCritterId(kind: string): kind is CritterId {
  return kind in CRITTERS;
}

export { COW, PIG };
export * from './types.js';
export { deriveCoat, PLAYER_COATS, swatchFor, MIN_ACCENT_CONTRAST, type CoatSwatch } from './palette.js';
export { contrastRatio, luminance, mix, shade, tint } from './color.js';
export {
  attachmentNames,
  boundsOf,
  boneOrigins,
  partBounds,
  partOrigin,
  resolveParts,
  resolveSockets,
  socketOrigins,
  speciesBounds,
  type Bounds,
  type ResolvedPart,
  type ResolvedSocket,
} from './resolve.js';
