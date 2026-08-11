import { describe, expect, it } from 'vitest';
import {
  autoUiScale,
  MIN_TAP_PX,
  resolveUiScale,
  tapCostInUiPixels,
  uiFrame,
  UI_SCALES,
} from './frame.js';

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

  /**
   * The floor is not the target (spec 131's correction).
   *
   * Maximising the scale against `minViewport` makes the interface as chunky as
   * it can possibly be by construction -- on a 1280x800 tab that is scale 4 and a
   * viewport of exactly the minimum, which put two windows across the whole
   * screen with the game barely visible behind them.
   */
  describe('with a comfort viewport', () => {
    const comfortViewport = { width: minViewport.width * 2, height: minViewport.height * 2 };
    const options = { minViewport, comfortViewport, coarsePointer: false, maxTapUiPx: 20 };

    it('halves the scale on the two screens that matter', () => {
      expect(autoUiScale(1280, 800, 1, { minViewport, coarsePointer: false, maxTapUiPx: 20 })).toBe(4);
      expect(autoUiScale(1280, 800, 1, options)).toBe(2);

      expect(autoUiScale(1920, 1080, 1, { minViewport, coarsePointer: false, maxTapUiPx: 20 })).toBe(6);
      expect(autoUiScale(1920, 1080, 1, options)).toBe(3);
    });

    it('leaves the comfortable viewport actually comfortable', () => {
      const frame = uiFrame(1280, 800, 1, autoUiScale(1280, 800, 1, options));
      expect(frame.width).toBeGreaterThanOrEqual(comfortViewport.width);
      expect(frame.height).toBeGreaterThanOrEqual(comfortViewport.height);
    });

    /**
     * The floor is enforced beside the comfort, not replaced by it, so a comfort
     * set too small cannot make the interface chunkier than every screen was
     * designed to survive. It is the one thing a single-viewport rule would have
     * quietly given up.
     */
    it('will not go chunkier than the floor allows, whatever the comfort says', () => {
      const tiny = { width: 10, height: 10 };
      const bare = { minViewport, coarsePointer: false, maxTapUiPx: 20 };
      expect(autoUiScale(1280, 800, 1, { ...bare, comfortViewport: tiny })).toBe(
        autoUiScale(1280, 800, 1, bare),
      );
    });

    /**
     * A window too small for the comfort gets the *finest* scale, not the
     * chunkiest.
     *
     * Falling back to "largest that fits the floor" is the original rule, and
     * reinstating it here made the interface jump from scale 1 to scale 3 as the
     * tab shrank -- chunkier on a smaller screen, which is backwards.
     */
    it('goes finer, not chunkier, on a window that cannot afford the comfort', () => {
      const small = { width: 1024, height: 700 };
      const bare = { minViewport, coarsePointer: false, maxTapUiPx: 20 };
      const wanted = { width: 1200, height: 560 };
      expect(autoUiScale(small.width, small.height, 1, { ...bare, comfortViewport: wanted })).toBe(1);
      // ...and the floor alone would have said 3.
      expect(autoUiScale(small.width, small.height, 1, bare)).toBe(3);
    });

    it('gives the smallest window a scale of 1 rather than 0', () => {
      expect(autoUiScale(320, 200, 1, options)).toBe(1);
    });

    /**
     * The phone, which is where the comfort has to give way.
     *
     * On the 844x390 frame at dpr 3 there is no scale that gives the comfortable
     * viewport *and* keeps a finger-sized button inside `maxTapUiPx`: the two
     * requirements do not overlap on that screen. A rule that insisted on both
     * returned scale 1, whose tap target is 132 UI pixels -- an interface no
     * thumb can use, produced by a change whose whole purpose was to make it
     * less chunky.
     */
    it('gives the comfort up rather than the finger, on a phone', () => {
      const scale = autoUiScale(844, 390, 3, { ...options, coarsePointer: true });
      expect(tapCostInUiPixels(3, scale)).toBeLessThanOrEqual(20);
      const frame = uiFrame(844, 390, 3, scale);
      expect(frame.width).toBeGreaterThanOrEqual(minViewport.width);
      expect(frame.height).toBeGreaterThanOrEqual(minViewport.height);
      // ...and it is the same answer the floor alone gave, unchanged by this.
      expect(scale).toBe(autoUiScale(844, 390, 3, { minViewport, coarsePointer: true, maxTapUiPx: 20 }));
    });

    it('is the old rule exactly when no comfort is asked for', () => {
      for (const [w, h, dpr] of [
        [1280, 800, 1],
        [1920, 1080, 2],
        [640, 480, 1],
        [100, 60, 1],
      ] as const) {
        const bare = { minViewport, coarsePointer: false, maxTapUiPx: 20 };
        expect(autoUiScale(w, h, dpr, { ...bare, comfortViewport: minViewport })).toBe(
          autoUiScale(w, h, dpr, bare),
        );
      }
    });
  });
});

describe('resolveUiScale', () => {
  const minViewport = { width: 300, height: 140 };
  const options = {
    minViewport,
    comfortViewport: { width: 1200, height: 560 },
    coarsePointer: false,
    maxTapUiPx: 20,
  };

  it('defers to autoUiScale when nobody has chosen', () => {
    for (const [w, h, dpr] of [
      [1280, 800, 1],
      [1920, 1080, 2],
      [844, 390, 3],
    ] as const) {
      expect(resolveUiScale(null, w, h, dpr, options)).toBe(autoUiScale(w, h, dpr, options));
    }
  });

  it('honours a choice outright, even where auto would disagree', () => {
    // The point of the setting. Auto picks 1 on this window -- the comfort
    // viewport is nearly the whole of it -- and a player who asked for 4 gets
    // 4, not "4 clamped back to what we would have chosen anyway".
    expect(autoUiScale(1280, 800, 1, options)).toBe(1);
    expect(resolveUiScale(4, 1280, 800, 1, options)).toBe(4);
    expect(resolveUiScale(2, 1280, 800, 1, options)).toBe(2);
  });

  it('is the scale the frame is then built at', () => {
    const frame = uiFrame(1280, 800, 1, resolveUiScale(3, 1280, 800, 1, options));
    expect(frame.scale).toBe(3);
    expect(frame.width).toBe(Math.floor(1280 / 3));
  });

  it('never lets a UI pixel be fractional or smaller than a device pixel', () => {
    expect(resolveUiScale(0, 1280, 800, 1, options)).toBe(1);
    expect(resolveUiScale(-2, 1280, 800, 1, options)).toBe(1);
    expect(resolveUiScale(2.7, 1280, 800, 1, options)).toBe(2);
  });
});
