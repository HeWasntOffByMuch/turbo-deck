# 263 — A grave in the ground

## Problem

There is nowhere in this world to bury anybody. The placed props are a hut, a
well, a sign and three light fixtures (specs 224, 250, 260) — every one of them
a thing a village *builds*, and none of them a thing that happens to a village.
A graveyard behind the church, a lone marker at a road fork, the aftermath of
whatever the Warden did: all three are the same missing object, and none of them
can be laid out today except by standing a signpost in a field.

A grave is the cheapest possible version of that, and this game already has all
of it but the geometry. It is a `PropKind` and nothing else — spec 224's
sentence about the hut and 250's about the campfire, one system further along —
so it is written into the map document, streamed, collided against, batched per
region, previewed by the structure ghost and taken out by the eraser without one
line of any of those asking what kind a prop is. What has to be authored is a
plan, three parts and one row in three tables.

## Shape

A fourth entry in `STRUCTURE_KINDS`, **appended, never inserted**, for the reason
that list already records: `PROP_GROUPS` enumerates it across a thread boundary,
so a kind ahead of another would hand the worker's matrices to the wrong
geometry. Everything the editor needs falls out of that — `PLACED_KINDS`
composes it, `STRUCTURE_CHOICES` offers it, `isKnownPropKind` accepts it in a
document, and the press-to-place tool, the drag-to-size gesture and the ghost
each already work for "a structure" rather than for a list of them.

```ts
// terrain/vegetation.ts, beside HOUSE_PLAN and SIGN_PLAN and for their reason:
// the renderer builds the parts from it and FOOTPRINT_BASE derives the collider
// from it, and two files disagreeing about a grave is a headstone somebody can
// stand inside or an invisible wall around a patch of earth.
export const GRAVE_PLAN = {
  stoneWidth: 40, stoneHeight: 44, stoneThickness: 10,
  moundLength: 88, moundWidth: 44, moundHeight: 14,
} as const;

export const STRUCTURE_KINDS = ['house', 'well', 'sign', 'grave'] as const;
```

**Three parts** (`graveParts()` in `render/iso3d/props.ts`): a plinth, the
headstone standing on it, and a mound of turned earth lying in front. The stone
faces the prop's local **+Z**, which is the axis the editor's Facing slider
turns and the same convention the hut's door and the sign's board already use —
so "turn it to face the path" means one thing for all four. The mound lies on
that same +Z, because a reader stands at the foot of a grave and the earth is
between them and the stone.

**The collider is the headstone and only the headstone.** That is spec 260's
rule for the sign, applied to the other half of the object: a mound is loose
earth a stride high, and blocking it would take a body-and-a-half of walkable
ground out of the world around every plot — and would put the reach a player has
to get inside *behind* the thing they came to look at. A graveyard is somewhere
you walk about.

**Three palette entries.** `graveStone`, `graveStoneDeep`, `graveEarth`. New
rather than borrowed, and the reason is stated once in `palette.ts`: every stone
in this palette is deliberately *warm* limestone, tuned so a wall belongs to the
ground it stands on, and a grave marker is the one piece of stonework here that
has to read as cold against that ground. There is likewise no soil tone —
`trunkDark` is bark and `TERRAIN_COLORS.dirt` is the orange of a trodden path,
not the dark of earth that was turned this morning.

## Invariants tested

- A grave is placed by the same tool, at the same sizes, with the same drag
  gesture and the same ghost as every other structure — carried by the existing
  loops over `STRUCTURE_KINDS`, which is the point of adding only a row.
- `footprintRadius` of a grave is the headstone's circumradius and nothing else:
  the mound reaches well past the collider, deliberately, and the stone does not.
- The headstone stands **shorter than a body** (`< BODY_HEIGHT`) and taller than
  the mound beside it. A grave marker taller than the person reading it is a
  monument, which is a different prop.
- The mound lies in front of the stone on local +Z, does not overlap it, and
  turns with the prop: a quarter turn swaps which axis it is long on.
- Every part is sunk below y=0, so a grave on a slope shows no daylight under it.
- `parseMap` round-trips a grave, and `isKnownPropKind('grave')` is true.
- The generic "every kind is more than a box" assertion keeps its meaning: its
  height floor becomes a claim about the *list* (nothing degenerate) rather than
  about the two elaborate buildings, with each kind's real height pinned in its
  own test — which is exactly the loosening spec 260 already made to the same
  assertion's part count.

## Out of scope

- **Anything a grave does.** It is scenery: no text on it (a sign is the prop
  that carries a string, and `signText` refuses every other kind), nothing to
  read, nothing to open, no entity, no wire message. `sim/`, `world/` and
  `player/` do not learn that graves exist.
- **A graveyard brush.** A grave is placed one at a time like every other
  structure. Laying out twenty of them in rows is a scatter tool with alignment,
  which is a tool rather than a prop.
- **Putting any on `maps/arena.json`.** Where a grave goes is a level-design
  decision made in the editor, and this spec is the thing being placed.
