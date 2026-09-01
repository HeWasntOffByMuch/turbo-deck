import { describe, expect, it } from 'vitest';
import {
  CYCLE_TICKS,
  DayPhase,
  tickForHours,
  worldClockAt,
} from '../../../server/data/day-night.js';
import { DEFAULT_TIME_OF_DAY } from '../daynight.js';
import {
  drawnWorldClock,
  parseClockFlag,
  resolveSkyHours,
  worldClockReadout,
  type SkySettings,
} from './sky-source.js';

const DEFAULTS: SkySettings = { cycleOn: true, overrideClock: false, panelHours: DEFAULT_TIME_OF_DAY };

describe('who owns the sky (spec 264)', () => {
  it('follows the world clock by default', () => {
    const clock = worldClockAt(tickForHours(9));
    expect(resolveSkyHours(DEFAULTS, clock)).toBe(clock.hours);
  });

  it('hands the panel the sky while it is overriding', () => {
    const clock = worldClockAt(tickForHours(9));
    const hours = resolveSkyHours({ ...DEFAULTS, overrideClock: true, panelHours: 3 }, clock);
    expect(hours).toBe(3);
  });

  it('hands the manual sliders the sun when the cycle is switched off', () => {
    // Null is the whole of "the Direction/Elevation sliders own it", which is
    // what unticking the cycle has meant since spec 033 and still does.
    expect(resolveSkyHours({ ...DEFAULTS, cycleOn: false }, worldClockAt(0))).toBe(null);
    expect(resolveSkyHours({ cycleOn: false, overrideClock: true, panelHours: 3 }, null)).toBe(null);
  });

  it('takes the panel hour before the first delta lands', () => {
    // The panel's default is a real, tuned afternoon; tick 0 would be an hour
    // this client has no reason to believe in yet.
    expect(resolveSkyHours(DEFAULTS, null)).toBe(DEFAULT_TIME_OF_DAY);
  });
});

describe('?clock= (spec 264)', () => {
  it('defers when it is absent, empty or unrecognised', () => {
    // `device.ts`'s rule: a misspelling costs the flag and not the frame.
    for (const search of ['', '?seed=1', '?clock=', '?clock=%20', '?clock=noon', '?clock=nite']) {
      expect(parseClockFlag(search)).toBe(null);
    }
  });

  it('reads an hour', () => {
    expect(parseClockFlag('?clock=15')).toBe(tickForHours(15));
    expect(parseClockFlag('?clock=19.8')).toBe(tickForHours(19.8));
    expect(parseClockFlag('?clock=0')).toBe(tickForHours(0));
  });

  it('reads a phase name, and lands in the middle of that phase', () => {
    for (const [name, phase] of [
      ['day', DayPhase.Day],
      ['dusk', DayPhase.Dusk],
      ['night', DayPhase.Night],
      ['dawn', DayPhase.Dawn],
    ] as const) {
      const tick = parseClockFlag(`?clock=${name}`);
      expect(tick).not.toBe(null);
      const clock = worldClockAt(tick as number);
      expect(clock.phase).toBe(phase);
      // The middle rather than a boundary: "night" means night, not the instant
      // the sky is still arriving at it.
      expect(clock.phaseProgress).toBeGreaterThan(0.25);
      expect(clock.phaseProgress).toBeLessThan(0.75);
    }
  });

  it('is case- and space-insensitive', () => {
    expect(parseClockFlag('?clock=%20Night%20')).toBe(parseClockFlag('?clock=night'));
  });

  it('resolves to a tick on the cycle, so a pin is a real clock', () => {
    for (const search of ['?clock=night', '?clock=15', '?clock=99']) {
      const tick = parseClockFlag(search) as number;
      expect(Number.isInteger(tick)).toBe(true);
      expect(tick).toBeGreaterThanOrEqual(0);
      expect(tick).toBeLessThan(CYCLE_TICKS);
    }
  });

  it('holds the hour still while the tick runs on', () => {
    const pinned = parseClockFlag('?clock=night');
    const early = drawnWorldClock(10, pinned);
    const late = drawnWorldClock(10 + CYCLE_TICKS / 2, pinned);
    expect(late.hours).toBe(early.hours);
    expect(late.phase).toBe(DayPhase.Night);
  });

  it('lets the clock run when there is no pin', () => {
    const early = drawnWorldClock(0, null);
    const late = drawnWorldClock(20000, null);
    expect(late.hours).not.toBe(early.hours);
  });
});

describe('the readout (spec 264)', () => {
  it('names the phase, the hour, the darkness and whether it is pinned', () => {
    const readout = worldClockReadout(worldClockAt(0), false);
    expect(readout).toContain('phase=day');
    expect(readout).toContain('hours=07:30');
    expect(readout).toContain('darkness=0.00');
    expect(readout).toContain('sun=up');
    expect(readout).not.toContain('pinned');
  });

  it('says so when it is pinned', () => {
    const night = worldClockAt(parseClockFlag('?clock=night') as number);
    const readout = worldClockReadout(night, true);
    expect(readout).toContain('phase=night');
    expect(readout).toContain('darkness=1.00');
    expect(readout).toContain('sun=down');
    expect(readout).toContain('pinned');
  });
});
