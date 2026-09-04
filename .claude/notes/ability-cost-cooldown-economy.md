# Ability cost & cooldown economy, and Wisdom's reach into it

> **UPDATED AGAIN BY SPEC 276.** The cost and cooldown *pipelines* below are
> unchanged and still correct. Three numbers in them are not: base regeneration
> is 1.0/s, Wisdom's regeneration term is soft-capped
> (`softCap(above(WIS), 0.025, 20, 0.55)`, so 1.98/s at the cap rather than
> 11.4), and `attunedCostPct` is capped at 0.1 with Conservation's tiers and
> milestone halved to match -- three Attuned stacks are 30% off, not 60%. The
> crossover this note computes at "WIS 13, then about 17" **no longer exists**:
> regeneration is now provably below the greediest legal bar's drain at every
> Wisdom value, asserted in `sim/resource-economy.test.ts` against the content
> table rather than against a number.

> **UPDATED BY SPEC 274.** The cooldown pipeline described here is unchanged and
> still correct, including the finding that spec 250 split `COOLDOWN_BOUNDS`
> from the attack-interval clamp. What changed: `cooldownReduction` is no longer
> granted by nothing -- Composure grants 0.05 a tier -- and `cooldownScaleFor`
> gained a per-ability Mastery term. The resource arithmetic still holds, with
> regeneration now measured from `above(WIS)` and the pool no longer scaling
> with Wisdom at all, which moves the crossover from WIS 13 to about WIS 17.


Traced 2026-09-03 against current `main`-merged state (branch
`claude/wisdom-progression-review-wfedgz`, up to date with origin/main).
Verified numerically via a throwaway `tsx` probe importing the real
`computeEffectiveStats`/`attackTimingFor`/`resourceCostFor` — not hand
arithmetic. Re-read source before trusting line numbers for edits.

## Cooldown pipeline

`src/server/sim/abilities.ts:190-239` `attackTimingFor(ability, entity, tick)`
is the one place. Two branches:

- **`basicAttack` abilities** (`melee.slash`, `ranged.shot`, `ranged.star`,
  `ranged.ember`): interval comes from `entity.stats.baseAttackTimeTicks`
  (the weapon/BAT stat). **`ability.cooldownTicks` is never read for these** —
  confirmed by direct probe: all four report the same 1.2s interval
  (`BASE_ATTACK_TIME_TICKS`) regardless of their differing authored
  `cooldownTicks` (0.6/1/0.7/1s), and regardless of Wisdom. Wisdom's
  `cooldownScale` never touches a basic attack.
- **Everything else** (the flask + all `skill: true` rows + the Warden's
  channel): `abilities.ts:203`:
  `baseAttackTimeTicks: ability.cooldownTicks * cooldownScaleFor(ability, entity, tick)`,
  then run through `resolveAttackTiming(..., COOLDOWN_BOUNDS)` at
  `abilities.ts:217` and `attack-timing.ts:321-367`. **Wisdom's scale is
  multiplied in BEFORE the clamp.**

`cooldownScaleFor` (`abilities.ts:359-375`) = `max(0.2, traits.cooldownScale *
handling * prepared)`, where `handling`/`prepared` are two cross-attribute
"pair" multipliers that are **currently dead** (see below) — so in practice
`cooldownScaleFor === traits.cooldownScale` for every ability in the shipped
game.

## The bug CLAUDE.md describes is fixed; CLAUDE.md's prose is stale

CLAUDE.md's `data/` section (spec-237 discussion) says non-basic cooldowns are
clamped through `MAX_ATTACK_INTERVAL_SECONDS` (5s), so "twelve of the fourteen
non-basic rows are really on a five-second cooldown." **That was true when
written and is false in the current tree.** Commit `637b210e` ("a light you
can hold, and one you can cast (spec 248)", later renumbered to spec 250 —
`e5372d29`) added `COOLDOWN_BOUNDS = { min: 0.2s, max: 300s }`
(`attack-timing.ts:172-191`) and made `attackTimingFor`'s non-basic branch
pass it explicitly instead of falling through to `ATTACK_INTERVAL_BOUNDS`
(0.2–5s). Evidence this is really wired, not just declared:

- `data/abilities.ts:945-947`, the `skill.conjureLight` comment: "spec 250
  stopped `resolveAttackTiming` clamping a spell's cooldown to a Base Attack
  Time's ceiling ... authored here before that, this row would have come back
  on five."
