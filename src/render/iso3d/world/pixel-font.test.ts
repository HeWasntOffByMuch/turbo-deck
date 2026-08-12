import { describe, expect, it } from 'vitest';
import {
  GLYPH_HEIGHT,
  GLYPH_SPACING,
  GLYPH_WIDTH,
  glyphNames,
  glyphPath,
  glyphRects,
  hasGlyph,
  pixelTextSvg,
  textWidth,
} from './pixel-font.js';

/**
 * Everything the HUD can put on screen through this font: the damage numbers
 * (spec 065) and, since spec 143, the words in the refusal stack.
 */
const HUD_CHARACTERS = '0123456789+-!:. ABCDEFGHIJKLMNOPQRSTUVWXYZ';

describe('the glyph table', () => {
  it('is 5x7 for every glyph, with no ragged rows', () => {
    for (const name of glyphNames()) {
      const rects = glyphRects(name);
      for (const rect of rects) {
        expect(rect.x).toBeGreaterThanOrEqual(0);
        expect(rect.x).toBeLessThan(GLYPH_WIDTH);
        expect(rect.y).toBeGreaterThanOrEqual(0);
        expect(rect.y).toBeLessThan(GLYPH_HEIGHT);
      }
    }
  });

  it('has a glyph for every character the HUD can emit', () => {
    for (const character of HUD_CHARACTERS) {
      expect(hasGlyph(character), `missing glyph for ${JSON.stringify(character)}`).toBe(true);
    }
  });

  it('draws something for every glyph but the space', () => {
    for (const name of glyphNames()) {
      const lit = glyphRects(name).length;
      if (name === ' ') expect(lit).toBe(0);
      else expect(lit, `glyph ${name} is blank`).toBeGreaterThan(0);
    }
  });

  it('gives distinct shapes to characters that must not be confused', () => {
    // A damage number is read at a glance and a refusal is read out of the
    // corner of an eye. Over the whole table rather than over the digits, which
    // is what catches the pairs the letters brought with them: O and 0, I and 1,
    // S and 5, Z and 2.
    const shapes = new Map<string, string>();
    for (const character of glyphNames()) {
      if (character === ' ') continue;
      const path = glyphPath(character);
      const clash = shapes.get(path);
      expect(clash, `${character} draws the same as ${clash}`).toBeUndefined();
      shapes.set(path, character);
    }
  });
});

describe('layout', () => {
  it('advances one glyph plus its spacing per character', () => {
    expect(textWidth('')).toBe(0);
    expect(textWidth('7')).toBe(GLYPH_WIDTH);
    expect(textWidth('77')).toBe(GLYPH_WIDTH * 2 + GLYPH_SPACING);
    expect(textWidth('1234')).toBe(GLYPH_WIDTH * 4 + GLYPH_SPACING * 3);
  });

  it('places later glyphs to the right of earlier ones', () => {
    const rects = glyphRects('11');
    const first = rects.filter((rect) => rect.x < GLYPH_WIDTH);
    const second = rects.filter((rect) => rect.x >= GLYPH_WIDTH);
    expect(first.length).toBeGreaterThan(0);
    expect(second.length).toBe(first.length);
    for (const rect of second) {
      expect(rect.x).toBeGreaterThanOrEqual(GLYPH_WIDTH + GLYPH_SPACING);
    }
  });

  it('never overlaps two glyphs on the same pixel', () => {
    const seen = new Set<string>();
    for (const rect of glyphRects('1234567890')) {
      const key = `${rect.x},${rect.y}`;
      expect(seen.has(key), `two glyphs lit ${key}`).toBe(false);
      seen.add(key);
    }
  });

  it('falls back to a solid block rather than drawing nothing', () => {
    // The face has one case on purpose (spec 143), so a lower-case letter is as
    // absent as an accent is.
    expect(hasGlyph('z')).toBe(false);
    expect(glyphRects('z')).toHaveLength(GLYPH_WIDTH * GLYPH_HEIGHT);
    expect(hasGlyph('\u00e9')).toBe(false);
  });
});

describe('pixelTextSvg', () => {
  it('sizes the box to the text, scaled, with room for the outline', () => {
    const svg = pixelTextSvg('12', { scale: 3 });
    const width = (GLYPH_WIDTH * 2 + GLYPH_SPACING + 2) * 3;
    const height = (GLYPH_HEIGHT + 2) * 3;
    expect(svg).toContain(`width="${width}"`);
    expect(svg).toContain(`height="${height}"`);
  });

  it('keeps its edges hard', () => {
    expect(pixelTextSvg('1')).toContain('shape-rendering="crispEdges"');
  });

  it('draws the fill once and the outline eight times around it', () => {
    const svg = pixelTextSvg('1', { fill: '#abcdef', outline: '#012345' });
    expect(svg.split('#abcdef').length - 1).toBe(1);
    expect(svg.split('#012345').length - 1).toBe(8);
  });

  it('is a self-contained element with no external reference', () => {
    const svg = pixelTextSvg('-42');
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg.endsWith('</svg>')).toBe(true);
    expect(svg).not.toContain('http://www.w3.org/1999/xlink');
    expect(svg).not.toContain('url(');
  });

  it('renders an empty string without producing a broken box', () => {
    const svg = pixelTextSvg('');
    expect(svg).toContain('width="6"'); // 0 text + 2 margin, at scale 3
    expect(svg).toContain('</svg>');
  });
});
