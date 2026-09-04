# Perception as exploit — what spec 272 changed

The companion to `perception-progression-review.md`. That one measured three
broken links in Perception's loop; this is what closing them did, and what was
measured afterwards.

Every number below came out of the real `step` — `npm run balance:perception`
and `npm run balance`, both on this branch, 120s vs stalker at seed 1 unless
stated. The suite is green: 434 files, 8,348 tests.

## The identity

**observe → identify → expose → exploit → sustain**, and each arrow is now a
thing the sim does rather than a thing the tables describe:

| step | mechanic | state |
|---|---|---|
| observe | **Patient Read** — withhold the attack for 1.75s to bank a read | live, new |
| identify | **Weak-Point Study** + **Opening Read** — find the seam, better against a body that just committed | live, recomposed |
| expose | a weak point marks the target **for everyone** | unchanged |
| exploit | **Exploit** — a later weak point inside that mark | unchanged |
| sustain | **Resource Sense** — precision pays for the next attempt | unchanged, remeasured |

Perception still adds nothing to a blow. `SCALING_ATTRIBUTES` is untouched at
`['strength', 'agility', 'intelligence']`, and no Perception weapon or spell
scaling was added. It multiplies what another attribute supplies — which is why
the broken multipliers cost so much and why fixing them was the whole job.

## Patient Read

Replaces Steady Aim, which could not fire: its gate read `stillSinceTick` at
the instant of impact, and `startCast` stamps that field while
`advanceProgression` re-stamps it every tick a cast is live, in a pass that runs
*before* casts resolve. Measured 0 fires in 153 blows.

| | |
|---|---|
| **Name** | Patient Read (`per.patientRead`), Perception 25, three tiers |
| **Wait** | **1.75s (105 ticks)** without *committing* an attack |
| **Resets** | committing an attack. A withdrawn wind-up is a feint and keeps the read |
| **Movement** | irrelevant — never consulted |
| **Banking** | one flag on the attacker, held 8s or until spent |
| **Payoff** | +35% weak-point damage per tier (**+105%** at three) |
| **Consumed by** | a weak point, and only a weak point |
| **Basic vs ability** | identical — any eligible blow both earns and spends it |

The wait was measured, not chosen: a worn sword commits about every 66 ticks and
the longest idle gap inside a continuous fight is 29, so 105 is a little under
two whole attacks given up.

**The state is one flag, not a per-target map.** That satisfies every rule the
design asked for including the one a map gets wrong — there is exactly one read,
so switching targets banks nothing extra, and a dead target needs no cleanup
because nothing refers to it.

### What it costs and buys

| scenario | policy | casts | weak % | DPS |
|---|---|---|---|---|
| duel | continuous | 976 | 72.5% | **3.4** |
| duel | patient | 225 | 66.7% | **3.1** |
| mobile | patient | — | 84.6% | **3.4** |
| stream (kills) | continuous | 1894 | 58.2% | **4.6** |
| stream (kills) | patient | 218 | 78.1% | **5.8** |

Patience gives up **77% of its attacks** and is 9% behind in a stationary duel,
free while repositioning, and **26% ahead once kills matter** — an amplified
weak point ends a body sooner, and Resource Sense is paid per kill. Neither
policy dominates, which is what the mechanic is for. Reads banked convert at
100% (50 banked, 50 spent).

It is distinct from Intelligence's Prepared by construction: that one reads
`stillSinceTick` and dies to movement, this one reads `lastAttackTick` and does
not.

## Ability weak points

`abilityWeakPoints` was a character trait granted by nothing, so every equipped
sigil switched the loop off. Eligibility now lives on the **ability row** as a
numeric factor, because which blows can find a seam is a fact about the blow.

```ts
precisionOf(a) = a.precision ?? (a.basicAttack ? 1 : 0)
chance = (base + (1 - base) × openingReadFactor) × precision
```

| ability | precision | why |
|---|---|---|
| the four basic attacks | **1.0** | implicit |
| `skill.cripplingStrike`, `skill.poisonDart`, `skill.rendingCut` | **1.0** | precise, placed, single-target |
| `skill.guardBreak`, `skill.stunningBlow` | **0.6** | single-target, but a committed heavy strike |
| everything else | **0** | reaches more than one body |

**Factor, not boolean** — a graded band is the only reason to have a number, and
a placed cut and a shoulder into a guard should not read the same.

**Multi-hit rule: one roll per target hit**, which is the existing hit model —
`resolveBlow` runs once per body. The safety is structural rather than a cap:
every eligible skill is `targeting: 'unit'`, so it lands through `landOnTarget`
and resolves exactly one blow. Measured **WP/CAST max = 1 in all five
scenarios**, including five bodies at once.

