# 276 — A magazine you can empty

## Problem

Resource is not a constraint. Spec 275 said so in its own Out of scope —
*"the crossover moves from WIS 13 to about WIS 17 as a consequence of the
baseline fix alone, and closing it properly is the later economy pass"* — and
this is that pass. Measured through `scripts/probe-resource.ts` over 150-second
fights against a durable target, the shipped economy is **bimodal**, and neither
mode is the one the design describes:

| build | mean pool | full% | starved% | skill casts/min | verdict |
|---|---|---|---|---|---|
| baseline (WIS 5) | 6% | 0 | 98 | 10 | `EMPTY` |
| INT 60 / WIS 5 | 9% | 0 | 80 | 42 (83 overdrawn) | `DRAINS` |
| WIS 25 | 94% | 73 | 0 | 42 | `STABLE` |
| WIS 40 | 98% | 94 | 0 | 46 | `FULL` |
| WIS 40 + Conservation | 99% | 100 | 0 | 46 | `FULL` |
| INT 30 / WIS 30 + tree | 99% | 100 | 0 | 65 | `FULL` |

Against the greediest legal four-skill bar. Four findings, and they are one
finding.

**Passive regeneration crosses the game's own ceiling.** The greediest bar a
player can equip drains **3.38 resource/second** — a hard ceiling, because it is
the four highest cost-per-cycle rows in the content table and a body is rooted
through its own casts. Regeneration is `0.4 + 0.2 x above(WIS)`, linear and
unbounded, so it passes that ceiling at about **WIS 21** and reaches **11.4/s at
WIS 60 — 3.4x the most the game can spend.** Past the crossover every other
resource mechanic in the design is measuring against a pool that is already
full.

**The waste is visible in the measurement.** At WIS 40, 7.40/s is available and
**2.15/s actually lands**; the rest is thrown away against a ceiling. A
purchased point of Wisdom past the crossover buys nothing at all.

**The floor is not a floor, it is a wall.** A character who has spent nothing
regenerates 0.4/s: 7.5 seconds to afford the cheapest skill in the game, 67.5
seconds to refill a 27-point pool, and — measured — 25 skill casts in 150
seconds against 118 basic attacks, with 98% of ticks unable to pay for anything
on the bar. That is not "burst, then pace yourself"; it is one opening burst and
two and a half minutes of auto-attacking. Both ends of the recovery table fail
the same way from opposite directions: INT 60 takes **260s** to refill, WIS 60
takes **2.4s**.

**Conservation is a standing discount, not a conditional one.** `Attuned` is
worth 0.20 a stack to three stacks — 60% off — and is refreshed by every
non-basic ability that connects rather than consumed by a cast, so any sustained
rotation holds three stacks permanently. It is larger than the entire attribute
curve (35%) and is what takes `WIS 40 + Conservation` to a pool that is full
100% of the time.

The rhythm the design asks for — *spend -> pressure -> run low if overly
aggressive -> fall back / recover -> spend again* — is reachable at exactly one
point on the Wisdom track and nowhere either side of it.

## Shape

**No new mechanic, no new state, no new message.** Four constants, one curve
shape, and one line at a respawn. Everything below is in the data locations that
already own it.

### Regeneration: a floor that works and a ceiling that binds

```ts
RESOURCE_REGEN_PER_SECOND = 1.0            // stats.ts, was 0.4
SCALING.wisdom.regenPer   = 0.025          // was 0.2, and linear
SCALING.wisdom.regenKnee  = 20
SCALING.wisdom.regenFalloff = 0.55
```

```ts
resourceRegen = RESOURCE_REGEN_PER_SECOND
              + softCap(above(WIS), regenPer, regenKnee, regenFalloff)
```

`softCap` rather than `linear`, and it is the same argument `scaling.ts` already
makes for `staggerPer` and `weakPointPer`: the stat is one an unbounded
specialist would stop the game being a game with, and a hard cap would make the
last twenty points worthless. Piecewise-linear, so the value at the hard cap is
still readable off two numbers.

