import { describe, expect, it } from 'vitest';
import {
  CYCLE_TICKS,
  DAY_NIGHT_CYCLE,
  DayPhase,
  tickForHours,
  worldClockAt,
} from '../../../server/data/day-night.js';
import { SKY_KEY_HOURS, skyAt } from '../daynight.js';

/**
 * Where the server's clock (spec 264) meets the sky spec 047 authored.
 *
 * On this side of the fence rather than beside `day-night.ts`, because
 * `src/server/data/` is deterministic core and may not import the renderer --
 * and because every claim here is about the *ramp*, which is the renderer's.
 */
describe('the clock against the sky ramp (spec 264)', () => {
  it('puts every segment boundary on a keyframe', () => {
    // The segments *are* the ramp's own structure, which is what keeps the rate
    // changing where the colour is not.
    for (const part of DAY_NIGHT_CYCLE) {
      expect(SKY_KEY_HOURS).toContain(part.fromHours);
      expect(SKY_KEY_HOURS).toContain(part.toHours);
    }
  });

  it('does not step, at 60fps, anywhere in the cycle', () => {
    // Spec 047's headline assertion re-stated against a rate that is no longer
    // uniform. The retro pass resolves 12 steps per channel, so 1/12 is what
    // "visible" means and everything here has to be far under it -- including
    // across the two boundaries where the clock changes speed by ~5x.
    let worstChannel = 0;
    let worstIntensity = 0;
    for (let tick = 1; tick <= CYCLE_TICKS; tick++) {
      const before = skyAt(worldClockAt(tick - 1).hours);
      const now = skyAt(worldClockAt(tick).hours);
      for (const key of ['skyColor', 'lightColor', 'ambientColor'] as const) {
        worstChannel = Math.max(
          worstChannel,
          Math.abs(now[key].r - before[key].r),
          Math.abs(now[key].g - before[key].g),
          Math.abs(now[key].b - before[key].b),
        );
      }
      worstIntensity = Math.max(
        worstIntensity,
        Math.abs(now.lightIntensity - before.lightIntensity),
        Math.abs(now.ambientIntensity - before.ambientIntensity),
      );
    }
    expect(worstChannel).toBeLessThan(1 / 12 / 10);
    expect(worstIntensity).toBeLessThan(0.02);
  });

  it('moves every colour on every frame of a transition, rather than holding and jumping', () => {
    // The other half of "does not step": a channel that holds for a while and
    // then takes a whole step at once is exactly what spec 047's byte rounding
    // did, and the transitions are where a clock this fast would show it.
    //
    // Scoped to Dusk and Dawn, which is spec 047's own choice for this
    // assertion and for a reason that is about the ramp rather than the clock:
    // its first and last keys are the *same colour* by authorship, so between
    // 21:00 and midnight the sky is genuinely constant and a "must always move"
    // test there would be asserting against the palette.
    for (const part of DAY_NIGHT_CYCLE) {
      if (part.phase !== DayPhase.Dusk && part.phase !== DayPhase.Dawn) continue;
      const start = tickForHours(part.fromHours);
      let previous = skyAt(worldClockAt(start).hours);
      for (let tick = start + 1; tick < start + part.ticks; tick++) {
        const sky = skyAt(worldClockAt(tick).hours);
        expect(sky.skyColor).not.toEqual(previous.skyColor);
        expect(sky.lightColor).not.toEqual(previous.lightColor);
        expect(sky.ambientColor).not.toEqual(previous.ambientColor);
        previous = sky;
      }
    }
  });

  it('is darker at night than by day, measured through the real ramp', () => {
    const noon = skyAt(worldClockAt(tickForHours(12)).hours);
    const midnight = skyAt(worldClockAt(tickForHours(0)).hours);
    expect(midnight.lightIntensity).toBeLessThan(noon.lightIntensity);
    expect(midnight.ambientIntensity).toBeLessThan(noon.ambientIntensity);
  });

  it('carries the sun through a real sunrise inside dawn', () => {
    // Dawn is not a fade between two colours: the sun crosses the horizon in the
    // middle of it, which is what makes it a sunrise rather than a dimmer.
    const start = skyAt(worldClockAt(tickForHours(4.5)).hours);
    const end = skyAt(worldClockAt(tickForHours(7.5) + CYCLE_TICKS - 1).hours);
    expect(start.isDay).toBe(false);
    expect(end.isDay).toBe(true);
    expect(end.lightIntensity).toBeGreaterThan(start.lightIntensity);
  });

  it('reaches the sunset inside dusk, in the other direction', () => {
    const start = skyAt(worldClockAt(tickForHours(16.5)).hours);
    const end = skyAt(worldClockAt(tickForHours(19.8) - 1).hours);
    expect(start.isDay).toBe(true);
    expect(end.isDay).toBe(false);
    expect(end.lightIntensity).toBeLessThan(start.lightIntensity);
  });
});
