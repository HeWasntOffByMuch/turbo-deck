# 184 — The damage a monster row authors

## Problem

Every melee monster in the game hits for exactly 14, whatever its row says.

`data/monsters.ts` authors an `attackDamage` per row -- 6 for the grazer, 11 for
the stalker, 24 for the ravager, 5 for the small spider, 9 for the slinger --
and the file's own header says that "every number it fights with is read from
here". The damage is the one number that is not. Measured off the shipped
tables:

```
grazer         attackDamage=  6   weaponPower=1   melee.slash (14)  -> 14
stalker        attackDamage= 11   weaponPower=1   melee.slash (14)  -> 14
ravager        attackDamage= 24   weaponPower=1   melee.slash (14)  -> 14
small_spider   attackDamage=  5   weaponPower=1   melee.slash (14)  -> 14
slinger        attackDamage=  9   weaponPower=1   ranged.star  (8)  ->  8
```

The cause is one line that was never written. `sim/blow.ts` multiplies a basic
attack by `traits.weaponPower`, and `player/derived.ts` derives that from a
body's `attackDamage` against the unarmed reference -- but only in
`deriveTraits`, the player's path. `monsterTraits` beside it takes `maxHealth`
and a stagger power and returns `NEUTRAL_TRAITS` with the poise fields
overridden, so `weaponPower` falls through at its neutral 1 and a monster's blow
is the ability's own authored damage. Every body swinging `melee.slash` is
therefore the same blow, and the ravager's 24 and the spider's 5 -- a range of
nearly five to one -- are the same number to the resolver.

This is exactly the hole spec 147 found and closed, one body short: *"`applyDamage`
multiplied every blow by `spellPower` and read `attackDamage` nowhere at all, so
Strength's damage coefficient had been decorative since spec 062."* The fix
introduced `weaponPower` and routed the player's damage stat into it. Monsters
went on being the earlier bug, and stayed inside a function whose doc comment
says "everything else stays neutral" -- which is right about weak points, flow
and adaptation, and wrong about how hard the body hits.

What made it survive is that the number is *live everywhere except in a blow*.
It is authored, it is summed into stagger power (`withTraits` reads it two lines
above), it rides the wire in `EffectiveStats`, and the admin console prints it in
the player table. Nothing looks unplugged.

What the bug costs is the design intent of the whole roster: the ravager is
authored as the heaviest thing on the map and hits like the grazer, the four
spiders you are meant to win against by swinging hit as hard as the thing that
takes 140 damage to kill, and the slinger's throw is under-tuned in the other
direction.

## Shape

`player/derived.ts` -- one rule, one place, because there are now two bodies
that need it and the `DeriveContext` doc already states that there must not be
two of it:

```ts
/** The Damage row, as a multiplier a basic attack is multiplied by. */
export function weaponPowerFor(attackDamage: number): number;
```

`deriveTraits` calls it where it inlined the expression. `monsterTraits` gains
the argument it was missing:

```ts
export function monsterTraits(
  maxHealth: number,
  staggerPower: number,
  attackDamage: number,
): TraitStats;
```

Required rather than defaulted, and third rather than optional: a default is how
the one caller that matters silently keeps not passing it, which is the shape
this bug already had once.

`data/monsters.ts` -- `withTraits` passes `monster.stats.attackDamage`, which it
is already holding for the stagger power on the line above.

**The reference is the player's**, not a per-row scale: `attackDamage` divided
by `PLAYER_ATTACK_DAMAGE` (8), the same denominator a player's swing is measured
against. That is what keeps "one shape, one code path" -- monsters.ts's own
stated reason for expressing a row as a full `EffectiveStats` -- a fact about
the module graph rather than a claim. A body authored at the reference damage
hits for exactly what the ability says, whoever it is.

What the roster does after the change, per basic attack before mitigation:

| row | attackDamage | was | is |
|---|---|---|---|
| grazer | 6 | 14 | 10.5 |
| stalker | 11 | 14 | 19.25 |
| ravager | 24 | 14 | 42 |
| small_spider | 5 | 14 | 8.75 |
| slinger | 9 | 8 | 9 |

Two of those move a long way and both are the point. The ravager swings once
every 2.25s and is the one body on the map that starts nothing, so a player
walks into that 42 by choosing to; the spider swings every 0.8s and comes in
fours, and four of them at 14 was 56 damage a second against a 100-health
player -- the fight the row's comment describes as "one you win by swinging"
was one nobody could survive.

## Invariants tested

- `weaponPowerFor(PLAYER_ATTACK_DAMAGE)` is 1, and it is linear either side of
  it, so an authored row and a player's sheet mean the same thing by the number.
- `monsterTraits` returns a `weaponPower` derived from the `attackDamage` it was
  handed, and still returns neutral values for everything progression owns
  (weak points, flow, adaptation, shields).
- Every row in `MONSTERS` -- the dummy included -- has
  `traits.weaponPower === stats.attackDamage / PLAYER_ATTACK_DAMAGE`, so a row
  added later cannot be a body whose damage reaches nothing.
- Through `resolveBlow` against an identical unarmoured target, each monster's
  own basic attack lands `ability.damage * attackDamage / 8`: the ravager's
  slash is measurably heavier than the spider's, where before they were equal.
- The player path is unchanged: `deriveTraits` returns the same `weaponPower` it
  did before the extraction, for the same context.
- The dummy authors 0 damage and derives a `weaponPower` of 0, so scenery with a
  health bar cannot start dealing 14.

## Out of scope

- **Retuning the rows.** This spec makes the authored numbers reach a blow; it
  does not change one of them. If 42 is the wrong number for the ravager, that
  is now a one-line edit in `monsters.ts` that visibly does something, which is
  the state this spec exists to reach.
- **`spellPower` for monsters.** Every row's `basicAttackId` names a
  `basicAttack: true` ability, so the non-basic multiplier is not on any monster's
  path today. A row that names a non-basic ability would scale with its
  `spellPower` of 1 -- correct by the same rule, and untested here because
  nothing exercises it.
- **The other authored numbers.** `armor`, `critChance`, `attackRange` and
  `baseAttackTimeTicks` are read by the resolver already and are not touched.
- **The balance harness.** `npm run balance` fights the twelve player presets
  against each other and does not read the monster table.
