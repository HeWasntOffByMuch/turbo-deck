# 222 — Editing a spawner

## Problem

A marker in the map editor can be **placed** and **erased**, and that is the
whole vocabulary. There is no way to click one and see what it is, and no way to
change anything about it: choosing the wrong monster from the dropdown means
erasing the marker and placing it again, and the id you get back is not the one
you had (`nextMarkerId` reuses the lowest free number, so the whole set can
shuffle). Spec 178 fixed the mistake the panel *reliably produced* — placing a
`spawn` where a `spawner` was meant — by relabelling the button; the marker
already on the ground still cannot be corrected.

Past which monster stands there, a spawner has nothing else to say either, and
two of the numbers a level designer would reach for first are global constants:

- **how long a kill stays dead** is `config.spawnIntervalTicks` scaled by
  `spawnRateMultiplier`, one number for every spawner on the map, so a boss and
  a rabbit come back on the same clock;
- **how far a body may be dragged** is `LEASH_RADIUS = 800` in `sim/world.ts`,
  so a camp meant to hold its ground and a wanderer are leashed alike.

Both are per-spawner questions being answered globally, and there was nowhere in
the document to answer them.

## Shape

### The document (`src/terrain/map.ts`)

One optional block on `MapMarker`, spawner-only:

```ts
export interface MapSpawnerSettings {
  /** Seconds from the kill to the replacement. Absent = the server's default. */
  readonly respawnSeconds?: number;
  /** How far a body from this point may be dragged. Absent = the sim's default. */
  readonly leashRadius?: number;
}

export interface MapMarker {
  readonly kind: MapMarkerKind;
  readonly id: string;
  readonly x: number;
  readonly z: number;
  readonly label?: string;
  /** Spawner-only: refused by the parser on any other kind. */
  readonly spawner?: MapSpawnerSettings;
}
```

Nested rather than two more flat optionals beside `label`, because this codebase
already states the rule these fields are subject to: **a row only names a number
the behaviour it chose actually reads** (`Temperament`, `Idle`). A `campfire`
carrying a `leashRadius` is a number nothing will ever look at, so `parseMarker`
refuses the block on any kind but `spawner` rather than ignoring it — the same
stance `spawnPointsFrom` already takes on a spawner naming a monster nobody has
heard of.

**Seconds, not ticks.** A map document is authored and reviewed by a person, and
a tick count is the sim's business. The conversion happens at the one boundary
that turns a document into sim input.

An empty or absent block writes nothing, so **every committed map is unchanged
byte for byte** and `mapId` does not move.

### The boundary (`src/server/world/spawners.ts`)

`SpawnPoint` gains the two, unresolved:

```ts
export interface SpawnPoint {
  readonly id: string;
  readonly monsterId: string;
  readonly x: number;
  readonly y: number;
  /** Ticks between the kill and the replacement, or null for the config's own. */
  readonly respawnTicks: number | null;
  /** The document's leash for this point, or null for the sim's own. */
  readonly leashRadius: number | null;
}
```

`null` rather than a resolved number, because the two defaults live in two
different places and neither is this file's: the respawn default is a *live*
config value the admin console can change without a restart, and the leash
default is a sim constant. Resolving here would freeze the first at load and
duplicate the second.

What this file *does* own is refusing nonsense, the way it already refuses an
unknown monster: a non-finite or non-positive `respawnSeconds` or `leashRadius`
is a `SpawnerError` at boot rather than a spawner that quietly misbehaves.

### The sim (`src/server/sim/world.ts`)

- `respawnInterval(config, point)` takes the point: the base is
  `point.respawnTicks ?? config.spawnIntervalTicks`, and `spawnRateMultiplier`
  still scales it — including to 0, which is still how the admin console stops
  the world repopulating. A per-spawner clock is a *base*, not an escape from
  the live control.
- `ServerEntity.leashRadius: number`, written at spawn, defaulted to
  `LEASH_RADIUS` in `blankEntity`. `beyondLeash` reads it instead of the
  constant. Gated by `anchor` exactly as before, so a player and a conjured
  monster are unaffected.
- **The document's leash is capped at `LEASH_RADIUS`.** Not a taste call:
  `NAV_WINDOW_PAD_TILES` is *derived* from `max(LEASH_RADIUS, FLEE_DISTANCE)`,
  so a nav window is assembled exactly wide enough for a body at the global
  reach, and a spawner allowed to exceed it would ask `findPath` for a goal
  outside its own window. A spawner may make a monster tighter on its leash;
  it may not make it looser than the routing was sized for. Raising the ceiling
  is one constant, and the padding follows it for free.

