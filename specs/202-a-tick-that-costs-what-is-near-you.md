# 202 — A tick that costs what is near you

## Problem

The sim already knows what is resident: `isSimulated` gates stepping on
`activeChunks`, and spec 198 narrowed that to 7×7 interest chunks. But three
things inside a tick are sized by **what the world contains** rather than by what
is near anybody, and each of them gets worse in direct proportion to the map
growing.

Measured, with **one player and 49 chunks active throughout** — residency never
changed across any row:

| spawn points in the world | entities | tick |
|---|---|---|
| 14 (today's map) | 15 | 38 µs |
| 200 | 201 | 806 µs |
| 800 | 801 | 3,804 µs |
| 3,200 | 3,201 | **17,366 µs** |
| 12,800 | 12,801 | **107,685 µs** |

A tick is 16,667 µs. Nothing about what the player could see changed between the
first row and the last.

A CPU profile of the last row attributes it:

| | share |
|---|---|
| `segmentClear` | **37%** |
| `step` itself | 26% |
| `monsterIntent` | 10% |
| `runSpawners` | 6% |
| `notice` + `nearestQuarry` | 3% |

### 1. `segmentClear` walks every collider in the world

```ts
export function segmentClear(a, b, radius, world = DEFAULT_WORLD): boolean {
  for (const rect of world.rects) { ... }
  for (const circle of world.circles) { ... }   // all 28,919 of them
}
```

Spec 192 built `ColliderIndex` because "`pushOutOfObstacles` and `circleBlocked`
used to test every circle in the world … the tick was `bodies × colliders` and
growing the map made standing still more expensive". It indexed those two and
**left `segmentClear` on the linear walk** — and `segmentClear` is what
`pathClear` is, which every routing monster asks every tick, and what aggro's
line of sight is.

Measured over 2,000 real segments on `maps/arena`:

| | per segment |
|---|---|
| linear walk (today) | **84.02 µs** |
| indexed | **1.27 µs** |

66×, with **zero disagreements** across all 2,000. And the 84 µs is today's
number, on today's map: at the 4× target there are ~463,000 circles rather than
28,919, so it becomes ~1,300 µs — a single line-of-sight check costing a
twelfth of a tick.

This is the urgent one, because unlike the other two it is already expensive at
the size the game is now.

### 2. `nearestQuarry` walks every entity, per noticing monster

```ts
for (const other of entities.values()) {
  if (other.kind !== EntityKindValue.Player) continue;
  ...
}
```

Called by `notice` for every monster deciding whether it has seen somebody. The
scan is over the whole entity map to find a handful of players, so it is
`resident monsters × every entity in the world` per tick.

### 3. `runSpawners` walks every spawn point, and its population cap is quadratic

`runSpawners` iterates `context.spawnPoints` — every spawner the map declares,
resident or not — every tick, at ~77 ns each. And inside it:

```ts
for (const entity of entities.values()) {
  if (chunkKeyOf(...) === key) population += 1;
}
```

per spawner, per tick: `O(spawn points × entities)`.

**A correction to the plan.** It said "the fix already exists —
`ChunkManager.populationOf(key)` is O(1)". It exists and has **no caller
anywhere in the tree**, and it is also the *wrong* fix here: `chunks.track` and
`chunks.remove` run **after** `step()` returns, so during a tick the manager's
occupancy is the previous tick's — it would not see a body killed this tick, and
`runSpawners` runs after the sweep that killed it. The right fix is to count
once per tick from the live entity map.

## Shape

Nothing here changes what the sim decides. All three are the same answers,
reached without walking things that cannot matter.

```ts
// collision.ts — the index spec 192 built, used by the query it missed.
export function segmentClear(a, b, radius, world = DEFAULT_WORLD): boolean;
```

Internally it narrows the circles to the segment's bounding box inflated by
`radius`, through `circlesInRect` (added in spec 201 for nav tiles). A bounding
box rather than a walk down the segment's cells: a long diagonal over-fetches,
and that is still a few dozen circles against 28,919.

Order does not matter and so nothing about determinism does either —
`segmentClear` returns "did anything hit", which is order-independent, unlike
`pushOutOfObstacles`, whose result depends on the order corrections are applied
and which is exactly why `circlesNear` promises ascending original order and
`circlesInRect` does not.

```ts
// aggro.ts — the players, gathered once per tick rather than per monster.
function nearestQuarry(monster, players: readonly ServerEntity[], range): number | null;
```

A list of players rather than the entity map. The caller builds it once; it is
the same list for every monster in the tick.

```ts
// world.ts — population per chunk, counted once per tick.
function populationByChunk(entities, chunkSize): ReadonlyMap<ChunkKey, number>;
```

And `runSpawners` iterates **resident** spawn points: a `chunk → spawn point
ids` index, built with the spawn point list rather than per tick, intersected
with `activeChunks`.

## What it measured

`npx tsx scripts/bench-tick-scale.ts`, before and after, on the identical
fixture — one player, 49 chunks active, the same handful of spawn points inside
the window, and the only difference between rows being how much world there is
*further out*:

| spawn points | before: entities / tick | after: entities / tick |
|---|---|---|
| 14 | 15 / 102 µs (×1.0) | 5 / 33 µs (×1.0) |
| 200 | 201 / 79 µs (×0.8) | 10 / 32 µs (×1.0) |
| 800 | 801 / 377 µs (×3.7) | 10 / 36 µs (×1.1) |
| 3,200 | 3,201 / 1,405 µs (×13.7) | 10 / 24 µs (×0.7) |
| 12,800 | 12,801 / 7,492 µs (×73.1) | 5 / 32 µs (×1.0) |

**×73 → flat**, and 7,492 µs → 32 µs at the extreme. The entity column is half
the story on its own: the world used to hold every monster it declared from the
first tick, and now holds the ones somebody is near.

Two things the bench itself got wrong first, both of the same kind — a fixture
that varied something other than the thing being measured:

- **Fixed area, growing count, is a density test.** Spreading `n` points over a
  constant square makes a bigger `n` a *denser* world, so more of them land
  inside the window and the tick grows because more is resident — correct
  behaviour reported as a failure. It is fixed *spacing* now, so a bigger world
  is bigger elsewhere.
- **A grid laid from a corner moves the player.** With the origin at a corner
  the player stood in a different place on every row — inside the arena's trees
  for the small worlds, far outside them for the big ones — and one row came
  back five times its neighbours. Centred, every row puts the player on the same
  ground with the same neighbours.

## Invariants tested

- **`segmentClear` answers exactly what the walk answered.** Over thousands of
  segments on the shipped map, including ones that start or end inside a
  collider, ones entirely outside the index's extent, and zero-length ones.
  Equality, not a tolerance: this is the deterministic core, and "faster and
  nearly the same" is a divergence with a delay on it.
- **A tick's cost stops tracking the world's totals.** The table above, run as a
  test on the *slope* rather than the value: at fixed residency, growing the
  world's spawner and entity count by 16× must not grow the tick by more than a
  small constant factor. A test on the value would be a test about this
  container.
- **`nearestQuarry` picks the same body**, including the tie rule — the first in
  insertion order keeps a tie, which a gathered list must preserve.
- **The population cap still refuses.** A spawner in a full chunk waits, and the
  count it reads is *this* tick's, including a body killed earlier in the same
  tick. That last part is what `populationOf` would have got wrong.
- **Spawn points outside the active set are not walked**, asserted by counting
  rather than by timing.
- **A replay is bit-identical**, from the same seed and inputs, before and after.
  This is the one that matters: every change here is a claim that the same
  answer is reached by less work.

## Out of scope

- **Terrain residency.** The map is still loaded whole; boot and heap are
  untouched. That is spec 203, and it is where the 48 s and 2.0 GB live.
- **Entity eviction.** Nothing is unloaded here — non-resident bodies keep
  existing and keep being skipped, exactly as they are today. Making them stop
  existing needs the `SpawnerState` third state and the "eviction is not death"
  table, which belongs with terrain residency.
- **A swept segment query.** The bounding box is enough for the segment lengths
  the sim actually asks about (100–800 units); walking the cells along the
  segment would be a second index query shape for a fraction of a microsecond.
- **`resolveOverlaps`**, which has no caller and is a survivor of the
  single-player sim spec 062 deleted.