What it produces, against the *measured* maximum legal drain for the same build
(the bar gets cheaper as Wisdom rises, so both columns move):

| WIS | regen/s | greedy drain/s | supply / demand |
|---|---|---|---|
| 5 | 1.00 | 3.38 | 30% |
| 15 | 1.25 | 3.24 | 39% |
| 25 | 1.50 | 2.37 | 63% |
| 40 | 1.71 | 2.25 | 76% |
| 60 | 2.00 | 2.13 | 94% |

The property that makes it a design rather than a number: **the ratio rises the
whole way and never reaches 1.** Every point of Wisdom is worth something, and
no amount of the attribute alone makes the greediest bar free. What closes the
last 6% is a *purchase* — which is where Conservation belongs.

`RESOURCE_REGEN_PER_SECOND` at 1.0 is measured against the same table from the
other end: an ordinary mixed bar drains 1.86/s, so a character who has spent
nothing sustains a little over half of it indefinitely and pays for the rest out
of the magazine. Recovery from zero becomes 3.0s to the cheapest skill and 27s
to a full pool, against 7.5s and 67.5s.

### Conservation: a discount the size of a specialization

```ts
wis.conservation  attunedCostPct 0.04 -> 0.02  a tier   (3 tiers: 0.06)
wis.conservation  milestone      0.08 -> 0.04            (total 0.10)
derived.ts        clamp(t.attunedCostPct, 0, 0.2 -> 0.1)
```

Halved, and the clamp halved with it so that the authored property survives
exactly: three tiers plus the milestone still sum to the ceiling, so every tier
moves the number and none of it disappears into the clamp. Three stacks are 30%
off rather than 60%.

This is a coefficient change, not a redesign. Attuned stays a standing,
refreshed, three-stack buff granted by an ability that connects; what changes is
that a specialization is worth about as much as the attribute curve beside it
instead of nearly twice as much.

### A respawn starts with a magazine

`respawn` in `server.ts` rewrites health, flask charges, the restoration meter,
statuses, activity and position, and does not name `resource` — so a player who
died with an empty pool gets up with an empty pool. Every other start of an
encounter in this game hands over a full one (`player-manager.ts` sets
`resource: stats.maxResource` on every login, unconditionally). One field, for
consistency with the rule that is already written down.

### The instrument

`scripts/probe-resource.ts` is new and is the thing this spec is decided by.
Sixteen builds x six bars, driven through the real `step()` for 150 seconds
each, reporting pool, regeneration, theoretical and measured drain, restoration
**split by source**, minimum pool, time to first empty, mean pool, time at the
ceiling, time starved, time ready-but-unaffordable, skill casts, basic-attack
fallbacks and overdraws — and classifying each row `FULL` / `STABLE` /
`OSCILLATES` / `DRAINS` / `EMPTY`.

Two things in it are the reason it can be believed. The theoretical ceiling is
computed over **wind-up plus cooldown**, because `advanceCast` stamps
`nextReadyTick` at the *release*: a ceiling read off `intervalTicks` alone
overstates every row by its own wind-up, 12% on the greediest bar, which is
exactly the headroom a tuning pass would then spend. And the greediest bar is
**derived from the content table** rather than chosen, so the ceiling moves when
`data/abilities.ts` does and no tuning is fitted to one hand-picked worst case.

## Invariants tested

**Baseline**

- A fresh character's pool initializes to `maxResource` and regenerates at
  exactly `RESOURCE_REGEN_PER_SECOND`.
- Regeneration never carries the pool past `maxResource`.
- A cast whose cost exceeds the pool is refused (`notEnoughResource`) for a body
  with no Arcane Overflow.
- A basic attack is castable at exactly zero resource.
- A respawned body comes back with a full pool.

**Intelligence owns capacity**

- `maxResource` rises with Intelligence and does not move with Wisdom at any
  value.
- `resourceRegen` does not move with Intelligence at any value.
- Higher Intelligence delivers strictly more casts before the first empty, and
  strictly more seconds to refill from zero.

