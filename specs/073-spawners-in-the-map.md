# 073 — Spawners in the map

## Problem

There are monsters in the game and no honest way to put them anywhere.

Two mechanisms exist today and neither is one. `runSpawner`
(`src/server/sim/world.ts`) is an *ambient* spawner: every active chunk rolls
against a zone spawn table on a cadence and drops a monster at a random point
inside it. It has no notion of place — a chunk is 400 units of nothing in
particular — and no notion of a population, only a per-chunk cap it climbs to
and sits at. The Play tab's answer to that is `server.liveConfig.set('spawnRateMultiplier', 0)`
and a `seedTheField()` that hand-places two grazers and a stalker relative to
wherever the player happened to land, once, in the renderer. So the only
monsters anyone has ever fought were placed by the *client*, in a file that is
not allowed to change a game outcome, and they never came back.

Meanwhile spec 072 made the map a document the server loads and the editor
edits, and that document already carries markers: named points with a kind, in
world space, placed by hand and streamed to clients with the chunks they sit in.
A spawn point is exactly a named point in world space. The mechanism is built;
nothing has ever read it.

This spec makes the map the only place enemies come from, gives each spawn point
its own timer, and takes the two AI behaviours that make a placed monster
different from an ambient one — it does not jump you for walking past, and it
does not follow you across the world — from nothing to something.

## Assumptions

- **A spawner is a marker, not a new document section.** `MapMarkerKind` gains
  `'spawner'` and the marker's existing `label` carries the monster id. A parallel
  `spawners: [...]` array on the layer would need its own parser, its own wire
  encoding, its own editor tool and its own undo entry, all to express `{kind,
  id, x, z, label}` — which is a marker. The label reads as a label, too: a
  billboard over the spawn point that says `stalker` is what you want the editor
  to draw anyway.
- **One spawner, one monster, at a time.** No pack size, no spawn table, no
  weights. A camp of four is four markers, which is a thing you can see in the
  editor and count in the diff; a `count: 4` on one marker is a thing you cannot.
- **The respawn delay is server config, not per-marker.** `spawnIntervalTicks`
  already exists, already defaults to 300 (5s at 60Hz), and is already live-tunable
  from the admin console. It changes meaning from "how often a chunk rolls" to
  "how long after its monster dies a spawner refills", which is the only meaning
  left for it. Per-marker delays are a later spec if a boss ever wants one.
- **Enemies leave nothing behind.** `CORPSE_TICKS` goes; a monster is deleted the
  tick its health reaches zero. Corpses, loot and death animations are their own
  feature, and a five-second body that cannot be interacted with is not a corpse,
  it is a monster you can no longer hit standing in the doorway.

## Shape

### The document

```ts
// src/terrain/map.ts
export type MapMarkerKind = 'spawn' | 'objective' | 'campfire' | 'trigger' | 'spawner';
```

`MapMarker` itself is unchanged. For `kind: 'spawner'`, `label` is a monster id
from `src/server/data/monsters.ts`. `MapMarkerKindValue`
(`src/server/net/protocol.ts`) gains `'spawner'` **at the end**, because that
array's index is the marker's byte on the wire.

### Reading them

```ts
// src/server/world/spawners.ts   — pure
export interface SpawnPoint {
  /** The marker's id, unique across the document. */
  readonly id: string;
  readonly monsterId: string;
  readonly x: number;
  /** The document's `z`. The sim's ground plane is (x, y). */
  readonly y: number;
}

export function spawnPointsFrom(doc: MapDocument): readonly SpawnPoint[];
```

Sorted by id, so the order a spawner is considered in does not depend on which
chunk it happened to be baked into. A spawner whose `label` is not a known
monster id **fails the boot**, in the same voice spec 072 fails an unparseable
map: a spawner that silently never spawns is indistinguishable from a spawner
that is working and whose monster is alive, so it would be found by nobody.

`BuiltMapWorld` gains `readonly spawnPoints: readonly SpawnPoint[]`, and
`StepContext` carries them into the tick.

### The timer

Spawner state is sim state — it is replayed, so it belongs in
`ServerWorldState` and not on the side:

