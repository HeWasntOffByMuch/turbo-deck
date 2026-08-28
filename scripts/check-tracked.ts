/**
 * Is every source file actually in git?
 *
 * The check that would have caught the thing it was written for. `.gitignore`
 * carried an unanchored `data/` -- meant for the live SQLite database at the
 * repo root -- and an unanchored directory pattern matches that name at *any*
 * depth, so it also matched `src/server/data/`: the content tables, and the
 * most-edited source directory in the repo.
 *
 * What made it silent is the half of .gitignore people forget: **it does not
 * touch what git already follows.** Every file already in `src/server/data/`
 * stayed tracked, `git status` stayed clean, and `git add -A` skipped only the
 * *new* ones -- without a word, because reporting an ignored path is precisely
 * what `add` is documented not to do. The branch typechecked, linted and passed
 * seven thousand tests against a working tree holding files that were not in
 * git at all.
 *
 * **This is a pre-push check, not a CI one, and the distinction is the point.**
 * CI checks out *from* git, so the missing file is missing there too and `tsc`
 * fails on the dangling import -- CI would have caught this, loudly, on the
 * first push. What no clean-checkout job can ever see is the *difference*
 * between a developer's tree and the index, and that difference is where this
 * class of fault lives. So it runs where the two can disagree.
 *
 * Exit code 1 and a named list on failure, so it is usable from a hook.
 */

import { execFileSync } from 'node:child_process';

/** Directories whose contents are source and belong in git, without exception. */
const SOURCE_ROOTS = ['src/', 'scripts/', 'specs/', 'docs/', 'schemas/', 'maps/'];

/**
 * Extensions that are source rather than output.
 *
 * A list rather than "anything that is not in a known-output directory",
 * because the genuinely ignorable things that turn up under a source root are
 * editor droppings and logs, and naming what counts is shorter than naming what
 * does not.
 */
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.md', '.glsl', '.html', '.css'];

function git(...args: readonly string[]): string {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function isSource(path: string): boolean {
  if (!SOURCE_ROOTS.some((root) => path.startsWith(root))) return false;
  return SOURCE_EXTENSIONS.some((extension) => path.endsWith(extension));
}

// `--ignored` lists what git is deliberately hiding; `-uall` expands ignored
// *directories* into their files, without which an ignored folder reports as one
// entry and a caller cannot tell whether anything inside it matters.
const lines = git('status', '--porcelain', '--ignored', '-uall').split('\n');

const ignored: string[] = [];
const untracked: string[] = [];
for (const line of lines) {
  if (line.length < 4) continue;
  const code = line.slice(0, 2);
  // Porcelain v1 quotes a path containing unusual characters; the quoted form
  // is still unambiguous for a report, so it is printed as git gave it.
  const path = line.slice(3);
  if (code === '!!' && isSource(path)) ignored.push(path);
  else if (code === '??' && isSource(path)) untracked.push(path);
}

if (ignored.length === 0 && untracked.length === 0) {
  console.log('every source file under', SOURCE_ROOTS.join(' '), 'is in git.');
  process.exit(0);
}

if (ignored.length > 0) {
  console.error(`\n${String(ignored.length)} source file(s) are IGNORED by .gitignore:\n`);
  for (const path of ignored) {
    // The rule that catches it, so the fix is one line away rather than a hunt.
    let why = '';
    try {
      why = git('check-ignore', '-v', path).trim().split('\t')[0] ?? '';
    } catch {
      why = '(rule not reported)';
    }
    console.error(`  ${path}\n      ${why}`);
  }
  console.error(
    '\nThese will not be committed and `git add` will not say so. An unanchored\n' +
      'directory pattern (`data/` rather than `/data/`) is the usual cause.\n',
  );
}

if (untracked.length > 0) {
  console.error(`\n${String(untracked.length)} source file(s) are untracked:\n`);
  for (const path of untracked) console.error(`  ${path}`);
  console.error('\nAdd them, or they are missing from every clone but this one.\n');
}

process.exit(1);
