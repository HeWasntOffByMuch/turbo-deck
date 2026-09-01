/**
 * What kind of thing a status *is* (spec 240).
 *
 * `sim/statuses.ts` is deliberately one map for everything a body has to
 * remember between ticks, and its header says so: the Flow an Agility character
 * is riding sits in it beside a half-second reaction window, an inverted "your
 * comeback has been spent", and a per-spawner farm-decay counter. One map with
 * one expiry rule is one place to get right, and that is the correct trade --
 * but it leaves the map with no way to answer *"is this body suffering from
 * something"*, because every entry looks the same.
 *
 * So Catalysis asked the only question the map could answer, which was **"is
 * anything at all on this body"**:
 *
 * ```ts
 * for (const [, value] of Object.entries(statuses)) {
 *   if (tick < value.expiresAtTick) return true;      // the old `afflicted`
 * }
 * ```
 *
 * Every blow stamps `recentlyHit` and `inCombat` on whatever it lands on. So
 * Catalysis -- *statuses are fuel; anything already suffering suffers more* --
 * was **"deal 8% more damage to anything you have already hit once"**, on every
 * target in the game, forever. Its trigger line, its name and its identity as
 * the Intelligence skill that rewards setting a fight up were all describing
 * something that was not happening.
 *
 * This table is the missing distinction, and it is a *table* rather than a list
 * inside Catalysis because the question is not Catalysis's. "Does this body
 * carry a meaningful affliction" is a thing a cleanse, a resistance, a UI filter
 * or a second skill would each ask, and a hardcoded list of ids in one consumer
 * is the wrong place for all of them.
 *
 * **The default is unclassified, and unclassified is not an affliction.** {@link
 * tagsOf} answers `[]` for an id with no row, so a status added to the sim
 * cannot become Catalysis fuel by being forgotten -- which is the same
 * safe-by-absence rule `data/status-visuals.ts` keeps for the wire, and for the
 * same reason.
 *
 * Pure data, plus the one query over it.
 */

import { ADAPTED_PREFIX, statusOf, StatusId, type Statuses } from '../sim/statuses.js';
import { ASSIST_PREFIX, ELITE_PREFIX, FARM_PREFIX, PVP_KILL_PREFIX } from '../sim/restoration.js';

/**
 * The taxonomy, kept to what current systems actually ask.
 *
 * Five tags, and the reason there are not more is the reason there is a table
 * at all: a category nobody queries is a category that drifts. Each of these is
 * read -- three by the sim, and `damageOverTime` by the consistency check in
 * `status-semantics.test.ts` that keeps this table and
 * `data/damage-over-time.ts` from disagreeing about which statuses pulse.
 */
export const StatusTag = {
  /** Works *for* the body carrying it. */
  Beneficial: 'beneficial',
  /** Works *against* the body carrying it. */
  Harmful: 'harmful',
  /**
   * A harmful condition that was **inflicted** on the body and **persists**.
   *
   * The Catalysis query, and the one tag with a rule rather than a description.
   * The distinction it draws is against two things that are also `harmful`:
   *
   *  - **Vulnerable is not an affliction.** It is a fact about what the target
   *    just *did* -- committed an attack -- so nobody inflicted it and there is
   *    nothing to suffer from. It is an opening, and reading an opening is
   *    Perception's whole identity.
   *  - **Exposed is not an affliction either.** It is a *read* left by a weak
   *    point: the target has not been hurt by it, somebody has noticed
   *    something about them. It is already a damage amplifier, so counting it
   *    here would make Perception and Intelligence double up on one "this
   *    target is marked" state without either table saying so.
   *
   * Both calls are arguable and both are recorded as arguable rather than
   * obvious. What is not arguable is `recentlyHit` and `inCombat`, which are
   * neither inflicted nor suffered from: they are the sim's own timers.
   */
  Affliction: 'affliction',
  /** Pulses damage on a cadence. Implies {@link Affliction}. */
  DamageOverTime: 'damageOverTime',
  /**
   * An internal timed flag. Never a condition, whichever way it cuts.
   *
   * Stated rather than left to absence, because these are exactly the entries a
   * future query will be tempted to treat as conditions -- `recentlyHit` reads
   * like a debuff and `secondWind.spent` reads like one too, being inverted.
   * A row saying "this is bookkeeping" is a decision somebody made; no row is
   * an omission.
   */
  Bookkeeping: 'bookkeeping',
} as const;

