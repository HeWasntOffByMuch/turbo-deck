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

## Branching

**The default branch is `main`. Branch from it, and merge back into it.**

`master` also exists on the remote and is badly out of date — it is an
abandoned ref, not a second line of development. Nothing should ever be based
on it. A fresh clone will not have `main` locally until you fetch, and
`git branch -a` will happily show you `master` and no `main`, so:

```sh
git fetch origin
git rev-parse --verify origin/main   # check the ref directly, not by scanning a list
git checkout -b <branch> origin/main
```

This has bitten real work: a feature branch cut from `master` landed 42 commits
behind, against a flat world that had since become a heightfield.

## Commit conventions

- Small commits, one system per commit (e.g. "add deck/hand engine", not
  "add deck engine and renderer and balance harness").
- Write the spec in its own commit before the implementation commit that
  follows it.
- Commit messages describe *why*, not a changelog of files touched.

## Directory layout

```
specs/           spec markdown, one file per system, written before its code
src/shared/      PRNG, spatial hash, world extent — dependency-free helpers
                 shared by sim, cards and terrain
src/terrain/     pure, deterministic world data: heightfields, materials, chunks
                 and where the vegetation stands. No three.js, no DOM.
src/cards/       card/deck engine — pure data and pure functions, no sim/render deps
src/sim/         deterministic fixed-timestep combat sim, no rendering/DOM deps
src/game/        composition root wiring cards to the sim (stepGame) — the only
                 place that translates a CardEffect into the sim's ExternalEffect
src/render/      PixiJS renderer + keyboard input capture, no game rules
src/render/cloth/ pure cloth simulation for the robed character (spec 046) --
                 solver, wind, patterns, colliders and figure metrics. No
                 three.js and no DOM, so it runs and is tested headlessly.
src/balance/     Monte Carlo balance harness logic (seeded bot policy + runner),
                 pure and testable; scripts/balance-harness.ts is its thin CLI
scripts/         standalone scripts (e.g. the balance harness), run via tsx
```

## Token Efficiency & Delegation

**Delegate to cheaper/subagent models:**
- Any output not needed in main context (log dumps, file listings, build output, dependency trees) → run via subagent, return only a distilled summary or pass/fail status.
- Playwright/E2E test runs → execute via subagent, return only: pass/fail count, failing test names, and a 1-3 line failure reason. Never paste full stack traces or DOM dumps into main context unless a test fails and root cause is unclear — then request only the relevant excerpt.
- Codebase/architecture exploration (reading through existing systems, tracing how a feature works) → delegate to a subagent using a lighter model (e.g. Sonnet), have it return a structured summary (files touched, key functions, data flow) instead of raw file contents.
- Large refactors across many files → delegate per-file or per-module summaries, then synthesize.

**Model tiering by task type:**
- Cheap/fast model: search, grep, file listing, formatting/lint checks, summarizing logs, running test suites and reporting pass/fail.
- Mid-tier model: straightforward implementation, boilerplate, routine bug fixes, writing tests, reading/summarizing architecture.
- Top-tier model (main context): design decisions, cross-system changes, tricky/non-obvious bugs, anything requiring full project context or judgment calls.
- Default to the cheapest model capable of the task; escalate only when a subagent's output is ambiguous, low-confidence, or the task spans multiple systems.

**Screenshots & visual artifacts:**
- Save Playwright/manual test screenshots to the working branch (e.g. `test-results/` or `.claude/screenshots/`), do not embed them in context.
- Only load a screenshot into context if a test fails and visual inspection is required to debug — load just that one image, not the batch.

**Ephemeral scratch files:**
- Subagents doing exploration, multi-step reasoning, or trial-and-error should write intermediate work to a temp file (e.g. `.claude/scratch/<task>.md`) instead of streaming it into context.
- Only the final summary/result gets pulled into main context; scratch files stay on disk for reference if needed later.
- Clear or gitignore `.claude/scratch/` periodically — treat it as disposable, not part of the permanent record.

**General token discipline:**
- Prefer `grep`/targeted reads over full-file dumps when only a function or section is relevant.
- When summarizing multi-file changes, report diffs/deltas, not full file contents.
- Cache/reuse architecture summaries from subagents instead of re-reading the same files each session — write them to a `docs/` or `.claude/notes/` file and reference that first.
- Batch related subagent calls instead of issuing them one at a time when the tasks are independent.
- Truncate long tool outputs (build logs, package installs) to last N lines + error lines unless full output is explicitly requested.
- For iterative work (e.g. fixing a failing test loop), keep only the current failure state in context — don't accumulate prior failed attempts' full output.

Apply these by default without asking for confirmation, unless the task explicitly requires full detail in-context.
