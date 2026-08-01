import { describe, expect, it } from 'vitest';
import {
  GRADE_NONE,
  GRADE_PRESETS,
  gradeColor,
  gradeIsIdentity,
  gradePreset,
  luma,
  resolveGrade,
  unpackColor,
} from './grade.js';

/** A spread of colours to grade, including the extremes. */
const SAMPLES: readonly (readonly [number, number, number])[] = [
  [0, 0, 0],
  [1, 1, 1],
  [0.5, 0.5, 0.5],
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
  [0.62, 0.74, 0.31], // the grass green the world is mostly made of
  [0.78, 0.51, 0.25], // trodden earth
  [0.56, 0.84, 0.78], // the sky
];

describe('gradeColor: the identity', () => {
  it('leaves every colour untouched with the none preset', () => {
    for (const rgb of SAMPLES) {
      const out = gradeColor(rgb, GRADE_NONE);
      expect(out[0]).toBeCloseTo(rgb[0], 9);
      expect(out[1]).toBeCloseTo(rgb[1], 9);
      expect(out[2]).toBeCloseTo(rgb[2], 9);
    }
  });

  it('recognises an identity grade so the pass can skip it', () => {
    expect(gradeIsIdentity(GRADE_NONE)).toBe(true);
    expect(gradeIsIdentity({ ...GRADE_NONE, saturation: 0 })).toBe(false);
    expect(gradeIsIdentity({ ...GRADE_NONE, tintStrength: 0.1 })).toBe(false);
    expect(gradeIsIdentity({ ...GRADE_NONE, gain: 1.2 })).toBe(false);
  });

  it('is the identity for every preset at zero strength', () => {
    for (const preset of GRADE_PRESETS) {
      expect(gradeIsIdentity(resolveGrade(preset, 0))).toBe(true);
    }
  });
});

describe('gradeColor: black and white', () => {
  const mono = gradePreset('mono').settings;

  it('collapses every colour to a neutral grey', () => {
    for (const rgb of SAMPLES) {
      const [r, g, b] = gradeColor(rgb, mono);
      expect(r).toBeCloseTo(g, 9);
      expect(g).toBeCloseTo(b, 9);
    }
  });

  it('keeps each colour at its own luma rather than flattening the picture', () => {
    // A red and a green of very different brightness must stay distinguishable.
    for (const rgb of SAMPLES) {
      expect(gradeColor(rgb, mono)[0]).toBeCloseTo(luma(rgb[0], rgb[1], rgb[2]), 9);
    }
    expect(gradeColor([0, 1, 0], mono)[0]).toBeGreaterThan(gradeColor([1, 0, 0], mono)[0]);
  });
});

describe('gradeColor: the tinted presets', () => {
  it('pushes hue without also acting as a dimmer', () => {
    // The reason the tint is normalised by its own luma: `moonlight`'s blue has
    // a luma near 0.36, so an un-normalised tint would darken the frame by
    // roughly two thirds and the hue could never be tuned independently.
    for (const id of ['evening', 'moonlight', 'fullmoon', 'bloodmoon']) {
      const settings = gradePreset(id).settings;
      const before = luma(0.5, 0.5, 0.5);
      const [r, g, b] = gradeColor([0.5, 0.5, 0.5], settings);
      expect(luma(r, g, b)).toBeCloseTo(before * settings.gain, 6);
    }
  });

  it('actually shifts the hue it claims to', () => {
    const [, , blue] = gradeColor([0.5, 0.5, 0.5], gradePreset('moonlight').settings);
    const [red] = gradeColor([0.5, 0.5, 0.5], gradePreset('moonlight').settings);
    expect(blue).toBeGreaterThan(red);

    const warm = gradeColor([0.5, 0.5, 0.5], gradePreset('evening').settings);
    expect(warm[0]).toBeGreaterThan(warm[2]);

    const blood = gradeColor([0.5, 0.5, 0.5], gradePreset('bloodmoon').settings);
    expect(blood[0]).toBeGreaterThan(blood[1]);
    expect(blood[1]).toBeGreaterThan(blood[2]);
  });

  it('brightens for a full moon and dims for plain moonlight', () => {
    // A full moon is the night you can see by; that is the whole distinction
    // between the two presets, beyond the hue.
    const mid: readonly [number, number, number] = [0.4, 0.4, 0.4];
    const full = gradeColor(mid, gradePreset('fullmoon').settings);
    const plain = gradeColor(mid, gradePreset('moonlight').settings);
    expect(luma(full[0], full[1], full[2])).toBeGreaterThan(luma(plain[0], plain[1], plain[2]));
  });

  it('keeps some of the original colour, so the palette still reads underneath', () => {
    for (const id of ['evening', 'moonlight', 'fullmoon', 'bloodmoon']) {
      const settings = gradePreset(id).settings;
      const green = gradeColor([0.3, 0.8, 0.3], settings);
      const magenta = gradeColor([0.8, 0.3, 0.8], settings);
      // Two colours of near-identical luma must not grade to the same pixel.
      const distance = Math.hypot(green[0] - magenta[0], green[1] - magenta[1], green[2] - magenta[2]);
      expect(distance).toBeGreaterThan(0.02);
    }
  });
});

