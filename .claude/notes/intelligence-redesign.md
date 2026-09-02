# Intelligence redesign (spec 270)

Implemented 2026-09-02 on `claude/intelligence-progression-review-4fh8yr`.
Published report: https://claude.ai/code/artifact/5aca043c-d401-40bc-9878-83b7cd98da46
Companion to `intelligence-progression-review.md`, which is the read that
produced it. Re-derive from the code before trusting this.

## Identity

**Glass artillery.** What Intelligence buys is *how you cast*, not more spell
damage: a stance you commit to, a chain that rewards varying what you throw,
geometry you pay resource for, and a magazine that runs out. Baseline
Intelligence still provides the power (an ability's own `intelligence` letter);
no specialization sells a flat multiplier any more.

## Prepared

| | before | after |
|---|---|---|
| setup, full investment | 0.6s | **1.95s** |
| setup, milestone only | 1.5s | 2.4s |
| wind-up while Prepared | 0.22x | 0.22x (unchanged) |
| broken by casting | yes | **no** |
| broken by | exact float position equality | movement > `stanceMoveEpsilon` (0.35 u/tick) |
| spent by a basic attack | **yes, for nothing** | no |
| buildup visible | no | `Preparing`, expiring at the prime tick |

- Own clock (`ServerEntity.stanceSinceTick`). Deliberately **not**
  `stillSinceTick`, which Perception's Steady Aim reads -- dropping the cast term
  there would have changed Perception's tree too.
- Reset by: movement past the epsilon, being hit (`blow.ts`), spending the charge
  (which restarts the interval, so one preparation buys one cast).
- Reductions are absolute seconds (`prepareTierRelief`, `prepareMilestoneRelief`),
  not fractions of the base -- as fractions they scaled with the base and any
  attempt to lengthen the stance cancelled itself.
- Floor `prepareFloorTicks` = 1.5s. Nothing in the tree reaches it.
- **Measured** (90s, unhit, `npm run balance`): 22-24 primes, 34-70% of the fight
  holding a banked stance. Contested in melee: **0 primes** -- a blow stamps the
  clock, so a caster held at 60 units never finishes one. That is the counterplay
  working, and `PLANT%` 30-84% is the tell an opponent reads.

## Resource

`maxResource = 20 + 1.4*INT + 1*WIS`; `regen = (0.4 + 0.2*above(WIS))/60` per tick.

| build | pool | regen | drain | empties in |
|---|---|---|---|---|
| Pure INT | 109 | 0.4/s | 2.38/s | **~55s** |
| INT specialized | 109 | 0.4/s | 2.48/s | ~52s |
| INT/WIS | 130 | 8.6/s | 2.11/s | never |
| Pure WIS | 87 | 11.4/s | 1.91/s | never |

Three changes: baseline regen 2.0 -> 0.4/s, `wisdom.regenPer` 0.12 -> 0.2, and
regen measured from `above(wisdom)` so the starting five buy nothing (the first
cut without that barely moved). `intelligence.resourcePer` 2 -> 1.4.

**Every non-Intelligence row of `npm run balance` is byte-identical.** Pure
Constitution's `RES x` moved 1.00 -> 0.92; nothing else changed. Pure INT's went
0.90 -> 0.41.

## Shaping / Efficient Construction

| EC tiers | relief | premium left | tier delivered |
|---|---|---|---|
| 0 | 0% | 40% | -- |
| 1 | 20% | 32% | 8pp |
| 2 | 40% | 24% | 8pp |
| 3 | 60% | 16% | 8pp |

`shapingReliefCap` = 0.6, three tiers of 0.2 reach it exactly. Every tier is worth
its whole step and **a shaped cast is never as cheap as an unshaped one**.
Geometry unchanged: +42% radius / +27% range at three Shaping tiers.

Thresholds **not** swapped. With the economy real, Shaping at INT 10 is a live
decision rather than a trap: the premium is a cost you feel, and Efficient
Construction at INT 25 pays part of it down rather than deleting it.

The rising `shapingCostPct` is declared in `INTENDED_TRADEOFFS`
(`progression-audit.ts`) rather than allowlisted in a test file -- so
`npm run audit:progression` no longer prints fifteen BACKWARDS cells at whoever
runs it.

## Arcane Potency -> Arcane Weaving

Removed: `int.potency` was +5% spell power a tier, i.e. a slower copy of
advancing the attribute, and the one row in the tree whose trigger was `passive`
and whose grant was a percentage.

`int.weaving` (T1, 3 tiers): committing a non-basic ability whose id differs from
the last one woven adds a `Weave` stack (max 3, 6s window); a repeat adds nothing
and does not refresh. Stacks raise the **magnitude of afflictions this caster
applies**, +9%/tier/stack.

- Not a damage multiplier: it reaches `applyDot`'s snapshotted magnitude only.
- Repeating does not *reset* -- the window lets it lapse instead, so one mistimed
  press is not a punishment.
- Server-authoritative: `ServerEntity.lastWovenAbilityId`, advanced at the commit.
  Nothing on the wire carries it.
- **No deviation from the brief's proposal.** Measured mean 1.10 stacks over 90s
  for the specialized build; peak 3.

## Catalysis

`appliesSundered: 0` -> `1`. `blow.ts`'s gate changed from "this was a basic
attack" (what the deleted STR/INT pair meant) to **"the target already carries an
affliction"**, read off the statuses the target had *coming in* so a blow cannot
sunder off its own application. That is Catalysis's own stated trigger, so the
row's two lines are one mechanic.

## Overdraw

Conversion unchanged in shape and now reachable: pay all the resource there is,
convert the shortfall at `overflowHealthPerResource` (2, less 25% per granting
layer -> 1.0 at full investment).

- **Cap**: 40% of *current* health, refused whole rather than partially cast.
- **Floor**: `Math.max(1, ...)` -- it can never kill the caster.
- **Presentation**: `StatusId.Overdrawn`, replicated, own glyph, own visual row.
  Needed because the write bypasses `resolveBlow`, so no `hit` event and no
  floating number -- only the same white chunk and bar kick a blow leaves.
- **Not observed in the harness** and the reason is stated in its own output: the
  spend rate is bounded by cooldowns, not by the pool, so a 90s ravager fight
  does not empty a magazine. `intelligence.test.ts` drives it directly.

## Orphaned traits still dormant

21, down from 22 (`docs/progression-model.md`). `preparedMastery` and
`spellbladeHandling` are Intelligence-facing and were **left dormant
deliberately** -- neither is needed by this design, and no fake content was
invented to reach them. `spellPowerPer` was deleted outright: nothing read it.

## Balance

`npm run balance`, 30s vs ravager:

| build | kills | dps | RES x | root% |
|---|---|---|---|---|
| Pure INT | 4 | 6.0 | 0.41 | 85.1 |
| INT specialized (new) | 6 | 7.7 | 0.66 | 83.5 |
| INT/WIS | 4 | 5.5 | 1.00 | 86.4 |
| AGI/INT | 4 | 5.1 | 0.54 | 65.8 |
| STR/PER (table best) | 7 | 10.2 | 0.00 | 75.0 |

90s, 4 targets: 2.5-2.6x the single-target damage, and **Pure INT, INT
specialized and AGI/INT all die doing it**. INT/WIS survives.

## Tuning concerns

1. `weaveEffectPct` 0.09/tier is +81% affliction magnitude at three stacks and
   three tiers. Measured mean is 1.10 stacks so the realised bonus is ~+30%, and
   the duel DPS (7.7) sits under STR/PER's 10.2 -- but this is the first number to
   revisit if Intelligence over-performs.
2. Prepared is unreachable while anything is hitting you. Correct for artillery,
   worth watching for a caster who gets caught.
3. Overdraw needs a longer fight than the harness runs to fire naturally.

## Deferred, not fixed

**Intelligence-scaling weapon availability.** `staff.emberwood` is still the only
weapon in the game with an `intelligence` grade, it is rare at level 4, and it is
in **no loot table** -- shop-only. Strength and Agility have three real grades
each. Out of scope for spec 270 (loot/shop/weapon content); named here so it can
be picked up on its own.
