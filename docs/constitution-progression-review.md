# The Constitution track: a review

*Reviewed at spec 269 / `main` @ 1cd0734. Every number below is measured, not
read off a table: `npx tsx scripts/probe-constitution.ts` prints all of them,
`npm run audit:progression -- --all` prints the per-tier verdicts, and
`npm run balance` prints the twelve-build comparison quoted at the end.*

## Verdict in one paragraph

Constitution is **mechanically sound**. All nine of its nodes reach something
the sim reads; `npm run audit:progression` returns 17 findings and not one of
them is on this track (they are all Intelligence's `int.shaping`); and the six
mechanics compose into a genuine attrition engine rather than a pile of
percentages. What is wrong with it is not the mechanics but the **gap between
what the sheet promises and what a player gets**: its headline defensive
purchase — guard regeneration — is silently zero on any tick the body moves,
nothing in the game grants the trait that would turn it back on, and no tooltip
mentions movement at all.

As a build it is close to unkillable and close to harmless. At CON 60 with every
tier it survives 5.5 damage/second indefinitely where a fresh character dies to
2.5, and it kills a ravager about five times slower than Strength does. Its real
ceiling is not its own numbers: the entire track costs **71 of the 242 points a
level-60 character has**, so a "Constitution build" is really Constitution
finished at level 18 plus 171 points of something else.

---

## 1. What the track is

Six purchasable specializations and three automatic milestones, on the standard
10/25/40 and 20/35/50 thresholds.

| Node | At | Ranks | Grants | Trigger |
|---|---|---|---|---|
| Deep Reserves | CON 10 | 3 | `maxHealth +25`, `maxPoise +8` per rank | passive |
| Steady Frame | CON 10 | 3 | `poiseRegenPct +0.4` per rank | "while not casting" |
| **Steady Frame** (milestone) | CON 20 | — | `poiseRegenCalm 1` | not casting |
| Second Wind | CON 25 | 3 | `secondWindHeal +0.12` per rank | dropping below 30% health |
| Hard to Kill | CON 25 | 3 | `resoluteReduction +0.06` per rank | below 30% health |
| Sustained Effort | CON 25 | 3 | `poiseRegenStaggered +0.25` per rank | while staggered |
| **Hard to Kill** (milestone) | CON 35 | — | `resoluteBelow 0.3`, `resoluteReduction 0.2`, `staggerImmuneBelow 0.3` | below 30% health |
| Overflow Vitality | CON 40 | 1 | `overhealShieldTicks 480` | healing past full |
| **Overflow Vitality** (milestone) | CON 50 | — | `overhealShieldTicks 480` | healing past full |

Plus the automatic per-point scaling: 3.5 health, 0.55 guard, 0.0875 guard
regen/s, 0.8% armour, 0.6% healing received, and — through
`data/restoration.ts` — 1.4% desperation surge per point above the start and one
extra flask charge per 18 points.

## 2. Does it work?

**Yes, all of it.** Every trait the track grants has a live reader in the sim,
and each one was driven through the function that owns it:

```
Second Wind        health 93.4 -> 227.8 (+134.5), refire at same health -> 93.4 (consumed, correct)
Overflow Vitality  overheal 261.4 -> shield 93.4 of a 93.4 cap, for 16.0s
Hard to Kill       at 90% health resolute=false unstaggerable=false;
                   at 25% resolute=true unstaggerable=true (-38% damage)
                   a blow worth twice the whole guard on that 25% body: broke=false
Sustained Effort   staggered regen 10.31/s (75% of the base rate)
Deep Reserves      +75.0 health, +24.0 guard over the same attribute with no tiers
Steady Frame       calm regen 12.50/s -> 27.50/s
```

`npm run audit:progression` agrees: of its 17 findings, **none are on
Constitution**. Every tier at every attribute value it can be bought at moves a
number the sim reads, in the right direction, without hitting a cap. Two caps
were deliberately tuned to make that true (spec 239): `resoluteReduction` is
capped at 0.4 and the track tops out at 0.38, so the third rank of Hard to Kill
is worth its whole step rather than half of it.

It is also fully **accessible**. The character sheet builds all six tracks
generically from `data/tracks.ts` (`character-model.ts:tracksOf`), tiers are
bought through `buySpecializationTier` over the wire, and every grant is
described by the derived `describeSpecialization` rather than by authored
prose. There is no Constitution-specific UI path that could be missing.

## 3. Where the sheet lies

### The one that matters: guard regeneration is zero while moving

`sim/poise.ts:regenPoise` has three rates, and the branch order is:

```ts
if (staggered)                                   rate *= poiseRegenStaggered;
else if (moving && traits.poiseRegenMoving <= 0) rate = 0;
else if (entity.cast === null)                   rate *= 1 + poiseRegenCalm;
```

`moved` is computed in `world.ts` as *"the position changed this tick"*. So a
body that takes a single step regenerates nothing. The escape hatch is
`poiseRegenMoving`, and **nothing in the game grants it** — not a
specialization, not a milestone, not an item. The comment beside the branch
says "unless the Agility+Constitution pair says otherwise", and spec 244 deleted
the fifteen authored attribute pairs. It is a socket with nothing plugged into
it, and it is load-bearing:

```
  CON  TIERS  STILL/s   CASTING/s  MOVING/s  STAGGERED/s
  5    -      1.44      1.44       0.00      0.00
  25   -      6.38      3.19       0.00      0.00
  25   all    14.03     7.01       0.00      5.26
  60   -      12.50     6.25       0.00      0.00
  60   all    27.50     13.75      0.00      10.31
```

Two of the nine nodes buy that column: Steady Frame's three ranks at CON 10 and
its milestone at CON 20. While the body is moving **all four purchases are worth
exactly zero** — in a game whose stated thesis is that committing to a blow and
withdrawing from it is the decision everything is built on. (Steady Frame's
ranks multiply the base rate, so they do still reach the casting and staggered
branches; the CON 20 milestone lives entirely in the calm branch and reaches
nothing but standing still.)

What the player is told is worse than silence. The derived tooltip reads
`Trigger: while not casting. +120% Guard regeneration`, and the CON 20 milestone
reads *"Your poise recovers twice as fast whenever you are not committed to a
cast."* Both name casting as the only condition. Neither mentions movement. The
character sheet's own stat hint is the only place in the tree that gets it
right — *"only while standing still until something grants otherwise"* — which
says the constraint is known and was expected to be lifted.

This is the single highest-value fix on the track, and there are two honest
shapes for it:

1. **Grant `poiseRegenMoving` from somewhere.** The obvious home is Steady
   Frame's rank 1, which would make the specialization mean what its tooltip
   says. Cheap, one row, no new trait.
2. **Make movement a reduction rather than a switch.** `rate = 0` is an
   absolute; a fraction (say 0.3) would let a repositioning body recover slowly
   and keep the "standing still is a decision" premise intact.

Either way the two tooltips need the movement clause, because right now the
track's second purchase is a lie by omission.

### Smaller ones

- **Overflow Vitality's duration reads as an absolute and is a delta.** The
  CON 50 milestone says *"Healing past full becomes a shield, up to a quarter of
  your health, for 8s."* Held with the CON 40 specialization — which also grants
  480 ticks — the real duration is **16s**, as measured. The specialization's
  own derived line (`+8s Shield duration`) is honest because it is phrased as a
  delta; the milestone's authored sentence is not.
- **`attributes.ts` says Constitution does not own healing efficiency**
  (`notOwned: ['healing efficiency (Wisdom)']`), and `derived.ts:308` adds
  `linear(CON, 0.006)` straight into `healingScale`. It is small (+0.33 at
  CON 60, against Wisdom's larger share) and both `derived.ts` and the sheet
  hint call it out as *"and a little Constitution"* — but the `notOwned` row
  contradicts it, and `progression-tables.test.ts` only cross-checks `owns`
  against `owns`, never against `notOwned`. Either the row should say "most of
  healing efficiency (Wisdom)" or the term should go.
- **Two of the three Constitution presets describe deleted synergies.**
  `pair.strCon`'s premise is *"Below half health every cast is armoured"* and
  `pair.conWis`'s is *"Healing doubles below half health, and adaptation caps
  half again as high"*. Both describe authored pair bonuses that spec 244
  removed. The rows still run; their stated premise is fiction.

## 4. Do the mechanics compose or fight?

### What composes, and composes well

The sustain chain is the best-built thing on the track, and it is four systems
deep with no bespoke arithmetic anywhere in it:

1. A vitality mote restores **6% of the collector's maximum**, so Deep Reserves
   makes every mote bigger rather than making overheal rarer.
2. `healingScale` multiplies it — 1.42 at CON 60.
3. Below 40% health the **desperation surge** multiplies it again — 1.77 at
   CON 60. A mote in the window is worth 6% × 1.42 × 1.77 = **15% of maximum**.
4. What will not fit becomes a **shield** (Overflow Vitality), capped at 25% of
   maximum, and `moteHasRoom` counts that shield as somewhere for a mote to go —
   so a Constitution build at full health still collects, where every other
   build refuses.

Spec 239's fix to the overheal cascade matters here and holds: the shield takes
first and Wisdom's conversion takes the remainder, so a CON/WIS build gets both
rather than the Constitution capstone switching the Wisdom capstone off.

The cross-attribute design is also right. Strength owns stagger *power* and
Constitution owns the *pool* it is spent against, which is a real opposition
rather than two attributes buying the same thing. Measured, that pool is the
difference between a ravager breaking your guard every 3.4 blows and every 17:

```
  CON  TIERS  GUARD   SMALL_SPIDER  STALKER  SLINGER  RAVAGER
  5    -      13.8    9.2           5.5      6.9      3.4
  25   all    48.8    32.5          19.5     24.4     12.2
  60   all    68.0    45.3          27.2     34.0     17.0
```

And Hard to Kill's two halves — the damage reduction on the specialization, the
stagger immunity on the milestone — are correctly separated. Spec 239 caught the
immunity being *inferred* from the reduction, which handed three ranks of a
purchasable percentage the milestone's whole qualitative payoff. Verified still
separate: a blow worth twice the entire guard fails to break a body under 30%.

### What fights

**Second Wind is outside Constitution's own healing pipeline, and it ejects you
from Constitution's own low-health mechanics.**

`world.ts:advanceProgression` computes the comeback as
`maxHealth * secondWindHeal * healingScaleOf(statuses, tick)` — the affliction
suppression and nothing else. It does not go through `applyHealing`, so:

- it ignores `healingScale` (the 1.42 the track bought),
- it ignores the desperation surge (the 1.77 the track bought, and it fires
  inside that window by construction),
- and its overflow is discarded by `Math.min(maxHealth, …)` rather than
  becoming a shield.

The single largest heal a Constitution character ever receives is the one heal
that benefits from none of their healing investment.

Worse, it removes the condition the rest of the tier is built on. Measured at
CON 60 with three ranks, it fires at 25% health and lands at **61%** — above the
30% threshold that Hard to Kill's reduction and stagger immunity need, and above
the 40% threshold the desperation surge needs. Even one rank (12%) takes 29% to
41%, which clears both. A player who buys Second Wind and Hard to Kill at the
same threshold, for the same points, has bought a mechanic that turns the other
one off. It is bounded — Second Wind is consumed until a rest or a death, so
after it fires you spend the rest of the fight inside the resolute window — and
it cannot be declined, held, or timed.

That is a genuine design tension rather than a bug, and it is worth naming
because both nodes sit at CON 25 and compete for the same points. If the intent
is "a stance for fighting hurt", Second Wind is the odd one out at that tier.
Routing it through `applyHealing` would at least make it part of the same
economy as everything else the track buys.

**Steady Frame's stated trigger does not match its grant.** The tooltip says
"while not casting", but `poiseRegenPct` multiplies the base rate in *all three*
states — it improves the staggered rate and the casting rate too. The condition
belongs to the CON 20 milestone (`poiseRegenCalm`), not to the specialization.
The description is derived and correct about the number; the `trigger` string is
authored and wrong.

## 5. How strong is it?

### The durability curve

```
  CON  TIERS  HP      ARMOUR  EHP     POISE  POISE/s  SHIELD  RESOL  2ND WIND  HEAL x  SURGE  FLASKS
  5    -      106.0   8.0%    115.2   13.8   1.44     0.0     0%     0%        1.09    0.00   3
  25   -      176.0   24.0%   231.6   24.8   6.38     0.0     0%     0%        1.21    0.28   4
  25   15     251.0   24.0%   330.3   48.8   14.03    0.0     18%    36%       1.21    0.28   4
  40   16     303.5   36.0%   474.2   57.0   19.80    75.9    38%    36%       1.30    0.49   4
  60   -      298.5   52.0%   621.9   44.0   12.50    74.6    20%    0%        1.42    0.77   6
  60   16     373.5   52.0%   778.1   68.0   27.50    93.4    38%    36%       1.42    0.77   6
```

EHP is `maxHealth / (1 − armour)`, because health and armour are multiplicative
and neither alone says how long a body lasts. **A fully-built Constitution
character is 6.8× the effective health of a fresh one** — and that is before the
low-health layer. Below 30% health the resolute reduction stacks on armour
multiplicatively: 0.48 × 0.62 = **0.30**, i.e. 70% total damage reduction, in a
window where you also cannot be staggered at all.

Adding the layers up — arithmetic from the measured traits rather than a
measured figure — one full bar costs an attacker 545 raw damage down to the 30%
line and 376 more below it, the once-per-rest Second Wind is another 280, and a
full shield is another 195. **Roughly 1,400 points of raw damage to put down a
373-health body.**

### What that looks like in a fight

A stream of ravagers, weapon only, never moving, 60 seconds:

```
  BUILD                 HP      EHP     KILLS  TAKEN   END HP   STAGGERS  ALIVE
  fresh (CON 5)         106.0   115.2   1      119.9   0.0      1         47.8s
  CON 25, no tiers      176.0   231.6   2      120.8   106.3    0         yes
  CON 40, all tiers     303.5   474.2   2      87.4    296.4    0         yes
  CON 60, all tiers     373.5   778.1   2      44.6    373.5    0         yes
```

Two things stand out. **A fresh character dies; every Constitution build lives**
— and CON 60 with every tier ends the minute at *full health*, having taken 44.6
damage in total and been staggered zero times, because motes plus the healing
multipliers out-restore the incoming damage entirely. And **the kill count never
moves**. Two kills at CON 25 and two at CON 60. Constitution buys no offence
whatsoever, which is correct by design and is the whole cost of the track.

Under sustained pressure the picture is the same, with incoming damage per
second beside each outcome:

```
  BUILD                 1 FOE             2 FOE             4 FOE             8 FOE
  fresh (CON 5)         died 47.8s 2.5/s  died 18.5s 5.7/s  died 10.1s 10.5/s died 44.3s 2.7/s
  CON 25, all tiers     alive 2.1/s       alive 4.1/s       died 45.5s 8.3/s  alive 3.6/s
  CON 40, all tiers     alive 1.4/s       alive 3.6/s       died 95.6s 6.3/s  alive 2.9/s
  CON 60, all tiers     alive 0.6/s       alive 2.7/s       alive 5.5/s       alive 1.3/s
```

(The count is not monotone because how many of a ring of eight are actually in
*reach* is `sim/crowd.ts`'s answer rather than the probe's — the DPS column is
what makes the row comparable.) A fresh character dies to 2.5 damage/second. A
finished Constitution build survives **5.5/second indefinitely**, and reduces
what a single ravager lands from 2.5/s to 0.6/s.

### The real ceiling is the point budget, not the numbers

The whole track — CON from 5 to the hard cap of 60, plus all sixteen tiers —
costs **71 points**. A character has `6 + 4 × (level − 1)`:

| Level | Points |
|---|---|
| 15 | 62 |
| **18** | **74** |
| 20 | 82 |
| 60 | 242 |

**Constitution is finished at level 18 of 60.** Everything after that is spent
elsewhere. So the honest answer to "how strong can this build be" is that
Constitution is not a build, it is a **chassis**: 171 spare points at level 60 —
enough for a second attribute at the cap *and* its entire tier set, with a
hundred left over. A CON 60 / STR 60 character with both tier sets costs 142 of
those 242 points and still has 100 spare: unkillable *and* hitting like Pure
Strength, with change.

That is the finding a designer should act on. Constitution's problem is not that
it is weak; it is that it is **cheap and terminal**. Nothing on the track scales
past the cap, nothing rewards the 171 points that follow, and there is no
Constitution purchase at level 40 that a level-18 character has not already made.

### Why the balance harness makes it look worse than it is

`npm run balance` reports Pure Constitution near the bottom of the table: 1 kill
in 30s against Pure Strength's 5 and STR/PER's 7, 1.6 DPS, and 37.4 health lost
per kill. That row is a strawman, and the reason is in `data/presets.ts`:

```
pure.constitution  unspent=27   tiers=0    str5 agi5 int5 con60 per5 wis5
```

Every `pure.*` preset has `tierShare: 0`, so it buys **zero specializations**,
and a pure build at level 20 has 82 points for a 55-point attribute — so it
**bins 27 of them**. The harness's Constitution row is CON 60 with no tiers and
a third of its budget thrown away. All four `spend.*` presets — the rows that
exist specifically to measure buying tiers — are Strength or Strength/Perception.
**No preset in the table has ever measured a Constitution build that spends on
Constitution.**

`ABSORB%` reads 0.0 for all sixteen rows, which is consistent rather than broken:
`Pure Constitution` has the CON 50 milestone but heals for 0 over the run, so
there is never any overheal to become a shield. The one build in the table that
could form one has nothing to fill it with. A `spend.con` preset would fix both
observations at once.

## 6. Recommendations, in order

1. **Grant `poiseRegenMoving`, or make movement a reduction rather than a
   switch.** Six purchasable ranks and a milestone are worth zero to a moving
   body, and no tooltip says so. This is the fix that changes how the track
   plays.
2. **Add the movement clause to Steady Frame's tooltip and the CON 20
   milestone's `effect` string**, whichever way (1) is resolved. Fix Steady
   Frame's `trigger`, which claims a condition its grant does not have.
3. **Add a `spend.con` preset** to `data/presets.ts` so the balance table
   measures a Constitution build that buys Constitution. The spending axis is
   four Strength rows today.
4. **Route Second Wind through `applyHealing`**, so the track's largest single
   heal is subject to the healing multipliers the track sells and can overflow
   into the shield the track sells. Consider whether a comeback that ejects you
   from Hard to Kill's window belongs at the same threshold as Hard to Kill.
5. **Give the track something to buy past level 18.** It is complete at 71
   points out of 242 and has no answer to the question "what does my 40th
   Constitution point do that my 30th did not".
6. **Housekeeping.** Fix the CON 50 milestone's "for 8s" (it is a delta, and
   reads as a total); reconcile `constitution.notOwned`'s healing claim with
   `derived.ts:308`; rewrite the two preset premises that describe synergies
   spec 244 deleted.

---

*Instrument: `npx tsx scripts/probe-constitution.ts` — six sheets: the
durability curve at every value on the track with and without its tiers, a
liveness check driving each mechanic through the sim function that owns it, the
moving/still split, guard longevity against the roster, a ravager stream, and a
gauntlet. It exists because `audit:progression` asks whether a purchase moves a
number and `balance` fights presets that buy no tiers, and neither answers what
a Constitution character actually is.*
