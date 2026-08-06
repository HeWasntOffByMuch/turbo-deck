# How terrain/world data reaches the client (traced 2026-08-06)

> **Superseded in part by spec 070, the same day.** The headline below was true
> when traced and is now history. Terrain *is* sent over the wire: the server
> runs on a map document (`maps/arena.json`), announces it with `MapInfo`
> (`0x4e`), and answers `RequestChunk` (`0x0a`) with `MapChunk` (`0x4f`) or
> `ChunkDenied` (`0x50`), bounded by the player's authoritative position. The
> client holds them in `MapChunkCache` and the Play view meshes from those and
> nothing else. `Welcome.worldSeed` survives as provenance and the fight's RNG.
>
> Everything below about the *entity interest* grid (`chunk-manager.ts`,
> `zone-manager.ts`, `chunks.ts`), the codec primitives and the admin namespace
> is unchanged and still accurate. Note there are now **three** independent
> grids: 400-unit interest chunks, 616-unit map chunks, and the terrain mesh's
> draw-call buckets.

## Headline finding as of the trace: terrain was never sent over the wire

There was **no chunk/terrain payload message in the protocol at all**. The
server never streamed a heightfield, and the client never requested one.
Instead the whole terrain (heightfield + vegetation/colliders) was generated
**deterministically from a single `u32` seed**, by the exact same pure
function, on both sides:

- `src/server/world/build.ts` — `buildWorld(seed: number): BuiltWorld`
  - `BuiltWorld { seed, terrain: TerrainWorld, props: readonly Prop[], sampler: TerrainSampler, colliders: WorldColliders }`
  - calls `createArenaWorld(seed)` (src/terrain/world.ts) for the heightfield
    and `worldVegetation(seed, terrain)` (src/terrain/vegetation.ts) for trees/bushes.
  - Not cached; comment explicitly says calling it twice (once server, once
    client) is fine and intentional, and caching would risk shared mutable state.

