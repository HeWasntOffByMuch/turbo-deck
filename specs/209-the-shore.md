# 209 — The shore

## Problem

The map has no edge. It has a place where it stops.

Measured on `maps/arena` at 810 chunks, against `MAP_CHUNK_REQUEST_RADIUS` = 2:

- **212 chunks are walkable ground within 2 chunks of undeclared space**, and
  110 of those are directly adjacent to it.
- **Not one chunk of the map is entirely under water.**

So the whole perimeter is ground a player can stand on, ending at nothing. The
sim's wall — `worldBoundsOf`, the union of the layers' declared bounds — stops
them, but it is at exactly the same place: an invisible wall at the edge of the
grass, with the frame showing the void past it. At the supported zoom the camera
sees about 1.4 chunks each way, so standing at the boundary is standing with a
sixth of the screen showing nothing.

Growing the map four times over makes the perimeter longer, not smaller.

## Shape

A pure checker, and a script that runs it.

```ts
// src/terrain/shore.ts
export interface ShoreProblem {
  readonly layerId: string;
  readonly cx: number;
  readonly cz: number;
  /** Chunks to the nearest coordinate the layer holds nothing for. */
  readonly toVoid: number;
  /** The highest ground in the chunk, so the report says why it counted. */
  readonly highest: number;
}

export function shoreProblems(doc: MapDocument, radius?: number): readonly ShoreProblem[];
```

`radius` defaults to `MAP_CHUNK_REQUEST_RADIUS`, **derived rather than chosen**:
the rule is "a player must not be able to *see* the end of the world", and what a
player can see is what the client streams, which spec 201 tied to the supported
zoom. Move the zoom cap and the content rule moves with it — a shore that was
deep enough at one zoom is not a shore at another, and nothing else in the tree
would notice.

Walkable means "any corner of the chunk stands above the layer's flood line",
which is the same comparison `createNavGrid` grades water with. A chunk entirely
below it is sea, and sea is what a shore is made of.

`npx tsx scripts/check-shore.ts` prints the report, and `--strict` makes it an
exit code so it can be a CI gate once the map has a coast.

## What this deliberately does not do

**It does not author a coastline.** Where the island ends is a design decision
about the world, not something a checker should guess: a skirt of sea grown
around today's rectangle would be an invented shape nobody chose, committed as
data, and inherited forever. The tool says where the problem is; a person grows
the answer with `grow-map.ts` and reviews it as a diff, which is the whole point
of spec 083.

Because the shipped map fails today, the test is a **ratchet** rather than a
gate: the count must not grow. A gate would have to be committed red, and a red
gate is a gate somebody turns off.

## How deep a shore has to be

Measured, growing `maps/recipes/shore.json` off the map's north edge at each
depth and re-running the check:

| depth grown | chunks | entirely sea | problems | against the void |
|---|---|---|---|---|
| 0 (today) | 810 | 0 | 212 | 110 |
| 2 | 870 | 30 | 190 | 84 |
| **3** | 900 | 60 | **164** | 84 |
| 4 | 930 | 90 | 164 | 84 |
| 5 | 960 | 120 | 164 | 84 |

**Three, and deeper buys nothing** — the remaining 164 are the other three
edges. Three rather than two because `bakePart` eases the recipe's field in over
a skirt where it joins existing ground (spec 083), so the innermost row of a
grown strip is *stitched up to meet the land* and is not sea. A strip `n` deep
gives `n - 1` rows of true sea, and the rule wants `MAP_CHUNK_REQUEST_RADIUS`
of them.

So the shape of the rule for an author is: **grow sea
`MAP_CHUNK_REQUEST_RADIUS + 1` chunks deep**, and the check will tell you if you
were wrong. `maps/recipes/shore.json` is a plain one — gentle relief well below
the flood line, nothing planted — and the coastline's actual shape is a design
decision made by growing rectangles, not something this guesses at.

## Invariants tested

- **A chunk in the middle of the map is never a problem**, however low or high
  its ground.
- **A chunk of open sea is never a problem**, even directly against the void —
  which is exactly what a shore is, and the test that says the rule is about
  *walkable* ground rather than about the edge.
- **A walkable chunk adjacent to the void is a problem**, at any radius ≥ 1.
- **The radius is the request radius** unless told otherwise, so the rule tracks
  the supported zoom rather than a number of its own.
- **A hole in the middle counts.** An authored map is not a rectangle, and a
  chunk the layer declares but holds nothing for reads as unknown rather than as
  the world's edge (spec 078) — so ground beside an interior hole is the same
  problem as ground at the rim.
- **The shipped map does not get worse.** 212 today; a grow that adds walkable
  perimeter without sea behind it fails.

## Out of scope

- **A cheaper form for seabed.** The plan proposed a constant-height chunk to
  take a drowned chunk from 6.9 KB to under 1 KB. There is no seabed yet to
  compress, and inventing a second chunk encoding for content that does not
  exist is the wrong order.
- **Drawing anything.** What the horizon looks like past the shore is the
  renderer's, and a shore deep enough that nobody reaches it is the point.
- **Moving `worldBoundsOf`.** It stays what it is — a backstop that keeps a body
  inside the declared rectangle. The shore is what makes it never be the thing a
  player meets.
