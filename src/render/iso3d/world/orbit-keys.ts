/**
 * Turning the camera with the keyboard (spec 129).
 *
 * A fixed isometric camera and 60-to-200 units of rock is a combination that
 * hides a unit behind a wall, and the answer this replaces spent four rounds
 * carving a hole in the world and getting it subtly wrong each time. Letting the
 * player turn the camera solves it outright: nothing is dressed, nothing is
 * removed, and the one case a cutaway cannot get right -- "I want to see what is
 * behind that" -- is answered by the player rather than guessed at.
 *
 * Pure: a set of held key codes and a frame's duration in, degrees out. No DOM,
 * no clock of its own, so it is tested in Node.
 */

/** Anticlockwise and clockwise. Rebindable later; hard-coded is enough for now. */
export const ORBIT_LEFT_KEY = 'BracketLeft';
export const ORBIT_RIGHT_KEY = 'BracketRight';

/**
 * How fast the view swings while a key is held.
 *
 * Four seconds for a full turn. Fast enough to get behind a formation without
 * waiting, slow enough that a tap is a nudge rather than a jump -- which is the
 * whole of "smooth" here: the rotation is continuous in time, so holding a key
 * *is* the easing and there is no separate animation to fight with the input.
 */
export const ORBIT_DEG_PER_SECOND = 90;

/**
 * Degrees to turn this frame. Positive is clockwise.
 *
 * Both keys held cancel rather than fighting: a player who has rolled a finger
 * across both wants the view to stop, not to pick whichever was pressed last.
 */
/**
 * How far a two-finger swipe turns the view, degrees per canvas pixel (spec 139).
 *
 * Per pixel rather than per second, because a drag is direct manipulation and
 * its rate is the finger. A little over a half turn across an 844px landscape
 * frame -- the same order as the keyboard's four-second sweep, so getting behind
 * a formation is one gesture, and a flick does not spin the world.
 */
export const ORBIT_DEG_PER_PX = 0.25;

/**
 * Degrees to turn for a swipe of `dragXPx`. Positive is clockwise, as above.
 *
 * The world follows the fingers: swiping right turns the camera anticlockwise,
 * so the ground under the hand travels with it rather than against it.
 * A non-finite drag turns nothing, the same contract `zoomSpan` has -- a swipe
 * arrives as a difference between two measurements and a lost pointer can make
 * one of them a NaN.
 */
export function orbitDrag(dragXPx: number): number {
  // Zero is checked as well as finiteness so that a still hand turns by `0`
  // rather than by `-0`. Nothing downstream can tell them apart -- `-0 === 0` --
  // but a negated product hands back a signed zero for half its inputs, and a
  // "turned nothing" that has a direction in it is a thing to explain later.
  if (!Number.isFinite(dragXPx) || dragXPx === 0) return 0;
  return -dragXPx * ORBIT_DEG_PER_PX;
}

export function orbitStep(held: ReadonlySet<string>, dt: number): number {
  const left = held.has(ORBIT_LEFT_KEY);
  const right = held.has(ORBIT_RIGHT_KEY);
  if (left === right) return 0;
  // A tab restored after a minute away arrives with an enormous frame; without
  // the clamp the view would spin through several turns in one step.
  const step = Math.min(Math.max(dt, 0), 0.1) * ORBIT_DEG_PER_SECOND;
  return right ? step : -step;
}