**Wisdom owns the reload**

- `resourceRegen` is exactly `RESOURCE_REGEN_PER_SECOND` at
  `WIS = startingAttribute`, and strictly monotonic across the whole range.
- The curve is soft-capped: the marginal point past the knee is worth
  `regenFalloff` of the point before it.
- **At every legal Wisdom value with no resource specialization, regeneration is
  strictly below the maximum legal drain** — measured through `resourceCostFor`
  and `attackTimingFor` over the four greediest equippable rows, so it is a
  property of the content table rather than a number in the test.

**Costs**

- `resourceCostScale` respects its floor and cannot go negative or below it.
- A zero-cost ability stays zero-cost under every discount.
- The composite floor inside `resourceCostFor` is not reachable by legal
  progression (a guard, not a ceiling the tree is priced against).

**Conservation / Attuned**

- Three tiers plus the milestone reach the clamp exactly, and every tier moves
  the resolved cost of a real ability.
- A basic attack grants no stack; a non-basic ability that connects does.
- Stacks cap at `attunedMaxStacks` and expire after `attunedTicks`.
- With Conservation fully bought, the greediest bar is still measurably
  expensive: the resolved cost of an ability never falls below half its authored
  cost from Attuned alone.

**Cooldown and resource interact**

- Composure and Mastery lower a resolved cooldown and leave `resourceCostFor`
  untouched — asserted directly, because "cooldown reduction must not secretly
  reduce cost" is the rule the design turns on.
- A build holding Composure and Mastery has a strictly higher theoretical drain
  than the same build without them.

**Overdraw**

- The pool is spent to zero first and only the deficit is billed to health.
- The bill is refused when it exceeds the health fraction, and the write floors
  at 1, so a cast cannot be lethal.
- Wisdom's efficiency reduces the deficit for the same ability and pool.
- A withdrawn wind-up refunds what was actually paid, in both currencies, and
  cannot refund past either ceiling.

**Long run**

- Over a 150-second fight against a durable target with the greediest bar: the
  baseline build reaches zero; a moderate-Wisdom build lasts materially longer;
  a high-Intelligence build spends more before its first empty; and **no build
  with no resource specialization sits above 85% of its pool for the whole
  fight.**

## Out of scope

- **The progression-point faucet.** No change to points per level, attribute or
  tier cost, caps, or thresholds, and no new node is added to consume points.
  That is the next pass.
- **The six track designs.** Every change here is a coefficient in
  `data/scaling.ts`, `player/stats.ts` or a `traits` grant. No specialization is
  replaced, no stat identity is introduced, and no pair synergy is restored.
- **Authored ability costs.** Every row in `data/abilities.ts` keeps its cost.
  The drain table is reported so a later content pass can read it; Poison Dart
  is the visible outlier at 1.25/s against a table median of 0.46/s and is left
  alone, because its own row says it is the one skill meant to be thrown
  repeatedly.
- **The restoration-meter and mote economy.** Measured and reported rather than
  retuned: a Focus mote restores `0.2 x maxResource`, so in a kill-rich fight it
  supplies 3.5/s to an Intelligence build against 0.8/s to a baseline one, which
  inverts Intelligence's "poor reload" identity in exactly the encounter where
  it should be weakest. It is a fraction of the pool rather than a flat amount,
  and changing that is a change to the drop economy with its own decisions.
- **New recovery machinery.** No regeneration delay after casting, no
  in-combat/out-of-combat regeneration modes, no exhaustion status and no
  lockout. The existing model produces a healthy economy once its curve is
  bounded, and the simple model is preferable while it works.
- **Perception's weak-point restoration semantics.** `weakPointResource` is 6
  per weak-point hit and `resolveBlow` runs per target, so an area ability
  hitting six bodies pays six times. Measured here (1.03/s single-target in a
  kill-rich fight) and reported; bounding the multi-hit case is a change to
  trigger semantics and belongs with Perception.
