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
 * Regions not yet composed, nearest the camera's pivot first.
 *
 * Ordered rather than merely returned, because the whole point is that what the
 * camera is pointed at arrives before the far corner of the map. Ties break on
 * the key so two runs of the same frame agree.
 */
export function propRegionsOwed(
  regions: ReadonlyMap<string, readonly Prop[]>,
  at: ResidencyPoint,
  held: ReadonlySet<string>,
): readonly string[];

/** How many regions with props in them are not composed. Counted, never subtracted. */
export function propRegionsPending(
  regions: ReadonlyMap<string, readonly Prop[]>,
  held: ReadonlySet<string>,
): number;
```

The grid itself moved to `prop-regions.ts`, which is `props.ts` minus three, because
this is the first thing outside that file to need the keying without needing a
mesh — and a second copy of `Math.floor(x / regionSize)` in the pure half would
be two answers to which props are in the region being adopted. `props.ts`
re-exports every name, so no existing caller moved. `propRegionKeysIn` went the
same way and replaced the loop `rebuildWithin` had inline, since the editor's
ledger has to mark exactly the regions an edit recomposed.

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

## What it measured, and what it corrected

On the shipped map (28,919 props, 72 regions), the field's own build:

| | before | after |
|---|---|---|
| `buildPropField` at open | 4,153 ms | **1 ms** |
| the ledger (`propRegions`) | — | 5 ms |

Three things this spec got wrong, found by building it:

- **The ordering wants a point, not a rectangle.** This spec asked for a
  `MapRect`. The editor camera *orbits*, so its world footprint is not
  axis-aligned and any rect standing in for it is an approximation — of a value
  used only to sort. `EditorCameraState.target` is the pivot, is exact, and is
  already what "what the camera is pointed at" means. Spec 212 still wants a real
  rectangle, because its keep test is a decision rather than an ordering.
- **The budget cannot bound this frame, and saying it does would be a lie.**
  One region is **55 ms** to compose (median over the map's 72; 77 ms at the
  worst), because a region is ~426 props at 0.15 ms each. `FrameBudget` is
  checked after a unit of work and nothing here can subdivide a region, so the
  pump composes exactly **one region per frame**. What that buys is real — the
  first region lands in 55 ms where the eager field took 4.5 s to land anything,
  and the tab pans and paints throughout — but it is not a bounded frame. The
  fix if one is wanted is a smaller region, and spec 195 chose 2200 by measuring
  draw calls on a real GPU *for the Play tab*, said in as many words that it is
  one machine's answer, and left `?props=` to ask again. The editor recomposes
  regions on every stroke, so it may well want a different number; that is a
  measurement on a real GPU rather than a guess here.
- **`held` is not a subset of `regions`.** An edit marks every region its
  rectangle touched, including ones with no props in them, so
  `held.size >= regions.size` can be true while regions are still owed. Written
  as the size comparison it obviously wants to be, the fill stops dead after a
  stroke near the edge of the map and the trees never arrive, with nothing
  reporting an error. `propRegionsPending` exists to make that countable, and
  the test for it pins the trap rather than the happy case.

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
- **`undrawn` still says so**, and says so *before* anything is composed: it is
  a fact about the prop list rather than about what has arrived, and answering
  it late would leave a tool looking broken for as long as the region holding
  the undrawn props had not landed (spec 086).
- **The trees actually arrive**, which no test above can tell. `npx tsx
  scripts/probe-editor-props.ts` drives the shipped build and reads
  `data-props`, published from what is **attached to the scene graph** rather
  than from what was asked for -- so a region composed into batches that never
  reached the group reads as absent, which is the one failure a deferred field
  can have and an eager one could not. It asserts the open owes regions rather
  than holding them, that the fill drains to nothing owed, and that the instance
  count lands at or above the map's own prop count.
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
