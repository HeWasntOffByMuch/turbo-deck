# Engineering charter

Drop this in as the `CLAUDE.md` of a new project and fill in the bracketed
parts. It is the set of rules turbo-deck was built under, with the game taken
out of them.

## 1. The one rule that governs everything

**The `<core>` and the `<shell>` are completely separate.**

- `src/<core>/` is the whole of the logic and the only place decisions are
  made. It has zero rendering, DOM, network or filesystem dependencies and runs
  identically in Node or a browser.
- `src/<shell>/` is thin: it reads core state and draws it, and turns input
  into timed events it feeds back in. It contains no rules. **If you find
  yourself writing an `if` in the shell that changes an outcome, that logic
  belongs in the core.**
- The property this buys is the one worth protecting: the whole product is
  runnable and testable **headlessly**, which is what lets an agent verify a
  change without a screen.

## 2. Determinism

- Given `(seed, ordered inputs)` the core MUST produce bit-identical state on
  every run. A test that cannot make that assertion is insufficient.
- Never call `Math.random()`, read `Date.now()`, or touch wall-clock time or
  any ambient nondeterminism inside the core.
- **Time and randomness are arguments.** All randomness goes through a seeded
  PRNG *passed in explicitly*, never imported as a singleton. `nowMs` is a
  parameter.
- Fix the core's timestep. The shell translates real elapsed time into "how
  many steps to advance" and feeds them one at a time.
- The *number of draws* from the PRNG is protocol: changing how many values a
  path consumes changes every outcome after it. Treat it as a breaking change.
- Presentation may never change an outcome. Assert it: run the same seed and
  inputs twice, once with the presentation layer driven and once without, and
  require identical authoritative state.

## 3. Make the rules mechanical, not honour-system

Most of the above should be a lint rule, not a promise. Configure the linter to
fail the build on `Math.random`, on `Date`/`performance`/DOM globals, on
`node:*` imports, and on importing the rendering library or anything under
`src/<shell>/` — across the whole core. Write down the two or three rules a
linter genuinely cannot see, and keep that list short.

Cache your lint results on a key that includes **the lint config itself**. A
cache that serves stale answers about the determinism fences is worse than no
cache.

## 4. Spec first

- Every feature gets a short markdown spec in `specs/`, **written and committed
  before its implementation**, in its own commit.
- A spec is short: problem statement, data/API shape, the invariants that will
  be tested, and explicit out-of-scope notes.
- Implementation commits reference the spec they implement.
- **Push the spec before you start building.**

## 5. Numbering specs

- **Never read `specs/` to find the next number.** `specs/` holds only what has
  merged; several sessions are looking at the same apparent gap.
- Build a `spec:next` script that reads **every branch** (`git ls-remote` /
  every ref), not the working tree, and take what it says. A pushed branch has
  published its claim; reading all of them costs half a second.
- Pushing early is your half of the bargain. Until you push, your claim is
  invisible, and the window in which somebody takes your number is the whole
  time you spend building.
- If you collide anyway, run the tool **again** and take that number. Never
  renumber to "one past the one I hit" — that is read off the merged view,
  which is the same view that caused the collision, so two sessions colliding
  pick the same replacement.
- A `check:specs` gate in CI: a branch may not *introduce* a duplicate. Existing
  duplicates are reported and never failed on — renumbering them breaks every
  reference pointing at them.

## 6. The loop

Two gates, and they are different gates:

- **Inner loop** — one command (`verify`) that runs incremental typecheck,
  cached lint, and only the tests reachable from what git says changed. Seconds,
  not minutes. Run it before every commit.
- **Merge gate** — CI runs all three cold and every test, on every push. It
  does not try to be clever about which tests are affected, because a gate that
  only ran what it thought was affected would be trusting the dependency graph
  about the one thing nobody is watching.

## 7. Instruments, not screenshots

For anything whose correctness is a shape, a schedule, or a sequence, write a
script rather than eyeballing it. Two kinds, named so the distinction stays:

- `preview-*` — renders or prints what something *is*, offline, through the
  real code path. For judging a shape or a curve.
- `probe-*` — drives the **shipped build** in a real browser/process and reads
  back what actually happened. For answering "is any of this wired to
  anything", which no headless test can.

Rules learned by getting them wrong:

