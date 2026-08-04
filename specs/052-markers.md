# 052 — Markers

## Problem

Spec 048 gave every chunk a `markers` array with four validated kinds — spawn,
objective, campfire, trigger — and nothing has ever written one. A map can say
where the ground is and what grows on it, and cannot say where the fight starts.

The arena rectangle has the same problem from the other end: it is in every
document, it is the one world-space field in the format, and it is invisible. You
cannot see the box you are laying a map out inside.

## Shape

### One coordinate space inside the store

Props are held in **world** space inside `MapChunkStore` and converted to
chunk-local only on the way out to a document. Markers are currently held
chunk-local and converted on the way *in* to a read. Two conventions for the same
job is a trap: the next person to add a marker writes a world coordinate into a
local field and it lands a chunk away.

Markers move to world space inside the store, matching props. The document is
unchanged — chunk-local there, as the format requires.

### Placing

```ts
function placeMarker(
  store: MapChunkStore,
  layerId: string,
  kind: MapMarkerKind,
  x: number,
  z: number,
  onTouchChunk?: (cx: number, cz: number) => void,
): { marker: MapMarker | null; dirty: ChunkCoord[] };

/** `spawn-1`, `spawn-2`, ... — the lowest number not already taken. */
function nextMarkerId(existing: readonly MapMarker[], kind: MapMarkerKind): string;
```

A marker is placed on **click, not drag**. The other tools are strokes because
ground and vegetation are bulk things; a spawn point is not, and a drag would
leave a trail of forty of them. Left-press in marker mode places exactly one.

Ids are generated rather than typed, because a marker with no id is useless to
whatever reads the map later and a text field in the middle of a placement flow
is a worse experience than a name you can change never. The lowest free number
per kind, so deleting `spawn-2` and placing again reuses it rather than climbing.

### The eraser takes markers too

The eraser already removes props inside its radius; it removes markers on the
same terms, by centre. Anything else means two erasers and a mode switch to pick
between them, which is exactly the "eraser with a mind of its own" problem the
prop eraser avoided by using centres.

### Drawing them

Two pieces, both in `editor/marker-view.ts`:

- **A billboard per marker.** A `THREE.Sprite` with a small generated canvas
  texture — a filled disc in the kind's colour with a dark rim and its initial —
  floating above the ground, plus a **stem** line dropping to the exact point it
  marks. The stem is the part that matters: a billboard alone tells you roughly
  where a marker is, and roughly is not good enough for a spawn.
- **The arena outline.** A line loop around the document's `arena` rect, its
  vertices sampled at `heightAt` so it lies on the terrain the way the brush
  cursor does. It is not editable here — it is the box you are laying out inside,
  drawn so you can see it.

Both draw with `depthTest: false`, like the cursor: a marker hidden behind the
hill it sits on is a marker you will forget exists.

### Undo

`ChunkSnapshot` gains `markers`, alongside the props it gained in spec 051. A
placement is a stroke like any other, so it takes one undo slot.

## Invariants tested

**Store**

- A marker added in world space comes back at the same world position, and is
  filed in the chunk that contains it.
- Markers survive an export/load round trip at their world positions, with kind,
  id and label intact.
- A marker on a chunk boundary lands in exactly one chunk and is not duplicated.

**Placing**

- `nextMarkerId` returns the lowest free number for its kind, ignores other
  kinds, and reuses a number freed by a deletion.
- Placing reports the chunk it touched, before it touches it.
- Placing outside the layer's bounds places nothing.

**Erasing**

- Removes markers whose centre is inside the radius and no others.
- Removes props and markers in the same stroke, and undo restores both.

**Undo**

- One placement is one entry; undo removes the marker.
- One erase of a marker is one entry; undo brings it back with its id.

## Out of scope

- Editing the arena rect. It is drawn, not dragged. Resizing it is a different
  interaction (a handle, a gizmo) than anything else here, and the brief rules
  gizmo widgets out.
- Marker labels and per-marker properties in the UI. The field exists in the
  format and round-trips; nothing types into it yet.
- Moving a marker that is already placed. Erase and place again.
- Anything reading markers at runtime. This authors them; the sim consuming a
  spawn point is a separate change.
