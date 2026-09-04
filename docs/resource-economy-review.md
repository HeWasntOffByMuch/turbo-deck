# The active-resource economy, reviewed and retuned

Spec 276. Every number here is measured through `scripts/probe-resource.ts`
against the real `step()`, not computed from the formulas — which is the point
of a probe rather than a spreadsheet: a spreadsheet cannot see that a body is
rooted through its own casts, that a cooldown came back while the pool was
empty, or that most of a build's regeneration was thrown away against its own
ceiling.

Kept as the measurement rather than rewritten to describe the answer, in the
register of `constitution-progression-review.md`.

---

## 1. The old economy, and why resource stopped mattering

**Supply had no ceiling to be measured against.** The greediest four-skill bar a
player can equip drains **3.38 resource/second**. That is a hard ceiling, not a
worst case somebody chose: it is the four highest cost-per-cycle rows in
`data/abilities.ts`, cast on cooldown, by a body rooted through its own casts.
Regeneration was `0.4 + 0.2 × above(WIS)` — linear, unbounded — so it passed
that ceiling at about **Wisdom 21** and reached **11.4/s at the cap, 3.4× the
most the game can spend.**

The waste was visible from the other side. At Wisdom 40, **7.40/s was available
and 2.15/s actually landed**, because the pool was at its ceiling: a purchased
point past the crossover bought nothing at all.

Measured over 150-second fights against a durable target with that bar, the
economy was **bimodal**, and neither mode is the design:

| build | mean pool | full% | starved% | skill casts/min | verdict |
|---|---|---|---|---|---|
| baseline (WIS 5) | 6% | 0 | 98 | 10 | `EMPTY` |
| INT 60 / WIS 5 | 9% | 0 | 80 | 42 (83 overdrawn) | `DRAINS` |
| WIS 25 | 94% | 73 | 0 | 42 | `STABLE` |
| WIS 40 | 98% | 94 | 0 | 46 | `FULL` |
| WIS 40 + Conservation | 99% | 100 | 0 | 46 | `FULL` |
| INT 30 / WIS 30 + tree | 99% | 100 | 0 | 65 | `FULL` |

Recovery from empty failed at both ends: **INT 60 took 260s to refill, WIS 60
took 2.4s.**

And **Conservation was a standing discount, not a conditional one.** `Attuned`
is refreshed by every non-basic ability that connects rather than consumed by a
cast, so any sustained rotation holds three stacks permanently. At 0.20 a stack
that was a permanent 60% cut — nearly twice the whole attribute curve's 35% —
and it is what took `WIS 40 + Conservation` to a pool that was full 100% of the
time.

---

## 2. The final global model

| dimension | owner | source |
|---|---|---|
| **capacity** | Intelligence, alone | `BASE_RESOURCE (20) + 1.4 × INT` |
| **passive regeneration** | Wisdom, alone | `1.0 + softCap(above(WIS), 0.025, knee 20, falloff 0.55)` |
| **cost efficiency** | Wisdom | `reciprocal(above(WIS), 0.01, floor 0.4)`, clamped `[0.2, 1]` |
| **conditional efficiency** | Conservation / Attuned | up to `0.1` a stack × 3 stacks |
| **cooldown availability** | Wisdom, Agility | Wisdom's curve, Composure, Mastery, Mobile Offense |
| **combat-earned restoration** | Strength, Perception, the meter | Brutal Reserve, Resource Sense, Focus motes |
| **substitution** | Intelligence | Arcane Overflow: health for the deficit |

**INT carries more fuel. WIS uses and restores fuel better.** Nothing else in
the game grants `maxResource` or `resourceRegen` — the `StatModifier` fields
exist and no item, specialization or milestone sets either.

### What changed

| lever | from | to |
|---|---|---|
| `RESOURCE_REGEN_PER_SECOND` | 0.4 | **1.0** |
| `SCALING.wisdom.regenPer` | 0.2, linear | **0.025, soft-capped** (`regenKnee` 20, `regenFalloff` 0.55) |
| `SCALING.wisdom.attunedCostCap` | 0.2 (a literal in `derived.ts`) | **0.1**, in `SCALING` |
| `wis.conservation` `attunedCostPct` | 0.04 / tier | **0.02 / tier** |
| Wisdom 20 milestone `attunedCostPct` | 0.08 | **0.04** |
| `respawn` | did not name `resource` | **restores the pool** |