**Where the guarantee stops, stated rather than hidden:** `melee.slash` has
authored `arcCosSq` since spec 062, so a cursor-aimed swing with no named target
is a cone and always could roll a weak point per body. That predates this spec
and is unchanged by it. What is guaranteed is that nothing added to the loop
widens it.

A sigil contributes **10–13% of weak points** in practice — live, and bounded by
its own cooldown rather than by a special rule.

## Weak-Point Study

Unchanged in role and curve: +0.04 base chance per tier.

| PER | tier 0 | 1 | 2 | 3 |
|---|---|---|---|---|
| 10 | 0.060 | 0.100 | 0.140 | 0.180 |
| 25 | 0.150 | 0.190 | 0.230 | 0.270 |
| 40 | 0.240 | 0.280 | 0.320 | 0.360 |
| 60 | 0.360 | 0.400 | 0.440 | **0.480** |

## Opening Read

Was `min(0.95, base × factor)`. Now takes a share of the **remaining**
probability:

```
opened = base + (1 - base) × openingReadFactor
```

Milestone at Perception 35 grants **0.55**; each tier +0.06; maximum **0.73**.

0.55 is calibrated against what it replaced rather than chosen round — the old
form doubled, so `0.36 × 2 = 0.72` and `0.36 + 0.64 × 0.55 = 0.712`. **0.30 was
tried first and cost Pure Perception half its kills** (51 → 22, and it stopped
surviving), because the milestone-only build is most of what a "pure" preset is.
Measuring it is what caught that.

| PER | study | read | before | after | wasted |
|---|---|---|---|---|---|
| 35 | 0 | milestone | 0.420 | 0.645 | none |
| 60 | 0 | milestone | 0.720 | 0.712 | none |
| 60 | ×3 | ×3 | **0.950** (raw 1.176) | **0.860** | none |
| max legal | ×3 | ×3 | — | **0.892** | none |

**No purchased value is lost at any legal point.** `d(chance)/d(base)` is
`1 − factor` = 0.27 > 0, so every Weak-Point Study tier still raises the final
chance with Opening Read maxed — a property of the form, asserted over the whole
legal progression rather than at sample points.

**One ceiling story.** `weakPointCap` (0.6) bounds the base; the share can only
take part of the remainder; `WEAK_POINT_CHANCE_CAP` (0.95) is a named failsafe
on a number arriving from a modifier that legal progression provably cannot
reach (0.892 max). The two contradictory ceilings are gone.

Opening Read still means only "a Vulnerable enemy is easier to read" — no
damage, no second Exposed bonus.

## Exposed, Hunter's Eye, Exploit

**Exposed** is unchanged and still a genuine target state: magnitude **0.15**,
stored on the target, read by *any* attacker. Measured in the team scenario, an
ally with **zero Perception** landed **36 blows** on a body somebody else
exposed. No party system anywhere. Its description now says whose damage it
raises — "Damage an Exposed target takes from anyone" — because a player who
does not know that cannot value the row.

**Hunter's Eye** unchanged; every tier moves it:

| tier | 0 | 1 | 2 | 3 |
|---|---|---|---|---|
| Exposed duration (PER 60) | 2.80s | 3.30s | 3.80s | **4.30s** |

Uptime is high but not automatic: 99.2% in a duel where a body is always in
front of you, **38.9%** in the kill stream where targets keep dying. There is
still value in finding more weak points.

**Exploit** unchanged, and its ordering is intact: the weak point that *creates*
Exposed does not receive it, a later one does. +25% per tier to **+75%**.

## Resource Sense — remeasured

Kept as authored. Ability integration did **not** create runaway sustain, and
the reason is structural: every eligible skill is single-target, so WP/CAST is 1
and nothing multiplies.

| build | triggers/min | resource credited | health credited | kills |
|---|---|---|---|---|
| Resource Sense only | 27.0 | 324 | 484 | 31 |
| full PER | 32.0 | 384 | 645 | 35 |
| full PER + sigil | **40.0** | 480 | 806 | 42 |
| full PER, bow | 36.5 | 438 | 827 | 44 |

Per-kill restoration is **18.4 health** — exactly the authored 12% of maximum,
not a multiple of it. **No cap, no internal cooldown, and no payoff reduction
was added.**

## Orphaned traits — final disposition

| field | state |
|---|---|
| `abilityWeakPoints` | **removed** — the ability row owns the answer now |
| `weakPointPayoffPct` | **repurposed** as `patientReadPayoffPct`, Patient Read's conditional |
| `steadyAimPct` / `steadyAimTicks` | **removed** with the mechanic |
| `flowWeakPoint` | dormant, deliberately — no AGI/PER pair restored |
| `exploitPoiseFactor` | dormant, deliberately — no STR/PER pair restored |
| `attunedFromWeakPoints` | dormant, deliberately — no PER/WIS pair restored |
| `exposedTeamResource` | dormant — testing showed no need for extra team payoff |

