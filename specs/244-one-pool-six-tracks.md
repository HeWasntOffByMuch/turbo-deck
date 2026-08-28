# 244 — One pool, six tracks

## Problem

Progression is **two currencies buying two trees**, plus a third layer nobody
spends anything on:

| Layer | Earned | Spent on | Gate |
|---|---|---|---|
| Attribute points | 5 + 3/level | the six attributes | the hard cap |
| Skill points | 1 + 1/level | 36 attuned skills, ranks 1-3 | an attribute threshold (10/25/40) |
| Milestones | — | — | automatic at 20/35/50 |
| Pair synergies | — | — | automatic, both halves at 25 |

`PersistedPlayer` comments defend the split in as many words: *"a system where a
point can be either a stat or a skill makes every skill compete with a stat, and
the stat always wins early and never wins late."* That is a real hazard, and the
price paid to avoid it is that the player never makes the decision the whole
system is about. Two budgets means the two trees are never weighed against each
other; a skill point has exactly one thing it can buy, so spending it is
bookkeeping rather than a choice.

Three further things are wrong with the shape as it stands:

- **A respec burns points.** `respecAttributes` returns the attribute points and
  `sanitizeSkills` then *drops* every specialization whose threshold is no
  longer met — without refunding a single skill point. Under two budgets that is
  a quiet loss; under one it would be intolerable.
- **The fifteen pair synergies are content nobody asked to be surprised by.**
  Every pair carries a bespoke authored bonus, present because a test requires
  all fifteen to exist. Whether the underlying mechanics already compose has
  never been tested, because the authored layer was always in the way.
- **"Skill" means two things.** The 36 attuned skills and the four equipped
  active skills (`skill1..skill4`, `activeSkillId`, `SkillSlot`) share a word and
  share nothing else.

## Shape

**One pool.** `unspentProgressionPoints`, earned at `SCALING.startingPoints` 6
and `SCALING.pointsPerLevel` 4 — the two old schedules summed, so a level-20
character holds the same 82 points of purchasing power they always did. One
schedule, in `SCALING`, so pacing is tuned in one place.

**Six tracks.** An attribute *is* a track. A point spent on it raises the
attribute; a point spent on a specialization does not. That is the trade-off the
system exists to present, and it is the one rule every layer preserves.

```ts
// data/specializations.ts  — was data/skills.ts
export interface SpecializationDefinition {
  readonly id: string;
  readonly attribute: AttributeKey;
  readonly name: string;
  readonly requires: number;        // the milestone that unlocks it: 10 | 25 | 40
  readonly tier: number;            // which threshold, 1..3
  readonly maxTier: number;         // tiers purchasable, 1..3
  readonly trigger: string;
  readonly perTier: StatModifier;   // one tier's worth
  readonly costPerTier?: number;    // points, default 1 — variable costs, unused
  readonly description: string;
}

// data/milestones.ts — one field added
export interface MilestoneDefinition {
  /* … unchanged … */
  /** The specialization this milestone automatically deepens, where there is one. */
  readonly deepens?: string;
}

// data/tracks.ts — the assembler both the read model and the audit share
export interface TrackNode {
  readonly threshold: number;
  readonly milestone: MilestoneDefinition | null;      // automatic
  readonly specializations: readonly SpecializationDefinition[];  // purchasable
}
export function trackFor(attribute: AttributeKey): readonly TrackNode[];
```

The thresholds do not move. Each track has six nodes — 10, 20, 25, 35, 40, 50 —
carrying the existing content exactly where it already sits:

```
STRENGTH   5 ──── 10 ──── 20 ──── 25 ──── 35 ──── 40 ──── 50
                   │       │       │       │       │       │
                   │    (auto)     │    (auto)     │    (auto)
                   ├ Crushing Blows ●●●            │
                   ├ Committed Swing ●●●───────────┘
                   │                 ├ Brutal Follow-Through ●●●
                   │                 ├ Heavy Handling ●●●
                   │                 └ Overkill ●●●
                   └ Unstoppable ● ───────────────────────────┘
```

