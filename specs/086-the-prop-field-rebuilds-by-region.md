# 086 — The prop field rebuilds by region

## Problem

Spec 085 made a part's *terrain* work proportional to the part — re-mesh 271ms
to 21ms, nav 461ms to 12ms, both flat as the map grows. Measuring the editor
afterwards showed the saving had simply moved: `refreshProps()` rebuilds the
entire instanced prop field on every commit, **300–400ms and rising**, which is
now the largest term by far.

The cost is not the prop count. On the shipped map one refresh builds **402
`InstancedMesh` batches over 143k base vertices**, because `buildPropField`
groups props into square regions and calls `treeParts()`, `bushParts()` and
`fenceParts()` once *per region* — so every refresh re-derives all prop geometry
from scratch, and the region count grows with the map.

Instancing is not the missing piece: the field already uses `InstancedMesh`, and
that shares the *draw call* across copies of one geometry. This is CPU work
building the geometry those draws point at.

The obvious fix — memoise the parts — is not safe on its own. `applySway`
(spec 074) writes per-batch instanced attributes onto `mesh.geometry`, so two
batches cannot share one geometry object. Measuring settled it anyway: geometry
construction is only 77ms of the 330ms. The rest is the batches themselves.

## Shape

The regions already exist, for culling. This makes them the unit of
**invalidation** too — the same move spec 085 made for chunks.

```ts
export const PROP_REGION_SIZE: number;
export function propRegionKey(x: number, z: number): string;

interface PropFieldHandle {
  /** Rebuild only the regions overlapping a world rectangle. */
  rebuildWithin(props: readonly Prop[], rect: MapRect): void;
}
```

Internally each region becomes a `THREE.Group` of its own, owning the
geometries and materials of its batches, so it can be freed and rebuilt without
touching its neighbours. `rebuildWithin` takes the *full* current prop list and
re-buckets it, so a caller never has to work out which props belong where — and
a region emptied by an erase is dropped rather than rebuilt as nothing.

`buildPropField` is otherwise unchanged, which matters because the play view
builds one and never rebuilds it.

### What the editor invalidates

- a part: the chunk rectangle it wrote or deleted;
- a brush or erase stroke: the bounding rectangle of the chunks the stroke
  dirtied, which it already tracks for nav and for undo.

`refreshProps()` stays for the cases that really do move everything — a file
load, or a map replaced wholesale.

## Invariants tested

- **`propRegionKey` names the region a point falls in**, and floors away from
  zero, so a grown map's west side does not fold onto its east.
- **A rebuild leaves untouched regions' batches as the same objects** — not
  rebuilt, not merely equal.
- **A prop added to a rebuilt region is drawn**, and one removed is not.
- **A region emptied by an erase is dropped**, rather than left as an empty
  group.
- **`undrawn` is recounted** on rebuild, so the editor's warning stays true.
- **A rectangle spanning several regions rebuilds all of them.**

## Measured

Five parts grown in sequence on a growing map, longest blocked frame per
commit, software renderer:

| | part 1 | part 5 (74 chunks) |
|---|---|---|
| before spec 085 | 1685ms | 2104ms |
| terrain + nav only | 1743ms | 1891ms |
| **and regions** | **533ms** | **794ms** |

~2.6x on average, and the growth with map size is much flatter. Absolute
numbers are inflated by the software renderer in CI; the shape is what matters.

## Out of scope

- Memoising the part geometry. It is 77ms of the 330ms and needs the sway
  attributes untangled from the shared geometry first.
- Making the play view rebuild anything. It builds the field once.
- The region size. 1100 units was chosen for culling and is left alone; it now
  also decides invalidation granularity, which is a tuning question for
  whenever one of the two starts to hurt.
