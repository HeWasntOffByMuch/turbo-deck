> **SUPERSEDED IN PART BY SPEC 276.** The pipeline, the grant sites, the clamp
> sites and the starting/respawn behaviour below are all still correct, with one
> exception noted in place: `respawn` now restores the pool. What moved are the
> two numbers this note is mostly about --
> `RESOURCE_REGEN_PER_SECOND` is **1.0**, and Wisdom's term is
> **`softCap(above(WIS), 0.025, knee 20, falloff 0.55)`** rather than
> `0.2 x above(WIS)`, so the curve reads 1.00 / 1.25 / 1.50 / 1.71 / 1.98 at
> Wisdom 5 / 15 / 25 / 40 / 60 instead of 0.4 / 2.4 / 4.4 / 7.4 / 11.4.
> `SCALING.wisdom.attunedCostCap` is 0.1 and Conservation's grants halved with
> it. `scripts/probe-resource.ts` is the live instrument; treat every regen
> figure below as history.

# Active resource (ability pool): capacity and passive regen, end to end

Traced 2026-09-04 against `integration` branch (post spec 275 "Wisdom is
sustain", post spec 270 "Intelligence as artillery"). Read directly from
source, not from prior notes — `ability-cost-cooldown-economy.md`'s own
resource-formula section (§"Resource pool and regen") is now **wrong**: it
predates specs 270/275 despite its own updated banner saying otherwise.
`progression-wisdom.md`'s formula is also pre-270/275. This note supersedes
both for the capacity/regen question specifically; their cooldown-pipeline
and cost-scale sections are still accurate.

## Formula (current, verified against source)

```
maxResource   = max(0, BASE_RESOURCE + RESOURCE_PER_INTELLIGENCE * intelligence + bonus.maxResource)
              = max(0, 20 + 1.4 * intelligence + bonus.maxResource)          // raw INT, NOT above()
resourceRegen = max(0, (RESOURCE_REGEN_PER_SECOND + REGEN_PER_WISDOM * above(wisdom)) / 60 + bonus.resourceRegen)
              = max(0, (0.4 + 0.2 * max(0, wisdom - 5)) / 60 + bonus.resourceRegen)   // per TICK
```
`above(attr) = max(0, attr - SCALING.startingAttribute)`, `startingAttribute=5`,
`attributeHardCap=60` (`data/scaling.ts:72-75,102-103`).

Constants: `BASE_RESOURCE=20` (`player/stats.ts:139`),
`RESOURCE_PER_INTELLIGENCE = SCALING.intelligence.resourcePer = 1.4`
(`player/stats.ts:140`, `data/scaling.ts:241`),
`RESOURCE_REGEN_PER_SECOND=0.4` (`player/stats.ts:162`),
`REGEN_PER_WISDOM = SCALING.wisdom.regenPer = 0.2` (`player/stats.ts:164`,
`data/scaling.ts:488`). Assembled at `player/stats.ts:324-340`
(`computeEffectiveStats`).

**Wisdom no longer contributes to `maxResource` at all** (spec 275 removed
`wisdom.resourcePer`, which used to be 1). **Intelligence never touches
regen.** The split is stated in the source comment at `player/stats.ts:134-137`:
"INT owns the magazine and WIS owns making it last."

`maxResource` is measured from the **raw** attribute (not `above()`) —
`data/scaling.ts:64-70` explains why: it's one of the pre-spec-147
"quantities" (health, pool, armor, turn rate) that stay zero-based, unlike
the reciprocal *scales* (cost/cooldown/healing multipliers), which are
measured from the starting value so a fresh character is exactly 1.0x.
`resourceRegen` **is** measured through `above()`, explicitly since spec 270
(`player/stats.ts:330-336`): "a character who had spent nothing on Wisdom
still collected five points of reload" was the bug the `above()` switch fixed.

`EffectiveStats.resourceRegen` is documented "Refilled by this much every
tick" (`state/types.ts:804`) — it is a per-tick field, so `bonus.resourceRegen`
from a `StatModifier` (if anything ever granted it) is added as a per-tick
quantity, not per-second.

## Worked values

maxResource(INT): 5→27, 20→48, 35→69, 50→90, 60→104.

resourceRegen(WIS), per second (÷60 for per-tick):
5→0.4, 10→1.4, 20→3.4, 25→4.4, 35→6.4, 40→7.4, 50→9.4, 60→11.4.
(60/s matches the source's own comment at `data/scaling.ts:474`: "a Wisdom
specialist regenerates 11.4/s where they used to get 9.2/s".)

## Where regen actually runs

`sim/world.ts:1132-1138`, inside `step()`'s main per-entity pass:
```js
if (next.resource < next.stats.maxResource) {
  working.set(next.id, {
    ...next,
    resource: regenerated(next.resource, next.stats.resourceRegen, next.stats.maxResource, 1),
  });
}
```
Comment directly above it: "Resource ticks back up whenever the body is
alive, casting or not." `regenerated()` (`sim/resource.ts:15-23`) is
`min(maxResource, max(0, resource) + regenPerTick * ticks)` — pure, closed-form
(client replays the same fn to predict several ticks at once without a loop).

**No gating found beyond alive + simulated**: not `InCombat`, not resting/zone,
not staggered/poise-broken, not mid-cast, no post-cast regen delay. The only
things that skip this line are `health <= 0` (`world.ts:900-906`, `continue`
before reaching the regen line — a corpse does not regen) and
`!isSimulated(entity)` (`world.ts:908` — an off-screen monster in an inactive
chunk; players are always simulated). `advanceRest`/spec 156 resting
(`world.ts:1828-1867`) touches only `health` and `fallbackCharges` (the
flask) — grepped and read in full, it never references `resource`.

## Capacity/regen modifiers — dead sockets

`StatModifier.maxResource?: number` and `.resourceRegen?: number`
(`data/modifiers.ts:307-308`, flat, summed by `sumModifiers` with zero
defaults at `:460-461`) are the **only** two fields for this. **No item, no
specialization, no milestone grants either one** — grepped
`data/items.ts`, `data/specializations.ts`, `data/milestones.ts` for numeric
`maxResource:`/`resourceRegen:` literals: zero hits in all three. Also no
`maxResourcePct`/`resourceRegenPct` field exists at all (the "percentages,
applied after every flat addition" block at `modifiers.ts:309-313` doesn't
include either).

The only *live* way to move either number is spending/gearing the owning
attribute: +1 Intelligence is +1.4 maxResource, +1 Wisdom above 5 is +0.2/s
regen. Two items grant raw Intelligence (nothing grants raw Wisdom — grepped,
zero hits): Emberwood Staff `+3 INT` (`data/items.ts:257`, → +4.2 maxResource)
and Quartz Focus `+2 INT` (`data/items.ts:342`, → +2.8 maxResource).

Event-triggered (NOT passive) resource restoration exists on the side,
worth not confusing with regen: `weakPointResource` (Resource Sense,
`per.resourceSense`, `data/specializations.ts:415-417`, flat 3 on a
weak-point hit, read `sim/blow.ts:641`); `EXPOSED_BOUNTY.magnitude` (Tactician
bounty, `blow.ts:701`); `traits.breakResource` (poise-break reward,
`blow.ts:517-519`) — declared (`modifiers.ts:47,346`) but **granted by
nothing** in current content, same dead-socket class as `cooldownReduction`
was before spec 274; and `skill-effects.ts`'s `case 'resource'`
(`:258-262`, flat add/clamp) — no ability row currently authors
`kind: 'resource'`, so this case is unreachable too. All of these clamp via
`Math.min(maxResource, ...)`/`Math.max(0, ...)` on write.

## Starting / login / respawn

- **Brand-new character**: `newCharacter()` (`player/player-manager.ts:983-1004`)
  writes `resource: 0` into the persisted record as a sentinel (parallel to
  `health: 0`), *not* the real starting value.
- **Every login** (new or returning): `resource: stats.maxResource` is forced
  unconditionally (`player-manager.ts:355-357`, comment: "A fresh login comes
  back with a full pool; there is nothing to gain from making someone wait out
  a regen timer at the character select"). Unlike health (`record.health > 0 ?
  record.health : stats.maxHealth`), resource is **never persisted across a
  logout/login** — it's always full on connect regardless of what it was when
  the session ended.
- **Stat recalculation within a session** (gear/spec change, level-up):
  `derive()` (`player-manager.ts:474-477`) does `resource:
  clampResourceToStats(record.resource, stats)` — clamps current resource down
  if `maxResource` shrank, never refills. `clampResourceToStats`
  (`player/stats.ts:459-462`): `resource <= 0 → 0`, else `min(resource,
  maxResource)`.
- **Death → respawn** (**changed by spec 276: `resource: session.stats.maxResource` is now in the override object**): `respawn()` (`server.ts:3152-3210`) explicitly resets
  `position`, `health` (→ `maxHealth`), `fallbackCharges`, `restoration`,
  `statuses` (afflictions + `SecondWindSpent` only — boons like Flow/Attuned
  survive death), `activity`, `targetId`/path fields, `claimedPosition`,
  `pardon`. **It does not mention `resource` (or `poise`) in the override
  object at all** — confirmed by reading the whole function body. So whatever
  resource a player had *at the moment of death* is exactly what they respawn
  with; death neither refills nor drains it. (The general "full health/poise/
  resource from the first tick" line elsewhere is about freshly-`runSpawners`-
  spawned **monsters**, not player respawn — don't conflate the two.)
- **Monsters**: every row in `data/monsters.ts` authors `maxResource: 0`
  (grepped, 9 occurrences) — monsters have no ability-resource pool at all;
  the regen line is a no-op for them (`0 < 0` is false).

## Clamping / can it exceed max

Never seen a write that isn't wrapped in `Math.min(maxResource, ...)` (up) or
`Math.max(0, ...)` (down): regen (`sim/resource.ts:22`), cast cost deduction
`Math.max(0, entity.resource - cost)` (`sim/abilities.ts:785` — floored, cast
is refused outright at `:676` if unaffordable and no Arcane Overflow
available), windup-cancel refund `Math.min(maxResource, ...)`
(`sim/abilities.ts:1126-1129` — refunds *what was actually paid*, not the
row's list price, specifically clamped because "regen ticks during a wind-up
... an unclamped refund would top the pool up past its own ceiling"), Focus
mote pickup (`world.ts:2128`), `blow.ts:518,705` (breakResource/bounty),
`skill-effects.ts:261`, and the recalculation clamp above. **Arcane Overflow**
(`int.overflow` specialization, T3×1, `data/specializations.ts:277-284`,
gate: `overflowHealthPerResource > 0`) lets a cast proceed when `cost >
resource` by paying the shortfall in health instead
(`sim/abilities.ts:512-537 overflowCostFor`, capped at
`SCALING.intelligence.overflowHealthFraction=0.4` of *current* health, floored
`Math.max(1, ...)` so it's never lethal) — resource itself still floors at 0
on that path, it's the health side that absorbs the difference.
