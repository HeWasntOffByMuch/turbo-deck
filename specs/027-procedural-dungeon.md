# 027 — Procedural dungeon: interconnected rooms, entry/exit, room-lock combat

## Problem

Every mode so far fights in one static open arena. This spec adds a procedurally
generated dungeon: a graph of rectangular rooms of varied sizes joined by
corridors, with a single entry room and a single exit room. Rooms are combat
encounters — walking into an uncleared room seals its doors and spawns its
enemies; defeating them all reopens the doors permanently. A room is only ever
cleared once, so once the dungeon is beaten the player roams the whole layout
freely. The art is the committed `assets/FD_Dungeon_Free.png` 48×48 tileset.

Determinism (spec 003) holds throughout: the entire layout — room count, sizes,
positions, corridor routing, entry/exit choice, per-room enemy roster — is drawn
from the sim's seeded `Rng`. Same seed ⇒ same dungeon, byte for byte.

Two layers, sim first then render:
1. `src/sim/dungeon.ts` — **pure** generation + tile model + collision. No
   combat/DOM deps.
2. `src/game/dungeon-session.ts` — composition root wiring the dungeon to the
   existing combat sim (the only place a room trigger becomes spawned enemies).
3. `src/render/dungeon/*` — thin tileset renderer. No game rules.

## 1. Tile model + generation (`src/sim/dungeon.ts`, pure)

A dungeon is a grid of `TileKind` cells at `TILE = 48` world units each:

```ts
type TileKind = 'void' | 'wall' | 'floor' | 'door';

interface Room {
  readonly id: number;
  // Interior floor rect, in tile coordinates (inclusive origin, exclusive extent).
  readonly x: number; readonly y: number; readonly w: number; readonly h: number;
  readonly kind: 'entry' | 'exit' | 'combat';
  readonly doors: readonly GridPos[];   // boundary cells that open onto corridors
  readonly enemyCount: number;          // rolled roster size (0 for entry/exit)
}

interface Dungeon {
  readonly seed: number;
  readonly cols: number; readonly rows: number;
  readonly tiles: readonly TileKind[];  // row-major, length cols*rows
  readonly rooms: readonly Room[];
  readonly corridors: readonly GridEdge[]; // room-id pairs that were joined
  readonly entryRoomId: number;
  readonly exitRoomId: number;
  readonly rng: Rng;                    // stream position after generation
}

function generateDungeon(seed: number, opts?: DungeonOptions): Dungeon;
```

**Algorithm (all draws threaded through one `Rng`):**
1. Fill the grid with `void`.
2. Place up to `opts.roomAttempts` rooms: each a random rectangle with side
   lengths in `[ROOM_MIN, ROOM_MAX]` tiles at a random position inside the grid
   margin; reject any that overlaps an existing room (including a 1-tile gap) so
   rooms never touch. Keep the accepted rooms (target `opts.roomCount`).
3. Connect rooms into one component: sort by position, join each room to the
   nearest already-connected room with an **L-shaped corridor** (1 tile wide)
   carved between their centres. Then add a few extra nearest-neighbour edges
   (`opts.extraLoops`) so the graph has loops — "interconnected", not a tree.
4. Carve: room interiors and corridors become `floor`.
5. Walls: every `void` cell orthogonally or diagonally adjacent to a `floor`
   becomes `wall` (a 1-tile shell around all walkable space).
6. Doors: each cell where a corridor meets a room's boundary is marked `door`
   and recorded on that room. Doors are walkable when the room is open.
7. Entry/exit: entry = the room whose centre is nearest a grid corner; exit =
   the room graph-farthest (BFS hops) from entry. Both are non-combat
   (`enemyCount = 0`); every other room is `combat` with a rolled roster.

**Helpers (pure, exported):**
- `tileAt(d, cx, cy): TileKind` (out-of-bounds ⇒ `'void'`).
- `worldToTile` / `tileCenterWorld` conversions at `TILE`.
- `roomAtWorld(d, world): Room | null` — the room whose interior contains a point.
- `resolveMove(from, desired, radius, isSolid): Vec2` — axis-separated
  circle-vs-tilemap slide: move X then Y, cancelling the axis whose swept circle
  would overlap a solid cell, so the mover slides along walls instead of
  sticking. `isSolid(cx, cy)` is supplied by the caller so door cells can be
  solid (locked) or passable (open) dynamically.

