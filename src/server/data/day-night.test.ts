import { describe, expect, it } from 'vitest';
import { SERVER_TICK_RATE } from '../config.js';
import {
  CYCLE_SECONDS,
  CYCLE_TICKS,
  DAY_NIGHT_CYCLE,
  DayPhase,
  cycleTickOf,
  formatWorldHours,
  phaseAt,
  phaseBeganAt,
  tickAtPhaseMidpoint,
  tickForHours,
  ticksUntilPhase,
  worldClockAt,
  type DayPhaseValue,
} from './day-night.js';

/** How many clock hours a segment covers, wrapping across midnight. */
function span(fromHours: number, toHours: number): number {
  const raw = toHours - fromHours;
  return raw > 0 ? raw : raw + 24;
}

describe('the cycle table (spec 264)', () => {
  it('sums to exactly one day, in hours, in seconds and in ticks', () => {
    const hours = DAY_NIGHT_CYCLE.reduce((sum, part) => sum + span(part.fromHours, part.toHours), 0);
    expect(hours).toBeCloseTo(24, 9);

    const seconds = DAY_NIGHT_CYCLE.reduce((sum, part) => sum + part.seconds, 0);
    expect(seconds).toBe(810);
    expect(CYCLE_SECONDS).toBe(810);
    expect(CYCLE_TICKS).toBe(810 * SERVER_TICK_RATE);
  });

  it('gives every segment a whole number of ticks', () => {
    // The phase is integer arithmetic on the tick, which is only exact while
    // this holds -- a fractional row would accumulate drift over a session.
    for (const part of DAY_NIGHT_CYCLE) {
      expect(Number.isInteger(part.ticks)).toBe(true);
      expect(part.ticks).toBe(part.seconds * SERVER_TICK_RATE);
    }
  });

  it('asks for ten minutes of day and two of night', () => {
    const byPhase = new Map(DAY_NIGHT_CYCLE.map((part) => [part.phase, part.seconds]));
    expect(byPhase.get(DayPhase.Day)).toBe(10 * 60);
    expect(byPhase.get(DayPhase.Night)).toBe(2 * 60);
  });

  it('gives dawn and dusk the same length, and both shorter than the night', () => {
    const byPhase = new Map(DAY_NIGHT_CYCLE.map((part) => [part.phase, part.seconds]));
    expect(byPhase.get(DayPhase.Dawn)).toBe(byPhase.get(DayPhase.Dusk));
    expect(byPhase.get(DayPhase.Dawn) as number).toBeLessThan(byPhase.get(DayPhase.Night) as number);
  });

  it('holds each phase exactly once, and joins them end to end', () => {
    const phases = DAY_NIGHT_CYCLE.map((part) => part.phase);
    expect(new Set(phases).size).toBe(phases.length);
    expect(phases.length).toBe(4);

    for (let i = 0; i < DAY_NIGHT_CYCLE.length; i++) {
      const part = DAY_NIGHT_CYCLE[i] as (typeof DAY_NIGHT_CYCLE)[number];
      const next = DAY_NIGHT_CYCLE[(i + 1) % DAY_NIGHT_CYCLE.length] as (typeof DAY_NIGHT_CYCLE)[number];
      expect(part.toHours).toBe(next.fromHours);
    }
  });

  it('changes rate only where the ramp is flat', () => {
    // The two boundaries that do step -- dawn->day and day->dusk -- bracket the
    // long daylight stretch. The other two are within a tenth of each other.
    const rate = (part: (typeof DAY_NIGHT_CYCLE)[number]): number =>
      span(part.fromHours, part.toHours) / part.seconds;
    const byPhase = new Map(DAY_NIGHT_CYCLE.map((part) => [part.phase, rate(part)]));

    const dusk = byPhase.get(DayPhase.Dusk) as number;
    const night = byPhase.get(DayPhase.Night) as number;
    const dawn = byPhase.get(DayPhase.Dawn) as number;
    expect(Math.abs(dusk / night - 1)).toBeLessThan(0.05);
    expect(Math.abs(night / dawn - 1)).toBeLessThan(0.1);
  });
});

