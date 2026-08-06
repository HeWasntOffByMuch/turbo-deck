/**
 * What the spawner overlay says (spec 076). Pure: no three.js, no DOM.
 *
 * The overlay exists to answer two questions at a glance -- what stands here,
 * and how long until it does again -- so this turns the wire's `SpawnerStatus`
 * into the one line that answers both. Every judgement about wording, rounding
 * and ordering lives here, where a test can reach it; `hud.ts` only positions
 * the string it is handed.
 */

import type { SpawnerStatus } from '../../../server/net/messages.js';
import { SpawnerStateValue } from '../../../server/net/protocol.js';

export interface SpawnerLabel {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly text: string;
  /** True while it is counting down, so the overlay can dim what is not there. */
  readonly waiting: boolean;
}

/**
 * One line per spawner, in the order the server sent them.
 *
 * Seconds are rounded *up*, and to one decimal: "0.0s" next to an empty patch
 * of ground for a whole tenth of a second reads as a bug, and a countdown that
 * reaches zero before the thing arrives is the one number the overlay must not
 * show. A timer of exactly zero is a spawner waiting on something else -- the
 * population cap -- and says so rather than counting.
 */
export function spawnerLabels(
  spawners: readonly SpawnerStatus[],
  tickRate: number,
): readonly SpawnerLabel[] {
  const rate = tickRate > 0 ? tickRate : 1;
  return spawners.map((spawner) => {
    const waiting = spawner.state !== SpawnerStateValue.Occupied;
    const seconds = Math.ceil((spawner.ticks / rate) * 10) / 10;
    return {
      id: spawner.id,
      x: spawner.x,
      y: spawner.y,
      waiting,
      text: !waiting
        ? spawner.monsterId
        : spawner.ticks <= 0
          ? `${spawner.monsterId} · due`
          : `${spawner.monsterId} · ${seconds.toFixed(1)}s`,
    };
  });
}