## 2. Combat hook (`src/sim/combat.ts`, additive)

Backward-compatible so every existing spell/arena test is untouched:
- `step(state, input, mods, collide?)` gains an optional
  `collide(from, desired, radius) => Vec2` movement resolver used for the player,
  homing enemies, and dashes. When omitted it clamps to the arena rectangle
  exactly as before (same result for both radii), so determinism of prior modes
  is preserved bit-for-bit.
- Export `makeHuntingEnemy(id, typeKey, position, tick, opts?)`: build one
  already-hunting `EnemyState` at a given world position, for the session to
  inject a room's roster (no use of the ambient/wave spawner).

## 3. Room-lock state machine (`src/game/dungeon-session.ts`)

Owns a single persistent `CombatState` (the player lives here for the whole run)
plus the `Dungeon` and per-room `status: 'idle' | 'locked' | 'cleared'`.

Invariant: **at most one room is `locked` at a time** — the player can only be
inside one room, so any live enemy belongs to the active room. That collapses
"which enemies belong to which room" to "all current enemies".

Each tick (`stepDungeonGame`):
1. Build `isSolid(cx, cy)` from the static tiles plus dynamic door state: a
   `door` of a `locked` room is solid; every other `door`/`floor` is passable.
2. Advance combat with that `collide` resolver (player + enemies slide on walls
   and are sealed inside a locked room by its solid doors).
3. Room triggers, from the post-step player centre:
   - Player interior-enters an `idle` `combat` room ⇒ `locked`; inject its
     rolled roster (deterministic type/position from the run `Rng`); emit
     `roomEntered`.
   - A `locked` room with zero live enemies ⇒ `cleared`; emit `roomCleared`.
   - Player interior-enters the exit room after all combat rooms are `cleared`
     ⇒ emit `dungeonComplete` (once).
4. Cleared and entry/exit rooms never re-trigger; the player roams freely.

`DungeonInput` mirrors the combat input the renderer already samples (move dir,
aim, attack, parry, dodge). Enemy rosters, positions and every trigger are pure
functions of `(seed, inputs)`.

## 4. Render (`src/render/dungeon/*`, no game rules)

A camera-follow Canvas2D view that blits the 48×48 tileset:
- floors (blue/red/purple stone slabs + dirt), walls (brick courses), void
  (dark), door plates (arrow/switch tiles) — a documented `(col,row)` index map.
- A locked room's doors draw closed/barred with a warning tint; open doors draw
  as floor. Entry/exit rooms get a distinct marker.
- Actors (player + enemies) reuse the baked pixel-dude skins and telegraph/health
  drawing already used by the arena view.
- If the PNG has not loaded yet, a procedural fallback draws flat-colour tiles so
  the layout is always visible; no gameplay depends on the atlas.

## Invariants tested (sim + session, pure Node)

- **Determinism:** same seed ⇒ identical `Dungeon` (tiles, rooms, corridors,
  entry/exit); same seed + inputs ⇒ identical session state and events.
- **Connectivity:** every room is reachable from the entry room across corridors
  (BFS over floor/door cells).
- **Entry/exit:** exactly one entry and one exit, they differ, both non-combat.
- **No overlap:** room rectangles never overlap and never touch (≥1-tile gap).
- **Walls seal walkable space:** no `floor`/`door` cell sits on the grid border,
  and every walkable cell's non-walkable neighbours are `wall`, not `void`.
- **Collision:** `resolveMove` never lets a circle's centre end inside a solid
  cell; a move straight into a wall slides along it (one axis preserved).
- **Lock/clear loop:** entering a combat room locks it and spawns exactly its
  roster; while locked the player cannot cross its (now-solid) doors; clearing
  all enemies sets `cleared` and reopens the doors; a cleared room never locks
  again.
- **Completion:** `dungeonComplete` fires once, only after every combat room is
  cleared and the player reaches the exit.

## Out of scope

- Multi-floor / stairs between dungeons, keys/locked treasure, traps, props as
  collidables (barrels/chests are decoration only), pressure-plate puzzles.
- Enemy pathfinding through corridors or between rooms; enemies are confined to
  their room (a convex rectangle, so homing needs no pathfinding).
- Non-rectangular / diagonal rooms; autotiled wall corners (a single wall tile is
  used for all wall cells).
- Changes to the existing spell-card arena game or its tuning.
