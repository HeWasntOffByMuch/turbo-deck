import { afterEach, describe, expect, it } from 'vitest';
import {
  advanceWind,
  resetWind,
  setWindBearing,
  setWindSpeed,
  setWindStrength,
  WIND_UNIFORMS,
  windDirUniform,
  windSpeed,
  windStrengthUniform,
  windTimeUniform,
} from './wind-uniforms.js';
import { compassPoint } from './weather-controls.js';
import { WIND, WIND_BEARING_DEG, WIND_LIMITS, windDirection } from './wind.js';

/**
 * The live weather state the panel drives (spec 075).
 *
 * The panel itself is DOM and this suite runs in Node, so what is covered here
 * is the half that decides anything: the clamping, the degrees-to-vector
 * conversion, and — most of all — that every material really is holding the same
 * objects. A panel that quietly wrote to a copy would look perfectly correct in
 * every screenshot of the trees and leave the water becalmed.
 */

afterEach(() => resetWind());

describe('the shared uniforms', () => {
  it('are the same objects the shaders were handed', () => {
    // Identity, not equality. This is the whole design: one wind, by reference.
    expect(WIND_UNIFORMS.uWindTime).toBe(windTimeUniform);
    expect(WIND_UNIFORMS.uWindDir).toBe(windDirUniform);
    expect(WIND_UNIFORMS.uWindStrength).toBe(windStrengthUniform);
  });

  it('survive being spread into a material', () => {
    // `{...WIND_UNIFORMS}` is how the water builds its uniform map. A shallow
    // spread copies the *references*, which is what makes that safe; a deep
    // clone would silently give that chunk its own private weather.
    const copy = { ...WIND_UNIFORMS };
    setWindStrength(2);
    expect(copy.uWindStrength.value).toBe(WIND.strength * 2);
  });

  it('open on the art direction', () => {
    expect(windStrengthUniform.value).toBe(WIND.strength);
    expect(windDirUniform.value.x).toBe(WIND.dirX);
    expect(windDirUniform.value.y).toBe(WIND.dirZ);
    expect(windSpeed()).toBe(1);
  });
});

describe('wind strength', () => {
  it('scales the art-directed lean', () => {
    setWindStrength(0.5);
    expect(windStrengthUniform.value).toBeCloseTo(WIND.strength * 0.5, 12);
    setWindStrength(2);
    expect(windStrengthUniform.value).toBeCloseTo(WIND.strength * 2, 12);
  });

  it('stills the forest at zero rather than freezing it mid-lean', () => {
    // Zero strength is a lean of zero radians, which is upright -- not the tree
    // stuck wherever the gust had it. Worth pinning: a slider that stopped the
    // *clock* instead would look identical for one frame and wrong forever.
    setWindStrength(0);
    expect(windStrengthUniform.value).toBe(0);
    expect(windSpeed()).toBe(1);
  });

  it('clamps rather than trusting its caller', () => {
    setWindStrength(-5);
    expect(windStrengthUniform.value).toBe(0);
    setWindStrength(1000);
    expect(windStrengthUniform.value).toBeCloseTo(WIND.strength * WIND_LIMITS.maxStrength, 12);
  });
});

describe('wind direction', () => {
  it('turns a compass bearing into the unit vector the shaders read', () => {
    for (const bearing of [0, 45, 137, 270, 359]) {
      setWindBearing(bearing);
      const expected = windDirection(bearing);
      expect(windDirUniform.value.x).toBeCloseTo(expected.x, 12);
      expect(windDirUniform.value.y).toBeCloseTo(expected.z, 12);
      expect(Math.hypot(windDirUniform.value.x, windDirUniform.value.y)).toBeCloseTo(1, 12);
    }
  });

  it('round-trips the default bearing back to the default wind', () => {
    setWindBearing(WIND_BEARING_DEG);
    expect(windDirUniform.value.x).toBe(WIND.dirX);
    expect(windDirUniform.value.y).toBe(WIND.dirZ);
  });

  it('mutates the vector in place, so nothing loses its reference to it', () => {
    const held = windDirUniform.value;
    setWindBearing(90);
    expect(windDirUniform.value).toBe(held);
  });
});

describe('weather speed', () => {
  it('scales how fast the shared clock runs', () => {
    setWindSpeed(2);
    advanceWind(1);
    expect(windTimeUniform.value).toBeCloseTo(2, 12);
  });

  it('holds the weather mid-gust at zero', () => {
    advanceWind(1);
    const held = windTimeUniform.value;
    setWindSpeed(0);
    advanceWind(10);
    expect(windTimeUniform.value).toBe(held);
  });

  it('clamps, and resumes from where it paused', () => {
    setWindSpeed(-1);
    expect(windSpeed()).toBe(0);
    setWindSpeed(99);
    expect(windSpeed()).toBe(WIND_LIMITS.maxSpeed);
  });
});

describe('reset', () => {
  it('puts every knob and the clock back', () => {
    setWindStrength(2.2);
    setWindBearing(12);
    setWindSpeed(0);
    advanceWind(3);

    resetWind();

    expect(windTimeUniform.value).toBe(0);
    expect(windSpeed()).toBe(1);
    expect(windStrengthUniform.value).toBeCloseTo(WIND.strength, 12);
    expect(windDirUniform.value.x).toBe(WIND.dirX);
    expect(windDirUniform.value.y).toBe(WIND.dirZ);
  });
});

describe('the compass readout', () => {
  it('names the eight points, and wraps', () => {
    // +Z is south under this camera, so bearing 0 -- blowing towards +X -- is
    // east. Getting this backwards would put a readout on the slider that
    // confidently disagrees with the trees.
    expect(compassPoint(0)).toBe('E');
    expect(compassPoint(90)).toBe('S');
    expect(compassPoint(180)).toBe('W');
    expect(compassPoint(270)).toBe('N');
    expect(compassPoint(360)).toBe('E');
    expect(compassPoint(-90)).toBe('N');
  });

  it('rounds to the nearest point rather than truncating', () => {
    expect(compassPoint(44)).toBe('SE');
    expect(compassPoint(23)).toBe('SE');
    expect(compassPoint(21)).toBe('E');
  });
});
