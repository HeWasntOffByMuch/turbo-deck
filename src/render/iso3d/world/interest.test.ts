/**
 * The interest window has to cover what the camera can frame.
 *
 * Reported as "units disappear when they're far enough from the player", and it
 * was: `CHUNK_SIZE` 100 with `INTEREST_CHUNK_RADIUS` 3 reached 300 to 400 world
 * units, while the camera framed +-320 by +-441 at its *default* zoom and +-1400
 * by +-1927 at its widest. Bodies winked out well inside the frame at every zoom.
 *
 * This lives on the render side because it is the only place both facts are
 * importable -- the server may not import the renderer, and the camera is the
 * renderer's. It asserts the *relationship* rather than the numbers, so widening
 * the zoom without widening interest fails here rather than in someone's game.
 */

import { describe, expect, it } from 'vitest';
import { CHUNK_SIZE, INTEREST_CHUNK_RADIUS } from '../../../server/config.js';
import { cameraFrustum, internalRenderSize } from '../view-frame.js';
import {
  DEFAULT_CAMERA_OFFSET,
  DEFAULT_VIEW_HALF_WIDTH,
  MAX_VIEW_HALF_WIDTH,
  SUPPORTED_MAX_VIEW_HALF_WIDTH,
  offsetToOrbit,
} from '../view-settings.js';

/**
 * The nearest edge of the interest window, in world units.
 *
 * The *guaranteed* reach, not the best case: a player standing at the far edge
 * of their own chunk sees `radius` whole chunks beyond it, and no more. Anything
 * further is only sometimes visible, which is worse than never.
 */
const GUARANTEED_INTEREST = CHUNK_SIZE * INTEREST_CHUNK_RADIUS;

/** How much ground the camera covers at a zoom, in world units from the centre. */
function groundReach(halfWidth: number, windowWidth = 1920, windowHeight = 1080): {
  x: number;
  y: number;
} {
  const size = internalRenderSize(windowWidth, windowHeight);
  const frustum = cameraFrustum(halfWidth, size.width / size.height);
  const elevation = offsetToOrbit(DEFAULT_CAMERA_OFFSET).elevation;
  return {
    x: frustum.halfWidth,
    // The camera is tilted, so a vertical span on screen covers more ground than
    // it does in camera space. This is the axis that was being clipped.
    y: frustum.halfHeight / Math.sin(elevation),
  };
}

describe('interest covers the camera', () => {
  it('reaches past what the default zoom frames', () => {
    const reach = groundReach(DEFAULT_VIEW_HALF_WIDTH);
    expect(GUARANTEED_INTEREST).toBeGreaterThan(reach.x);
    expect(GUARANTEED_INTEREST).toBeGreaterThan(reach.y);
  });

  it('reaches past what the widest *supported* zoom frames', () => {
    const reach = groundReach(SUPPORTED_MAX_VIEW_HALF_WIDTH);
    expect(GUARANTEED_INTEREST).toBeGreaterThan(reach.x);
    expect(GUARANTEED_INTEREST).toBeGreaterThan(reach.y);
  });

  /**
   * Every window shape a real monitor comes in, at the widest zoom.
   *
   * `internalRenderSize` trades height rather than capping the aspect past 2.53,
   * so horizontal reach keeps growing with the window and there is no absolute
   * ceiling to test against -- 32:9 is simply where monitors stop.
   */
  it('is not asked to cover the slider\'s own maximum, which is a dev setting', () => {
    // Spec 201: the slider still reaches `MAX_VIEW_HALF_WIDTH`, and past the
    // supported band bodies wink out inside the frame. That is the degradation
    // the Display page names rather than a bug, and it is written down here so
    // that the gap between the two constants is a stated fact rather than a
    // test somebody deleted.
    expect(groundReach(MAX_VIEW_HALF_WIDTH).x).toBeGreaterThan(GUARANTEED_INTEREST);
  });

  it('is sized for a band the default zoom is inside of', () => {
    // Without this, raising the default past the supported cap would ship
    // visible holes in an ordinary configuration while the setting describes
    // them as dev-only.
    expect(DEFAULT_VIEW_HALF_WIDTH).toBeLessThanOrEqual(SUPPORTED_MAX_VIEW_HALF_WIDTH);
    expect(SUPPORTED_MAX_VIEW_HALF_WIDTH).toBeLessThanOrEqual(MAX_VIEW_HALF_WIDTH);
  });

  it.each([
    ['16:10 laptop', 1280, 800],
    ['16:9', 1920, 1080],
    ['21:9 ultrawide', 3440, 1440],
    ['32:9 superwide', 3840, 1080],
    ['tall portrait', 1080, 1920],
  ])('covers a %s window at the widest supported zoom', (_label, width, height) => {
    const reach = groundReach(SUPPORTED_MAX_VIEW_HALF_WIDTH, width, height);
    expect(GUARANTEED_INTEREST).toBeGreaterThan(reach.x);
    expect(GUARANTEED_INTEREST).toBeGreaterThan(reach.y);
  });

  /**
   * A sanity floor on the other side: an interest window many times the widest
   * shot is replicating the whole map to everyone, which is a different bug.
   * Generous, because right now the world genuinely is smaller than the camera.
   */
  it('is not absurdly wider than it needs to be', () => {
    const reach = groundReach(MAX_VIEW_HALF_WIDTH);
    expect(GUARANTEED_INTEREST).toBeLessThan(Math.max(reach.x, reach.y) * 4);
  });
});