No content was written to reach a dead field, and no explicit pair-synergy
system was restored.

## Balance

`npm run balance`, 180s vs stalker — the twelve attribute presets, which spend
no tiers:

| build | kills before | kills after | DPS before | DPS after | weak % after |
|---|---|---|---|---|---|
| Pure Perception | 51 | **51** | 3.7 | **3.7** | 49.7% |
| AGI/PER | 26 | **37** | 4.9 | **5.9** | 47.6% |
| STR/PER | 93 | **93** | 9.9 | **10.4** | 42.7% |
| Pure Strength *(ref)* | 76 | 76 | 7.4 | 7.4 | 4.0% |

Nothing else moved. The two hybrids improved because the tiers that were being
discarded into the clamp now land.

`npm run balance:perception --scenario=stream`, 120s, real kills:

| build | pts | DPS | weak % | kills | vs pure STR |
|---|---|---|---|---|---|
| raw PER | 55 | 2.6 | 53.3% | 29 | 36% |
| full PER | 71 | 4.6 | 58.2% | 35 | 63% |
| full PER, **patient** | 71 | **5.8** | 78.1% | 33 | **79%** |
| full PER, sigil | 71 | 5.4 | 64.5% | 42 | 74% |
| full PER, bow | 71 | 6.6 | 72.3% | 44 | 90% |
| STR/PER | 129 | **12.5** | 40.0% | 69 | 171% |
| AGI/PER | 129 | 7.5 | 50.8% | 54 | 103% |
| pure STR *(ref)* | 58 | 7.3 | 4.0% | 51 | — |

The review measured pure Perception at **39%** of bare Strength's DPS. It is now
**63%** played straight and **79%** played patiently, without a point of weapon
scaling being added — the gain is entirely the repaired mechanics.

### Tuning concerns, flagged not fixed

- **The bow is no longer mandatory, but it is still better.** In a sustained
  duel the sword is now level (3.4 vs 3.3) where the review measured the bow 48%
  ahead. In kill throughput it is still 43% ahead (6.6 vs 4.6) — but that gap is
  range and time-to-kill, and it takes 13% less damage getting there. **An
  equipment question, not a Perception one.** Not touched here.
- **STR/PER at 12.5 DPS is the strongest thing measured.** It has always been;
  it is now further ahead. Perception multiplies, so it is worth most on the
  biggest base number, which is the identity working as designed — but it is the
  row to watch if anything gets retuned.
- **Perception's damage taken is high** (260 per stream run against Strength's
  0). It has no defensive layer and no stagger, and Resource Sense is what pays
  for that. Working, but it is the reason Pure Perception dies in some presets.

## The audit

`audit:progression` gained a **conditional-effect observation pass**
(`src/server/sim/observed-effects.ts`). The tier audit proves a purchase moves a
trait; Steady Aim did that in all twelve of its cells while doing nothing. This
one drives each gated mechanic through a real fight and reports whether the gate
ever opened.

```
OBSERVED      per.patientRead            x4      10 blows   -- a banked read is held when a weak point lands
OBSERVED      per.patientRead/ability    x3      7 blows    -- an eligible ability spends a banked read
OBSERVED      per.exploit                x6      13 blows   -- a weak point lands on an already-Exposed body
OBSERVED      per.resourceSense          x6      13 blows   -- a weak point returns resource
OBSERVED      per.openingRead            x512    13 blows   -- a blow lands while the target is Vulnerable
OBSERVED      int.prepared               x311    0 blows    -- stillness banks a Prepared charge
```

Complementary to spec 271's static reachability rather than a rival: that asks
whether any *content* can satisfy a gate, this asks whether the *simulation*
ever does. Steady Aim's was satisfiable by content and unsatisfiable by the tick
order.

**The false positive is the failure mode**, so each probe carries its own
scenario. That proved itself immediately — Opening Read came back NOT OBSERVED
against a training dummy, because Vulnerable is the tell a *committed attack*
leaves and a dummy never commits one. The repair was a better opponent, not a
code change.

The test that matters reconstructs Steady Aim's exact gate and requires it to be
reported unreachable, with a live control beside it so a pass that called
everything dead could not score.

## Unrelated issues found, not fixed

- `src/server/auth/auth.test.ts` → "carries the expiry forward when a live
  session is touched (spec 267)" fails intermittently in a full-suite run and
  passes 3/3 in isolation. A wall-clock flake, nothing to do with progression.
- The 17 `BACKWARDS` findings the audit reports are all `int.shaping`'s
  `shapingCostPct`, pre-existing and being handled on spec 270's branch.
