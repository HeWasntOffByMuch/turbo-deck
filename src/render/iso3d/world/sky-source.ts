import {
  DAY_PHASE_NAMES,
  DayPhase,
  formatWorldHours,
  tickAtPhaseMidpoint,
  tickForHours,
  worldClockAt,
  type DayPhaseValue,
  type WorldClock,
} from '../../../server/data/day-night.js';

/**
 * Whose clock the sky follows (spec 263).
 *
 * `carried-light.ts`'s shape one system along, and it holds that module's rule
 * for that module's reason -- **the panel wins where it is asking for something,
 * and the game decides where it is not.** Until spec 263 only the panel decided,
 * and it decided for one client at a time, which is the one thing a shared
 * cycle cannot be.
 *
 * Pure: it answers an hour and `scene.ts` turns that into lights. The split
 * every view-model in this directory keeps, and what lets the whole decision be
 * asserted in Node.
 */

/** What the panel's Sky section is asking for. */
export interface SkySettings {
  /**
   * `Day/night cycle`, and since spec 263 it opens **ticked**. Unticked hands
   * the sun to the manual `Direction`/`Elevation` sliders, which is what it has
   * always meant and what spec 033 built them for.
   */
  readonly cycleOn: boolean;
  /**
   * `Override the clock`, unticked by default. Ticked, the panel's own `Time`
   * slider drives the sky instead of the server's clock -- spec 047's behaviour
   * byte for byte, which is what keeps the panel useful for the thing it is for:
   * looking at an hour on purpose.
   */
  readonly overrideClock: boolean;
  /** The `Time` slider, in clock hours. Only read while overriding. */
  readonly panelHours: number;
}

/**
 * The hour to draw the sky at, or null for "the manual sliders own the sun".
 *
 * `clock` is null before the first delta lands, and that case takes the panel's
 * hour rather than guessing at one: the panel's default is a real, tuned
 * afternoon, where tick 0 would be an hour this client has no reason to believe
 * in yet.
 */
export function resolveSkyHours(settings: SkySettings, clock: WorldClock | null): number | null {
  if (!settings.cycleOn) return null;
  if (settings.overrideClock || clock === null) return settings.panelHours;
  return clock.hours;
}

/**
 * `?clock=` -- pin what this client draws to one hour (spec 263).
 *
 * In the register of `?seed=`, `?slots=` and `?field=`, and needed rather than
 * convenient: a sky that moves is a sky no harness can photograph twice, and
 * `probe-living-ground.ts` already stills the weather clock for exactly this
 * reason.
 *
 * Three things about it. It resolves to a **cycle tick**, so everything
 * downstream is the running case rather than a second path -- a pinned clock is
 * a real {@link WorldClock}, with a phase and a darkness and all. An
 * unrecognised value **defers** rather than picking an hour, which is
 * `device.ts`'s rule: a misspelling costs the flag and not the frame. And it
 * pins **what this client draws and nothing else** -- the server's clock is
 * unmoved, which is the honest line for a shared cycle, since one player must
 * not be able to make it night for everybody.
 *
 * Accepts an hour (`?clock=15`, `?clock=19.8`) or a phase name (`?clock=night`),
 * the latter resolving to the middle of that phase -- which is what somebody
 * asking for "night" means, and never a boundary where the sky is still moving.
 */
export function parseClockFlag(search: string): number | null {
  const raw = new URLSearchParams(search).get('clock');
  if (raw === null) return null;
  const value = raw.trim().toLowerCase();
  if (value === '') return null;

  for (const phase of [DayPhase.Day, DayPhase.Dusk, DayPhase.Night, DayPhase.Dawn]) {
    if (DAY_PHASE_NAMES[phase] === value) return tickAtPhaseMidpoint(phase);
  }

  // `Number('')` is 0 and `Number('night')` is NaN, so the empty case is refused
  // above and a non-finite one defers here rather than pinning midnight.
  const hours = Number(value);
  if (!Number.isFinite(hours)) return null;
  return tickForHours(hours);
}

/**
 * The clock to draw this frame with: the pin if there is one, otherwise the
 * world's own at the tick being drawn.
 */
export function drawnWorldClock(tick: number, pinnedTick: number | null): WorldClock {
  return worldClockAt(pinnedTick ?? tick);
}

/**
 * `data-world-clock`, for a harness and for a developer.
 *
 * Published from the clock the frame actually drew with rather than from the
 * tick, so a pin reads as the hour it pinned -- which is the only way to tell a
 * working pin from one that parsed and reached nothing.
 */
export function worldClockReadout(clock: WorldClock, pinned: boolean): string {
  return (
    `phase=${DAY_PHASE_NAMES[clock.phase]} hours=${formatWorldHours(clock.hours)}` +
    ` darkness=${clock.darkness.toFixed(2)} cycle=${String(clock.cycleCount)}` +
    ` sun=${clock.sunUp ? 'up' : 'down'}${pinned ? ' pinned' : ''}`
  );
}

/** Re-exported so a caller needs one import for the whole feature. */
export type { DayPhaseValue, WorldClock };
