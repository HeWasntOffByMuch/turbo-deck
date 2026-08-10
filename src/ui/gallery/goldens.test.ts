import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodePng, firstDifference, GOLDEN_CASES } from './goldens.js';
import { renderGallery } from './render.js';
import { buildGallery } from './gallery.js';
import { bakeAtlas } from '../render/atlas.js';
import { THEME } from '../theme/theme.js';
import { UNBOUNDED } from '../core/geom.js';

const directory = new URL('./goldens/', import.meta.url);

describe('golden images', () => {
  // This is the assertion the whole backend split exists for: a screen compared
  // byte for byte inside `npm test`, with no GPU and no browser.
  for (const item of GOLDEN_CASES) {
    it(`${item.name} matches, pixel for pixel (${item.covers})`, () => {
      const frame = renderGallery(item.options);
      const actual = {
        width: frame.surface.width,
        height: frame.surface.height,
        pixels: frame.surface.pixels,
      };
      const expected = decodePng(readFileSync(new URL(`${item.name}.png`, directory)));
      const difference = firstDifference(actual, expected);
      expect(
        difference,
        difference === null
          ? ''
          : `${item.name} differs -- ${difference}. Look at the change, then run \`npm run bake:ui-goldens\` to accept it.`,
      ).toBe(null);
    });
  }

  it('renders the same bytes twice in a row', () => {
    // A golden is only worth having if the renderer is deterministic; if this
    // fails, the goldens above are noise rather than a check.
    const first = renderGallery();
    const second = renderGallery();
    expect(firstDifference(
      { width: first.surface.width, height: first.surface.height, pixels: first.surface.pixels },
      { width: second.surface.width, height: second.surface.height, pixels: second.surface.pixels },
    )).toBe(null);
  });
});

describe('the gallery fits the smallest supported viewport', () => {
  it('lays out inside minViewport without overflowing it', () => {
    const { width, height } = THEME.input.minViewport;
    const frame = renderGallery({ viewport: { width, height } });
    expect(frame.root.viewport).toEqual({ width, height });
    // Nothing may be arranged wider than the viewport: a window that is is a
    // window with content the player cannot reach.
    for (const widget of frame.root.content.walk()) {
      expect(widget.rect.width, widget.name).toBeLessThanOrEqual(width);
    }
  });

  it('scrolls rather than squashing, at every viewport it is asked for', () => {
    const atlas = bakeAtlas(THEME);
    for (const viewport of [
      { width: 300, height: 140 },
      { width: 400, height: 300 },
      { width: 640, height: 360 },
    ]) {
      const gallery = buildGallery(THEME);
      const size = gallery.root.measure(
        { maxWidth: viewport.width, maxHeight: viewport.height },
        { theme: THEME, atlas },
      );
      expect(size.height, `${viewport.width}x${viewport.height}`).toBeLessThanOrEqual(viewport.height);
    }
  });

  it('has a finite natural size when measured unbounded', () => {
    const atlas = bakeAtlas(THEME);
    const gallery = buildGallery(THEME);
    const size = gallery.root.measure({ maxWidth: 400, maxHeight: UNBOUNDED }, { theme: THEME, atlas });
    expect(size.height).toBeLessThan(10_000);
  });
});
