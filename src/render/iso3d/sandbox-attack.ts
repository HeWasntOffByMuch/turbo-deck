/**
 * A rehearsal of a cast, for the movement sandbox (spec 140).
 *
 * **This is not a sim and does not pretend to be one.** `sandbox-mover.ts` says
 * the same thing about movement and for the same reason: no server sees this, no
 * other body exists in the tab that runs it, and nothing it produces travels
 * further than the rig standing on it. Reviving a second combat sim to watch a
 * pig swing a stick would be the worst possible reason to have two of them.
 *
 * What it *does* reproduce, exactly, is the one rule that makes an animation
 * legible: **the timing is authoritative and the clip is rescaled to fit it**
 * (spec 107). Drag the wind-up to 900ms and the swing slows down to land on it,
 * because {@link attackRate} is `timeScaleFor` and nothing else. That is the
 * property the sandbox exists to let somebody feel, and it is the property that
 * is impossible to feel from a number in a document.
 *
 * The shape mirrors the server's: `windup -> release -> recovery -> free`, with
 * the blow landing on the tick the wind-up ends. Whole ticks throughout, so the
 * hit lands on the same tick at 30fps as at 144 -- the same reason `machine.ts`
 * counts integers.
 *
 * Pure and headlessly tested.
 */

import { timeScaleFor } from '../../units/timing.js';
import type { ActionTiming } from '../../units/types.js';

/** What a swing costs in time. Every field is milliseconds and panel-editable. */
export interface AttackTuning {
  windupMs: number;
  activeMs: number;
  recoveryMs: number;
  /**
   * From the start of one swing to when the next may begin.
   *
   * From the *start* rather than from the end, which is how `melee.slash` works:
   * the cooldown is stamped when the cast commits, so a long wind-up eats into
   * it rather than adding to it.
   */
  cooldownMs: number;
}

/**
 * `melee.slash`, as the ability table has it, plus the two numbers the table
 * does not carry.
 *
 * The server's cast has no recovery -- the release frees the caster and only a
 * channel runs past it (spec 068) -- so `activeMs` and `recoveryMs` here are the
 * *animation's* phases, which is what an `actionTiming` has always meant. They
 * default to what the pig's own unitdef ships with, so the sandbox opens showing
 * the shipped swing rather than one somebody invented for a slider.
 */
export function defaultAttackTuning(): AttackTuning {
  return { windupMs: 500, activeMs: 100, recoveryMs: 200, cooldownMs: 600 };
}

export type AttackPhase = 'ready' | 'windup' | 'active' | 'recovery' | 'cooldown';

export interface AttackState {
  readonly phase: AttackPhase;
  /** Ticks completed since this swing began. Zero while ready. */
  readonly ticks: number;
}

export const ATTACK_READY: AttackState = { phase: 'ready', ticks: 0 };

export interface AttackStep {
  readonly state: AttackState;
  /** True on the tick a swing commits: the edge the machine's trigger wants. */
  readonly started: boolean;
  /** True on the tick the blow lands, and on no other. */
  readonly hit: boolean;
}

/** Milliseconds as whole ticks, never fewer than one. Matches `seconds()` server-side. */
function ticksOf(ms: number, tickMs: number): number {
  if (!(tickMs > 0)) return 1;
  return Math.max(1, Math.round(ms / tickMs));
}

/** Which phase a swing is in, `ticks` ticks after it committed. */
export function phaseAt(ticks: number, tuning: AttackTuning, tickMs: number): AttackPhase {
  const windup = ticksOf(tuning.windupMs, tickMs);
  const active = windup + ticksOf(tuning.activeMs, tickMs);
  const recovery = active + ticksOf(tuning.recoveryMs, tickMs);
  const cooldown = ticksOf(tuning.cooldownMs, tickMs);
  if (ticks < windup) return 'windup';
  if (ticks < active) return 'active';
  if (ticks < recovery) return 'recovery';
  // The cooldown runs from the swing's start, so a wind-up longer than it means
  // there is no cooldown left to serve by the time the recovery ends.
  if (ticks < cooldown) return 'cooldown';
  return 'ready';
}

/**
 * One tick.
 *
 * `swing` is an edge the caller has already consumed -- a key press or a button
 * -- and is ignored unless the body is free. Refusing rather than queueing is
 * deliberate: a queued swing fires later at a moment nobody asked for, which in
 * a tuning tool means the number you just dragged is not the number you are
 * watching.
 */
export function stepAttack(
  state: AttackState,
  tuning: AttackTuning,
  swing: boolean,
  tickMs: number,
): AttackStep {
  if (state.phase === 'ready') {
    if (!swing) return { state, started: false, hit: false };
    // Ticks start at zero and the hit lands on the tick that *reaches* the
    // wind-up's length, so a one-tick wind-up hits on the very next tick rather
    // than on the frame it committed.
    return { state: { phase: 'windup', ticks: 0 }, started: true, hit: false };
  }

  const ticks = state.ticks + 1;
  const windup = ticksOf(tuning.windupMs, tickMs);
  const phase = phaseAt(ticks, tuning, tickMs);
  const next: AttackState = phase === 'ready' ? ATTACK_READY : { phase, ticks };
  return { state: next, started: false, hit: ticks === windup };
}

/**
 * The action timing a swing runs at, as the format's own type.
 *
 * Built here rather than read from the unitdef so the panel's sliders are what
 * the machine sees. The document's own timing is what ships; this is the tool
 * asking "what if it were this instead", which is the entire point of a sandbox.
 */
export function attackTiming(tuning: AttackTuning, clipRef: string): ActionTiming {
  return {
    actionId: 'basic.attack',
    windupMs: tuning.windupMs,
    activeMs: tuning.activeMs,
    recoveryMs: tuning.recoveryMs,
    clipRef,
    eventMap: { windup: 'swing.start', active: 'swing.impact' },
  };
}

/**
 * How fast the clip plays to cover the tuned action exactly.
 *
 * `timeScaleFor` and nothing else, so the sandbox cannot drift from what the
 * validator and the Studio timing panel compute from the same numbers.
 */
export function attackRate(tuning: AttackTuning, clipDurationMs: number): number {
  return timeScaleFor(attackTiming(tuning, ''), clipDurationMs);
}

/**
 * How far a struck dummy is leaning, `ticks` after it was hit.
 *
 * A damped oscillation rather than a linear return, because the question the
 * dummy answers is "did the blow land *now*" and a spike that decays is the only
 * shape that reads as an impact at a glance. Radians, positive meaning away from
 * the blow.
 *
 * Pure, and a function of a tick count rather than of elapsed time -- so the
 * flinch is the same shape at any frame rate, and a screenshot of tick 7 is the
 * same picture on every machine.
 */
export function dummyLean(ticks: number, amplitude = 0.5): number {
  if (ticks < 0) return 0;
  // ~0.6s to settle at 60Hz, with a first swing back at about a third of that.
  const decay = Math.exp(-ticks / 12);
  return amplitude * decay * Math.cos(ticks / 3.2);
}
