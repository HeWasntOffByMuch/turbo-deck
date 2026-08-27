# 237 — Progression that does not move backwards

## Problem

Eight joins between two pieces of progression, each of which is a fault, and
every one of them green in every existing test. The tables are coherent and the
derivation is coherent; what is wrong is what happens where they meet.

**Second Wind is a heartbeat rather than a comeback.** It re-arms the moment
health climbs back over its threshold -- and the comeback itself does that, on
the same tick, because healing 12% of maximum from under 30% lands above 30%. So
its twenty-second cooldown is cleared one tick after it is applied, every time,
and a Constitution character can cycle the threshold indefinitely.

**Arcane Overflow gets more expensive as you invest in it.** The Intelligence 40
skill and the Intelligence 50 milestone both grant
`overflowHealthPerResource` and the two sum, so reaching the milestone
**doubles** the health an overflow cast costs, from 2 a point to 4.

**Three purchasable skills do nothing at all when purchased.** `int.prepared`
(Intelligence 25), `per.openingRead` (Perception 10) and `wis.adaptation`
(Wisdom 25) each *improve* a mechanic their own milestone *introduces*, ten to
twenty-five attribute points later. Worse, `deriveTraits` infers each capability
from the number the skill reduces -- Prepared from `preparedWindupScale > 0`,
and the skill grants `-0.08` -- so buying the skill that improves Prepared is
what switches Prepared off.

**Two ranks are bought into a full number.** `windupPoiseArmor` is capped at 0.9
and its four sources sum to 2.0, so at Strength 35 rank 3 of Committed Swing is
worth nothing and past Strength 50 every rank is. `attunedCostPct` is capped at
0.2, the Wisdom 20 milestone grants 0.08 and Conservation grants 0.07 a rank, so
its rank 3 is worth nothing at the tier it becomes purchasable.

**Hard to Kill grants a mechanic it does not mention.** `isResolute` gates the
damage reduction *and* immunity to guard breaks, and `resoluteBelow` is inferred
from `resoluteReduction` -- so a skill whose entire grant is a damage reduction
hands out complete stagger immunity below 30% health, which is the milestone's
stated, qualitative payoff.

**The Constitution capstone switches the Wisdom capstone off.** `applyHealing`
routes overheal with `if (shield) else if (conversion)`, so a character with
Overflow Vitality and Conversion takes the shield branch always and Conversion
-- the last thing a Wisdom character buys -- never runs again.

## Shape

**Capability flags, so a delta is never also a switch.** Three new
`TraitModifier` fields, read as `> 0`, in the pattern `poiseArmorAllCasts`
already sets:

```ts
readonly grantsPrepared?: number;
readonly grantsOpeningRead?: number;
readonly grantsAdaptation?: number;
```

Behind each, the numbers become **deltas onto a base in `SCALING`**, so every
layer moves them in the direction it reads and both a skill and a milestone may
grant the capability.

**A price its sources may only lower.** `overflowHealthPerResource` decides
*whether* Overflow exists; the rate is `SCALING`'s and the only thing that moves
it is `overflowCostReduction`, which by the reduction convention can only
shrink. Backwards progression becomes impossible rather than absent.

**A separated trait, so a tooltip is true.**

```ts
readonly staggerImmuneBelow: number;   // TraitStats
export function isUnstaggerable(entity): boolean;   // sim/poise.ts
```

`isResolute` keeps the damage reduction; the two places a break can happen read
the new one.

**A budget, not a bigger cap.** The four `windupPoiseArmor` sources are retuned
to sum to exactly 0.9 and the three `attunedCostPct` sources to exactly 0.2 --
so the endpoint of a fully-invested character is unchanged and every step on the
way there is reachable.

**A cascade, not a branch.** `applyHealing` runs shield, then conversion, then
salvage, each taking from what the one above it left.

**A lifecycle, not a longer timer.** `SecondWindSpent` is held until an explicit
reset, and the reset is the flask's own: `advanceRest` clears it beside the
charge it returns, and `respawn` clears it beside the flask it refills.

## Invariants tested

- Second Wind stays spent however far health climbs, and across a hundred
  thousand ticks; the cycle that used to work yields exactly one comeback; a
  rest clears it and walking does not.
- Arcane Overflow with both layers costs no more than with either alone and
  strictly less than either; no combination exceeds the base rate; the
  Battlemage pair lowers it again.
- Every rank of Committed Swing, Conservation and Hard to Kill moves its trait
  at every attribute value including past both milestones; the Strength
  hyper-armour sources sum to exactly the cap.
- Prepared, Opening Read and Adaptation each work at their own `requires`, on
  every field the mechanic needs to function, and rank up monotonically.
- The Enduring pair still reaches the 45% Adaptation cap its effect line states.
- Hard to Kill's skill grants a damage reduction and no stagger immunity; the
  milestone grants both; exactly one row in any table grants the immunity.
- Overheal fills the shield and converts the remainder; neither mechanic
  reduces the other; the outlets together never take more than the overheal; a
  full shield passes the whole remainder on.

## Out of scope

- Redesigning the skill trees, the milestones or the pairs. No row is added or
  removed; eight are retuned and four gain a capability flag.
- Retuning anything not implicated in one of the eight faults.
- The audit that would have found these. That is spec 239.
