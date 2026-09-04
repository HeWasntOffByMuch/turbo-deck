# Everything that restores or discounts the active ability resource

Traced 2026-09-04 against `integration` branch (HEAD = merge of spec 275,
"Wisdom is sustain"). Scope is deliberately the complement of
`active-resource-economy.md` (which covers `maxResource`/passive
`resourceRegen` end to end and is current and correct as of the same date):
**everything else** that adds resource, discounts what a cast costs,
substitutes health for resource, or shortens a cooldown so resource can be
spent again sooner. Read directly from source; every number below was
cross-checked against the derivation code, not against comments alone.

`ability-cost-cooldown-economy.md` is now **stale on its central claim**:
it says `t.cooldownReduction` "is never granted by anything in the shipped
content." That was true pre-spec-275. On `integration` today, Wisdom's
Composure (`wis.composure`) grants it. Its cooldown-pipeline mechanics
(`attackTimingFor`'s two branches, `COOLDOWN_BOUNDS`, basic attacks never
reading `cooldownTicks`) are still accurate; its Wisdom-lever section and
"dead fields" list are not — see below for the corrected version.

## Where every grant in this whole note comes from

Exhaustively grepped: the **only** two files anywhere in `src/server` that
author a `traits: { ... }` block with a nonzero value are
`data/specializations.ts` and `data/milestones.ts`. `data/items.ts` has zero
`traits:` occurrences (checked directly) and no item, and `data/monsters.ts`
grants nothing (monsters get `NEUTRAL_TRAITS` via `monsterTraits()`,
`player/derived.ts:171-180`). So "where is X granted" only ever has two
possible answers, and if neither names a field, it is dead.

---

## A. Direct restoration

### Strength: Brutal Reserve (`overkillResource`)
- `data/specializations.ts:163-165`, id `str.overkill`, requires STR 25
  (tier 2), **3 tiers**, `perTier: { traits: { overkillResource: 4 } }` →
  max **+12** resource. **No milestone deepens this** (none of the three
  Strength milestones — `str.crushing`/`str.committed`/`str.unstoppable` —
  names `overkillResource`), so 12 is the hard ceiling, from the
  specialization alone.
- Trigger: `outcome.overkill`, i.e. a kill where the damage that landed on
  health (post-shield) was `>= targetIn.health * 1.25`
  (`sim/blow.ts:374`, `SCALING.combat.overkillFraction = 0.25`,
  `data/scaling.ts:542`) — "overkilled by a quarter" is literal.
- Fires: `sim/blow.ts:685`, `if (outcome.overkill && A.overkillResource > 0) resource += A.overkillResource;`,
  inside `rewardAttacker`, folded into the same `Math.min(maxResource, ...)`
  write as every other reward in that function (`blow.ts:703-706`).

### Perception: Resource Sense (`weakPointResource`, `weakPointKillHeal`)
- `data/specializations.ts:415-417`, id `per.resourceSense`, requires PER 40
  (tier 3), **1 tier only**, `{ weakPointResource: 3, weakPointKillHeal: 0.06 }`.
- `data/milestones.ts:271-279`, PER 50, deepens it with the **same pair**,
  `{ weakPointResource: 3, weakPointKillHeal: 0.06 }`.
- Both summed and both live simultaneously once a player is PER 50 and has
  bought the specialization: **weakPointResource = 6**, **weakPointKillHeal
  = 0.12** (clamped `[0, 0.25]` in `derived.ts:551`, so 0.12 stands).
- `weakPointResource` triggers on **any weak-point hit**, kill or not:
  `sim/blow.ts:640-641`, `if (outcome.weakPoint) { resource += A.weakPointResource; ... }`.
- `weakPointKillHeal` triggers **only on a weak-point hit that also kills**:
  `blow.ts:642` `if (outcome.killed && A.weakPointKillHeal > 0)`. It is a
  **health** mend, not resource — `blow.ts:662-667`,
  `mend = maxHealth * weakPointKillHeal * healingScale * healingScaleOf(...)`.
  It is applied as a raw health add (`blow.ts:667`), **bypassing
  `applyHealing` entirely** — the function's own comment says why
  (`blow.ts:654-661`): it runs mid-`resolveBlow`, before the overheal
  cascade exists as a concept for this write, so a weak-point kill that
  heals past full **wastes the remainder and can never spill into Wisdom's
  Conversion**. It does still respect `healingScale` and `healingScaleOf`
  (Decay suppression), just not the shield/conversion/salvage cascade.

