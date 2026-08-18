# 176 — A setting that only changed the ground

## Problem

The Play tab's effects panel (spec 121) has two rows. One of them does almost
nothing, and the other cannot be told apart from doing nothing.

**Blood: Off leaves every drop of blood on screen.** `gore` is pushed into
`DecalField`, which owns the *stains*, and the stains are the smaller half of
what the setting names. The spatter — `blood_hit_brush`, `blood_hit_brush_heavy`
and the `death_blood` pool — is chosen by `effectsForBlow` in `vfx-wire.ts`,
which has never been told the setting exists. So a player who turns blood off
because they do not want to see it watches the same red brush marks come off
every body, and only the marks left on the ground go away.

**Blood: Less is byte-identical to Full.** Nothing anywhere reads level 1:
`DecalField.add` refuses at 0 and accepts otherwise. The middle button is a
label with no behaviour behind it.

Both halves are individually correct and individually tested. `decals.test.ts`
asserts the gore gate, `vfx-wire.test.ts` asserts which effect a blow asks for,
and neither has any reason to mention the other — which is exactly why a full
green suite sat beside a setting that did not work. Measured on the shipped page
over a real fight: Full, Less and Off drew 7, 8 and 7 particles.

**Effect detail is fine**, and this spec says so rather than changing it. The
same measurement gives 38 particles at Full, 2 at Low and 0 at Off. What it did
not have was any way for anybody to check that without playing the game, which
is the third thing here.

## Shape

`vfx-wire.ts` — the gore level becomes an argument, because what a blow looks
like is exactly this module's job and blood is a thing a blow looks like:

```ts
/** 0 off, 1 reduced, 2 full. The panel's row, as the blow adapter sees it. */
export type GoreLevel = 0 | 1 | 2;

export function effectsForBlow(
  facts: CombatFacts,
  tick: number,
  gore: GoreLevel,
): readonly PlayRequest[];
```

Required rather than defaulted: a default is how the one caller that matters
silently keeps not passing it.

What each level means, and the rule is that **a lower setting removes blood and
never removes the blow**:

| | hit | killing blow |
|---|---|---|
| Full (2) | `blood_hit_brush` | `blood_hit_brush_heavy` + `death_blood` |
| Less (1) | `blood_hit_brush` | `blood_hit_brush` |
| Off (0) | `hit_physical` | `hit_physical` |

`Less` keeps the wound and drops the *pool*: `death_blood` is the loud one, it
is the one that lasts, and it is the one that puts a 96-unit stain on the floor.
`Off` falls through to the impact a construct already draws, so a hit on flesh
still reads as a hit — dropping the blood and putting nothing in its place would
make a fight harder to follow, which is a worse setting than the one being
fixed.

`decals.ts` — the same three steps, applied to how much ground is kept:

```ts
/** Fraction of `DecalLimits` each gore level holds. Index is the level. */
const GORE_SCALE = [0, 0.25, 1];
```

Derived on read rather than copied into `limits`, so the authored numbers stay
the authored numbers, and re-enforced inside `setGore` — turning the setting
down has to trim the field that is already on the floor, not wait for the next
blow to notice.

`view.ts` — holds the level the panel last chose and hands it to
`effectsForBlow`. Initialised from `VFX_DEFAULTS.gore`, which is also what a
handheld gets, since the panel is not built there (spec 140).

`layer.ts` — `readout()` gains `intensity`, `gore` and the ids of the effects
playing right now, and `view.ts` publishes them as `data-vfx-*`, the way
`data-held-weapons` is published from the bone rather than from the intent
(spec 165). A panel that lit up a button and reached nothing has to read as
unchanged.

## Invariants tested

- **At gore 0 no blood effect is played for a bleeding target**, and the blow
  still draws something: the request list is non-empty and holds no id naming
  blood.
- **At gore 1 a killing blow draws the ordinary brush and no `death_blood`**,
  and an ordinary hit is unchanged from Full.
- **At gore 2 nothing about the existing table moves** — the spec-158 rows still
  hold.
- **Every id `effectsForBlow` can return, at every gore level, is in the
  registry.** The existing check widened by the new parameter, since a level
  that names a typo is exactly where this hides.
- **A blocked blow and a heal are the same at all three levels**: neither is
  blood, and a setting that silenced a heal would be a bug of its own.
- **`DecalField` holds strictly fewer stains at level 1 than at level 2**, and
  still refuses everything at level 0.
- **Turning gore down trims the field immediately**, rather than on the next
  add.
- **`npx tsx scripts/probe-vfx-settings.ts`**: on the shipped page, over a real
  fight — Effect detail Off draws no particles and Low draws fewer than Full;
  Blood Off lays no stains and plays no blood effect; Blood Less holds fewer
  stains than Full. This is the half no test can reach, because every half of
  it is already green.

## Out of scope

- Persisting either setting. Nothing in this corner is persisted and every
  session opens at defaults; that is the tab's standing convention
  (`view-controls.ts`), and changing it is a different spec.
- Gore in the options window (spec 135), which is where a phone would reach it.
  The panel is still desktop-only.
- A gore level that reads the *fluid*: every decal in the registry today is
  blood, so refusing on the level alone and refusing on `fluid === 'blood'` are
  the same code. The day sap or oil stains something, that is the change.
- Making Effect detail do more than it does. It works; this only makes it
  possible to see that it does.
