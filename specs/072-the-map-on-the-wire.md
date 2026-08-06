# 072 — The map on the wire

## Problem

There is an editor, and there is a server, and nothing connects them.

`src/render/iso3d/editor/` can bake a world, brush its terrain, scatter its
props, drop its markers and bake its nav — and then the only places that work
can go are a `localStorage` slot and the user's downloads folder. Nothing reads
either one. Ten specs of tooling produce a document that no running game has
ever loaded.

Meanwhile the world the game actually plays on comes from `buildWorld(seed)`
(`src/server/world/build.ts`), which calls `createArenaWorld(seed)` and
`worldVegetation(seed, terrain)` — the *generator*. Spec 048 set out to demote
the feature list to "the thing that produces the first bake", and for the editor
it succeeded. For the game it never happened: the generator is still authority,
and an edited map is a file nobody opens.

The second half is how the client gets it. Spec 063 made the client build its
terrain from `Welcome.worldSeed` "and from nothing else" — both ends run the same
pure `buildWorld`, so they cannot disagree. That trick works precisely because
the world is a pure function of one `u32`. **A hand-edited map is not.** The
moment the terrain is a document rather than a seed, the client cannot rederive
it and it has to be sent.

So this spec does two things that have to happen together:

1. The server's world comes from a **map document**, not the generator.
2. The client is **sent the parts of that map it is standing near**, on request,
   and caches what it already has.

## Assumptions

Four decisions were open and are settled here as the narrowest thing that works.
Each is reversible and none is load-bearing for the rest:

- **The map reaches the server as a file on disk**, checked into `maps/`, not
  uploaded live from the editor. Live publish needs the editor to reach a
  running server, an auth story, and a hot-swap path through a sim that is
  mid-tick; a file needs none of that and is diffable in review. The editor's
  existing "save" already produces exactly this file.
- **The map is the client's only terrain source.** No generator fallback. A
  fallback would keep two world builds alive, which is the drift `build.ts`
  exists to prevent — and it would be silent, because a client that quietly
  generates looks right until it is standing in a tree the server edited away.
- **The chunk cache is in-memory, per session.** Persisting to `localStorage`
  buys a warm reload and costs a quota story; the whole map is 0.62 MB and a
  session fetches each chunk exactly once.
- **The Play tab stays on `LoopbackTransport`.** The request/validate/send/cache
  path is transport-agnostic and is tested headlessly; pointing the tab at a
  remote server is its own feature and is out of scope here.

## Shape

### The map on disk

```
maps/arena.json          the map the server serves, checked in
scripts/bake-map.ts      regenerates it from the generator
```

`npx tsx scripts/bake-map.ts [--seed N] [--out path]` runs the same three calls
`bakeEditorMap` does — `createArenaWorld`, `worldVegetation`, `exportMap` — bakes
nav, and writes `serializeMap(doc)`. It is how the first file is made and how it
is regenerated when the generator changes; after that the editor is the thing
that edits it, and the round trip is: **`maps/arena.json` → drop on the editor →
brush → save → replace `maps/arena.json` → commit**.