export type StatusTag = (typeof StatusTag)[keyof typeof StatusTag];

const { Beneficial, Harmful, Affliction, DamageOverTime, Bookkeeping } = StatusTag;

/** The tags carried by one status id. */
export interface StatusSemantics {
  readonly id: string;
  readonly tags: readonly StatusTag[];
}

/**
 * Every status the game names, and what each one is.
 *
 * In `StatusId`'s own order, so this file and that one can be read side by side
 * and checked off -- and `status-semantics.test.ts` asserts the coverage is
 * total, so a status added there and forgotten here fails CI rather than
 * quietly becoming unclassified.
 */
export const STATUS_SEMANTICS: readonly StatusSemantics[] = [
  // --- boons: what a build earns ----------------------------------------
  { id: StatusId.Flow, tags: [Beneficial] },
  { id: StatusId.Momentum, tags: [Beneficial] },
  { id: StatusId.Prepared, tags: [Beneficial] },
  { id: StatusId.Attuned, tags: [Beneficial] },
  // A field is a boon its *carrier* wears; what it does to everyone else is a
  // row in `data/aura-fields.ts`, and what that lays on them is a Burn, which
  // is tagged where Burn is.
  { id: StatusId.ScorchedEarth, tags: [Beneficial] },
  // Beneficial and nothing else (spec 250). Not `Bookkeeping`, which is for the
  // timers the sim keeps for itself: this one is *only* visible, so being seen
  // is the whole of what it does.
  { id: StatusId.MagicLight, tags: [Beneficial] },

  // --- harmful, but not afflictions -------------------------------------
  { id: StatusId.Exposed, tags: [Harmful] },
  { id: StatusId.Vulnerable, tags: [Harmful] },

  // --- afflictions: inflicted, and suffered from ------------------------
  // Armour stripped and movement taken away. Neither pulses, and both are
  // unmistakably things somebody did to this body that are still happening.
  { id: StatusId.Sundered, tags: [Harmful, Affliction] },
  { id: StatusId.Slowed, tags: [Harmful, Affliction] },

  // The seven of `data/damage-over-time.ts`, whole.
  { id: StatusId.Burn, tags: [Harmful, Affliction, DamageOverTime] },
  { id: StatusId.Bleed, tags: [Harmful, Affliction, DamageOverTime] },
  { id: StatusId.Poison, tags: [Harmful, Affliction, DamageOverTime] },
  { id: StatusId.Corrosion, tags: [Harmful, Affliction, DamageOverTime] },
  { id: StatusId.Shock, tags: [Harmful, Affliction, DamageOverTime] },
  { id: StatusId.Frostbite, tags: [Harmful, Affliction, DamageOverTime] },
  { id: StatusId.Decay, tags: [Harmful, Affliction, DamageOverTime] },

  // --- the sim's own timers ---------------------------------------------
  // The two that made Catalysis unconditional. Every blow stamps both on
  // whatever it lands on, so an affliction query that counted them was a query
  // that answered "has this been hit".
  { id: StatusId.RecentlyHit, tags: [Bookkeeping] },
  { id: StatusId.InCombat, tags: [Bookkeeping] },
  // The clock a monster's recovery is measured against. Nobody suffers from it
  // and nobody benefits: it is the sim remembering when a fight ended.
  { id: StatusId.Recovering, tags: [Bookkeeping] },
  // Inverted: carrying one means the mechanic has fired and has not re-armed.
  // Bookkeeping rather than `Harmful` for that reason -- it is the absence of a
  // boon rather than the presence of a problem, and a cleanse that removed it
  // would be a cleanse that handed you a free comeback.
  { id: StatusId.SecondWindSpent, tags: [Bookkeeping] },
  { id: StatusId.PerfectExitSpent, tags: [Bookkeeping] },
  // A payout marker for *other* people, parked on the target. Not a condition
  // the target suffers from; not one it benefits from either.
  { id: StatusId.ExposedBounty, tags: [Bookkeeping] },
];