Four constants and one field. No new mechanic, no new state, no new wire
message, no regeneration delay, no in-combat mode, no exhaustion status. Three
tiers plus the milestone still sum to the Attuned cap exactly, so every tier
moves the number and none of it disappears into the clamp.

**No ability cost changed.** Every row in `data/abilities.ts` keeps what it was
authored at.

---

## 3. The six representative bars

Reported so a tuning claim is not fitted to one loadout. Every drain is at
baseline (no attribute spent), and `duty%` is what fraction of the cooldown the
body is rooted for — a bar whose duty cycles sum past 100% cannot reach its own
ceiling.

| bar | drain/s | duty% | abilities |
|---|---|---|---|
| spam | 2.60 | 37 | poisonDart, rendingCut, guardBreak, cripplingStrike |
| mixed | 1.86 | 25 | rendingCut, cripplingStrike, emberToss, stunningBlow |
| burst | 2.08 | 25 | whirlwind, scorchedEarth, stunningBlow, blight |
| artillery | 2.05 | 23 | emberToss, acidSpray, arcLash, scorchedEarth |
| support | 1.58 | 18 | conjureLight, rimeTouch, cripplingStrike, guardBreak |
| **maxDrain** | **3.38** | 43 | poisonDart, whirlwind, arcLash, emberToss |

`maxDrain` is **derived** — the four highest cost-per-cycle equippable rows —
rather than chosen, so the ceiling moves when the content table does.

The support bar is the one the Wisdom case is judged on. A deeply invested
Wisdom build does hold it indefinitely (`FULL` at 90% mean pool), which is the
intended payoff and not a failure: on the greedy bar the same build drains. It
is not infinite *under all conditions*, which is the line the design draws.

---

## 4. Final baseline values

| build | pool | regen/s | cost × | cd × | greedy drain/s | supply/demand |
|---|---|---|---|---|---|---|
| baseline | 27 | 1.00 | 1.000 | 1.000 | 3.38 | 30% |
| WIS 15 | 27 | 1.25 | 0.909 | 0.943 | 3.24 | 39% |
| WIS 25 | 27 | 1.50 | 0.833 | 0.893 | 2.74 | 55% |
| WIS 40 | 27 | 1.71 | 0.741 | 0.826 | 2.61 | 65% |
| WIS 60 | 27 | 1.98 | 0.645 | 0.752 | 2.47 | 80% |
| INT 25 | 55 | 1.00 | 1.000 | 1.000 | 3.72 | 27% |
| INT 40 | 76 | 1.00 | 1.000 | 1.000 | 3.72 | 27% |
| INT 60 | 104 | 1.00 | 1.000 | 1.000 | 3.72 | 27% |
| INT 30 / WIS 30 | 62 | 1.57 | 0.800 | 0.870 | 2.97 | 53% |
| WIS 40 + whole tree | 27 | 1.71 | 0.741 | 0.702 | 3.22 | 53% |
| INT 30 / WIS 30 + tree | 62 | 1.57 | 0.800 | 0.739 | 3.67 | 43% |

**The ratio rises the whole way and never reaches 1.** That is a property of the
curve, asserted in `sim/resource-economy.test.ts` against the content table
rather than against a number — a cheaper ability moves what the test requires.

### Time to empty, 150s durable fight, greediest bar