All **eighteen milestone names already match a specialization name** — every
automatic milestone is the deepening of a mechanic the track unlocked earlier.
`deepens` records that link rather than leaving the sheet to print one name
twice with no explanation.

**One spend command.**

```ts
export interface SpendProgressionPointMessage {
  readonly type: typeof ClientMessageType.SpendProgressionPoint;
  readonly target: ProgressionTargetValue;   // Attribute | Specialization
  readonly attribute: number;                // ordinal, when target is Attribute
  readonly specializationId: string;         // when target is Specialization
}
```

Replaces `AllocateAttribute` and `SpendSkillPoint`. One logical economy gets one
request; two wire messages for one pool would be the split surviving the refactor
in the one place a client can see it.

**Explicit pair synergies are removed.** `data/synergies.ts`, the `synergies`
field on `Progression`, the wire field and the sheet's presentation all go. The
systemic interactions stay untouched: Strength still pressures Guard, Perception
still exploits Vulnerable, Wisdom still changes the resource economy. The point
is to find out whether those already compose.

**Respec is an atomic refund.** Attributes go back to the starting spread *and*
every purchased tier is refunded, in one operation, into the one pool. The
dependency problem — a tier whose milestone is no longer reached — is
unrepresentable rather than handled: there is no path that lowers an attribute
and leaves a tier standing.

## Invariants tested

**Economy**
- A level-`n` character has earned exactly `6 + 4 * (n - 1)` points, and that
  equals the old two budgets summed at every level.
- Spending on an attribute raises it by 1 and the pool by -1.
- Spending on a specialization raises its tier by 1, the pool by -1, and **the
  attribute by 0**.
- Overspend, unknown id, unknown attribute ordinal, tier past `maxTier`, and a
  specialization whose milestone is not reached are each refused, and a refusal
  leaves the record byte-identical.

**Server authority**
- A forged attribute value on the wire is ignored: the request names a target,
  never a result.
- A client-claimed tier is ignored the same way.

**Derived behaviour**
- Every purchased tier moves a value on `EffectiveStats` or `TraitStats`, at
  every attribute value where it can legally be bought — spec 241's audit,
  retargeted at tiers.
- Automatic milestones still fire at 20/35/50.
- No pair of attributes produces a modifier that neither attribute produces
  alone: the synergy layer contributes nothing, asserted over all fifteen pairs.
- `deepens` names a real specialization on the same track, for all eighteen.

**Persistence**
- A fresh character round-trips: attributes, pool, tiers.
- A row at `save_version` 1 is refused as unsupported rather than reinterpreted.
- No obsolete `unspentSkillPoints` / `unspentAttributePoints` field is written.

**Respec**
- Refunds attribute points and specialization tiers together, into one pool.
- A respec leaves no tier whose milestone is unreached.

**Read model**
- Six tracks, each with its value, its nodes in threshold order, the next
  milestone and the distance to it, and per specialization: tier held, max tier,
  availability, and the cost of the next tier.
- A track with no purchasable specialization at the current value still renders.

**UI**
- The character screen has no Attributes tab and no Skills tab.
- No synergy is presented anywhere.
- One point counter.
- Selecting a track, selecting a specialization, and both kinds of purchase are
  driven in a headless test; a server refusal surfaces.

## Out of scope

- **Pacing.** The award schedule preserves total purchasing power and is not
  retuned. Whether 4/level is right for a pool that now buys two things is a
  balance question this spec deliberately leaves open, with the schedule
  centralized so it can be answered.
- **Tier cost curves.** `costPerTier` exists and every row uses the default 1.
- **New mechanics.** No specialization is invented; the 36 existing skills and
  18 milestones are mapped in place.
- **Threshold changes.** 10/25/40 and 20/35/50 stand.
- **Migration.** Local development characters are reset, not converted. There is
  deliberately no conversion code to maintain.
- **Reintroducing synergies.** If playtesting shows the systems do not compose,
  that is a later spec with content behind it.
