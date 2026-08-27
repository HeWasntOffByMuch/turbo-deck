# 232 — A blow that says what hit you

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

**What kind of blow it was.** Derived where it can be, and it rides the wire.

The wire is the correction to this spec's first draft, which had the client
derive the type from the ability the way `ProjectileLook` is derived. **It does
not work.** `look` gets away with being a pure lookup because a projectile
entity's `typeId` *is* its ability id, so a client holding the projectile is
already holding the ability. A blow is a `CombatResult`, which names an attacker
and a target and no ability at all — and the one join available, against the
attacker's live cast (`KnownCast.abilityId`), is wrong for exactly the abilities
that need it most: a projectile's blow lands seconds after its cast ended, so
Ember Toss and Poison Dart are precisely the two it would miss.

So the split is **content says what a blow is made of, the renderer says what
that looks like**:

```ts
// server/data/abilities.ts  -- content
type DamageElement =
  | 'physical' | 'fire' | 'poison' | 'ice' | 'lightning' | 'arcane'
  | 'corrosion' | 'decay';                    // the last two are new

/** Append only: this ordinal is what crosses, in place of the string. */
const DAMAGE_ELEMENTS: readonly DamageElement[];
function damageElementOrdinal(element: DamageElement): number;
function damageElementOf(ordinal: number): DamageElement;   // total

interface AbilityDefinition {
  /** For a row that lands no affliction. Absent is physical. */
  readonly element?: DamageElement;
}

/** An affliction decides the element of the blow that carried it. */
function elementOfAbility(ability: AbilityDefinition | null): DamageElement;

// server/net/messages.ts  -- one byte
interface CombatResultMessage { readonly element: number; }

// world/vfx-wire.ts  -- presentation, and the only place this decision lives
type DamageType = DamageElement;                            // an alias, not a copy
const DAMAGE_EFFECTS: Record<DamageType, string>;
```

`elementOfAbility` reads the ability's own `applyDot` first, so an eighth
affliction is one row in `DOT_ELEMENTS` rather than an edit to every skill that
applies it, and a row's own `element` is consulted only when it lands none — so
the two can never disagree. A byte of its own rather than three spare bits of
`flags`, because eight elements is exactly eight and a bitfield with no room
left is one the ninth silently overflows.

The precedent for putting it on this message is spec 219, which promoted
`periodic` from sim-only onto this exact message for this exact reason: the
client cannot work it out, and the picture is wrong without it.

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
- `elementOfAbility` answers from the ability's `applyDot`: every affliction-
  carrying skill in the table maps to its affliction's element, asserted row by
  row rather than by re-implementing the derivation in the test. Bleed is
  `physical`, which is why the mapping is a table and not "dots are elemental".
- An ability with no row, no dot, or none at all answers `physical` rather than
  throwing — it is called inside the render loop.
- A row carrying both an affliction and an authored `element` answers with the
  affliction's, so the two cannot come to two answers.
- Every element round-trips through its wire ordinal, and an ordinal this build
  has no name for reads as `physical` rather than throwing.
- A `CombatResult` carrying a non-zero element survives an encode/decode round
  trip — asserted at a value other than 0, or the test cannot tell a field that
  survives from one the decoder fills in.
- A bleeding body hit by an elemental skill draws blood **and** the element, and
  the request count stays at or under `MAX_BLOW_EFFECTS` in every combination of
  bleeds × gore × critical × killed × element. The element is the request that
  **yields** when the budget is full: a killing blow at `Full` has already spent
  two slots on the loud blood and the pool, and a crit spends the third. That is
  the right one to drop — the other three each say what the blow *did*, where the
  element says what it *was*, which is the same on every cast of the skill and
  already known from the button that was pressed.
- Each request of one blow gets a distinct seed, so two of them cannot draw the
  same pattern and read as one effect drawn twice.
- A physical blow on a bleeding body draws exactly what it drew before this
  spec: the same ids, in the same order.
- `skill.emberToss` resolves through `shotArtFor` to `shot_ember`.
- `skill.poisonDart.impact` is refused by the effect handler, and the dart's own
  blow draws `hit_poison`.

## Out of scope

- **Naming which abilities are `arcane` without an affliction.** `element` lands
  on `AbilityDefinition` with no row in the table setting it, because every
  elemental skill today reaches its colour through the affliction it lands.
  The field exists so the first ability that is arcane *without poisoning
  anybody* has somewhere to say so, rather than having a dot invented for it.
- **The `.impact` fallback ring** for Whirlwind, Arc Lash, Rime Touch, Blight,
  Ember Toss and Scorched Earth. Those are landings rather than blows, they need
  authored effects of their own, and they are specs 234 and 235.
- **Aimed landings.** Acid Spray's cone and Arc Lash's lane cannot be drawn from
  the effect message, which carries no rotation. Spec 234.
- **Repainting the five existing impacts.** `hit_fire` and its four siblings
  become reachable here for the first time; whether the whole `DAMAGE_EFFECTS`
  table should move from `burst()` particles to the painted vocabulary is a look
  decision to take once somebody has actually seen them, not one to take blind
  in the same change that makes them visible.
- **Naming which monsters are constructs.** The column lands with its default,
  and which rows set it false is a content pass with the preview beside it —
  `preview-monsters.ts` is the contact sheet that decision gets made against.
