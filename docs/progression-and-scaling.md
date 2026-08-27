# Progression and scaling

The rules progression and combat-scaling work is decided against, and the
answers to the four questions that had no written answer before specs 231-234.
Everything here is **Implemented** unless a heading says otherwise; where a
section records a decision that is arguable, it says so rather than presenting
it as obvious.

Its companions: `mechanics-vocabulary.md` is how a mechanic is *described*, and
`reward-philosophy.md` is what a reward is *for*. This is what a number is
allowed to do.

---

## Part 1 — What an ability scales with

### 1.1 The rule

**Every ability declares its own scaling, and an ability that declares nothing
scales with nothing.**

Before spec 231 there was no declaration and no need for one, because there was
one answer: `resolveBlow` computed a non-basic blow as
`ability.damage * spellPower`, and `spellPower` is a function of Intelligence.
So Whirlwind — *one turn, all the way round, blade out* — got stronger because a
player invested in Intelligence, and no field on any row could say otherwise.

A row now authors any combination of three things:

```ts
readonly scaling?: {
  readonly strength?: ScalingGrade;      // None | E | D | C | B | A | S
  readonly agility?: ScalingGrade;
  readonly intelligence?: ScalingGrade;
  readonly weapon?: number;              // 0..1 of the equipped weapon's own damage
};
```

**Constitution, Perception and Wisdom are absent by construction.** The type
names three attributes, so a row cannot author a Wisdom damage grade even by
accident. Those three reach abilities through the mechanics they already own —
crit chance, weak points, cost, adaptation, healing — and turning them into
generic damage stats is a design change nobody has asked for.

### 1.2 One coefficient language

The ladder, the letters, the clamp, the per-point rate and what a grade is worth
are all `data/weapon-scaling.ts`'s and `SCALING.weaponScaling`'s, shared with
weapons. **An `A` on Whirlwind and an `A` on a sword buy the same damage per
point of Strength.** A second ladder for abilities would be a second answer to
what an `S` is worth, and the whole reason spec 216 put the ladder in one place
was that there must not be one.

What abilities have of their own is `SCALING.abilityScaling`, and it is two
numbers rather than a table:

| Number | What it decides |
|---|---|
| `effectPerPoint` | What a grade is worth to an ability's **non-damage** effects — an affliction's pulse, a slow's bite, a field's linger. A different currency from damage, so a different rate. |
| `coefficientBudget` | What an ability's own letters may add up to. A shade over the ladder's best single grade, so a hybrid can carry a real second letter, and paid for by the cooldown and cost a basic attack does not have. |

### 1.3 The evaluation order

**Current rule.** A blow's base number is **three addends, summed once**, and
nothing below that point is an offensive source:

```
base = ability.damage                    the row's own flat number
     + abilityAttributeBonus(...)        its declared STR/AGI/INT letters
     + weaponRoll * weaponFactor         the fraction of the weapon it is

then, in order, all multiplicative:
     crit -> weak point -> exploit -> catalysis -> exposure -> execute
     -> armour -> adaptation -> resolve -> reads -> flow
     -> shield -> health
```

A **basic attack** is the third addend alone: `weaponFactor` is 1, the row
authors `damage: 0` and declares no letters of its own, so `base` is the
weapon's rolled range — which already carries its own attribute term, flat
bonuses and percentage.

**This is what makes double-counting structural rather than something to be
careful about.** A reviewer asking *"does Intelligence reach this twice"* has
three addends to read, not a chain of multiplications spread over two files:

- `ability.damage` is a constant on the row and is multiplied by nothing;
- the attribute term reads each attribute exactly once, at the one grade the row
  declares for it;
- the weapon term is the weapon's *whole* resolved damage, so a weapon's own
  letters live inside it and are not re-applied by the ability.

The ability's letters and its weapon's are **separate addends** for exactly that
reason. Nested, a hybrid would multiply one by the other.

### 1.4 Spell Power

**Current rule: Spell Power multiplies what Intelligence buys, and nothing
else.**

It is applied to the Intelligence contribution of an ability's scaling, so it
cannot reach a Strength ability — a `None` grade is coefficient 0, and 0 times
any multiplier is 0. Items and passives that grant it keep meaning what they
say.

