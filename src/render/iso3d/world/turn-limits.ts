/**
 * How fast a drawn body is allowed to be turning (spec 140).
 *
 * The ease in `turn-ease.ts` needs a rate to cap the drawn yaw at, because a
 * follower that may exceed the sim's own rate to catch up would raise the peak
 * sweep spec 139 gated -- the ease is meant to soften the onset, not to make the
 * middle of a turn worse.
 *
 * A replicated entity is a kind and a content id, so the rate comes from the same
 * tables the server derives it from -- `appearance.ts` next door already reads
 * `monsterById` for the same reason. Only the local player's stats are on the
 * wire, so this is exact for the body that matters most, a table lookup for a
 * monster, and an approximation for a remote player.
 *
 * The approximation is safe to make because of the saturation exemption in
 * `easeTurn`: an under-estimated cap costs a body some ease and some lag, never a
 * pop and never a wrong heading. That is what lets this be a small honest
 * function rather than a reimplementation of `computeEffectiveStats` against
 * equipment and skills the client was never sent.
 *
 * Pure: a table read. No three.js.
 */

import { monsterById } from '../../../server/data/monsters.js';
import { EntityKind } from '../../../server/net/protocol.js';
import { CHARACTERS } from '../../../sim/characters.js';
import type { TurnLimits } from '../turn-ease.js';

/**
 * The rate a remote player is eased at, degrees per second.
 *
 * A player's rate is a base plus a term per point of dexterity, and neither the
 * dexterity nor the derived rate is replicated for anybody but ourselves. The
 * fastest base in the table is the closest honest answer available: it is above
 * the slowest character rather than below every geared one, and being wrong in
 * either direction only moves how much ease that one body gets.
 */
export const REMOTE_PLAYER_TURN_RATE = Math.max(
  ...CHARACTERS.map((character) => character.turnRate),
);

/** What `turn-ease.ts` should cap this body at, or null if it must not be eased. */
export function turnLimitsFor(
  entity: { readonly kind: number; readonly typeId: string },
  isSelf: boolean,
  selfTurnRate: number | null,
  tickRate: number,
): TurnLimits | null {
  // An arrow's facing is its direction of travel, not a heading it turned to. It
  // has no turn rate, and easing it would draw the nose off its own path on the
  // frame it is spawned.
  if (entity.kind === EntityKind.Projectile) return null;

  if (isSelf) {
    return selfTurnRate === null
      ? null
      : { degreesPerSecond: selfTurnRate, tickRate };
  }

  if (entity.kind === EntityKind.Monster) {
    const rate = monsterById(entity.typeId)?.stats.turnRate;
    // A monster with no rate at all is a training dummy: it does not turn, so
    // whatever moved its heading was not a turn. `easeTurn` follows instantly.
    return rate === undefined ? null : { degreesPerSecond: rate, tickRate };
  }

  if (entity.kind === EntityKind.Player) {
    return { degreesPerSecond: REMOTE_PLAYER_TURN_RATE, tickRate };
  }

  // Props do not turn, and anything this file has not heard of is drawn the way
  // it always was rather than eased on a guessed rate.
  return null;
}
