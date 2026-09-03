# 275 — Wisdom is sustain

## Problem

Wisdom is reviewed in `.claude/notes/progression-wisdom.md`: everything on the
track is wired, purchasable and read by the sim, and about a quarter of it
changes how the game plays. Five things are wrong, and they are one thing.

**Wisdom stretches an economy that was never tight.** The greediest legal
four-skill bar drains 3.79 resource/second — a hard ceiling, since a body is
rooted through its own casts — against a regeneration of `2 + 0.12 x WIS` that
Wisdom raises while it also cuts the cost. Supply passes demand at **WIS 13**,
below the first milestone and below every cost specialization. Seven of sixteen
buyable tiers and two of three milestones sit on that axis.

Around that:

- **Six automatic scales point at one problem.** Wisdom grants cost, cooldown,
  healing, salvage, max resource *and* regeneration. Three of them are the same
  lever. `maxResource` in particular is Intelligence's: INT owns the magazine.
- **Three of the six measure from raw `WIS`** — healing, pool, regeneration —
  where cost, cooldown and salvage measure from `above(WIS)`. A character who
  has spent nothing already carries +6% healing, +5 pool and +0.6/s regen.
  `scaling.ts`'s own header warns about exactly this.
- **Nothing purchasable grants cooldown.** `attributes.ts` lists "cooldowns
  (Wisdom)" and three other attributes list it in their `notOwned`, but
  `cooldownReduction` is granted by nothing anywhere in the repo — the only
  cooldown lever is the automatic curve.
- **Adaptation has no depth.** Every tier and the milestone converge on the same
  30% ceiling, because `adaptationCap` is granted by nothing; tiers buy only
  hits-to-cap, and at WIS 35 tier 2 does not move even that.
- **Mastery is meta-progression, not combat.** It relieves specialization
  thresholds — roughly point-neutral, described to the player only in flavour
  text, and its `TraitStats.masteryRelief` is replicated to every client and
  read by nothing (the real mechanic runs through a parallel reader in
  `player/specializations.ts`).
- **The WIS 20 milestone deepens a mechanic it does not share a trait with.**
  It grants the Attuned family; the specialization it names grants
  `costReduction`.

This spec rebuilds Wisdom as the sustain track its identity claims, without
restoring pair synergies, redesigning another attribute, or retuning the global
resource economy. The loop it should read as:

> recover -> conserve -> learn -> adapt -> reuse -> waste nothing

## Shape

### Ownership

> **INT owns the magazine. WIS owns making it last and recovering it.**

`RESOURCE_PER_WISDOM` is removed from `computeEffectiveStats`. `maxResource`
becomes `BASE_RESOURCE + RESOURCE_PER_INTELLIGENCE * INT + bonus`. Nothing moves
to another attribute: Intelligence already has the primitive.

`healingPer` and `regenPer` move from raw `WIS` onto `above(WIS)`, joining
`costPer`, `cooldownPer` and `wisdomSalvagePer`. `SCALING.wisdom.resourcePer` is
deleted.

### The track

Six nodes and sixteen tiers, unchanged in cost. Conservation moves to T1 so the
milestone that introduces Attuned deepens the specialization that owns it.

```
   10 ── Conservation x3 ...... Attuned: deliberate resource efficiency
         Measured Recovery x3 . restoration works better on me
   20 ── (auto) Conservation ... introduces Attuned, deepens Conservation
   25 ── Composure x3 ......... broad active-cooldown efficiency
         Adaptation x3 ........ repeated incoming threats
         Mastery x3 ........... repeated use of my own tools
   35 ── (auto) Adaptation .... deepens Adaptation
   40 ── Conversion x1 ........ overflow becomes resource and salvage
   50 ── (auto) Conversion .... deepens Conversion
```

### Capability flags

`TraitModifier` gains `grantsAttuned` and `grantsMastery`, following the pattern
`grantsPrepared` / `grantsOpeningRead` / `grantsAdaptation` already set and the
reason `derived.ts` states for them: a capability inferred from the number a
skill grants as a delta is a capability the skill switches off. Both are
`TraitModifier`-only and do not ride the wire, as `grantsAdaptation` does not.

### Composure — `cooldownReduction`, reused

The dead primitive is the right hook: `derived.ts` already computes

```ts
cooldownScale = clamp(reciprocal(above(WIS), cooldownPer, cooldownFloor)
                        * reduction(t.cooldownReduction), 0.25, 1)
```

so a specialization granting `cooldownReduction` deepens the curve with no new
plumbing. Composure grants `0.05` a tier.

It reaches active abilities only, structurally rather than by a guard:
`cooldownScaleFor` is called from `attackTimingFor`'s non-basic branch alone, and
a basic attack's interval comes from `baseAttackTimeTicks`. Wind-up, attack point
and backswing are separate fields and are not touched.

### Mastery — per-ability, earned by use

`sim/statuses.ts` gains `masteryKey(abilityId)`, beside `adaptedKey`. A stack is
applied at the **attack point**, in `advanceCast`'s commit block — the one place
the sim already marks a cast as real, and the reason support abilities
participate for free: it is ability-kind agnostic, so a heal, a shield or a
control ability masters exactly as a blow does. Basic attacks are excluded, as
they already are for Attuned.