describe('the world clock (spec 264)', () => {
  it('is a pure function of the tick, memo and all', () => {
    const first = worldClockAt(1234);
    worldClockAt(99999);
    const again = worldClockAt(1234);
    expect(again).toEqual(first);
  });

  it('starts the world at the first tick of the day, at 07:30', () => {
    const clock = worldClockAt(0);
    expect(clock.phase).toBe(DayPhase.Day);
    expect(clock.hours).toBeCloseTo(7.5, 9);
    expect(clock.phaseProgress).toBe(0);
    expect(clock.cycleCount).toBe(0);
  });

  it('spends exactly the authored real time in each phase', () => {
    // Counted through a whole cycle rather than read back off the table, so this
    // measures the clock rather than restating its input.
    const ticks = new Map<DayPhaseValue, number>();
    for (let tick = 0; tick < CYCLE_TICKS; tick++) {
      const phase = phaseAt(tick);
      ticks.set(phase, (ticks.get(phase) ?? 0) + 1);
    }
    expect((ticks.get(DayPhase.Day) as number) / SERVER_TICK_RATE).toBe(600);
    expect((ticks.get(DayPhase.Night) as number) / SERVER_TICK_RATE).toBe(120);
    expect((ticks.get(DayPhase.Dusk) as number) / SERVER_TICK_RATE).toBe(45);
    expect((ticks.get(DayPhase.Dawn) as number) / SERVER_TICK_RATE).toBe(45);
  });

  it('repeats', () => {
    for (const tick of [0, 1, 5000, 36000, 38700, 48599]) {
      const now = worldClockAt(tick);
      const later = worldClockAt(tick + CYCLE_TICKS);
      expect(later.phase).toBe(now.phase);
      expect(later.hours).toBeCloseTo(now.hours, 9);
      expect(later.darkness).toBeCloseTo(now.darkness, 9);
      expect(later.cycleTick).toBe(now.cycleTick);
      expect(later.cycleCount).toBe(now.cycleCount + 1);
    }
  });

  it('lands each boundary exactly on its authored hour, arriving from the one before', () => {
    // The rate changes at a boundary and the *value* must not. Asserted at the
    // four boundaries specifically rather than as a sweep: a sweep would pass on
    // an average, and what has to hold here is that the segment starts where the
    // last one ended, to the hour and to the tick.
    let start = 0;
    for (const part of DAY_NIGHT_CYCLE) {
      const arriving = worldClockAt(start - 1).hours;
      const beginning = worldClockAt(start).hours;
      expect(beginning).toBeCloseTo(part.fromHours, 9);

      // The step across the seam is one tick of the *previous* segment's rate,
      // never a jump.
      const forward = beginning >= arriving ? beginning - arriving : beginning + 24 - arriving;
      expect(forward).toBeGreaterThan(0);
      expect(forward).toBeLessThan(0.002);
      start += part.ticks;
    }
    expect(start).toBe(CYCLE_TICKS);
  });

  it('never runs the hour backwards', () => {
    for (let tick = 1; tick <= CYCLE_TICKS; tick++) {
      const before = worldClockAt(tick - 1).hours;
      const now = worldClockAt(tick).hours;
      const forward = now >= before ? now - before : now + 24 - before;
      expect(forward).toBeGreaterThanOrEqual(0);
      expect(forward).toBeLessThan(0.002);
    }
  });

  it('is total for a tick before the epoch, a huge tick and a broken one', () => {
    for (const tick of [-1, -CYCLE_TICKS - 7, 2 ** 34, Number.NaN, Number.POSITIVE_INFINITY]) {
      const clock = worldClockAt(tick);
      expect(clock.cycleTick).toBeGreaterThanOrEqual(0);
      expect(clock.cycleTick).toBeLessThan(CYCLE_TICKS);
      expect(clock.hours).toBeGreaterThanOrEqual(0);
      expect(clock.hours).toBeLessThan(24);
      expect(Number.isFinite(clock.darkness)).toBe(true);
    }
    expect(worldClockAt(-1).cycleCount).toBe(-1);
  });
});

