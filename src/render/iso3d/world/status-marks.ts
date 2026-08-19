/**
 * The marks over a body carrying a status (spec 185).
 *
 * The companion to `stun-icon.ts`, and deliberately built to the same three
 * rules, because they were the right ones and a second answer to "how does a
 * timed state get drawn" is a second thing to keep in step.
 *
 * **Stateless.** There is no map, no `retain` and nothing to prune. A body that
 * is Exposed right now is Exposed whether or not this client watched the weak
 * point that exposed it, so the honest thing to draw for one that walks into
 * view mid-status is the mark. That is what a `stagger-flinch` cannot be -- a
 * flinch is a *contact* and needs an edge somebody saw -- and what the swirl
 * beside this already is.
 *
 * **A stale entry is refused on read.** `ReplicatedEntity.statuses` is never
 * pruned by anybody, and the sim's own `statusOf` refuses an entry whose window
 * has passed rather than trusting a sweep to have removed it. This does the
 * same comparison, which is what makes correctness independent of whether the
 * delta saying "it fell off" has arrived yet.
 *
 * **The clock is an argument.** `drawnTick` is the interpolated presentation
 * tick the bodies under these are placed by -- never `Date.now()`, never a
 * second clock -- so a mark is a pure function of a tick count and looks the
 * same at 30fps as at 144.
 *
 * Pure. No DOM: `hud.ts` owns the elements, the same division `health-bar.ts`
 * and `stun-icon.ts` both keep.
 */

import type { WireStatus } from '../../../server/net/messages.js';
import {
  STATUS_VISUALS,
  visualByWire,
  type StatusIconId,
  type StatusKind,
} from '../../../server/data/status-visuals.js';

/**
 * How many ticks before a status ends its mark starts thinning out.
 *
 * A count rather than a fraction, for the reason `stun-icon.ts` gives at
 * length: the function is handed an *end* and not a length, so "the last eight
 * ticks" is expressible and "the last third" is not. It is also the better rule
 * here than it was there, because these windows are far more varied -- Flow at
 * 1.2s and Adaptation at several seconds should tail off identically, where a
 * fraction would fade the long one for seconds.
 *
 * The same eight ticks as the swirl, so two marks on one body that end together
 * fade together.
 */
export const FADE_TICKS = 8;

/**
 * There is no fade *in*, on purpose.
 *
 * A status arrives because something happened -- a blow found a weak point, a
 * follow-through was walked out of -- and a mark that ramps up over its first
 * frames reads as unrelated to the thing that caused it. Same argument the
 * swirl makes, same answer.
 */

/** What to draw for one status this frame. */
export interface StatusMark {
  /** The row's id, so a caller can key elements by it. */
  readonly id: string;
  readonly name: string;
  readonly icon: StatusIconId;
  readonly kind: StatusKind;
  /** Live stacks. 1 for the ones that do not stack. */
  readonly stacks: number;
  /** Whether the count is worth drawing: false for a row that cannot stack. */
  readonly showsCount: boolean;
  /** 0..1. Full until the window's last few ticks, then thinning into the end. */
  readonly opacity: number;
}

/** Shared, so a body with nothing on it allocates nothing. */
export const NO_MARKS: readonly StatusMark[] = [];

/**
 * The marks for one body, from what the wire said and the tick being drawn.
 *
 * Returned in wire-index order rather than in the order the list arrived, for
 * the reason `AURA_ORDER` is fixed: two bodies carrying the same statuses always
 * show the same picture, and a mark never slides along the row because
 * something else was applied. The server already sorts, and sorting again here
 * costs nothing and means the drawing does not depend on it having done so.
 *
 * A `wire` index this build has no row for is dropped rather than drawn as a
 * placeholder -- that is a client talking to a newer server, and an unnamed
 * glyph over a body says less than nothing.
 */
export function statusMarks(
  statuses: readonly WireStatus[],
  drawnTick: number,
): readonly StatusMark[] {
  if (statuses.length === 0) return NO_MARKS;
  const now = Number.isFinite(drawnTick) ? drawnTick : 0;

  let marks: StatusMark[] | null = null;
  for (const status of statuses) {
    const until = Number.isFinite(status.expiresAtTick) ? status.expiresAtTick : 0;
    // The same comparison `statusOf` makes in the sim, and the same one
    // `stunMark` makes about a passed window. A status that has run out is not a
    // status, however stale the delta that carried it.
    if (now >= until) continue;
    const visual = visualByWire(status.wire);
    if (!visual) continue;

    const left = until - now;
    const stacks = Math.max(1, Math.min(visual.maxStacks, Math.floor(status.stacks)));
    marks ??= [];
    marks.push({
      id: visual.id,
      name: visual.name,
      icon: visual.icon,
      kind: visual.kind,
      stacks,
      // A "1" over a status that can only ever be 1 is a number that never
      // means anything, so it is not drawn. A stacking row shows its count even
      // at one, because there the number is live and its absence would read as
      // "this one does not stack".
      showsCount: visual.maxStacks > 1,
      opacity: left >= FADE_TICKS ? 1 : Math.max(0, left / FADE_TICKS),
    });
  }

  if (!marks) return NO_MARKS;
  return marks.sort(
    (a, b) =>
      (WIRE_OF.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
      (WIRE_OF.get(b.id) ?? Number.MAX_SAFE_INTEGER),
  );
}

/**
 * Id to wire index, so the sort does not need the index carried on every mark.
 *
 * Built off the table rather than by walking indices up from zero, because
 * `wire` is append-only and a retired row would leave a hole a walk would stop
 * at -- silently dropping every row past it out of the ordering.
 */
const WIRE_OF: ReadonlyMap<string, number> = new Map(
  STATUS_VISUALS.map((visual) => [visual.id, visual.wire]),
);
