# 177 — A prop region that fits in a frame

## Problem

Spec 176 took the terrain and the nav grid off the main thread and left the prop
field on it, deliberately and with a number attached: rebuilding one 1100-unit
region is **32.7 ms**, and it is one dropped frame every time it happens.
Measured over a 90-second walk across the shipped arena (`bench-walk.ts`):

- **81 region rebuilds behind the loading screen** — 2.75 s of a 4.3 s load
- **28 in front of it** — one dropped frame every 3.2 s while walking into
  ground that has not been seen

Where the 32.7 ms goes, measured by timing each stage inside `build`:

| stage | ms | |
|---|---|---|
| part tables — `treeParts`/`bushParts`/`fenceParts` | 6.7 | rebuilt **per region** |
| `smoothGeometry` weld | 5.9 | re-welded **per region** |
| `new InstancedMesh` + material | 0.8 | genuinely per batch |
| **the instance loop** | **16.2** | pure arithmetic |
| `applySway` + `needsUpdate` | 1.5 | genuinely per batch |

Two separate findings sit in that table. Half the cost is **arithmetic that
belongs on the worker spec 176 already built**. The other half is **the same
geometry being constructed ninety times** — `buildRegion` calls `treeParts(species)`
for each of three species, `bushParts()`, and `fenceParts(kind)` for each fence
kind, *per region*, and each call builds `THREE.BufferGeometry` from scratch and
welds it again afterwards.

Neither half is enough alone. The worker takes 16.2 ms and leaves 16.5 ms, which
is still a whole frame at 60 Hz. Sharing the geometry takes 12.6 ms and leaves
20 ms. Together they leave about 4 ms, and a prop region stops being a dropped
frame.

## Shape

### The geometry is built once, and each batch gets a shell over it

`treeParts`, `bushParts` and `fenceParts` memoize. `smoothGeometry` memoizes on
`(source geometry, creaseCos)`. `bakeBend` rides along inside the part builders,
so it is baked once with them.

**But the geometry object itself cannot be shared**, and the reason is the
feature that made the per-region construction look necessary in the first place:
`applySway` writes `aWindBase` and `aWindTune` — *instanced* attributes, one
entry per tree — onto `mesh.geometry`. Ninety regions sharing one geometry
object is ninety regions whose trees all sway around the base points of whichever
region was built last.

So each batch gets a `THREE.BufferGeometry` **shell**: a fresh geometry whose
`position`, `normal`, `color` and `aBend` are the *same `BufferAttribute`
objects* as every other batch of that part, and whose instanced attributes are
its own. A shell costs an object and four assignments; it does no vertex work.

```ts
function shellOf(shared: THREE.BufferGeometry): THREE.BufferGeometry {
  const shell = new THREE.BufferGeometry();
  for (const name of Object.keys(shared.attributes)) {
    shell.setAttribute(name, shared.attributes[name]);   // shared, not copied
  }
  if (shared.index) shell.setIndex(shared.index);
  shell.boundingSphere = shared.boundingSphere;          // already computed
  return shell;
}
```

### ...and a shell is stripped before it is disposed

three's `onGeometryDispose` walks `geometry.attributes` and removes the GPU
buffer of every one it finds. Disposing a shell would therefore free the shared
attributes' buffers and force every *other* region holding that part to
re-upload — which is a hitch caused by the very rebuild this spec exists to make
cheap, and it would have been invisible in Node.

`disposeRegion` deletes the shared attributes off the shell first, so what it
disposes is only what that batch owns:

```ts
for (const name of SHARED_ATTRIBUTES) shell.deleteAttribute(name);
shell.setIndex(null);
shell.dispose();
```

### The instance loop goes to the worker

`buildRegionInstances(props, heightAt, shading)` is today's inner loop with
`mesh.setMatrixAt`/`setColorAt` replaced by writes into a `Float32Array`, and it
returns plain arrays keyed by which batch they belong to:

```ts
interface PropBatchInstances {
  readonly group: number;   // 0..2 tree species, 3 bush, 4.. fence kinds
  readonly part: number;    // index within that group's part list
  readonly count: number;
  readonly matrices: Float32Array;  // 16 per instance
  readonly colors: Float32Array;    // 3 per instance
  /** Present only where every instance in the batch sways. */
  readonly sway: { base: Float32Array; tune: Float32Array; height: number; reach: number } | null;
}
```

`(group, part)` is the identity, and it is an index into the enumeration
`buildRegion` already walks — three species, bushes, then the fence kinds in
`FENCE_KINDS` order. Both sides enumerate the same lists from the same module,
so the index cannot mean two things.