| build | verdict | mean pool | starved% | first empty | skill casts/min |
|---|---|---|---|---|---|
| baseline | `DRAINS` | 8% | 81 | — | 22 |
| INT 25 | `DRAINS` | 8% | 69 | — | 22 |
| INT 60 | `DRAINS` | 12% | 77 | 40s | 42 (77 overdrawn) |
| WIS 15 | `DRAINS` | 12% | 41 | — | 26 |
| WIS 25 | `DRAINS` | 13% | 43 | — | 34 |
| WIS 40 | `OSCILLATES` | 17% | 25 | — | 39 |
| WIS 60 | `OSCILLATES` | 29% | 12 | — | 47 |
| WIS 40 + Conservation | `OSCILLATES` | 36% | 8 | — | 45 |
| WIS 40 + Composure/Mastery | `DRAINS` | 12% | 48 | — | 44 |
| WIS 40 + whole tree | `DRAINS` | 15% | 50 | — | 52 |
| INT 30 / WIS 30 | `OSCILLATES` | 17% | 28 | — | 36 |
| INT 30 / WIS 30 + tree | `DRAINS` | 16% | 49 | — | 47 |

**No build reads `FULL` on the greedy bar.** On an ordinary mixed bar the
Wisdom builds settle `STABLE` at 82–93% mean pool, which is the intended payoff:
sustain a normal rotation, be challenged by a greedy one.

---

## 5. Intelligence: burst depth, not reload

Measured over **30 seconds** — the window a magazine is actually for:

| build | pool | measured spend/s | skill casts/min | min pool |
|---|---|---|---|---|
| baseline | 27 | 1.87 | 30 | 0 |
| INT 25 | 55 | 2.79 | 36 | 0 |
| INT 40 | 76 | 3.41 | 40 | 0 |
| INT 60 | 104 | 3.63 | 44 | 25 |

Over **150 seconds** the same builds converge on 1.17–1.67/s, because the
magazine only pays once and long-run throughput is regeneration-bound. That is
the correct shape: **capacity is burst depth, regeneration is sustained rate.**

Reload, from empty:

| build | → cheapest skill | → 50% | → full |
|---|---|---|---|
| baseline | 3.0s | 13.5s | 27s |
| INT 40 | 3.3s | 38s | 76s |
| INT 60 | 3.3s | 52s | 104s |
| WIS 60 | 1.0s | 6.8s | 13.6s |
| INT 30 / WIS 30 | 1.7s | 19.8s | 39.5s |

High Intelligence is **no slower to the first cast** and much slower to full,
which is the "deeper capacity, slower percentage refill" the design asks for.

**Overdraw frequency**: `int.overflow` is granted by the Intelligence 50
milestone, so INT 60 reaches it automatically. On the greedy bar it overdraws 77
times in 150 seconds and first empties at 40s — the capstone is doing exactly
what it exists for. It cannot kill: the bill is refused above 40% of *current*
health and the write floors at 1.

---

## 6. Wisdom: reload and efficiency

| WIS | regen/s | cost × | cooldown × | greedy drain/s | sustainable casts/min (paced) |
|---|---|---|---|---|---|
| 5 | 1.00 | 1.000 | 1.000 | 3.38 | 21 |
| 15 | 1.25 | 0.909 | 0.943 | 3.24 | 26 |
| 25 | 1.50 | 0.833 | 0.893 | 2.74 | 33 |
| 40 | 1.71 | 0.741 | 0.826 | 2.61 | 38 |
| 60 | 1.98 | 0.645 | 0.752 | 2.47 | 46 |

There is no cliff. The transition from "clearly negative" to "nearly holding" is
gradual across the whole track, and at no legal value does the attribute alone
close the greedy bar.

**Conservation savings**: three Attuned stacks now take 30% off rather than 60%.
On the greedy bar at WIS 40 it moves the theoretical drain 2.61 → 2.08/s and the
verdict from `OSCILLATES` at 25% starved to `OSCILLATES` at 8% starved. It is
the purchase that closes most of the last gap, which is where the design wants
that stretch bought rather than accrued.

**Equilibrium behaviour**: a Wisdom build with the whole tree on an ordinary bar
sits `STABLE` at 89% mean pool with a minimum of 18/27 — it oscillates shallowly
and never starves. On the greedy bar the same build is `DRAINS` at 50% starved.

---

## 7. INT/WIS under three rotations

| rotation | INT 30 / WIS 30 | + the whole Wisdom tree |
|---|---|---|
| ordinary (mixed bar) | `STABLE`, 92% mean, 0% starved | `STABLE`, 85% mean, 0% starved |
| maximum drain | `OSCILLATES`, 17% mean, 28% starved | `DRAINS`, 16% mean, 49% starved |
| cooldown-heavy (greedy + Composure/Mastery) | — | `DRAINS`, theoretical demand 3.67/s against 1.57/s supply |

