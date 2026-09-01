/**
 * The world clock (spec 263): what time it is, as a pure function of the
 * server's tick.
 *
 * Spec 047 built the whole day/night cycle -- the sun's arc, the nine-key
 * colour ramp, the terminator fade -- and drove it from a slider in a tuning
 * panel, which spec 254 then hid in the shipped build. This is the half that
 * spec said would need its own spec: **a clock the server keeps**, so that
 * every player stands in the same evening.
 *
 * ## Why nothing crosses the wire
 *
 * The clock is a pure function of the tick, and the client already holds one:
 * `ClientView.estimatedTick` is the server's clock re-synced to every delta with
 * half the round trip added. So both ends compute the same hour from the same
 * number and there is no message, no protocol version, and no state to persist,
 * replicate or forget to clear. It is the pattern this repo already uses for the
 * loot reveal's phase, the stun swirl's angle and the affliction beat -- spec
 * 215 states it outright: *the beat is derived, not sent*.
 *
 * What that costs is one round trip's worth of hour, which at the fastest the
 * clock ever runs (dusk, 0.073 hours a second) is under a hundredth of an hour
 * on a 200ms connection. It is not a quantity anybody can see.
 *
 * ## The hook
 *
 * {@link worldClockAt} is the whole surface, and every pass in the sim already
 * has the tick in hand. That is deliberately *not* a field on
 * `ServerWorldState`, a member of `StepContext` or a `ServerSimEvent`: each of
 * those would be a socket sitting un-plugged in a dozen places -- a field to
 * persist and replicate, a context member every test fixture has to supply, a
 * `switch` arm in every consumer -- to say something derivable from a number
 * those callers were handed anyway. {@link phaseBeganAt} is the edge, and being
 * a comparison rather than a fired event, nothing can forget to raise it.
 *
 * Pure and part of the deterministic core: no `Date`, no `Math.random`, no
 * mutable state but a memo whose only input is the tick.
 */

import { SERVER_TICK_RATE } from '../config.js';

/**
 * The four named parts of a cycle.
 *
 * A const object rather than a string union, the `StatusId` pattern: what a
 * caller does with one is compare it and switch on it, and an ordinal is one
 * byte if this ever does need to cross anything.
 */
export const DayPhase = {
  Day: 0,
  Dusk: 1,
  Night: 2,
  Dawn: 3,
} as const;

export type DayPhaseValue = (typeof DayPhase)[keyof typeof DayPhase];

/** For readouts and for `?clock=`. Not a player-facing string. */
export const DAY_PHASE_NAMES: Readonly<Record<DayPhaseValue, string>> = {
  [DayPhase.Day]: 'day',
  [DayPhase.Dusk]: 'dusk',
  [DayPhase.Night]: 'night',
  [DayPhase.Dawn]: 'dawn',
};

/** One part of the cycle: a span of clock hours, given a real duration. */
export interface DayNightSegment {
  readonly phase: DayPhaseValue;
  /** How long this part lasts in real time. */
  readonly seconds: number;
  /** The clock hour it starts at. */
  readonly fromHours: number;
  /**
   * The clock hour it ends at. Greater than {@link fromHours} except for Night,
   * which crosses midnight and is measured with a wrap.
   */
  readonly toHours: number;
  /** {@link seconds} in ticks. An integer for every row, and asserted. */
  readonly ticks: number;
}

/**
 * Bring an hour onto the clock face.
 *
 * The obvious `((h % 24) + 24) % 24` is not used, and the reason is a real bug
 * rather than fastidiousness: for an hour already in range it is two float
 * operations that need not happen, and `((19.8 % 24) + 24) % 24` is
 * `19.799999999999997`. Every segment boundary in {@link DAY_NIGHT_CYCLE} is
 * exactly such an hour, so the round trip through it put `tickForHours(19.8)` on
 * the last tick of Dusk instead of the first of Night -- the one case anybody
 * pinning a clock by hand is most likely to type.
 */
function wrapHours24(hours: number): number {
  if (!Number.isFinite(hours)) return 0;
  if (hours >= 0 && hours < 24) return hours;
  return ((hours % 24) + 24) % 24;
}

