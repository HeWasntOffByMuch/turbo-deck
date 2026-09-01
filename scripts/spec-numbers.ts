/**
 * Which spec number to take, and whether this branch is about to take one twice.
 *
 *   npm run spec:next      the number to write, and who has claimed what
 *   npm run check:specs    the same report, plus an exit code (CI runs this)
 *
 * The git half of `src/tooling/spec-numbers.ts`, which is where every rule
 * lives and where they are tested. This file resolves three sets of paths and
 * prints them:
 *
 *   - the **baseline**, `origin/main`, which is what a collision is measured
 *     against, because a number that landed on main after this branch was cut
 *     is taken whether or not this branch has heard about it;
 *   - the **head**, this working tree including files not yet committed, since
 *     a spec written five minutes ago collides exactly as hard as a merged one;
 *   - **every other ref**, local and remote, which is the half nobody was
 *     reading. A pushed branch has published its claim, and reading 184 of them
 *     costs about half a second -- against 48 duplicated numbers on main.
 *
 * `--strict` is the idiom `check-shore.ts` and `audio-report.ts` already use
 * here: same output, plus an exit code.
 */

import { execFileSync } from 'node:child_process';

import {
  checkSpecs,
  nextFreeNumber,
  parseSpecPaths,
  type SpecFile,
} from '../src/tooling/spec-numbers.js';

const BASELINE_CANDIDATES = ['origin/main', 'main'] as const;

/**
 * Below this many refs, this checkout has not seen the branches.
 *
 * A full clone here carries 185; `actions/checkout` leaves one, and one more
 * once the workflow fetches main. There is no honest number between those two
 * populations, so the bar is set where it separates them and the report prints
 * the count it actually read rather than asking anybody to trust the bar.
 */
const ENOUGH_REFS = 10;

