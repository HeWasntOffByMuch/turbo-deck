# Map loading / chunk streaming, end to end (traced 2026-08-17)

Supersedes the "terrain was never sent over the wire" headline in
`world-terrain-network.md` (that was true pre-spec-072; spec 072+ streams
terrain for real, spec 147 hardened retries, spec 078/083/146 handle partial
coverage). This note is the current, accurate path.

Three independent "chunk" grids exist in this codebase — do not conflate them:
- **Terrain mesh buckets**: 22-unit cells x 28 = **616-unit** map chunks
  (`src/terrain/chunk.ts:49 DEFAULT_CHUNK_OPTIONS = { cellSize: 22, chunkCells: 28 }`,
  841 corners / 784 cells per chunk). This is what streams over the wire.
- **Entity interest chunks**: 400-unit (`CHUNK_SIZE`, config.ts:48), used only
  by `ChunkManager` (src/server/world/chunk-manager.ts) to decide which
  *entities* go in a player's `Delta` message. Unrelated to terrain.
- **Prop instancing regions**: 1100-unit (`REGION_SIZE`, src/render/iso3d/props.ts:46),
  a pure draw-call-batching/culling bucket on the client, unrelated to both.

## 1. Server boot

- `maps/arena.json` -> `src/server/world/map-file.ts:loadMapFile()` — sync
  `readFileSync` + `parseMap` (src/terrain/map.ts). Throws and kills the
  process on a missing/malformed file; no fallback to the procedural
  generator (comment: a server silently playing a different world is exactly
  the bug this removes).
- `src/server/world/map-index.ts:buildMapIndex(doc, mapId)` builds an O(1)
  lookup index once at boot: `chunkAt(layer,cx,cz)`, `centreOf`, sorted
  `species` table, `mapId = mapIdOf(text)` (FNV-1a over the raw file text,
  8 hex digits — identity check, not security).
- `src/server/server.ts:358` wires `this.mapIndex` from the built world.
- Per connection: `sendMapInfo` (server.ts:1026) is pushed **unprompted**
  right after `Welcome`, on both fresh spawn (server.ts:1012) and resume
  (server.ts:957-961) — a reconnect that skipped it left a client with no
  chunk list and therefore no ground. `MapInfo` carries every layer's
  scalars (`origin`, `bounds`, `baseY`, `waterLevel`) and the **coordinate
  list of every chunk that exists** (not the chunk bodies) plus the sorted
  species string table. No per-chunk work happens at this point — it's a
  metadata dump straight out of the already-built index.
- Chunk *bodies* are never pushed; they are requested. `handleChunkRequest`
  (server.ts:1057) → `decideChunkRequest` (src/server/world/map-request.ts:123):
  1. `index.chunkAt` — unknown chunk → `ChunkDeniedReason.Unknown`, permanent.
  2. Chebyshev distance from the **server's own entity position** (never the
     client's claimed position — `entity.position`, not `predictedX/Y`) vs
     `MAP_CHUNK_REQUEST_RADIUS = 6` chunks (config.ts:146) → `OutOfRange`.
  3. Per-connection `ChunkBudget` token bucket (`MAP_CHUNK_BURST = 64`,
     `MAP_CHUNK_REFILL_PER_SECOND = 16`, config.ts:226-227) → `Throttled`.
  On success the raw `MapChunk` from the index (already-baked JSON-shaped
  arrays, no per-request computation) is sent as-is.

**Per-chunk server-side work is essentially zero at request time** — chunks
are baked once at load (parseMap) and served as a map lookup. All the real
cost is in the wire encoding (below) and the client-side mesh build.

## 2. Wire: encoding, sizes, throttling

`src/server/net/map-messages.ts`:
- `MapInfo` (`0x4e`? see protocol.ts) — one message, sent once per
  session/resume. Varint-quantized rects, one `u32`/layer seed, chunk-coord
  list per layer as raw varints. Cheap; not the bottleneck.
- `MapChunk` — one message per chunk, ~4-12KB (config.ts:206-220 comment:
  "the server serialize ~12 KB per request"). Encoding tricks:
  - Heights: **delta-encoded against the previous corner + zigzag varint**
    (map-messages.ts:244-254) — "roughly half the size of the raw values."
  - `solid`/`materials`/`tones`: sent as the document's own **run-length
    pairs** (`value, count`), not expanded — a 784-cell chunk of open meadow
    is 4 numbers.
  - Props: **local species table per chunk** (index into 1-3 strings) rather
    than a string per prop.
  - Every coordinate is an **integer of thousandths** (`MAP_QUANTUM`), never
    `f32` — sending the float would be a few ulps off the server's own value
    and manifest as spurious position corrections on flat ground.
