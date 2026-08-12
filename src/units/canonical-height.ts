/**
 * How tall a body is in this world (spec 115).
 *
 * `(cow.metrics.headY 69 + headRadius 10.5) * PLAYER_FIGURE.bodyScale 0.7`, which
 * is the height the renderer has drawn a player at since long before units were
 * authored. World units, not metres -- a terrain chunk is 616 across.
 *
 * It lived in `assets/units/biped.skeleton.json` and nowhere else, which made it
 * a property of one hand-written document rather than of the game: a second rig
 * family had no way to reach it except by copying the number, and the authoring
 * server could not derive a skeleton at all without a skeleton to read it from.
 * So it is here, where the deterministic core, the studio config and the
 * renderer's own reference silhouette can all name the same constant.
 *
 * `src/render/iso3d/world/unit-scale.test.ts` is what stops it drifting from the
 * figure the renderer actually draws.
 */
export const DEFAULT_CANONICAL_HEIGHT = 55.65;