The strongest sustained-casting combination in the game, and still under
pressure when it is greedy. Note the direction: **adding the cooldown tree makes
it worse**, not better.

---

## 8. Cooldown reduction is resource demand

This is intentional and now measurable.

| build | theoretical drain/s (greedy bar) |
|---|---|
| WIS 40 | 2.61 |
| WIS 40 + Composure ×3 + Mastery ×3 | **4.04** (+55%) |
| WIS 40 + Composure + Mastery + Conservation | 3.22 |

Composure and Mastery lower a resolved cooldown and leave `resourceCostFor`
untouched — asserted directly, because "cooldown reduction must not secretly
reduce cost" is the rule the tension depends on.

**Ready-but-unaffordable time**, greedy bar, 150s:

| build | rdy!$ |
|---|---|
| baseline | 15% |
| INT 40 | 16% |
| AGI 40 / WIS 20 + Mobile Offense | 19% |
| WIS 25 | 6% |
| WIS 40 | 4% |
| WIS 60 | 1% |
| WIS 40 + Conservation | 0% |

Some is healthy, and the gradient is the right way round. The Agility row is the
highest in the table, which is the intended `ready, but can I pay for it?`
tension.

---

## 9. Combat-earned restoration, reported separately

Kill-rich, 150s, three respawning ravagers, greedy bar. Rates are per second.

| build | passive regen | Resource Sense | Brutal Reserve | motes | verdict |
|---|---|---|---|---|---|
| baseline | 1.00 | — | — | 1.08 | `DRAINS` |
| STR 40 + Brutal Reserve | 0.84 | — | **0.80** | 1.50 | `OSCILLATES` |
| PER 40 + Resource Sense | 0.89 | **0.93** | — | 1.63 | `OSCILLATES` |
| WIS 40 | 1.29 | — | — | 1.20 | `OSCILLATES` |
| INT 40 | 0.65 | — | — | **3.24** | `STABLE` |

**Both specialized routes work and neither is runaway.** Brutal Reserve is worth
0.80/s in a fight that is nothing but kills; Resource Sense is worth 0.93/s
single-target (1.03–1.25/s on faster bars) and takes Perception from `DRAINS` to
`OSCILLATES`. Both are comparable to the base reload — a real specialized route,
not a replacement for the economy.

**Against a durable no-kill target both go to zero** and every build still has a
functional cycle from passive regeneration alone. That is the isolation the
no-kill sheet exists for.

---

## 10. Exhaustion is playable

- Basic attacks cost nothing and stay usable at exactly zero — asserted.
- A baseline character on the greedy bar makes 22 skill casts and 115
  basic attacks per 150 seconds; it never stops acting.
- Passive recovery continues while empty, casting or not: nothing gates it.
- No punishment status was added for being empty.
- A respawn now hands over a full pool.
- Recovery from zero to the cheapest skill: **3.0s** at baseline, 1.0s at
  Wisdom 60.

**The paced control.** With half the pool held in reserve, *every* build in the
table is `STABLE` at **0% starved and 0% ready-but-unaffordable**, even on the
greediest bar. A conservative player never runs dry on any build. What greed
buys over a long fight is nothing — throughput converges on regeneration either
way — and what it costs is the reserve. The decision the design asks for is
therefore real and it is about *when*, not *whether*.

---

## 11. Player-facing information

- **Pool** — on the character sheet. Its hint said *"Intelligence, and a little
  Wisdom"*, which stopped being true at spec 275; corrected.
- **Resource regen** — **added**. The sheet showed Guard regeneration and not
  this one, so the number the whole Wisdom track buys was the only quantity in
  the game with no way to read it.
- **Ability cost** — the sheet's `-X%` row, and every ability tooltip carries its
  authored cost through `data/description.ts`.
- **Attuned** — *"Each stack reduces what your abilities cost"*, with
  `attunedCostPct` labelled in the modifier vocabulary.
