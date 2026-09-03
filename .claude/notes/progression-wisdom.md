# Wisdom progression: authored -> derived -> read (traced, not yet wired-checked for other attributes)

Full key-by-key trace of the WISDOM specialization/milestone/scaling keys, from
authoring to every runtime read. See git blame / session trace for method.
Re-derive if `data/specializations.ts`, `data/milestones.ts`, `data/scaling.ts`,
`player/derived.ts`, `player/stats.ts`, or `player/specializations.ts` change.

## Pipeline

`data/specializations.ts` (perTier grant) + `data/milestones.ts` (grant, once
met) -> `player/progression.ts:resolveProgression` (`heldModifiers` scales each
specialization's `perTier` by held tier via `scaleModifier`, hop1 -> attributes
-> `metMilestones` -> hop2 -> `sumModifiers([...held, ...hop2])` = `totals`,
a `ModifierTotals`/`TraitModifier`, i.e. the raw `t.*` object) -> `player/derived.ts:deriveTraits(totals, attributes, ...)`
produces `TraitStats` (the numbers the sim actually reads, and what rides the
wire under `TRAIT_WIRE_ORDER`). Separately, `SCALING.wisdom.resourcePer` /
`.regenPer` feed `player/stats.ts:computeEffectiveStats` directly (`maxResource`,
`resourceRegen`), which is `EffectiveStats`/`Stats`-level, NOT `TraitStats`.

`SCALING.wisdom` (data/scaling.ts:274-288):
```
costPer: 0.01, costFloor: 0.4, cooldownPer: 0.006, cooldownFloor: 0.5,
healingPer: 0.012, resourcePer: 1, regenPer: 0.12,
attunedTicks: seconds(6), attunedMaxStacks: 3,
adaptationTicks: seconds(10), adaptationCap: 0.3,
conversionCap: 15, masteryRelief: 3,
```

Wisdom specializations (data/specializations.ts:275-304), perTier (x1..x3 held tiers):
- `wis.discipline` T1 x3: `costReduction: 0.06`
- `wis.measuredRecovery` T1 x3: `healingPct: 0.12`
- `wis.mastery` T2 x3: `masteryRelief: 1`
- `wis.conservation` T2 x3: `attunedCostPct: 0.04`
- `wis.adaptation` T2 x3: `grantsAdaptation: 1, adaptationPerStack: 0.04`
- `wis.conversion` T3 x1: `conversionCap: SCALING.wisdom.conversionCap`

Wisdom milestones (data/milestones.ts:261-310), flat once threshold met:
- `wis.discipline` T1: `attunedTicks: SCALING.wisdom.attunedTicks, attunedMaxStacks: SCALING.wisdom.attunedMaxStacks, attunedCostPct: 0.08`
- `wis.adaptation` T2: `grantsAdaptation: 1, adaptationPerStack: 0.06` (deliberately no cap/window of its own)
- `wis.conversion` T3: `conversionCap: SCALING.wisdom.conversionCap`

No item in `data/items.ts` grants any of these fields. `synergies.ts` does not
exist (removed spec 244); the `pair.enduring` example in comments (derived.ts:492,
milestones.ts:289) is illustrative prose, not live content -- nothing today
grants a delta to `adaptationCap` or `adaptationTicks`, so both are always
exactly their `SCALING.wisdom` base whenever `grantsAdaptation` is true.

## Key -> derived TraitStats field -> live read site

