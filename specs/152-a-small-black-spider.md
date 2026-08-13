# 152 — A small black spider

## Problem

Every monster in the arena is drawn by `new MechRig(typeId)` and nothing else,
which means every monster in the arena is the same body: a cube chassis on four
legs, at size 1, in the same dusty red. That last part is not a design decision,
it is a dead lookup — `enemyColor` switches on `brawler`/`skitter`/`brute`, three
sim type names that no row in `MONSTERS` has ever used, so all four monsters fall
through to its neutral fallback. Four enemies, one silhouette, one colour.

So there is nowhere to put a *small* enemy. Half of "small and fast" already has
a home: `moveSpeed`, `turnRate` and `radius` are sim numbers and live in
`MONSTERS`, where the server reads them and the wire carries what a client needs.
The other half — how big the body is drawn, how it carries itself, what shape and
colour it is — has no home at all, and the rig it would be written on takes a
whole `MechTuning` the scene never passes.

This adds the missing half as a table, and a small black spider as its first row.

## Shape

`src/render/iso3d/world/monster-look.ts`, pure and beside `appearance.ts`, which
already answers *which* rig draws a body. This answers what that rig is built
with:

```ts
/** The mech tuning minus the two fields the rig itself never reads. */
export type MechRigTuning = Partial<Omit<MechTuning, 'moveSpeed' | 'turnRate'>>;

export interface MonsterLook {
  readonly appearance: MechAppearance;   // shape + the two colours
  readonly tuning: MechRigTuning;
}

export function monsterLookFor(typeId: string): MonsterLook | null;
```

`MechAppearance` is the rig's own live record rather than a shape this file
invents, and that is what makes the movement sandbox's chip honest: the panel's
colour wells write into the same type, so what somebody tunes over there is what
gets pasted back in here. It is separate from `MechTuning` rather than three more
fields on it because the tuning is a record of *numbers* — clamped to safe
ranges, bound to sliders — and a shape is not a number while a colour is one only
by accident of encoding. Sanitizing a colour against a min and a max is nonsense.

Both records are read by the rig every frame, so an edit lands on the next one.
Changing a colour rebuilds the body and swaps the legs' materials; it must not
rebuild the *legs*, because that re-plants every foot and picking a colour would
make the unit hop where it stands. Mutating the material in place is not an
option either — `flatMaterial` caches one per colour across the whole scene.

There is deliberately no `mechTuningFor` here merging the overrides onto
`defaultMechTuning()`, which was the first shape and is the obvious one. That
function lives in the rig module, and importing it would pull three.js into the
world view's pure half — where nothing outside `scene.ts` and `shot.ts` has ever
reached for it. So the rig types come in as types and are erased, and the merge
is a spread at the one place a rig is actually constructed.

The `Omit` is the point, not a detail. Move speed and turn rate exist on
`MechTuning` because the movement sandbox needs somewhere to hang its two sim
overrides, and the rig has never read either. A monster's copies of those numbers
are the *server's*, so a renderer table that could name them would be a second
place to write down how fast a body moves — and the two would disagree the first
time one was edited. The type makes that unwriteable rather than discouraged.

`MechRig` takes the record the same way it already takes a tuning — shared, so a
panel can edit one object and every mech built against it follows:

```ts
export type MechBodyShape = 'box' | 'sphere';

export interface MechAppearance {
  shape: MechBodyShape;
  bodyColor: number;
  legColor: number;     // always concrete; defaultMechAppearance applies the darken once
}

export interface MechOptions {
  readonly lowerBodyTurns?: boolean;
  readonly tuning?: MechTuning;
  readonly appearance?: MechAppearance;
}
```

`MechTuning` gains one field, `bodySize`: how big the body is against its own
legs. It belongs with the other proportions rather than on the appearance,
because it is a number somebody finds by dragging, and because `sizeScale` — the
knob next to it — moves the body and the legs together and so cannot express a
proportion between them.

`'sphere'` is one faceted body and no other part. The box variant is a chassis, a
plate, a head and an eye, and three of those exist to say which way a mech is
pointing; on a black body they say nothing, and on a spider the legs say it
anyway. So the sphere is the whole body, at the same height and roughly the same
mass as the cube it replaces.

The sim half is one row in `MONSTERS`:

```ts
{ id: 'small_spider', name: 'Small Spider', radius: 12, aggroRange: 300,
  experience: 10, passive: false,
  stats: { maxHealth: 22, moveSpeed: 115, turnRate: 290, ... } }
```

`moveSpeed` and `turnRate` are the tuned values. The rest are authored to fit
what those two describe — a body that closes fast, swings often and dies quickly
— and are stated here because nobody tuned them at a slider: 22 health is two
player hits, `melee.slash` at a 0.8s cadence is the fastest BAT in the table, and
5 damage a swing makes a nest dangerous and one spider survivable.

