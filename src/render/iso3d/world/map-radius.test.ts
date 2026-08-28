/**
 * The chunk request window has to cover what the camera can frame (spec 072).
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

import {
  MAP_CHUNK_BURST,
  MAP_CHUNK_REFILL_PER_SECOND,
  MAP_CHUNK_REQUEST_RADIUS,
} from '../../../server/config.js';
import { CHUNK_REQUESTS_PER_PASS } from '../../../server/client/game-client.js';
import { cameraFrustum, internalRenderSize } from '../view-frame.js';
import { loadMapFile } from '../../../server/world/map-file.js';
import {
  DEFAULT_CAMERA_OFFSET,
  DEFAULT_VIEW_HALF_WIDTH,
  MAX_VIEW_HALF_WIDTH,
  SUPPORTED_MAX_VIEW_HALF_WIDTH,
  offsetToOrbit,
} from '../view-settings.js';

/** The chunk edge the shipped map actually uses, rather than an assumed one. */
const doc = loadMapFile().doc;
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

  it('reaches past what the widest *supported* zoom frames', () => {
    const reach = groundReach(SUPPORTED_MAX_VIEW_HALF_WIDTH);
    expect(GUARANTEED_REACH).toBeGreaterThan(reach.x);
    expect(GUARANTEED_REACH).toBeGreaterThan(reach.y);
  });

  it('reaches past the widest supported zoom on a 32:9 monitor', () => {
    const reach = groundReach(SUPPORTED_MAX_VIEW_HALF_WIDTH, 3840, 1080);
    expect(GUARANTEED_REACH).toBeGreaterThan(reach.x);
    expect(GUARANTEED_REACH).toBeGreaterThan(reach.y);
  });

  it('does not cover the slider\'s own maximum, which is a dev setting', () => {
    // Spec 202. Past the supported band terrain outside the window is a hole
    // with the sky through it -- the worse of the two degradations, and exactly
    // what the Display page's warning has to name.
    expect(groundReach(MAX_VIEW_HALF_WIDTH, 3840, 1080).x).toBeGreaterThan(GUARANTEED_REACH);
  });

  it('is sized for a band the default zoom is inside of', () => {
    expect(DEFAULT_VIEW_HALF_WIDTH).toBeLessThanOrEqual(SUPPORTED_MAX_VIEW_HALF_WIDTH);
    expect(SUPPORTED_MAX_VIEW_HALF_WIDTH).toBeLessThanOrEqual(MAX_VIEW_HALF_WIDTH);
  });
});

describe('the chunk budget covers the request radius', () => {
  /**
   * The relationship spec 165 restored, asserted rather than typed in.
   *
   * The burst has to cover every chunk the radius is *allowed* to ask for, or a
   * cold start spends the difference at the refill rate -- which is what a
   * 64-chunk burst did the moment the map grew past it, and what the constant's
   * own comment had predicted it would. Sized off the map, this would break
   * again on the next map; sized off the radius, only widening the radius can
   * re-open it, and that fails here.
   */
  it('bursts at least the whole request window', () => {
    const window = (2 * MAP_CHUNK_REQUEST_RADIUS + 1) ** 2;
    expect(MAP_CHUNK_BURST).toBeGreaterThanOrEqual(window);
  });

  it('lets the client ask a whole pass without meeting the bucket', () => {
    // The relationship the client's own pacing comment claims and nothing
    // asserted: a pass sized above the burst would make the server's throttle
    // the thing that shapes a cold start, which is exactly what it is not for.
    // Spec 202 narrowed the radius and moved the burst underneath this number,
    // which is how it was found.
    expect(CHUNK_REQUESTS_PER_PASS).toBeLessThanOrEqual(MAP_CHUNK_BURST);
  });

  it('would still bound a client asking for one chunk forever', () => {
    // The case the bucket was written for. It is only a guard if the sustained
    // rate stays far below what a burst costs.
    expect(MAP_CHUNK_REFILL_PER_SECOND).toBeLessThan(MAP_CHUNK_BURST);
  });
});
