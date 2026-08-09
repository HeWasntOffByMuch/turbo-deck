/**
 * Whose clock wins (spec 107).
 *
 * A generated clip is however long the generator felt like making it. A wind-up
 * is however long the fight needs it to be. These are not negotiable against
 * each other: **the action timing is the source of truth and the clip is
 * rescaled to fit it.** If it were the other way round, regenerating an
 * animation would silently re-tune combat, and the timing that this whole game
 * is built on would be a side effect of an API call.
 *
 * What is bounded is how far that rescaling may go, because a clip dragged far
 * enough stops reading as the motion it was. The bound is two-sided: a clip
 * crammed into a quarter of its length reads as badly as one hauled out to four
 * times it, and bounding only the drag would let "make the wind-up snappier"
 * quietly become a flicker.
 *
 * Pure arithmetic, no document loading, so the Studio tab's timing panel and the
 * validator compute the same number from the same function rather than each
 * having their own idea of what a stretch factor is.
 */

import type { ActionTiming } from './types.js';

/**
 * The default bound, used when a unitdef does not name its own `maxTimeScale`.
 *
 * 2.0 because that is roughly where a rescaled human motion stops being read as
 * the motion and starts being read as slow-motion or as a twitch. It is a
 * judgement call and so it is configurable per unit -- but the default being
 * generous would make the check decorative.
 */
export const DEFAULT_MAX_TIME_SCALE = 2;

/** Wind-up plus active plus recovery: how long the action takes, start to free. */
export function actionTotalMs(timing: ActionTiming): number {
  return timing.windupMs + timing.activeMs + timing.recoveryMs;
}

/**
 * The playback rate the clip runs at to cover the action exactly.
 *
 * A rate, not a duration: 2 means "play twice as fast", which is what a mixer's
 * `timeScale` wants. Returns `Infinity` for a zero-length action rather than
 * `NaN`, so a caller comparing against the bound rejects it instead of silently
 * passing every comparison the way `NaN` does.
 */
export function timeScaleFor(timing: ActionTiming, clipDurationMs: number): number {
  const total = actionTotalMs(timing);
  if (total <= 0) return Number.POSITIVE_INFINITY;
  return clipDurationMs / total;
}

/**
 * How far a playback rate is from 1, in whichever direction it went.
 *
 * Always >= 1. A rate of 2 (twice as fast) and a rate of 0.5 (half speed) are
 * both a ratio of 2, which is what makes one `maxTimeScale` able to bound both
 * squash and stretch without the caller having to know which way it went.
 */
export function stretchRatio(rate: number): number {
  if (!Number.isFinite(rate) || rate <= 0) return Number.POSITIVE_INFINITY;
  return Math.max(rate, 1 / rate);
}

/** Whether a playback rate is within a bound. Non-finite rates are never within. */
export function withinTimeScale(rate: number, maxTimeScale: number): boolean {
  return stretchRatio(rate) <= maxTimeScale;
}

/**
 * An action's three phases as normalized spans of the rescaled clip.
 *
 * Normalized because that is the space clip events live in: once the clip has
 * been scaled to the action, "does the hit land during the active window" is a
 * comparison between two numbers in 0..1, with no milliseconds and no scale
 * factor left in the question.
 */
export interface PhaseWindows {
  readonly windup: readonly [number, number];
  readonly active: readonly [number, number];
  readonly recovery: readonly [number, number];
}

export function phaseWindows(timing: ActionTiming): PhaseWindows {
  const total = actionTotalMs(timing);
  if (total <= 0) {
    return { windup: [0, 0], active: [0, 0], recovery: [0, 0] };
  }
  const windupEnd = timing.windupMs / total;
  const activeEnd = (timing.windupMs + timing.activeMs) / total;
  return {
    windup: [0, windupEnd],
    active: [windupEnd, activeEnd],
    recovery: [activeEnd, 1],
  };
}

/**
 * Whether a normalized time falls inside a window, inclusive at both ends.
 *
 * Inclusive because an event authored exactly on the boundary between wind-up
 * and active is the *normal* case -- it is the frame the blow lands -- and an
 * exclusive test would reject the one placement everybody reaches for first.
 */
export function inWindow(normalizedTime: number, window: readonly [number, number]): boolean {
  return normalizedTime >= window[0] && normalizedTime <= window[1];
}

/**
 * Which tick indices an event at `normalizedTime` falls on, for a clip playing
 * over `durationMs` at `tickMs`.
 *
 * Here rather than in the runtime because the same arithmetic decides two
 * things that must agree: whether the validator thinks an event is reachable,
 * and which tick the runtime actually fires it on. An event that rounds onto
 * tick `n` at 60Hz and past the end of the clip at 30Hz is a bug that only
 * shows up on someone else's machine, and it is found by calling this twice.
 */
export function eventTickIndex(normalizedTime: number, durationMs: number, tickMs: number): number {
  if (tickMs <= 0) return 0;
  return Math.floor((normalizedTime * durationMs) / tickMs);
}