**Its own Intelligence term was removed.** Intelligence already appears once, as
the attribute an `intelligence` grade is resolved against; leaving
`1 + per * Intelligence` in `spellPower` as well would make an Intelligence
ability quadratic in Intelligence, which is the double-count Part 1.3 exists to
prevent.

### 1.5 Weapon-derived scaling

An ability may say that some of its damage **is** the equipped weapon:
`{ weapon: 1 }` is the whole of it, `{ weapon: 0.6 }` is most of it. It rolls
the same range a swing rolls, through the same `rollBetween`, so an Axe Throw
scales like the axe with no special-case damage code anywhere.

A fraction rather than a flag, because the interesting case is the hybrid one —
a flurry that is mostly the bow and a little the archer — and a flag would make
the middle inexpressible.

**Ability grades are not shifted by `scalingModifiers`.** Those are authored as
*weapon* scaling steps: a ring that raises what your weapon scales with. Letting
them reach an ability's own letters would be a second, invisible source of
ability scaling that no row could see. The weapon-derived term carries them
already, because it reads the weapon's resolved damage.

**Not yet used by any production ability.** The mode exists and is exercised by
test rows; inventing an Axe Throw to demonstrate it would be content added to
prove a feature works.

### 1.6 How afflictions inherit scaling

**Current rule: an affliction's numbers are the row's, whole. What the applier
moves is one multiplier, and that multiplier is the applying ability's own
declared scaling, snapshotted when it lands.**

`data/damage-over-time.ts` states a rate per second, a cadence and a length, and
none of the three is authorable by a skill — every Burn in the game is the same
Burn, which is what makes *step out and it goes out shortly* a sentence a player
can reason about. On top of that sits `abilityEffectPower`, which is
`1 + <the row's grades at `effectPerPoint`>`:

- a caster who has spent nothing is exactly **1**, so the table's authored
  numbers are what actually happens;
- an ability that declares no scaling is **1 forever**, so an affliction from an
  unscaled source is worth exactly what the table says;
- a martial Bleed grows with the build that threw it, and an Ember Toss's Burn
  grows with Intelligence.

Before spec 231 the multiplier was the applier's `spellPower` outright, so
**every affliction in the game was Intelligence-scaled whatever applied it** —
Rending Cut's Bleed included.

It is **snapshotted, not live**: captured into `StatusState.magnitude` when the
affliction lands, the same rule `Exposed` already followed, so an affliction is
worth what the build that landed it was worth and does not retroactively change
when that build does. The same rule covers a slow's magnitude and a field's
linger; a status effect whose row authors no magnitude carries the caster's
resolved power, and one that authors a number means that number literally.

### 1.7 No stat gating

**Current rule: scaling decides effectiveness, never permission.**

A low-Strength character may cast a Strength-scaling ability, badly. Nothing in
the ability system reads an attribute to decide whether a cast is allowed, and
`startCast`'s one ownership check is about *carrying* the skill (spec 188), not
about having built for it.

**Future direction, not implemented.** Requiring Strength for an Axe Throw may
eventually make sense. It is a separate design question, because a stat
requirement on an ability is the step that turns six attributes into six
classes, and this repo's stated aim is that unusual combinations stay
discoverable.

---

## Part 2 — Progression interaction rules

Two rules, and every progression change is reviewed against both.
`npx tsx scripts/audit-progression.ts` checks them mechanically, and
`player/progression-audit.test.ts` fails CI when one breaks.

### 2.1 Every purchased rank does something

**Every skill rank must change a value the simulation reads, at every attribute
value where that rank can legally be bought.**

*A value the simulation reads* means `EffectiveStats` or `TraitStats`. A
modifier that only moves a `ModifierTotals` field is **not** enough: that is
exactly what three skills did before spec 232, granting an improvement to a
mechanic their own milestone introduced ten to twenty-five attribute points
later, with the totals moving and `deriveTraits` gated on a different field.

Two failure shapes, and the audit tells them apart:

- **Inert** — the rank does nothing at any legal attribute value.
- **Redundant** — the rank does nothing *here*, because a milestone has already
  filled the cap it shares, though it works elsewhere.