```ts
masteryCooldownPct  // per stack, from Mastery's tiers
masteryMaxStacks    // SCALING base + delta
masteryTicks        // SCALING base + delta, refreshed by each use
```

`cooldownScaleFor` multiplies in `1 - stacks * masteryCooldownPct` for the
ability being cast. Because `nextReadyTick` reads `cast.timing`, snapshotted at
`startCast`, the stack a cast earns pays for the *next* one — the lifecycle the
task describes, and spec 258's own rule for Flow.

Mastery reaches `cooldownScaleFor` and nothing else, so it cannot become attack
speed.

### Adaptation — a purchasable ceiling

`adaptationCap` is reused. Both the specialization and the milestone grant cap as
well as rate, so deep investment raises the ceiling rather than only reaching the
same one sooner.

| held | per stack | cap | hits to cap |
|---|---|---|---|
| WIS 25, tier 1 | 0.03 | 0.35 | 12 |
| WIS 25, tier 3 | 0.09 | 0.45 | 5 |
| WIS 35, milestone only | 0.06 | 0.35 | 6 |
| WIS 35, tier 3 | 0.15 | 0.50 | 4 |

50% is the fully specialized ceiling, inside the task's 40–50% region and under
the existing `0.6` clamp. It stays attack-pattern-specific: keyed on ability id,
as now.

### Conversion — and salvage depth

`TraitStats` gains `salvagePct`, summed onto the automatic curve:

```ts
restoreSalvagePct = min(wisdomSalvageCap, linear(above(WIS), wisdomSalvagePer))
                    + t.salvagePct
```

`wisdomSalvageCap` drops 0.60 -> 0.35 so the attribute gives a foundation, and
Conversion grants `salvagePct: 0.20` so the specialization is the extreme
version. Conversion keeps `conversionCap: 15`; the milestone keeps its own 15 and
its copy is corrected to read as the delta it is.

### Retired

`masteryRelief` leaves `TraitStats`, `TraitModifier`, `SCALING.wisdom` and
`player/specializations.ts`; `effectiveRequirement` collapses to
`specialization.requires`. `wis.discipline` and its `costReduction` grant are
gone — the attribute keeps modest automatic cost efficiency and Conservation is
where a player specializes.

## Invariants tested

**Automatic scaling**

- `maxResource` does not change with Wisdom at any value; it does change with
  Intelligence.
- healing, regeneration, cost and cooldown scales are all exactly neutral at
  `WIS = SCALING.startingAttribute`, and monotonic across the range.
- `SCALING.wisdom` has no `resourcePer` and no `masteryRelief`.

**Composure**

- every tier lowers a real ability's resolved cooldown, measured through
  `attackTimingFor`.
- no tier changes `baseAttackTimeTicks`, the attack point or the backswing of a
  basic attack.
- legal maximum investment stays above both cooldown floors.

**Mastery**

- casting A repeatedly builds stacks on A and none on B.
- an ability's resolved cooldown falls as its own stacks rise.
- a self-targeted, damage-free ability builds Mastery (the support case).
- a withdrawn cast — one cancelled before the attack point — builds nothing.
- basic attacks neither build Mastery nor have their interval changed by it.
- stacks stop at `masteryMaxStacks` and expire after `masteryTicks`.

**Adaptation**

- repeated hits from one ability build resistance; a second ability tracks
  separately.
- each tier changes the final cap, and the cap is respected.
- hits-to-cap falls across tiers.
- a body with no Adaptation takes unmodified damage (no generic DR appears).

**Conservation / Attuned**

- a non-basic ability that connects grants Attuned; a basic attack does not.
- stacks cap, the discount applies to the next cast, and the resource floor holds.
- the WIS 20 milestone's `deepens` names a specialization that shares a trait
  family with it — asserted for every milestone in the table, not just this one.

**Conversion**

- overflow past full health converts, bounded by `conversionCap`.
- specialization and milestone sum, and the rendered text states a delta.
- `salvagePct` deepens salvage above the automatic ceiling.

**Audit**

- Wisdom's purchases are checked on *derived gameplay results* — resolved
  cooldown, resolved cost, adaptation cap and hits-to-cap, conversion recovered,
  healing applied — not only on whether a trait number moved.

## Out of scope

- The five other attributes. Constitution's Second Wind healing-pipeline fix is
  spec 273's; this spec audits and reports the Perception weak-point-kill heal
  rather than moving it.
- Global resource coefficients. Skill costs and `RESOURCE_REGEN_PER_SECOND` are
  untouched; the crossover moves from WIS 13 to about WIS 17 as a consequence of
  the baseline fix alone, and closing it properly is the later economy pass.
- The global progression-point faucet. The track stays at sixteen tiers; no
  filler is added because the level-60 budget is oversized.
- Explicit pair synergies. `preparedMastery`, `flowCostPct`, `handlingCooldowns`
  and `attunedFromWeakPoints` stay dormant and are reported, not resurrected.
- The monster roster. Adaptation reads broader than intended because six of seven
  hostile rows share `melee.slash`; that content compression is measured and
  reported here, not fixed.
- Any weapon or spell damage for Wisdom.
