# 163 — The bar along the bottom

## Problem

Six RPG elements were each half-built and none of them meet the player.

1. **A kill awards nothing.** `server.ts` has granted experience on the `died`
   event since spec 062, and it has never once run. `world.ts` step 4a sweeps a
   dead monster out of `working` in the same step that emits the event, so the
   `this.state.entities.get(event.entityId)` the handler looks the row up
   through is *always* `undefined` by the time `dispatchEvents` reaches it, and
   the handler `break`s. Every character in this game is level 1 forever. The
   admin console can grant experience and the character sheet can draw it, which
   is exactly why nobody noticed: both halves work, and the only path a player
   can actually take is the broken one.
2. **Experience has no place on screen.** It is one field in a `display:none`
   developer readout.
3. **Death is a three-second pause.** `handleRespawns` puts a dead player back
   on a timer with one line of system chat. Nothing on screen says you died,
   and nothing asks.
4. **The bar is nine abilities wide** — every ability in the table, laid out in
   authoring order, because the bar has been the ability list since spec 062.
   That is a debug affordance, not a skill bar.
5. **There is no vial slot**, so the flask (spec 156) sits at slot 8 of nine and
   is one more unlabelled rectangle.
6. **Health and resource are text in the hidden readout.** The player's own
   floating bar is over their head, where it competes with the fight.

## Shape

### The `died` event says what died

```ts
// src/server/sim/types.ts
{
  readonly kind: 'died';
  readonly entityId: number;
  readonly killerId: number | null;
  readonly victimKind: EntityKindValueType;   // new
  readonly victimTypeId: string;              // new
  readonly qualities: KillQualities;
}
```

The fix for (1), and the shape rather than a lookup order because the ordering
is not the bug: **a death event outlives the body it is about.** Anything that
has to know what died has to be told, and the emitter is the only thing holding
a body that is about to stop existing. `world.ts` already learned this lesson
once for loot — it builds a `killedBy` map from the events *before* the sweep so
a drop can be rolled — and this is the same fact stated on the event instead of
reconstructed by each reader.

`server.ts` then reads the monster row off the event, and the experience it
awards is the row's, unchanged.

### The experience bar is arithmetic

```ts
// src/render/iso3d/world/xp-bar.ts   -- pure
export const XP_SUBDIVISIONS = 10;

export interface XpBar {
  readonly level: number;
  readonly current: number;      // into this level
  readonly toNext: number;       // what this level costs
  readonly fraction: number;     // 0..1, clamped
  readonly percentText: string;  // "62.4%"
  readonly detail: string;       // "Level 7 -- 62.4% (312 / 500 xp)"
}
export function xpBar(level: number, experience: number): XpBar;
```

`toNext` comes from `experienceForLevel(level + 1)`, the server's own function,
the way `character-model.ts` already gets it — so the bar and the sheet cannot
come to different answers about how far along a character is.

Drawn as a strip at the very bottom of the frame, full width, six pixels tall,
gold on black with nine hairlines cutting it into ten. Hovering it shows the
`detail` line above it, in capitals, because everything in this band is drawn
in the game's own face. The subdivisions are `XP_SUBDIVISIONS` hairlines and not
ten separate elements, because a subdivision is a mark on one bar rather than a
segment with its own state.

### Death is a state the client can already see, and a request it cannot fake

```ts
// src/render/iso3d/world/death.ts   -- pure
export const DEATH_TEXT = 'YOU ARE DEAD';
export function deathOverlay(view: ClientView): { readonly text: string } | null;
```

Null rather than a present-and-false shape, because there is one thing a caller
does with this and it is decide whether the overlay is on screen -- a
`{ dead: false }` would be an extra way to be wrong.

Derived from the local body's replicated health, so no new field is needed to
*know* — the client has always been told. What is new is the ask:

```ts
// src/server/net/protocol.ts
Respawn: 0x1a,   // no payload
```

The server honours it only from a connection whose body is at zero health, and
puts them at `DEFAULT_SPAWN` through the same `clearSpawnNear` + `Correction`
path the timer used. **The timer goes.** A respawn is now a decision, and a
death that undoes itself after three seconds while a player is still reading
"YOU ARE DEAD" would be the interface lying about what the button is for.
`RESPAWN_DELAY_TICKS` is deleted rather than left as a floor: a countdown on the
button is a different feature, and an unused constant is a claim that something
reads it.

The overlay is `pixelTextSvg` at scale 8 in red with a black outline — the
game's existing vocabulary for big text (the damage numbers, the refusal stack)
rather than a second one — and a Respawn button under it.