The fix for a shared cap is **a budget, never a bigger cap**. The four sources
of `windupPoiseArmor` sum to exactly its 0.9 ceiling and the three sources of
`attunedCostPct` to exactly its 0.2 — so a fully-invested character ends where
they always did and every step on the way there is reachable.

### 2.2 Progression does not move backwards

**Increasing a stat, gaining a milestone or buying another rank must not
increase a cost, disable an effect, make another investment useless, remove
access to a mechanic, or cross a cap so the purchase does nothing.**

The exception is a trade-off the game **explicitly presents**, and there is
exactly one: Spell Shaping buys radius and range at a cost premium, says so on
its own row, and `int.efficientConstruction` exists to pay it off. No new
trade-offs were introduced by this cleanup.

Two representational rules follow, and both are about making the bad case
*unrepresentable* rather than merely absent:

- **A capability is a flag, never a number a layer reduces.** `grantsPrepared`,
  `grantsOpeningRead` and `grantsAdaptation` exist because `deriveTraits` used to
  infer each mechanic's existence from a field that skills grant as a *negative*
  delta — so buying the skill that improves Prepared is what switched Prepared
  off. Behind the flag, every number is a delta onto a base in `SCALING`.
- **A price comes from `SCALING`, and progression may only relieve it.**
  `overflowHealthPerResource` decides *whether* Arcane Overflow exists; the rate
  is the table's and the only thing that moves it is a reduction. Additively, the
  Intelligence 40 skill and the Intelligence 50 milestone both granted the rate
  and it **doubled**.

### 2.3 Two mechanics that meet must both survive

Where two investments reach the same place, the answer is a **defined order**,
never a branch. Healing past full cascades: Constitution's shield first up to its
cap, then Wisdom's conversion on the remainder, then Wisdom's salvage on what is
left. Each outlet subtracts exactly what it absorbed, so nothing is created
twice and a full shield passes the whole remainder on.

Constitution first because a shield is a buffer against the next blow and
Conversion is explicitly a valve for what would otherwise be wasted — the
skill's own words. Before spec 232 the first two were an `if / else if`, so
taking the Constitution capstone switched the Wisdom capstone off outright.

### 2.4 A skill grants what its tooltip says

A skill must not confer a qualitative mechanic its description does not mention.
Hard to Kill grants a damage reduction; the *milestone* of the same name grants
immunity to guard breaks, and those are two traits (`resoluteReduction`,
`staggerImmuneBelow`) read by two predicates (`isResolute`, `isUnstaggerable`)
because they are two promises.

---

## Part 3 — Status semantics

### 3.1 Why the tags exist

`sim/statuses.ts` is deliberately one map for everything a body remembers
between ticks — one map with one expiry rule is one place to get right. The cost
is that a Flow stack, a poison, a half-second reaction window and a per-spawner
farm-decay counter are all the same shape.

So Catalysis asked the only question the map could answer, *"is anything at all
live on this body"* — and every blow stamps `recentlyHit` and `inCombat` on what
it lands on. The Intelligence skill that rewards exploiting an affliction was
**"deal more damage to anything you have already hit once"**.

`data/status-semantics.ts` is the missing distinction. It is a table rather than
a list inside Catalysis because the question belongs to nobody in particular: a
cleanse, a resistance, a UI filter or a second skill would each ask it.

### 3.2 The tags

| Tag | Means | Members |
|---|---|---|
| `beneficial` | Works *for* the body carrying it | Flow, Momentum, Prepared, Attuned, Scorched Earth, `adapt:*` |
| `harmful` | Works *against* it | Exposed, Vulnerable, and every affliction |
| `affliction` | Harmful **and inflicted and persisting**. The Catalysis query | Sundered, Slowed, and the seven damage-over-times |
| `damageOverTime` | Pulses damage on a cadence. Implies `affliction` | Burn, Bleed, Poison, Corrosion, Shock, Frostbite, Decay |
| `bookkeeping` | An internal timed flag; never a condition, whichever way it would cut | RecentlyHit, InCombat, `secondWind.spent`, `perfectExit.spent`, `exposed.bounty`, `dmg:*`, `farm:*`, `elite:*`, `pvpKill:*` |

