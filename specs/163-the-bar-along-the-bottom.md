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
`detail` line above it. The subdivisions are `XP_SUBDIVISIONS` hairlines and not
ten separate elements, because a subdivision is a mark on one bar rather than a
segment with its own state.

### Death is a state the client can already see, and a request it cannot fake

```ts
// src/render/iso3d/world/death.ts   -- pure
export function deathOverlay(view: ClientView): { readonly dead: boolean; readonly text: string } | null;
```

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
export function abilityForSlot(index: number): string | null;
```

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

### The pool is two bars, left of the slots

```ts
// src/render/iso3d/world/hud-layout.ts
readonly pool: BoxSize;      // the health/resource block
readonly poolGap: number;    // between it and the slots
readonly xpBarHeight: number;
export function poolLeft(layout: HudLayout, slots: number, frameWidth: number): number;
```

Health over resource, immediately left of the centred slots, each with its
absolute numbers over it. Sized in the layout table like every other piece of
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
- The mount is still presentation only: the same seed and inputs, with the new
  overlay and bars driven and without, produce identical authoritative state.

## Out of scope

- **Putting a skill into a slot.** The four are empty and stay empty until
  there is a drag from the skill tree to put something in one, which needs the
  tree to have a source of draggable rows and is its own change. Nothing here
  persists a binding, because nothing here creates one.
- **A death recap** — what killed you, what it cost. The overlay says you died
  and offers the way back.
- **A death penalty.** Spec 156's reset (flask restored, meter gone) is what
  dying costs and this does not add to it.
- **Experience for anything but a kill.** No quest, no discovery, no assist
  share.
- **A level-up celebration.** The bar falling back to nearly empty is the
  feedback; a burst is `docs/vfx-plan.md`'s business.
- **A respawn point that is not `DEFAULT_SPAWN`.** Bindstones are a map feature.