describe('darkness, the hook that is a number (spec 264)', () => {
  it('is flat at both ends and continuous at all four boundaries', () => {
    let worst = 0;
    for (let tick = 1; tick <= CYCLE_TICKS; tick++) {
      worst = Math.max(worst, Math.abs(worldClockAt(tick).darkness - worldClockAt(tick - 1).darkness));
    }
    // A smoothstep over 2700 ticks peaks at 1.5/2700 per tick.
    expect(worst).toBeLessThan(0.001);

    for (let tick = 0; tick < CYCLE_TICKS; tick++) {
      const clock = worldClockAt(tick);
      if (clock.phase === DayPhase.Day) expect(clock.darkness).toBe(0);
      if (clock.phase === DayPhase.Night) expect(clock.darkness).toBe(1);
    }
  });

  it('rises through dusk and falls through dawn, without turning back', () => {
    const sweep = (phase: DayPhaseValue): readonly number[] => {
      const out: number[] = [];
      for (let tick = 0; tick < CYCLE_TICKS; tick++) {
        const clock = worldClockAt(tick);
        if (clock.phase === phase) out.push(clock.darkness);
      }
      return out;
    };

    const dusk = sweep(DayPhase.Dusk);
    for (let i = 1; i < dusk.length; i++) expect(dusk[i] as number).toBeGreaterThanOrEqual(dusk[i - 1] as number);
    expect(dusk[0]).toBe(0);

    const dawn = sweep(DayPhase.Dawn);
    for (let i = 1; i < dawn.length; i++) expect(dawn[i] as number).toBeLessThanOrEqual(dawn[i - 1] as number);
    expect(dawn[0]).toBe(1);
  });
});

describe('sunUp (spec 264)', () => {
  it('is the horizon rather than the phase name', () => {
    for (let tick = 0; tick < CYCLE_TICKS; tick += 7) {
      const clock = worldClockAt(tick);
      expect(clock.sunUp).toBe(clock.hours >= 6 && clock.hours < 18);
    }
  });

  it('is true for part of dawn and part of dusk, so the two questions differ', () => {
    // The whole reason there is no `isNight`: the sun is up before Day begins
    // and still up after it ends, so "the Night phase" and "the sun is down" are
    // two different claims and a caller has to say which it meant.
    const sawIn = (phase: DayPhaseValue, up: boolean): boolean => {
      for (let tick = 0; tick < CYCLE_TICKS; tick++) {
        const clock = worldClockAt(tick);
        if (clock.phase === phase && clock.sunUp === up) return true;
      }
      return false;
    };
    expect(sawIn(DayPhase.Dawn, true)).toBe(true);
    expect(sawIn(DayPhase.Dawn, false)).toBe(true);
    expect(sawIn(DayPhase.Dusk, true)).toBe(true);
    expect(sawIn(DayPhase.Dusk, false)).toBe(true);
    expect(sawIn(DayPhase.Day, false)).toBe(false);
    expect(sawIn(DayPhase.Night, true)).toBe(false);
  });

  it('leaves the sun up about five times as long as it is down', () => {
    let up = 0;
    for (let tick = 0; tick < CYCLE_TICKS; tick++) if (worldClockAt(tick).sunUp) up++;
    const down = CYCLE_TICKS - up;
    expect(up / SERVER_TICK_RATE).toBeCloseTo(643, 0);
    expect(down / SERVER_TICK_RATE).toBeCloseTo(167, 0);
    expect(up).toBeGreaterThan(down * 3);
  });
});

