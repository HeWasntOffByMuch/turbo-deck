import { describe, expect, it } from 'vitest';
import {
  DEFAULT_VIRTUAL_SIZE,
  HIKE_DEBUG_VIEWS,
  HIKE_OFF,
  paletteById,
  DEFAULT_PALETTE_ID,
  HIKE_PALETTES,
  srgbDecode,
  glslSrgbEncodeChunk,
  srgbEncode,
  unpackLinear,
  VIRTUAL_SIZES,
  virtualSizeById,
  type HikeSettings,
} from './hike.js';

describe('the hike settings', () => {
  it('opens with every switch off', () => {
    // Walked rather than listed on purpose: a switch added later without an off
    // default has to fail here, not ship turned on.
    const on = Object.entries(HIKE_OFF).filter(([, value]) => value === true);
    expect(on).toEqual([]);
  });

  it('has a switch for every step of the arc', () => {
    // The point of the object is that each piece can be A/B'd alone, which only
    // holds if each piece actually has its own switch.
    const switches: (keyof HikeSettings)[] = [
      'smoothNormals',
      'swayNormals',
      'lowRes',
      'snapCamera',
      'buffers',
      'edges',
      'ink',
      'curvature',
      'softShadows',
    ];
    for (const name of switches) expect(typeof HIKE_OFF[name]).toBe('boolean');
  });

  it('draws the finished frame until a debug view is asked for', () => {
    expect(HIKE_OFF.debug).toBe('off');
  });

  it('names each debug view once', () => {
    expect(new Set(HIKE_DEBUG_VIEWS).size).toBe(HIKE_DEBUG_VIEWS.length);
  });

  it('quantizes onto even steps until given a palette', () => {
    // Null rather than a baked-in list: the palette is data the panel supplies,
    // never a constant compiled into shader source. Null also means "the frame
    // that shipped", since the retro filter's own steps are what it has always
    // used.
    expect(HIKE_OFF.palette).toBeNull();
    expect(paletteById(DEFAULT_PALETTE_ID)).toBeNull();
  });

  it('opens at a virtual resolution that does not depend on the window', () => {
    expect(HIKE_OFF.virtualWidth).toBe(480);
    expect(HIKE_OFF.virtualHeight).toBe(270);
  });

  it('reaches full ink strength somewhere beyond where it starts', () => {
    expect(HIKE_OFF.inkEnd).toBeGreaterThan(HIKE_OFF.inkStart);
  });

  it('opens at the size the panel calls the default', () => {
    // Two places name it; this is what stops them drifting apart, which would
    // show up as the panel silently resizing the buffer on first read.
    const size = virtualSizeById(DEFAULT_VIRTUAL_SIZE);
    expect(size.width).toBe(HIKE_OFF.virtualWidth);
    expect(size.height).toBe(HIKE_OFF.virtualHeight);
  });
});

describe('the palettes', () => {
  it('offers a way back to even steps', () => {
    expect(paletteById('none')).toBeNull();
  });

  it('stays inside the shader\'s loop bound', () => {
    // The GLSL loops to a fixed 16, because GLSL ES 1.00 will not take a
    // uniform loop count. A longer palette would be silently truncated.
    for (const palette of HIKE_PALETTES) {
      expect(palette.colors?.length ?? 0).toBeLessThanOrEqual(16);
    }
  });

  it('holds every colour to a real 24-bit hex', () => {
    for (const palette of HIKE_PALETTES) {
      for (const hex of palette.colors ?? []) {
        expect(Number.isInteger(hex)).toBe(true);
        expect(hex).toBeGreaterThanOrEqual(0);
        expect(hex).toBeLessThanOrEqual(0xffffff);
      }
    }
  });

  it('names each palette once, and has no duplicate colours within one', () => {
    expect(new Set(HIKE_PALETTES.map((p) => p.id)).size).toBe(HIKE_PALETTES.length);
    for (const palette of HIKE_PALETTES) {
      const colors = palette.colors ?? [];
      expect(new Set(colors).size).toBe(colors.length);
    }
  });

  it('falls back rather than throwing on an unknown id', () => {
    expect(paletteById('nonsense')).toBeNull();
  });
});

describe('the virtual sizes', () => {
  it('are all 16:9, so only the letterbox changes shape', () => {
    for (const size of VIRTUAL_SIZES) {
      expect(size.width / size.height).toBeCloseTo(16 / 9, 6);
    }
  });

  it('name themselves consistently', () => {
    for (const size of VIRTUAL_SIZES) {
      expect(size.id).toBe(`${size.width}x${size.height}`);
    }
  });

  it('falls back rather than throwing on an unknown id', () => {
    expect(virtualSizeById('nonsense')).toEqual(virtualSizeById(DEFAULT_VIRTUAL_SIZE));
  });
});

