# 243 — Two numbers that belonged to the other body

## Problem

Two faults left over from specs 239 and 241, and they are the same fault in two
registers: **a quantity attributed to one body and read off another.**

**Second Wind's description describes a rule the sim stopped having.** Spec 239
replaced its reset — it used to re-arm the moment health climbed back over its
threshold, which the comeback itself does on the same tick — with a rest or a
death. The mechanic moved; the sentence did not. The skill's flavour still read:

```
One comeback. It will not fire again until you have climbed back out.
```

Four specs of players told the opposite of what the game does, with every
mechanic test green throughout, because none of them read a description. And the
*true* rule was nowhere at all: `describeStatSkill` derives its lines from the
row's grants, `secondWindHeal` is a percentage, and a percentage cannot say when
a mechanic re-arms.

**`staggerTicks` is Strength's and was read off the defender.** It sits in
`SCALING.strength` between `staggerBase`/`staggerPer` (*"poise damage a blow
carries"*) and `poisePer` (*"poise contributed to one's own pool"*, the one
Strength quantity explicitly labelled as self). It grows 0.2 a point, 31 ticks at
5 Strength to 42 at 60. Both consumers read it off the **victim**:

```ts
stagger(target, attacker.id, D.staggerTicks, ...)              // sim/blow.ts
stagger(poised.entity, caster.id, poised.entity.stats.traits.staggerTicks, ...)  // sim/skill-effects.ts
```

So investing in the overpower attribute bought a longer spell on the floor for
yourself and bought whoever broke you nothing — backwards progression in exactly
the sense `player/progression-audit.ts` exists to catch. It *was* caught, on
every run since spec 241, and allowlisted with a note saying which side should
read it was a design question rather than a typo.

## Shape

**Second Wind.** `GrantLabel` gains one optional field:

```ts
/** A rule about the mechanic this grant brings, as a whole sentence. */
readonly note?: string;
```

`grantsOf` emits it as a `whole: true` grant after the quantity's own line, and
`times` does not reach it — a rule is the same rule at rank 1 and at rank 3. The
`secondWindHeal` label carries the lifecycle:

```
Resting in a safe zone re-arms it, and so does dying. Recovering health does not.
```

The skill's `description` becomes flavour and only flavour, which is the rule the
vocabulary standard already states and which this is a case of: a mechanical
claim there is a second copy of a rule with nothing keeping it true.

**`staggerTicks`.** Resolved as *duration inflicted*, which is the reading the
scaling table's own neighbourhood implies and the one consistent with Strength as
overpower. Both call sites read the attacker's value; the trait's declaration and
the scaling comment say so; `TRAIT_DIRECTION` flips `down` → `up`; the four
allowlist entries go.

Nothing else moves. No RNG draw, so no seeded sequence shifts. Monsters carry
`NEUTRAL_TRAITS.staggerTicks`, which is `staggerTicksBase` — the same 30 ticks a
default-Strength player used to be held for, so an ordinary monster's break is
unchanged.

## Invariants tested

- Second Wind's description names the rest and denies the recovery, asserted in
  the same test that drives the sim through both — a change to either side alone
  fails.
- The skill's flavour contains no mechanical vocabulary at all.
- A break lasts as long as the **breaker's** Strength says, through
  `resolveBlow` and through a skill's `poiseDamage` effect.
- The same attacker breaking two bodies that differ only in Strength roots them
  for the same time.
- Raising Strength across its whole range never lengthens its own holder's
  stagger.
- The audit reports no `staggerTicks` regression, and the staleness test refuses
  an allowlist entry for one.

## Out of scope

- Retuning `staggerTicksBase`, `staggerTicksPer` or `staggerTicksCap`. The
  semantic moved; the curve did not.
- Every other trait's ownership. These two were found by the audit and by
  reading a tooltip against the code; a sweep of all of `TraitStats` is its own
  spec.
- Giving `note` to any other label. One mechanic needed it; a second caller can
  add one when a second mechanic does.
- The `tone` a `whole` grant is drawn in. It is `effect`, like `grantsPrepared`
  and the other flags, rather than `note` — changing that moves every flag line
  in the game.
