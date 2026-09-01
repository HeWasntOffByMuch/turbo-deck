/**
 * Which spec number is free, and which one this branch is about to collide on.
 *
 * 105 of the 319 specs on `main` share their number with another spec: 48
 * contested numbers, eight of them held by three specs and one by four. The
 * reason is one line long -- every session picks its number by looking at
 * `specs/`, `specs/` only ever holds what has *merged*, and this repo runs a
 * lot of branches at once. Two sessions that start on the same afternoon both
 * see 264 as the highest and both write 265.
 *
 * The renumber that follows is what turned a slow leak into a flood. A session
 * that hits a collision at merge time renumbers to the next integer after the
 * one it hit -- read off `main` again -- so a second session doing the same
 * thing on the same day lands on the same replacement. `main` carries two spec
 * 257s for exactly that reason, one committed as "renumber to spec 257: a layer
 * that comes back took 256" and the other as "Merge origin/main, and renumber
 * to spec 257". The cure was the disease.
 *
 * So the numbers here are read from **every ref**, not from the working tree: a
 * branch that has pushed its spec has published its claim, and 0.5s of
 * `git ls-tree` over 184 branches is the whole cost of seeing it. What that
 * cannot see is a session that has picked a number and not pushed yet, which is
 * why the workflow says to push the spec commit on its own -- it shrinks the
 * window from the days a feature takes to the minutes between writing the file
 * and pushing it.
 *
 * Pure: it is handed lists of paths and answers with numbers, so `npm test`
 * covers the rules and `scripts/spec-numbers.ts` is git plumbing and an exit
 * code.
 */

/** A spec file, as its name says it: `specs/264-a-press-that-waits.md`. */
export interface SpecFile {
  /** Repo-relative path, as git reports it. */
  readonly path: string;
  /** The `NNN` prefix, as a number. */
  readonly number: number;
  /** Everything after the prefix and before `.md`. */
  readonly slug: string;
}

/** A number claimed by more than one spec, and the files claiming it. */
export interface Collision {
  readonly number: number;
  readonly files: readonly SpecFile[];
}

/**
 * The gate's answer: what this branch adds, and what that costs.
 *
 * `collisions` is only ever about numbers this branch is *introducing*. The 51
 * already on `main` are history -- renumbering them would break every `spec NNN`
 * reference in CLAUDE.md, in the specs themselves and in a few hundred code
 * comments -- so they are reported as context and never as a failure.
 */
export interface SpecCheck {
  readonly added: readonly SpecFile[];
  readonly collisions: readonly Collision[];
  readonly existing: readonly Collision[];
}

const SPEC_NAME = /^specs\/(\d{3,})-([^/]+)\.md$/;

/**
 * Parse a path, or answer null for anything that is not a numbered spec.
 *
 * Null rather than a throw because the callers walk whole trees: a `README` in
 * `specs/` is not an error, it is a file this module has no opinion about.
 */
export function parseSpecPath(path: string): SpecFile | null {
  const match = SPEC_NAME.exec(path);
  if (match === null) return null;
  const [, digits, slug] = match;
  if (digits === undefined || slug === undefined) return null;
  const number = Number.parseInt(digits, 10);
  if (!Number.isSafeInteger(number)) return null;
  return { path, number, slug };
}

/** Every numbered spec in a list of paths, in the order they arrived. */
export function parseSpecPaths(paths: Iterable<string>): SpecFile[] {
  const specs: SpecFile[] = [];
  for (const path of paths) {
    const spec = parseSpecPath(path);
    if (spec !== null) specs.push(spec);
  }
  return specs;
}

/**
 * The number a new spec takes: one past the highest anybody has claimed.
 *
 * **Gaps are never filled**, and that is the one judgement in this file rather
 * than arithmetic. Specs are numbered in build order, so a spec dropped into
 * the hole at 020 would sort as though it had been built before the card deck
 * engine -- and the holes are there because work was abandoned, which is a fact
 * about the history worth keeping legible. Skipping a number costs nothing; the
 * sequence is a sort key, not an inventory.
 */
export function nextFreeNumber(claimed: Iterable<number>): number {
  let highest = -1;
  for (const number of claimed) if (number > highest) highest = number;
  return highest + 1;
}

/** Numbers carried by more than one file, lowest first, for reporting. */
export function collisionsIn(specs: Iterable<SpecFile>): Collision[] {
  const byNumber = new Map<number, SpecFile[]>();
  for (const spec of specs) {
    const held = byNumber.get(spec.number);
    if (held === undefined) byNumber.set(spec.number, [spec]);
    else held.push(spec);
  }
  return [...byNumber.entries()]
    .filter(([, files]) => files.length > 1)
    .map(([number, files]) => ({ number, files: [...files].sort(byPath) }))
    .sort((a, b) => a.number - b.number);
}

function byPath(a: SpecFile, b: SpecFile): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/**
 * Does this branch introduce a duplicate number?
 *
 * The comparison is against the **tip of `main`** rather than against the merge
 * base, and that is deliberate: a number that landed on `main` after this branch
 * was cut is taken, whether or not this branch has heard about it, and being
 * told at push time is the entire point. A rename off a taken number reads as an
 * add at the new number and a removal at the old one, so correcting a collision
 * clears the gate rather than tripping it again.
 */
export function checkSpecs(baseline: Iterable<string>, head: Iterable<string>): SpecCheck {
  const baselineSpecs = parseSpecPaths(baseline);
  const headSpecs = parseSpecPaths(head);

  const baselinePaths = new Set(baselineSpecs.map((spec) => spec.path));
  const added = headSpecs.filter((spec) => !baselinePaths.has(spec.path));

  // A collision is reported with every file on the number, added or not, because
  // "265 is taken" is not actionable and "265 is taken by 265-the-warden.md" is.
  const contested = new Set(added.map((spec) => spec.number));
  const collisions = collisionsIn([
    ...baselineSpecs.filter((spec) => contested.has(spec.number)),
    ...added,
  ]);

  // Everything already duplicated on `main`, which by construction is disjoint
  // from what this branch adds. Context for a reader, never a failure.
  return { added, collisions, existing: collisionsIn(baselineSpecs) };
}