```ts
// src/server/sim/types.ts
export interface SpawnerState {
  /** The live spawnee, or null when this spawner is empty. */
  readonly entityId: number | null;
  /** Earliest tick a replacement may appear. 0 means "now". */
  readonly readyAtTick: number;
}

interface ServerWorldState {
  // ...
  readonly spawners: ReadonlyMap<string, SpawnerState>;
}
```

A spawner with no entry is empty and ready, so tick 0 fills every spawner on the
map — **the world is populated on boot**, with no first-interval wait. The timer
is stamped when the body is *removed*, not when the tick comes round:

```
death (health -> 0)  ->  entity deleted, `despawned` emitted,
                         spawners[spawnerId].readyAtTick = tick + interval
tick >= readyAtTick  ->  spawn at the marker, entityId = the new body
```

`interval = max(1, round(config.spawnIntervalTicks / config.spawnRateMultiplier))`,
so `spawnRateMultiplier = 0` still stops spawning dead from the admin console
and the existing `maxEntitiesPerChunk` cap still refuses a spawn into a chunk
that is already full. A spawner whose entity vanishes for any other reason
(an admin despawn) is noticed by the same check and refills on the same delay.

The entity gains two fields, neither of which goes on the wire:

```ts
/** The map spawner that produced this body, or null. */
readonly spawnerId: string | null;
/** Where it was spawned. The centre of its leash. */
readonly anchor: Vec2 | null;
```

`runSpawner`'s ambient half — the per-chunk cadence, the zone roll, the random
offset — is deleted, and with it `ZoneDefinition.spawnTable`, which nothing else
reads. The spawner no longer draws from the sim's `Rng` at all: where a monster
appears and when are now both decided by the document and the clock, which
leaves the RNG stream to combat alone.

### Not aggressive until attacked

The proximity scan in `monsterIntent` goes. Retaliation is already the only other
way a `targetId` is written (`applyDamage`: `targetId: target.targetId ?? attacker.id`),
so removing the scan leaves exactly the requested rule with no new code: a
monster fights the first thing that hits it and ignores everything else.

`MonsterDefinition.aggroRange` stays in the table, unread, because it is the
number a later spec turns back on per-monster — and `passive` stays for the same
reason. Nothing in the data changes; what changed is that the sim stopped asking.

### The leash

```ts
export const LEASH_RADIUS = 800;   // world units, from the spawn point
```

Evaluated every tick, in `monsterIntent`, before anything else:

- Beyond `LEASH_RADIUS` from `anchor`: drop the target and route home to
  `anchor`. Being hit on the way home re-targets the attacker exactly as before,
  and the next tick drops it again — so "cannot be re-aggroed while leashing" is
  a consequence of the rule rather than a second piece of state to keep.
- Within it, and holding no target: stand.
- Within it, holding a target: chase and swing, unchanged.

Walking home uses `routeToward`, the same A* the chase uses, so a monster
dragged round a wall walks back round it rather than into it. It stops when it
is within its own radius of the anchor; it does not heal, and it does not
re-place itself exactly — an inch of drift is cheaper than a teleport.

### Watching them

The overlay needs two things the client cannot derive: which spawners exist
outside the chunks it has cached, and how much of each timer is left. Both come
from the server, and only to a client that asked — this is a debug channel, and
it should cost nothing when it is off. `PROTOCOL_VERSION` goes to **8**.

```
0x0b WatchSpawners   bool on
0x51 SpawnerStates   varuint count ·
                     (str id · str monsterId · varint x · varint z ·
                      u8 state · varuint ticks) × count
```

`state` is `0` occupied, `1` counting down; `ticks` is the remainder of the
timer, and 0 when occupied. Coordinates are thousandths like every other
coordinate on this wire (spec 072). The whole map's spawners go in one message —
they are markers a level designer placed, so there are tens of them, not
thousands — and it is sent on broadcast ticks, at 20Hz, to watching connections
only.

`ClientView` gains `readonly spawners: readonly SpawnerStatus[]`, empty until
the toggle is on.

### The toggle

The Play tab already has a settings surface — the cog in the corner, built by
`src/render/iso3d/view-controls.ts` — so the toggle is one more checkbox in it,
under Terrain beside "Unwalkable terrain", off by default and read the same way
every other one is: a getter on `ViewControls`.

```ts
interface ViewControls {
  // ...
  /** Whether the map's spawn points and their timers are drawn. */
  showSpawners(): boolean;
}
```