/** How many clock hours a segment covers, wrapping across midnight. */
function spanHours(fromHours: number, toHours: number): number {
  const span = toHours - fromHours;
  return span > 0 ? span : span + 24;
}

function segment(phase: DayPhaseValue, seconds: number, fromHours: number, toHours: number): DayNightSegment {
  return { phase, seconds, fromHours, toHours, ticks: Math.round(seconds * SERVER_TICK_RATE) };
}

/**
 * The cycle, in the order it happens, **starting where it starts**.
 *
 * Authored Day-first rather than Dawn-first for one reason: tick 0 is then the
 * first tick of the first row, so the epoch is the table's own beginning and
 * there is no offset constant to keep in step with it. A fresh server opens in
 * morning light with the full ten minutes ahead of it, which is also what makes
 * every harness that boots a server and photographs it inside a minute a harness
 * photographing daylight.
 *
 * ## The rates
 *
 * The mapping from real time to clock hours is piecewise linear with a
 * **different rate per segment**, and that is the only way a 10-minute day and a
 * 2-minute night are expressible at all -- `advanceTimeOfDay` is linear in `dt`,
 * so under one rate day and night are each half a cycle.
 *
 * | Segment | Hours | Seconds | Hours/second |
 * |---|---|---|---|
 * | Day   | 07:30 -> 16:30 | 600 | 0.0150 |
 * | Dusk  | 16:30 -> 19:48 |  45 | 0.0733 |
 * | Night | 19:48 -> 04:30 | 120 | 0.0725 |
 * | Dawn  | 04:30 -> 07:30 |  45 | 0.0667 |
 *
 * ## Why these hours
 *
 * **They are `SKY_KEYS` entries**, and that is the point rather than a
 * coincidence. `daynight.ts`'s ramp has keys at 4.5, 7.5, 16.5 and 19.8; these
 * segments *are* that ramp's own structure. So a boundary -- the one place a
 * piecewise clock can show a kink, because the rate jumps there -- always lands
 * on a keyframe and never in the middle of a colour transition.
 *
 * Three of the four boundaries barely have a kink at all: dusk->night is 0.0733
 * to 0.0725 and night->dawn is 0.0725 to 0.0667. The two real steps are
 * dawn->day (4.4x slower) and day->dusk (4.9x faster), and both sit at the ends
 * of the long, nearly-constant daylight stretch -- so what changes speed is a
 * colour that is barely moving either way.
 *
 * ## Why day and night are authored independently
 *
 * 600 and 120 are exactly the ten minutes and the two minutes, and moving one
 * does not silently move the other or eat the sunrise. The cycle is therefore
 * 13m30s rather than 12m, which is stated rather than hidden. Measured against
 * the *horizon* instead of the segment names the sun is up for 10m43s and down
 * for 2m47s: the named phases are the flat parts and the transitions divide
 * between them.
 *
 * Dawn spans a genuine sunrise -- 04:30 to 07:30 crosses the horizon at 06:00 --
 * so it is 22.5s of the sky reddening with the sun still down and 22.5s of it
 * climbing into morning. It is the same 45s as dusk, because asymmetry would
 * need a reason and there is not one: what makes dawn the payoff for a short
 * night is that it is 45 seconds against night's 120.
 */
export const DAY_NIGHT_CYCLE: readonly DayNightSegment[] = [
  segment(DayPhase.Day, 600, 7.5, 16.5),
  segment(DayPhase.Dusk, 45, 16.5, 19.8),
  segment(DayPhase.Night, 120, 19.8, 4.5),
  segment(DayPhase.Dawn, 45, 4.5, 7.5),
];

/** One whole cycle, in ticks. 48,600 -- and an integer, which is asserted. */
export const CYCLE_TICKS: number = DAY_NIGHT_CYCLE.reduce((sum, part) => sum + part.ticks, 0);

/** One whole cycle in real seconds, for readouts. */
export const CYCLE_SECONDS: number = CYCLE_TICKS / SERVER_TICK_RATE;

