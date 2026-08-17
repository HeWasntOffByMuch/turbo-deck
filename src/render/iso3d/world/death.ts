/**
 * Whether to say you are dead (spec 163).
 *
 * One line of arithmetic and a module of its own, because the three ways to draw
 * nothing look nothing alike and each of them used to be a screen somebody could
 * get stuck on: a living body, a client that has not been told which body is its
 * own yet, and a body that is not in the replicated set at all -- which is what a
 * player standing outside their own interest radius during a reconnect looks
 * like for a frame or two.
 *
 * The death state is *not* a new field on the wire. The local body's health has
 * been replicated since spec 057; what spec 163 added was the way back up
 * (`ClientMessageType.Respawn`), not a way to find out.
 */

import type { ClientView } from '../../../server/client/game-client.js';

/**
 * What the overlay says.
 *
 * Capitals because the pixel font is capitals, and short because it is drawn at
 * eight times scale across the middle of the frame -- the words have to fit a
 * phone held sideways as well as a monitor.
 */
export const DEATH_TEXT = 'YOU ARE DEAD';

export interface DeathOverlay {
  readonly text: string;
}

/**
 * The overlay to draw, or null.
 *
 * Null rather than `{ dead: false }`: there is one thing a caller does with this
 * and it is decide whether the overlay is on screen, so a shape that can be
 * *present and false* is a shape with an extra way to be wrong.
 *
 * A body at zero health is dead, and that is the whole test. Not `activity`,
 * which is also `Dead` and would be a second opinion -- the server sets both
 * from the same blow, and a client that read the one the wire quantizes hardest
 * would be the one to disagree first.
 */
export function deathOverlay(view: ClientView): DeathOverlay | null {
  if (view.selfEntityId < 0) return null;
  const self = view.entities.find((entity) => entity.id === view.selfEntityId);
  if (!self) return null;
  return self.health <= 0 ? { text: DEATH_TEXT } : null;
}
