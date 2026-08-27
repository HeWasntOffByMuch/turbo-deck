/**
 * Which sound hooks exist, and which of them are silent (spec 229).
 *
 * `npm run audio:report`.
 *
 * A script rather than a paragraph in a spec, for the reason `npm run balance`
 * is a script: the answer changes every time somebody assigns a file, and a
 * number written down in prose is a number that is wrong a week later. It reads
 * the two documents that decide it -- `assets/audio/sfx.json` and the vocabulary
 * in `src/render/audio/events.ts` -- and prints the gap.
 *
 * It also prints what is **unused**, which is the same question from the other
 * side and the one that is otherwise invisible: a take sitting in
 * `public/audio/` that no event references is a recording somebody paid for and
 * nobody can hear.
 *
 * Exits non-zero only with `--strict`, which nothing runs today: an unassigned
 * event is the normal state of a game being built, not a build failure. The flag
 * is there for the day a release wants to say every hook has a sound.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseCatalog, type SoundCatalog } from '../src/render/audio/catalog.js';
import { BUS_LABELS, soundEvent, soundEventSections } from '../src/render/audio/events.js';
import { parseClips, unusedClips } from '../src/render/iso3d/sfx/model.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function read(path: string): string | null {
  try {
    return readFileSync(join(repoRoot, path), 'utf8');
  } catch {
    return null;
  }
}

function main(): void {
  const strict = process.argv.includes('--strict');

  const text = read(join('assets', 'audio', 'sfx.json'));
  let catalog: SoundCatalog = new Map();
  if (text === null) {
    process.stdout.write('no assets/audio/sfx.json -- every event is silent\n\n');
  } else {
    const parsed = parseCatalog(text);
    if ('error' in parsed) {
      process.stderr.write(`assets/audio/sfx.json: ${parsed.error}\n`);
      process.exitCode = 1;
      return;
    }
    catalog = parsed.catalog;
  }

  const manifest = read(join('public', 'audio', 'manifest.json'));
  const clips = manifest === null ? [] : parseClips(JSON.parse(manifest));

  let assigned = 0;
  let total = 0;
  let variants = 0;
  const silent: string[] = [];

  for (const section of soundEventSections()) {
    process.stdout.write(`\n${BUS_LABELS[section.bus]} / ${section.section}\n`);
    for (const event of section.events) {
      total += 1;
      const files = catalog.get(event.id)?.variants ?? [];
      variants += files.length;
      if (files.length > 0) assigned += 1;
      else silent.push(event.id);
      const mark = files.length > 0 ? `${String(files.length)} variant${files.length === 1 ? '' : 's'}` : 'SILENT';
      process.stdout.write(`  ${event.id.padEnd(34)} ${mark.padEnd(11)} ${event.label}\n`);
    }
  }

  const unused = unusedClips(catalog, clips);
  process.stdout.write(
    `\n${String(assigned)}/${String(total)} events have a sound; ` +
      `${String(variants)} variant assignments across ${String(clips.length)} baked clips.\n`,
  );

  if (silent.length > 0) {
    process.stdout.write(`\nSilent (${String(silent.length)}):\n`);
    for (const id of silent) process.stdout.write(`  ${id.padEnd(34)} ${soundEvent(id)?.note ?? ''}\n`);
  }
  if (unused.length > 0) {
    process.stdout.write(`\nBaked but unassigned (${String(unused.length)}):\n`);
    for (const url of unused) process.stdout.write(`  ${url}\n`);
  }

  if (strict && silent.length > 0) process.exitCode = 1;
}

main();
