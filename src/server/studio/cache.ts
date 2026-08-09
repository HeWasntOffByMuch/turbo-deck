/**
 * The cache key (spec 108): identical request in, existing asset out, nothing
 * spent.
 *
 * A **readable canonical string** rather than a hash of one. The cache key ends
 * up in `jobs.json` and in log lines, and the only time anybody reads either is
 * when a paid job has gone wrong -- at which point "why did this miss the cache"
 * is answerable by looking at two strings side by side, instead of by
 * reconstructing two hashes. The image's own sha256 is already a hash and does
 * the collision-resistance work; the rest is plain text.
 *
 * The rule for what belongs in the key: **anything that changes what comes
 * back.** The unit's id does not -- generating the same image at the same face
 * limit gives the same mesh whether it is called `grunt` or `archer`, and
 * charging twice for the rename would be exactly the waste this exists to stop.
 */

import type { GenerationParams } from './types.js';

/**
 * Clip intents are sorted, so the same set requested in a different order is
 * the same key. Requesting `[idle, run]` and `[run, idle]` produces the same
 * clips and must not produce two bills.
 */
export function canonicalClipIntents(intents: readonly string[]): readonly string[] {
  return [...new Set(intents)].sort();
}

export function cacheKey(referenceImageSha256: string, params: GenerationParams): string {
  const clips = canonicalClipIntents(params.clipIntents).join(',');
  // Ordered fields with explicit names, so a new parameter added to
  // `GenerationParams` and forgotten here is visible in a diff of this line
  // rather than silently sharing a key with the old behaviour.
  return [
    `img=${referenceImageSha256}`,
    `model=${params.modelVersion}`,
    `faces=${params.faceLimit}`,
    `texture=${params.texture ? 1 : 0}`,
    `pbr=${params.pbr ? 1 : 0}`,
    `orient=${params.orientation}`,
    `format=${params.outFormat}`,
    `clips=${clips}`,
  ].join('|');
}
