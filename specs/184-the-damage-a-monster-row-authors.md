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

`sim/blow.ts` multiplies a basic attack by `traits.weaponPower`, and
`monsterTraits` returns `NEUTRAL_TRAITS` with the poise fields overridden -- so
`weaponPower` is 1 for every body in the table and a monster's blow is the
ability's own authored damage. The ravager's 24 and the spider's 5 are the same
blow.

### This was a decision, not an oversight

Worth stating plainly, because the first draft of this spec got it wrong and
that is the more useful finding. Spec 147 introduced `weaponPower` to close the
same hole on the player's side -- `applyDamage` had multiplied every blow by
`spellPower` and read `attackDamage` nowhere since spec 062 -- and it explicitly
declined to extend it here:

> Monsters keep `weaponPower: 1` through `monsterTraits`, so nothing in the
> existing content is re-tuned by this.

That was the right call *for 147*, whose subject was six player attributes and
which had no business silently rescaling five monsters on its way past. But it
left the field parked: authored, replicated in `EffectiveStats`, summed into
stagger power two lines above in `withTraits`, printed in the admin console, and
reaching no blow. Nothing looks unplugged, and `npm run balance` fights the
twelve player presets against each other, so no instrument in the tree was ever
going to object.

Before 147 the formula was `ability.damage * spellPower` with monsters at
`spellPower: 1`, so a monster's blow has been flat ability damage since spec 062
and its `attackDamage` has never reached one in any version of this game.

### The reading the rows were authored under

The rows say which one they meant. The spider's comment:

> the fastest base attack time in the table is the only thing that makes **5
> damage** matter

It calls the 5 damage -- the thing that lands. So does the shape of the numbers:
6, 11, 24, 5, 9 are damage figures, not multipliers, and the pre-062 constant
they descend from (`ENEMY_ATTACK_DAMAGE = 15`) was flat damage per blow.

The same comment also says "22 health is two player swings", and a starting
player's slash is 20.5625, so 22 is 1.07 swings. That half went stale when 147
gave the *player* a `weaponPower`, and nobody noticed then either -- for exactly
the reason nobody noticed this. A number nothing reads cannot be observed to be
wrong.

## Shape

**A row's `attackDamage` is the damage it lands**, per blow, before the target's
armour. Five is five.

That is a different rule from the player's, where `attackDamage` is a *power*
measured against the unarmed reference, and the difference is the point rather
than an inconsistency. A player's damage is derived from attributes, level and
gear and is a different number every session, so it can only be stated relative
to something. A monster's row is authored by hand and read by a person deciding
whether a fight is fair, and relative-to-what is a question that person should
never have to ask.

`resolveBlow` does not move. It computes `ability.damage * weaponPower` for
every body in the world, and what changes is only how a monster's multiplier is
arrived at -- in `data/monsters.ts`, which is the one file holding both the row
and the ability it names:

```ts
/** The multiplier that makes this row's blow land its authored damage. */
function weaponPowerOf(stats: AuthoredStats): number {
  const ability = abilityById(stats.basicAttackId);
  if (!ability || ability.damage <= 0) return 0;
  return Math.max(0, stats.attackDamage / ability.damage);
}
```

`player/derived.ts` is left as spec 147 wrote it, and `monsterTraits` takes the
multiplier already worked out rather than an `attackDamage` to divide down:

```ts
export function monsterTraits(
  maxHealth: number,
  staggerPower: number,
  weaponPower: number,
): TraitStats;
```

Required rather than defaulted, because a default is how a body ends up back at
the neutral 1 with nobody noticing. That function has no business knowing the
ability table, and the division cannot be done without it.

The degenerate rows answer **0, not 1**. The training dummy names no ability;
a row naming a damageless one has nothing for a multiplier to scale. 1 is the
neutral, and the neutral is precisely the value that made a monster deal its
ability's damage regardless of its row.

What the roster does after the change -- per basic attack, before mitigation,
which is the column the table already authored:

| row | attackDamage | ability | was | is |
|---|---|---|---|---|
| grazer | 6 | melee.slash (14) | 14 | 6 |
| stalker | 11 | melee.slash (14) | 14 | 11 |
| ravager | 24 | melee.slash (14) | 14 | 24 |
| small_spider | 5 | melee.slash (14) | 14 | 5 |
| slinger | 9 | ranged.star (8) | 8 | 9 |

The two abilities are what make this per-row rather than a rescale: a rule
expressed against one shared reference cannot land both 24 off a 14-damage slash
and 9 off an 8-damage star.

## Invariants tested

- Through `resolveBlow` against an unarmoured target, **every row lands exactly
  its own `attackDamage`** -- equality, not proportionality, so a change that
  rescaled the roster uniformly fails here instead of passing an ordering check.
- The slinger and the ravager land 9 and 24 off abilities authored at 8 and 14,
  which is the pair that distinguishes a per-row ratio from a shared one.
- The roster is ordered the way the table is: spider < grazer < stalker <
  ravager, where before all four were equal.
- The training dummy names no ability, authors 0 damage and derives a
  `weaponPower` of 0.
- `monsterTraits` carries the weapon power it is handed and never defaults it,
  and still returns neutral values for everything progression owns (weak points,
  flow, adaptation, shields).
- The player path is untouched: `deriveTraits` is byte-identical to spec 147's.

## Out of scope

- **Retuning the rows.** Every authored number now lands as written, which is
  the state a tuning pass should start from rather than one it has to reach.
  What did change is the *fight*: four spiders were 65.8 damage a second after a
  starting player's armour and are now 23.5, and the ravager went from 13.2 a
  blow to 22.6. Those are consequences of the table being read, not choices this
  spec made.
- **`spellPower` for monsters.** Every row's `basicAttackId` names a
  `basicAttack: true` ability, so the non-basic multiplier is on no monster's
  path today. A row naming a non-basic ability would scale by its `spellPower`
  of 1 and land the ability's authored damage -- correct by the same rule, and
  untested here because nothing exercises it.
- **A monster with more than one attack.** The ratio is taken against the single
  ability a row names. A body with a second attack would need its damage stated
  per ability, and `attackDamage` would stop being able to mean this.
- **The other authored numbers.** `armor`, `critChance`, `attackRange` and
  `baseAttackTimeTicks` are read by the resolver already and are not touched.