| key | derived field (derived.ts) | live read (file:line) | replicated |
|---|---|---|---|
| `costReduction` | `resourceCostScale` (297, out 475) | `sim/abilities.ts:410` `resourceCostFor()`, called from `startCast` (abilities.ts:606) | yes (`resourceCostScale` in TRAIT_WIRE_ORDER) |
| `healingPct` | `healingScale` (308, out 477) | `sim/healing.ts:64` `applyHealing()`, called from `world.ts:2029` (mote), `abilities.ts:1884` (self-heal), `skill-effects.ts:238` (skill heal) | yes |
| `attunedCostPct` | passthrough, clamped [0,0.2] (482) | `sim/abilities.ts:399` (`resourceCostFor`, live); `sim/blow.ts:558` (gates granting Attuned on non-basic hit, `rewardAttacker`) | yes |
| `attunedTicks` | passthrough (481) | `sim/blow.ts:548-551` and `:558-561` (`rewardAttacker`, duration arg to `applyStatus(...StatusId.Attuned...)`) | yes |
| `attunedMaxStacks` | passthrough (480) | `sim/blow.ts:550` and `:560` (`maxStacks: A.attunedMaxStacks`) | yes |
| `grantsAdaptation` | NOT a TraitStats field -- consumed once as `adapts = t.grantsAdaptation > 0` (derived.ts:276), gates the 3 fields below | n/a directly; effect visible only via those 3 | no (not in TRAIT_WIRE_ORDER) |
| `adaptationPerStack` | clamp(t.adaptationPerStack,0,0.2) if adapts (494) | `sim/blow.ts:288` (`adaptationAgainst` damage mitigation, `resolveBlow`); `sim/blow.ts:476-479` (`markTarget`, stacks the `adapted:<ability>` status) | yes |
| `adaptationTicks` | `S.wisdom.adaptationTicks + t.adaptationTicks` if adapts (496-497) — t.adaptationTicks is always 0 today | `sim/blow.ts:477` (duration arg, `markTarget`) | yes |
| `adaptationCap` | `S.wisdom.adaptationCap + t.adaptationCap` if adapts (495) — t.adaptationCap is always 0 today | `sim/blow.ts:288` (`adaptationAgainst`); `sim/blow.ts:478` (`maxStacks: ceil(cap/perStack)`) | yes |
| `conversionCap` | passthrough (499) | `sim/healing.ts:108,112` (`applyHealing` overflow-to-resource); `sim/world.ts:1908` (`moteHasRoom`, decides if a health mote is worth collecting) | yes |
| `masteryRelief` | `Math.max(0, round(t.masteryRelief))` (500) | **ZERO reads anywhere** (see finding below) | yes (bytes cross wire, nothing consumes them either side) |
| `SCALING.wisdom.resourcePer` | -> `RESOURCE_PER_WISDOM` (stats.ts:133) -> `maxResource` (stats.ts:291-297) | `sim/world.ts:1123-1126` per-tick regen clamp; every resource-cost check reads `stats.maxResource` | yes (`Stats.maxResource`, messages.ts:1567/1686) |
| `SCALING.wisdom.regenPer` | -> `REGEN_PER_WISDOM` (stats.ts:136) -> `resourceRegen` (stats.ts:298-301) | `sim/world.ts:1123-1126`: `regenerated(next.resource, next.stats.resourceRegen, ...)`, every tick | yes (`Stats.resourceRegen`, messages.ts:1568/1687) |
| `SCALING.wisdom.costPer/costFloor` | -> `resourceCostScale` (297) | same as `costReduction` above | yes |
| `SCALING.wisdom.cooldownPer/cooldownFloor` | -> `cooldownScale` (301-305, out 476) | `sim/abilities.ts:374` `cooldownScaleFor()`, called from `attackTimingFor` (abilities.ts:203, called from `startCast` abilities.ts:673) | yes |
| `SCALING.wisdom.healingPer` | -> `healingScale` (308) | same as `healingPct` above | yes |
| `SCALING.wisdom.masteryRelief` (=3) | **never read by anything, including `derived.ts`** -- `wis.mastery` specialization hardcodes its own literal `1` per tier instead | n/a | n/a (pure dead constant) |

## Two dead-socket findings (the point of this exercise)

### 1. `TraitStats.masteryRelief` -- authored, derived, replicated, read by nobody

Grep across the whole repo (`grep -rn "masteryRelief" src/`) turns up exactly:
authoring (specializations.ts:282, scaling.ts:287), the `TraitModifier`
declaration (modifiers.ts:214), the `deriveTraits` computation + default
(derived.ts:142,500), the `TraitStats` interface + wire-order entry
(state/types.ts:517,641), a static direction-label for `npm run audit:progression`
(progression-audit.ts:185, metadata only), description.ts's explicit exclusion
list (588, confirmed by description.test.ts:555-559 as one of exactly 3 fields
that "cannot be turned into a signed quantity"), and tests. **No file under
`sim/`, `world/`, `render/`, or `ui/` ever reads `.traits.masteryRelief`.**

