# 217 — A weapon's damage is its own

## Problem

Three things, and they are one thing.

**A weapon has no damage of its own.** A basic attack is
`ability.damage * weaponPower`, so the number that decides how hard a swing hits
is a field on `melee.slash` -- shared by every sword, every maul and every
monster in the game -- and what a weapon contributes is a *multiplier* assembled
out of `attackDamage`. There is nowhere to write "this sword hits for 1 to 3".

**Every melee monster hits for exactly 14.** `monsterTraits` spreads
`NEUTRAL_TRAITS`, whose `weaponPower` is 1, so a monster's blow is
`melee.slash.damage * 1` and the `attackDamage` its row authors reaches nothing
but its stagger power. The Ravager's 24 and the Grazer's 6 land identically; the
Training Dummy authors 0 and hits for 14. Measured, not reasoned:
`weaponPower 1.00, ACTUAL per blow 14.0` on every row but the Slinger's.

**The numbers are an order of magnitude too big to read.** A fresh character
swinging the Worn Sword hits a 24-health Grazer for 26.3 and deletes it, and
nothing about that hit is legible as a quantity.

## Shape

A weapon authors a **range**, and the range is the damage.

```ts
export interface WeaponDamage {
  readonly min: number;
  readonly max: number;
}
// on ItemDefinition, beside `scaling` (spec 216)
readonly damage?: WeaponDamage;      // absent -> UNARMED_DAMAGE
```

Resolved onto the body, with spec 216's attribute term already inside it:

```ts
// EffectiveStats
readonly weaponDamageMin: number;
readonly weaponDamageMax: number;
// = (weapon.min|max + attributeScalingBonus + bonus.attackDamage) * (1 + pct)
```

`attackDamage` stays, as the **midpoint** of that range: it is what the
character sheet's Damage row shows and what a monster's stagger power is sized
off, and both want one number rather than two.

`resolveBlow` gains one line and loses one:

```ts
const base = isBasicAttack
  ? rollBetween(A.weaponDamageMin, A.weaponDamageMax, rng)   // one draw
  : ability.damage * attacker.stats.spellPower;
```

`TraitStats.weaponPower` is **removed**. Its only production reader was the line
above; leaving a replicated float that says "how hard you hit" and is read by
nothing is the decay this repo keeps finding.

A monster's range is `min = max = ` its authored `attackDamage`, filled in by
`withTraits` the way `NO_WEAPON_SCALING` already is. That is the whole of the
second bug: the number a row authors becomes the number it hits for.

**The draw.** One `nextInt`, taken *before* the crit roll, and only for a basic
attack. Conditioning on `isBasicAttack` is safe where conditioning on a chance
would not be: it is a property of the ability row, fixed for a given id, so two
replays of the same input always draw the same count. The Rng draw count is
protocol, so this moves every seeded combat sequence in the tree once, on
purpose.

**The baseline.** Spec 216's attribute term is re-based through `above()` --
the rule `data/scaling.ts` already states and applies to every other scale --
so a character who has spent nothing gets nothing from scaling, and the Worn
Sword's `1-3` is exactly what a fresh character hits for rather than the small
half of a bigger sum.

## Invariants tested

- A basic attack lands within its weapon's resolved range, inclusive, over many
  rolls -- and hits both ends of it.
- Two replays of the same seed and inputs produce identical damage, and the
  draw count of a blow does not depend on the attacker's stats.
- A monster hits for what its row authors: the Ravager and the Grazer differ,
  and the Training Dummy's 0 is 0.
- A weapon with no `damage` row falls back to the unarmed range rather than to
  zero; an empty hand uses it too.
- The range still carries spec 216's scaling: Strength moves the maul's range
  and does not move the Weighted Stars'.
- A fresh character's Worn Sword hits inside `1..3` exactly.
- Ability damage is untouched -- a non-basic attack still reads `ability.damage`
  and `spellPower`, and no weapon range reaches it.
- `attackDamage` is the midpoint of the resolved range.
- Armour, crit, weak points, shields and the whole of the rest of `resolveBlow`
  still apply to the rolled number.

## Out of scope

- Rounding damage to integers. The roll is integral on the weapon's own range;
  everything downstream stays fractional, as it already is.
- Damage *types*, resistances, or a second range for abilities.
- Re-tuning the twelve balance presets. `npm run balance` will move; reading it
  is the follow-up, not this.