The file is checked in on purpose. It is the world, it is reviewable as a diff
(spec 048's serializer emits one terrain row per line for exactly this reason),
and CI can assert the shipped map parses and loads.

Server-side it is read once at startup:

```ts
// src/server/world/map-file.ts   (impure: this is the one place that reads a file)
function loadMapFile(path: string): MapDocument;
const DEFAULT_MAP_PATH = 'maps/arena.json';   // overridden by TURBO_DECK_MAP
```

A map that does not parse **fails the boot**, loudly. There is no falling back to
the generator: a server that silently plays a different world than the one in
`maps/` is the failure this spec exists to remove.

### The world, from a document

`build.ts` gains a second entry point and keeps the first:

```ts
function buildWorld(seed: number): BuiltWorld;               // unchanged — sandboxes, tests
function buildWorldFromMap(doc: MapDocument): BuiltMapWorld; // what the server runs on

interface BuiltMapWorld extends BuiltWorld {
  readonly doc: MapDocument;
  /** Chunk lookup for the wire, and the layer scalars a client needs to mesh. */
  readonly index: MapIndex;
}
```

`buildWorldFromMap` is `loadMap(doc)` plus the same sampler and the same collider
construction `buildWorld` already does — the props it feeds `vegetationColliders`
are the document's props rather than the scatter's. `BuiltWorld` keeps its shape,
so every consumer downstream of it is untouched.

`WORLD_BOUNDS` and `ARENA_OBSTACLES` stay where they are, out of the document,
and out of scope. The map supplies **terrain and props**; the arena walls remain
sim constants. Folding those into the document is a later spec.

### The map index

Pure, and the thing both the wire encoder and the request validator ask:

```ts
// src/server/world/map-index.ts
interface MapIndex {
  readonly mapId: string;          // FNV-1a of the serialized doc, hex
  readonly cellSize: number;
  readonly chunkCells: number;
  /** cellSize * chunkCells — the edge of a map chunk, in world units. */
  readonly chunkExtent: number;
  readonly species: readonly string[];   // union of every chunk's species
  readonly layers: readonly MapLayerInfo[];
  chunkAt(layer: number, cx: number, cz: number): MapChunk | null;
  /** World-space centre of a chunk, for the distance check. */
  centreOf(layer: number, cx: number, cz: number): { x: number; z: number } | null;
}

function buildMapIndex(doc: MapDocument): MapIndex;
```

`mapId` exists so a client can tell "the same map" from "a map that was edited
under me". It is announced once and stamped on every chunk; a chunk whose
`mapId` is not the current one is dropped rather than drawn.

### Protocol

`PROTOCOL_VERSION` goes to **6**. One new client message, three new server ones.

```
0x0a RequestChunk    varuint layer · varint cx · varint cz
0x4e MapInfo         (see below)
0x4f MapChunk        (see below)
0x50 ChunkDenied     varuint layer · varint cx · varint cz · u8 reason
```

**`0x4e MapInfo`** is sent immediately after `Welcome`, unprompted. It carries
everything that is *not* per-chunk: `str mapId`, `u32 seed`, `varint cellSize`,
`varuint chunkCells`, the arena rect, the species string table, and per layer the
id, seed, bounds, `baseY`, `waterLevel` and the `(cx, cz)` list of chunks that
exist. That last list is what stops a client asking for chunks that were never
baked. It is a few kilobytes for the shipped map.

**`0x4f MapChunk`** is one chunk of one layer:

```
str mapId · varuint layer · varint cx · varint cz · varuint cols · varuint rows
heights   varuint count · varint × count      (delta-encoded, see below)
solid     varuint pairs · (varuint value · varuint count) × pairs
materials  "
tones      "
nav       bool present · then the same run pairs when present
species   varuint count · str × count          (chunk-LOCAL table, see below)
props     varuint count · (varuint speciesIndex · varint x · varint z ·
                           varint rotation · varint scale · varint tint ·
                           u8 flags) × count
markers   varuint count · (u8 kind · str id · varint x · varint z · str label)
```

**Every coordinate on this wire is an integer of thousandths, not an `f32`.**
This is the one detail that is not a matter of taste. Spec 048 quantizes the
document to 3 decimals (`quantize`, `QUANTUM = 1000`); an `f32` cannot hold most
of those values exactly, so a client that decoded floats would sample a
heightfield a few ulps away from the server's, and `heightAt` would disagree —
which is a position correction on ground that looks flat. Sending
`Math.round(v * 1000)` as a `varint` and dividing on arrival reproduces the
document's numbers **exactly**, which is the only thing that keeps prediction and
authority on one surface.

Heights are additionally delta-encoded against the previous corner before the
zigzag, because a heightfield's neighbours are close: it roughly halves the
largest array in the message at no cost in fidelity.

`flags` bit 1 is `align`, bit 2 is `uniform` — the two optional `MapProp` fields.
`tint` is a quantized *tone*, not a packed colour, and goes over as thousandths
like every other document number; encoding it as a `u32` silently rounded every
prop's tint to zero, which the round-trip test caught.

The species table is **chunk-local**, duplicating a few short strings per chunk,
because `decodeServerMessage` is stateless. A frame that could only be read by a
client that had already seen an earlier frame would quietly break that property,
and the saving would be a few dozen bytes. `MapInfo`'s table is the union of them
all and is advisory — it exists so a renderer can build one instanced mesh per
species up front rather than discovering a new one mid-stream.

**`0x50 ChunkDenied`** answers a request the server will not serve, with reason
`0 OutOfRange`, `1 Unknown`, `2 Throttled`. It exists so a client can retire the
request from its in-flight set instead of waiting forever; a denied chunk is
re-requested when the player is closer, which is the OutOfRange case resolving
itself.

### Which chunks a player may ask for

The rule, and the "within reason" the request came with:

> A `RequestChunk` is served only when the requesting player's **current
> authoritative position** is within `MAP_CHUNK_REQUEST_RADIUS` chunks
> (Chebyshev) of the requested chunk.

```ts
const MAP_CHUNK_REQUEST_RADIUS = 6;   // in map chunks, so 6 * 616 = 3696 units
```

Sized off the camera, exactly as `INTEREST_CHUNK_RADIUS` is and for a worse
failure: terrain that is framed but not loaded is a hole with the sky through
it. And sized off the *window shape*, not just the zoom — this spec first said
4, and the test below is what caught it: `internalRenderSize` trades height
rather than capping the aspect, so a 32:9 monitor at maximum zoom reaches ~3107
units where 4 guarantees only 2464. 6 guarantees 3696.

The relationship is asserted in a test rather than the number, so the next
person to touch the camera finds out here rather than in someone's game.

Note this is a **different grid** from `CHUNK_SIZE`/`INTEREST_CHUNK_RADIUS`.
Interest chunks are 400 units and decide who hears about which *entities*; map
chunks are `cellSize * chunkCells` = 616 units and are the document's own
geometry buckets. Spec 056 already made the point that these grids are
independent by design; this adds a third consumer and does not merge them.

On top of the distance check, a **token bucket per connection**: burst 24,
refill 12 per second. The distance check bounds *where* a client can read; the
bucket bounds *how fast*. Without it a connected client can ask for the same
legal chunk in a loop and make the server serialize a 12 KB message every time.

### The client

```ts
// src/server/client/map-cache.ts  — pure, headlessly tested
class MapChunkCache {
  constructor(info: MapInfoMessage);
  /** Chunks within the radius that are neither held nor in flight, nearest first. */
  wanted(x: number, z: number, radius: number, budget: number): ChunkRequest[];
  markRequested(req: ChunkRequest): void;
  accept(chunk: MapChunkMessage): boolean;   // false if mapId is stale
  deny(layer: number, cx: number, cz: number, reason: number): void;
  held(): readonly MapChunkMessage[];
  readonly revision: number;   // ticks on every accept, so a view knows to remesh
}
```

`wanted` is **nearest-first** and budgeted, so a client that spawns into a cold
cache draws the ground under its own feet before the ground at the edge of the
frame. A denied-as-OutOfRange chunk goes back to "not held, not in flight" and is
naturally re-asked when the player walks toward it; a denied-as-Unknown one is
remembered as absent and never asked again.

`GameClient` drives it: on `MapInfo` it builds the cache, and once per broadcast
it sends whatever `wanted(ownPosition, MAP_CHUNK_REQUEST_RADIUS, budget)`
returns. `ClientView` gains `map: { info, chunks, revision } | null`, and
`worldSeed` stops being the client's terrain source — it stays on the wire for
provenance, and the document's own per-layer seeds drive the corner jitter.

### The renderer

`src/render/iso3d/world/` stops calling `buildWorld` for its scene. It watches
`view().map.revision`, and when it changes it rebuilds from the chunks held so
far — `loadMapChunks(info, chunks)` produces the same `TerrainChunk[]` and
`MeshLayer[]` that `loadMap` does for a whole document, and
`buildTerrainMeshFromChunks` already takes exactly that pair. Props and markers
come from the chunks alongside the geometry.

**Meshing is incremental, one chunk at a time.** The first cut of this spec said
the opposite — rebuild the whole held set per arrival, "there is nothing yet to
optimise" — and that was simply wrong. Measured on the real page, it cost **10.6
seconds of blocked main thread out of the first 12**, with single tasks over a
second: the page was frozen for the whole of startup. O(held) per arrival is
O(n²) across a cold start, and 56 chunks is enough for that to bite.

The fix is to stop rebuilding anything. A `MapChunkStore` is a sparse map from
`(cx, cz)` to arrays, and everything derived from it reads *through* it —
`bakedLayer` closes over `store.cornerHeight`, `meshLayers` over
`store.cellSolid`. So `StreamedMap` builds the store, the `TerrainWorld` and the
mesh layers **once**, from a document with no chunks in it, and each arrival is
one `insertChunk` plus one `buildChunk`. The height sampler answers for new
ground the instant it lands, with nothing rebuilt.

Nor is per-chunk meshing a second meshing path: `TerrainMeshHandle.rebuild` is
the seam spec 050 already cut for the editor's brush, and a streamed chunk wants
exactly what a brush stroke wants.

Props are the one thing still rebuilt whole, when the stream goes **quiet**
rather than per arrival. One instanced mesh per species over the whole map is a
handful of draw calls; one per chunk would be fifty-odd of them on every frame
from then on — trading a startup cost for a permanent one, which is the wrong
way round.

Measured after: **1.4 seconds blocked, worst task 431ms** — against a pre-spec-070
baseline of 1.9 seconds and 731ms. Streaming now costs less than the game did
before it streamed, and the worst single hitch is smaller because the work
arrives in pieces. `scripts/measure-startup.ts` is how those numbers are taken.

One honest limit, stated plainly rather than implied: **only the drawn world
comes from streamed chunks.** The Play tab's *predictor* still takes its
colliders and its height sampler from the document the in-tab server loaded,
because in a loopback tab the two are the same process and there is nothing to
stream them from. Meshing is the half that had to change for the streaming path
to be exercised at all — handed the full world the scene would have looked
correct while streaming did nothing — and it is the half this spec changes.

Collider paging for a genuinely remote client is therefore still open, and it is
the one thing standing between this and a real socket. It is listed out of scope
below rather than quietly assumed to work.

## Invariants to test

- **Round trip.** `decodeMapChunk(encodeMapChunk(c))` deep-equals `c`, for every
  chunk of the shipped map. Heights compare **exactly**, not within a tolerance —
  that is the whole point of the integer encoding.
- **The shipped map is valid.** `maps/arena.json` parses, `loadMap`s, and every
  prop species in it satisfies `isKnownPropKind`.
- **The bake is deterministic.** `bake-map.ts` on the same seed twice produces
  byte-identical text.
- **Server and client agree on the ground.** For a sample of points, the
  server's `heightAt` and a client's `heightAt` rebuilt from decoded chunks
  return *identical* doubles.
- **The distance check holds.** A request for a chunk beyond
  `MAP_CHUNK_REQUEST_RADIUS` of the player's authoritative position is answered
  with `ChunkDenied(OutOfRange)` and no `MapChunk`; one inside it is served. A
  client that teleports its *predicted* position does not widen the window — the
  check reads the server's position, never the client's hint.
- **The radius covers the camera.** Asserted as a relationship against the same
  camera-frame numbers `interest.test.ts` uses, not as a literal 4.
- **The bucket throttles.** Requesting the same legal chunk 100 times in a tick
  yields at most burst-many `MapChunk` messages and `Throttled` thereafter.
- **The cache asks once.** Over a session that walks a path, no chunk is
  requested twice while held or in flight; `wanted` returns nearest-first.
- **A stale map is dropped.** A `MapChunk` carrying a `mapId` other than the
  announced one is refused by `accept` and does not enter `held()`.
- **Determinism is unharmed.** The existing replay tests still pass with the
  server running on the document rather than the generator.

## Out of scope

- Live publish from the editor to a running server, and hot-swapping the map on
  a server that is already ticking.
- Persisting the chunk cache across reloads, and any `mapId`-keyed storage.
- Pointing the Play tab at a remote server over `transport-ws.ts`.
- **Collider paging on the client**: building the predictor's colliders from
  streamed chunks and growing them as more arrive. Needed before a remote client
  can predict correctly; not needed by the loopback tab, which is all that runs
  today.
- Moving `WORLD_BOUNDS` / `ARENA_OBSTACLES` into the document.
- Compressing the wire beyond the run-length and delta encodings already in the
  document's own format.
