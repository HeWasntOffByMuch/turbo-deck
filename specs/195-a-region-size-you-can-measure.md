# 195 — A region size you can measure

## Problem

`PROP_REGION_SIZE` is 1100 world units and the opening zoom frames 711x881 of
ground, so a batching region is larger than the whole frame. A region that
clips the view submits every tree in it: measured over the shipped map, **413
props submitted to draw 99**, and the shadow pass submits another 464 to draw
123. Around three quarters of the prop geometry in the frame is off-screen.

Props are 88% of the frame's triangles, so that is the largest single thing in
it. But whether shrinking the region is a *win* depends on something no reading
in this repo could answer: whether the machine minds triangles or draw calls
more. Shrinking trades one for the other, and the two candidate answers pointed
in opposite directions:

- if the frame is bound by triangles, a smaller region is close to free;
- if it is bound by draw calls, a smaller region makes the frame *worse*.

The estimate said a 400-unit region would cost ~1000 prop draws against today's
283, which would have been a bad trade. The estimate was wrong, and there was no
way to find that out without trying it on real hardware.

## Shape

`?props=<size>`, in the same register as `?perf=`, `?seed=`, `?wire=` and
`?slots=` — a measuring affordance, off unless asked for, changing nothing the
sim does.

```ts
// perf-flags.ts -- pure, a string in and a number or null out.
export function parsePropRegionSize(search: string): number | null;

// props.ts
export const PROP_REGION_SIZE = 1100;   // the shipped size
export function propRegionSize(): number;
export function setPropRegionSize(size: number): void;
```

Two decisions.

**The size is module state, set once before anything is bucketed.**
`propRegionKey` is a free function called from the main thread, the worker and
the editor; threading a size through all of them would be a refactor in service
of a switch that exists to be thrown twice and read off a meter. What keeps that
safe is the second decision.

**The size rides the worker's `map` message**, rather than both threads reading
the same URL. A worker has its own module graph, so the main thread setting it
does not reach the worker — and a worker bucketing at 1100 while the main thread
asks for regions at 550 is a prop field with holes in it. Sending it with the map
makes the two agree by construction. The in-process twin takes the same path
even though it shares the module graph, because a twin that takes a different
path is a twin that stops proving anything.

`parsePropRegionSize` refuses zero, negatives and typos rather than passing them
on: `Math.floor(x / 0)` is `Infinity`, which buckets every prop in the world into
one region and draws a blank field with no error anywhere.

## What it measured

Against the shipped map, same camera, same spot:

| region | draws | triangles |
|---|---|---|
| 1100 (shipped) | 689 | 470k |
| 550 | 760 (+10%) | **238k (−49%)** |
| 400 | 818 (+19%) | **185k (−61%)** |

The estimate was badly wrong in the useful direction. It assumed draws scale
with the number of regions overlapped, at a fixed cost per region — but a
smaller region holds fewer prop *kinds*, so it needs fewer batches, and that
effect dominates. +129 draws for −61% of the frame's triangles, not the +715
that was predicted.

## Invariants tested

- `parsePropRegionSize` returns null for absent, empty, zero, negative and
  non-numeric, and the size for a usable one.
- The existing prop field, chunk ingest and worker tests pass unchanged at the
  default, so the flag is inert unless asked for.
- Both threads agree: the worker's `map` message carries the size and the
  in-process twin applies it the same way.

## Out of scope

- **Changing the shipped default.** This is the instrument, not the decision.
  What the number should be depends on a reading from a real GPU, which is the
  next step and belongs in its own commit — a constant changed on the strength
  of a container that rasterises in software would be a guess wearing a
  measurement's clothes.
- **Per-instance culling.** Strictly better than any region size — it cuts the
  same triangles at a constant draw count — and considerably more machinery:
  sub-cell ordering at build time and contiguous instance runs. Worth building
  only if a region size turns out not to be enough.
- **The shadow pass.** It submits its props against its own frustum at 1.8x the
  view's half-width and is the larger half of the prop cost. It benefits from
  this for free, and tightening it further is a separate question.
