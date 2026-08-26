# 229 — A blow that says what hit you

## Problem

Every blow in this game is drawn as a physical blow on a bleeding body, because
both facts are literals at one call site. `view.ts` passes `damageType:
'physical'` and `bleeds: true` into `effectsForBlow`, so five authored impact
effects — `hit_fire`, `hit_poison`, `hit_ice`, `hit_lightning`, `hit_arcane` —
are unreachable, and every construct on the map sprays blood.

The two are one bug rather than two, and that is the whole reason this is one
spec: `effectsForBlow` reaches `DAMAGE_EFFECTS` **only in the `else` of the
bleed branch**, so fixing the damage type alone changes nothing at all. Every
blow takes the blood path first, and would go on doing so.

The cost is not abstract. Ember Toss, Rime Touch and Arc Lash are the fire, the
frost and the lightning in the skill table, and all three land as a red spatter.
The whole monster roster is `MechRig` — machines — and all of them bleed.

Two smaller things travel with it because they are the same question about the
same blow. `skill.emberToss` names no `look`, so the level-4 sigil flies as an
untextured orb while the staff's basic attack it is a sigil *of* carries
`shot_ember`. And `skill.poisonDart.impact` is a second picture of a blow that
already draws one — the definition `REDUNDANT_SERVER_EFFECTS` was named for.

## Shape

**Which bodies bleed.** A column on the look table, not a guess:

```ts
// world/monster-look.ts
interface MonsterLook {
  /** Absent is `true`: a body bleeds unless its row says it does not. */
  readonly bleeds?: boolean;
}
```

Defaulted absent so players and every unrowed body are unchanged, and read at
the one `effectsForBlow` call site. A construct then falls to the damage type's
own flash plus `impact_physical`, which is what `hit_metal_spark` and
`impact_flash` were authored for and what nothing has ever played.

**What kind of blow it was.** Derived first, authored only where it cannot be:

```ts
// world/vfx-wire.ts
type DamageType =
  | 'physical' | 'fire' | 'poison' | 'ice' | 'lightning' | 'arcane'
  | 'corrosion' | 'decay';               // new

/** The dot an ability lands, as a damage type. The derivation. */
const DOT_DAMAGE_TYPES: Record<string, DamageType>;

/** Rows that carry no affliction and are not physical. The exceptions. */
const ABILITY_DAMAGE_TYPES: Record<string, DamageType>;

export function damageTypeFor(abilityId: string | null): DamageType;
```

`damageTypeFor` reads the ability's own `applyDot` where it has one, so an
eighth affliction needs no entry here and `data/damage-over-time.ts` stays the
single source. The table is only for rows that carry no affliction, which today
is none of them — it exists so a future arcane bolt has somewhere to go without
inventing a dot for it.

**Two new impacts**, in the family the five existing ones are built from, using
the palette ramps spec 215 already authored for exactly these two colours:

```ts
burst({ id: 'hit_corrosion', scale: 19, hot: 'corrodeBright', warm: 'corrodeBody',
        cool: 'corrodeDeep', spikes: 17 })
burst({ id: 'hit_decay', scale: 18, hot: 'decayBright', warm: 'decayBody',
        cool: 'decayDeep', spikes: 15, dust: false })
```

`dust: false` on decay for the reason `hit_arcane` has it: rot chips nothing off.

**Where the element goes on a body that bleeds.** The debris slot. Blood and an
element are both true of the same blow, and `effectsForBlow` is capped at three
requests — a cap this spec does not raise. `DAMAGE_DEBRIS` is already skipped
when a body bleeds, so an elemental flash takes the slot that was going spare
and the cap holds untouched. A physical blow on flesh is exactly what it was.

**Two one-liners.** `look: 'ember'` on `skill.emberToss`'s projectile, which
gives it `shot_ember` through `SHOT_ART` with nothing else changed; and
`skill.poisonDart.impact` into `REDUNDANT_SERVER_EFFECTS`, whose comment
generalises to name the class — a direct-hit projectile's `.impact` fires at the
same instant, at the same point, as the blow it reports.

## Invariants tested

- Every `DamageType` has an entry in `DAMAGE_EFFECTS` and every one of those ids
  is in the registry. The existing assertion, extended to the two new types, so
  a type added without an effect fails rather than silently playing nothing.
- `DAMAGE_EFFECTS` values stay distinct — two types sharing a picture is two
  types nobody can tell apart.
- A body whose row says `bleeds: false` draws **no** blood effect at any gore
  level, and draws the damage type's flash and `impact_physical` instead.
- A body with no row, and a player, bleed exactly as they did.
- `damageTypeFor` answers from the ability's `applyDot`: every affliction-
  carrying skill in the table maps to its affliction's type, asserted row by row
  rather than by re-implementing the derivation in the test.
- An ability id with no row and no dot answers `physical` rather than throwing.
- A bleeding body hit by an elemental skill draws blood **and** the element, and
  the request count stays at or under three in every combination of
  bleeds × gore × critical × killed.
- A physical blow on a bleeding body draws exactly what it drew before this
  spec: the same ids, in the same order.
- `skill.emberToss` resolves through `shotArtFor` to `shot_ember`.
- `skill.poisonDart.impact` is refused by the effect handler, and the dart's own
  blow draws `hit_poison`.

## Out of scope

- **The `.impact` fallback ring** for Whirlwind, Arc Lash, Rime Touch, Blight,
  Ember Toss and Scorched Earth. Those are landings rather than blows, they need
  authored effects of their own, and they are specs 231 and 232.
- **Aimed landings.** Acid Spray's cone and Arc Lash's lane cannot be drawn from
  the effect message, which carries no rotation. Spec 231.
- **Repainting the five existing impacts.** `hit_fire` and its four siblings
  become reachable here for the first time; whether the whole `DAMAGE_EFFECTS`
  table should move from `burst()` particles to the painted vocabulary is a look
  decision to take once somebody has actually seen them, not one to take blind
  in the same change that makes them visible.
- **Naming which monsters are constructs.** The column lands with its default,
  and which rows set it false is a content pass with the preview beside it —
  `preview-monsters.ts` is the contact sheet that decision gets made against.
