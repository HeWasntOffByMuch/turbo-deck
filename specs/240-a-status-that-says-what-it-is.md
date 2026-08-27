# 240 — A status that says what it is

## Problem

`sim/statuses.ts` is one map for everything a body remembers between ticks, and
its header says so on purpose: one map with one expiry rule is one place to get
right. The cost is that a Flow stack, a poison, a half-second reaction window
and a per-spawner farm-decay counter are all the same shape, and nothing can
tell them apart.

So **Catalysis asked the only question the map could answer**:

```ts
function afflicted(statuses: Statuses, tick: number): boolean {
  for (const [, value] of Object.entries(statuses)) {
    if (tick < value.expiresAtTick) return true;   // anything at all
  }
  return false;
}
```

`markTarget` stamps `recentlyHit` and `inCombat` on everything a blow lands on.
So the Intelligence skill whose whole identity is *statuses are fuel; anything
already suffering suffers more* was **"deal 8% more damage to anything you have
already hit once"** -- unconditional from the second swing, on every target in
the game. Its name, its trigger line and its place in the tree all described
something that was not happening, and no test in the tree noticed, because
nothing had ever asserted what it was supposed to key off.

## Shape

A table, because the question is not Catalysis's. *"Does this body carry a
meaningful affliction"* is what a cleanse, a resistance, a UI filter or a second
skill would each ask, and a list of ids inside one consumer is the wrong home
for all of them.

```ts
// data/status-semantics.ts
export const StatusTag = {
  Beneficial: 'beneficial',
  Harmful: 'harmful',
  Affliction: 'affliction',        // harmful + inflicted + persists
  DamageOverTime: 'damageOverTime',
  Bookkeeping: 'bookkeeping',      // an internal timer; never a condition
} as const;

export function tagsOf(id: string): readonly StatusTag[];        // [] = unclassified
export function isAffliction(id: string): boolean;
export function hasAffliction(statuses: Statuses, tick: number): boolean;
export function afflictionsOn(statuses: Statuses, tick: number): readonly string[];
```

Five tags, and no more, because a category nobody queries is a category that
drifts. The dynamic families (`adapt:`, `dmg:`, `farm:`, `elite:`, `pvpKill:`)
are a closed prefix table rather than a heuristic.

**Absent is not an affliction.** `tagsOf` answers `[]` for an unclassified id,
so the failure mode of forgetting a row is a mechanic that does not fire rather
than one that fires on everything -- the same safe-by-absence rule
`data/status-visuals.ts` already keeps for the wire.

Two classifications are the design decisions worth arguing over, and both are
recorded as arguable: **Vulnerable** is a fact about what the target just did
rather than something inflicted on it, and **Exposed** is a read somebody took
that already amplifies damage on its own. Both are `harmful`; neither is an
`affliction`.

`StatusId.ExposedBounty` moves out of `sim/blow.ts` into `StatusId` beside the
rest of the well-known ids, so the classification table can reach it without
importing the file that reads the classification.

## Invariants tested

- Every `StatusId` and every dynamic family is classified; an unclassified id
  answers `[]` and is never an affliction.
- Every affliction is harmful; every damage-over-time is an affliction; nothing
  is both beneficial and harmful; bookkeeping carries no other tag.
- Every row of `data/damage-over-time.ts` is tagged `damageOverTime` and every
  row of `data/aura-fields.ts` is tagged `beneficial`, so the tables cannot
  drift apart.
- Every `StatusVisual` agrees with its tags about which way the status cuts, so
  a mark drawn as a boon is never treated as harmful.
- Through the real `resolveBlow`: Catalysis fires on each of the nine
  afflictions; does **not** fire on `RecentlyHit`, on `InCombat`, on both
  together, on any boon, on `adapt:`, on an assist mark, on `exposed.bounty`, on
  a spent-marker, on Vulnerable or on Exposed; and still fires on a poison
  buried among all of them.
- A control asserts the caster's `vsAfflictedPct` is non-zero, so the eight
  negative cases cannot pass by the skill being switched off.

## Out of scope

- Duplicating or renaming any production status. Vulnerable, Exposed, Sundered,
  Flow, Momentum, Prepared and Attuned keep their ids and their meanings.
- A cleanse, a dispel, a resistance system, or anything else that would read the
  tags. The taxonomy is sized to what exists.
- `StatusVisual.kind`, which stays presentation-only. The consistency check
  relates the two; it does not merge them.
