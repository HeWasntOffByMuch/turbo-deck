# 241 — Does this purchase do anything?

## Problem

`npm run balance` fights twelve *attribute* presets through the real sim. It is
the right instrument for "is Strength worth taking" and the wrong shape for the
question one level down: **for every skill, at every rank, at every attribute
value where that rank can legally be bought -- does the purchase reach the
simulation at all?**

Spec 232 closed eight faults that were each invisible to every test in the tree,
and six of them were that question answered wrongly:

- three skills granting an improvement to a mechanic their own milestone
  introduced, ten to twenty-five attribute points later;
- two ranks bought into a number a milestone had already filled to its cap;
- a capstone that made its own mechanic more expensive.

Every one would have been a line of this report. They were found by reading, and
reading does not scale to thirty-six skills times ninety-six ranks times four
contexts.

## Shape

Pure, in `player/progression-audit.ts`; a script and a CI gate both drive it.

```ts
export type Verdict = 'ACTIVE' | 'REDUNDANT' | 'INERT' | 'BACKWARDS';
export function auditProgression(): AuditReport;   // ranks + milestones + growth
export function findings(report): readonly RankAudit[];
export function regressionKeys(report): readonly string[];
```

**What counts as an effect**: a value on `EffectiveStats` or `TraitStats` -- the
two objects the sim reads. A modifier that only moves a `ModifierTotals` field is
explicitly not enough, which is the case `grantsPrepared` exists to fix.

**Contexts are derived, not authored**: the value the rank becomes purchasable
at, each milestone threshold of the same attribute at or above it, and the hard
cap. A retuned threshold moves them with it.

**`REDUNDANT` vs `INERT` is a two-pass answer.** The first pass measures each
`(transition, context)` cell; the second looks across a transition's row. Nothing
moved *here* but something moves elsewhere is a cap somebody else filled;
nothing moved anywhere is a rank that does nothing, ever.

**Three audits, because they catch different things.** Ranks; milestones crossed
both alone *and under the skills of the same attribute a real character would be
holding* (the second is the one Arcane Overflow needed); and attribute growth
over whole spans, because a scale moving 0.2 a point rounds to nothing across a
threshold and is eight ticks across forty.

**Direction is an authored table**, `TRAIT_DIRECTION`, covering `TraitStats`
exactly -- because there is no heuristic: `backswingScale` down is good and
`flowTicks` up is good and nothing about either name says so. `ambiguous` is a
decision rather than an omission. `ABSENT_AT_ZERO` names the two fields where
`0` means the mechanic is not present, so acquiring one is not read as a
regression.

**Exceptions are an explicit allowlist with a reason each, asserted exactly.** A
new inert rank fails, and so does fixing an allowlisted one without removing its
entry -- so the list can only shrink by somebody deciding it should.

The script also prints the **ability scaling roster**: what each ability
declares, and the coefficient budget its letters add up to.

## Invariants tested

- `TRAIT_DIRECTION` covers `TraitStats` exactly, in both directions.
- Every skill produces at least one context, and the first is its `requires`.
- Every rank/context cell is checked; the count matches the tables.
- No finding that is not on the allowlist; no stale allowlist entry; every
  allowlist entry has a reason.
- No regression, at a milestone or across an attribute span, that is not on the
  allowlist; no stale entry there either.
- A control asserts the audit still produces `ACTIVE` verdicts with non-empty
  deltas, so an audit that had stopped computing anything cannot pass the
  absence assertions above it.

Verified by putting three of spec 239's faults back: Conservation's rank 3 reads
`INERT`, Adaptation's three ranks read `REDUNDANT` at the value they become
purchasable, Arcane Overflow reads as a regression, and the gate fails on two
assertions.

## Out of scope

- Behaviour-level interference. The audit reads resolved state, so it would not
  have caught spec 239's overheal fault -- both traits were present and the bug
  was a branch in `applyHealing`. That one is covered by `sim/overheal.test.ts`
  and the limit is stated rather than papered over.
- Equipment, levels and the loot tables. Attributes and skills only.
- Judging whether a rank is worth its *cost*. The question is whether it does
  anything, not whether it does enough.
