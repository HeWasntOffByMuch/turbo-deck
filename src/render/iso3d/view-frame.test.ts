import { describe, expect, it } from 'vitest';
import { cameraFrustum, cursorToNdc, internalRenderSize, MAX_RENDER_W, REFERENCE_ASPECT, RENDER_H } from './view-frame.js';
import { DEFAULT_VIEW_HALF_WIDTH, MAX_VIEW_HALF_WIDTH, MIN_VIEW_HALF_WIDTH } from './view-settings.js';

describe('internal render size (spec 041)', () => {
  it('keeps a fixed pixel height and takes the window aspect', () => {
    const size = internalRenderSize(1600, 900);
    expect(size.height).toBe(RENDER_H);
    expect(size.width).toBe(Math.round(RENDER_H * (1600 / 900)));
  });

  it('holds pixels square rather than squashing them when the width caps out', () => {
    const size = internalRenderSize(5120, 1440); // ultrawide: past the width cap
    expect(size.width).toBe(MAX_RENDER_W);
    expect(size.width / size.height).toBeCloseTo(5120 / 1440, 1);
    expect(size.height).toBeLessThan(RENDER_H);
  });

  it('falls back to the reference aspect for a degenerate box', () => {
    expect(internalRenderSize(0, 0)).toEqual({ width: Math.round(RENDER_H * REFERENCE_ASPECT), height: RENDER_H });
  });
});

describe('camera frustum (spec 041)', () => {
  it('holds the vertical span constant as the window widens', () => {
    const narrow = cameraFrustum(320, 1.6);
    const wide = cameraFrustum(320, 2.4);
    expect(wide.halfHeight).toBe(narrow.halfHeight);
    expect(wide.halfWidth).toBeGreaterThan(narrow.halfWidth);
  });

  it('reproduces the pre-fullscreen framing at the reference aspect', () => {
    const frustum = cameraFrustum(320, REFERENCE_ASPECT);
    expect(frustum.halfWidth).toBeCloseTo(320, 6);
    expect(frustum.halfHeight).toBeCloseTo(320 / REFERENCE_ASPECT, 6);
  });

  it('opens on the 320-unit framing (spec 044)', () => {
    // Spec 041 doubled the opening span to 640; spec 044 puts it back to 320,
    // which is the framing this describe block's reference case is built on.
    const frustum = cameraFrustum(DEFAULT_VIEW_HALF_WIDTH, REFERENCE_ASPECT);
    expect(frustum.halfWidth).toBeCloseTo(320, 6);
    expect(frustum.halfHeight).toBeCloseTo(320 / REFERENCE_ASPECT, 6);
  });

  it('leaves the default zoom inside the slider it is driven by', () => {
    expect(DEFAULT_VIEW_HALF_WIDTH).toBeGreaterThanOrEqual(MIN_VIEW_HALF_WIDTH);
    expect(DEFAULT_VIEW_HALF_WIDTH).toBeLessThanOrEqual(MAX_VIEW_HALF_WIDTH);
  });
});

describe('cursor to NDC (spec 041)', () => {
  it('maps the corners and centre of the canvas box', () => {
    expect(cursorToNdc(0, 0, 800, 400)).toEqual({ x: -1, y: 1 });
    expect(cursorToNdc(800, 400, 800, 400)).toEqual({ x: 1, y: -1 });
    const centre = cursorToNdc(400, 200, 800, 400);
    expect(centre.x).toBeCloseTo(0, 12);
    expect(centre.y).toBeCloseTo(0, 12); // -0 at the exact centre, which is still centre
  });

  it('does not divide by a zero-sized box', () => {
    expect(Number.isFinite(cursorToNdc(10, 10, 0, 0).x)).toBe(true);
  });
});