describe('the edge and the countdown (spec 264)', () => {
  it('reports a phase beginning on exactly four ticks per cycle', () => {
    const began: DayPhaseValue[] = [];
    for (let tick = 0; tick < CYCLE_TICKS; tick++) {
      const phase = phaseBeganAt(tick);
      if (phase !== null) began.push(phase);
    }
    expect(began).toEqual([DayPhase.Day, DayPhase.Dusk, DayPhase.Night, DayPhase.Dawn]);
  });

  it('reports it on the first tick of the phase and not the last of the one before', () => {
    expect(phaseBeganAt(0)).toBe(DayPhase.Day);
    expect(phaseBeganAt(1)).toBe(null);
    expect(phaseBeganAt(36000)).toBe(DayPhase.Dusk);
    expect(phaseBeganAt(35999)).toBe(null);
  });

  it('counts down to a phase without ever going negative or past a cycle', () => {
    for (const phase of [DayPhase.Day, DayPhase.Dusk, DayPhase.Night, DayPhase.Dawn]) {
      for (let tick = 0; tick < CYCLE_TICKS; tick += 13) {
        const left = ticksUntilPhase(tick, phase);
        expect(left).toBeGreaterThanOrEqual(0);
        expect(left).toBeLessThan(CYCLE_TICKS);
        expect(phaseAt(tick + left)).toBe(phase);
        expect(phaseBeganAt(tick + left)).toBe(phase);
      }
    }
  });

  it('is zero on the tick the phase begins', () => {
    expect(ticksUntilPhase(0, DayPhase.Day)).toBe(0);
    expect(ticksUntilPhase(36000, DayPhase.Dusk)).toBe(0);
  });

  it('leaves at least one tick in every phase', () => {
    for (let tick = 0; tick < CYCLE_TICKS; tick += 11) {
      expect(worldClockAt(tick).phaseTicksLeft).toBeGreaterThan(0);
    }
  });
});

describe('pinning an hour (spec 264)', () => {
  it('inverts the clock to within a tick, everywhere', () => {
    for (let hours = 0; hours < 24; hours += 0.05) {
      const tick = tickForHours(hours);
      const back = worldClockAt(tick).hours;
      // Signed distance round the clock face, in [-12, 12).
      const off = Math.abs((((back - hours) % 24) + 36) % 24 - 12);
      // Within one tick of the fastest segment.
      expect(off).toBeLessThan(0.002);
    }
  });

  it('lands a boundary hour exactly on its boundary tick', () => {
    // `((19.8 % 24) + 24) % 24` is 19.799999999999997, and every boundary in the
    // table is exactly such an hour -- so this is the case the naive wrap got
    // wrong, on the hours somebody pinning a clock is most likely to type.
    expect(tickForHours(7.5)).toBe(0);
    expect(tickForHours(16.5)).toBe(36000);
    expect(tickForHours(19.8)).toBe(38700);
    expect(tickForHours(4.5)).toBe(45900);
    expect(phaseAt(tickForHours(19.8))).toBe(DayPhase.Night);
    expect(phaseAt(tickForHours(4.5))).toBe(DayPhase.Dawn);
  });

  it('is total for an hour off the clock face', () => {
    for (const hours of [-3, 25, 48, Number.NaN, Number.POSITIVE_INFINITY]) {
      const tick = tickForHours(hours);
      expect(Number.isInteger(tick)).toBe(true);
      expect(tick).toBeGreaterThanOrEqual(0);
      expect(tick).toBeLessThan(CYCLE_TICKS);
    }
    expect(tickForHours(24 + 12)).toBe(tickForHours(12));
  });

  it('puts a phase midpoint inside that phase', () => {
    for (const phase of [DayPhase.Day, DayPhase.Dusk, DayPhase.Night, DayPhase.Dawn]) {
      const tick = tickAtPhaseMidpoint(phase);
      expect(phaseAt(tick)).toBe(phase);
      expect(worldClockAt(tick).phaseProgress).toBeCloseTo(0.5, 2);
    }
  });

  it('wraps a tick onto the cycle', () => {
    expect(cycleTickOf(0)).toBe(0);
    expect(cycleTickOf(CYCLE_TICKS)).toBe(0);
    expect(cycleTickOf(-1)).toBe(CYCLE_TICKS - 1);
  });
});

describe('the readout (spec 264)', () => {
  it('formats an hour as a clock face', () => {
    expect(formatWorldHours(7.5)).toBe('07:30');
    expect(formatWorldHours(0)).toBe('00:00');
    expect(formatWorldHours(19.8)).toBe('19:48');
    expect(formatWorldHours(24)).toBe('00:00');
    expect(formatWorldHours(Number.NaN)).toBe('00:00');
  });
});