Nothing new crosses the wire. The spawner overlay's countdown is already
`readyAtTick - tick`, so a per-spawner clock reaches it with no protocol change.

### The tool (`src/render/iso3d/editor/`)

A ninth `EditorMode`, `'select'`, and it is the first one whose left button
**names a thing already on the map** rather than describing a region to change.

- **The pick is against the billboards, not the ground.** A marker's disc floats
  `STEM_HEIGHT` above the point it marks, so the ground under the cursor when
  you aim at a disc is metres away from the marker and *how far* depends on the
  camera's pitch. Raycasting the sprites means you click what you can see, at
  every angle. `MarkerViewHandle.pickTargets` is that list, and each sprite
  carries its marker's id.
- **Selection is held by id, never by reference.** The store hands back fresh
  marker objects on every `markers()` call and re-files a moved one into a
  different chunk, so a held object is stale the moment anything is edited —
  the same rule the admin console's player table follows for the same reason.
- `markers.ts` gains `updateMarker(store, layerId, id, patch, onTouchChunk)`,
  which is one primitive rather than three: it re-files the marker when the
  patch moves it across a chunk seam, and it **drops what the new kind cannot
  read** when the patch changes the kind, which is the document rule above
  enforced at the one place a kind can change.
- The panel's Select folder edits the selected marker: kind, monster (a
  spawner's label) or free text (every other kind's), respawn seconds, leash
  radius, position, and a Delete button. Spawner rows are *shown and disabled*
  off a spawner, which is the rule the Markers folder already follows —
  live-looking and inert is the worst of the three states.
- `0` is the **document default** for both numbers, so "unset" is reachable from
  a slider without a second control saying whether the first one counts.
- Left-**drag** on a grabbed marker moves it, which is the same `updateMarker`
  and needs nothing else.

The select tool's fields are its own, separate from the marker tool's placement
defaults: what I am about to place and what I have selected are two questions,
and selecting a marker must not silently re-arm the placement dropdown.

## Invariants tested

**Document**

- A spawner's settings survive `serializeMap` -> `parseMap` -> `serializeMap`.
- A marker with no block, or an empty one, serializes exactly as it did before
  this spec — every committed map is byte-identical.
- `parseMarker` refuses a `spawner` block on any kind but `spawner`.
- A marker's settings survive a part round trip (`bakePart` copies markers) and
  the region split/join.

**Boundary**

- `spawnPointsFrom` reads both fields, converts seconds to ticks at
  `SERVER_TICK_RATE`, and leaves `null` where the document says nothing.
- A non-finite, zero or negative `respawnSeconds` or `leashRadius` is a
  `SpawnerError` naming the marker.

**Sim**

- A spawner authoring a respawn time refills on *its* clock; one that does not
  refills on the config's, unchanged.
- `spawnRateMultiplier` still scales a per-spawner clock, and 0 still stops it.
- A body from a spawner with a tight leash gives up at that distance; one with
  none gives up at `LEASH_RADIUS`.
- A document leash above `LEASH_RADIUS` is capped at it, asserted against
  `NAV_WINDOW_PAD_TILES`'s own derivation rather than against a literal.
- Spawning draws nothing from the `Rng`: the state after a spawner with a
  document clock has refilled equals the state after one without.

**Tool**

- `markerAt` returns the nearest marker within reach and breaks ties on id.
- `updateMarker` re-files a marker dragged across a chunk seam: it appears
  exactly once, in the new chunk, at the new point.
- `updateMarker` drops a spawner's settings when the patch changes the kind to
  one that cannot read them.
- `updateMarker` on an id nothing holds changes nothing and reports so.
- Selecting does not disturb the marker tool's placement defaults.
- `visibleGroups('select')` shows the select folder and nothing else's.
- An edit is one undo entry, and undoing restores the marker's previous values.

## Out of scope

- **How many bodies a spawner holds.** `SpawnerState.entityId` is one id and it
  is replicated as `SpawnerStates`; a count is a change to the sim's spawner
  state, the wire and the overlay, which is a feature rather than a property of
  the marker in front of you.
- **Per-spawner monster level or stat overrides.** A monster's numbers are a row
  in `MONSTERS`, and a document that could override them would be a second place
  balance lives.
- **Editing the four kinds nothing reads** past their label and position. They
  are still sockets with nothing plugged in, and the panel still says so.
- **Renaming a marker's id.** It is what the document is keyed on, and
  `nextMarkerId` generates it precisely so it is never typed.
- **Multi-select.** One marker, one panel.
