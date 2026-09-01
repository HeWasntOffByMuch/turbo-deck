# 266 — A number nobody takes twice

## Problem

105 of the 319 specs on `main` share their number with another spec. 48 numbers
are contested, eight of them by three specs and one — 139 — by four. Spec 254 is
both "a client that is only the game" and "mobile offense buys cooldown", so
every `spec 254` in CLAUDE.md, in the specs and in a few hundred code comments
is ambiguous, and the sort order the numbers exist to give is a lie wherever
they collide.

The cause is one sentence. A session picks its number by reading `specs/`,
`specs/` only ever holds what has **merged**, and this repo runs 184 branches at
once. Two sessions that start on the same afternoon both see 264 as the highest
and both write 265.

The renumber that follows is what turned a leak into a flood. A session that
hits a collision at merge time renumbers to the next integer after the one it
hit — read off `main` again, which is the same view that caused the collision —
so a second session doing the same thing that day picks the same replacement.
`main` carries two spec 257s for exactly this reason: `renumber to spec 257: a
layer that comes back took 256` and `Merge origin/main, and renumber to spec
257`. It carries two 263s and two 264s the same way, one of them committed as
`Renumber the day/night cycle to spec 264: 263 was taken by the arrival`. **The
cure was the disease.**

What nobody was reading is the thing that already holds the answer: a branch
that has pushed its spec has published its claim, and `git ls-tree` over every
ref costs 0.5 seconds. Measured while writing this spec, nine spec files on live
branches were sitting on numbers `main` already used — nine duplicates already
in flight, invisible to all nine sessions.

## Shape

`src/tooling/spec-numbers.ts`, pure and tested:

```ts
interface SpecFile { path: string; number: number; slug: string }
interface Collision { number: number; files: readonly SpecFile[] }
interface SpecCheck {
  added: readonly SpecFile[];       // specs this branch introduces
  collisions: readonly Collision[]; // ...that land on a number already used
  existing: readonly Collision[];   // ...the 48 on main, reported, never gated
}

parseSpecPath(path): SpecFile | null
nextFreeNumber(claimed: Iterable<number>): number
collisionsIn(specs: Iterable<SpecFile>): Collision[]
checkSpecs(baseline: Iterable<string>, head: Iterable<string>): SpecCheck
```

`scripts/spec-numbers.ts` is the git half and resolves three sets of paths: the
**baseline** (`origin/main`), the **head** (this working tree, `--cached
--others`, so a file written and not yet committed counts), and **every other
ref**, local and remote.

- `npm run spec:next` — the number to write, and who holds what.
- `npm run check:specs` — the same report, plus an exit code. CI runs it.

Three surfaces carry the rule, in descending order of how hard they are to
ignore: the SessionStart hook prints the free number unasked, CLAUDE.md's
Spec-first workflow states the procedure, and `specs/000-template.md` repeats it
where a spec is actually started.

## Invariants tested

- `nextFreeNumber` is one past the highest claim and **never fills a gap** — the
  holes at 020 and 021 are abandoned work, and a spec dropped into one would
  sort as though it were built in 2025.
- A number claimed on an unmerged branch counts exactly like a merged one. This
  is the whole fix; a test asserts it directly.
- `checkSpecs` measures against the **tip** of `main`, not the merge base: a
  number that landed after this branch was cut is taken whether or not this
  branch has heard about it.
- A renumber clears the gate — it reads as an add at the new number and a
  removal at the old, so correcting a collision does not trip the check again.
- A branch that collides **with itself** (two new specs on one number) fails.
- A duplicate this branch did not introduce **never** fails. The 48 on `main` are
  reported as context and gated on by nothing.
- The failure message only names a replacement number when the checkout could
  actually see the branches. A CI checkout has one ref, where "one past main" is
  the exact advice that produced two spec 257s.

## Out of scope

- **Renumbering the 48.** Every `spec NNN` reference in CLAUDE.md, in the specs
  and in the source comments points at a number, and there are several hundred
  of them. Renaming 105 files would break all of it to tidy up history that is
  already written. They stay; a bare number below 266 may be ambiguous, and the
  way to disambiguate is the slug.
- **Making collisions impossible.** Sequential numbering with no shared
  coordinator cannot do that: a session that has picked a number and not pushed
  is invisible to every other session by construction. What closes is the days-
  long window (pick, build a feature, merge, collide) down to the minutes between
  writing the file and pushing it — which is why the workflow says to push the
  spec commit on its own, and why the recovery is defined as "ask the tool"
  rather than "add one".
- **Anything about spec content.** This is about the name of the file.
- **A stale baseline.** `check:specs` compares against whatever `origin/main`
  points at; if that is old, specs merged since read as this branch's. The fetch
  belongs to the caller — the hook does one, and CI does one in the step before.
  The report prints the baseline's commit and date rather than assuming.
