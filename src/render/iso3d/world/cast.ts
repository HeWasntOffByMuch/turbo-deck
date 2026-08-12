/**
 * How far through a cast is, for the bar over the caster's head (spec 063).
 *
 * The bar is the whole readable surface of spec 062's design: a wind-up long
 * enough to be read and short enough to matter, that the caster can still back
 * out of. If it is wrong, the game is unreadable in exactly the place it is
 * supposed to be legible.
 *
 * It has to be worked out rather than read off the wire, because `CastState`
 * carries the ticks a cast *starts*, *releases* and *ends*, not how far through
 * it is. The four phases fill differently:
 *
 *  - **turning** -- committed and paid for, but the body is still coming round
 *    to face the aim (spec 065), so the wind-up clock has not started. Shown
 *    empty: the commitment is real, the swing has not begun.
 *  - **wind-up** -- from the swing starting to the attack point. This is the
 *    phase that matters; a cancel here refunds everything.
 *  - **backswing** -- from the attack point to the end (spec 144). The blow has
 *    landed, so this bar is *not* cancellable in the sense the flag means:
 *    walking out of it is free and refunds nothing, because there is nothing
 *    left to refund.
 *  - **channel** -- from the release to the end, running while it pulses.
 *
 * The wind-up's length is `releaseTick - startTick` and is deliberately not
 * `ability.windupTicks`: attack speed scales the wind-up (spec 144), so reading
 * the table would draw the bar at the wrong rate for exactly the bodies
 * attacking fastest, which is the regime `scripts/probe-windup.ts` exists to
 * watch.
 *
 * Pure: a few numbers in, a number out, tested headlessly.
 */

import { CastPhaseValue } from '../../../server/net/protocol.js';

export interface CastLike {
  readonly abilityId: string;
  readonly phase: number;
  /** The tick the wind-up began (spec 144). */
  readonly startTick: number;
  readonly releaseTick: number;
  readonly endTick: number;
}

export interface CastBar {
  /** 0..1, how full to draw the bar. */
  readonly progress: number;
  /**
   * True while the caster can still withdraw *and get something back* -- the
   * bar that means something.
   *
   * False through the backswing (spec 144), which is walkable-out-of but has
   * nothing left to refund. The two are different claims and the renderer draws
   * them differently: one says "this is still a decision", the other says "this
   * already happened".
   */
  readonly cancellable: boolean;
  readonly phase: number;
  /** True while the body is only turning; the wind-up has not started. */
  readonly turning: boolean;
  /** True past the attack point: the blow has landed (spec 144). */
  readonly committed: boolean;
}

function clamp01(value: number): number {
  return value <= 0 ? 0 : value >= 1 ? 1 : value;
}

/**
 * `tick` may be fractional: the renderer paints between sim ticks, and passing
 * the interpolated tick is what stops the bar advancing in 20Hz steps while the
 * body under it moves smoothly.
 *
 * The ability table used to be an argument, for the wind-up's length alone.
 * Since spec 144 that length is on the cast, so this needs nothing but the four
 * ticks -- which also closes the way the two could disagree.
 */
export function castBar(cast: CastLike, tick: number): CastBar {
  const phase = cast.phase;

  // Turning. `releaseTick` is provisional here and the server will re-stamp it
  // at alignment, so there is nothing honest to fill a bar with -- drawing
  // against it would run the bar up and then reset it when the real wind-up
  // starts. Empty, and cancellable, which is exactly the state it describes.
  if (phase === CastPhaseValue.Turning) {
    return { progress: 0, cancellable: true, phase, turning: true, committed: false };
  }

  if (phase === CastPhaseValue.Windup) {
    // The wind-up's length comes off the cast itself, not off the ability table
    // (spec 144): attack speed scales it, and the table does not know by how
    // much. `startTick` is on the wire for exactly this.
    const windup = Math.max(1, cast.releaseTick - cast.startTick);
    return {
      progress: clamp01(1 - (cast.releaseTick - tick) / windup),
      cancellable: true,
      phase,
      turning: false,
      committed: false,
    };
  }

  if (phase === CastPhaseValue.Backswing) {
    // The follow-through. Drawn because the body is still rooted and the player
    // should be able to see how much of it is left to walk out of -- but not
    // `cancellable`, because walking out of it gives nothing back.
    const span = Math.max(1, cast.endTick - cast.releaseTick);
    return {
      progress: clamp01((tick - cast.releaseTick) / span),
      cancellable: false,
      phase,
      turning: false,
      committed: true,
    };
  }

  // Channel: from the release to the end, running while it pulses.
  const span = Math.max(1, cast.endTick - cast.releaseTick);
  return {
    progress: clamp01((tick - cast.releaseTick) / span),
    cancellable: true,
    phase,
    turning: false,
    committed: true,
  };
}
