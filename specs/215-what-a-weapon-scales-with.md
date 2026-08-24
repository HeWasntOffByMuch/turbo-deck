# 215 — What a weapon scales with

## Problem

Every weapon in the game scales the same way, and the way is Strength. The
`attackDamage` line in `player/stats.ts` reads

```
PLAYER_ATTACK_DAMAGE + DAMAGE_PER_STRENGTH * STR + agility.damagePer * AGI + bonus.attackDamage
```

for the maul, the rapier-shaped Keen Longsword, the hunting bow and the
Emberwood Staff alike -- so what a player is holding cannot express *what kind
of character it is for*. The two rates are also an order apart (0.6 against
0.15), which means the Agility term is not a design choice a weapon makes but a
rounding error every weapon carries, and Intelligence reaches a basic attack not
at all: the staff's own `spellPower` is read by `resolveBlow` only for abilities,
so swinging it is a Strength act.

This spec makes the *weapon* say which attributes it scales with, as a letter
grade per attribute, and makes one table say what a letter is worth.

## Shape

Four things, in the deterministic core.

**The grade**, `src/server/data/weapon-scaling.ts` -- a const object with
ordinal values, the `StatusId` pattern, because every operation on a grade is
step arithmetic and clamping:

```ts
export const ScalingGrade = { None: 0, E: 1, D: 2, C: 3, B: 4, A: 5, S: 6 } as const;
export type ScalingGrade = (typeof ScalingGrade)[keyof typeof ScalingGrade];

export interface WeaponScaling {
  readonly strength: ScalingGrade;
  readonly agility: ScalingGrade;
  readonly intelligence: ScalingGrade;
}
```

**The coefficients**, in `SCALING` and nowhere else, because `data/scaling.ts`
already states its own reason to exist: *a balance pass on this system should be
a diff of this file and nothing else*. Nothing outside it may spell a
coefficient, and `coefficientOf(grade)` is the only reader.

```ts
SCALING.weaponScaling = {
  damagePerPoint: 2 / 3,
  grades: { none: 0, E: 0.15, D: 0.3, C: 0.5, B: 0.7, A: 0.9, S: 1.15 },
};
```

`damagePerPoint` is **one rate for all three attributes**, and that is the half
of this spec that makes grades mean anything. With Strength at 0.6 per point and
Agility at 0.15, an `A` in Agility would be worth less than an `E` in Strength
and no amount of grading could balance the two; the differentiation has to live
in the grade or it does not live anywhere. It is `2/3` because `2/3 * 0.9` is
`0.6` -- grade `A` reproduces the Strength rate this spec inherits exactly, so
the migration below moves no Strength build's damage at all.

**The base scaling**, one optional field on the row a weapon already is:

```ts
readonly scaling?: WeaponScaling;   // absent -> NO_SCALING
```

**The modifiers**, three flat fields on `StatModifier` beside the six attribute
grants, summed by `sumModifiers` with everything else:

```ts
readonly strengthScalingGrade?: number;      // steps, not coefficients
readonly agilityScalingGrade?: number;
readonly intelligenceScalingGrade?: number;
```

And one resolver both the damage and the tooltip go through:

```ts
export function effectiveScaling(base, modifiers): WeaponScaling;
export function attributeScalingBonus(attributes, scaling): number;
export function explainScaling(attributes, base, modifiers): ScalingBreakdown;
```

The damage formula, replacing the two hard-coded attribute terms:

```
attackDamage = (PLAYER_ATTACK_DAMAGE + bonus.attackDamage + attributeScalingBonus) * (1 + bonus.attackDamagePct)
attributeScalingBonus = damagePerPoint * (STR * c(effSTR) + AGI * c(effAGI) + INT * c(effINT))
```

`weaponPower`, `resolveBlow` and every modifier after it are untouched: this
changes what the Damage row *is*, not what happens to it afterwards.

The three resolved modifier steps ride `EffectiveStats` and the `Stats` message
so the bag can resolve the effective scaling of an item it is only *hovering*,
which is a thing the equipped weapon's own resolved grades cannot answer.

## Invariants tested

- `S` contributes more than `B` for identical inputs; `None` contributes exactly
  zero; a weapon with no scaling deals its base damage and nothing more.
- Agility scaling reads Agility and Intelligence scaling reads Intelligence --
  asserted by moving one attribute at a time.
- Constitution, Wisdom and Perception move no weapon scaling damage.
- A hybrid weapon takes a contribution from each configured attribute.
- Coefficients are read from `SCALING` alone: retuning `B` moves every `B`
  weapon, and no second copy of the ladder exists in the tree.
- `+1` advances one tier, `+2` two, negatives descend; `S + 1` is `S` and
  `None - 1` is `None`; several modifiers on one attribute sum before clamping.
- Resolution never mutates the weapon's own row: the base is the same object
  before and after, and dropping the modifier restores the base exactly.
- Swapping weapons re-resolves against the same modifiers.
- The tooltip's grades come from `effectiveScaling` -- asserted by moving a
  modifier and reading the line, not by re-deriving it.
- The line is `STR / AGI / INT` in that fixed order, one character each, `-` for
  `None`, and the three characters carry the three attribute colour tokens while
  the separators carry the tooltip's own.
- Existing weapon damage still passes through crit, weak point, armour and the
  rest of `resolveBlow` unchanged.

## Out of scope

- Percentage or flat *numeric* scaling modifiers. Grade steps only.
- Grades outside `None..S`. No `S+`, no `F`.
- Showing base and effective side by side. The view-model returns both so a
  later spec can, and the tooltip draws the effective one.
- Monsters. `monsterTraits` is sized off health and has no weapon row to read.
- Re-pointing abilities at weapon scaling: `resolveBlow` still splits basic
  attacks from abilities on `ability.basicAttack`, and a spell still scales with
  `spellPower`.
