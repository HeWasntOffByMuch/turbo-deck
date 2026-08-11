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
export function orbitStep(held: ReadonlySet<string>, dt: number): number {
  const left = held.has(ORBIT_LEFT_KEY);
  const right = held.has(ORBIT_RIGHT_KEY);
  if (left === right) return 0;
  // A tab restored after a minute away arrives with an enormous frame; without
  // the clamp the view would spin through several turns in one step.
  const step = Math.min(Math.max(dt, 0), 0.1) * ORBIT_DEG_PER_SECOND;
  return right ? step : -step;
}