### The bar is five slots, four of them empty

```ts
// src/render/iso3d/world/action-bar.ts   -- pure
export type ActionSlotKind = 'skill' | 'vial';
export interface ActionSlot {
  readonly kind: ActionSlotKind;
  /** What this slot casts, or null for a slot nothing has been put in yet. */
  readonly abilityId: string | null;
  readonly keyNumber: number;
}
export const ACTION_BAR: readonly ActionSlot[];      // 4 skill + 1 vial
export function buildActionBar(ids: readonly (string | null)[]): readonly ActionSlot[];
export function actionBarFromQuery(search: string): readonly ActionSlot[];
export function abilityForSlot(bar: readonly ActionSlot[], index: number): string | null;
```

The bar is built **once** in `view.ts` and handed to both readers -- `createHud`
draws it, the key handler presses it -- rather than each importing `ACTION_BAR`.
A bar built twice is two answers about what is in slot 3.

Four empty skill slots and one vial slot holding `self.hearthdraught`, and the
emptiness is the point: a slot with nothing in it is a place a skill will go,
which is a thing the interface can show and the nine-ability list could not.
`abilityForSlot` returns `null` for an empty one and is the *only* way a press
becomes an ability, so a key and a click cannot come to different answers — and
neither of them can cast out of a slot that holds nothing.

The vial is a slot of its own after all, reversing spec 156's placement, and the
reason is not that the flask is special in the rules: it is that four skill slots
and one flask in the same undifferentiated row makes the flask look like a fifth
skill. What it costs is a charge and not resource, and a slot that draws its
charge count is the interface saying so.

#### `?slots=` — the developer path, and why it is not scope creep

With the bar empty, every ability in the game except the auto-attack and the
flask becomes unreachable from the shipped page. That is the honest consequence
of what this spec is for, and it is fine for a player -- but it also left the
browser harnesses that check the aim (spec 080), the refusal on cooldown (143)
and the ground telegraph (153) with nothing to press. Deleting those checks
would have been this change quietly taking the coverage with it.

So `?slots=melee.heavy,,ground.quake` fills the skill slots in order, in the same
register as `?seed=`, `?wire=` and `?units=`. It is not an interface: a player
has no way to reach it, nothing persists it, and the vial can never be one of the
names -- a caller that could overwrite the fifth slot could take the flask off
the bar.

### The pool is two bars, left of the slots

```ts
// src/render/iso3d/world/pool-bars.ts   -- pure
export function poolBars(view: ClientView): { health: PoolBar; resource: PoolBar };
```

One judgement in it: **an unknown maximum is not a maximum of zero.** Before the
first `Stats` message there is no stat block, and dividing by the zero standing
in for it paints an empty health bar over a player at full health for the opening
frames of every session.

The health bar is the **same bar mechanically** as the one over a body:
`HealthFlashes` (specs 145/146) reads it, so the white chunk a blow leaves and
the flinch it kicks with are the ones already on screen rather than a second
implementation to keep in step. Two departures, each for a stated reason — the
pool gets a `HealthFlashes` instance of its own, because sharing the floating
bars' would make the chunk depend on whether the camera happened to be looking
at the player; and the kick moves the whole two-bar block, because half a group
flinching reads as a layout bug. Resource has no chunk: the chunk marks what a
*blow* took, and nothing takes resource off you — you spend it.

#### Everything in the band is drawn in the game's own font

`pixel-font.ts` (spec 065), not the browser's monospace: the slot key numbers
and names, the cooldown countdown, the vial's charges, both pool labels, the
hover line, the weapon and window captions, and the respawn button. The band
sits over a posterized, low-resolution world and system type over it reads like
a debug overlay somebody left on — the same argument spec 065 made about the
damage numbers and 143 about the refusals.

Three consequences, and none of them is cosmetic:

- The face has **one case and a fixed set of symbols**, so a character with no
  glyph draws as a solid block. `/`, `%`, `(` and `)` are added for the
  quantities this band shows, and every string it can produce is asserted
  drawable rather than eyeballed once.
- A label is **drawn, not typeset**: nothing reflows, and a glyph a pixel taller
  than its track is silently clipped. So each label's size is a *scale* in the
  layout table and its fit is a sum (`poolLabelFits`), like every other number
  in that file.
- No name in the ability table fits a 46px square at any scale, so a filled slot
  on a phone draws an **icon** — the answer the compact HUD already gives for
  the weapon switch and the window buttons.