/** A dynamic family: every id starting with `prefix` carries these tags. */
export interface StatusPrefixSemantics {
  readonly prefix: string;
  readonly tags: readonly StatusTag[];
}

/**
 * The families whose ids are built at runtime.
 *
 * A closed table rather than a heuristic, for the reason `naming.ts` is one and
 * `POINTER_CODES` is one: a heuristic is a second, invisible answer that every
 * boundary has to re-derive, and there is nowhere to write down why.
 */
export const STATUS_PREFIX_SEMANTICS: readonly StatusPrefixSemantics[] = [
  // Resistance the victim has *earned*, per ability. A boon, and pointedly not
  // an affliction -- a body that has adapted to your Quake is harder to hurt,
  // not easier.
  { prefix: ADAPTED_PREFIX, tags: [Beneficial] },
  // The health economy's four ledgers: who hit me, how much I have farmed this
  // spawner, elite decay, and a per-victim pvp mark. None is a condition.
  { prefix: ASSIST_PREFIX, tags: [Bookkeeping] },
  { prefix: FARM_PREFIX, tags: [Bookkeeping] },
  { prefix: ELITE_PREFIX, tags: [Bookkeeping] },
  { prefix: PVP_KILL_PREFIX, tags: [Bookkeeping] },
];

const BY_ID: ReadonlyMap<string, readonly StatusTag[]> = new Map(
  STATUS_SEMANTICS.map((row) => [row.id, row.tags]),
);

const NO_TAGS: readonly StatusTag[] = [];

/**
 * What this status is, or `[]` for one nobody has classified.
 *
 * Exact ids first, then the prefix families. Total by construction: an
 * unrecognised id is unclassified rather than an error, and unclassified is
 * never an affliction -- so the failure mode of forgetting a row is a mechanic
 * that does not fire, rather than one that fires on everything.
 */
export function tagsOf(id: string): readonly StatusTag[] {
  const exact = BY_ID.get(id);
  if (exact) return exact;
  for (const family of STATUS_PREFIX_SEMANTICS) {
    if (id.startsWith(family.prefix)) return family.tags;
  }
  return NO_TAGS;
}

/** Whether this status carries `tag`. */
export function hasTag(id: string, tag: StatusTag): boolean {
  return tagsOf(id).includes(tag);
}

/** Whether this status is a meaningful, inflicted, ongoing condition. */
export function isAffliction(id: string): boolean {
  return hasTag(id, StatusTag.Affliction);
}

/**
 * Whether this body is carrying a meaningful affliction right now.
 *
 * **The Catalysis query**, and the one function that answers it. Live entries
 * only, through the same {@link statusOf} the rest of the sim reads with, so a
 * stale entry can no more feed Catalysis than it can feed anything else.
 *
 * It walks the body's statuses rather than the table because a body carries a
 * handful of entries and the table has twenty-odd rows -- and because the ids a
 * body actually carries include the dynamic families, which cannot be
 * enumerated.
 */
export function hasAffliction(statuses: Statuses, tick: number): boolean {
  for (const id of Object.keys(statuses)) {
    if (!isAffliction(id)) continue;
    if (statusOf(statuses, id, tick)) return true;
  }
  return false;
}

/** Every live affliction on a body, for tooling and tests. Ids only. */
export function afflictionsOn(statuses: Statuses, tick: number): readonly string[] {
  const found: string[] = [];
  for (const id of Object.keys(statuses)) {
    if (isAffliction(id) && statusOf(statuses, id, tick)) found.push(id);
  }
  return found;
}
