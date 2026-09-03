# Damage scaling: Intelligence -> spellPower -> a blow (spec 216/217/238)

Traced 2026-09-01. Read the actual code before trusting this if any of the
cited files have since moved — this is a summary, not a source.

## The three addends of a blow (src/server/sim/blow.ts:233-242, `resolveBlow`)

```
base = ability.damage                                    // flat row number
     + (isBasicAttack ? 0 : abilityAttributeBonus(        // ability's OWN letters
         attacker.stats.scalingAttributes,
         abilityGradesOf(ability.scaling),
         attacker.stats.spellPower))
     + weaponRoll * weaponFactor                          // weapon's own roll
```
`isBasicAttack = ability.basicAttack === true` (blow.ts:146).
`weaponFactor = isBasicAttack ? 1 : abilityWeaponFactor(ability.scaling)`
(blow.ts:169) — no shipped non-basic ability declares a `weapon` fraction
today (comment at blow.ts:161).

**spellPower enters at exactly one point**: inside `abilityAttributeBonus`,
and only when `!isBasicAttack`. **A basic attack never sees spellPower** —
the ability-owned term is hard-zeroed for it, full stop. Everything after
`base` (crit, weak point, exposure, catalysis, execute, armour, adaptation,
resolve...) is a *multiplier* on the running number, never a second source.

## Two separate ways Intelligence reaches damage

1. **spellPower path** (non-basic abilities only): `spellPower` multiplies
   only the Intelligence *contribution* of an ability's own declared grades
   (`data/ability-scaling.ts:165-174`, `abilityContributionOf`). spellPower
   itself is `Math.max(0, 1 + bonus.spellPower)`
   (`src/server/player/stats.ts:287`) — **Intelligence the attribute is NOT a
   term in spellPower** (removed by spec 238, comment at stats.ts:271-286).
   `bonus.spellPower` only comes from items/specs: `staff.emberwood` (+0.2),
   `focus.quartz` (+0.12), `int.potency` (+0.05/tier, 3 tiers,
   `data/specializations.ts:163-165`). So Intelligence is linear, not
   quadratic: attribute value appears once, in `contributionOf(value, grade)`;
   spellPower (fed by gear/specs, never by Intelligence) multiplies that.