### Agility: Perfect Exit (`perfectExitResource`)
- `data/specializations.ts:220-222`, id `agi.perfectExit`, requires AGI 40
  (tier 3), **1 tier**, `{ perfectExitResource: 5, perfectExitWindowTicks: round(flowTicks/6) }`
  = 5 resource, 12-tick (0.2s) window.
- `data/milestones.ts:121-134`, AGI 50, deepens with the same pair again:
  another +5, another +12 ticks.
- Both held: **perfectExitResource = 10**, **perfectExitWindowTicks = 24**
  (0.4s) — summed plainly by `derived.ts:412-413`
  (`Math.max(0, t.perfectExitResource)`, `Math.round(t.perfectExitWindowTicks)`),
  no cap on either.
- Trigger, `sim/abilities.ts:1096-1100`: a **voluntary wind-up withdrawal**
  (`cancelWindup`, not a backswing cancel), `!interrupting`, `perfectExitResource > 0`,
  not already on the mechanic's own 240-tick (4s) cooldown
  (`StatusId.PerfectExitSpent`, `PERFECT_EXIT_COOLDOWN_TICKS`, `blow.ts:82`),
  and `withinPerfectExit` — the body was hit
  (`StatusId.RecentlyHit`) within `perfectExitWindowTicks` ticks of *now*
  (`abilities.ts:1161-1166`).
- Paid out at `abilities.ts:1126-1129`, folded into the same refund write as
  the ordinary wind-up refund (see "Refund path" below) — one
  `Math.min(maxResource, entity.resource + cast.spentResource + perfectExitResource)`.
  Also grants full Flow (`abilities.ts:1110`, `grantFlow(..., flowMaxStacks)`).

### Wisdom: Conversion (`conversionCap`) — overheal → resource
- `data/specializations.ts:471-473`, id `wis.conversion`, requires WIS 40
  (tier 3), **1 tier**, `{ conversionCap: SCALING.wisdom.conversionCap /* 15 */, salvagePct: 0.2 }`.
- `data/milestones.ts:325-336`, WIS 50, deepens with `{ conversionCap: SCALING.wisdom.conversionCap }`
  (another 15). Both held: **conversionCap = 30** per healing event.
- This is **not a trigger**, it's an outlet in the shared overheal cascade
  every heal that goes through `applyHealing` runs
  (`sim/healing.ts:99-136`), in fixed order:
  1. Constitution's shield (`overhealShieldTicks`/`maxShield`)
  2. **Wisdom's conversion** — `healing.ts:129-136`:
     `resource = min(maxResource, resource + min(conversionCap, leftover))`,
     where `leftover` is whatever the shield outlet did not absorb.
  3. Wisdom's salvage (`salvageFrom`, into the restoration **meter**, not
     resource directly — see below).
- Reaches: any `applyHealing` caller with overheal — a Vitality mote
  (`world.ts:2137`), Second Wind (`world.ts:1757-1767`), a `heal`-kind skill
  effect (`sim/skill-effects.ts:252-256`), `self.mend`/the flask. **Does
  not** reach the weak-point-kill mend above (bypasses `applyHealing`
  entirely, see above) or a Focus mote (bypasses `applyHealing` too, see
  motes below).

### Motes (`sim/restoration.ts`, `sim/world.ts`)
- `MoteKind.Focus` motes restore resource **directly**, bypassing
  `applyHealing` (no `healingScale`, no Decay suppression, no cascade):
  `world.ts:2126-2131`, `resource = min(maxResource, before + mote.amount)`.
  Value: `RESTORATION.mote.resourceFraction = 0.2` of the collector's
  `maxResource` (`data/restoration.ts:127`, read in `restoration.ts:373-378`
  `moteValueFor`).
