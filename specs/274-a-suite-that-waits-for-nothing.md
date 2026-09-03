# 274 — A suite that waits for nothing

## Problem

`npm test` is 2m53s wall and 330s of CPU across 430 files, and **147s of that
is the operating system's timer clamp rather than work.** Thirty-nine wire-level
test files each define their own settle primitive as
`new Promise((resolve) => setTimeout(resolve, 0))` and await it once or twice per
simulated tick. Measured on this container a `setTimeout(0)` round trip costs
**1.12ms** — Node clamps a zero timeout to one millisecond — where a
`setImmediate` round trip costs **0.004ms**. `rate-match.test.ts` simulates 260
seconds of game at 60Hz with two settles a tick: 31,200 timer round trips,
39.6s of a 39.6s file.

Those thirty-nine files are 54.3% of the suite's CPU. They are not slow because
the sim is slow; they are slow because the loop is asleep.

Two things came out of measuring it and belong in the same change. The pipeline
has **no incremental anything** — `tsc` runs cold at 22s and `eslint` cold at
43s on every invocation, against 4.8s and 1.5s warm — and there is no way to run
the tests for a change short of running all of them, although the median commit
here touches **one** TypeScript file. And `src/server/auth/auth.test.ts` carries
a millisecond race that fails about two runs in five on a fast machine
(spec 267's touch-forward assertion compares a re-read `expires_at` against one
captured a few instructions earlier, and both land in the same millisecond).
Making the suite faster makes that flake fire *more often*, so it is fixed here
rather than left to be re-discovered as a regression.

## Shape

No production code changes. Four edits to how the suite is run:

- `settle` in all thirty-nine files becomes
  `new Promise((resolve) => setImmediate(resolve))`. Same barrier — both yield a
  macrotask, and `setImmediate`'s check phase runs *after* the poll phase, so it
  is at least as strong a settle for anything I/O-driven as a timer that fires
  at the top of the next loop iteration.
- `npm run typecheck` gains `--incremental` with a gitignored
  `.tsbuildinfo`; `npm run lint` gains `--cache`. CI keeps running both cold,
  because a fresh checkout has no cache to warm and correctness there is the
  whole point.
- `npm run test:changed` — `vitest --changed` — and `npm run verify`, the three
  gates a developer actually runs, in one command over the warm caches.
- CI splits its single nine-step job into three parallel jobs, so wall time is
  the slowest of them rather than their sum.

`auth.test.ts` backdates the session's `last_seen_at` the way the assertion
above it already does, rather than depending on a millisecond having passed.

## Invariants tested

- All 8,307 existing tests pass unchanged. The settle swap is a change to how
  long a test waits, never to what it asserts.
- `auth.test.ts`'s touch-forward test passes twenty consecutive runs.
- `npm run typecheck` and `npm run lint` still fail on the faults they caught
  before, warm cache or cold — a cache that hides a real error is worse than no
  cache.
- CI gates on exactly the set of checks it gated on before the split.

## Out of scope

**Consolidating the thirty-nine `settle` definitions into one shared helper.**
This change fixes them where they are; that one file was edited thirty-nine
times to fix one primitive is the argument for a shared home, and it is a
separate decision about where a cross-tree test helper lives given the lint
fences (`src/server/persistence/testing.ts` is the precedent).

**Making `robe.test.ts` (13.9s), `walkability.test.ts` (9.2s) and
`vegetation.test.ts` (7.2s) faster.** Those are cloth solves, slope sampling and
scatter over the real map — real CPU, correctly spent, and nothing mechanical is
left in them.

**Wiring `npm run check:tracked` to anything.** It is a written gate with no
caller, which is worth fixing and is not this spec.