- `ChunkDenied` (`Unknown`/`OutOfRange`/`Throttled`) — 16 bytes, tiny.

**Trigger for a chunk send**: pull, not push. The client asks. There is no
server-side "push what's near this player" logic — see client loop below.

**Throttling, two independent layers**:
- Client pull rate: `requestChunks()` (game-client.ts:1646) is driven from
  `advanceTick()` every `CHUNK_REQUEST_INTERVAL_TICKS = 3` ticks (50ms @
  60Hz) — not from deltas, deliberately, because a delta is suppressed when
  nothing changed and a standing player would stop asking on a half-loaded
  map. Each pass asks `MapChunkCache.wanted()` for **up to
  `CHUNK_REQUESTS_PER_PASS = 8`** nearest-first, not-yet-held/in-flight/absent
  chunks within `MAP_CHUNK_REQUEST_RADIUS = 6` chunks Chebyshev of the
  player's *drawn/predicted* position. Also re-pumped immediately on every
  `MapChunk` arrival (game-client.ts:1828) — "this is what actually paces a
  cold start: the window fills as fast as the link carries it."
- Server push rate: the `ChunkBudget` token bucket above (burst 64, refill
  16/s) — sized specifically so a **cold start of the shipped map's 56
  chunks is not throttle-paced** (burst covers it outright); the bucket only
  bites a client re-asking one in-range chunk in a loop.
- Retry: `CHUNK_RETRY_TICKS = 180` (3s) — if a `RequestChunk` or its
  `MapChunk` answer is simply lost (no retransmit anywhere), the client
  re-asks after 3s. `Throttled` denial sets a client-side
  `chunkBackoffTicks = CHUNK_THROTTLE_BACKOFF_TICKS = 15` (0.25s) pause on
  the whole pump, not just that chunk.

So for the shipped 56-chunk map: 8 chunks every 50ms into a 64-token budget
→ **cold start is bounded by ~8 round trips of network latency** in the
best case (loopback: effectively free), not by the token bucket.

## 3. Client: session + render-side chunk-to-geometry

`src/server/client/game-client.ts`:
- `case ServerMessageType.MapInfo` (1816): fresh `MapChunkCache` (a full
  replace, not merge — different `mapId` means the old chunks describe
  ground that no longer exists), then `requestChunks()`.
- `case ServerMessageType.MapChunk` (1824): `mapCache.accept()` (validates
  `mapId` match, clears the in-flight mark, bumps `revision`), then pumps
  `requestChunks()` again.
- `case ServerMessageType.ChunkDenied` (1835): `Unknown` → permanent
  "absent" set (never re-asked); `Throttled` → backoff as above.
- `mapView()` (1630) exposes `{ info, chunks: held(), revision }` on
  `client.view().map` — read once per render frame.

`src/render/iso3d/world/view.ts:ingestChunks()` (line 290), called **once
per animation frame** (line 1638, inside `frame(now)`):
1. First call: builds `StreamedMap` from `MapInfo` (empty world, no chunks)
   and hands it to `scene.setMap()`.
2. For each `HeldChunk` not yet seen by `StreamedMap`
   (`src/server/client/streamed-map.ts:add()`): `store.insertChunk()` is
   **O(1)** — `MapChunkStore` is a sparse `Map<"cx,cz", StoredChunk>`, and
   everything derived from it (`TerrainWorld.heightAt`, `MeshLayer.solidAt`)
   is a closure reading through the live store, so nothing needs rebuilding
   on insert.
3. `add()` then rebuilds **the arrived chunk plus up to its 4 edge
   neighbours** (never diagonals) via `store.buildChunk()` — because a
   chunk's mesh reads across its edge for wall visibility and corner-normal
   apron, so a neighbour meshed before this chunk existed has a stale seam.
   That's up to 5 `buildChunk()` calls per arrival, each O(chunk size) —
   `841` corners: compute jittered corner positions + finite-difference
   normals (`cornerJitter`, cross product per corner).
4. Each dirty `TerrainChunk` → `scene.addTerrainChunk(chunk)` →
   `terrainMesh.rebuild(chunk)` (src/render/iso3d/terrain-mesh.ts:472): full
   re-mesh of *that one chunk's* surface+wall+water geometry (dispose old
   THREE.BufferGeometry, build new), plus **its own 8 neighbours' water
   quads re-baked** (shore distance field reads across the chunk edge too).
