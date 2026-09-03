/**
 * `npm run lint` with a cache that cannot go stale (spec 274).
 *
 * ESLint over this tree is 43s cold and 1.7s warm, and on a repo where the
 * whole local loop is typecheck + lint + test that difference is most of the
 * loop. What makes a bare `--cache` unsafe here is a thing ESLint does not
 * document loudly: **its cache does not invalidate when the config changes.**
 * Measured against eslint 9 on this tree -- edit `eslint.config.js`, re-run
 * with `--cache`, and every file is served from the cache having never been
 * checked against the rule that just changed.
 *
 * That is a bad trade anywhere and a worse one here, because
 * `eslint.config.js` is not style: it is where the determinism fences live --
 * the `Math.random` ban, the `Date`/`performance`/DOM ban, and the import
 * restrictions that keep three.js and `src/render/` out of the deterministic
 * core. A cache that can serve a stale answer about *those* is a cache that
 * can green a branch which breaks the one rule this project has.
 *
 * So the cache is keyed on what decides its answers: the config, and the
 * lockfile that pins the plugins the config loads. Either changes and the key
 * changes, the old cache is simply not read, and the run is cold -- correct by
 * construction rather than by remembering to clear anything.
 *
 * `npm run lint` itself is deliberately left alone and stays what CI runs: a
 * cold, cacheless, authoritative pass. This is the developer's inner loop.
 */

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** Files whose contents decide what a lint run answers. */
const KEY_INPUTS = ['eslint.config.js', 'package-lock.json'];

const key = createHash('sha256');
for (const file of KEY_INPUTS) key.update(readFileSync(file));

const dir = path.join('node_modules', '.cache', 'eslint');
mkdirSync(dir, { recursive: true });
const location = path.join(dir, `${key.digest('hex').slice(0, 16)}.json`);

const result = spawnSync(
  path.join('node_modules', '.bin', 'eslint'),
  // `content` rather than the default `metadata`: a checkout can restore a file
  // with a different body at the same size and mtime, and a lint pass that
  // skips it is the same stale answer by another route.
  ['.', '--cache', '--cache-strategy', 'content', '--cache-location', location, ...process.argv.slice(2)],
  { stdio: 'inherit' },
);

process.exit(result.status ?? 1);
