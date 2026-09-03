# Weapon scaling (STR/AGI/INT) and reachable weapon/skill content

Traced 2026-09-01, against `src/server/{player,data,sim}` as of the spec
216-238 damage rework. Re-read source before relying on line numbers.

## 1. The basic-attack damage chain

Two-stage: `player/stats.ts` (`computeEffectiveStats`) resolves a *range*
once per stat recalc; `sim/blow.ts` (`resolveBlow`) rolls inside that range
once per swing.

**Stage 1 — resolve the weapon's range** (`player/stats.ts:214-239`):
```
mainHand = player.equipment.mainHand -> itemById()
weaponScaling  = effectiveScaling(scalingOf(weapon.scaling, held), gradeModifiersFrom(bonus))
scalingBonus   = attributeScalingBonus({str,agi,int}, weaponScaling)   // sums all 3 attrs
resolve(end)   = max(0, (end + scalingBonus + bonus.attackDamage) * (1 + bonus.attackDamagePct))
weaponDamageMin = resolve(weapon.damage.min)
weaponDamageMax = resolve(weapon.damage.max)
```
Both ends of the range get the *same* additions, so a wide weapon stays wide.

**Stage 2 — roll and apply** (`sim/blow.ts:163-243`), only for `isBasicAttack`:
```
weaponRoll = rollBetween(rng, stats.weaponDamageMin, stats.weaponDamageMax)  // one Rng draw
base = ability.damage (0 for a basic attack) + abilityAttributeBonus(...) (skipped, isBasicAttack) + weaponRoll * 1
damage = base * (critical ? 1.75 : 1)
... weak point / exposed / afflicted / execute multipliers ...
... armor / adaptation / resolute mitigation ...
```
So for a basic attack, `base` *is* `weaponRoll`, and `weaponRoll` already has
the attribute term folded in from stage 1. Crit is rolled **before** the
weak-point roll always (Rng draw-count determinism, blow.ts:22-26).

## 2. The attribute term itself — `data/weapon-scaling.ts`

- `ScalingGrade` ladder (ordinal, `None=0..S=6`): `weapon-scaling.ts:52-60`.
- `coefficientOf(grade)` reads `SCALING.weaponScaling.grades`:
  `weapon-scaling.ts:233-251`.
- `effectiveScaling(base, modifiers)` = base grade shifted by summed item/
  milestone grade-step modifiers, clamped to the ladder: `weapon-scaling.ts:293-302`.
- `contributionOf(value, grade)` = `above(value) * coefficientOf(grade) *
  SCALING.weaponScaling.damagePerPoint` — **measured from the starting
  attribute, not zero**: `weapon-scaling.ts:346-357`.
- `above(attr)` = `max(0, attr - SCALING.startingAttribute)`:
  `data/scaling.ts:72-75`. `startingAttribute = 5`: `data/scaling.ts:102`.
- `attributeScalingBonus` sums `contributionOf` over str/agi/int:
  `weapon-scaling.ts:370-376`.

**Grade coefficient table** (`data/scaling.ts:344-369`):

| Grade | coefficient | damage/point above starting-5 (coef × 0.15) |
|---|---|---|
| None | 0 | 0 |
| E | 0.15 | 0.0225 |
| D | 0.3 | 0.045 |
| C | 0.5 | 0.075 |
| B | 0.7 | 0.105 |
| A | 0.9 | 0.135 |
| S | 1.15 | 0.1725 |

**IMPORTANT — stale comment / value mismatch.** `data/scaling.ts:337-342`
(the outer docstring on the `weaponScaling` block) still says *"It is `2/3`
because `2/3 * 0.9` is exactly `0.6`"* — that is spec 216's original
rationale. The inner docstring six lines later (`data/scaling.ts:348-354`)
and the live value (`data/scaling.ts:355`) say the field was **"Retuned
from `2/3` to `0.15` by spec 217."** The executable value is **0.15**, not
2/3; the outer comment was never updated after the spec-217 retune. Anyone
reasoning from that outer comment alone gets the wrong coefficient by 4.4x.

A weapon with grade `None` on an attribute contributes **exactly 0** from
that attribute (`coefficientOf` default branch returns `table.none = 0`).
`stars.weighted` is the only mainHand weapon with `strength: None` — a
Strength character wielding it gets zero Strength contribution on
autoattacks, full stop.

## 3. Attack interval — Strength (and every attribute) is structurally excluded

`player/derived.ts:233-238` (Agility block) states outright: *"Agility:
animation only. Nothing here touches intervalTicks."* More generally,
`baseAttackTimeTicks` is computed in `player/stats.ts:263` as
`baseAttackTimeTicksFrom(bonus.attackCooldownTicks)`, and `attackSpeedPct`/
`attackSpeed` (haste) at `stats.ts:264-267` — all three read straight off
`ModifierTotals` (top-level `StatModifier` fields, `data/modifiers.ts:247,
259`), **not** off `TraitModifier`/`deriveTraits` (the attribute-derived
half, `player/derived.ts`). `TraitModifier` has no `attackCooldownTicks`/
`attackSpeed`/`attackSpeedPct` field at all — structurally, no attribute can
reach the interval. Confirmed by repo-wide grep: the only writers of those
three `StatModifier` fields are the 4 weapon rows in `data/items.ts` (sword
.keen, maul.iron, bow.hunting, stars.weighted); no specialization row
touches them.