Five, and no more, because a category nobody queries is a category that drifts.
The dynamic families are a closed prefix table rather than a prefix heuristic,
for the reason `naming.ts` is a table: a heuristic is a second, invisible answer
that every boundary re-derives, with nowhere to write down why.

**Unclassified is not an affliction.** `tagsOf` answers `[]` for an id with no
row, so the failure mode of forgetting one is a mechanic that does not fire
rather than one that fires on everything.

### 3.3 The two arguable calls

Recorded as arguable rather than presented as obvious:

- **Vulnerable is harmful and is not an affliction.** It is a fact about what the
  target just *did* — committed an attack — so nobody inflicted it and there is
  nothing to suffer from. It is an opening, and reading an opening is
  Perception's identity.
- **Exposed is harmful and is not an affliction.** It is a *read* somebody took,
  not a wound. It already amplifies damage on its own, so counting it would have
  Perception and Intelligence double up on one "this target is marked" state
  without either table saying so.

### 3.4 Its relationship to `StatusVisual.kind`

`data/status-visuals.ts` has a two-way `boon | affliction` split, and it is
**presentation**: it decides the colour of a mark over a head and no rule in the
sim reads it. These tags are the mechanical counterpart and cover every id,
including the ones no player is shown.

They are held in step by a test rather than by convention: every `StatusVisual`
drawn as a boon must carry `beneficial`, and every one drawn as an affliction
must carry `harmful`. A mark drawn as a boon that the sim treats as harmful
would be a fight nobody can read.

---

## Part 4 — Second Wind

**Current rule.**

| Question | Answer |
|---|---|
| When is it consumed? | On the tick it fires — health at or below `secondWindBelow`, the comeback paid. `StatusId.SecondWindSpent` is applied in the same breath. |
| How is that state represented? | `StatusId.SecondWindSpent` (`secondWind.spent`), an ordinary entry in the status map, **held** rather than timed — the mirror of `Prepared`, which is banked until spent where this is spent until banked. |
| When does it reset? | **A rest, or a death.** `advanceRest` clears it beside the flask charge it returns; `respawn` clears it beside the flask it refills. Nothing else clears it. |

**Health rising is explicitly not a reset**, and that is the whole fix. The rule
it replaces re-armed Second Wind the moment the body climbed back above its
threshold — which the comeback itself does, on the same tick, because healing
12% of maximum from under 30% lands above 30%. Its twenty-second cooldown was
therefore cleared one tick after it was applied, every single time, and a
Constitution character could cycle the threshold indefinitely.

The reset boundary is the one the health economy already had rather than a new
one. Spec 156 states it: a bad run costs the momentum you had built and never
leaves you unable to start again.

**Inspectable.** It is a status, so it rides the same map every other timed
state does and `admin:triggerEvent 'status'` reaches it. It is deliberately
**not** in `STATUS_VISUALS` — it is inverted, so a mark for it would say
"something is missing" rather than "something is on you", which is the one thing
the mark row cannot express.

---

## Part 5 — Keeping it true

`npx tsx scripts/audit-progression.ts` (or `npm run audit:progression`) answers,
for every skill, at every rank, at every attribute value where that rank can be
bought: does the purchase reach the simulation? It prints four verdicts —
`ACTIVE`, `REDUNDANT`, `INERT`, `BACKWARDS` — plus what crossing each milestone
does, what raising each attribute does over its whole range, and the ability
scaling roster with each row's coefficient budget.

`player/progression-audit.test.ts` is the same thing as a gate. Exceptions are
an **explicit allowlist with a reason each**, asserted exactly in both
directions: a new inert rank fails, and so does fixing an allowlisted one
without removing its entry — so the list can only shrink by somebody deciding it
should.

What the audit **cannot** see is stated rather than papered over: it reads
resolved state, so an interference that lives in behaviour rather than in a
number is invisible to it. Spec 232's overheal fault was exactly that — both
traits were present and the bug was a branch in `applyHealing` — and it is
covered by `sim/overheal.test.ts` instead.
