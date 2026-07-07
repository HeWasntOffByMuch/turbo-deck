/**
 * Pure animation math for the Balatro-style card hand (spec 013).
 *
 * No Pixi/DOM here on purpose: these curves are unit-tested, while the stateful
 * Pixi drawing in `hand.ts` that consumes them stays untested, matching the
 * existing render convention (see `sprites.ts` vs the untested `scene.ts`).
 *
 * All transforms are expressed relative to a card's *resting* slot pose, so the
 * caller composes them by adding offsets / multiplying scale onto that pose.
 */

export interface CardTransform {
  /** px, relative to the resting slot position. */
  readonly offsetX: number;
  /** px, negative = up. */
  readonly offsetY: number;
  /** radians. */
  readonly rotation: number;
  /** 1 = resting size. */
  readonly scale: number;
  /** 0..1. */
  readonly alpha: number;
}

export const REST_TRANSFORM: CardTransform = {
  offsetX: 0,
  offsetY: 0,
  rotation: 0,
  scale: 1,
  alpha: 1,
};

/** Peak vertical travel of the idle bob, in px. */
export const IDLE_BOB_PX = 4;
/** Peak tilt of the idle wobble, in radians (~2.9°). */
export const IDLE_TILT_RAD = 0.05;

const clamp01 = (t: number): number => Math.min(1, Math.max(0, t));

/** Standard ease-out-back: settles past 1 then eases back — a springy overshoot. */
export function easeOutBack(t: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  const x = t - 1;
  return 1 + c3 * x * x * x + c1 * x * x;
}

/** Accelerating cubic: slow start, fast finish. */
export function easeInCubic(t: number): number {
  return t * t * t;
}

/** Decelerating cubic: fast start, gentle finish. */
export function easeOutCubic(t: number): number {
  const x = 1 - t;
  return 1 - x * x * x;
}

/**
 * Gentle idle "breathing": each card bobs and tilts on a sine, phase-offset by
 * slot so the hand doesn't move in lockstep. Bounded by IDLE_BOB_PX / tilt.
 */
export function idleTransform(slotIndex: number, timeMs: number): CardTransform {
  const t = timeMs / 1000;
  const phase = slotIndex * 1.7;
  return {
    offsetX: 0,
    offsetY: Math.sin(t * 1.8 + phase) * IDLE_BOB_PX,
    rotation: Math.sin(t * 1.2 + phase * 0.6) * IDLE_TILT_RAD,
    scale: 1,
    alpha: 1,
  };
}

/**
 * A spent card being played: it lifts up, spins a little, enlarges and fades
 * out — the Balatro "score" pop. `progress` runs 0..1 over the animation.
 */
export function playTransform(progress: number): CardTransform {
  const t = clamp01(progress);
  const lift = easeOutCubic(t); // snaps upward immediately, then eases
  // Stay opaque through the first ~45% so the lift/spin is clearly seen, then fade.
  const FADE_START = 0.45;
  const alpha = t < FADE_START ? 1 : Math.max(0, 1 - (t - FADE_START) / (1 - FADE_START));
  return {
    offsetX: 0,
    offsetY: -130 * lift,
    rotation: t * 0.6,
    scale: 1 + 0.4 * t,
    alpha,
  };
}

/**
 * A drawn replacement dealing into a freshly emptied slot: it rises from below
 * with an ease-out-back overshoot and fades in, settling exactly at rest.
 */
export function dealTransform(progress: number): CardTransform {
  const t = clamp01(progress);
  const settle = easeOutBack(t);
  return {
    offsetX: 0,
    offsetY: 46 * (1 - settle),
    rotation: (1 - t) * -0.12,
    scale: 0.86 + 0.14 * Math.min(1, t * 1.4),
    alpha: Math.min(1, t * 2),
  };
}
