import { describe, expect, it } from 'vitest';
import { advance, BODY_FONT, glyphFor, measureText, NUMERIC_FONT, wrapText } from './font.js';
import { BODY_GLYPHS, BODY_GLYPH_HEIGHT, BODY_GLYPH_WIDTH } from './glyphs-6x10.js';
import { glyphNames, glyphRects, GLYPH_HEIGHT, GLYPH_WIDTH } from '../../render/iso3d/world/pixel-font.js';

describe('the numeric face is the one the damage numbers already use', () => {
  it('lights exactly the pixels pixel-font.ts reports, for every glyph it has', () => {
    // The point of deriving it rather than copying it: this cannot drift.
    for (const character of glyphNames()) {
      const glyph = glyphFor(NUMERIC_FONT, character);
      const expected = new Set(glyphRects(character).map((r) => `${r.x},${r.y}`));
      for (let y = 0; y < GLYPH_HEIGHT; y++) {
        for (let x = 0; x < GLYPH_WIDTH; x++) {
          expect(glyph.lit[y * GLYPH_WIDTH + x]).toBe(expected.has(`${x},${y}`));
        }
      }
    }
  });

  it('carries every glyph the original has, and no more', () => {
    expect(Object.keys(NUMERIC_FONT.glyphs).sort()).toEqual([...glyphNames()].sort());
  });
});

describe('the body face', () => {
  it('covers every printable ASCII character', () => {
    for (let code = 0x20; code <= 0x7e; code++) {
      const character = String.fromCharCode(code);
      expect(BODY_GLYPHS[character], `missing glyph for ${JSON.stringify(character)}`).toBeDefined();
    }
  });

  it('has every glyph on the same grid', () => {
    for (const [character, rows] of Object.entries(BODY_GLYPHS)) {
      expect(rows, character).toHaveLength(BODY_GLYPH_HEIGHT);
      for (const row of rows) {
        expect(row.length, `${character} row width`).toBe(BODY_GLYPH_WIDTH);
        expect(/^[#.]*$/.test(row), `${character} uses an unexpected character`).toBe(true);
      }
    }
  });

  it('has descenders below the baseline, which is why it exists', () => {
    const below = (character: string): boolean => {
      const glyph = glyphFor(BODY_FONT, character);
      for (let y = BODY_FONT.baseline; y < BODY_FONT.height; y++) {
        for (let x = 0; x < BODY_FONT.width; x++) {
          if (glyph.lit[y * BODY_FONT.width + x]) return true;
        }
      }
      return false;
    };
    for (const character of ['g', 'j', 'p', 'q', 'y']) {
      expect(below(character), `${character} should descend`).toBe(true);
    }
    for (const character of ['o', 'n', 'A', 'x']) {
      expect(below(character), `${character} should not descend`).toBe(false);
    }
  });

  it('falls back rather than throwing on a character it has no glyph for', () => {
    expect(() => glyphFor(BODY_FONT, 'é')).not.toThrow();
    expect(glyphFor(BODY_FONT, 'é')).toBe(BODY_FONT.fallback);
  });
});

describe('measureText', () => {
  it('is the sum of advances minus the trailing gap', () => {
    expect(measureText(BODY_FONT, '')).toBe(0);
    expect(measureText(BODY_FONT, 'a')).toBe(BODY_FONT.width);
    expect(measureText(BODY_FONT, 'ab')).toBe(BODY_FONT.width * 2 + BODY_FONT.spacing);
    expect(measureText(BODY_FONT, 'abcde')).toBe(5 * advance(BODY_FONT) - BODY_FONT.spacing);
  });

  it('counts a space like any other character', () => {
    expect(measureText(BODY_FONT, 'a b')).toBe(measureText(BODY_FONT, 'axb'));
  });
});

describe('wrapText', () => {
  it('never emits a line wider than the limit', () => {
    const text = 'the quick brown fox jumps over the lazy dog and pays for it with a cooldown';
    for (const width of [40, 60, 80, 120, 200]) {
      for (const line of wrapText(BODY_FONT, text, width)) {
        expect(measureText(BODY_FONT, line), `"${line}" at ${width}`).toBeLessThanOrEqual(width);
      }
    }
  });

  it('breaks at spaces and keeps the words', () => {
    const lines = wrapText(BODY_FONT, 'alpha beta gamma', 90);
    expect(lines.join(' ').replace(/\s+/g, ' ')).toBe('alpha beta gamma');
  });

  it('chops a single word that cannot fit on a line of its own', () => {
    const lines = wrapText(BODY_FONT, 'supercalifragilistic', 40);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join('')).toBe('supercalifragilistic');
  });

  it('honours explicit newlines', () => {
    expect(wrapText(BODY_FONT, 'one\ntwo', 500)).toEqual(['one', 'two']);
  });

  it('terminates on a limit narrower than one glyph', () => {
    const lines = wrapText(BODY_FONT, 'abc', 1);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('')).toBe('abc');
  });
});
