# 191 — Where the frame goes

## Problem

The meter says how long a frame took, and since spec 189 how much of it was the
simulation. It cannot say anything about the other half. "The renderer is slow"
covers three unrelated problems with three unrelated fixes — too much JavaScript
building the frame, too many commands handed to the driver, and a GPU that
cannot keep up — and the number on screen is the same in all three cases.

That is not academic here. The shipped frame is ~689 draw calls and ~470k
triangles. 470k triangles is nothing for a GPU; 689 WebGL draw calls is a
meaningful amount of CPU. Which of those is the bill decides whether the next
piece of work is prop culling (fewer triangles, same draws), a smaller
`PROP_REGION_SIZE` (fewer triangles, *many* more draws), or neither — and
getting it backwards means paying for a change that makes the frame worse.

Nothing in the tree can currently tell them apart, and this container cannot be
asked: it rasterises in software, so its answer inverts the real one.

## Shape

Two numbers from the scene, one derived by the overlay.

```ts
// scene.ts, split at the first draw call of the frame.
renderCost(): { readonly prepareMs: number; readonly drawMs: number };

// fps-overlay.ts
export interface RenderCost {
  readonly prepareMs: number;
  readonly drawMs: number;
}
```

Rendered as one line: `prep 2.6  draw 14.3  rest 202.4ms`.

**The split is at the first draw call**, not at a pass boundary. Everything
before it is JavaScript preparing the frame — posing rigs, ageing effects,
walking the scene graph — and is fixed by doing less work. Everything after is
handing commands to the driver, and is fixed by submitting fewer of them. A
per-pass breakdown would be finer and would answer a question nobody is asking
yet; this answers the one that decides the next spec.

**`rest` is computed, not measured**: the frame time minus the sim, the
preparation and the submission. It is everything this thread cannot time — the
GPU, the driver, the compositor, vsync. Publishing it as a subtraction rather
than pretending the parts add up to a frame is the whole point: a large `rest`
means the answer is not on this thread and none of the three numbers beside it
is worth chasing.

One honest caveat, stated in the code rather than only here: WebGL commands are
queued, so `drawMs` is submission and not GPU time — but when the queue backs
up the driver blocks *inside* a later GL call, so real GPU time can land in
`drawMs`. A large `drawMs` with a small `rest` still means the GPU is the
problem.

## Invariants tested

- `CostMeter` already carries the arithmetic and its tests already stand; this
  adds no new statistics.
- The three numbers reach the page: `data-fps-prepare`, `data-fps-draw` and
  `data-fps-rest` are published beside the existing handles, and
  `scripts/probe-sim-cost.ts` reads them off a real browser over both
  transports.
- `rest` is never negative — a frame whose parts over-account (the meters use
  different windows) reports zero rather than a number that reads as a bug.
- The measurement does not change what it measures: no clock is read that was
  not already read, and the split reuses the frame's own `performance.now()`.

## Out of scope

- **Per-pass timing.** Shadow map, buffers, retro composite and edges each on
  their own line. Worth having once `prep`/`draw`/`rest` says which half to look
  in; before that it is four numbers where one would do.
- **Real GPU timing.** `EXT_disjoint_timer_query_webgl2` would measure what
  `rest` infers, and is unavailable or throttled in enough browsers that a
  readout depending on it would be blank exactly where it matters.
- **Deciding between prop culling and a smaller `PROP_REGION_SIZE`.** That is
  what this exists to inform, and it needs a reading from a real GPU.