5. Props are **not** rebuilt per chunk. `propsDirty` is set; once
   `PROP_SETTLE_FRAMES = 2` consecutive frames arrive with nothing new,
   `scene.refreshProps()` runs **once**: single pass over all
   `map.props()` (~1150-1160 on the shipped map, per in-source comments),
   `buildPropField()` rebuilds every species' `InstancedMesh` batches
   (bucketed by 1100-unit region, src/render/iso3d/props.ts), and
   `makeUnwalkableField(vegetationColliders(props), ...)` rebuilds the
   client's unwalkable-prop field. This is deliberate: "one per chunk would
   be fifty-odd draw calls on every frame from then on."
6. On the same settle, for a **remote** connection only (loopback already
   has the world synchronously — see §4), `fillGround()` gives the movement
   predictor its `WorldColliders`/`TerrainSampler`, and
   `warmNavGrids(...)` is called — explicitly flagged in-source as
   **"around a second on a real map"** of synchronous main-thread work,
   paid once per settle burst rather than inside the frame that gives the
   first move order.
7. `root.dataset['worldReady'] = 'true'` is set once the *first* settle
   completes (terrain meshed + props standing).

### The historical hot spot, fixed but worth knowing about

`streamed-map.ts`'s header comment documents the *previous* implementation
explicitly as the thing to avoid: rebuilding `loadMap` over the whole held
set on every single arrival was **O(chunks held) per arrival, O(n²) across
a cold start — 10.6s of blocked main thread out of the first 12s**, with
single tasks over a second. The fix (sparse `MapChunkStore` + closures +
bounded-neighbour remesh) is what's shipped now. If a future change
reintroduces "rebuild the whole store/world on chunk arrival" anywhere, it
reproduces this exact regression.

### Current remaining costs, worth watching if this file is being read for a
### performance pass

- **`buildChunk()` mesh cost is unbounded per triangle-strip** (784 cells
  x up to 4 wall quads + curvature/cavity calc per vertex,
  `src/render/iso3d/terrain-mesh.ts:186-280`) and runs synchronously on the
  main thread, once per arriving chunk plus up to 4 neighbours. At 8
  chunks/pump this is up to 40 `buildChunk` calls in the same 50ms window,
  each disposing+reallocating THREE.BufferGeometry. Not measured in this
  trace, but the shape (main thread, per-chunk, several times a burst) is
  the shape 10.6s-of-block came from before the O(1)-insert fix; it wasn't
  re-profiled after.
- **`refreshProps()` is O(all props ever seen)**, unconditionally, on every
  settle — including the settle that fires because *one* new chunk arrived
  late during otherwise-idle streaming. On a slow link with many small
  bursts this could re-run the full ~1150-prop instancing rebuild many
  times rather than once; `PROP_SETTLE_FRAMES=2` only coalesces a *single*
  burst, not the whole cold start.
- **`warmNavGrids` at ~1s** runs on *every* prop settle for a remote client
  (not gated to "first settle only" in what was read) — worth confirming
  whether a slow/lossy connection with many small settles pays that ~1s
  more than once. (Open question — see below.)
- Server-side, `MapChunk` bodies are the *baked* document arrays
  (`decodeRuns`-shaped), so there's no per-request terrain computation on
  the server; the cost there is purely wire serialization
  (`encodeMapChunk`), which is allocation + varint writes over ~1600
  numbers, cheap relative to the client's mesh build.

## 4. Initial connect sequence, page load -> first frame

`src/render/iso3d/world/view.ts:mountWorld()`:
1. Canvas/root created synchronously.
2. `?server`/local-vs-remote decided by `planConnection` (`plan.mode`).
3. **Loopback (default single-player) only**: `mapText` (bundled
   `maps/arena.json?raw`, a Vite static import — no network fetch, it's in
   the JS bundle) is `parseMap`'d and `buildWorldFromMap`'d **synchronously
   on the main thread**, `warmRouting(local)` runs (this is the nav-grid
   warm the remote path defers to the settle), and `fillGround()` gives the
   predictor real colliders immediately — so a loopback session's
   *prediction* is correct from frame 0, even though...
4. ...**the drawn scene still goes through the exact same `MapInfo` ->
   `RequestChunk` -> `MapChunk` -> `StreamedMap` pipeline as a remote
   client**, just over an in-process `LoopbackTransport` with zero latency.
   This is deliberate (comment: "handed `world` [directly] it would look
   right while streaming did nothing" — i.e. the streaming path would go
   untested). So even single-player pays the full per-chunk mesh-build /
   settle-based prop rebuild cost, just without network RTT.
5. `GameClient` constructed over an `UnreliableChannel` wrapper (`?wire=`
   can inject synthetic latency/loss even in loopback, seeded from the URL
   for reproducibility).
6. `WorldScene` constructed empty (`new WorldScene(canvas)` — no map yet).
7. Server `accept()`s the connection -> spawns the player entity (position
   already decided, server-authoritative) -> sends `Welcome` -> `sendMapInfo`
   (unprompted) -> `sendStats` -> `sendInventory`.