/** The tick each segment begins on, parallel to {@link DAY_NIGHT_CYCLE}. */
const SEGMENT_STARTS: readonly number[] = (() => {
  const starts: number[] = [];
  let at = 0;
  for (const part of DAY_NIGHT_CYCLE) {
    starts.push(at);
    at += part.ticks;
  }
  return starts;
})();

/** Everything the game or the sky needs to know about one instant. */
export interface WorldClock {
  /** The tick this was sampled at, as handed in. */
  readonly tick: number;
  /** Ticks into the current cycle, in `[0, CYCLE_TICKS)`. */
  readonly cycleTick: number;
  /**
   * Whole cycles since tick 0 -- "day 3". Negative for a tick before the epoch,
   * which only a test ever has.
   */
  readonly cycleCount: number;
  readonly phase: DayPhaseValue;
  /** How far through the current segment, in `[0, 1)`. */
  readonly phaseProgress: number;
  /** Ticks until the next segment begins. Never 0 -- a segment always has one left. */
  readonly phaseTicksLeft: number;
  /**
   * The clock hour, in `[0, 24)`. What `skyAt` takes, and the one field of this
   * whole interface the renderer reads.
   */
  readonly hours: number;
  /**
   * The sun is above the horizon: `6 <= hours < 18`.
   *
   * Not the same question as `phase === Night`, which is why there is no
   * `isNight` here to conflate them: the sun is already up for the last half of
   * Dawn and still up for the first half of Dusk.
   */
  readonly sunUp: boolean;
  /**
   * How dark it is, in `[0, 1]`. **The continuous hook**: 0 through Day,
   * smoothstepped up across Dusk, 1 through Night, smoothstepped down across
   * Dawn.
   *
   * Deliberately not derived from the sky's light intensity. That is
   * presentation -- tuned by eye, and free to be retuned by anybody doing a look
   * pass -- and this is a gameplay quantity with a stated shape. A mechanic
   * reading the ramp would be a rule that moves when somebody adjusts a colour.
   *
   * Smoothstepped rather than linear for `horizonShadow.strength`'s reason:
   * whatever scales by this inherits its kink, and a rate that jumps at a
   * boundary is the one thing the segment table is arranged to avoid.
   */
  readonly darkness: number;
}

/** Hermite smoothstep on an already-normalised `t`. */
function smoothstep(t: number): number {
  const x = t < 0 ? 0 : t > 1 ? 1 : t;
  return x * x * (3 - 2 * x);
}

/** Bring any tick onto the cycle, including negatives. */
export function cycleTickOf(tick: number): number {
  if (!Number.isFinite(tick)) return 0;
  const whole = Math.floor(tick);
  return ((whole % CYCLE_TICKS) + CYCLE_TICKS) % CYCLE_TICKS;
}

/** How many whole cycles have elapsed at `tick`. */
export function cycleCountOf(tick: number): number {
  if (!Number.isFinite(tick)) return 0;
  return Math.floor(Math.floor(tick) / CYCLE_TICKS);
}

/**
 * Darkness for a segment at `progress` through it. Split out so the ramp is one
 * description rather than four cases inside the builder.
 */
function darknessOf(phase: DayPhaseValue, progress: number): number {
  switch (phase) {
    case DayPhase.Day:
      return 0;
    case DayPhase.Dusk:
      return smoothstep(progress);
    case DayPhase.Night:
      return 1;
    case DayPhase.Dawn:
      return 1 - smoothstep(progress);
  }
}

function buildClock(tick: number): WorldClock {
  const cycleTick = cycleTickOf(tick);

  let index = DAY_NIGHT_CYCLE.length - 1;
  for (let i = 0; i < DAY_NIGHT_CYCLE.length; i++) {
    const start = SEGMENT_STARTS[i] as number;
    const part = DAY_NIGHT_CYCLE[i] as DayNightSegment;
    if (cycleTick < start + part.ticks) {
      index = i;
      break;
    }
  }

  const part = DAY_NIGHT_CYCLE[index] as DayNightSegment;
  const into = cycleTick - (SEGMENT_STARTS[index] as number);
  const progress = part.ticks > 0 ? into / part.ticks : 0;
  // Wrapped, because Night's span crosses midnight -- 19.8 + 8.7 is 28.5.
  const hours = (part.fromHours + spanHours(part.fromHours, part.toHours) * progress) % 24;

  return {
    tick,
    cycleTick,
    cycleCount: cycleCountOf(tick),
    phase: part.phase,
    phaseProgress: progress,
    phaseTicksLeft: part.ticks - into,
    hours,
    sunUp: hours >= 6 && hours < 18,
    darkness: darknessOf(part.phase, progress),
  };
}

