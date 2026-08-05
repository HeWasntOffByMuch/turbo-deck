/**
 * Keys and a cursor, turned into the intent the server is sent (spec 063).
 *
 * The one place the renderer touches input semantics, and deliberately a pure
 * function of what is held and where the mouse is: it decides *what was asked
 * for*, never what happens as a result. The server decides that, and the whole
 * reason this is a separate module from the view is so the question "does W+D
 * walk the diagonal at walking speed" is answerable in Node.
 */

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface MoveIntent {
  /** A unit vector, or (0,0) when nothing is held. */
  readonly moveX: number;
  readonly moveY: number;
  /** Radians, toward the cursor. */
  readonly facing: number;
}

/**
 * Which key codes drive which way, in the sim's axes: +y is "down the screen"
 * (south), matching the terrain module's `z`.
 */
export const MOVE_KEYS: Readonly<Record<string, readonly [number, number]>> = {
  KeyW: [0, -1],
  ArrowUp: [0, -1],
  KeyS: [0, 1],
  ArrowDown: [0, 1],
  KeyA: [-1, 0],
  ArrowLeft: [-1, 0],
  KeyD: [1, 0],
  ArrowRight: [1, 0],
};

/**
 * The intent for one tick.
 *
 * The direction is normalised here even though the server also clamps it. That
 * is not redundancy for its own sake: the client's *prediction* uses this same
 * vector, so an unnormalised diagonal would have the client predicting a faster
 * walk than the server grants and being corrected the whole way across the map.
 * Both sides normalising is what makes the diagonal silent.
 */
export function moveIntent(held: ReadonlySet<string>, self: Point, aim: Point): MoveIntent {
  let moveX = 0;
  let moveY = 0;
  for (const code of held) {
    const axis = MOVE_KEYS[code];
    if (!axis) continue;
    moveX += axis[0];
    moveY += axis[1];
  }

  const length = Math.hypot(moveX, moveY);
  if (length > 1e-6) {
    moveX /= length;
    moveY /= length;
  } else {
    moveX = 0;
    moveY = 0;
  }

  const dx = aim.x - self.x;
  const dy = aim.y - self.y;
  // A cursor exactly on the body has no direction in it; keeping the old facing
  // is the caller's job, and 0 here would snap the figure east for one frame.
  const facing = Math.hypot(dx, dy) < 1e-6 ? 0 : Math.atan2(dy, dx);

  return { moveX, moveY, facing };
}