- `MoteKind.Vitality` motes go through `applyHealing`
  (`world.ts:2137`) — health, but **can** cascade into resource via
  Conversion if health is already full or nearly so.
- Which kind spawns is deterministic, never rolled: `moteKindFor`
  (`restoration.ts:354-370`) — vitality unless health deficit is under
  `focusHealthCeiling` (0.25) **and** the resource deficit fraction exceeds
  the health deficit fraction. Vitality wins essentially every tie and
  whenever health is meaningfully missing, so Focus motes are the minority
  case by design ("resource regenerates on its own between fights and
  health does not").
- How many motes a kill produces (the **meter**, `RESTORATION.threshold = 100`
  progress per mote) is boosted by four stat-scaled kill-quality bonuses in
  `contributionFor` (`restoration.ts:290-294`):
  `restoreOverkillPct` (Strength, `derived.ts:599`, `linear(above(STR), 0.012)`),
  `restoreEvasivePct` (Agility, untouched-kill, `derived.ts:600`),
  `restoreAbilityKillPct` (Intelligence, `derived.ts:601`),
  `restoreWeakPointPct` (Perception, `derived.ts:602`). **None of these are
  specialization/milestone grants** — they're flat attribute curves in
  `data/restoration.ts:264-302`, always live, no `traits:` row involved. All
  of them only raise **meter progress**, which is a probabilistic/indirect
  path to resource (only pays off resource when the resulting mote happens
  to roll Focus per `moteKindFor`).
- `moteAttractRadius` (Perception, `derived.ts:603`, `linear(above(PER), 2.4)`,
  read `restoration.ts:381-383`) only widens **pickup range**, not amount.

### Wisdom: salvage (`restoreSalvagePct`) — overheal → meter, not resource
- `data/specializations.ts:471-473` (`wis.conversion`'s `salvagePct: 0.2`,
  on top of the attribute's own curve, capped: `derived.ts:604-611`,
  `min(0.35, linear(above(WIS), 0.02)) + salvagePct`, clamped `[0, 0.75]`).
  Fires as the **third and last** overheal outlet
  (`healing.ts:142`, `salvageFrom`, `restoration.ts:584-589`), capped at
  `RESTORATION.threshold * salvageCapFraction` (35 progress) per event. This
  restores the **restoration meter**, not resource — an indirect,
  two-hop path (meter → crosses threshold → mote → maybe Focus).

### Kill/status/level-up rewards — checked and mostly **negative**
- **Login** (new or returning session): resource is unconditionally set to
  `stats.maxResource` — `player/player-manager.ts:355-357`. This is the one
  genuine unconditional full restore in the game, gated on session start
  rather than any in-game event.
- **Level-up / respec / gear change** (`PlayerManager.recalculate`,
  `player-manager.ts:465-483`): resource is **only ever clamped down**,
  never refilled — `resource: clampResourceToStats(record.resource, stats)`
  (line 477), and `clampResourceToStats` (`player/stats.ts:459-462`) is
  `min(resource, maxResource)`, never raises it. **Gaining maxResource from
  a level-up does not top off the pool.**
- **Respawn** (`server.ts:3152-3210`): explicitly resets position, health
  (→ max), `fallbackCharges`, `restoration` (meter → 0), statuses
  (afflictions + `SecondWindSpent` only). **`resource` is not in the
  override object at all** — a respawned player keeps whatever resource
  they had the instant they died.
- **Monster spawn**: `resource: definition.stats.maxResource`
  (`sim/world.ts:3008`) — moot, every monster row authors `maxResource: 0`.

### Refund path: `cancelWindup`
- `sim/abilities.ts:1048-1158`. Whenever a cast is called off **before** the
  attack point resolves — a voluntary withdrawal (movement/stop-key,
  `CastEndReason.Cancelled`) or an interruption (death, poise break,
  `CastEndReason.Interrupted`) — the entity gets back exactly
  `cast.spentResource` (what was actually paid, snapshotted at `startCast`,
  **not** the ability's list-price `cost` — the comment at
  `abilities.ts:1120-1122` is explicit: refunding list price "would be a
  resource generator for anybody with cost reduction and a cancel key").
  Same write also refunds `spentHealth` (the Overflow bill), `spentPoise`,
  and `spentCharges` (flask), all independently clamped to their own
  ceilings (`abilities.ts:1126-1149`) because regen/rest can have moved
  during the wind-up.
- Guard at `abilities.ts:1061-1080`: refuses to cancel (and thus refuses to
  refund) only when the cast is **not** turning, **not** interrupting,
  **not** a channel, and `tick >= cast.releaseTick` — i.e. once committed
  past the attack point, `cancelWindup` no longer applies at all (that's
  `cancelBackswing`'s territory, which refunds **cooldown time**, not
  resource — see Part D). A `Channel`-phase cast can always be walked out of
  through this path regardless of tick, though no shipped ability currently
  has `kind: 'channel'` (per `docs/progression-and-scaling.md` — the whole
  case is content-unreachable today).
- This is the single most-frequently-exercised "restoration" mechanic in
  the game: any withdrawn or interrupted cast returns 100% of what it would
  have cost.

### A generic per-ability restore effect exists and is unused
- `data/skill-effects.ts:196`: `{ kind: 'resource'; amount: number }` —
  "Pool. Positive restores, negative drains. Clamped at both ends."
  Resolved at `sim/skill-effects.ts:258-262`: raw
  `target.resource = clamp(target.resource + effect.amount, 0, maxResource)`,
  **no scaling of any kind** (bypasses Wisdom's `healingScale`, bypasses
  `applyHealing` entirely — it isn't healing).
- Grepped `data/abilities.ts` for `kind: 'resource'`: **zero matches**. Fully
  wired, fully tested presumably, but no ability row in the shipped content
  authors one. Structurally identical in kind to the dormant trait fields
  below, but it's a content gap rather than a stat-modifier grant gap.

---

## B. Cost modification

All of it lives in one function: `sim/abilities.ts:458-478`
`resourceCostFor(ability, entity, tick)`:
```
if (ability.cost <= 0) return 0;                    // every basicAttack row has cost: 0
attuned = stacksOf(Attuned) * traits.attunedCostPct
flow    = stacksOf(Flow) * traits.flowCostPct        // always 0, see "dormant" below
discount = max(0.1, 1 - min(0.75, attuned + flow))
shaped  = ability has radius, projectile, or area
waived  = traits.preparedMastery > 0 && Prepared is live   // always false, dormant
premium = shaped && !waived ? 1 + traits.shapingCostPct : 1
return max(0, ability.cost * traits.resourceCostScale * discount * premium)
```

### Wisdom automatic `costPer`/`costFloor` → `resourceCostScale`
- `derived.ts:318-322`:
  `resourceCostScale = clamp(reciprocal(above(WIS), 0.01, 0.4) * reduction(t.costReduction), 0.2, 1)`.
  `S.wisdom.costPer = 0.01`, `costFloor = 0.4` (`data/scaling.ts:465-466`).
- `t.costReduction` is **dormant** (see below), so in practice
  `resourceCostScale = clamp(reciprocal(above(WIS), 0.01, 0.4), 0.2, 1)`.
  At WIS 60 (`above = 55`): `1/(1+55*0.01) = 1/1.55 = 0.6452` — this never
  reaches the reciprocal's own 0.4 floor within the attribute hard cap (60),
  so the outer clamp's 0.2 floor is unreachable by any currently-live
  content. **~35.5% cost reduction is the ceiling from Wisdom alone.**

### Conservation (`wis.conservation`) → Attuned → `attunedCostPct`
- `data/specializations.ts:428-430`, WIS 10, 3 tiers, `attunedCostPct: 0.04`/tier
  (max 0.12) + `grantsAttuned: 1` (capability flag).
- `data/milestones.ts:289-304`, WIS 20, deepens: `grantsAttuned: 1`,
  `attunedCostPct: 0.08`.
- Summed and clamped `[0, 0.2]` at `derived.ts:569` — 0.08 + 3×0.04 = **0.20
  exactly**, so the cap is reachable and every tier counts (stated
  explicitly in the source comment, `milestones.ts:293-295`).
- The **window/stack count are not purchasable** — `attunedTicks`
  (6s = 360 ticks) and `attunedMaxStacks` (3) come straight from
  `SCALING.wisdom` (`derived.ts:565-568`); no specialization or milestone
  grants a delta to either (grepped, zero hits).
- Grant trigger: `sim/blow.ts:679`,
  `if (!ability.basicAttack && A.attunedCostPct > 0 && A.attunedTicks > 0)` —
  inside `rewardAttacker`, i.e. **only** on a **damage**-kind effect that
  went through `resolveBlow` (a landed non-basic attack). A pure `heal`,
  `stun`, `applyStatus`, `poiseDamage`, or `resource` skill effect never
  calls `resolveBlow`/`rewardAttacker` (confirmed against
  `sim/skill-effects.ts:38,145,176`), so **a support skill that deals no
  damage never grants an Attuned stack**, "an ability that connects" reads
  more narrowly than the specialization's flavour text suggests.
- At 3 stacks × 0.20 = 0.60 max discount — comfortably inside the
  `min(0.75, ...)` combined cap in `resourceCostFor`.

### Flow's cost discount (`flowCostPct`) — dormant, see below.

### Mastery (`masteryCooldownPct`) — **cooldown only, never cost**
- Checked directly: `resourceCostFor` (`abilities.ts:458-478`) references
  `attunedCostPct` and `flowCostPct` and nothing else Wisdom-Mastery-shaped.
  Mastery's own field, `masteryCooldownPct`, is read exactly once outside
  `derived.ts`/wire plumbing: `masteryReliefFor`
  (`abilities.ts:418-432`), which feeds only `cooldownScaleFor`
  (`abilities.ts:386-402`) → the non-basic branch of `attackTimingFor`
  (`abilities.ts:204`). It has **no path into `resourceCostFor`**. Full
  mechanics under Part D.

### Shaped-ability premium and its relief (category discount, not per-ability)
- The premium: `int.shaping` specialization (`data/specializations.ts:233-235`,
  INT 10, 3 tiers, `shapingCostPct: 0.1`/tier → 0.3) plus its milestone
  (`data/milestones.ts:138-145`, INT 20, `shapingCostPct: 0.1`) → summed
  `t.shapingCostPct` up to **0.4** (40% surcharge on any ability whose row
  has `radius`, `projectile`, or `area`).
- The relief: Efficient Construction (`int.efficientConstruction`,
  `data/specializations.ts:269-271`, INT 25, 3 tiers, `shapingCostRelief: 0.2`/tier
  → 0.6), capped at `S.intelligence.shapingReliefCap = 0.6`
  (`data/scaling.ts:314`) — three tiers land exactly on the cap.
- Combined in `derived.ts:417`:
  `shapingCostPct_final = t.shapingCostPct * (1 - shapingCostRelief)`.
  At max investment in both: `0.4 * (1 - 0.6) = 0.16` — **the surcharge can
  be cut from 40% to 16%, and is designed to never reach 0%** (spec 270's
  own words: "a specialization whose whole job is to delete another
  specialization's drawback is not progression, it is an apology for it").
- This is a category discount (any "shaped" ability), not an id-specific
  one. **No mechanism in the sim keys a cost discount off a specific
  ability id.** The closest thing to "ability-specific" is Mastery, which
  is specific to an ability id but only touches cooldown (Part D).
- `waived` (Prepared cast skips the premium outright) is gated on
  `preparedMastery`, which is **dormant** — see below. The waiver code path
  (`abilities.ts:474`) exists and is exercised by nothing today.

### Dormant/leftover legacy hooks in the cost pipeline
All confirmed by exhaustive grep: declared as a `TraitModifier` field
(`data/modifiers.ts`), defaulted to 0/false in `NEUTRAL_TRAITS`
(`player/derived.ts`), read by the sim, but **granted by nothing** in
`data/specializations.ts` or `data/milestones.ts` (the only two grant
sources that exist) — remnants of the pair-synergy table (`data/synergies.ts`)
spec 244 deleted, per `data/presets.ts:140-198`'s own commentary:
- **`t.costReduction`** (`modifiers.ts:409`) — feeds `resourceCostScale`
  alongside Wisdom's attribute curve (`derived.ts:319`). Always 0, so
  `reduction(0) = 1`; Wisdom's raw curve is the *only* live contributor to
  `resourceCostScale` today.
- **`t.flowCostPct`** (`modifiers.ts:361`, capped `[0,0.25]` at `derived.ts:402`)
  — read in `resourceCostFor`'s `flow` term (`abilities.ts:467`). The
  `agi.flow` specialization (`data/specializations.ts:217-219`) grants
  `flowBackswingCancelPct`/`flowDurationPct` only, never `flowCostPct`. Dead.
- **`t.preparedMastery`** (`modifiers.ts:375`) — gates both the shaping-
  premium waiver above and a 25% cooldown refund (Part D). Not granted
  anywhere (was the "Archmage" INT+WIS pair).
- **`t.breakResource`** / **`t.breakCooldownRefund`** (`modifiers.ts:346-347`)
  — read in `rewardBreak` (`blow.ts:517-526`, resource-on-guard-break and a
  fractional refund of remaining cooldown time on every entry in
  `cooldowns`). Not granted anywhere.
- **`t.exposedTeamResource`** (`modifiers.ts:408`) — the "Tactician's
  bounty": if the *exposer* had this trait, a status carrying the magnitude
  (`EXPOSED_BOUNTY = StatusId.ExposedBounty`) would be written on the
  target at `blow.ts:586-590`, and **anyone** who later hits that target
  reads it back as free resource at `blow.ts:700-701`. Since nothing grants
  the trait, the status is never written, so the read always finds nothing.
- **`t.attunedFromWeakPoints`** (`modifiers.ts:417`) — would grant an
  Attuned stack from a weak-point hit specifically (`blow.ts:669-673`),
  separate from Conservation's "any connecting non-basic hit" rule above.
  Not granted anywhere.
- **`t.handlingCooldowns`** (`modifiers.ts:357`) — would let Agility's
  `handlingScale` also shrink a **projectile** skill's cooldown
  (`cooldownScaleFor`, `abilities.ts:392-393`; the "Ranger"/AGI+PER pair).
  Not granted anywhere.

None of these are reachable by any equipped item either (`data/items.ts` has
no `traits:` block at all, confirmed by grep).

---

## C. Resource substitution — Intelligence's Arcane Overflow

Two traits, always granted as a pair, from two independent sources:
- `int.overflow` specialization: `data/specializations.ts:277-283`, INT 40,
  1 tier, `{ overflowHealthPerResource: SCALING.intelligence.overflowHealthPerResource /* 2 */, overflowCostReduction: 0.25 }`.
- Its milestone: `data/milestones.ts:167-184`, INT 50, grants the identical
  pair again.

**The capability flag and the rate are decoupled from each other on
purpose** (`derived.ts:454-471`): the *summed* `t.overflowHealthPerResource`
is only ever checked as `> 0` (a capability gate — either source alone turns
Overflow on); the *actual output rate* always comes from the flat constant
`SCALING.intelligence.overflowHealthPerResource` (2) times
`reduction(t.overflowCostReduction)`, **never** from the raw sum of however
many sources granted the base rate. This is a deliberate fix for a
historical bug (both sources used to add the raw rate, so reaching the
milestone *doubled* the cost instead of easing it — see the comment at
`milestones.ts:172-176`). Consequence: rate = `2 * reduction(0.25) = 1.5`
with either source alone, `2 * reduction(0.5) = 1.0` with both (0.25+0.25
summed and clamped `≤0.9` inside `reduction()`, `derived.ts:39-41`).

Mechanics, in `startCast` (`sim/abilities.ts:633-786`):
1. `cost = resourceCostFor(...)` — the full, already-discounted cost (B above).
2. `shortfall = cost - entity.resource` (`abilities.ts:674`) — **whatever
   resource the body currently has is applied to the cost first**, in full;
   only the amount still missing after that is a "shortfall."
3. `overflow = shortfall > 0 ? overflowCostFor(entity, shortfall) : 0`
   (`abilities.ts:675`, `overflowCostFor` at `abilities.ts:528-537`):
   `bill = shortfall * overflowHealthPerResource`; refused outright
   (`return 0`) unless `bill <= entity.health * SCALING.intelligence.overflowHealthFraction /* 0.4, fixed, not purchasable */`.
   **Only the deficit is ever converted — never the whole cost.**
4. Refusal: `if (shortfall > 0 && overflow <= 0) return { ok: false, reason: 'notEnoughResource' }`
   (`abilities.ts:676`) — Overflow is a conditional unlock, not an
   always-available substitute; if the health bill would exceed 40% of
   *current* (not max) health, the cast is refused exactly as it would be
   with no Overflow at all.
5. On success: `resource: max(0, entity.resource - cost)` (`abilities.ts:785`,
   drains the pool to 0 when overflow was needed) and
   `health: max(1, entity.health - overflow - extra.health)`
   (`abilities.ts:791-794`).

**Can it kill you? No, by two independent mechanisms**: the affordability
check in step 3 bounds the bill to 40% of *current* health before the cast
is even allowed to start, and the health write itself is floored at
`Math.max(1, ...)` (`abilities.ts:793`) as defense in depth. Comment at
`abilities.ts:522-526` states the intent directly: "Never lethal... the
risk is that the *next* thing to hit you finds you low."

A withdrawn/interrupted cast refunds the overflow health exactly as it
refunds resource — `cancelWindup` (`abilities.ts:1133-1135`,
`health: min(maxHealth, entity.health + cast.spentHealth)`), Part A's
refund path.

`SCALING.intelligence.overflowHealthFraction` (0.4) is a fixed constant
read directly by name in `overflowCostFor` — **not itself purchasable or
reducible by any trait.**

---

## D. Cooldown reduction

Everything below reaches **only non-basic (`skill: true`, `basicAttack`
falsy) abilities**. Every `basicAttack` row has `cost: 0` and its interval
comes from `entity.stats.baseAttackTimeTicks` (weapon Base Attack Time),
which none of this touches by construction (`attackTimingFor`'s two
branches, `abilities.ts:191-240`; the non-basic branch alone calls
`cooldownScaleFor`, at `abilities.ts:204`).

### Wisdom automatic `cooldownPer`/`cooldownFloor` → `cooldownScale`
- `derived.ts:323-327`:
  `cooldownScale = clamp(reciprocal(above(WIS), 0.006, 0.5) * reduction(t.cooldownReduction), 0.25, 1)`.
  `S.wisdom.cooldownPer = 0.006`, `cooldownFloor = 0.5` (`scaling.ts:467-468`).
- At WIS 60 (`above = 55`): `1/(1+55*0.006) = 1/1.33 = 0.75188` — 24.8%
  reduction from the attribute alone, and (per the reciprocal floor of 0.5)
  this is nowhere near either floor on its own.

### Composure (`wis.composure`) → `cooldownReduction`
- `data/specializations.ts:444-446`, WIS 25, 3 tiers, `cooldownReduction: 0.05`/tier
  → **0.15** total. `reduction(0.15) = 0.85`.
- Combined with the attribute alone: `0.75188 * 0.85 = 0.639` — matches the
  source's own stated result exactly (`specializations.ts:438-439`,
  "takes a fully invested body to 0.639").

### Mastery (`wis.mastery`) → `masteryCooldownPct`, **per ability id**
- `data/specializations.ts:464-466`, WIS 25, 3 tiers, `masteryCooldownPct: 0.02`/tier
  → 0.06 total (clamped `[0, 0.1]` at `derived.ts:593`, so unclamped in
  practice), plus `grantsMastery: 1`.
- Window/stack cap are **not purchasable**: `masteryTicks` (20s = 1200
  ticks) and `masteryMaxStacks` (5) come from `SCALING.wisdom` alone
  (`derived.ts:594-597`); no grant adds a delta to either.
- A stack is earned **per ability id**, at the attack point of every
  non-basic cast that reaches it (`sim/abilities.ts:1544-1549`,
  `applyStatus(statuses, masteryKey(ability.id), tick, masteryTicks, { maxStacks: masteryMaxStacks })`
  — this is ability-kind-agnostic, so a heal/shield/slow cast earns a stack
  identically to a damage cast). Earned at the attack point specifically so
  a withdrawn cast teaches nothing.
- Consumed by `masteryReliefFor` (`abilities.ts:418-432`):
  `min(stacksHeld, masteryMaxStacks) * masteryCooldownPct` — at 3 tiers and
  5 stacks on one ability, **0.06 * 5 = 0.30**, i.e. up to 30% off *that
  ability's* cooldown specifically, on top of Composure/attribute.
  `masteryReliefFor` explicitly returns 0 for a `basicAttack`
  (`abilities.ts:423`) as a second, redundant guard.
- Folded into `cooldownScaleFor` (`abilities.ts:386-402`):
  `max(0.2, traits.cooldownScale * handling(dead) * prepared(dead) * (1 - masteryReliefFor(...)))`.
  Worked worst case (Composure+attribute both maxed, 5 Mastery stacks on
  one ability): `0.639 * 0.70 = 0.447` — 55% off that ability's cooldown,
  above the 0.2 floor.

### Agility: Mobile Offense (`mobileOffenseCooldownTicks`)
- `data/specializations.ts:202-204`, id `agi.mobileOffense`, AGI 10, 3 tiers,
  `mobileOffenseCooldownTicks: SCALING.agility.mobileOffenseCooldownTicks /* seconds(0.4) = 24 ticks */`
  → **72 ticks (1.2s)** from 3 tiers.
- `data/milestones.ts:106-119`, AGI 20, deepens with the same constant once
  more: another 24 ticks. Both held: **96 ticks (1.6s)**, summed plainly
  (`derived.ts:406-411`, explicitly **uncapped**).
- Trigger: **not** cooldown-on-cast — it fires once per **deliberate
  backswing cancel** (walking out of a follow-through *after* the attack
  already landed), via `cancelBackswing`
  (`abilities.ts:1252-1309`) → `refundActiveCooldowns`
  (`abilities.ts:1211-1231`).
- What it moves: every entry in `entity.cooldowns` whose ability resolves
  to `skill: true` (the four equipped active abilities), reducing each
  `readyAt` by the flat tick amount, floored at `tick` (never negative,
  never drags a stale past-tick entry forward). **Explicitly excludes the
  basic attack's own cooldown entry** (that would move the attack cadence,
  which spec 144/258 forbid Agility from ever touching) and the flask
  (paced by charges, not by this map). Can fire repeatedly, once per
  follow-through walked out of — no cap on how many times per fight.
- Distinguish from Quick Recovery / Flow (`backswingCancelReduction`,
  `flowBackswingCancelPct`, `flowDurationPct`): those move the **tick a
  follow-through may be left on** (commitment), not any cooldown value.
  Only Mobile Offense's own field touches `cooldowns`.

### Dormant cooldown-reduction hooks
- **`t.preparedMastery`** — gates a flat **25% cooldown refund**
  (`PREPARED_COOLDOWN_REFUND = 0.25`, `abilities.ts:435`) on a cast made
  while `Prepared` is live: `cooldownScaleFor`, `abilities.ts:398-401`.
  Never granted (see Part B's dormant list — same field, same "Archmage"
  pair, two consumers).
- **`t.handlingCooldowns`** — gates Agility's `handlingScale` reaching
  `cooldownScaleFor`'s `handling` term for **projectile** abilities
  (`abilities.ts:392-393`). Never granted (the "Ranger"/AGI+PER pair).
- **`t.breakCooldownRefund`** — a fractional refund of whatever time is
  **currently** left on every cooldown, on breaking a Guard
  (`rewardBreak`, `blow.ts:520-526`:
  `cooldowns[id] = readyAt - floor(remaining * breakCooldownRefund)`, for
  every id in `next.cooldowns`, not scoped to `skill: true` the way Mobile
  Offense is). Never granted.

Neither Mastery's per-ability discount, nor Composure's, nor the Wisdom
curve, nor Mobile Offense ever reaches a **basic attack's** interval — the
fence is structural (`attackTimingFor`'s branch split), not a runtime guard
that could be forgotten.