- **Overdrawn** — *"That cast was paid for with health, because the resource was
  not there."*

One limit, stated rather than fixed: a tooltip shows the **authored** cost and
the sheet shows the reduction, so a player holds both halves and multiplies. A
per-character effective cost on every tooltip is a larger UI change than this
pass wanted.

---

## 12. Concerns flagged, not fixed

**Focus motes scale with the pool, which inverts Intelligence's identity.** A
Focus mote restores `0.2 × maxResource`, so in a kill-rich fight it supplies
**3.24/s to an Intelligence build against 1.08/s to a baseline one** — three
times as much, purely for having a bigger magazine. It is what takes INT 25–60
to `STABLE` in kill-rich combat where every other build oscillates, and it is
the one place *"INT owns the magazine, WIS owns the reload"* does not hold.
Changing it is a change to the drop economy's shape and interacts with the
meter, the mote-kind bias and the health orb; it belongs in a pass of its own.

**Perception's weak-point restoration is per target.** `weakPointResource` is 6
(specialization 3 + milestone 3) and `resolveBlow` runs once per target, so an
area ability hitting six bodies pays six times. Single-target it measures a
reasonable 0.93–1.25/s. Bounding the multi-hit case is a change to trigger
semantics and belongs with Perception.

**Poison Dart is the drain outlier**: 1.25/s against a table median of 0.46/s,
and it is in the greediest bar by construction. Left alone — its own row says it
is the one skill meant to be thrown repeatedly, and the ceiling it sets is the
one the whole curve is now measured against.

**Both cost floors are unreachable** by legal progression (`resourceCostScale`
bottoms at 0.645, against a reciprocal floor of 0.4 and an outer clamp of 0.2;
the Attuned/Flow composite floor of 0.1 sits under a reachable 0.7). That is the
state a guard should be in, and asserted so it stays that way.

**Still not modified, and next**: the progression-point faucet. Points per
level, attribute cost, tier cost, caps and thresholds are untouched, and no node
was added to consume the surplus.

---

## The instrument

```
npx tsx scripts/probe-resource.ts                    # every sheet
npx tsx scripts/probe-resource.ts --sheet=fight      # the core one
npx tsx scripts/probe-resource.ts --sheet=paced      # the control
npx tsx scripts/probe-resource.ts --sheet=sensitivity
npx tsx scripts/probe-resource.ts --seconds=180
```

Two things make it believable. The theoretical ceiling is computed over
**wind-up plus cooldown**, because `advanceCast` stamps `nextReadyTick` at the
*release* — read off `intervalTicks` alone it overstates every row by its own
wind-up, 12% on the greediest bar, which is exactly the headroom a tuning pass
then spends. And the greediest bar is **derived from `data/abilities.ts`**
rather than chosen, so nothing here is fitted to one hand-picked worst case.

`--sheet=sensitivity` is why these constants and not others:

| curve | WIS 5 | WIS 25 | WIS 60 | verdict |
|---|---|---|---|---|
| before spec 276 | 0.40 (12%) | 4.40 (160%) | 11.40 (462%) | supply passes the ceiling |
| flat base only | 1.00 (30%) | 1.00 (36%) | 1.00 (41%) | Wisdom barely worth buying |
| linear, gentler | 1.00 (30%) | 1.40 (51%) | 2.10 (85%) | ok |
| **shipped** | 1.00 (30%) | 1.50 (55%) | 1.98 (80%) | ok |
| higher floor (1.4) | 1.40 (41%) | 1.90 (69%) | 2.38 (96%) | ok, no room left for Conservation |
| steeper (per 0.04) | 1.00 (30%) | 1.80 (66%) | 2.57 (104%) | supply passes the ceiling |
| later knee (40) | 1.00 (30%) | 1.50 (55%) | 2.21 (89%) | ok |

Four candidates clear both hard failures. The shipped one leaves the widest gap
at the cap for a purchase to close; `linear, gentler` is the nearest alternative
and differs by two points anywhere a player would notice. The reason it is not
the shipped one is structural rather than numeric: a soft cap cannot be made to
run away by a future source of Wisdom.
