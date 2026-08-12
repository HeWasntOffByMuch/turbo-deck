/**
 * Giving the drawn turn a beginning and an end (spec 142).
 *
 * `turnToward` is a step function on angular velocity: a body is turning at
 * nothing, then at its full rate for every tick of the turn, then at nothing
 * again. Spec 139 gated the *peak* of the resulting sweep and left this alone --
 * at any rate at all, an extremity 28 units out goes from rest to 264 units per
 * second inside one tick, and that discontinuity is what reads as a whip-crack.
 *
 * This is the follower that eases it, and it is **presentation, not state** --
 * the same standing `interpolate.ts` has. The sim's turn rule is untouched and
 * still the only one: `scene.ts` hands this the heading the server (or the
 * client's own prediction of it) says a body has, and takes back the heading to
 * actually yaw the group by. Nothing reads the output but a transform, which is
 * what keeps the "no `if` in src/render/ changes a game outcome" line intact
 * while the body on screen is, briefly, not pointing where the server says.
 *
 * The profile is trapezoidal with a braking curve: accelerate toward the target,
 * but never faster than you could still stop *on* it, which is what makes the
 * ease-out automatic and the landing exact rather than asymptotic.
 *
 * The one thing worth understanding is that **the acceleration is not a tuning
 * constant**. It is fixed by how far the drawn heading may trail the
 * authoritative one, and the sim already answered that: `COMMIT_ALIGN_TICKS` is
 * where `abilities.ts` says three ticks of a body's own turn still counts as
 * already facing its mark. Bound the visual lag by the sim's own tolerance and
 * the acceleration follows from it -- see {@link turnAcceleration}.
 *
 * Pure: no three.js, no DOM, time is an argument. Tested headlessly.
 */

import { COMMIT_ALIGN_TICKS } from '../../server/sim/abilities.js';

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;

/**
 * The longest step the follower will integrate in one go, in seconds.
 *
 * A frame that took longer than this really happened -- a tab coming back, a
 * shader compiling -- but integrating all of it in one go means one step of a
 * profile whose whole ramp is 100ms, which is a corner worth not having. The
 * following frames catch the rest up, which is what the ease is for.
 *
 * This is not what protects against a background tab; {@link JUMP_TICKS} is. A
 * tab that was away for two seconds comes back to a body genuinely facing
 * somewhere else, and that is a jump, not a long frame.
 */
export const MAX_STEP_SECONDS = 1 / 30;

/**
 * How many ticks' worth of turn the *target* has to move in one step before it
 * stops being a turn at all.
 *
 * A jump has to be told from a fast turn, and the only honest signal is how far
 * the authoritative heading itself moved -- not how far behind the drawn one is.
 * The first cut used the error, and the test caught what is wrong with it: the
 * cap is an estimate (a monster's table rate can be raised by a modifier, and a
 * remote player's rate is not replicated at all), so a body turning faster than
 * we believe possible builds an error no *believed* turn could produce, and snaps
 * in the middle of an ordinary turn every single time it makes one. The target's
 * own motion stays proportional to the real rate however wrong the estimate is.
 *
 * Four, because the estimate can be wrong by a factor of two in either direction
 * and still not be mistaken for a teleport -- and because a "jump" smaller than
 * this is one the ease can absorb in its normal 100ms anyway, so being slow to
 * call one costs nothing.
 *
 * Denominated in *ticks* rather than in frames: the authoritative heading moves
 * once per sim tick, so at 240fps two frames in three see it hold still and the
 * third sees a whole tick's turn. A frame-denominated threshold would call that
 * third frame a teleport and snap away the ease on exactly the machines that can
 * afford it.
 */
export const JUMP_TICKS = 4;

export interface TurnLimits {
  /** The body's own turn rate, degrees per second. Zero means it cannot turn. */
  readonly degreesPerSecond: number;
  /** The sim's tick rate, which is what the lag bound is denominated in. */
  readonly tickRate: number;
}

/** The signed turn from `from` to `to`, in (-PI, PI]. */
export function shortestTurn(from: number, to: number): number {
  let delta = (to - from) % TAU;
  if (delta > Math.PI) delta -= TAU;
  if (delta <= -Math.PI) delta += TAU;
  return delta;
}

/**
 * How far the drawn heading may trail the authoritative one, in radians.
 *
 * Three ticks of the body's own turn -- `commitAlignEps` in the sim, arrived at
 * from the other direction. The sim uses it to decide a body is close enough to
 * facing its mark to swing; using the same number here means the ease can never
 * draw a body the server would call aligned as one a player would call turned
 * away, which is the whole reason the bound is that and not a rounder number.
 */
export function lagBound(limits: TurnLimits): number {
  const rate = Math.max(0, limits.degreesPerSecond) * DEG;
  const tickRate = Math.max(1, limits.tickRate);
  return (rate * COMMIT_ALIGN_TICKS) / tickRate;
}

/**
 * The acceleration that bound implies, radians per second squared.
 *
 * A follower running at `R` needs `R^2 / 2a` of runway to stop, so holding the
 * lag to `L` means `a = R^2 / 2L`. Substituting `L` cancels one factor of the
 * rate: `a = R * tickRate / (2 * COMMIT_ALIGN_TICKS)`, ten times the rate at
 * 60Hz. Which is why the ramp -- `R / a` -- is `2 * COMMIT_ALIGN_TICKS /
 * tickRate`, 100ms, for every body in the game regardless of how fast it turns.
 * A slow body just covers less ground getting up to speed.
 */
