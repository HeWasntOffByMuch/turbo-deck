/**
 * How big the world is, in world units -- the one place both halves of the game
 * agree on it (spec 044).
 *
 * The sim bounds movement by the world's outer edge and stages the fight in the
 * play area; the terrain grows ground across exactly the same rectangle. Those
 * two have to be the same numbers -- ground the sim will not let you walk on, or
 * walkable space with no ground under it, are both bugs -- so they live here
 * rather than being written down twice.
 */

/** The play area: where the fight is staged, and where enemies spawn and graze. */
export const PLAY_WIDTH = 1200;
export const PLAY_HEIGHT = 900;

/**
 * How far the world extends past the play area on every side. At the widest
 * zoom the camera reaches well over a thousand units past a unit standing on the
 * play area's edge, and there has to be ground there when it does.
 */
export const WORLD_BLEED = 1600;

export const WORLD_MIN_X = -WORLD_BLEED;
export const WORLD_MIN_Y = -WORLD_BLEED;
export const WORLD_MAX_X = PLAY_WIDTH + WORLD_BLEED;
export const WORLD_MAX_Y = PLAY_HEIGHT + WORLD_BLEED;