#### Sized in the layout table, like everything else in the band

```ts
// src/render/iso3d/world/hud-layout.ts
readonly pool: BoxSize;      // one of the two bars
readonly poolGap: number;    // between them, and between the block and the slots
readonly poolScale: number;  // font pixels, not a point size
readonly xpBarHeight: number;
export function poolClearance(layout: HudLayout, slots: number, frameWidth: number): number;
export function bottomEdge(layout: HudLayout): number;   // edge + xpBarHeight
export function poolBlockHeight(layout: HudLayout): number;
export function poolBottom(layout: HudLayout): number;   // centred on the slot row
export function poolLabelFits(layout: HudLayout, longest: string): boolean;
```

Health over resource, immediately left of the centred slots and *centred on
them* rather than sharing their floor, each with its absolute numbers over it.
Centring is what `poolBottom` is for, and it needs the slot to have a stated
height: the desktop slot used to be as tall as its padding and line height made
it, which was 46 by coincidence until the label became a glyph path. Sized in the layout table like every other piece of
HUD furniture, so *whether the pool block still clears the weapon switch on a
phone* fails in Node rather than in a screenshot — which is the whole reason
that table exists.

Every bottom-edge offset in the HUD gains `xpBarHeight`, because the xp strip is
pinned to the frame's bottom and everything else has to clear it.

## Invariants tested

- A real kill over a real loopback raises the killer's replicated
  `view().experience`, and the amount is the monster row's. (The test that
  would have caught the bug: it has to be a kill, not a `grantExperience` call.)
- The `died` event carries the victim's kind and type id even though the entity
  is gone from the state the same step emitted it.
- Enough experience levels a character up over the wire, and the bar's fraction
  falls back toward zero when it does.
- `xpBar` clamps: 0 at zero experience, never above 1, and `percentText` is the
  exact percentage rather than a tenth of the bar it is drawn in.
- A dead player is not respawned by the passage of time, however long the server
  runs.
- `Respawn` from a dead player puts them within a body's width of
  `DEFAULT_SPAWN`, whole, and pardons the teleport (no speed-hack correction on
  the next input).
- `Respawn` from a living player changes nothing at all.
- `deathOverlay` is null for a living body, for a spectator with no body yet,
  and for a client that has not been told about itself.
- `abilityForSlot` returns null for all four skill slots and the flask id for
  the vial, and the bar is five long.
- The pool block plus the five slots clear the weapon switch and the frame edge
  on a phone in landscape.
- `poolBars` reports an unknown maximum as unknown rather than as empty, clamps a
  negative health to zero and a resource past its ceiling to full.
- Every string this band can draw has a glyph for every character in it -- the
  pool labels at both ends of their range, and the hover line at every level
  including the cap.
- Every label fits its box at its scale: the longest pool label inside a pool
  bar, and the longest ability name in the table inside a desktop slot.
- The pool block's middle and the slot row's middle are the same line, in the
  layout table and again in a real browser.
- The pool's health bar holds the white chunk a blow left, starting where the
  fill was -- the same reading the floating bar gets, checked on painted pixels
  rather than on the model.
- `?slots=` fills the slots it names in order, leaves an empty entry empty rather
  than shifting the rest along, and cannot take the vial off the bar however many
  names it is given.
- The strip a player reads moves off zero on a real kill over a real loopback --
  the join between the award and the bar, which neither side can assert alone.
- The mount is still presentation only: the same seed and inputs, with the new
  overlay and bars driven and without, produce identical authoritative state.

## Out of scope

- **Putting a skill into a slot.** The four are empty and stay empty until
  there is a drag from the skill tree to put something in one, which needs the
  tree to have a source of draggable rows and is its own change. Nothing here
  persists a binding, because nothing here creates one — `?slots=` is a
  developer path and not the first half of that feature. The cost of leaving it
  here is stated rather than hidden: until slot binding is built, a player can
  reach the auto-attack and the flask and nothing else.
- **A death recap** — what killed you, what it cost. The overlay says you died
  and offers the way back.
- **A death penalty.** Spec 156's reset (flask restored, meter gone) is what
  dying costs and this does not add to it.
- **Experience for anything but a kill.** No quest, no discovery, no assist
  share.
- **A level-up celebration.** The bar falling back to nearly empty is the
  feedback; a burst is `docs/vfx-plan.md`'s business.
- **A respawn point that is not `DEFAULT_SPAWN`.** Bindstones are a map feature.
