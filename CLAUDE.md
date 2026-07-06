# turbo-deck

Real-time action combat fused with a rolling card economy: a hand of 3 cards
drawn from a deck, spent as special attacks, refilled on use, with perfect
parries/dodges drawing bonus cards.

## The one rule that governs everything

**Simulation and rendering are completely separate.**

- `src/sim/` and `src/cards/` are the simulation. They are pure TypeScript,
  have zero rendering/DOM dependencies, and run identically in Node or a
  browser. Given `(seed, sequence of timed inputs)`, the sim MUST produce
  bit-identical state on every run.
- `src/render/` is a thin layer on top: it reads sim state and draws it, and
  captures input and feeds it into the sim as timed events. It contains no
  game rules. If you find yourself writing an `if` that changes game outcome
  inside `src/render/`, that logic belongs in the sim instead.
- Because of this split, the whole game is playable and testable headlessly
  in Node, with no browser or canvas — that's what makes it possible for an
  agent to verify changes without a screen.

## Determinism rules

- Never call `Math.random()`, read `Date.now()`, or otherwise touch
  wall-clock time or ambient nondeterminism inside `src/sim/` or
  `src/cards/`. ESLint enforces the `Math.random` ban in those directories;
  the rest is on you.
- All randomness (shuffles, drawn RNG for effects, etc.) goes through a
  seeded PRNG (`src/shared/prng.ts`) that is passed into the sim explicitly
  as part of its constructor/init, never imported as a singleton.
- The sim runs on a **fixed timestep of 60 ticks/second**. It never reads
  real elapsed time to decide what happens; the render loop is responsible
  for translating real time into "how many ticks to advance," and feeds
  ticks/inputs to the sim one at a time.
- A test that replays the same seed and the same input sequence must get
  the same resulting state, every time, forever. This is the property that
  makes regressions detectable — treat any test that can't make this
  assertion as insufficient.

## Running things

| Command | What it does |
|---|---|
| `npm test` | Run the Vitest suite once (sim, cards, integration tests) |
| `npm run test:watch` | Vitest in watch mode |
| `npm run typecheck` | `tsc --noEmit` against the strict tsconfig |
| `npm run lint` | ESLint over the whole repo |
| `npm run build` | Production build of the renderer (Vite) |
| `npm run dev` | Dev server for the renderer, for actually playing the game |
| `npm run balance` | Headless Monte Carlo balance harness (see `scripts/balance-harness.ts`) |

CI (`.github/workflows/ci.yml`) runs typecheck + lint + test on every push
and must be green before merging.

## Spec-first workflow

Every feature gets a short markdown spec in `specs/` **written and committed
before its implementation**. Use `specs/000-template.md` as the starting
point. A spec should be short: problem statement, data/API shape, the
invariants that will be tested, and explicit out-of-scope notes. Specs are
numbered in build order; implementation PRs/commits should reference the
spec they implement.

## Commit conventions

- Small commits, one system per commit (e.g. "add deck/hand engine", not
  "add deck engine and renderer and balance harness").
- Write the spec in its own commit before the implementation commit that
  follows it.
- Commit messages describe *why*, not a changelog of files touched.

## Directory layout

```
specs/           spec markdown, one file per system, written before its code
src/shared/      PRNG and other dependency-free helpers shared by sim and cards
src/cards/       card/deck engine — pure data and pure functions, no sim/render deps
src/sim/         deterministic fixed-timestep combat sim, no rendering/DOM deps
src/game/        composition root wiring cards to the sim (stepGame) — the only
                 place that translates a CardEffect into the sim's ExternalEffect
src/render/      PixiJS renderer + keyboard input capture, no game rules
scripts/         standalone scripts (e.g. the balance harness), run via tsx
```
