/**
 * The chunk request window has to cover what the camera can frame (spec 070).
 *
 * The sibling of `interest.test.ts`, and it lives here for the same reason: this
 * is the only place both facts are importable, since the server may not import
 * the renderer. The failure it guards against is worse than the one that test
 * guards against — a monster outside the interest window winks out, but terrain
 * outside *this* window is a hole in the world with the skybox showing through.
 *
 * It asserts the relationship, not the number. Widening the zoom without
 * widening the request radius fails here rather than in someone's game.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import { MAP_CHUNK_REQUEST_RADIUS } from '../../../server/config.js';
import { parseMap } from '../../../terrain/map.js';
import { cameraFrustum, internalRenderSize } from '../view-frame.js';
import {
  DEFAULT_CAMERA_OFFSET,
  DEFAULT_VIEW_HALF_WIDTH,
  MAX_VIEW_HALF_WIDTH,
  offsetToOrbit,
} from '../view-settings.js';

/** The chunk edge the shipped map actually uses, rather than an assumed one. */
const doc = parseMap(readFileSync('maps/arena.json', 'utf8'));
const CHUNK_EXTENT = doc.grid.cellSize * doc.grid.chunkCells;

/**
 * The nearest edge of the request window, in world units.
 *
 * The *guaranteed* reach: a player pressed against the far edge of their own
 * chunk still gets `radius` whole chunks beyond it, and no more. Terrain that is
 * only sometimes loaded is worse than terrain that never is, because it means
 * the hole appears when the player walks rather than when they log in.
 */
const GUARANTEED_REACH = CHUNK_EXTENT * MAP_CHUNK_REQUEST_RADIUS;

function groundReach(halfWidth: number, windowWidth = 1920, windowHeight = 1080): {
  x: number;
  y: number;
} {
  const size = internalRenderSize(windowWidth, windowHeight);
  const frustum = cameraFrustum(halfWidth, size.width / size.height);
  const elevation = offsetToOrbit(DEFAULT_CAMERA_OFFSET).elevation;
  return { x: frustum.halfWidth, y: frustum.halfHeight / Math.sin(elevation) };
}

describe('the chunk request radius covers the camera', () => {
  it('reaches past what the default zoom frames', () => {
    const reach = groundReach(DEFAULT_VIEW_HALF_WIDTH);
    expect(GUARANTEED_REACH).toBeGreaterThan(reach.x);
    expect(GUARANTEED_REACH).toBeGreaterThan(reach.y);
  });

  it('reaches past what the widest zoom frames', () => {
    const reach = groundReach(MAX_VIEW_HALF_WIDTH);
    expect(GUARANTEED_REACH).toBeGreaterThan(reach.x);
    expect(GUARANTEED_REACH).toBeGreaterThan(reach.y);
  });

  it('reaches past the widest zoom on a 32:9 monitor', () => {
    const reach = groundReach(MAX_VIEW_HALF_WIDTH, 3840, 1080);
    expect(GUARANTEED_REACH).toBeGreaterThan(reach.x);
    expect(GUARANTEED_REACH).toBeGreaterThan(reach.y);
  });
});
