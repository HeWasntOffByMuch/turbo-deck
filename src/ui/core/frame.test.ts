import { describe, expect, it } from 'vitest';
import { autoUiScale, MIN_TAP_PX, tapCostInUiPixels, uiFrame, UI_SCALES } from './frame.js';

describe('uiFrame', () => {
  it('gives a whole-number scale and an integral viewport', () => {
    for (const scale of UI_SCALES) {
      const frame = uiFrame(1387, 733, 1.5, scale);
      expect(Number.isInteger(frame.scale)).toBe(true);
      expect(Number.isInteger(frame.width)).toBe(true);
      expect(Number.isInteger(frame.height)).toBe(true);
      expect(frame.width).toBeGreaterThan(0);
      expect(frame.height).toBeGreaterThan(0);
    }
  });

  it('divides the DEVICE box, not the CSS box', () => {
    // The whole point of spec 099's arithmetic, restated for the UI: a 960x540
    // CSS box at dpr 2 is 1920x1080 real pixels, so scale 4 leaves 480x270 UI
    // pixels. Deriving from the CSS box would say 240x135 and throw away half
    // the display.
    expect(uiFrame(960, 540, 2, 4)).toMatchObject({ width: 480, height: 270 });
    expect(uiFrame(960, 540, 1, 4)).toMatchObject({ width: 240, height: 135 });
  });

  it('drops the remainder rather than drawing half a UI pixel', () => {
    // 101 device pixels at scale 4 is 25 UI pixels and one left over.
    const frame = uiFrame(101, 101, 1, 4);
    expect(frame.width).toBe(25);
    expect(frame.cssWidth).toBe(100);
  });

  it('never returns a scale below 1, whatever it is handed', () => {
    expect(uiFrame(100, 100, 1, 0).scale).toBe(1);
    expect(uiFrame(100, 100, 1, -3).scale).toBe(1);
    expect(uiFrame(100, 100, 0, 2).scale).toBe(2);
  });
});

describe('tapCostInUiPixels', () => {
  it('gets CHEAPER as the scale rises', () => {
    // The finding that turned the tap-target squeeze into arithmetic: on a phone
    // at dpr 3, a 44 CSS px target is 33 UI pixels at scale 4 and 17 at scale 8.
    expect(tapCostInUiPixels(3, 4)).toBe(33);
    expect(tapCostInUiPixels(3, 8)).toBe(17);
    let previous = Infinity;
    for (const scale of UI_SCALES) {
      const cost = tapCostInUiPixels(3, scale);
      expect(cost).toBeLessThanOrEqual(previous);
      previous = cost;
    }
  });

  it('is the identity at scale 1, dpr 1', () => {
    expect(tapCostInUiPixels(1, 1)).toBe(MIN_TAP_PX);
  });
});

describe('autoUiScale', () => {
  const minViewport = { width: 300, height: 140 };

  it('picks the largest scale whose viewport still holds the minimum', () => {
    const scale = autoUiScale(1920, 1080, 1, { minViewport, coarsePointer: false, maxTapUiPx: 20 });
    expect(uiFrame(1920, 1080, 1, scale).width).toBeGreaterThanOrEqual(minViewport.width);
    // One step larger would no longer fit.
    const next = UI_SCALES[UI_SCALES.indexOf(scale) + 1];
    if (next !== undefined) {
      const bigger = uiFrame(1920, 1080, 1, next);
      expect(bigger.width < minViewport.width || bigger.height < minViewport.height).toBe(true);
    }
  });

  it('on a finger, refuses a scale where a tap target eats the screen', () => {
    // The phone frame preview-touch.ts drives: 844x390 CSS at dpr 3.
    const scale = autoUiScale(844, 390, 3, { minViewport, coarsePointer: true, maxTapUiPx: 20 });
    expect(tapCostInUiPixels(3, scale)).toBeLessThanOrEqual(20);
    const frame = uiFrame(844, 390, 3, scale);
    expect(frame.width).toBeGreaterThanOrEqual(minViewport.width);
    expect(frame.height).toBeGreaterThanOrEqual(minViewport.height);
  });

  it('a mouse on the same screen gets a finer scale than a finger does', () => {
    const options = { minViewport, maxTapUiPx: 20 };
    const finger = autoUiScale(844, 390, 3, { ...options, coarsePointer: true });
    const mouse = autoUiScale(844, 390, 3, { ...options, coarsePointer: false });
    expect(finger).toBeGreaterThanOrEqual(mouse);
  });

  it('falls back to 1 rather than 0 when nothing fits', () => {
    expect(autoUiScale(100, 60, 1, { minViewport, coarsePointer: false, maxTapUiPx: 20 })).toBe(1);
  });
});