- **Every instrument needs a control.** A measurement with no "before" cannot
  tell a working feature from one that is always on. A run of checks that are
  all *absences* passes perfectly when nothing happened at all — include one
  positive assertion that fails in that case.
- **Publish observables from what happened, not from what was asked for.** An
  attribute written at request time reports a working system when the work was
  refused.
- **Poll, never sleep.** A fixed wait reads state before the frame that
  produced it. Headless environments paint at a few frames a second.
- Measure the thing itself: derive the footprint you are measuring from the
  system (turn the feature off and diff) rather than choosing a crop.

## 8. One answer per question

- When two files must agree about a number, make it **one function with two
  callers**. Two literals that have to agree is drift waiting for the first
  edit.
- Derive constants rather than choosing them, and say what they are derived
  from. Especially: **the rule that lets go must not fight the rule that takes
  hold** (an eviction radius derived from the request radius; a keep window
  derived from the view).
- Prefer a **closed table** to a heuristic. A heuristic is a second, invisible
  answer every boundary re-derives, and it has nowhere to put the label.
- **Absent is a state.** Don't write a default into every row; an absent field
  means "the shared default", so moving the default reaches everything that did
  not override it — and adding the field moves no existing file's bytes.
- Content is **data**: tables with ids, and records that store only an id.
  Player-facing descriptions are **derived from the row the logic reads**, never
  authored beside it.
- Anything serialized — wire enums, persisted ids, saved-preference keys — is
  **append-only**. Renaming an id silently discards what references it.

## 9. What goes in the docs

`CLAUDE.md` and `docs/` are for **durable direction and the reasons**, not a
changelog. When you write something down:

- Record the **measurement**, not a description of the answer. "This is what it
  cost and here is the number" survives; "this is fast now" does not.
- Record what you **deliberately did not do**, with its measurement. An
  out-of-scope note is the difference between a known limitation and a bug
  nobody has found yet.
- **State the cost rather than hiding it.** Every real decision gives something
  up; write down what.
- Record the thing that was **learned by getting it wrong**. Those are the notes
  that stop the next session repeating it.

## 10. Standing habits

- **A socket with nothing plugged into it is the recurring failure.** Half a
  feature, fully tested, wired to nothing, discovered a hundred commits later.
  Either wire it now or delete it. When you remove a feature, remove its
  machinery with it — don't leave it switched off.
- A wrong answer and a missing answer are different: make the failure *say*
  which. Distinguish "no server here", "the server refused" and "nothing
  answered" — they have three different fixes.
- Never fix a failing check by loosening it. Fix the thing, or state the
  property so precisely that the check stays exact.
- "Flake" is not a root cause. Re-run once, at most, and only when something
  died before any test body ran. Never skip, disable or quarantine a test.
- If the obvious version was wrong, keep the note about why — not the version.

## 11. Delegation

Keep the delegation policy in `.claude/agents/` (each agent's `description`
decides when it is reached for, and its `model:` picks the tier) rather than in
prose here, so the harness acts on it. A workable default set:

| Agent | Reach for it when |
|---|---|
| `test-runner` | running tests, typecheck, lint, build — anything whose full output would otherwise land in context |
| `code-explorer` | tracing how an existing system works, or any question answered by reading across several files |
| `implementer` | the design is settled and the work is "make it so" inside one module |
| `architect` | the change crosses subsystems, touches the core, or needs a spec written first |

Main context keeps the judgement calls: design decisions, cross-system changes,
and bugs whose cause is not yet located. Batch independent agent calls into one
message so they run concurrently.

Where output goes matters as much as who does the work:

- `.claude/notes/<area>.md` — cached architecture summaries, tracked. Read one
  before sending an agent to re-derive it.
- `.claude/screenshots/` — visual checks, tracked so they review on the branch.
  Pull an image into context only when something has gone wrong.
- `.claude/scratch/<task>.md` — disposable sifting and long reasoning.
  Gitignored, not part of the record.

## 12. Branching and commits

- The default branch is `main`. Branch from it, merge back into it. Fetch
  first — basing a branch on stale history costs more than it saves.
- Have the session-start hook report how far behind `origin/main` you are, so
  that shows up at the top of the session rather than at merge time.
- Small commits, **one system per commit**.
- The spec goes in its own commit, before the implementation commit.
- Commit messages describe **why**, not a changelog of files touched.
