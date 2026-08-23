/**
 * Which prop regions the ground still justifies (spec 215).
 *
 * Spec 208 made the client forget the ground behind it and said the trees
 * standing on that ground were the same question one level up. This is the
 * answer, and it is one sentence: **a region is drawn because a chunk under it
 * is held, so it is dropped when none is.**
 *
 * Derived from terrain residency rather than given a keep radius of its own,
 * which is what makes it unable to fight the streamer *by construction* --
 * spec 208 had to derive `MAP_CHUNK_KEEP_RADIUS` to buy terrain the same
 * guarantee, where trees can simply follow the ground: they cannot go while it
 * is there, and cannot be asked for before it arrives, because both questions
 * read one held set. A second radius would be a second description of
 * residency, and the interesting thing about a second description is the day it
 * disagrees with the first.
 *
 * A function rather than four lines in `view.ts` because it has *two* callers
 * that must not drift: the drop pass, and the adopt path -- a region asked for
 * on one frame, evicted on the next and delivered on the one after would
 * otherwise be hung on the scene graph behind the drop pass, where nothing
 * would ever take it down again.
 *
 * The held set arrives as a predicate rather than as a `StreamedMap`, so this
 * module knows what a region is and nothing about how ground is stored.
 */

import { propRegionBounds, type PropRect } from '../props.js';

/** Whether any ground under this region is still held. */
export function propRegionHasGround(key: string, holdsAnyIn: (rect: PropRect) => boolean): boolean {
  return holdsAnyIn(propRegionBounds(key));
}

/**
 * Of the regions drawn, the ones with no ground left under them.
 *
 * Given what is actually on the scene graph rather than the chunks that just
 * went, for the reason the terrain reconcile in `view.ts` is written the same
 * way: today the two are the same set -- a region only loses its last ground
 * when a chunk in it is removed -- and reading what is drawn is the version
 * that stays right whatever path a region arrived by.
 */
export function orphanedPropRegions(
  drawn: readonly string[],
  holdsAnyIn: (rect: PropRect) => boolean,
): readonly string[] {
  const out: string[] = [];
  for (const key of drawn) {
    if (propRegionHasGround(key, holdsAnyIn)) continue;
    out.push(key);
  }
  return out;
}