describe('gradeColor: invariants across every preset', () => {
  it('never leaves the displayable range', () => {
    for (const preset of GRADE_PRESETS) {
      for (const strength of [0, 0.3, 0.7, 1]) {
        for (const rgb of SAMPLES) {
          for (const channel of gradeColor(rgb, resolveGrade(preset, strength))) {
            expect(channel).toBeGreaterThanOrEqual(0);
            expect(channel).toBeLessThanOrEqual(1);
          }
        }
      }
    }
  });

  it('keeps black black and never inverts brightness order', () => {
    for (const preset of GRADE_PRESETS) {
      const settings = preset.settings;
      expect(luma(...gradeColor([0, 0, 0], settings))).toBeCloseTo(0, 9);
      const dark = luma(...gradeColor([0.2, 0.2, 0.2], settings));
      const light = luma(...gradeColor([0.7, 0.7, 0.7], settings));
      expect(light).toBeGreaterThan(dark);
    }
  });

  it('is pure', () => {
    for (const preset of GRADE_PRESETS) {
      expect(gradeColor([0.4, 0.6, 0.2], preset.settings)).toEqual(
        gradeColor([0.4, 0.6, 0.2], preset.settings),
      );
    }
  });
});

describe('resolveGrade', () => {
  it('eases from identity to the full preset', () => {
    const preset = gradePreset('moonlight');
    const half = resolveGrade(preset, 0.5);
    expect(half.saturation).toBeCloseTo((1 + preset.settings.saturation) / 2, 9);
    expect(half.tintStrength).toBeCloseTo(preset.settings.tintStrength / 2, 9);
    expect(resolveGrade(preset, 1)).toEqual(preset.settings);
  });

  it('moves the graded colour monotonically as strength rises', () => {
    const preset = gradePreset('mono');
    const saturations = [0, 0.25, 0.5, 0.75, 1].map((s) => {
      const [r, , b] = gradeColor([0.9, 0.2, 0.2], resolveGrade(preset, s));
      return r - b; // how much colour is left
    });
    for (let i = 1; i < saturations.length; i++) {
      expect(saturations[i] as number).toBeLessThan(saturations[i - 1] as number);
    }
    expect(saturations[saturations.length - 1]).toBeCloseTo(0, 9);
  });

  it('clamps a strength outside 0..1', () => {
    const preset = gradePreset('evening');
    expect(resolveGrade(preset, 2)).toEqual(resolveGrade(preset, 1));
    expect(gradeIsIdentity(resolveGrade(preset, -1))).toBe(true);
  });
});

describe('gradePreset / unpackColor', () => {
  it('falls back to the identity for an unknown id', () => {
    expect(gradePreset('nonsense').id).toBe('none');
    expect(gradePreset('mono').id).toBe('mono');
  });

  it('offers the black-and-white and evening/moon grades the panel lists', () => {
    const ids = GRADE_PRESETS.map((p) => p.id);
    expect(ids).toContain('mono');
    expect(ids).toContain('evening');
    expect(ids).toContain('fullmoon');
    // Every preset needs a label for the dropdown, and ids must be unique.
    expect(new Set(ids).size).toBe(ids.length);
    for (const preset of GRADE_PRESETS) expect(preset.label.length).toBeGreaterThan(0);
  });

  it('unpacks a packed colour into 0..1 channels', () => {
    expect(unpackColor(0xffffff)).toEqual([1, 1, 1]);
    expect(unpackColor(0x000000)).toEqual([0, 0, 0]);
    const [r, g, b] = unpackColor(0xff8000);
    expect(r).toBe(1);
    expect(g).toBeCloseTo(0x80 / 255, 9);
    expect(b).toBe(0);
  });
});