8. `rAF` loop `frame(now)` starts: each frame, `client.advanceTick()` may
   fire zero or more sim ticks (fixed 1/60 accumulator), then **every
   frame** (not gated by tick) calls `ingestChunks(view)` — so chunk
   meshing happens at *display* frame rate, not sim tick rate, and can run
   several times before the first sim tick even completes.
9. **Player position is known immediately** (server places the entity
   before `Welcome` is sent, and `Welcome`/`Delta` carry it) — well before
   the ground under it has fully streamed in. Nothing blocks the first
   frame on chunk completeness: the world is drawn incrementally, chunk by
   chunk, and `root.dataset.worldReady` only flips true once the *first*
   settle (terrain+props) finishes. Between "connected" and "worldReady"
   the player's own body can be drawn standing over unmeshed/partially
   meshed ground.
10. **Unit `.glb` loads are fully decoupled and async**: `UnitRig.load()`
    (`src/render/iso3d/unit-rig.ts:239`) is `async`, uses
    `GLTFLoader.loadAsync`, and is triggered per-entity as bodies are built
    into the scene (not gated on map streaming, not gated on each other).
    Nothing in `view.ts`/`scene.ts` awaits these before drawing a frame —
    a body appears un-skinned/default for however many frames the fetch +
    parse take, no loading indicator.
11. Asset manifest: `ASSET_MANIFEST_HASH` (src/render/iso3d/world/unit-assets.ts)
    is a **build-time constant** (baked by `npm run bake:units`), not a
    runtime fetch — it's compared by a real server at `Welcome` time to
    refuse a stale client; the in-tab loopback server always accepts it.

## 5. Loading/progress UI and FPS/perf readouts

- **No loading screen, spinner, or progress bar exists anywhere in
  `src/render/` or `src/ui/`.** Grepped for `loading`/`progress` across
  `src/render/iso3d/world/` — zero hits beyond code comments. The world
  simply pops in chunk-by-chunk and prop-burst-by-burst with nothing on
  screen indicating "X of Y chunks loaded" or "still loading" other than
  the terrain visibly filling in.
- The only externally-visible "loading is done" signal is
  `root.dataset['worldReady'] = 'true'`
  (src/render/iso3d/world/view.ts:345), set once after the first
  terrain+prop settle — read by preview/harness scripts
  (`preview-world.ts` etc.), not shown to a player.
- **No FPS counter or frame-time readout exists anywhere** — grepped
  `\bfps\b` case-insensitive across `src/render/`; every hit is the VFX
  sprite-sheet `fps` field (animation frame rate of a particle sprite
  sheet), unrelated to render performance.
- There **is** a "developer readout" (`src/render/iso3d/world/hud.ts:1315`,
  `status.textContent`), but it shows `tick`, `delta tick`, `worldSeed`,
  `hp`, `guard`, `level`, `xp`, `motes%` — game-state debug text that four
  harness scripts parse (per `src/render/iso3d/world/hud.ts` doc comments),
  **not** performance metrics. It does not show chunk count, held-chunk
  count, or streaming progress.
- `data-camera-orbit` / `data-camera-zoom` (src/render/iso3d/view-controls.ts)
  are real but are camera-state mirrors for a probe/harness that can't read
  a phone's inputs, not performance data.
- **Open finding**: there is no client-visible or server-visible metric for
  "how long did the cold start actually take" or "how many chunks are still
  in flight" — anyone doing a live performance pass on chunk streaming has
  to instrument `StreamedMap`/`MapChunkCache`/`ingestChunks` by hand (e.g.
  temporarily logging `cache.outstanding`, `revision`, or wall-clock deltas
  around `refreshProps()`/`warmNavGrids()`), since nothing in the shipped
  build surfaces it.

## Open questions

- Whether `warmNavGrids` (the ~1s-per-call operation) can fire more than
  once per remote session on a lossy/slow connection with multiple small
  settle bursts — the settle logic doesn't appear to gate it to
  "first successful settle only." Would need to trace `fillGround`/
  `syncPathWorld` call sites and `PROP_SETTLE_FRAMES` interaction with a
  synthetic slow `?wire=` to confirm.
- No instrumentation exists to actually measure wall-clock cold-start time
  or per-chunk `buildChunk()`/mesh-build cost against a real 56-chunk map
  today; the 10.6s figure in `streamed-map.ts`'s header comment is from the
  *pre-fix* implementation, not a current benchmark. A perf pass should
  add a temporary timer around `ingestChunks`/`buildChunk` rather than
  trust that comment as current.
