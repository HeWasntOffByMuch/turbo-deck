/**
 * The wind-up / active / recovery bar (spec 110).
 *
 * The one control on this screen that decides how the game feels. It shows three
 * spans and one number, and the number is the important half: **the factor the
 * clip is being rescaled by to fit the timing.** Nudge a wind-up down far enough
 * and the animation stops reading as the motion it was, and this is where that
 * shows up -- in red, before it ships, rather than as a swing that looks like a
 * twitch on somebody's screen.
 *
 * Pure, so what the bar draws and what the validator rejects are computed by the
 * same functions rather than by two that agree today.
 */

import { actionTotalMs, stretchRatio, timeScaleFor } from '../../../units/timing.js';
import type { ActionTiming } from '../../../units/types.js';

export type Phase = 'windup' | 'active' | 'recovery';

export interface PhaseSpan {
  readonly phase: Phase;
  readonly ms: number;
  /** Pixels from the left of the bar. */
  readonly x: number;
  readonly width: number;
}

/**
 * The three spans, laid out across `width` pixels.
 *
 * Widths are accumulated from rounded edges rather than each rounded on its own,
 * so they always sum to exactly the bar -- three independently rounded widths
 * leave a one-pixel gap that looks like a rendering bug.
 */
export function phaseSpans(timing: ActionTiming, width: number): readonly PhaseSpan[] {
  const total = actionTotalMs(timing);
  const phases: readonly { phase: Phase; ms: number }[] = [
    { phase: 'windup', ms: timing.windupMs },
    { phase: 'active', ms: timing.activeMs },
    { phase: 'recovery', ms: timing.recoveryMs },
  ];
  if (total <= 0) return phases.map((entry) => ({ ...entry, x: 0, width: 0 }));

  const out: PhaseSpan[] = [];
  let accumulated = 0;
  let previousEdge = 0;
  for (const entry of phases) {
    accumulated += entry.ms;
    const edge = Math.round((accumulated / total) * width);
    out.push({ phase: entry.phase, ms: entry.ms, x: previousEdge, width: edge - previousEdge });
    previousEdge = edge;
  }
  return out;
}

export interface TimingVerdict {
  readonly totalMs: number;
  /** Playback rate the clip runs at to fit the action. */
  readonly rate: number;
  /** How far from 1 that rate is, in whichever direction. Always >= 1. */
  readonly ratio: number;
  readonly limit: number;
  readonly overLimit: boolean;
  /** What to say next to the number, in words rather than a code. */
  readonly note: string;
}

export function timingVerdict(timing: ActionTiming, clipDurationMs: number, maxTimeScale: number): TimingVerdict {
  const totalMs = actionTotalMs(timing);
  const rate = timeScaleFor(timing, clipDurationMs);
  const ratio = stretchRatio(rate);
  const overLimit = !(ratio <= maxTimeScale);

  const direction = rate > 1 ? 'compressed' : rate < 1 ? 'stretched' : 'unchanged';
  const note = overLimit
    ? `${ratio.toFixed(2)}x ${direction} -- past the ${maxTimeScale}x limit. This needs a different clip, not more stretching.`
    : `${ratio.toFixed(2)}x ${direction}`;

  return { totalMs, rate, ratio, limit: maxTimeScale, overLimit, note };
}

/**
 * Where an event marker sits along the bar, 0..1 of the action.
 *
 * The action and the clip share a normalised timeline once the clip has been
 * rescaled to fit -- that is the entire point of storing events normalised -- so
 * a marker's position on the clip is its position on the bar, unchanged.
 */
export function markerOnBar(normalizedTime: number): number {
  return Math.max(0, Math.min(1, normalizedTime));
}

/** Which phase a normalised time falls in, for colouring a marker. */
export function phaseAt(timing: ActionTiming, normalizedTime: number): Phase {
  const total = actionTotalMs(timing);
  if (total <= 0) return 'windup';
  const ms = normalizedTime * total;
  if (ms < timing.windupMs) return 'windup';
  if (ms < timing.windupMs + timing.activeMs) return 'active';
  return 'recovery';
}

export const PHASE_COLORS: Readonly<Record<Phase, string>> = {
  // Wind-up is the readable half of the decision, active is the commitment,
  // recovery is the price. Coloured so the shape of a blow is legible at a
  // glance without reading the numbers.
  windup: '#6fa8dc',
  active: '#e06c75',
  recovery: '#8a8aa0',
};
