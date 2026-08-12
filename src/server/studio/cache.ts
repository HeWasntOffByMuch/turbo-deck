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

/**
 * Bumped when a change on *our* side changes what the API sends back.
 *
 * The cache key covers everything about the request a caller chooses. It cannot
 * cover what the client itself sends, and that turns out to matter: adding
 * `rig_type` to the rig call changed every rig from a generic numbered-limb
 * skeleton to a named biped, with the same image, the same parameters and
 * therefore the same key. Without this, the first regeneration after that fix
 * would have been answered from the cache with the artifacts it was meant to
 * replace -- and reported as free, which is how somebody concludes the fix did
 * not work.
 *
 * Bump it only for a change that alters the *output*, never for a refactor.
 * Every bump makes the whole library miss and costs real credits, so it is a
 * deliberate act with a line in the history saying why.
 *
 * 2 -- `rig_type` is sent (spec 116's investigation); rigs before it are
 *      generic skeletons that no unit document can address.
 */
export const PIPELINE_REVISION = 2;

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
    // The rig identity, because a different skeleton spec is a different set of
    // artifacts start to finish -- different bone names, so different clips
    // bound to them. Without it, flipping `TRIPO_RIG_SPEC` and regenerating
    // returns the job made with the old one and reports it as free.
    `rig=${params.rigModelVersion}/${params.rigSpec}`,
    `format=${params.outFormat}`,
    `pipeline=${PIPELINE_REVISION}`,
    `clips=${clips}`,
  ].join('|');
}
