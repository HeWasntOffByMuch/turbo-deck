/**
 * The swirl over a stunned body (spec 173).
 *
 * A poise break roots a body for `staggerTicks` -- it cannot walk, turn or
 * swing. `stagger-flinch.ts` draws the *contact* that put it there, which is a
 * couple of tenths of a second of rocking, and then the body stands
 * unnaturally still for the rest of the window with nothing saying why. This is
 * the other half: a mark that says the state, for exactly as long as the state
 * lasts.
 *
 * **It is stateless, and that is the difference from the flinch.** A flinch is
 * a *contact* -- it has to be started by an edge somebody watched, so it keeps
 * a per-entity track and refuses to fire for a body that walked into view
 * already broken. A swirl is a *state*: a body that is stunned right now is
 * stunned whether or not this client saw the blow, and the honest thing to draw
 * for one that came into view mid-break is the swirl. So there is no map, no
 * `retain`, and nothing to leak -- the answer is a pure function of the two
 * replicated fields and the tick, and asking about a body twice on one frame
 * cannot produce two different answers.
 *
 * Both fields it reads are authoritative (`activity`, `activityUntilTick`), so
 * this decides nothing: it is the same comparison the sim's own `staggered`
 * makes, asked by a thing that draws rather than a thing that gates.
 *
 * Pure. No DOM: `hud.ts` owns the element, the same division `health-bar.ts`
 * keeps.
 */

import { EntityActivity } from '../../../server/net/protocol.js';

/**
 * How fast the swirl turns, in full turns per second.
 *
 * Fast enough to read as spinning inside the shortest stagger there is. The
 * window is 0.5s at its floor, so anything under about two turns a second
 * shows less than one rotation and reads as a tilted glyph rather than a
 * spinning one -- and 2.5 gives a turn and a quarter at the floor, just over
 * two at the 0.8s cap.
 */
export const SPIN_TURNS_PER_SECOND = 2.5;

/** Ticks per second the drawn clock runs at, for the spin's phase. */
const TICK_RATE = 60;

/**
 * How many ticks before the window ends the swirl starts thinning out.
 *
 * A count rather than a fraction of the window, because a fraction needs the
 * window's *length* and this module deliberately does not know it: all it is
 * given is when the stagger ends, so "the last eight ticks" is expressible and
 * "the last third" is not. That turns out to be the better rule anyway -- the
 * tail reads the same whether the stagger was 30 ticks or 48, where a fraction
 * would make the long one fade for half again as long for no reason a player
 * could name.
 *
 * There is no fade *in*, on purpose. A stagger begins with a blow, and the
 * argument `stagger-flinch.ts` makes about starting at full throw applies here:
 * a mark that ramps up over its first frames reads as unrelated to the hit that
 * caused it. The end is the opposite -- the body simply becomes able to move
 * again -- so the swirl thins into it rather than vanishing on a frame
 * boundary.
 */
export const FADE_TICKS = 8;

/** What to draw over one body this frame. */
export interface StunMark {
  /** Whether the swirl is drawn at all. */
  readonly visible: boolean;
  /** Degrees to rotate the glyph by. */
  readonly spin: number;
  /** 0..1. Full until the window's last few ticks, then thinning into the end. */
  readonly opacity: number;
}

/** A body holding its own: nothing over its head. */
export const UNMARKED: StunMark = { visible: false, spin: 0, opacity: 0 };

/**
 * The swirl for one body, from what the wire said and the tick being drawn.
 *
 * `drawnTick` is the interpolated presentation tick the bodies under it are
 * placed by -- never `Date.now()` and never a second clock -- so the mark is a
 * pure function of a tick count and looks the same at 30fps as at 144.
 */
export function stunMark(
  activity: number,
  activityUntilTick: number,
  drawnTick: number,
): StunMark {
  if (activity !== EntityActivity.Stunned) return UNMARKED;
  const until = Number.isFinite(activityUntilTick) ? activityUntilTick : 0;
  const now = Number.isFinite(drawnTick) ? drawnTick : 0;
  // The same comparison `staggered` makes in the sim. A window that has already
  // passed is not a stagger, however stale the delta that carried it.
  if (now >= until) return UNMARKED;

  const left = until - now;
  // The spin runs off the window's *end* rather than off an observed start,
  // which is what keeps this stateless: every client watching this body agrees
  // on `activityUntilTick`, so every one of them draws the same angle on the
  // same tick without anybody having had to see the blow land. It counts up as
  // the window drains, so the glyph turns one way throughout.
  const spin = (-left * SPIN_TURNS_PER_SECOND * 360) / TICK_RATE;
  const opacity = left >= FADE_TICKS ? 1 : Math.max(0, left / FADE_TICKS);

  return { visible: true, spin, opacity };
}
