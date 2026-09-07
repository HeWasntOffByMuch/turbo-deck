# 279 — A spawner the wire carries whole

## Problem

`MapMarker.spawner` does not cross the wire. Spec 222 gave a `spawner` marker a
block of its own — `respawnSeconds`, `leashRadius`, and since spec 268 a
`when` — added it to the map document, to the parser, to the editor's select
tool and to `spawnPointsFrom`, and never to `encodeMapChunk`. A marker goes over
as `kind · id · x · z · label` and comes back with the block gone.

Nothing could see it, and the reason is the reason this repo keeps rediscovering
things a hundred specs later: **no committed map had ever authored one.** The
round-trip test in `map-messages.test.ts` compares every chunk of the shipped map
against itself, which is exactly the assertion that would catch this — and it
passed for fifty-seven specs because every marker on the map was three fields
wide. The northern-mountain pass is the first content to give a spawner a leash
and a clock, and it fails that test on the first run.

What it costs today is small and entirely on the client's side of the wire: the
server reads the document off disk, so respawn timing, leash and the night gate
are all correct in the sim. What is wrong is that `MapChunk` is documented as
carrying a chunk and does not, so a client's copy of the map is quietly not the
server's — and the thing standing between that and a real bug is only that
nothing on the client has yet asked a marker what its leash is.

## Shape

**A flags byte and three optional members, in the shape the props beside them
already use.** `MapProp` has carried `u8 flags` with its optional light and text
following in bit order since specs 250 and 260; a marker gets the same, so there
is one pattern on this frame rather than two.

```
per marker: u8 kind · str id · varint x · varint z · str label · u8 flags
  flags 1 → varint respawnSeconds   (quantized thousandths, like every number here)
  flags 2 → varint leashRadius
  flags 4 → u8 window               (index into SPAWN_WINDOWS)
```

```ts
// src/server/net/protocol.ts
export const MapMarkerFlag = { Respawn: 1, Leash: 2, Window: 4 } as const;
```

Four decisions.

**The byte is unconditional**, as the prop's is, rather than written only for a
`spawner` kind. A reader that has to know the kind before it knows how many
bytes to take is a reader that breaks the day a second kind grows a block, and
the cost is one byte per marker — about sixty on the shipped map, against a
frame that already carries a chunk of heightfield.

**An empty block encodes as absent.** `spawnerSettingsEmpty` is the existing
one answer to "does this block say anything", already shared by the parser and
the editor's `patchMarker`; the encoder becomes its third caller rather than
testing the three fields itself. So a `spawner: {}` that never came from a
document round-trips to absent — which is what the parser does to one anyway.

**A block on a kind that cannot read it is a `CodecError`**, not something to
honour. `map.ts` states the rule — spawner-only, refused by the parser on any
other kind — so a frame claiming a campfire has a leash is a frame the document
parser would reject, and the wire and the document have to agree about what a
marker may be.

**The numbers are quantized like every other number on this frame.** Both are
authored in the document as plain numbers and `MAP_QUANTUM` thousandths is exact
for anything `quantize` produced, so `respawnSeconds: 150` and
`leashRadius: 470` survive as themselves. `when` is not a number and takes an
index into `SPAWN_WINDOWS`, the same closed table the parser refuses anything
outside of.

## Invariants tested

- The shipped map's every chunk round-trips **exactly**, which is the existing
  assertion and is the one that failed; it is what proves the fix rather than a
  new test written to fit it.
- A marker carrying all three fields round-trips all three, and one carrying a
  single field round-trips only that one — separately, because a flags byte read
  in the wrong bit order passes the all-three case.
- An absent block stays absent, and an **empty** block encodes as absent rather
  than as an empty object, so the wire cannot invent a key the document would
  not have written.
- A window round-trips by value rather than by index, and an index outside
  `SPAWN_WINDOWS` is a `CodecError` rather than an `undefined` window.
- A block on a non-spawner kind is refused on decode.
- Markers with no block still cost one byte each and no more, and `MapChunk` is
  still smaller on the wire than the JSON it came from.

## Out of scope

- **Any client reading the block.** Nothing in the Play tab asks a marker what
  its leash is today; this makes the message honest, and what reads it is
  whatever wants it next. The spawner overlay's countdown is `SpawnerStates` and
  is unchanged.
- **Bounds on the numbers.** The parser takes any number and `spawnPointsFrom`
  clamps the leash at `LEASH_RADIUS`, which is where that decision already lives
  (spec 222); the wire's job is to carry what the document holds.
- **A protocol version bump.** The frame grows a byte per marker and both ends
  are built from this tree; `mapId` already refuses a client whose map differs.
