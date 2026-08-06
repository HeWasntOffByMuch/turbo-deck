/**
 * How far through a cast is, for the bar over the caster's head (spec 063).
 *
 * The bar is the whole readable surface of spec 062's design: a wind-up long
 * enough to be read and short enough to matter, that the caster can still back
 * out of. If it is wrong, the game is unreadable in exactly the place it is
 * supposed to be legible.
 *
 * It has to be worked out rather than read off the wire, because `CastState`
 * carries the tick a cast *releases* and the tick it *ends*, not how long it has
 * been running. The three phases fill differently:
 *
 *  - **turning** -- committed and paid for, but the body is still coming round
 *    to face the aim (spec 065), so the wind-up clock has not started. Shown
 *    empty: the commitment is real, the swing has not begun.
 *  - **wind-up** -- from committing to the release. This is the phase that
 *    matters; a cancel here refunds everything.
 *  - **channel** -- from the release to the end, running while it pulses.
 *
 * There is no fourth: a cast ends when it releases (spec 068), so the bar is
 * gone by the time the blow has landed.
 *
 * Pure: a few numbers in, a number out, tested headlessly.
 */

import { CastPhaseValue } from '../../../server/net/protocol.js';
import type { AbilityDefinition } from '../../../server/data/abilities.js';

export interface CastLike {
  readonly abilityId: string;
  readonly phase: number;
  readonly releaseTick: number;
  readonly endTick: number;
}

export interface CastBar {
  /** 0..1, how full to draw the bar. */
  readonly progress: number;
  /** True while the caster can still withdraw -- the bar that means something. */
  readonly cancellable: boolean;
  readonly phase: number;
  /** True while the body is only turning; the wind-up has not started. */
  readonly turning: boolean;
}

function clamp01(value: number): number {
  return value <= 0 ? 0 : value >= 1 ? 1 : value;
}

/**
 * `tick` may be fractional: the renderer paints between sim ticks, and passing
 * the interpolated tick is what stops the bar advancing in 20Hz steps while the
 * body under it moves smoothly.
 */
export function castBar(cast: CastLike, tick: number, ability: AbilityDefinition | null): CastBar {
  const phase = cast.phase;

  // Turning. `releaseTick` is provisional here and the server will re-stamp it
  // at alignment, so there is nothing honest to fill a bar with -- drawing
  // against it would run the bar up and then reset it when the real wind-up
  // starts. Empty, and cancellable, which is exactly the state it describes.
  if (phase === CastPhaseValue.Turning) {
    return { progress: 0, cancellable: true, phase, turning: true };
  }

  if (phase === CastPhaseValue.Windup) {
    // The wind-up's length is the ability's, and its start is the release minus
    // that -- the server never sends a start tick, and deriving it here is
    // exact as long as both sides read the same table, which they do.
    const windup = Math.max(1, ability?.windupTicks ?? 1);
    return { progress: clamp01(1 - (cast.releaseTick - tick) / windup), cancellable: true, phase, turning: false };
  }

  // Channel: from the release to the end, running while it pulses.
  const span = Math.max(1, cast.endTick - cast.releaseTick);
  return { progress: clamp01((tick - cast.releaseTick) / span), cancellable: true, phase, turning: false };
}
