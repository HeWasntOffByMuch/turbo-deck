/**
 * The bundle gate (spec 199), as a command.
 *
 *   npm run build && npm run check:bundle
 *
 * Reads what the build emitted and hands it to `checkBundle`. Everything that
 * *decides* anything is pure and lives in `src/render/bundle-budget.ts`, which
 * is the same split `grow-map.ts` keeps -- so the thresholds are tested in
 * `npm test` and this file is a directory listing and an exit code.
 */

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { checkBundle, MAX_JS_BYTES, type Emitted } from '../src/render/bundle-budget.js';

/** Every file in a directory, with its size. Not recursive: `dist/assets` is flat. */
function emittedFiles(dir: string): Emitted[] {
  return readdirSync(dir)
    .map((name) => ({ name, bytes: statSync(join(dir, name)).size }))
    .sort((a, b) => b.bytes - a.bytes);
}

function main(): void {
  const dir = join('dist', 'assets');
  let files: Emitted[];
  try {
    files = emittedFiles(dir);
  } catch {
    console.error(`check-bundle: no ${dir}. Run \`npm run build\` first.`);
    process.exit(1);
    return;
  }

  const report = checkBundle(files);
  console.log(
    `emitted JavaScript  ${(report.jsBytes / 1048576).toFixed(2)} MB  ` +
      `(ceiling ${(MAX_JS_BYTES / 1048576).toFixed(2)} MB)`,
  );
  console.log(`largest map asset   ${(report.largestMapAsset / 1048576).toFixed(2)} MB`);
  for (const failure of report.failures) console.error(`check-bundle: ${failure}`);
  process.exit(report.failures.length === 0 ? 0 : 1);
}

main();
