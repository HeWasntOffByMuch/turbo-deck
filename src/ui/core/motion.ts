/**
 * Motion, as arithmetic over the time it is handed (spec 133).
 *
 * Not a scheduler, not an animator, not a list of running things. A widget holds
 * a {@link Tween} and asks it what its value is *while painting*, exactly as
 * `TextField` already asks whether the caret is visible at `now`. There is
 * nothing here to start, nothing to stop, and nothing that ticks.
 *
 * That shape is chosen to keep the rule the whole framework rests on:
 * `UiRoot.update(nowMs)` takes the time, so a script of `[time, event]` pairs
 * replays to the same pixels every run. An animation cannot be the one exception
 * to that -- an animator with its own clock would make every golden image a
 * question about when the test ran.
 *
 * Two rules the callers keep, which this file can only make easy:
 *
 * **Animation is paint-time, never layout-time.** A tween that changed a
 * measured size would relayout every frame, which is exactly the cost the dirty
 * flags exist to avoid. What moves here is where a thing is *drawn*.
 *
 * **`reduced` is not a faster animation.** It is no animation: the value is the
 * destination from the first frame. A player who asked their system for less
 * motion asked for a reason, and easing the request is refusing it politely.
 *
 * Pure. No clock, no state, no DOM.
 */

/**
 * The three curves this interface has, plus the one that is an absence.
 *
 * Three named easings in code rather than curves as theme data: a theme that can
 * describe an arbitrary cubic is a feature nobody has asked for, and every extra
 * curve is another thing a screen can be inconsistent about.
 */
export type Easing = 'linear' | 'outQuad' | 'outBack' | 'step';

export const EASINGS: readonly Easing[] = ['linear', 'outQuad', 'outBack', 'step'];

/**
 * How far past the overshoot `outBack` goes, as a fraction.
 *
 * Small. This is a pixel-art interface and an overshoot is rounded to whole
 * pixels by whoever draws it, so a large one is not "bouncier", it is one frame
 * in the wrong place.
 */
const BACK = 1.15;

/**
 * The eased fraction, given a raw one.
 *
 * Clamped at both ends, so a caller that hands in an out-of-range `t` gets the
 * nearest endpoint rather than an extrapolation. `outBack` is the one curve that
 * leaves 0..1 in the middle, and deliberately: the overshoot is the effect.
 */
export function ease(kind: Easing, t: number): number {
  const clamped = Number.isFinite(t) ? Math.max(0, Math.min(1, t)) : 1;
  switch (kind) {
    case 'linear':
      return clamped;
    case 'outQuad':
      return 1 - (1 - clamped) * (1 - clamped);
    case 'outBack': {
      const inverse = clamped - 1;
      return 1 + (BACK + 1) * inverse * inverse * inverse + BACK * inverse * inverse;
    }
    case 'step':
      // Not "instant at the end" -- instant at the *start*. A step function that
      // waited out the duration would be a reduce-motion setting that still made
      // you wait, which is the half of the request people forget.
      return 1;
  }
}

export interface Tween {
  readonly from: number;
  readonly to: number;
  /** The `nowMs` the tween was created at. */
  readonly startMs: number;
  readonly durationMs: number;
  readonly easing: Easing;
}

/** A tween that is already over. What a widget holds before anything happens. */
export function settled(value: number): Tween {
  return { from: value, to: value, startMs: 0, durationMs: 0, easing: 'step' };
}

export function tweenTo(current: Tween, to: number, nowMs: number, durationMs: number, easing: Easing): Tween {
  // From wherever it *is*, not from where the last tween was aiming. A meter
  // interrupted halfway would otherwise jump back to the old start before
  // setting off again, which reads as a flicker rather than as a correction.
  return { from: valueAt(current, nowMs), to, startMs: nowMs, durationMs, easing };
}

/**
 * The value at `nowMs`.
 *
 * A zero -- or negative, or non-finite -- duration is `to`, rather than a
 * division that produces one. A time before the start is `from`, because a
 * caller replaying a script backwards should see the frame it asked for and not
 * an extrapolation.
 */
export function valueAt(tween: Tween, nowMs: number): number {
  if (!(tween.durationMs > 0)) return tween.to;
  const elapsed = nowMs - tween.startMs;
  if (elapsed <= 0) return tween.from;
  if (elapsed >= tween.durationMs) return tween.to;
  return tween.from + (tween.to - tween.from) * ease(tween.easing, elapsed / tween.durationMs);
}

export function isDone(tween: Tween, nowMs: number): boolean {
  return !(tween.durationMs > 0) || nowMs - tween.startMs >= tween.durationMs;
}

/**
 * The value at `nowMs`, honouring a motion preference.
 *
 * The one function widgets actually call. Keeping the check here rather than at
 * each call site is what makes "reduce-motion is respected" a property of this
 * module rather than a thing seven widgets each have to remember -- and it is
 * why the test for it is a property over the whole easing table rather than
 * seven assertions that would each pass while an eighth widget was added.
 */
export function animate(tween: Tween, nowMs: number, motion: MotionPreference): number {
  return motion.reduced ? tween.to : valueAt(tween, nowMs);
}

/**
 * Whether the player has asked for less motion.
 *
 * An input to a frame, handed in beside `now` rather than sensed, for the same
 * reason `now` is: nothing under `src/ui/` may touch the platform, and a
 * preference read inside a widget is a preference no test can set.
 *
 * It says nothing about sound. Motion and sound are different requests and a
 * player who made one has not made the other.
 */
export interface MotionPreference {
  readonly reduced: boolean;
}

export const FULL_MOTION: MotionPreference = { reduced: false };
export const REDUCED_MOTION: MotionPreference = { reduced: true };

/**
 * How long the three animated things take, and how they move.
 *
 * Here rather than in `theme.json` because these are *timings*, and the theme is
 * a description of how things look. A theme that could retime the interface
 * would be a theme that could make it feel broken.
 */
export const MOTION = {
  /** A window settling into place: up a few pixels, and quick. */
  window: { durationMs: 120, easing: 'outQuad' as Easing, riseUiPx: 6 },
  /** A modal, from further and faster -- it has to arrive, not drift in. */
  modal: { durationMs: 90, easing: 'outBack' as Easing, riseUiPx: 10 },
  /** A meter chasing its value, so a hit reads as a hit and not a new number. */
  meter: { durationMs: 180, easing: 'outQuad' as Easing },
} as const;