2. **Weapon-letter path** (basic attacks, and anything with a `weapon`
   fraction): a weapon can author its own `intelligence` grade (only
   `staff.emberwood`: `{strength: E, agility: none, intelligence: A}`,
   `data/items.ts:222`). This feeds `attributeScalingBonus` in
   `player/stats.ts:230` -> `weaponDamageMin/Max` -> `weaponRoll` in
   blow.ts. **This path is never touched by spellPower** — confirmed
   explicitly in `ability-scaling.ts:259-261` ("Spell Power is deliberately
   not applied here: this term is the *weapon's* scaling").

Formula chain for either path: `contributionOf(value, grade) = above(value)
* coefficientOf(grade) * SCALING.weaponScaling.damagePerPoint`
(`data/weapon-scaling.ts:346-356`). `above(v) = max(0, v -
SCALING.startingAttribute)`, `startingAttribute = 5`
(`data/scaling.ts:72-75,102`). `damagePerPoint = 0.15`; grade coefficients
`{none:0, E:0.15, D:0.3, C:0.5, B:0.7, A:0.9, S:1.15}`
(`data/scaling.ts:355-368`). An ability's own letters are capped at
coefficient sum 1.2 (`coefficientBudget`, `data/scaling.ts:418`), asserted
in `ability-scaling.test.ts`.

## Intelligence-scaling abilities (src/server/data/abilities.ts)

All `skill: true`, all gated by `startCast` on `entity.stats.skillAbilityIds`
(`sim/abilities.ts:595`), which is derived off the four `skill1..skill4`
equipment slots (`player/skill-slots.ts:66`, `player/stats.ts:319`) — so a
player must have the sigil *equipped*, not just owned.

| ability id | grades | dmg | cost | cooldown | effect | sigil (items.ts) | lvl |
|---|---|---|---|---|---|---|---|
| skill.emberToss | int B, agi D | 2 | 5 | 8s | applyDot(Burn) | sigil.emberToss | 4 |
| skill.acidSpray | int A | 1 | 6 | 10s | applyDot(Corrosion) | sigil.acidSpray | 4 |
| skill.arcLash | int A | 2 | 6 | 9s | applyDot(Shock) | sigil.arcLash | 5 |
| skill.rimeTouch | int A | 1 | 5 | 11s | applyDot(Frostbite) | sigil.rimeTouch | 5 |
| skill.blight | int A | 1 | 6 | 12s | applyDot(Decay) | sigil.blight | 6 |
| skill.scorchedEarth | int A | 0 | 7 | 24s | applyStatus(ScorchedEarth) -> field lays Burn | sigil.scorchedEarth | 6 |

All six are reachable — every one has a matching sigil with `activeSkillId`
set. Plus `ranged.ember` (Emberwood Staff's basic attack, `basicAttack:
true`, `scaling: {weapon:1}`, `damage: 0`) reaches Intelligence only via the
staff's own `intelligence: A` weapon grade, never via spellPower.

No monster in `data/monsters.ts` references any of these six ability ids.

## Afflictions (src/server/sim/damage-over-time.ts, data/damage-over-time.ts)

`applyDot` (sim/damage-over-time.ts:172-190) sets
`magnitude = max(0, abilityEffectPowerOf(ability.scaling, source.stats))` —
**the applying ability's own declared scaling, not `source.stats.spellPower`
outright** (spec 238; before it, every affliction was Intelligence-scaled
regardless of what applied it).

`abilityEffectPower` (`data/ability-scaling.ts:221-238`):
```
scaled = abilityAttributeBonus(attributes, grades, spellPower) / SCALING.weaponScaling.damagePerPoint
result = max(0, 1 + scaled * SCALING.abilityScaling.effectPerPoint)   // effectPerPoint = 0.05
```
So spellPower still reaches an affliction's magnitude, but only through the
same single Intelligence-letter contribution as the damage path — re-based
from the damage rate onto `effectPerPoint`, not a second multiplication.
A caster with no attribute investment gets exactly `1` (the table's flat
rate); a row with no scaling is `1` forever.

Pulse damage: `dotPulseDamage(row) * stacks * magnitude * ramp * exertion`
(sim/damage-over-time.ts:113-124), where `dotPulseDamage(row) =
damagePerSecond * intervalTicks / SERVER_TICK_RATE`
(data/damage-over-time.ts:227-229).

Rows landed by the six Intelligence abilities:
- Burn (emberToss, and Scorched Earth's field): 1.3 dps, 0.5s interval, 8
  pulses, maxStacks 1, spreadRadius 90.
- Corrosion (acidSpray): 0.6 dps, 0.5s, 12 pulses, maxStacks 3,
  guardPerSecond 14, sunderMagnitude 0.12 (-> StatusId.Sundered, read by
  blow.ts's armour mitigation).
- Shock (arcLash): 1.1 dps, 0.75s, 6 pulses, maxStacks 1, spreadRadius 150.
- Frostbite (rimeTouch): 0.3 dps, 0.5s, 16 pulses, maxStacks 1,
  rampPerSecond 0.35, rampCap 3 (escalates while held).
- Decay (blight): 0.2 dps, 1s, 10 pulses, maxStacks 1, healingScale 0.4.

Scorched Earth (`skill.scorchedEarth`) does not damage directly (`damage:
0`); it applies `StatusId.ScorchedEarth` to the caster via `applyStatus`
(no `effect.magnitude` authored, so `sim/skill-effects.ts:216-221` fills it
with `abilityEffectPowerOf(ability.scaling, caster.stats)` at cast time —
one snapshot). `sim/aura-field.ts:130-191` (`pulseAuraFields`) re-lays Burn
(`data/aura-fields.ts` `SCORCHED_EARTH_ROW`: radius 130, lingerTicks 60,
maxTargets 6) on every body inside every tick, passing that snapshotted
magnitude straight to `landDot` as the Burn's own magnitude — never a live
read of the caster's current spellPower.

## Open questions / not verified further
- Whether monsters ever author `scaling` on their own ability rows
  (unlikely; monsters build `EffectiveStats.spellPower: 1` directly in
  `sim/world.ts`, bypassing the attribute-derivation pipeline).
- `trinket.runic`'s `intelligenceScalingGrade: 2` shifts a *weapon's*
  resolved Intelligence grade (`effectiveScaling`), not an ability's own —
  `abilityGradesOf` is explicitly documented as not reading
  `scalingModifiers` (`data/ability-scaling.ts:117-125`). Not fully traced
  through `effectiveScaling`'s call sites; take the above as directional.
