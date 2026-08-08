import { describe, expect, it } from 'vitest';
import {
  cameraFrustum,
  cursorToNdc,
  internalRenderSize,
  MAX_RENDER_W,
  pixelFrame,
  REFERENCE_ASPECT,
  RENDER_H,
  snapToPixelGrid,
  worldPerPixel,
} from './view-frame.js';
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

describe('pixelFrame (spec 095)', () => {
  it('picks the factor from device pixels, not CSS pixels', () => {
    // The whole point. Both boxes are 1920x1080 real pixels and must both come
    // out at 4x; choosing from the CSS box would give the retina one 2x, throw
    // away half the display, and still resample.
    const plain = pixelFrame(1920, 1080, 1, 480, 270);
    const retina = pixelFrame(960, 540, 2, 480, 270);
    expect(plain.scale).toBe(4);
    expect(retina.scale).toBe(4);
  });

  it('fills a display that fits exactly, with no letterbox', () => {
    const frame = pixelFrame(1920, 1080, 1, 480, 270);
    expect(frame.cssWidth).toBe(1920);
    expect(frame.cssHeight).toBe(1080);
    expect(frame.offsetX).toBe(0);
    expect(frame.offsetY).toBe(0);
  });

  it('is sized in whole device pixels at every ratio', () => {
    for (const dpr of [1, 2, 3]) {
      for (const [w, h] of [[1280, 720], [1000, 700], [1366, 768], [837, 611]] as const) {
        const frame = pixelFrame(w, h, dpr, 480, 270);
        expect(Number.isInteger(Math.round(frame.cssWidth * dpr))).toBe(true);
        expect(frame.cssWidth * dpr).toBeCloseTo(480 * frame.scale, 6);
        expect(frame.cssHeight * dpr).toBeCloseTo(270 * frame.scale, 6);
      }
    }
  });

  it('starts on a whole device pixel, so the browser never resamples', () => {
    // Half of an odd remainder is half a device pixel, which is enough to blur
    // the whole image while every size involved is still integral.
    for (const dpr of [1, 2, 3]) {
      for (const w of [1001, 1002, 1003, 1237]) {
        const frame = pixelFrame(w, 713, dpr, 480, 270);
        expect(frame.offsetX * dpr).toBeCloseTo(Math.round(frame.offsetX * dpr), 6);
        expect(frame.offsetY * dpr).toBeCloseTo(Math.round(frame.offsetY * dpr), 6);
      }
    }
  });

  it('letterboxes the remainder rather than stretching into it', () => {
    // 1600x900 at dpr 1 fits 3x (1440x810); the rest is bars.
    const frame = pixelFrame(1600, 900, 1, 480, 270);
    expect(frame.scale).toBe(3);
    expect(frame.cssWidth).toBe(1440);
    expect(frame.cssHeight).toBe(810);
    expect(frame.offsetX).toBe(80);
    expect(frame.offsetY).toBe(45);
  });

  it('never letterboxes negatively, and never drops below 1x', () => {
    // A window smaller than one virtual pixel per pixel clips instead of
    // shrinking the buffer -- the virtual resolution is an input, never an output.
    const tiny = pixelFrame(200, 100, 1, 480, 270);
    expect(tiny.scale).toBe(1);
    expect(tiny.offsetX).toBe(0);
    expect(tiny.offsetY).toBe(0);
  });

  it('survives a degenerate box and a nonsense ratio', () => {
    expect(pixelFrame(0, 0, 0, 480, 270).scale).toBe(1);
    expect(pixelFrame(-5, -5, -1, 480, 270).scale).toBe(1);
  });

  it('holds the virtual resolution whatever the window does', () => {
    // Restated as a property: the shown size is always an exact whole multiple
    // of the virtual size in device pixels, at every window size.
    for (let w = 400; w <= 2600; w += 137) {
      const frame = pixelFrame(w, 800, 2, 480, 270);
      expect((frame.cssWidth * 2) / frame.scale).toBeCloseTo(480, 6);
      expect((frame.cssHeight * 2) / frame.scale).toBeCloseTo(270, 6);
    }
  });
});

describe('snapToPixelGrid (spec 095)', () => {
  const right = { x: 1, y: 0, z: 0 };
  const up = { x: 0, y: 1, z: 0 };

  it('moves the camera onto the pixel lattice', () => {
    const snapped = snapToPixelGrid({ x: 10.3, y: 20.7, z: 5 }, right, up, 1);
    expect(snapped.x).toBeCloseTo(10, 9);
    expect(snapped.y).toBeCloseTo(21, 9);
  });

  it('leaves the view-direction component exactly alone', () => {
    // The clip planes are measured along it; nudging it would move near and far.
    const snapped = snapToPixelGrid({ x: 10.3, y: 20.7, z: 5.37 }, right, up, 1);
    expect(snapped.z).toBe(5.37);
  });

  it('is idempotent', () => {
    const once = snapToPixelGrid({ x: 10.3, y: 20.7, z: 5 }, right, up, 4);
    const twice = snapToPixelGrid(once, right, up, 4);
    expect(twice.x).toBeCloseTo(once.x, 9);
    expect(twice.y).toBeCloseTo(once.y, 9);
  });

  it('never moves further than half a pixel along either axis', () => {
    for (let i = 0; i < 50; i++) {
      const p = { x: i * 0.37 - 9, y: i * 0.61 + 3, z: 0 };
      const snapped = snapToPixelGrid(p, right, up, 2.5);
      expect(Math.abs(snapped.x - p.x)).toBeLessThanOrEqual(1.25 + 1e-9);
      expect(Math.abs(snapped.y - p.y)).toBeLessThanOrEqual(1.25 + 1e-9);
    }
  });

  it('snaps along the camera axes, not the world axes', () => {
    // An isometric camera's right vector is diagonal in world space, so a snap
    // that quantized world x and z would land the image between pixels.
    const s = Math.SQRT1_2;
    const diagRight = { x: s, y: 0, z: -s };
    const diagUp = { x: 0, y: 1, z: 0 };
    const snapped = snapToPixelGrid({ x: 3.3, y: 0, z: 1.1 }, diagRight, diagUp, 1);
    const along = snapped.x * diagRight.x + snapped.z * diagRight.z;
    expect(along).toBeCloseTo(Math.round(along), 9);
  });

  it('does nothing for a nonsense step', () => {
    const p = { x: 1.5, y: 2.5, z: 3.5 };
    expect(snapToPixelGrid(p, right, up, 0)).toBe(p);
    expect(snapToPixelGrid(p, right, up, Number.NaN)).toBe(p);
  });
});

describe('worldPerPixel (spec 095)', () => {
  it('divides the span across the virtual buffer', () => {
    expect(worldPerPixel(960, 480)).toBe(2);
  });

  it('is positive whichever way the span is signed', () => {
    expect(worldPerPixel(-960, 480)).toBe(2);
  });
});