export function turnAcceleration(limits: TurnLimits): number {
  const rate = Math.max(0, limits.degreesPerSecond) * DEG;
  const tickRate = Math.max(1, limits.tickRate);
  return (rate * tickRate) / (2 * COMMIT_ALIGN_TICKS);
}

/** Everything one body's ease carries between steps. */
export interface TurnState {
  /** The heading last drawn, radians. */
  readonly facing: number;
  /** Angular velocity carried forward, radians per second, signed. */
  readonly rate: number;
  /** The authoritative heading the last step was aiming at. */
  readonly target: number;
}

export interface EasedTurn extends TurnState {
  /** True when this step took the whole error at once. */
  readonly snapped: boolean;
}

/** A body drawn for the first time: at its own heading, at rest. */
export function restingAt(target: number): TurnState {
  const facing = Number.isFinite(target) ? target : 0;
  return { facing, rate: 0, target: facing };
}

/**
 * One step of the follower.
 *
 * `state` is what the last step returned; `target` is what the sim says now.
 * Non-finite inputs answer with a heading rather than propagating: a `NaN` here
 * is a body whose transform leaves the world entirely.
 */
export function easeTurn(
  state: TurnState,
  target: number,
  limits: TurnLimits,
  dt: number,
): EasedTurn {
  if (!Number.isFinite(target)) return { ...state, snapped: false };
  if (!Number.isFinite(state.facing) || !Number.isFinite(state.rate)) {
    return { ...restingAt(target), snapped: true };
  }

  const cap = Math.max(0, limits.degreesPerSecond) * DEG;
  const accel = turnAcceleration(limits);

  // A body that cannot turn is not a body that turns slowly. Whatever moved its
  // heading was not a turn, so there is nothing to ease.
  if (cap <= 0 || accel <= 0) return { ...restingAt(target), snapped: true };

  const step = Number.isFinite(dt) ? Math.min(Math.max(0, dt), MAX_STEP_SECONDS) : 0;

  // Did the authoritative heading *move* further than turning could take it?
  // Measured over a tick or the frame, whichever is longer, so the answer does
  // not change with the frame rate.
  const advanced = Math.max(Number.isFinite(dt) ? Math.max(0, dt) : 0, 1 / Math.max(1, limits.tickRate));
  const jumped = Math.abs(shortestTurn(state.target, target)) > JUMP_TICKS * cap * advanced;
  if (jumped) return { ...restingAt(target), snapped: true };

  if (step <= 0) return { ...state, target, snapped: false };

  const error = shortestTurn(state.facing, target);

  // The fastest we may be going and still stop on the target rather than past
  // it. This is the whole ease-out: no phase, no timer, no easing curve to pick
  // -- just refusing to carry more speed than the remaining angle can absorb.
  const braking = Math.sqrt(2 * accel * Math.abs(error));
  const wanted = Math.sign(error) * Math.min(cap, braking);

  let rate = state.rate + Math.max(-accel * step, Math.min(accel * step, wanted - state.rate));
  // Clamped rather than merely bounded: with `wanted` already inside the cap,
  // this only bites when the previous step left us going faster than the cap
  // (a body whose rate fell), and it keeps the invariant true on every step.
  rate = Math.max(-cap, Math.min(cap, rate));

  const travel = rate * step;
  // Never cross the target. The braking curve makes this unreachable in the
  // steady state, but a `dt` that changes between steps can leave a fraction of
  // a step's worth of overshoot, and landing exactly is worth more than the
  // arithmetic that would prove it cannot happen.
  if (Math.abs(travel) >= Math.abs(error)) {
    return { facing: target, rate, target, snapped: false };
  }
  return { facing: state.facing + travel, rate, target, snapped: false };
}

/**
 * The per-body state, keyed by entity id.
 *
 * Shaped like `EntityMotion` next door -- `scene.ts` already owns one
 * parallel presentation-only track per body and this is a second. Bodies are
 * forgotten explicitly, on the same pass that disposes their meshes, rather than
 * on a timer.
 */
export class TurnEase {
  private readonly bodies = new Map<number, TurnState>();

  /**
   * The heading to draw for `id` this frame, given the one the sim says it has.
   *
   * A body that has never been drawn takes its target as-is: there is no
   * previous heading to ease from, and easing from zero would spin every monster
   * in the arena on the frame it spawned.
   */
  step(id: number, target: number, limits: TurnLimits, dt: number): number {
    const held = this.bodies.get(id);
    if (!held) {
      const fresh = restingAt(target);
      this.bodies.set(id, fresh);
      return fresh.facing;
    }
    const eased = easeTurn(held, target, limits, dt);
    this.bodies.set(id, { facing: eased.facing, rate: eased.rate, target: eased.target });
    return eased.facing;
  }

  /** The heading last drawn for `id`, or null if it has never been drawn. */
  facing(id: number): number | null {
    return this.bodies.get(id)?.facing ?? null;
  }

  forget(id: number): void {
    this.bodies.delete(id);
  }

  /** Drops everything not in `live`, so a departed body leaves no state behind. */
  retain(live: ReadonlySet<number>): void {
    for (const id of this.bodies.keys()) {
      if (!live.has(id)) this.bodies.delete(id);
    }
  }
}
