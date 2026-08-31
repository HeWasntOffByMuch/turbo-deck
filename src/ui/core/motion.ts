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
 * The value at `nowMs` for something that **drifts** rather than arrives.
 *
 * {@link animate} snaps to `to` under reduce-motion, and that is right for every
 * caller it has: a window, a modal and a meter are all *arriving* somewhere, so
 * the end of the tween is the resting state and jumping to it is the same
 * picture without the travel.
 *
 * A float has no resting state. The end of its journey is where it disappears,
 * so snapping puts it at the far end of a trip it never took -- as far from the
 * thing it is about as the animation ever gets, and static there for its whole
 * life. That is not "the same picture without the travel"; it is a different and
 * worse picture. Spec 253's refund mark shipped that way and was reported twice:
 * the label sat high above the slot and never moved, and *raising* the travel
 * moved it further away, because `to` is the one number a reduced client draws.
 *
 * So a drift holds its **start**. Motion reduced means the label stays where it
 * appears -- clear of the slot, beside what it is about -- and simply does not
 * travel, which is what was actually asked for.
 */
export function drift(tween: Tween, nowMs: number, motion: MotionPreference): number {
  return motion.reduced ? tween.from : valueAt(tween, nowMs);
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
  /**
   * A number leaving a slot: up and away, decelerating (spec 253).
   *
   * **A notice, not a response**, which is the one entry here that is: the three
   * above are the interface answering something the player did, and the rule
   * they are held to is that an answer past a quarter of a second reads as a
   * wait. Nothing is waiting on this one. It is a number floating off a thing to
   * be read, so what bounds it is the opposite -- long enough to be noticed by
   * somebody who is looking at the world rather than at the bar.
   *
   * 800ms is **the damage number's own life** (`world/damage-popup.ts`'s
   * `NUMBER_LIFE`, 48 ticks) rather than a number chosen here, because it is the
   * same kind of thing one layer over: a quantity that floats off what it
   * happened to and fades out of the frame. A test asserts the two agree, so
   * retuning one moves the other or fails.
   *
   * **Linear, and that is the whole difference between rising and appearing.**
   * The three above ease out because each is *arriving* somewhere -- a window
   * settling, a meter reaching its value -- and a decelerating float reads as
   * having arrived and then creeping. `world/damage-popup.ts` rises its numbers
   * at a constant rate for exactly this reason (`spent * popup.rise`, `spent`
   * linear in age), and this is the same object one layer over.
   *
   * **`riseUiPx` is a floor and it is derived, not chosen.** The travel used to
   * be one slot side, which is right in spirit -- a label off a square whose
   * size is set by how big a finger is -- and wrong in fact: the bar converts
   * `ACTION_SLOT_CSS` through the interface scale, so a shipped slot is 20 to 23
   * *UI* pixels rather than the 46 an unscaled gallery draws. Twenty pixels over
   * 800ms is a quarter of a pixel a frame at 60fps, and sub-pixel-per-frame
   * motion does not read as motion at all -- it reads as a label that appeared
   * somewhere and sat there, which is exactly how this was reported. The floor
   * is therefore *one whole pixel per frame for the whole life*:
   * `durationMs / 1000 * 60`. A bigger slot still gets a bigger rise.
   */
  refund: {
    durationMs: 800,
    easing: 'linear' as Easing,
    riseFraction: 1,
    riseUiPx: Math.round((800 / 1000) * 60),
  },
} as const;

/**
 * The entries of {@link MOTION} that are the interface *answering* something.
 *
 * Named so the rule they are held to -- an answer past a quarter of a second
 * reads as a wait rather than as a response -- can be asserted over exactly
 * them, and so a timing added later has to be classified rather than quietly
 * escaping the check. `motion.test.ts` asserts this list plus the notices covers
 * `MOTION` exactly.
 */
export const RESPONSE_TIMINGS = ['window', 'modal', 'meter'] as const;

/**
 * ...and the ones that are a *notice*: something to be read, that nothing waits
 * on. Bounded from the other side -- long enough to be seen.
 */
export const NOTICE_TIMINGS = ['refund'] as const;
