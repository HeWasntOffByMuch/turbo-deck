/**
 * Which statuses a player can see, and what each one looks like (spec 186).
 *
 * `sim/statuses.ts` is where *"everything the progression needs to remember
 * about a body between ticks"* goes, and that is deliberately wider than what
 * anybody should be shown. Some of what it remembers is a condition -- Flow
 * building, a target left Exposed -- and some of it is bookkeeping: a 0.2s
 * window Perfect Exit reads, an inverted "your comeback has been spent", the
 * per-spawner farm decay. This table is the line between them.
 *
 * **The rule: the wire carries the conditions somebody could point at, not the
 * timers the sim keeps for itself.** A row here is a promise that a player can
 * act on the mark. Four `StatusId`s and every internal family
 * (`dmg:`, `exposed.bounty`, the restoration keys) are deliberately absent, and
 * absent is the default -- {@link visualFor} answers null for anything with no
 * row, so a status added to the sim is invisible until somebody decides it
 * should not be.
 *
 * `wire` is **append-only**. It is the number that crosses the wire in place of
 * the string id, so renumbering a row silently re-labels every mark on a client
 * that has not been rebuilt. Add at the end; never reuse a retired index.
 *
 * `icon` is a *picture*, in the same register as `ProjectileSpec.look`: nothing
 * under `src/server/sim/` reads it, and it rides no wire. The client looks it up
 * from the id it was sent, because this table is shared code.
 *
 * Pure data.
 */

import { StatusId, ADAPTED_PREFIX } from '../sim/statuses.js';

/** The glyphs `render/iso3d/world/icons.ts` draws for these. */
export type StatusIconId =
  | 'flow'
  | 'momentum'
  | 'prepared'
  | 'attuned'
  | 'exposed'
  | 'vulnerable'
  | 'sundered'
  | 'adapted';

/**
 * Which way a status cuts.
 *
 * Colour comes from this and from nothing else -- eight colours over a head is a
 * legend rather than a picture, and a player reading a fight needs "is that good
 * for them or bad for them" long before they need which one it is.
 *
 * It is presentation, and no rule in the sim reads it: a boon is not cleansable
 * and an affliction is not dispellable, because neither of those systems exists.
 */
export type StatusKind = 'boon' | 'affliction';

export interface StatusVisual {
  readonly id: string;
  /** Stable wire index. Append only. */
  readonly wire: number;
  readonly name: string;
  readonly kind: StatusKind;
  readonly icon: StatusIconId;
  /**
   * What the sim will let this reach, so a client can draw "2/3" without being
   * told the ceiling per body. A 1 here means the mark never shows a count.
   */
  readonly maxStacks: number;
}

/**
 * The id the adaptation family collapses to.
 *
 * Adaptation is per ability -- `adapt:bolt.arcane` -- so it is the one entry
 * here that is not a status id the sim ever writes. A mark over a head cannot
 * say *which* ability it has learned to shrug off, so the eight rows below carry
 * one `adapted` and the packer folds every `adapt:` entry into it, keeping the
 * largest stack count. What is left is still true: this body is getting harder
 * to hurt the same way.
 */
export const ADAPTED_ID = 'adapted';

const DEFINITIONS: readonly StatusVisual[] = [
  // --- boons -------------------------------------------------------------
  { id: StatusId.Flow, wire: 0, name: 'Flow', kind: 'boon', icon: 'flow', maxStacks: 3 },
  { id: StatusId.Momentum, wire: 1, name: 'Momentum', kind: 'boon', icon: 'momentum', maxStacks: 1 },
  { id: StatusId.Prepared, wire: 2, name: 'Prepared', kind: 'boon', icon: 'prepared', maxStacks: 1 },
  { id: StatusId.Attuned, wire: 3, name: 'Attuned', kind: 'boon', icon: 'attuned', maxStacks: 3 },

  // --- afflictions -------------------------------------------------------
  // Exposed is the one that most needed a picture: it is worth +15% to
  // *everybody* attacking that body, and until now no member of that everybody
  // could see it.
  { id: StatusId.Exposed, wire: 4, name: 'Exposed', kind: 'affliction', icon: 'exposed', maxStacks: 1 },
  { id: StatusId.Vulnerable, wire: 5, name: 'Vulnerable', kind: 'affliction', icon: 'vulnerable', maxStacks: 1 },
  { id: StatusId.Sundered, wire: 6, name: 'Sundered', kind: 'affliction', icon: 'sundered', maxStacks: 1 },
  // An affliction from the point of view of whoever is trying to land the blow,
  // which is the side the mark is read from: a body that has adapted is a body
  // your bolt is getting worse against.
  { id: ADAPTED_ID, wire: 7, name: 'Adapted', kind: 'affliction', icon: 'adapted', maxStacks: 8 },
];

export const STATUS_VISUALS: readonly StatusVisual[] = DEFINITIONS;

/** The widest a packed list can be, which bounds the field on the wire. */
export const MAX_VISIBLE_STATUSES = DEFINITIONS.length;

const BY_ID: ReadonlyMap<string, StatusVisual> = new Map(
  DEFINITIONS.map((definition) => [definition.id, definition]),
);

const BY_WIRE: ReadonlyMap<number, StatusVisual> = new Map(
  DEFINITIONS.map((definition) => [definition.wire, definition]),
);

/**
 * The row for one status id, or null if it is not shown.
 *
 * Every `adapt:<ability>` key answers the collapsed {@link ADAPTED_ID} row, which
 * is what lets the packer fold the family without knowing the ability table.
 */
export function visualFor(id: string): StatusVisual | null {
  if (id.startsWith(ADAPTED_PREFIX)) return BY_ID.get(ADAPTED_ID) ?? null;
  return BY_ID.get(id) ?? null;
}

/**
 * The row for a wire index, or null.
 *
 * Null rather than a throw: an index this build has no row for is a client
 * reading a newer server, and the honest answer to a mark it cannot name is to
 * draw nothing rather than to drop the frame.
 */
export function visualByWire(wire: number): StatusVisual | null {
  return BY_WIRE.get(wire) ?? null;
}
