import { describe, expect, it } from 'vitest';
import { bakeAtlas, TintCache } from './atlas.js';
import { RasterSurface } from './raster.js';
import { color, WHITE, type Color } from '../core/color.js';
import { BODY_FONT, NUMERIC_FONT } from '../text/font.js';
import { THEME } from '../theme/theme.js';

const atlas = bakeAtlas(THEME);

/** Index into an array, failing loudly rather than with `undefined is not an object`. */
function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`no item at ${index}`);
  return item;
}

function surface(width = 32, height = 32): RasterSurface {
  const out = new RasterSurface(atlas, width, height);
  out.beginFrame();
  return out;
}

describe('bakeAtlas', () => {
  it('places every sprite inside the bounds', () => {
    for (const name of atlas.names()) {
      const rect = atlas.sprite(name);
      expect(rect.x, name).toBeGreaterThanOrEqual(0);
      expect(rect.y, name).toBeGreaterThanOrEqual(0);
      expect(rect.x + rect.width, name).toBeLessThanOrEqual(atlas.width);
      expect(rect.y + rect.height, name).toBeLessThanOrEqual(atlas.height);
    }
  });

  it('never overlaps two sprites', () => {
    const names = atlas.names();
    for (let i = 0; i < names.length; i++) {
      for (let j = i + 1; j < names.length; j++) {
        const a = atlas.sprite(at(names, i));
        const b = atlas.sprite(at(names, j));
        const disjoint =
          a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;
        expect(disjoint, `${names[i]} overlaps ${names[j]}`).toBe(true);
      }
    }
  });

  it('is deterministic: the same source bakes byte-identical pixels', () => {
    // Without this a golden image is a thing that passes on one machine.
    const again = bakeAtlas(THEME);
    expect(again.width).toBe(atlas.width);
    expect(again.height).toBe(atlas.height);
    expect(Array.from(again.pixels)).toEqual(Array.from(atlas.pixels));
    expect(again.names()).toEqual(atlas.names());
  });

  it('carries a sprite for every glyph of both faces', () => {
    for (const font of [BODY_FONT, NUMERIC_FONT]) {
      for (const character of Object.keys(font.glyphs)) {
        const rect = atlas.glyph(font, character);
        expect(rect.width, `${font.id} ${character}`).toBe(font.width);
        expect(rect.height, `${font.id} ${character}`).toBe(font.height);
      }
    }
  });

  it('bakes glyphs white, so a tint is what colours text', () => {
    const rect = atlas.glyph(BODY_FONT, 'A');
    let litFound = false;
    for (let y = 0; y < rect.height; y++) {
      for (let x = 0; x < rect.width; x++) {
        const offset = ((rect.y + y) * atlas.width + rect.x + x) * 4;
        if ((atlas.pixels[offset + 3] ?? 0) === 0) continue;
        litFound = true;
        expect(atlas.pixels[offset]).toBe(255);
        expect(atlas.pixels[offset + 1]).toBe(255);
        expect(atlas.pixels[offset + 2]).toBe(255);
      }
    }
    expect(litFound).toBe(true);
  });

  it('throws for a sprite that is not there rather than drawing nothing', () => {
    expect(() => atlas.sprite('icon:nonesuch')).toThrow(/no sprite named/);
    expect(() => atlas.patch('nonesuch')).toThrow(/no patch named/);
  });
});

describe('TintCache', () => {
  it('multiplies, so white is the identity', () => {
    const cache = new TintCache(atlas);
    expect(Array.from(cache.get(WHITE))).toEqual(Array.from(atlas.pixels));
  });

  it('keeps one copy per colour, not one per call', () => {
    const cache = new TintCache(atlas);
    const red = color(255, 0, 0);
    cache.get(red);
    cache.get(red);
    cache.get(color(255, 0, 0));
    expect(cache.size()).toBe(1);
  });

  it('tints a white glyph to exactly the requested colour', () => {
    const cache = new TintCache(atlas);
    const teal = color(20, 180, 170);
    const pixels = cache.get(teal);
    const rect = atlas.glyph(BODY_FONT, 'A');
    for (let y = 0; y < rect.height; y++) {
      for (let x = 0; x < rect.width; x++) {
        const offset = ((rect.y + y) * atlas.width + rect.x + x) * 4;
        if ((atlas.pixels[offset + 3] ?? 0) === 0) continue;
        expect(pixels[offset]).toBe(teal.r);
        expect(pixels[offset + 1]).toBe(teal.g);
        expect(pixels[offset + 2]).toBe(teal.b);
      }
    }
  });
});