Per-weapon `attackSpeedPct` (`data/items.ts`):

| Weapon | attackSpeedPct |
|---|---|
| sword.worn | (absent = 0) |
| sword.keen | +0.15 |
| maul.iron | -0.2 |
| staff.emberwood | (absent = 0) |
| bow.hunting | -0.1 |
| stars.weighted | +0.2 |

Interval formula (`sim/attack-timing.ts:247-260,321-341`):
`factor = (1 + attackSpeed/100) * attackSpeedMultiplier * attackSpeedSlowMultiplier`,
`intervalTicks = round(baseAttackTimeTicks / factor)`. Only the multiplier
terms move for a weapon (from `attackSpeedPct` split into growth/slow
buckets at `stats.ts:266-267`); `baseAttackTimeTicks` itself never moves for
a weapon (`BASE_ATTACK_TIME_TICKS`, `stats.ts:83`, is constant per body
unless an item grants flat `attackCooldownTicks`, which none of the six
mainHand rows do).

## 4. Weapons — exhaustive (`data/items.ts`, mainHand slot only)

| id | name | lvl | STR / AGI / INT | damage | attackSpeedPct | starting kit | loot table | vendor stock |
|---|---|---|---|---|---|---|---|---|
| sword.worn | Worn Sword | 1 | A / D / None | 1-3 | 0 | yes | — | quartermaster, rell |
| sword.keen | Keen Longsword | 5 | B / B / None | 3-6 | +0.15 | — | ravager (chance 0.5, weight 3/39) | armourer |
| maul.iron | Iron Maul | 5 | S / None / None | 4-11 | -0.2 | — | ravager (chance 0.5, weight 3/39) | armourer |
| staff.emberwood | Emberwood Staff | 4 | E / None / A | 2-5 | 0 | — | **none** | armourer |
| bow.hunting | Hunting Bow | 1 | D / A / None | 2-4 | -0.1 | yes | — | quartermaster, rell |
| stars.weighted | Weighted Stars | 1 | None / S / None | 1-3 | +0.2 | yes | slinger (chance 0.35, weight 4) | quartermaster |

All 6 are reachable; none unreachable. `staff.emberwood` is vendor-only
(armourer, no loot path).

## 5. Strength-scaling active skills (sigils) — exhaustive for the 4 named

`data/abilities.ts`, `G = ScalingGrade` (`abilities.ts:446`):

| ability id | scaling | item (`activeSkillId` owner) | item lvl req | rarity | acquisition |
|---|---|---|---|---|---|
| skill.guardBreak | STR B, AGI D (abilities.ts:615) | sigil.guardBreak | 1 | common | **starting kit only** — not in any DROP_TABLES entry, not in any vendor stock |
| skill.stunningBlow | STR A only (abilities.ts:641) | sigil.stunningBlow | 4 | rare | loot: ravager table, chance 0.5 × weight 3/39 ≈ 3.85%/kill; not in vendor stock |
| skill.whirlwind | STR A, AGI D (abilities.ts:672) | sigil.whirlwind | 5 | rare | loot: ravager table, chance 0.5 × weight 3/39 ≈ 3.85%/kill; not in vendor stock |
| skill.rendingCut | STR C, AGI B (abilities.ts:795) | sigil.rendingCut | 2 | common | loot: small_spider table, chance 0.25 × weight 1/7 ≈ 3.57%/kill; not in vendor stock |

**Flag:** `sigil.guardBreak` is granted once at character creation
(`data/items.ts` `STARTING_KIT`) and appears in **no** `DROP_TABLES` entry
and **no** vendor's `stock` array (only `sigil.witchlight` is sold, by the
quartermaster). If a player loses their starting Guard Break sigil (sold,
dropped, traded away), there is no documented in-game path to get another —
only an operator `admin:giveItem` action reaches it after that point.

None of the other three sigils are sold by any vendor either — all sigil
acquisition for these four is loot-only (or the one-time starting grant).

## 6. Files read

- `src/server/player/stats.ts` — `computeEffectiveStats`, `baseAttackTimeTicksFrom`
- `src/server/player/derived.ts` — `deriveTraits`, `NEUTRAL_TRAITS`, `armorFromAttributes`
- `src/server/data/weapon-scaling.ts` — grade ladder, resolver, contribution
- `src/server/data/scaling.ts` — `SCALING` table, `above()`, `linear/softCap/reciprocal`
- `src/server/sim/blow.ts` — `resolveBlow` (the 7-step order)
- `src/server/data/items.ts` — `ItemDefinition`, `DEFINITIONS`, `STARTING_KIT`
- `src/server/data/loot.ts` — `DROP_TABLES`, `rollLoot`
- `src/server/data/vendors.ts` — `VendorDefinition`, `DEFINITIONS`
- `src/server/data/abilities.ts` — the four `skill.*` rows (str-scaling ones)
- `src/server/data/modifiers.ts` — `StatModifier` vs `TraitModifier` split
- `src/server/sim/attack-timing.ts` — `attackSpeedFactor`, `resolveAttackTiming`
