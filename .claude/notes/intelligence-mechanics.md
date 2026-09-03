# Intelligence mechanics: Prepared Casting & Arcane Overflow

Traced end-to-end 2026-09-01. File:line refs below; re-derive only if these
functions move.

## A. Prepared Casting

**Stillness tracking** — `src/server/sim/world.ts:1618-1696` (`advanceProgression`,
called once per living entity per tick from the movement loop at `world.ts:1108`).

- `busy = moved || entity.cast !== null` (`world.ts:1627`). `moved` is computed
  at `world.ts:1050-1052` as a **strict inequality** on position
  (`outcome.position.x !== steered.position.x || ...y !== ...y`) — no epsilon,
  so *any* nonzero positional delta (including a sub-pixel ORCA/crowd nudge
  from `resolveCrowding`) resets it. Facing/turning alone does NOT set `moved`
  — only translation does.
- Camera orbit/zoom never reaches the sim at all (render-only) — no effect.
- `stillSinceTick = busy ? tick : entity.stillSinceTick` (`world.ts:1628`) — so
  while `busy`, the clock is bumped forward every tick (not reset-and-held);
  it starts counting from the tick busy-ness *ends*.
- Being hit also stamps it, independent of `busy`: `sim/blow.ts:322`
  (`stillSinceTick: tick` on the **target** inside `resolveBlow`).
- Grant: `world.ts:1630-1640` — if `!busy && traits.prepareTicks > 0 &&
  tick - stillSinceTick >= traits.prepareTicks && !hasStatus(Prepared)`, calls
  `applyStatus(statuses, StatusId.Prepared, tick, Number.MAX_SAFE_INTEGER - tick)`
  → `expiresAtTick = MAX_SAFE_INTEGER`, i.e. functionally indefinite (never
  time-expires; `applyStatus` duration semantics at `sim/statuses.ts:285-297`).

