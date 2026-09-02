# 271 — Strength as overpower

## Problem

Strength's tree is built around one loop — **commit → pressure Guard → break →
Momentum → punish → finish → continue** — and three links in it are broken or
missing. Spec 270's review measured the damage; this closes it.

**Guard pressure does not reach abilities.** `poiseDamageOf` reads
`isBasicAttack ? staggerPower : staggerPower * abilityPoiseFactor`, and
`abilityPoiseFactor` is granted by nothing since spec 244 deleted the pair
synergies. It resolves to 0, so every non-basic blow carries *zero* Guard
pressure and Crushing Blows — the flagship row, +79% at full investment — is
silently basic-attacks-only. The four Strength-scaling sigils get nothing from
the row the tree is built around.

**Guard Break bypasses the tree it belongs to.** Its first effect is
`{ kind: 'poise', amount: -50 }`, a flat write to the pool that scales with
nothing. A ravager's Guard is 49, so one press empties it at Strength 5 exactly
as at Strength 60, and the `{ poiseDamage: 6 }` behind it then breaks an empty
pool. A level-1 common sigil delivers Strength's identity mechanic better than
71 points of Strength.

**Heavy Handling is dead content.** Its gate is
`ability.damage >= HEAVY_ABILITY_DAMAGE` (6); the highest-damage ability in the
game is Whirlwind at 4. Spec 217 set that constant to 6 so `melee.heavy`
(damage exactly 6) would clear it; spec 237 then deleted `melee.heavy`. Three
purchasable points buy a number nothing multiplies.

Two smaller ones: `juggernautBelow` is a health gate whose only source sets it
to exactly `1`, so `if (gate < 1)` never runs; and Guard pressure is entirely
attribute-derived and per-hit, so a fast sword out-pressures a maul — the
weapon carries no impact identity at all.

## Shape

### Guard pressure becomes `staggerPower × impact`

One factor replaces the `isBasicAttack` branch. It is **authored**, never
derived from damage or from a scaling grade:

```ts
// data/abilities.ts — what this blow carries into a Guard pool.
interface AbilityDefinition {
  readonly guardImpact?: number;   // absent → traits.abilityPoiseFactor (0)
}

// data/items.ts — what this weapon carries. Basic attacks read it.
interface ItemDefinition {
  readonly guardImpact?: number;   // absent → DEFAULT_WEAPON_GUARD_IMPACT (1)
}

// sim/poise.ts
export function guardImpactOf(ability: AbilityDefinition, stats: EffectiveStats): number;
export function poiseDamageOf(stats: EffectiveStats, impact: number, multiplier: number): number;
//   => max(0, staggerPower * impact * multiplier)
```

`abilityPoiseFactor` stays live as the **fallback for an ability that authors no
impact**, which is 0 — so a row that says nothing carries nothing, and the trait
keeps a real reader without becoming the single global factor the brief rules
out.

`EffectiveStats.weaponGuardImpact` resolves the main hand's value once, beside
`weaponDamageMin`/`Max`, and rides the `Stats` message so a tooltip reads what
the sim reads. A monster has no weapon row, so `withTraits` fills in the
default.

### `poiseDamage` effects go through the same pipeline

`{ kind: 'poiseDamage' }` loses its required flat `amount` and gains an optional
`multiplier`, resolving through `poiseDamageOf` with the ability's own impact.
An authored `amount` remains legal for the one caller that genuinely wants an
absolute number (the Warden's laser, which has no attacker progression).

### Guard Break

`{ kind: 'poise', amount: -50 }` is removed. The row authors
`guardImpact: 3.4` and resolves through `applyPoiseDamage` like every other
blow — so it obeys hyper-armour, the immunity window, normal break handling and
break rewards, and it scales with Strength and with Crushing Blows.

### Executioner replaces Heavy Handling

`str.heavyHandling` is removed; `str.executioner` takes its threshold and tier
count, granting the orphaned `executeBonus`/`executeBelow`, which `blow.ts`
already reads as `executeBonus > 0 && staggered && healthFraction <= executeBelow`
— exactly "broken and nearly finished". `heavyWindupReduction`,
`heavyWindupScale` and `HEAVY_ABILITY_DAMAGE` go with it.

### Smaller pieces

- `str.overkill` renames to **Brutal Reserve** (id unchanged — it is persisted).
- `juggernautBelow` is dropped from Unstoppable's grant and its branch removed
  from `poiseArmorOf`. The field stays in `TraitStats` (deleting one is a
  protocol change) and is documented as dormant.
- `audit:progression` gains a **reachability pass**: a table of trait → gating
  predicate over the content tables, reporting a trait whose consumer no
  content can satisfy.

## Invariants tested

- Guard pressure is `staggerPower × impact × multiplier`; a basic attack takes
  the weapon's impact and an ability its own.
- An ability that authors no `guardImpact` carries **zero** Guard pressure.
- Crushing Blows raises Guard pressure on basic attacks **and** on abilities
  that carry impact, and every tier plus the milestone moves it.
- Guard Break performs no direct Guard subtraction; it does not reliably break a
  representative target at low Strength, does at high Strength, and improves
  measurably with Crushing Blows.
- A Guard break through an ability grants Momentum exactly as one through a
  basic attack does, and runs the same immunity and hyper-armour rules.
- Momentum shortens the wind-up and leaves `baseAttackTimeTicks` untouched.
- Committed Swing's four sources still sum to exactly the 0.9 cap, and no
  purchased tier is redundant.
- Executioner fires only on a staggered target under its health threshold;
  every tier moves the outcome; it is not generic low-health damage.
- Brutal Reserve restores resource on a qualifying overkill and not otherwise.
- Unstoppable still extends hyper-armour to non-basic casts with no health gate.
- The maul delivers more Guard pressure per hit than the keen sword, and the
  keen sword can still win on cadence.
- Stagger immunity is unchanged: no chain-lock.
- The audit reports a specialization whose consumer gate no content satisfies,
  and does not false-positive on a live conditional mechanic.

## Out of scope

- The other five attributes. No AGI/INT/CON/PER/WIS row changes.
- Explicit pair synergies. `data/synergies.ts` stays deleted, and no pair
  contributes a modifier neither half contributes alone.
- `breakResource` and `breakCooldownRefund` stay dormant. Momentum remains the
  only break reward.
- A semantic `heavy` ability tag. If one is wanted later it is its own spec.
- New active abilities, new statuses, new resources, enemy rebalancing, and any
  weapon change beyond the authored impact value.