`radius: 12` adds a fifth entry to `ROUTING_RADII`, and so a fifth nav grid at
boot. That is the honest cost of a body that is genuinely smaller than the other
four, and the alternative — reusing 20 so no grid is added — would draw a
12-unit spider with a 20-unit target ring and collide it with doorways it visibly
fits through.

Three spawners go into `maps/arena.json` as a nest, so the enemy exists in the
world rather than only in a table.

`npx tsx scripts/preview-monsters.ts` is the picture, because a look is a thing
you check by looking at it and there was no way to see a monster short of
starting a server and walking to one. It builds each rig the way `scene.ts` does
and rasterises it in software, with two decisions taken against
`preview-critters.ts`'s: one world-space window for every cell rather than
framing each subject on its own extent — the thing being checked is that a small
enemy is small, and auto-framing hides exactly that — and the collider drawn as
a ring, since the drawn size and the collider are authored in different files and
nothing forces them to agree.

## The sandbox

A third mech chip, loaded from this same table, so the body being tuned is the
one in the game rather than a lookalike rebuilt from memory. The controls it
exists for are `bodySize` and the two colour wells, which need a third row type
in `tuning-panel.ts`: a swatch over a hex int, a union member rather than a flag
on the slider, because `min`/`max`/`step` are meaningless on a colour and absent
says that better than ignored does.

The mechs have always shared one tuning object — that is what makes the panel's
mech section one set of sliders rather than one per unit — so a third mech with
different numbers has to *load* them, exactly as `C` already loads an archetype
preset. A preset's tuning and its appearance carry separate ids, because they
change on different picks: spider and walker have always differed in colour and
never in tuning, so moving between those two must still leave a dragged slider
alone. Reset follows the active chip rather than the bare defaults, or the button
quietly turns the small spider into a mech.

The rig debugger mounts this same panel over two mechs whose colours are fixed at
construction, so it passes no appearance and the colour rows are never shown —
the rule this tab already applies to the attack section, and to controls that
would visibly do nothing.

## Invariants tested

- The look table cannot name a sim number: no entry carries `moveSpeed` or
  `turnRate` at runtime, in a test that would still fail if the `Omit` were
  removed from the type.
- The spider's row carries exactly the authored values —
  `sizeScale` 0.6, `bodySize` 1.25, `raisedLegs` 0, `pitchGain` 0.0006, `rollGain` 0.03,
  `coxaReach` 0, `femurScale` 1.05 — and every *other* field is untouched from
  `defaultMechTuning()`.
- A type id with no row gets `null` and the default tuning, so an unknown monster
  draws exactly what it draws today. Every id in `ALL_MONSTERS` resolves without
  throwing, including the ones with no row.
- Each call returns its own tuning object: two bodies of the same type may not
  share one, or a size change on one spider resizes every spider in the arena.
- The sim row reads back the tuned numbers: `moveSpeed` 115 and `turnRate` 290
  off `MONSTERS`, which is where the server and `turn-limits.ts` both look.
- The map's spider spawners resolve through `spawnPointsFrom` — a spawner naming
  a monster nobody has heard of is already a boot failure, so this pins that the
  new id and the new markers agree.
- `appearanceOf` still gives the new monster a rig, a health bar and its own
  radius, like every other row.
- A live edit reaches the meshes: changing the shape swaps the body and leaves
  the legs alone, changing either colour repaints, and changing `bodySize`
  resizes the body without moving a leg. The last two are asserted against a
  *control* rig walked in lockstep rather than against a tolerance, because a
  foot mid-swing travels several units in a frame by itself — so "did the edit
  move it" cannot be asked of one rig's before and after.
- A colour change does not re-plant the feet.
- In a real browser (`preview-sandbox.ts`): the chip loads the shipped 0.60 and
  `#241f31` into the controls, a tuned body colour paints that many pixels of
  the canvas, and switching back restores the plain spider's numbers.

## Out of scope

- Eight legs. The spider is the four-legged rig at 0.6 with the tuned values;
  `numLegs` was not one of them, and changing it is a different silhouette from
  the one that was tuned.
- Any change to how the other four monsters look. They have no row, so they draw
  the cube body and the fallback colour they draw today, and `enemyColor`'s dead
  switch stays dead until something asks it a question it can answer.
- A web, a poison, a leap, or any AI that is not "walk in and swing". It fights
  with `melee.slash` like everything else in the table.
- A shape control in the sandbox. The chip picks the shape; there is no box/sphere
  switch, because nobody asked to compare them and a control nobody wants is
  still a control somebody has to understand.
- Persisting what gets tuned. The sandbox opens at defaults like every other
  panel in it, and a look that is worth keeping is a line in `monster-look.ts`.