`view.ts` **watches** that getter rather than binding to a change event, because
the panel's "Reset" button moves the checkbox too, and a subscription that
survived a reset would be a leak. When it changes, it calls
`client.watchSpawners(on)`; when it is on, it draws.

The wording is pure and tested headlessly, because "what does this say" is the
half worth asserting:

```ts
// src/render/iso3d/world/spawner-overlay.ts
interface SpawnerLabel {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly text: string;    // "grazer", or "grazer · 4.3s"
  readonly waiting: boolean;
}
function spawnerLabels(spawners: readonly SpawnerStatus[], tickRate: number): readonly SpawnerLabel[];
```

Seconds round **up**: a countdown that reaches zero before the monster does is
the one number this overlay must not show. A timer already at zero says `due`
rather than `0.0s`, because a spawner held up by the population cap is waiting
on something a countdown cannot describe.

Drawing is HUD DOM, like the health bars and for the same reason — text through
the low-resolution buffer and the dither pass comes out as chewed pixels.
`WorldScene` gains a `projectPoint(x, y)` alongside `screenAnchors()`, since a
spawner is a world position rather than a body. No `if` in the renderer changes
an outcome: the toggle asks the server for a readout and draws what comes back.

### The map

`maps/arena.json` gets spawner markers around the player's spawn at (600, 450) —
enough grazers, stalkers and a ravager to have something to fight in every
direction. `seedTheField()` and the Play tab's `spawnRateMultiplier = 0` both go:
the tab stops placing monsters, because the map does.

## Invariants tested

- **Boot populates.** From a document with N spawners, the world holds N
  monsters after one tick, each at its marker, each of its marker's type.
- **One at a time.** A spawner with a living spawnee never adds a second, for any
  number of ticks.
- **The timer starts at death, and runs.** Kill a spawnee: it is gone from
  `entities` on that tick, and no replacement exists until exactly
  `spawnIntervalTicks` later, when one does — at the marker, not where the old
  one died.
- **Replay.** The same seed and the same inputs against the same map produce
  bit-identical state, spawners included; and a spawn consumes no RNG, so a
  replay's combat rolls are unaffected by how many things have spawned.
- **A bad label fails loudly.** `spawnPointsFrom` on a document with an unknown
  monster id throws, naming the marker.
- **Nothing is aggressive.** A player standing inside every monster's former
  `aggroRange` for a thousand ticks is never attacked; one that lands a hit is
  attacked on the next tick.
- **The leash holds.** A monster led past `LEASH_RADIUS` from its anchor drops
  its target, ends up back within its own radius of the anchor, and does not
  re-acquire the player who is still hitting it while it walks.
- **Round trip.** A `'spawner'` marker survives `serializeMap`/`parseMap` and
  `encodeMapChunk`/`decodeMapChunk` with its label intact.
- **The channel is opt-in.** A connection that has not sent `WatchSpawners`
  receives no `SpawnerStates` message; one that has receives one per broadcast,
  and stops receiving them when it sends `false`.
- **The shipped map is valid.** `maps/arena.json` parses, and every spawner
  marker in it names a monster in `MONSTERS`.
- **The countdown never lies.** `spawnerLabels` rounds up, so one tick left
  reads `0.1s` and never `0.0s`; a timer already at zero reads `due`; an
  occupied spawner carries no timer at all.

## Out of scope

- **Corpses**, loot, and anything that stays behind when a monster dies.
- **Proximity aggro**, herds, calls for help, and any target selection beyond
  "whoever hit me first". `aggroRange` and `passive` stay in the table, unread,
  waiting for the spec that turns them back on.
- **Healing on leash.** A monster that walks home walks home hurt, so a player
  who kites one past the leash twice fights it at half health the second time.
  Cheap to add, and it wants a regeneration rule rather than a snap to full.
- **Per-marker respawn delays, pack sizes and spawn tables.** One marker, one
  monster, one server-wide delay.
- **Levels, elites and zone scaling.** A spawner names a monster id and that is
  the whole of its content.
- **Spawner state in the editor.** The editor places markers; the countdown
  overlay is the running game's, and the editor has no server to ask.
- **Bounding `SpawnerStates` by interest.** The whole map's spawners go to a
  watching client. That is fine for a map with tens of markers and is the first
  thing to fix for one with thousands.