**The worker imports `props.ts`.** It builds the part geometries it will never
draw, and it carries three.js: the worker bundle goes from 34.9 kB to 187 kB.
That was measured before it was chosen, and it is the cheaper mistake. The
alternative is moving `treeVariant`, `speciesHeight`, `foliageColor`,
`shadedColor`, `SPECIES_STIFFNESS` and the four hundred lines of tier and trunk
arithmetic they read out from between the geometry builders they are interleaved
with — and the failure mode of that is two definitions of what a tree is, which
is a worse thing to own than 152 kB in a chunk that loads in parallel with a
4.99 MB one.

### The protocol

```ts
// main -> worker
| { kind: 'props'; rects: readonly WorldRect[]; shading: PropShading }
// worker -> main
| { kind: 'props'; region: string; batches: readonly PropBatchInstances[] }
```

`view.ts` sends what `takePropRects` hands it and adopts what comes back, in the
same inbox-and-budget shape spec 176 uses for meshes — a region is a region's
worth of work whichever thread does it, and adopting several in one frame is the
lurch that budget exists to prevent.

## Invariants tested

- A field built through `adoptRegion` is the field `buildPropField` builds:
  same batches, same instance counts, and matrices equal element for element.
  This is the whole risk of moving the loop and it is answered by comparison.
- Two regions of the same species get **different** `aWindBase` attributes, each
  matching its own trees. The shared-geometry version of this fails, which is
  the bug the shell exists to prevent.
- Disposing one region leaves another region's batches drawable — the shared
  attributes survive, and the shell's own instanced attributes do not.
- The part tables are built once per species and kind however many regions are
  built, and the weld once per `(part, creaseAngle)`.
- Changing the crease angle rebuilds the field and re-welds, rather than serving
  the previous angle's geometry from the memo.
- `(group, part)` names the same batch on both sides for every species, the
  bush, and every fence kind.
- A region rebuilt twice does not accumulate meshes, materials or sway patches.

## Out of scope

- **The 0.8 ms of `InstancedMesh` and material construction, and the 1.5 ms of
  `applySway`.** Both need the mesh, so both stay. They are what the remaining
  ~4 ms is.
- **Merging regions into one batch per part.** It would delete the shell problem
  and most of the remaining cost, and it would delete the culling the regions
  exist for (spec 086). Not a trade worth making for 4 ms.
- **The editor's `rebuildWithin`.** It calls the same handle and gets the same
  result; nothing about the map editor moves onto a worker in this spec.
- **The load's other 1.5 s.** Behind the gate this spec removes 81 rebuilds'
  worth of prop work from the main thread, but the chunk stream, the first nav
  grid and the gate's own conditions decide when it lifts.

---

## What it cost, measured

`npx tsx scripts/bench-stream.ts`, averaged over thirty real regions of the
shipped arena rather than measured on one — regions differ hugely in how many
props stand in them, and either a sparse or a dense one alone is a number that
flatters or libels the change:

```
one prop region, averaged over 30 real ones (77 props and 20 batches each):
  [worker] compose instances      17.5 ms
  [main]   shells + meshes + sway  1.0 ms
  -> the frame pays 1.0 ms of the 18.5 ms it used to pay
```

Both halves are in that pair of numbers. **32.7 ms → 18.5 ms** is the geometry
sharing, measured on its own before the worker was wired: the part tables and
the welds stopped being rebuilt ninety times. **18.5 ms → 1.0 ms** is the
worker.

The browser agrees, on the path that matters. `probe-streaming.ts` against a
real server over `?server`:

| | before 176 | after 176 | after 177 |
|---|---|---|---|
| worst streaming cost, standing still | — | 38–77 ms | **10 ms** |
| worst streaming cost, after walking | — | 98–129 ms | **9 ms** |
| worst stage named | props | props | mesh |

"props" has stopped being the worst thing the loader does, which it had been
since spec 165 opened.

The worker bundle went from 34.9 kB to 143 kB, which is the three.js it now
carries. That was the trade named in the Shape above and it is the one that was
made.

## What the tests had to be watched failing

The two ownership hazards are the reason this spec is not just "move the loop",
and a test nobody has watched fail is a test nobody should trust. Both were
checked by putting the bug back — `shellOf` returning the shared geometry
directly — and both of the tests written for them failed, and only those two:

- *gives two regions of the same species different wind bases*
- *leaves another region drawable after one is disposed*

The other nine passed throughout, including the equality check against the path
that shipped. That is the shape to expect: sharing a geometry object does not
move a single tree, it moves what the *wind* does to them, and it would have
looked perfect in every still screenshot this repo takes.
