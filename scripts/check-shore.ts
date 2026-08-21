/**
 * Where the world stops, and whether a player can see it (spec 210).
 *
 *   npx tsx scripts/check-shore.ts [--map maps/arena] [--radius N] [--strict]
 *
 * Prints the report. `--strict` turns it into an exit code, so it can become a
 * CI gate once the map has a coast -- deliberately not the default, because the
 * shipped map fails today and a gate committed red is a gate somebody turns off.
 *
 * What it does not do is author a coastline. Where an island ends is a design
 * decision about the world; this says where the problem is, and a person grows
 * the answer with `grow-map.ts` and reviews it as a diff.
 */

import { MAP_CHUNK_REQUEST_RADIUS } from '../src/server/config.js';
import { DEFAULT_MAP_PATH, loadMapFile } from '../src/server/world/map-file.js';
import { drownedChunks, shoreProblems } from '../src/terrain/shore.js';

function main(): void {
  const argv = process.argv.slice(2);
  let map = DEFAULT_MAP_PATH;
  let radius = MAP_CHUNK_REQUEST_RADIUS;
  let strict = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--map') map = argv[++i] ?? map;
    else if (argv[i] === '--radius') radius = Number(argv[++i] ?? radius);
    else if (argv[i] === '--strict') strict = true;
    else throw new Error(`unknown argument: ${String(argv[i])}`);
  }

  const doc = loadMapFile(map).doc;
  const total = doc.layers.reduce((n, l) => n + l.chunks.length, 0);
  const problems = shoreProblems(doc, radius);
  const drowned = drownedChunks(doc);

  console.log(`${map}: ${String(total)} chunks, ${String(drowned)} of them entirely under water`);
  console.log(
    `walkable ground within ${String(radius)} chunks of undeclared space: ` +
      `${String(problems.length)}`,
  );
  if (problems.length === 0) {
    console.log('\nthe world ends in water everywhere a player could see it.');
    process.exit(0);
  }

  const adjacent = problems.filter((p) => p.toVoid === 1).length;
  console.log(`  of which directly against it: ${String(adjacent)}`);
  console.log('\nfirst twelve:');
  for (const p of problems.slice(0, 12)) {
    console.log(
      `  ${p.layerId} ${String(p.cx)},${String(p.cz)}  ` +
        `${String(p.toVoid)} chunk${p.toVoid === 1 ? '' : 's'} from the void, ` +
        `highest ground ${p.highest.toFixed(1)}`,
    );
  }
  console.log(
    `\nThe radius is ${String(radius)} because that is what the client streams ` +
      `(spec 202's\nsupported zoom), so this rule follows the zoom cap rather ` +
      `than having a number\nof its own. Grow sea beyond these with ` +
      `\`scripts/grow-map.ts\`; the shape of the\ncoast is a design decision and ` +
      `this deliberately does not guess at one.`,
  );
  process.exit(strict ? 1 : 0);
}

main();