- `sim/abilities.test.ts:1779-1801`: asserts `skill.acidSpray`'s authored 10s
  (`cooldownTicks > MAX_ATTACK_INTERVAL_SECONDS * SERVER_TICK_RATE`) survives
  to `spellReadyAt === 1 + windupTicks + cooldownTicks` exactly — i.e. the
  clamp does **not** fire.

`MAX_ATTACK_INTERVAL_SECONDS` (5) still exists and still bounds **basic
attack** cadence only (`ATTACK_INTERVAL_BOUNDS`, `attack-timing.ts:146-147,
182-185`). It no longer touches any `skill:true` row, the flask, or the
Warden's channel.

## Wisdom's cooldownScale — the actual ceiling is ~25%, and it cannot go higher

`player/derived.ts:301-305`:
```
cooldownScale = clamp(
  reciprocal(above(WIS), S.wisdom.cooldownPer=0.006, S.wisdom.cooldownFloor=0.5)
    * reduction(t.cooldownReduction),
  0.25, 1,
)
```
`above(WIS) = max(0, WIS - 5)` (`data/scaling.ts:72-75`, `startingAttribute=5`,
`attributeHardCap=60`).

**`t.cooldownReduction` is never granted by anything in the shipped content.**
Grepped the whole tree: the only occurrences are the field declaration
(`data/modifiers.ts:189`, default 0) and the two consumer reads in
`derived.ts`. No specialization, no milestone, no item sets it. It is *not*
one of the documented "22 orphaned by the synergy removal"
(`docs/progression-model.md:198-208` lists them by name and
`cooldownReduction` is not among them) — it looks like a field authored
alongside `costReduction` (Wisdom's actually-used lever) that nothing was
ever pointed at. So `reduction(t.cooldownReduction)` is always exactly `1`,
and the whole formula collapses to the bare attribute term.

At WIS=60 (hard cap): `reciprocal(55, 0.006, 0.5) = 1/(1+0.33) = 0.75188`
(computed exactly via probe: `0.7518796992481203`) — **24.8% reduction, and
that is the ceiling.** Neither `reciprocal`'s own floor (0.5) nor the outer
clamp's floor (0.25) is reachable by anything raisable in this game today.

Two more dead levers in the same function, confirmed via
`progression-combat.test.ts:821-835` ("never refunds a cooldown, because
nothing grants preparedMastery ... this is the second of the orphaned
twenty-two") and grep:
- `traits.handlingCooldowns` (the "Ranger pair", would let Agility's
  `handlingScale` also shrink a projectile skill's cooldown) — orphaned by
  the spec-244 synergy removal, never re-granted.
- `traits.preparedMastery` (the "Archmage" INT+WIS pair, -25% cooldown on a
  Prepared cast) — same, orphaned, never re-granted.

So **Wisdom's raw attribute term is the only cooldown lever that exists in
the game**, and it tops out at a flat, un-augmentable ~25%.

## Effective cooldowns (verified via probe, not hand math)

`attackTimingFor` run against real `computeEffectiveStats` output at WIS=5
(baseline, `cooldownScale=1`) and WIS=60 (`cooldownScale=0.75188`, same at
either WIS=60 alone or WIS=60+3 tiers of `wis.discipline`, since discipline
only touches `costReduction`, not `cooldownReduction`):

| id | authored CD | CD @ WIS 5 | CD @ WIS 60 |
|---|---|---|---|
| melee.slash (basic) | 0.6s | 1.2s (BAT, ignores cooldownTicks) | 1.2s (unaffected) |
| ranged.shot (basic) | 1.0s | 1.2s | 1.2s |
| ranged.star (basic) | 0.7s | 1.2s | 1.2s |
| ranged.ember (basic) | 1.0s | 1.2s | 1.2s |
| self.hearthdraught (flask) | 12s | 12s | 9.02s |
| skill.guardBreak | 6s | 6s | 4.52s |
| skill.stunningBlow | 14s | 14s | 10.53s |
| skill.whirlwind | 9s | 9s | 6.77s |
| skill.cripplingStrike | 8s | 8s | 6.02s |
| skill.poisonDart | 2s | 2s | 1.5s |
| skill.emberToss | 8s | 8s | 6.02s |
| skill.rendingCut | 7s | 7s | 5.27s |
| skill.acidSpray | 10s | 10s | 7.52s |
| skill.arcLash | 9s | 9s | 6.77s |
| skill.rimeTouch | 11s | 11s | 8.27s |
| skill.blight | 12s | 12s | 9.02s |
| skill.scorchedEarth | 24s | 24s | 18.05s |
| skill.conjureLight | 20s | 20s | 15.03s |
| warden.laser (monster-only channel) | 9s | n/a — monster traits, no WIS | n/a |

Character sheet shows this as "Cooldowns: -X%"
(`render/iso3d/world/character-model.ts:301-305`,
`1 - traits.cooldownScale`), so at hard-cap WIS it reads "-25%".

## Resource cost pipeline

`sim/abilities.ts:391-411` `resourceCostFor`:
```
cost * traits.resourceCostScale * discount * premium
```
- `resourceCostScale` (`derived.ts:296-300`) = `clamp(reciprocal(above(WIS),
  0.01, floor 0.4) * reduction(t.costReduction), 0.2, 1)`. **This is the one
  Wisdom lever that a specialization actually reaches**: `wis.discipline`
  (`data/specializations.ts:275-277`, 3 tiers, `costReduction: 0.06`/tier,
  max 0.18) is the only grant of `costReduction` anywhere in the tree.
  - WIS=5: `resourceCostScale = 1.0` exactly (no discipline reachable below
    WIS 10).
  - WIS=60, no discipline: `0.6452`.
  - WIS=60 + discipline x3 (max): `0.5290` (verified).
- `discount` = Attuned/Flow stacks, capped combined at 0.75 off, floored at
  0.1 of original cost (combat-status-driven, not Wisdom).
- `premium` = `1 + shapingCostPct` for a "shaped" ability (has `radius`,
  `projectile`, or `area`); INT-milestone-gated, ~10% base. Independent of
  Wisdom.
- **Health/guard costs are NOT scaled by anything.** `extraCostsFor`
  (`abilities.ts:528-541`), explicit comment: "Unlike the pool cost this is
  not scaled by anything. Wisdom buys efficiency with mana; it has never
  bought cheaper blood." Refused outright rather than clamped if unaffordable.
  Only `skill.guardBreak` authors one (`costs: { poise: 4 }`); no row authors
  `costs.health`.

Cost is spent in `startCast` (`abilities.ts:566-765`): resource at
`entity.resource - cost` (line ~718), health/poise at lines ~724-731, all
refunded whole by `cancelCast` on a withdrawal from the wind-up.

## Resource pool and regen (player/stats.ts:130-136, 291-301)

```
maxResource   = 20 + 2*INT + 1*WIS + bonus.maxResource      (raw INT/WIS, not above())
resourceRegen = (2 + 0.12*WIS)/60 per tick + bonus.resourceRegen
```
Verified (holding INT=5):
- WIS=5: maxResource=35, regen=2.6/s.
- WIS=60: maxResource=90, regen=9.2/s.

## Is resource ever binding? — arithmetic

For every ability, compare "time for passive regen to refill its (Wisdom-
scaled) cost" against its own (Wisdom-scaled) cooldown. At WIS=5 (least
favorable case) the ratio (cooldown / regen-time-for-cost) ranges from **1.73x
(poisonDart, the row explicitly designed to be spammed) to 13x
(conjureLight)** — cooldown always the tighter gate for a single ability
repeated on its own cadence. At WIS=60+discipline the ratio widens to
**8.7x–65x**, because `resourceCostScale` (→0.53) falls faster than
`cooldownScale` (→0.75) while regen triples independently (2.6→9.2/s) — so
Wisdom investment makes resource *less* relevant as a constraint, not more.

**The one place resource can actually bind**: an aggressive rotation weaving
several short-cooldown/high-cost skills at once. Example at WIS=5: casting
poisonDart(3/2s=1.5/s) + whirlwind(9/9s=1.0/s) + arcLash(6/9s=0.667/s) on
cooldown forever demands 3.17 resource/s against 2.6/s regen — **unsustainable,
genuinely resource-gated**. The same rotation at WIS=60+discipline needs
combined drain scaled by `(resourceCostScale/cooldownScale) = 0.53/0.75 =
0.70` against a regen scaled by `9.2/2.6 = 3.54` — roughly a fifth the
relative pressure, comfortably sustainable. So Wisdom's pool/regen growth is
solving a real (if narrow) problem: multi-skill spam at low investment;
it is not needed for any single ability's own cadence at any investment level.

## Dead fields worth knowing about elsewhere in this economy

- `t.cooldownReduction` — dead (this doc's main finding; not in the
  documented 22).
- `t.handlingCooldowns`, `t.preparedMastery` — dead, and *documented* dead
  (`docs/progression-model.md:198-208`, the 22 fields orphaned by spec 244's
  removal of `data/synergies.ts`).
- `t.breakCooldownRefund` — also in that list of 22 (Strength's "a poise
  break refunds cooldown" — `sim/blow.ts:437-441` still consumes it, nothing
  grants it).

`npx tsx scripts/audit-progression.ts --all` is the standing instrument for
this class of question (per specialization tier, whether it reaches anything)
but it only iterates *specializations* — a field like `cooldownReduction`
that no specialization row ever names is invisible to it too, which is why it
took a targeted grep rather than the audit tool to find this one.

---

## 2026-09-04 addendum: full resource-cost ability audit (branch `integration`)

Traced fresh against `integration` (not `main`) for a "every ability with a
nonzero `cost`, and its max drain rate" audit. Two findings this session made
that the sections above do not have, plus a line-number staleness warning.

**Line numbers above have drifted.** `resourceCostFor` is now at
`sim/abilities.ts:458-478` (not `391-411`), `cooldownScaleFor` at `:386-403`
(not `359-375`), `attackTimingFor` at `:191-240` (not `190-239`), `startCast`
at `:633-849` (not `566-765`). The content between old and new positions is a
**fourth term** in `cooldownScaleFor` that didn't exist when this note's body
was written: `masteryReliefFor` (`:418-432`) — Wisdom's Mastery, `mastery:<id>`
stacks earned per-ability at the commit in `advanceCast` (`:1544-1549`), each
worth `traits.masteryCooldownPct` off *that ability's* cooldown, capped at
`traits.masteryMaxStacks`. `cooldownScaleFor` is now `max(0.2, cooldownScale *
handling * prepared * (1 - masteryRelief))` (`:402`), not the three-term
version quoted above.

**`costReduction` is now orphaned; `cooldownReduction` (fixed by this note's
own banner) is not the only dead lever any more — the cost side has the same
shape of bug the cooldown side used to have.** `wis.discipline` (which this
note's body cites as granting `costReduction: 0.06`/tier) **no longer
exists**. `data/specializations.ts:420-430` and `data/milestones.ts:281-304`
record the rename: Conservation moved to Wisdom's T1 milestone slot and now
grants `attunedCostPct` (Attuned stacking) instead, and "Resource Discipline"
(the old T1 specialization) was deleted outright — its own comment says why:
"three tiers of passive cost reduction on an economy that closes at WIS 13 was
the clearest example of the branch spending points on a solved problem."
Composure took its *name slot* in the cooldown story but grants
`cooldownReduction`, not `costReduction`. Grepped the whole of `src/server`
for `costReduction`: the only hits are the field declaration/default
(`data/modifiers.ts:217,409`, default 0) and the consumer
(`player/derived.ts:319`) — **nothing grants it**. So today,
`reduction(t.costReduction)` (`derived.ts:39-41`, `1 - clamp(total,0,0.9)`) is
always exactly `1` for every character, and `resourceCostScale` collapses to
the bare Wisdom reciprocal term.

That matters for the floor question. `resourceCostScale = clamp(reciprocal(
above(WIS), S.wisdom.costPer=0.01, S.wisdom.costFloor=0.4) *
reduction(t.costReduction), 0.2, 1)` (`derived.ts:318-322`,
`scaling.ts:465-466`). With `reduction(...)` pinned at 1 and
`attributeHardCap=60` / `startingAttribute=5` (`scaling.ts:102-103`), the
reciprocal term's own floor (0.4) and the outer clamp's floor (0.2) are **both
unreachable by any attainable character today**: at WIS 60,
`above(WIS)=55`, `reciprocal = 1/(1+0.55) = 0.6452` — the actual, currently-
reachable minimum `resourceCostScale`, well above either coded floor. Same
shape as this note's original finding about `cooldownReduction` pre-Composure
("neither floor is reachable by anything raisable in this game today") — it
just moved to the other currency.

**Cooldown vs. wind-up as the real per-ability cast-rate limiter.** For a
`skill: true` (non-`basicAttack`) ability, `nextReadyTick` (`sim/abilities.ts:
503-510`) stamps the cooldown from the **release** tick
(`releasedAt + cast.timing.intervalTicks`), and the release only happens
`windupTicks` after the commit. None of the 13 resource-costing rows author a
`backswingTicks` (that field is basic-attack-only by convention), so
`endTickFor` (`:858-865`) returns `releaseTick` unmodified and the cast frees
the caster the instant it resolves. So the true minimum commit-to-commit
period for spamming one skill on cooldown is **windup + cooldown**, not
cooldown alone — the cooldown timer simply hasn't started yet for the
`windupTicks` the cast spends winding up. Verified this is not a rounding
trick: `startCast` (`:750`) and `advanceCast`'s commit block (`:1575`) confirm
the cooldown map write happens once, at the attack point, off `tick`
(the release tick), never off the commit tick. Table (authored, unmodified —
`traits.cooldownScale`/`resourceCostScale` = 1 baseline, confirmed
`NEUTRAL_TRAITS` at `derived.ts:132-133`):

| ability | cost | windup | cooldown | effective cycle (windup+CD) | max drain (cost / cycle) | naive (cost / CD only) |
|---|---:|---:|---:|---:|---:|---:|
| skill.poisonDart | 3 | 0.4s | 2.0s | 2.4s | **1.250/s** | 1.500/s |
| skill.whirlwind | 9 | 0.7s | 9.0s | 9.7s | 0.928/s | 1.000/s |
| skill.arcLash | 6 | 0.55s | 9.0s | 9.55s | 0.628/s | 0.667/s |
| skill.emberToss | 5 | 0.7s | 8.0s | 8.7s | 0.575/s | 0.625/s |
| skill.acidSpray | 6 | 0.6s | 10.0s | 10.6s | 0.566/s | 0.600/s |
| skill.cripplingStrike | 4 | 0.3s | 8.0s | 8.3s | 0.482/s | 0.500/s |
| skill.guardBreak | 3 | 0.4s | 6.0s | 6.4s | 0.469/s | 0.500/s |
| skill.rimeTouch | 5 | 0.6s | 11.0s | 11.6s | 0.431/s | 0.455/s |
| skill.blight | 6 | 1.0s | 12.0s | 13.0s | 0.462/s | 0.500/s |
| skill.rendingCut | 3 | 0.45s | 7.0s | 7.45s | 0.403/s | 0.429/s |
| skill.stunningBlow | 6 | 0.9s | 14.0s | 14.9s | 0.403/s | 0.429/s |
| skill.scorchedEarth | 7 | 0.6s | 24.0s | 24.6s | 0.285/s | 0.292/s |
| skill.conjureLight | 4 | 0.5s | 20.0s | 20.5s | 0.195/s | 0.200/s |

The gap between the two rightmost columns is exactly the wind-up's share of
the cycle, and is largest (proportionally) for `poisonDart` (the row
explicitly authored "you are *meant* to throw repeatedly") — the naive
cooldown-only figure overstates its sustainable drain by 20%.

**Reachability.** All 13 have a `slot: 'skill'` sigil item naming their
`activeSkillId` (`data/items.ts:465-609`), and all 13 sigils appear in either
a loot table (`data/loot.ts`, 11 of them) or vendor stock (`data/vendors.ts`,
the other 2: `sigil.guardBreak`, `sigil.witchlight`) — genuinely obtainable in
normal play, not admin-only. The 14th `skill: true` row, `skill.testStatuses`
(cost 0, excluded from the table above), has a sigil too
(`sigil.testStatuses`, `items.ts:617-625`) but it is explicitly **not** in
either loot or vendor tables — `admin:giveItem` only, per its own comment.

**The flask (`self.hearthdraught`) costs 0 resource, deliberately**
(`data/abilities.ts:616-618`, comment: "Free of resource on purpose: a
fallback that cost mana would be no fallback at all for the build most likely
to be out of it"). It spends `chargeCost: 1` (`:619`) out of
`fallbackCharges`, a separate currency from the resource pool, checked/spent
alongside cost, health and poise in `startCast` (`sim/abilities.ts:683-686`
check, `:786` spend) and refunded the same way on `cancelWindup` (`:1146-1149`).
