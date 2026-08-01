import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DAY_LENGTH_MINUTES,
  DEFAULT_TIME_OF_DAY,
  advanceTimeOfDay,
  formatClock,
  skyAt,
  sunPosition,
  wrapHours,
} from './daynight.js';
import { DEFAULT_LIGHT_OFFSET, type Vec3 } from './view-settings.js';
import { PALETTE } from './palette.js';

const DEG = Math.PI / 180;

/** Angle between two direction vectors, degrees. */
function angleBetween(a: Vec3, b: Vec3): number {
  const dot = a.x * b.x + a.y * b.y + a.z * b.z;
  const mag = Math.hypot(a.x, a.y, a.z) * Math.hypot(b.x, b.y, b.z);
  return Math.acos(Math.min(1, Math.max(-1, dot / mag))) / DEG;
}

describe('sunPosition (spec 047)', () => {
  it('peaks at noon and bottoms out at midnight', () => {
    const noon = sunPosition(12).elevation;
    const midnight = sunPosition(0).elevation;
    expect(noon).toBeGreaterThan(0);
    expect(midnight).toBeCloseTo(-noon, 9);
    for (const h of [8, 10, 14, 16]) {
      expect(sunPosition(h).elevation).toBeLessThan(noon);
    }
  });

  it('puts the sun exactly on the horizon at 06:00 and 18:00', () => {
    expect(sunPosition(6).elevation).toBeCloseTo(0, 9);
    expect(sunPosition(18).elevation).toBeCloseTo(0, 9);
  });

  it('climbs through the morning and falls through the afternoon', () => {
    for (let h = 6; h < 12; h += 0.5) {
      expect(sunPosition(h + 0.5).elevation).toBeGreaterThan(sunPosition(h).elevation);
    }
    for (let h = 12; h < 18; h += 0.5) {
      expect(sunPosition(h + 0.5).elevation).toBeLessThan(sunPosition(h).elevation);
    }
  });

  it('sweeps a half turn of bearing between sunrise and sunset', () => {
    const swing = sunPosition(18).azimuth - sunPosition(6).azimuth;
    expect(swing).toBeCloseTo(Math.PI, 9);
  });
});

describe('skyAt: continuity with the tuned daylight (spec 045)', () => {
  it('reproduces the shipped sun direction at the hour the view opens on', () => {
    // The whole reason DEFAULT_TIME_OF_DAY is mid-afternoon: the clock passes
    // back through spec 045's deliberately tuned light rather than replacing it.
    const sky = skyAt(DEFAULT_TIME_OF_DAY);
    expect(angleBetween(sky.lightDirection, DEFAULT_LIGHT_OFFSET)).toBeLessThan(1);
  });

  it('keeps the noon keyframe identical to what the scene shipped with', () => {
    const noon = skyAt(12);
    expect(noon.skyColor).toBe(PALETTE.sky);
    expect(noon.lightColor).toBe(0xfff4e0);
    expect(noon.lightIntensity).toBeCloseTo(2.1, 9);
    expect(noon.ambientColor).toBe(0x8090a0);
    // The sun is high at noon, so the horizon effect adds no fill at all.
    expect(noon.ambientIntensity).toBeCloseTo(1.55, 9);
  });
});

describe('skyAt: the shape of a day', () => {
  it('is dimmer at night than at any hour of the day', () => {
    const night = skyAt(0);
    for (const h of [8, 10, 12, 14, 16]) {
      expect(skyAt(h).lightIntensity).toBeGreaterThan(night.lightIntensity * 2);
    }
  });

  it('lights from the sun by day and from the anti-sun by night', () => {
    const noon = skyAt(12);
    expect(noon.isDay).toBe(true);
    expect(noon.lightDirection.y).toBeGreaterThan(0);

    const midnight = skyAt(0);
    expect(midnight.isDay).toBe(false);
    // The moon is up when the sun is down, so the key light is still overhead.
    expect(midnight.lightDirection.y).toBeGreaterThan(0);
    // ...and on the opposite bearing to the sun, which is what makes it the moon.
    const bearing = Math.atan2(midnight.lightDirection.z, midnight.lightDirection.x);
    expect(Math.cos(bearing - (midnight.sunAzimuth + Math.PI))).toBeCloseTo(1, 9);
  });

  it('is continuous across midnight rather than seaming at the wrap', () => {
    const before = skyAt(23.99);
    const after = skyAt(0.01);
    expect(Math.abs(before.lightIntensity - after.lightIntensity)).toBeLessThan(0.05);
    expect(Math.abs(before.ambientIntensity - after.ambientIntensity)).toBeLessThan(0.05);
    expect(before.skyColor).toBe(after.skyColor);
  });

  it('is continuous through every hour, with no jump between ramp keys', () => {
    let previous = skyAt(0);
    for (let h = 0.05; h < 24; h += 0.05) {
      const sky = skyAt(h);
      expect(Math.abs(sky.lightIntensity - previous.lightIntensity)).toBeLessThan(0.15);
      expect(Math.abs(sky.ambientIntensity - previous.ambientIntensity)).toBeLessThan(0.15);
      previous = sky;
    }
  });

  it('is total: any hour, in or out of range, produces a sky', () => {
    for (const h of [-5, -0.001, 0, 24, 49.5, 1e6]) {
      const sky = skyAt(h);
      expect(sky.hours).toBeGreaterThanOrEqual(0);
      expect(sky.hours).toBeLessThan(24);
      expect(Number.isFinite(sky.lightIntensity)).toBe(true);
      expect(Number.isFinite(sky.ambientIntensity)).toBe(true);
    }
    expect(skyAt(25)).toEqual(skyAt(1));
  });

  it('is pure', () => {
    expect(skyAt(9.3)).toEqual(skyAt(9.3));
  });
});