function git(...args: readonly string[]): string {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/** Answers null rather than throwing: a ref that is not there is an answer. */
function tryGit(...args: readonly string[]): string | null {
  try {
    return git(...args);
  } catch {
    return null;
  }
}

function lines(output: string | null): string[] {
  if (output === null) return [];
  return output.split('\n').filter((line) => line.length > 0);
}

/** The first of `origin/main`, `main` that this checkout actually has. */
function baselineRef(): string | null {
  for (const ref of BASELINE_CANDIDATES) {
    if (tryGit('rev-parse', '--verify', '--quiet', `${ref}^{commit}`) !== null) return ref;
  }
  return null;
}

/**
 * The baseline's tip, printed rather than trusted.
 *
 * A stale baseline is this check's one false-positive: every spec that merged
 * since would look like something this branch added, and any of those on a
 * contested number would be reported against a session that never touched them.
 * Nothing here can tell a stale ref from a fresh one -- so it prints the date,
 * and the fetch is the caller's (the SessionStart hook does one, and so does
 * CI, immediately before this runs).
 */
function baselineTip(ref: string): string {
  return (tryGit('log', '-1', '--format=%h %ad', '--date=short', ref) ?? 'unknown').trim();
}

function specsAt(ref: string): string[] {
  return lines(tryGit('ls-tree', '-r', '--name-only', ref, 'specs/'));
}

/**
 * The working tree, tracked and untracked alike.
 *
 * `--others --exclude-standard` is the half that matters: the moment a session
 * is most likely to be holding a colliding number is *before* it has committed
 * the file, which is exactly when `ls-files` alone reports nothing.
 */
function specsInWorkingTree(): string[] {
  return lines(tryGit('ls-files', '--cached', '--others', '--exclude-standard', 'specs/'));
}

/** Every branch this checkout can see. */
function otherRefs(): string[] {
  return lines(
    tryGit('for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes'),
  ).filter((ref) => !ref.endsWith('/HEAD'));
}

/** Where each claimed number came from, so a report can say who holds one. */
function claimsOnBranches(refs: readonly string[]): Map<number, SpecFile[]> {
  const byNumber = new Map<number, SpecFile[]>();
  for (const ref of refs) {
    for (const spec of parseSpecPaths(specsAt(ref))) {
      const held = byNumber.get(spec.number);
      if (held === undefined) byNumber.set(spec.number, [spec]);
      else if (!held.some((file) => file.path === spec.path)) held.push(spec);
    }
  }
  return byNumber;
}

function main(): void {
  const strict = process.argv.includes('--strict');

  const root = tryGit('rev-parse', '--show-toplevel')?.trim();
  if (root === undefined || root.length === 0) {
    console.error('spec-numbers: not a git repository.');
    process.exit(1);
    return;
  }
  process.chdir(root);

  const baseline = baselineRef();
  if (baseline === null) {
    console.error(
      'spec-numbers: no origin/main and no main. Run `git fetch origin` — the next\n' +
        '  free number cannot be worked out from this branch alone, which is the\n' +
        '  whole failure this check exists to prevent.',
    );
    process.exit(1);
    return;
  }

  const baselinePaths = specsAt(baseline);
  const headPaths = specsInWorkingTree();
  const report = checkSpecs(baselinePaths, headPaths);

  const refs = otherRefs();
  const branchClaims = claimsOnBranches(refs);
  const claimed = [
    ...parseSpecPaths(baselinePaths).map((spec) => spec.number),
    ...parseSpecPaths(headPaths).map((spec) => spec.number),
    ...branchClaims.keys(),
  ];
  const next = nextFreeNumber(claimed);

  const baselineSpecs = parseSpecPaths(baselinePaths);
  const baselineNumbers = new Set(baselineSpecs.map((spec) => spec.number));
  const onBaseline = Math.max(-1, ...baselineNumbers);

  const sawBranches = refs.length >= ENOUGH_REFS;

  console.log(
    `next free spec number   ${String(next).padStart(3, '0')}` +
      (sawBranches ? `   (counting ${refs.length} refs)` : `   (only ${refs.length} ref(s) — see below)`),
  );
  console.log(
    `highest on ${baseline.padEnd(12)} ${String(onBaseline).padStart(3, '0')}` +
      `   (at ${baselineTip(baseline)} — fetch if that looks old)`,
  );
  if (!sawBranches) {
    console.log(
      '\nThis checkout cannot see the other branches, so that number counts only\n' +
        'what has merged. Run `git fetch origin` — or run this in a full clone.',
    );
  }

  // Numbers a branch has published that main has not seen. These are the reason
  // the next free number is not simply "one past main", and naming them is what
  // turns the gap from a mystery into a list.
  const unmerged = [...branchClaims.entries()]
    .filter(([number]) => number > onBaseline)
    .sort(([a], [b]) => a - b);
  if (unmerged.length > 0) {
    console.log(`\nclaimed on an unmerged branch, past ${onBaseline}:`);
    for (const [number, files] of unmerged) {
      for (const file of files) console.log(`  ${String(number).padStart(3, '0')}  ${file.path}`);
    }
  }

  // A branch sitting on a number main already holds. Not this run's failure --
  // it is somebody else's branch -- but it is the collision, visible before it
  // lands rather than after.
  //
  // The test is "main holds this number under a different name", not "this
  // number is below main's highest": the sequence has holes at 020 and 021, and
  // a branch sitting in one of those is odd but is not a duplicate, so calling
  // it one would be the report crying wolf about the one thing it is for.
  const onMain = new Set(baselinePaths);
  const doomed = [...branchClaims.values()]
    .flat()
    .filter((file) => baselineNumbers.has(file.number) && !onMain.has(file.path))
    .sort((a, b) => a.number - b.number);
  if (doomed.length > 0) {
    console.log('\nbranches holding a number main already uses (they will duplicate on merge):');
    for (const file of doomed) console.log(`  ${file.path}`);
  }

  if (report.existing.length > 0) {
    console.log(
      `\n${report.existing.length} number(s) already duplicated on ${baseline}, left alone: ` +
        report.existing.map((collision) => String(collision.number).padStart(3, '0')).join(' '),
    );
  }

  if (report.collisions.length === 0) {
    if (report.added.length > 0) {
      console.log(
        `\nthis branch adds ${report.added.length} spec(s), none of them on a taken number.`,
      );
    }
    process.exit(0);
    return;
  }

  console.error('\nspec-numbers: this branch takes a number that is already used.');
  for (const collision of report.collisions) {
    console.error(`  ${String(collision.number).padStart(3, '0')}`);
    for (const file of collision.files) console.error(`      ${file.path}`);
  }
  // Naming a replacement number is only safe if the branches were visible. A CI
  // checkout has `main` and nothing else, so "one past main" is exactly the
  // advice that produced two spec 257s -- and saying it with a straight face
  // would make this check a cause of the thing it exists to catch.
  if (sawBranches) {
    console.error(
      `\n  Rename yours to ${String(next).padStart(3, '0')}. That counts every branch, not just ` +
        'main:\n' +
        '  renumbering to "one past the one you hit" is what put two spec 257s on\n' +
        '  main, when two branches did it on the same day.',
    );
  } else {
    console.error(
      `\n  This checkout can see ${refs.length} ref(s), so it cannot say which number is\n` +
        '  free — one past main is the advice that caused this. Run `npm run spec:next`\n' +
        '  in a full clone and take the number it gives.',
    );
  }
  console.error('  Update the `# NNN —` heading and any `spec NNN` reference with it.');
  process.exit(strict ? 1 : 0);
}

main();