/**
 * The last answer, keyed on the tick that produced it.
 *
 * A one-entry memo whose only input is the tick, so it is pure by construction:
 * the same tick gives the same object, and there is no way for what is *held* to
 * change what is *answered*. That is what makes it safe in the deterministic
 * core, and it is what lets a pass ask once per body without paying for a
 * search and an allocation each time.
 */
let memoTick = Number.NaN;
let memoClock: WorldClock | null = null;

/** What time it is at `tick`. Total: a negative or non-finite tick is wrapped. */
export function worldClockAt(tick: number): WorldClock {
  const key = Number.isFinite(tick) ? Math.floor(tick) : 0;
  if (memoClock !== null && key === memoTick) return memoClock;
  const clock = buildClock(key);
  memoTick = key;
  memoClock = clock;
  return clock;
}

/** Which part of the cycle `tick` is in. */
export function phaseAt(tick: number): DayPhaseValue {
  return worldClockAt(tick).phase;
}

/**
 * The phase that *began* on this tick, or null.
 *
 * The edge, for a mechanic that wants to act once at nightfall rather than every
 * tick of the night. A comparison rather than a fired event, so there is nothing
 * to remember to raise and nothing to drop.
 */
export function phaseBeganAt(tick: number): DayPhaseValue | null {
  const now = worldClockAt(tick);
  const before = worldClockAt(tick - 1);
  return now.phase === before.phase ? null : now.phase;
}

/**
 * Ticks from `tick` until `phase` next begins. 0 on the tick it begins, and at
 * most one whole cycle.
 */
export function ticksUntilPhase(tick: number, phase: DayPhaseValue): number {
  const index = DAY_NIGHT_CYCLE.findIndex((part) => part.phase === phase);
  if (index < 0) return 0;
  const start = SEGMENT_STARTS[index] as number;
  const now = cycleTickOf(tick);
  return start >= now ? start - now : start + CYCLE_TICKS - now;
}

/**
 * The first tick of the cycle at which the clock reads `hours`. The inverse of
 * {@link WorldClock.hours}, and what `?clock=15` resolves through.
 *
 * Exact rather than searched: the segment holding an hour is found by span, and
 * the position inside it is a proportion.
 */
export function tickForHours(hours: number): number {
  const wanted = wrapHours24(hours);
  for (let i = 0; i < DAY_NIGHT_CYCLE.length; i++) {
    const part = DAY_NIGHT_CYCLE[i] as DayNightSegment;
    const span = spanHours(part.fromHours, part.toHours);
    // Measured as a distance forward from the segment's start, so the row that
    // crosses midnight needs no case of its own.
    const ahead = wanted - part.fromHours;
    const into = ahead >= 0 ? ahead : ahead + 24;
    if (into < span) {
      // Rounded rather than floored, so the answer is the *nearest* tick to the
      // hour asked for rather than always the one below it.
      return (SEGMENT_STARTS[i] as number) + Math.round((into / span) * part.ticks);
    }
  }
  return 0;
}

/** The tick at the middle of a phase -- what `?clock=night` resolves to. */
export function tickAtPhaseMidpoint(phase: DayPhaseValue): number {
  const index = DAY_NIGHT_CYCLE.findIndex((part) => part.phase === phase);
  if (index < 0) return 0;
  const part = DAY_NIGHT_CYCLE[index] as DayNightSegment;
  return (SEGMENT_STARTS[index] as number) + Math.floor(part.ticks / 2);
}

/** An hour as `HH:MM`, for readouts. Mirrors `daynight.ts`'s `formatClock`. */
export function formatWorldHours(hours: number): string {
  const h = wrapHours24(hours);
  const whole = Math.floor(h);
  const minutes = Math.floor((h - whole) * 60);
  return `${String(whole).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}