describe('RasterSurface', () => {
  const red: Color = color(255, 0, 0);

  it('fills exactly the rect it is given', () => {
    const out = surface();
    out.drawSolid({ x: 2, y: 3, width: 4, height: 5 }, red);
    out.endFrame();
    expect(out.pixelAt(2, 3)).toEqual(red);
    expect(out.pixelAt(5, 7)).toEqual(red);
    expect(out.pixelAt(6, 7).a).toBe(0);
    expect(out.pixelAt(2, 2).a).toBe(0);
  });

  it('clips to the scissor stack, and a fully clipped draw changes nothing', () => {
    const out = surface();
    const before = Array.from(out.pixels);
    out.pushClip({ x: 0, y: 0, width: 4, height: 4 });
    out.drawSolid({ x: 10, y: 10, width: 5, height: 5 }, red);
    out.popClip();
    out.endFrame();
    expect(Array.from(out.pixels)).toEqual(before);
  });

  it('intersects nested clips rather than replacing them', () => {
    const out = surface();
    out.pushClip({ x: 0, y: 0, width: 10, height: 10 });
    out.pushClip({ x: 5, y: 5, width: 20, height: 20 });
    out.drawSolid({ x: 0, y: 0, width: 32, height: 32 }, red);
    out.popClip();
    out.popClip();
    out.endFrame();
    expect(out.pixelAt(7, 7)).toEqual(red);
    expect(out.pixelAt(2, 2).a).toBe(0);
    expect(out.pixelAt(12, 12).a).toBe(0);
  });

  it('refuses an unbalanced clip stack instead of drawing something wrong', () => {
    const out = surface();
    out.pushClip({ x: 0, y: 0, width: 4, height: 4 });
    expect(() => out.endFrame()).toThrow(/unbalanced/);
    expect(() => surface().popClip()).toThrow(/no matching pushClip/);
  });

  it('samples nearest-neighbour from the unclipped destination', () => {
    // A sprite half off the edge of a clip must show the pixels it would have
    // shown whole, just fewer of them -- otherwise a list item stretches as it
    // scrolls under the top of a scroll view.
    const whole = surface(16, 16);
    const src = atlas.glyph(BODY_FONT, 'A');
    whole.drawSprite(src, { x: 0, y: 0, width: 12, height: 20 }, WHITE);
    whole.endFrame();

    const clipped = surface(16, 16);
    clipped.pushClip({ x: 0, y: 0, width: 12, height: 10 });
    clipped.drawSprite(src, { x: 0, y: 0, width: 12, height: 20 }, WHITE);
    clipped.popClip();
    clipped.endFrame();

    for (let y = 0; y < 10; y++) {
      for (let x = 0; x < 12; x++) {
        expect(clipped.pixelAt(x, y), `at ${x},${y}`).toEqual(whole.pixelAt(x, y));
      }
    }
  });

  it('never writes outside the buffer, however far out the rect is', () => {
    const out = surface(8, 8);
    expect(() => {
      out.drawSolid({ x: -100, y: -100, width: 500, height: 500 }, red);
      out.drawSolid({ x: 1000, y: 1000, width: 5, height: 5 }, red);
    }).not.toThrow();
    out.endFrame();
    expect(out.pixels.length).toBe(8 * 8 * 4);
  });

  it('composites a translucent colour over what is beneath it', () => {
    const out = surface(4, 4);
    out.drawSolid({ x: 0, y: 0, width: 4, height: 4 }, color(0, 0, 0));
    out.drawSolid({ x: 0, y: 0, width: 4, height: 4 }, color(255, 255, 255, 128));
    out.endFrame();
    const pixel = out.pixelAt(0, 0);
    expect(pixel.a).toBe(255);
    expect(pixel.r).toBeGreaterThan(100);
    expect(pixel.r).toBeLessThan(160);
  });

  it('draws nothing for a fully transparent colour', () => {
    const out = surface(4, 4);
    const before = Array.from(out.pixels);
    out.drawSolid({ x: 0, y: 0, width: 4, height: 4 }, color(255, 0, 0, 0));
    out.endFrame();
    expect(Array.from(out.pixels)).toEqual(before);
  });
});