The server sends the **seed only**, in `Welcome.worldSeed` (a `u32`), and the
client is expected to call `buildWorld(worldSeed)` itself. This is documented
directly on the field in `src/server/net/messages.ts:206-227`
(`WelcomeMessage.worldSeed`) and mirrored in
`src/server/client/game-client.ts:51-60` (`WelcomeInfo.worldSeed`) and
`ClientView.worldSeed` (game-client.ts:118, "A renderer builds its terrain
from this and from nothing else").

`PROTOCOL_VERSION` bump 2 (src/server/config.ts:85) is literally "the welcome
carries the world seed (spec 063), so a client can build the ground and the
trees the server is colliding against."

### Caveat: no real remote client exercises this path yet

`src/render/iso3d/world/view.ts` (the Play tab) is the only renderer entry
point, and it is **single-player over a loopback transport**: it builds
`world = buildWorld(viewSeed())` itself, constructs `new GameServer({ seed,
built: world, transport })` in the same process, and hands `world` straight
to `WorldScene` — it never actually reads `client.view().worldSeed` and
re-derives terrain from it. `src/render` has no `WebSocket`/`transport-ws.js`
usage anywhere (grepped, zero hits), so the "client receives worldSeed over
a real socket and calls buildWorld itself" path is only proven by
`src/server/client/prediction.test.ts` and the type contract, not exercised
by any shipped UI. Worth flagging if remote multiplayer is the next feature
here — that plumbing (a "connect to remote server" screen using
`transport-ws.ts`) does not exist yet.

`viewSeed()` (src/render/iso3d/seed.ts) defaults to `Date.now() >>> 0` but is
explicitly renderer-only / not part of the sim: "the sim is handed whatever
number this returns and neither knows nor cares where it came from." Not a
determinism violation — it's choosing which deterministic world to open, not
touching sim state.

## 1. src/server/world/ — chunking and zones

Two unrelated grids share the word "chunk"/"zone" here, neither of which is
terrain streaming:

- `src/server/world/chunks.ts` — pure chunk-grid arithmetic. `ChunkCoord {cx,
  cy}`, `ChunkKey = string` ("${cx},${cy}"), `chunkOf/chunkKeyOf(x, y,
  chunkSize)` (floor-based), `chunkDistance` (Chebyshev), `chunksInRadius`/
  `chunkKeysInRadius(centre, radius)` (stable row-major order, for determinism).
  This chunk grid is deliberately **separate** from `src/terrain/chunk.ts`
  (which batches terrain geometry into draw calls) — different sizes, different
  purpose.

- `src/server/world/chunk-manager.ts` — `class ChunkManager` — **entity
  interest management only**, not terrain. Tracks entity->chunk and
  chunk->entities maps, and which chunks are "active" (>=1 player within
  `interestRadius`). Key methods:
  - `place(entityId, x, y, isPlayer): EntityMove | null`
  - `refreshActive(): readonly ChunkTransition[]` — recomputed fresh once/tick
  - `interestSet(playerEntityId): number[]` — sorted entity ids in radius,
    used to build each player's `Delta` message
  - `interestChunks`, `isInInterest`, `populationOf` (per-chunk entity cap)
  Constructed with `(chunkSize, interestRadius = INTEREST_CHUNK_RADIUS)`.
  Radius is Chebyshev/square (`isWithinInterest`), not circular — cheaper,
  over-includes corners.

- `src/server/world/zone-manager.ts` — `class ZoneManager`, `ZoneDefinition`,
  `DEFAULT_ZONES`, `WILDERNESS` — labels rectangular regions of the *same*
  continuous world (pvp flag, spawn table/multiplier, display name). First
  matching rect wins; unmatched falls to `WILDERNESS`. Presentation/rules
  metadata, not a coordinate-space partition — "walking from Greenmarch to
  the Barrows is walking, not a load screen."

- `src/server/world/terrain.ts` — `TerrainSampler { heightAt(x,y): number }`,
  `terrainSamplerFrom(world: TerrainWorld)`, `FLAT_TERRAIN`,
  `MAX_STEP_HEIGHT`, `WALKABLE_MIN_HEIGHT`. The sim's narrow view of terrain
  height, used for movement validation — not transport-related.

- `src/server/world/build.ts` — see headline above; `buildWorld(seed)` is
  the one place both server and renderer construct the world from.

**Is there interest management / a distance check today?** Yes, but only for
*entities in Delta messages* (`ChunkManager.interestSet`), driven by a
Chebyshev chunk-radius (`INTEREST_CHUNK_RADIUS = 8`, src/server/config.ts:80,
tuned against a world ~4400x4100 units where a radius-8 window "contains most
of it and culling currently culls almost nothing" — explicit comment that
it's not yet earning its keep). There is **no interest management for
terrain**, because terrain is never streamed at all — client and server both
have the whole map from tick 0 via `buildWorld(seed)`.

## 2. src/server/net/ — protocol

- `src/server/net/PROTOCOL.md` — binary framing spec. First byte of every
  WS binary frame = message type; little-endian; type-byte ranges are the
  namespace (`0x01-0x3F` client->server game, `0x40-0x7F` server->client
  game, `0x80-0x9F`/`0xA0-0xBF` admin). No chunk/terrain message exists in
  either direction. Only relevant field: `Welcome` (`0x40`) carries
  `chunkSize`, `interestRadius` (both about entity interest, not terrain
  paging) and `worldSeed` (the terrain payload, effectively — 4 bytes for
  the whole map). Note: PROTOCOL.md's documented Welcome layout is
  **missing `worldSeed`** in its field list (line ~99-101) even though
  the code (`messages.ts`/`codec.ts`) both encode and decode it as the last
  `u32` — the doc is stale by one field. Also `Cooldowns` (`0x4d`) as coded
  carries two extra fields (`resource: f32`, `atTick: u32`) beyond what
  PROTOCOL.md documents.
- `src/server/net/protocol.ts` — the type-byte enums: `ClientMessageType`,
  `ServerMessageType`, `AdminMessageType`, `AdminReplyType`, plus
  `isAdminRequest(type)` (range check) and `messageTypeName(type)`. New
  message types are added by picking the next free byte in the appropriate
  range and adding it to the relevant `as const` object — no registry beyond
  that, and `PROTOCOL_VERSION` (config.ts) is bumped whenever the wire format
  changes incompatibly (currently 5).
- `src/server/net/codec.ts` — `BufferReader`/`BufferWriter` primitives
  (u8/u16/u32/i16/i32/f32/f64/bool/varuint/varint/str) referenced by
  `messages.ts`'s `encodeServerMessage`/`decodeServerMessage` and
  `encodeClientMessage`/`decodeClientMessage`.
- `src/server/net/messages.ts` — the typed message union +
  `encode*Message`/`decode*Message` switch statements. `WelcomeMessage`
  (line 206) is where `worldSeed: number` lives; `writer.u32(message.worldSeed)`
  is the last field written (line 526).

## 3. src/server/client/ — transport-agnostic session

- `src/server/client/game-client.ts` — `class GameClient`, `WelcomeInfo`,
  `ClientView` (the read-only projection the renderer draws from via
  `GameClient.view()`). Holds `worldSeed: number | null` on `ClientView`
  (null before Welcome lands) and populates it straight from
  `message.worldSeed` in the `Welcome` case (~line 862). **No chunk
  request/response logic exists here** — the client never asks for a chunk;
  it gets the seed once in `Welcome` and is expected to build the whole
  world locally. `chunkSize`/`interestRadius` are stored on `WelcomeInfo`
  purely as announced tuning values (so retuning server-side needs no
  client release, per PROTOCOL.md) and are not otherwise consumed anywhere
  in `game-client.ts` (grepped — no other use).
- `src/server/client/replica.ts` — `ReplicatedWorld`/`ReplicatedEntity`:
  entity interpolation state from `Delta` messages. Entity-only, no terrain.
- `src/server/client/prediction.ts` — local movement prediction; takes the
  same `world.colliders`/`world.sampler` from `buildWorld` as the sim does
  (comment: "the same colliders and the same heightfield, from `buildWorld`").

**Client-side chunk cache?** None. There is nothing to cache — the client
has the entire terrain in memory as soon as `buildWorld(worldSeed)` returns,
synchronously, no paging.

## 4. src/render/iso3d/world/ — the Play tab

`src/render/iso3d/world/view.ts` — `mountWorld(container)`. Generates
terrain **locally**, not by receiving it:
```
const seed = viewSeed();
const world = buildWorld(seed);          // <- terrain generated here, client-side
const server = new GameServer({ seed, built: world, transport });
const client = new GameClient(transport.connect(), { ... });
const scene = new WorldScene(canvas, world);   // scene draws from `world` directly
```
`WorldScene` (`src/render/iso3d/world/scene.ts`) takes the `BuiltWorld`
object directly (terrain + props) as a constructor argument and draws from
it — it does not read `client.view().worldSeed` at all in this tab, because
it already has `world` from having built it itself a few lines above. The
`worldSeed` field on `ClientView` exists for a *future* remote client that
doesn't get to call `buildWorld` before knowing the seed; today's only
renderer entry point doesn't need it because it's also the one that spun up
the server.

`hud.ts` reads `view.worldSeed` only for a debug overlay string
(`seed ${view.worldSeed ?? '-'}`), not to drive any terrain build.

## Summary data flow

1. `src/render/iso3d/seed.ts:viewSeed()` picks a `u32` (URL `?seed=` or
   `Date.now()`, renderer-only).
2. `view.ts` calls `buildWorld(seed)` **locally** to get the full terrain +
   vegetation + colliders (`src/server/world/build.ts`).
3. `view.ts` also constructs `GameServer({ seed, built: world })` — the
   *same* `BuiltWorld` object — over a `LoopbackTransport`.
4. `GameServer` sends `Welcome` with `worldSeed` as one `u32` field, plus
   `chunkSize`/`interestRadius` (entity-interest tuning, not terrain paging).
5. Over the wire, `ChunkManager` on the server continuously computes each
   player's *entity* interest set (Chebyshev chunk radius) and only those
   entities' changed fields go out in `Delta` (`0x41`) messages. Terrain
   itself never appears in any `Delta` or any other message.
6. `WorldScene` draws from the `BuiltWorld` object it was constructed with
   (terrain heightfield + props), independent of anything arriving over the
   wire.

## Open questions / gaps for a future remote-multiplayer feature

- No `transport-ws.ts` consumer exists in `src/render/` — there is no "join
  a remote server" UI yet, so the `worldSeed`-driven client build path is
  currently only type-checked/tested (`prediction.test.ts`), not exercised
  end-to-end by a real network client.
- `PROTOCOL.md`'s `Welcome` (0x40) section is missing the `worldSeed: u32`
  field that both `messages.ts` and `codec.ts` actually encode last; anyone
  writing a client from the doc alone would misparse the frame. Similarly
  `Cooldowns` (0x4d) is under-documented (missing `resource`/`atTick`).
- If the map ever needs live edits (not just a seed), there is no mechanism
  today for the server to push a terrain delta — the design assumes the
  seed is the whole contract and terrain is immutable for a server's
  lifetime.