**Consumption** — NOT at cast commit. Cleared unconditionally at the **attack
point** of the *next* cast to reach it, whatever ability that cast is:
`sim/abilities.ts:1394-1400` (`advanceCast`, `if (cast.phase === Windup &&
tick >= cast.releaseTick)`): `clearStatus(caster.statuses, StatusId.Prepared)`
(and `Momentum` the same way). Gotcha: a Prepared charge is spent by a **basic
attack** reaching its attack point too, even though `windupScaleFor` never
applies `preparedWindupScale` to a basic attack (gated `!ability.basicAttack`,
`abilities.ts:289`) — so auto-attacking while Prepared silently burns the
charge for nothing. Withdrawing before the attack point (`cancelWindup`,
`abilities.ts:964-1073`) never spends it — comment at `abilities.ts:1018-1022`
states this is deliberate ("nothing is un-consumed... a wind-up that was
withdrawn from never spent them in the first place").

**Wind-up multiplication** — `sim/abilities.ts:190-239` (`attackTimingFor`)
computes `shaped = windupScaleFor(...)` once (`abilities.ts:195`), then:
- non-basic (skill/spell): `baseAttackPointTicks = ability.windupTicks * shaped`
  (`abilities.ts:204`) — **no `attackPointScale` term at all** in this branch.
- basic attack: `baseAttackPointTicks = ability.windupTicks * shaped *
  entity.stats.traits.attackPointScale` (`abilities.ts:228`).

`windupScaleFor` (`abilities.ts:267-294`) multiplies into one running `scale`:
handling (Agility, launches/spellblade) → heavy (Strength, `ability.damage >=
HEAVY_ABILITY_DAMAGE=6`) → momentum (Strength+Agility status) → **prepared**
(`scale *= traits.preparedWindupScale`, only if `!ability.basicAttack &&
hasStatus(Prepared)`, `abilities.ts:289-291`), floored at `Math.max(0.05, scale)`.

**Net interaction**: Prepared and Agility's `attackPointScale` structurally
**never multiply together** — Prepared only ever appears in the non-basic
branch (which has no `attackPointScale` term), `attackPointScale` only ever
appears in the basic-attack branch (which excludes `preparedWindupScale` via
`windupScaleFor`'s own gate). `heavyWindupScale` (Strength) **does** compound
with `preparedWindupScale` for a heavy non-basic ability, since both are
factors in the same `scale` product with no mutual gate.

**Numbers** (`data/scaling.ts:230-231`): `SCALING.intelligence.prepareTicks =
seconds(2)` = 120 ticks; `preparedWindupScale = 0.5` (halves wind-up) —
both are *base* values only in effect once the `grantsPrepared` capability
flag is held (`t.grantsPrepared > 0`, `player/derived.ts:274`); otherwise
`prepareTicks: 0` (mechanic off) and `preparedWindupScale: 1` (neutral)
(`derived.ts:393-398`, `NEUTRAL_TRAITS` at `derived.ts:95-96`).

Gated behind **either** source (both grant `grantsPrepared: 1`, deltas are
additive onto the `SCALING` base):
- specialization `int.prepared` (`data/specializations.ts:174-186`), unlocked
  at INT 25 (`SPECIALIZATION_THRESHOLDS[1]=25`, `scaling.ts:431`), 3 ranks,
  each: `prepareTicks: -round(120*0.15)=-18`, `preparedWindupScale: -0.06`.
- milestone `int.prepared` (`data/milestones.ts:146-166`), automatic at INT 35
  (`MILESTONE_THRESHOLDS[1]=35`, `scaling.ts:430`): `prepareTicks: -30`,
  `preparedWindupScale: -0.1`.
- Fully invested (3 specialization ranks + milestone): `prepareTicks = 120 -
  84 = 36` ticks = 0.6s (floor is `rate*0.25`=15 ticks, not reached);
  `preparedWindupScale = clamp(0.5-0.28, 0.2, 1) = 0.22` (78% wind-up cut).

Related: `preparedMastery` (Archmage pair, Wisdom+Intelligence) also reads
Prepared — waives the shaping-cost premium (`abilities.ts:407`) and refunds
25% off a prepared cast's cooldown (`PREPARED_COOLDOWN_REFUND=0.25`,
`abilities.ts:370-378`) — but `cooldownScaleFor` is only ever invoked for
non-basic abilities (`abilities.ts:203`), so this too never touches a basic
attack.

**Discoverability**: Fully wired to the wire/UI, unlike Overflow.
`StatusId.Prepared` has a full `StatusVisual` row —
`data/status-visuals.ts:151-161` (`wire: 2`, `name: 'Prepared'`, `icon:
'prepared'`, `maxStacks: 1`, `indefinite: true`, effect text "Shortens the
wind-up of your next ability. Does not apply to basic attacks.") and is tagged
`Beneficial` in `data/status-semantics.ts:117`. It replicates and is drawn as
an overhead status mark (`world/status-marks.ts`) and in the mini-HUD
(`selection.ts`, reads `statusMarks`). There is **no leading indicator** —
nothing shows progress toward the 2s (or reduced) stillness window; the icon
only appears the instant it is granted. The character sheet's specialization
tooltip (`describeSpecialization`, `data/description.ts:872-909`, called via
`specializationTooltip` in `render/iso3d/world/character-model.ts:335-342`)
shows a derived line for the `grantsPrepared` flag ("Standing still primes
your next ability.", from `GRANT_LABELS` at `description.ts:731`) plus derived
`-Xs Stillness needed to become Prepared.` / `-X% Wind-up while Prepared.`
lines (`description.ts:720-721`), followed by the row's authored flavour
sentence in quotes.

## B. Arcane Overflow

**Cost computation** — `sim/abilities.ts:461-470` (`overflowCostFor`):
```
bill = shortfall * traits.overflowHealthPerResource
affordable = entity.health * SCALING.intelligence.overflowHealthFraction  // 0.4, current health
return bill <= affordable ? bill : 0   // 0 = refused, not partial
```
`shortfall = cost - entity.resource` (only when positive), computed at the
`startCast` call site `abilities.ts:606-609`. If `overflow <= 0` and
`shortfall > 0`, the cast is refused with reason `'notEnoughResource'`
(`abilities.ts:609`) — Overflow does not degrade gracefully into a partial
cast; either the whole shortfall is affordable in health or the cast fails.

**Never lethal, two independent guards**:
1. `overflowCostFor`'s own cap: `bill <= 0.4 * currentHealth` (not max health
   — the whole safety property, per the doc comment at `abilities.ts:454-459`:
   a fraction of *what's left* can never take the last point).
2. A hard floor applied when the cost is actually paid, independent of (1):
   `health: overflow + extra.health > 0 ? Math.max(1, entity.health - overflow
   - extra.health) : entity.health` (`abilities.ts:722-727`). This floor is
   the *only* thing guarding against the case where a skill's own authored
   blood cost (`ability.costs.health`, checked separately and more loosely by
   `extraCostsFor` at `abilities.ts:528-541`, which only refuses at `health <=
   cost`, i.e. permits leaving health at an arbitrarily small positive amount)
   stacks with the overflow bill — `overflowCostFor`'s 40%-of-current cap is
   computed without knowing about `extra.health`, so the two can sum past
   current health; `Math.max(1, ...)` is the true backstop, floor is 1 HP.

**Resource vs. health**: pays *all* remaining resource first, then health only
for the gap — never "all health, no resource": `spentResource: Math.min(cost,
entity.resource)` (`abilities.ts:683`), `resource: Math.max(0, entity.resource
- cost)` (`abilities.ts:718`), `spentHealth: overflow + extra.health`
(`abilities.ts:687`). Withdrawing before the attack point refunds resource,
health (including the overflow portion) and poise in full
(`cancelWindup`/`abilities.ts:1042-1051`) — so a feinted overflow cast costs
nothing but time, same as an ordinary one.

Overflow is moot for basic attacks in practice: they typically author
`cost: 0`⇒`resourceCostFor` returns 0 immediately (`abilities.ts:396`)⇒
`shortfall` never positive.

**Gating and numbers** (`data/scaling.ts:227-229`):
`overflowHealthPerResource: 2` (health per point of missing resource),
`overflowHealthFraction: 0.4`. Capability is the field itself being `>0`
(no separate flag) — `player/derived.ts:416-419`:
```
overflowHealthPerResource = t.overflowHealthPerResource > 0
  ? SCALING.intelligence.overflowHealthPerResource * reduction(t.overflowCostReduction)
  : 0
```
`reduction(x) = 1 - clamp(x, 0, 0.9)`. Granted by **either**:
- specialization `int.overflow` (`data/specializations.ts:198-205`), INT 40,
  **1 rank only**: `overflowHealthPerResource: 2`, `overflowCostReduction: 0.25`.
- milestone `int.overflow` (`data/milestones.ts:167-185`), automatic INT 50:
  same two fields, same values.
Both sum (rate itself does not double, only `overflowCostReduction` sums):
neither alone → rate 2/point; either one alone → `reduction(0.25)=0.75` →
1.5/point; both → `reduction(0.5)=0.5` → 1/point (floor if both stacked
higher would be `reduction` clamped at 0.9 → rate 0.2/point, not reached here).

**Resource pool for an Intelligence build** — `player/stats.ts:130-136,
291-301` (`computeEffectiveStats`):
```
maxResource   = max(0, 20 + 2*intelligence + 1*wisdom + bonus.maxResource)
resourceRegen = max(0, (2 + 0.12*wisdom)/60 + bonus.resourceRegen)   // per tick, 60Hz
```
(`BASE_RESOURCE=20`, `RESOURCE_PER_INTELLIGENCE=SCALING.intelligence.resourcePer=2`
`data/scaling.ts:220`, `RESOURCE_PER_WISDOM=SCALING.wisdom.resourcePer=1`
`scaling.ts:280`, `RESOURCE_REGEN_PER_SECOND=2`, `REGEN_PER_WISDOM=
SCALING.wisdom.regenPer=0.12` `scaling.ts:281`). Note: unlike most other
scaling curves in this file, `intelligence`/`wisdom` are used **raw** here,
not through `above()` (measured from the starting attribute of 5) — so a
fresh character (INT 5, WIS 5) already has `maxResource = 20+10+5 = 35`.
**Intelligence buys pool size only; it does not touch regen at all** —
regen scales with Wisdom alone. A pure-Intelligence, low-Wisdom "burst" build
has a big pool that refills slowly (flat 2/s), which is exactly the profile
Arcane Overflow exists to cover for.

**Discoverability**: much weaker than Prepared. No `StatusId` exists for
"just overflowed" — it's a same-tick health/resource field write in
`startCast`, not a status, so it cannot appear in `status-visuals.ts` or
`status-marks.ts` by construction. No wire event carries an overflow flag
(`castStarted` — `abilities.ts:751-760` — has no such field). Grepped
`src/render` for `spentHealth`/`overflowHealthPerResource`/"Arcane
Overflow": **zero hits** — no dedicated VFX, sound, or HUD callout.
The one incidental tell: `HealthFlashes.read()` (`render/iso3d/world/
health-bar.ts:123-189`) compares raw replicated `health` frame-to-frame with
no regard for *why* it dropped (`current < track.health` at `health-bar.ts:144`),
so an overflow cast **does** trigger the same white-ghost-chunk flash and bar
"kick" as being struck by an enemy — but nothing labels it, and because the
health write bypasses `resolveBlow`, no `hit` event fires, so there is no
floating damage number either. On the character sheet,
`GRANT_LABELS` (`data/description.ts:640-778`) has **no row** for
`overflowHealthPerResource` at all — the comment at `description.ts:584-593`
explains it is one of three trait fields deliberately excluded because it
"cannot be turned into a signed quantity that reads correctly in English."
Only `overflowCostReduction` has a row (`description.ts:732`, "Relief on
Arcane Overflow's health cost", percent) — so buying the tier shows only the
*relief* percentage, never the base rate or the 40% cap. Those two numbers
exist in prose exactly once each, in the **milestone's** authored `effect`
string only ("You may cast without the resource, paying health per point
short -- never more than 40% of what you have left.",
`data/milestones.ts:177`) — the **specialization's** own flavour text ("The
pool is not the limit. Your health is, and it is a real one.",
`data/specializations.ts:205`) states neither number. A player who only ever
buys the INT-40 specialization (and never reaches INT 50, or never reads the
milestone preview) has no in-game text stating the 2-health-per-point rate or
the 40%-of-current-health cap.

## No architecture violations found
All decision logic for both mechanics lives in `src/server/sim/` and
`src/server/player/` (deterministic core). Every `src/render/` touchpoint
found (status-visuals icon draw, health-bar flash-on-raw-health-delta,
description-text display) is read-only presentation of replicated state —
no game-outcome `if` in `src/render/`.