describe('the sRGB transfer', () => {
  it('pins black exactly', () => {
    // Exactly, not nearly: black that came back above zero would lift every
    // shadow in the frame, and the ink treatment spends most of its range down
    // here. Both directions take the linear foot at 0, so both are exact.
    expect(srgbEncode(0)).toBe(0);
    expect(srgbDecode(0)).toBe(0);
  });

  it('pins white to within a rounding step', () => {
    // `1.055 * pow(1, 1/2.4) - 0.055` is one ulp short of 1, because neither
    // 1.055 nor 0.055 is exact in binary. It could be rearranged to land on 1
    // exactly -- but this function's job is to be the expression the GLSL
    // mirrors term for term, and a reference written in a form no shader would
    // use has stopped being a reference. One ulp cannot cross an 8-bit step, so
    // it costs nothing where the number is actually spent.
    expect(srgbEncode(1)).toBeCloseTo(1, 12);
    expect(srgbDecode(1)).toBe(1);
  });

  it('round-trips across the range', () => {
    for (let i = 0; i <= 100; i++) {
      const v = i / 100;
      expect(srgbDecode(srgbEncode(v))).toBeCloseTo(v, 10);
      expect(srgbEncode(srgbDecode(v))).toBeCloseTo(v, 10);
    }
  });

  it('puts mid-grey where the real curve puts it', () => {
    // The number that separates the true piecewise transfer from a pow(2.2)
    // approximation of it: 0.5^2.2 is 0.2176, and the difference is a whole
    // palette step at twelve levels.
    expect(srgbDecode(0.5)).toBeCloseTo(0.2140, 4);
    expect(srgbEncode(0.2140)).toBeCloseTo(0.5, 3);
  });

  it('uses the linear foot below the knee, not the power curve', () => {
    // Below 0.0031308 the transfer is a straight multiply. A curve that used
    // the power term all the way down would be visibly wrong in exactly the
    // darks the ink treatment spends its range on.
    expect(srgbEncode(0.001)).toBeCloseTo(0.001 * 12.92, 12);
    expect(srgbDecode(0.02)).toBeCloseTo(0.02 / 12.92, 12);
  });

  it('is monotonic, so quantizing after it cannot reorder two shades', () => {
    let previous = -1;
    for (let i = 0; i <= 256; i++) {
      const v = srgbEncode(i / 256);
      expect(v).toBeGreaterThan(previous);
      previous = v;
    }
  });
});

describe('the sRGB transfer as GLSL', () => {
  it('computes the same curve as the reference, constant for constant', () => {
    // Not a string match. The constants are pulled back out of the shader source
    // and the expression is rebuilt from them, so the check is that the GLSL
    // *evaluates* to the reference rather than that it looks like it -- which is
    // the only version of this claim worth making about a shader nobody can run.
    const glsl = glslSrgbEncodeChunk();
    const numbers = (glsl.match(/\d+\.\d+/g) ?? []).map(Number);
    expect(numbers).toHaveLength(5);
    const [slope, exponent, scale, offset, knee] = numbers as [number, number, number, number, number];

    // `mix(high, low, step(c, knee))` takes `low` when knee >= c, which is the
    // reference's `<=`. Getting that backwards is the classic way to write this.
    const transcribed = (c: number): number =>
      c <= knee ? c * slope : Math.pow(c, exponent) * scale - offset;

    for (let i = 0; i <= 512; i++) {
      const v = i / 512;
      expect(transcribed(v)).toBeCloseTo(srgbEncode(v), 6);
    }
  });

  it('declares the function the passes call it by', () => {
    expect(glslSrgbEncodeChunk()).toContain('vec3 toSRGB(vec3 c)');
  });
});

describe('unpackLinear', () => {
  it('splits a packed hex into its three channels', () => {
    const [r, g, b] = unpackLinear(0xff8000);
    expect(r).toBeCloseTo(srgbDecode(1), 12);
    expect(g).toBeCloseTo(srgbDecode(0x80 / 255), 12);
    expect(b).toBe(0);
  });

  it('sends white to white and black to black', () => {
    expect(unpackLinear(0xffffff)).toEqual([1, 1, 1]);
    expect(unpackLinear(0x000000)).toEqual([0, 0, 0]);
  });

  it('darkens every mid-tone, which is what the decode is for', () => {
    // A palette hex read straight as linear would light the scene too brightly
    // everywhere but the ends. This is the whole reason the decode exists.
    const [r, g, b] = unpackLinear(0x7fae3f);
    expect(r).toBeLessThan(0x7f / 255);
    expect(g).toBeLessThan(0xae / 255);
    expect(b).toBeLessThan(0x3f / 255);
  });
});
