# 238 — What an ability scales with

## Problem

**Every active ability in the game is an Intelligence ability.** `resolveBlow`
computes a non-basic blow as `ability.damage * attacker.stats.spellPower`, and
`spellPower` is `1 + 0.04 * Intelligence`. So Whirlwind -- *one turn, all the way
round, blade out* -- gets stronger because a player invested in Intelligence,
and there is no field on a row that could say otherwise. Spec 216 gave a
*weapon* a letter per attribute and left abilities where they were, so half the
game's offence is explicit and the other half is one hard-coded multiplier.

**And so is every affliction.** `applyDot` captures the applier's `spellPower`
as the pulse magnitude, so Rending Cut's Bleed -- a cut that will not close --
grows with Intelligence and with nothing else. A martial build that lands it
gets the table's flat rate forever. `sim/aura-field.ts` reads the carrier's live
spell power for the same purpose, which is worse: it is not even a snapshot.

**There is nowhere to say "this is your weapon, thrown".** An Axe Throw or an
Arrow Flurry is an extension of the thing in your hand, and expressing that
today means special-case damage code in whatever lands it.

## Shape

One coefficient language. The ladder, the letters, the clamp and the per-point
rate stay `data/weapon-scaling.ts`'s and `SCALING.weaponScaling`'s; what is new
is whose letters they are.

```ts
// data/ability-scaling.ts
export interface AbilityScaling {
  readonly strength?: ScalingGrade;
  readonly agility?: ScalingGrade;
  readonly intelligence?: ScalingGrade;
  /** Fraction of the equipped weapon's own damage this ability carries, 0..1. */
  readonly weapon?: number;
}
// on AbilityDefinition, beside `damage`
readonly scaling?: AbilityScaling;   // absent -> scales with nothing
```

Constitution, Perception and Wisdom are absent **by construction** -- the type
names three attributes, so a row cannot author a Wisdom damage grade even by
accident.

The damage becomes three addends, summed once, in `resolveBlow`:

```
base = ability.damage                    the row's own flat number
     + abilityAttributeBonus(...)        its declared STR/AGI/INT letters
     + weaponRoll * weaponFactor         the fraction of the weapon it is
```

A **basic attack** is the third addend alone (`{ weapon: 1 }`, `damage: 0`),
which is bit-for-bit what it was.

The three attribute values every grade resolves against ride `EffectiveStats`:

```ts
readonly scalingAttributes: ScalingAttributes;   // STR/AGI/INT after all grants
```

A weapon can fold its term into `weaponDamageMin/Max`; an ability cannot,
because which grades apply depends on which ability.

**Spell Power multiplies what Intelligence buys, and nothing else.** Its own
Intelligence term is removed from `player/stats.ts` -- Intelligence already
appears once as the attribute the grade resolves against, and leaving it in
would make an Intelligence ability quadratic in Intelligence.

Effects that are not damage -- an affliction's pulse, a slow's bite, a field's
linger -- take a single multiplier from the same letters at their own rate:

```ts
export function abilityEffectPowerOf(scaling, stats): number;   // 1 at no investment
```

`SCALING.abilityScaling.effectPerPoint` is chosen to reproduce the curve it
replaces: an `A` at 50 Intelligence is 3.025 against the old `spellPower` 3.0.

## Invariants tested

- Every production row answers the scaling question from the table alone; no
  row exceeds `SCALING.abilityScaling.coefficientBudget`.
- Every basic attack is `{ weapon: 1 }` with `damage: 0` and no letters of its
  own, and the `basicAttack` branch produces the same number the general path
  does from that row.
- Pure STR / pure AGI / pure INT abilities move with their own attribute and
  with neither of the other two.
- A stat hybrid is **additive**: both attributes together equal both apart.
- A weapon-derived ability tracks the weapon's resolved damage, and half the
  weapon is half the damage.
- A weapon + stat hybrid moves with both and its weapon half smuggles in no
  second attribute term.
- An unscaled ability is the same number at every build.
- Spell Power amplifies an Intelligence ability, cannot reach a Strength one,
  and no longer carries an Intelligence term of itself.
- An affliction from an ability that declares nothing is worth exactly the
  table's rate; one from a martial ability grows with Strength and not with
  Intelligence.
- No martial skill declares an Intelligence grade.
- A row that scales with nothing gets no scaling line; a basic attack gets none
  either, because the weapon's own tooltip already prints its grades.

## Out of scope

- **No stat gating.** Scaling decides effectiveness, never permission. A
  low-Strength character may still cast a Strength ability, badly.
- **No new production abilities.** Weapon-derived and weapon+stat hybrid modes
  are exercised by test rows; no shipped ability declares a weapon fraction,
  which is also why no seeded combat sequence moved a second time.
- Constitution, Perception and Wisdom as generic damage scaling.
- Ability grades are **not** shifted by `scalingModifiers`. Those are authored
  as weapon scaling steps; the weapon-derived term carries them already, because
  it reads the weapon's resolved damage.
- Rebalancing the authored grades. The letters are a first classification
  rather than a settled one; `skill.emberToss` at `- / D / B` for a thrown
  incendiary is the one most obviously arguable, since what a pot of embers is
  worth could as easily be read off the arm that threw it.

  Written against the roster as it stood, this paragraph also named `bolt.lob`
  and `ground.quake`; spec 237 deleted both along with five other rows nothing
  granted, so the argument survives only in the row that is still in the game.