describe('skyAt: the horizon effect (spec 047)', () => {
  it('never lets the shade get darker as the sun goes down', () => {
    // The dusk fill replaces the shadow contrast the horizon effect removes, so
    // a shadowed surface -- lit by ambient alone -- is never worse off at dusk.
    const noonShade = skyAt(12).ambientIntensity;
    for (const h of [16.5, 17.5, 18, 18.4]) {
      expect(skyAt(h).ambientIntensity).toBeGreaterThan(noonShade * 0.7);
    }
  });

  it('adds fill exactly as the sun nears the horizon, and none while it is high', () => {
    // Above the fade band the raw ramp is untouched; inside it the fill climbs.
    expect(skyAt(12).shadow.strength).toBe(1);
    const strengths = [17, 17.5, 18].map((h) => skyAt(h).shadow.strength);
    for (let i = 1; i < strengths.length; i++) {
      expect(strengths[i] as number).toBeLessThan(strengths[i - 1] as number);
    }
    // 18:00 is the instant of sunset itself: cos(pi/2) lands a hair off zero in
    // floating point, so the sun is technically still up with nothing left to cast.
    expect(skyAt(18).shadow.strength).toBeCloseTo(0, 9);
  });

  it('stops casting at all once the sun is down', () => {
    for (const h of [18.5, 20, 0, 3, 5.5]) {
      expect(skyAt(h).shadow.casting).toBe(false);
    }
    for (const h of [7, 9, 12, 15, 17]) {
      expect(skyAt(h).shadow.casting).toBe(true);
    }
  });

  it('holds the casting direction above the floor at every hour', () => {
    for (let h = 0; h < 24; h += 0.1) {
      // Even at the instant of sunset, the direction the light casts from is
      // still well clear of the horizon -- which is what bounds shadow length.
      expect(skyAt(h).shadow.castElevation).toBeGreaterThanOrEqual(8 * DEG - 1e-9);
    }
  });
});

describe('advanceTimeOfDay', () => {
  it('completes exactly one day per day length', () => {
    const day = DEFAULT_DAY_LENGTH_MINUTES * 60;
    expect(advanceTimeOfDay(6, day, DEFAULT_DAY_LENGTH_MINUTES)).toBeCloseTo(6, 6);
    expect(advanceTimeOfDay(6, day / 2, DEFAULT_DAY_LENGTH_MINUTES)).toBeCloseTo(18, 6);
  });

  it('is linear in elapsed time', () => {
    const once = advanceTimeOfDay(0, 30, 10);
    const twice = advanceTimeOfDay(once, 30, 10);
    expect(twice).toBeCloseTo(advanceTimeOfDay(0, 60, 10), 9);
  });

  it('wraps past midnight instead of running off the clock', () => {
    expect(advanceTimeOfDay(23.5, 60, 1)).toBeGreaterThanOrEqual(0);
    expect(advanceTimeOfDay(23.5, 60, 1)).toBeLessThan(24);
  });

  it('shrugs off a non-finite frame time rather than losing the clock', () => {
    expect(advanceTimeOfDay(9, Number.NaN, 8)).toBe(9);
    expect(advanceTimeOfDay(9, Number.POSITIVE_INFINITY, 8)).toBe(9);
  });

  it('runs faster with a shorter day', () => {
    expect(advanceTimeOfDay(0, 10, 2)).toBeGreaterThan(advanceTimeOfDay(0, 10, 20));
  });
});

describe('wrapHours / formatClock', () => {
  it('brings any hour onto the clock face', () => {
    expect(wrapHours(-1)).toBeCloseTo(23, 9);
    expect(wrapHours(24)).toBe(0);
    expect(wrapHours(26.5)).toBeCloseTo(2.5, 9);
    expect(wrapHours(Number.NaN)).toBe(DEFAULT_TIME_OF_DAY);
  });

  it('reads out as a wall clock', () => {
    expect(formatClock(0)).toBe('00:00');
    expect(formatClock(6.5)).toBe('06:30');
    expect(formatClock(15)).toBe('15:00');
    expect(formatClock(23.75)).toBe('23:45');
  });
});
