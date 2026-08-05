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
  `src/cards/`.
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

Most of this is mechanical, not honour-system. `eslint.config.js` fails the
build on `Math.random`, on `Date`/`performance`/DOM globals, and on importing
three.js, PixiJS, lil-gui or anything under `src/render/` — across the whole
deterministic core (`shared`, `cards`, `sim`, `game`, `terrain`, `balance`) and
the pure subtrees that live under `src/render/` anyway (`cloth/`, `critters/`,
and the headless half of the editor). `src/shared/` additionally may not import
its own siblings. Two rules a linter can't see are still on you: the PRNG must
be *passed in*, never imported as a singleton, and no `if` in `src/render/` may
change a game outcome.

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
behind, against a flat world that had since become a heightfield. The
`SessionStart` hook now says so at the top of every session: if your branch
forks from history at or before `origin/master`, it prints the `git rebase`
command to fix it. Fix it before writing code, not after.

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
                 and where the vegetation stands. No three.js, no DOM. Also the
                 map document (spec 048): map.ts bakes a world to JSON,
                 map-world.ts loads one back as array-backed terrain.
src/cards/       card/deck engine — pure data and pure functions, no sim/render deps
src/sim/         deterministic fixed-timestep combat sim, no rendering/DOM deps
src/game/        composition root wiring cards to the sim (stepGame) — the only
                 place that translates a CardEffect into the sim's ExternalEffect
src/render/      PixiJS renderer + keyboard input capture, no game rules
src/render/cloth/ pure cloth simulation for the robed character (spec 046) --
                 solver, wind, patterns, colliders and figure metrics. No
                 three.js and no DOM, so it runs and is tested headlessly.
src/render/critters/ playable animal characters as pure data (spec 055): one
                 file per species (proportions, blocks, sockets, colours) over
                 the shared skeleton, plus the player coat palette. No three.js.
                 Adding an animal is a data file + one line in index.ts;
                 `src/render/iso3d/critter.ts` already knows how to build it.
                 `npx tsx scripts/preview-critters.ts` renders the real rig to
                 .claude/screenshots/critters.png to check it reads at 64px.
src/render/iso3d/editor/  the map editor tab (specs 049-052). Renders only from
                 a loaded map document, never from the world generator. camera.ts,
                 brush.ts, scatter.ts, markers.ts and history.ts are pure and
                 tested headlessly; view.ts, cursor.ts and marker-view.ts are the
                 three.js scene; panel.ts is the lil-gui surface.
src/balance/     Monte Carlo balance harness logic (seeded bot policy + runner),
                 pure and testable; scripts/balance-harness.ts is its thin CLI
scripts/         standalone scripts (e.g. the balance harness), run via tsx
.claude/         harness config: agents/ (the delegation policy, see below),
                 hooks/session-start.sh (branch-base check + dependency install),
                 settings.json, notes/ and screenshots/
```

## Delegation

The delegation policy lives in `.claude/agents/`, not here: each agent's
`description` decides when it gets reached for and its `model:` line picks the
tier, so the harness acts on it instead of hoping this file gets re-read.

| Agent | Reach for it when |
|---|---|
| `test-runner` | running `npm test`, `typecheck`, `lint`, `build` or `balance` — anything whose full output would otherwise land in context |
| `code-explorer` | tracing how an existing system works, or any question answered by reading across several files |
| `implementer` | the design is already settled and the work is "make it so" inside one module |
| `architect` | the change crosses sim/cards/game/render/terrain, touches the deterministic core, or needs a `specs/` entry written first |

Main context keeps the judgement calls: design decisions, cross-system changes,
and bugs whose cause is not yet located. Batch independent agent calls into a
single message so they run concurrently.

Where the output goes matters as much as who does the work:

- `.claude/notes/<area>.md` — cached architecture summaries. Read one before
  sending an agent to re-derive it. Tracked.
- `.claude/screenshots/` — visual checks (`npx tsx scripts/preview-critters.ts`
  writes here). Tracked, so they can be reviewed on the branch; pull an image
  into context only when something has actually gone wrong.
- `.claude/scratch/<task>.md` — disposable sifting and long reasoning.
  Gitignored, and not part of the record.
