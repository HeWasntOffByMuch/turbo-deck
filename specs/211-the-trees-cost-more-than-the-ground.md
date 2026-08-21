# 211 — The trees cost more than the ground

## Problem

Spec 207 stopped the server meshing a world nobody draws, and named where the
cost went instead:

> `buildChunks` still costs 30.7 s at 4× *when it is called*, and the editor
> calls it — so opening the editor on a 4× map is the next real problem.

That is true and it is not the largest part of it. Nothing in the tree measured
the editor, so the claim was the one stage anybody had a number for.
`scripts/bench-editor.ts` runs `EditorScene`'s own constructor sequence —
`loadMap` → `map.chunks` → `buildTerrainMeshFromChunks` → `buildPropField` —
across world sizes:

| chunks | props | load | chunks | mesh | **propField** | open |
|---|---|---|---|---|---|---|
| 200 | 7,288 | 6 ms | 720 ms | 311 ms | **1,152 ms** | 2.2 s |
| **800 (today)** | 28,535 | 43 ms | 2,822 ms | 2,075 ms | **4,491 ms** | **9.4 s** |
| 3,200 | 114,173 | 409 ms | 10,718 ms | 7,385 ms | **18,124 ms** | **36.6 s** |
| 12,960 (4× target) | ~460,000 | | | | | **~148 s** |

The chunk build 207 named is **30%**. The mesh is 20%. **`buildPropField` is
half**, at every size, and 207 does not mention it.

It is also the only one of the four that is paid **more than once**.
`refreshProps()` disposes the whole field and builds it again, and `view.ts`
reaches it from a height-brush stroke ending without a rect, from undo, and from
every load — so on today's map a stroke can cost 4.5 seconds of frozen editor,
and that is a cost the map has today rather than one it grows into.

What costs is not the ground. `heightAt` over all 28,919 props of the shipped
map is **6 ms** against seconds for the field; the time is composing instances —
a matrix, a colour and a scale per instance per part. That is precisely the work
**spec 181 already took off the frame thread**, for the Play tab, through
`buildRegionInstances` and `adoptRegion`. The editor calls neither.

## Shape

The seam exists and is unused from here: `adoptRegion(key, instances)` hangs one
region's batches, `buildRegionInstances(bucket, heightAt, normalAt)` composes
one region's worth, and `rebuildWithin` is documented as "this with that in
front of it". What is missing is a field that starts **empty**, and a ledger of
which regions are owed.

```ts
// props.ts — one more way to ask for a field, not a second field.
export interface PropFieldOptions {
  /**
   * Compose nothing at build time. The handle comes back with its group
   * attached and no batches in it; regions arrive through `adoptRegion`.
   */
  readonly deferred?: boolean;
}
export function buildPropField(
  props: readonly Prop[],
  heightAt: (x: number, z: number) => number,
  normalAt?: NormalAt,
  shading?: PropShading,
  options?: PropFieldOptions,
): PropFieldHandle;
```

```ts
// src/render/iso3d/editor/prop-residency.ts — pure, no three.js.

/** Which regions have props in them, keyed exactly as `propRegionKey` keys them. */
export function propRegions(props: readonly Prop[]): ReadonlyMap<string, readonly Prop[]>;

/**
 * Regions not yet composed, nearest the view centre first.
 *
 * Ordered rather than merely returned, because the whole point is that what the
 * camera is pointed at arrives before the far corner of the map. Ties break on
 * the key so two runs of the same frame agree.
 */
export function propRegionsOwed(
  regions: ReadonlyMap<string, readonly Prop[]>,
  view: MapRect,
  held: ReadonlySet<string>,
): readonly string[];
```

The editor's frame drains that list under the existing `FrameBudget`, and
`refreshProps()` stops meaning "dispose and rebuild now": it drops what is held
and lets the same drain put it back. One mechanism then covers all four cases
that reach the field today — boot, load, undo, and a stroke with no rect — and
none of them blocks.

**Composition stays on the frame thread**, which is the one place this parts
company with spec 181 and the reason is not effort. The Play tab's props are
immutable once streamed, so a worker can hold a copy of them; the editor's props
change under the tools — scatter, erase, part add and remove — so a worker's
copy of the field's input would be **a second description of the document**, and
keeping it in step is a larger question than the one being answered here. Paced
rather than moved.

## Invariants tested

- **A deferred field composes nothing.** Built and not pumped, it holds no
  batches and no geometry — asserted by counting, not by timing, since a clock
  in the suite is a test about the container it runs in.
- **A drained field is the field that shipped.** Deferred, then pumped until
  nothing is owed, produces batches deep-equal to `buildPropField`'s eager
  result — batch for batch and instance for instance. This is what makes it a
  change of *when* rather than of *what*, the assertion spec 207 made for chunks.
- **What the camera is pointed at is composed first.** `propRegionsOwed` returns
  regions ordered by distance from the view centre, ties on key, so the order is
  the same on two runs.
- **A pump makes progress and then stops.** Under a spent budget it still
  composes one region; under a live one it stops as soon as the budget is gone
  — the `FrameBudget` contract, driven with numbers rather than a clock.
- **Nothing is composed twice.** Pumping a held region is a no-op and the held
  set never exceeds the region count.
- **A whole-field refresh re-owes rather than rebuilds.** After `refreshProps()`
  nothing is composed and exactly the regions that were held are owed again.
- **`undrawn` still says so.** A prop kind with no geometry is reported once
  across adopted regions, not silently drawn as nothing (spec 086).
- **Boot is flat in world size**, asserted as a slope against a 16× world rather
  than as a value.

## Out of scope, with the number that would change it

- **The map worker.** Argued above rather than deferred for effort. The reading
  that would reopen it: when one region's composition stops fitting a frame —
  `bench-editor`'s `per prop` cost times a region's population past ~16 ms.
- **Ground chunks and the terrain mesh**, the other half of the `open` column.
  That is spec 212, and it is a different shape: the ground is what the cursor
  raycasts against, so deferring it has a consequence for picking that the trees
  do not have.
- **Evicting a composed region.** This makes the field arrive late; it does not
  make it go away, so a long session still ends holding every region it ever
  looked at. Spec 212's keep window covers both, because the window is one idea.
- **Level of detail at wide zoom.** The editor camera can pull out to frame the
  whole map on purpose (`maxHalfWidthFor`), so a fully-drained field at widest
  zoom is still every prop in the world. The budget bounds the *rate*, not the
  set. What would change that is the drained heap, not the time:
  `bench-editor`'s `heap` column past ~1 GB at the target size — the same
  reading spec 207 left for the `ChunkSource`.