The actual mechanic (Mastery lowers a tier-3 specialization's attribute gate)
is implemented by a *second, independent* function that bypasses the trait
bundle entirely: `player/specializations.ts:67-72` `masteryRelief(held)` reads
`tierOf(held, 'wis.mastery')` and the specialization definition's own
`perTier.traits.masteryRelief` directly, called from `effectiveRequirement`
(specializations.ts:75-80) -> `validateSpecializationSpend` (94-138) ->
`buySpecializationTier` (148+) -> `PlayerManager.buySpecializationTier`
(player-manager.ts:832-846) -> the live spend-a-point server handler
(server.ts ~1101). The code comment at specializations.ts:62-66 says this is
deliberate (avoids a cycle: computing the trait bundle needs the specializations
already resolved), not an oversight -- but the byproduct is that
`TraitStats.masteryRelief` is a fully-wired, fully-replicated field with zero
consumers on either end of the wire.

Why `npm run audit:progression` doesn't catch it: its `diff()`
(progression-audit.ts:313-346) verdict is "did a value on `EffectiveStats`/
`TraitStats` move between before/after a purchase" -- and `masteryRelief` DOES
move (0 -> 1 -> 2 -> 3 across tiers), so the audit scores `wis.mastery` as
`ACTIVE`. The audit's definition of "reaches the sim" is "exists on one of
these two objects and changed," which is a necessary but not sufficient
condition -- it has no notion of "and something downstream reads that specific
field." This is a gap in the audit tool itself, not something it currently flags.

### 2. `attunedTicks` / `adaptationTicks` GRANT_LABELS rows are description-unreachable given current content

`description.ts` has `GRANT_LABELS` rows for `attunedTicks` (774) and
`adaptationTicks` (777) (there is no row at all for `attunedMaxStacks` or
`adaptationCap`). But of the wisdom content that exists today:
- `attunedTicks` is granted *only* by the `wis.discipline` **milestone**
  (milestones.ts:272); no specialization grants it (the comment at
  specializations.ts:290 explicitly says it was removed from `wis.conservation`'s
  grant on purpose).
- `adaptationTicks` and `adaptationCap` are granted by *nothing* currently
  authored (only `SCALING.wisdom`'s flat base feeds them).

Milestones are described by their own hand-authored `.effect` string shown
verbatim (`src/ui/screens/character.ts:560`, `character-model.ts:386`), **never**
via `GRANT_LABELS`/`describeSpecialization` (that path is specializations-only,
confirmed by description.test.ts:530-560 iterating `ALL_SPECIALIZATIONS` only).
So: the numbers are live in the sim (see table above), replicated, but there is
no player-facing text anywhere that states "Attuned lasts 6s" or "Adaptation
lasts 10s, caps at 30%" -- the milestone's authored prose ("up to three
stacks", "half again as fast") states some of this by hand and does not
mention the cap or the duration at all. Not a runtime bug, but a
description/UI coverage gap for exactly the fields the description system
exists to keep synced with the data.

## UI surfacing (character sheet)

Always-visible sheet rows (`render/iso3d/world/character-model.ts:296-311`),
labelled "Wisdom": **Ability cost** = `resourceCostScale` (298), **Cooldowns**
= `cooldownScale` (303), **Healing** = `healingScale` (308). Also **Pool**
(245) = `maxResource` (reflects `resourcePer`); no sheet row for
`resourceRegen`/`regenPer` at all (replicated but undisplayed).

Everything else (`attunedCostPct`, `attunedTicks`, `grantsAdaptation`,
`adaptationPerStack`, `conversionCap`, `costReduction`, `healingPct` themselves
as raw grants) surfaces only as tooltip prose on the wisdom specialization tree
via `GRANT_LABELS` + `describeSpecialization` (character-model.ts:339), i.e.
what a *tier* grants, not the character's current effective value. Two visible
status marks exist for the moment-to-moment mechanics: `StatusId.Attuned`
(status-visuals.ts:163-170, icon `attuned`) and the collapsed `ADAPTED_ID`
(`'adapted'`, status-visuals.ts:211-220, icon `adapted`) -- every per-ability
`adapted:<ability>` status collapses into this one wire row, keeping the
largest stack (net/delta.ts:103-129), so a player sees "you have adapted" and
a stack count but never which ability or the numeric discount.
