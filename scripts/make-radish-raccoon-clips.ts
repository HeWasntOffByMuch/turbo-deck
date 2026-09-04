/**
 * Write the radish raccoon's `run` and `idle` `.glb`s, and the library that
 * names them (spec 277).
 *
 * `make-pig-strike.ts`'s shape: read the *mesh* for the rig -- never the
 * skeleton document, because what three binds a track to is the bone tree it
 * loaded, and bind rotations have to match what it will actually see -- author
 * the clip against it, and write the animation-only document `glb.ts` emits.
 *
 * The library is written here rather than by hand for the reason the skeleton
 * is: its `durationMs` has to equal the clip's, and two files that have to
 * agree about a number should not be two files somebody edits.
 *
 * `npx tsx scripts/make-radish-raccoon-clips.ts`
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { authorClipDocument, frameCount } from '../src/units/clip-author.js';
import { writeGlb } from '../src/units/glb.js';
import { readNodeTree, splitGlb } from '../src/units/glb-read.js';
import { namingOf } from '../src/units/pose.js';
import { RADISH_RACCOON_LIBRARY } from '../src/units/radish-raccoon-clips.js';
import { RADISH_RACCOON_FAMILY } from '../src/units/radish-raccoon-rig.js';

const MESH = 'assets/units/radish_raccoon_2/radish_raccoon_2.glb';
const CLIP_DIR = `assets/units/${RADISH_RACCOON_FAMILY}_clips`;
const LIBRARY = `assets/units/${RADISH_RACCOON_FAMILY}.core.cliplib.json`;
const GENERATOR = 'turbo-deck scripts/make-radish-raccoon-clips.ts';

const glb = splitGlb(new Uint8Array(readFileSync(MESH)));
const nodes = readNodeTree(glb);
const naming = namingOf(nodes);
if (naming === 'unknown') {
  throw new Error(`${MESH} answers to neither naming contract, so no clip can be authored against it`);
}
const rig = { nodes, naming } as const;

mkdirSync(CLIP_DIR, { recursive: true });
for (const { clip } of RADISH_RACCOON_LIBRARY) {
  const document = authorClipDocument(clip, rig, GENERATOR);
  const bytes = writeGlb(document);
  writeFileSync(`${CLIP_DIR}/${clip.id}.glb`, bytes);
  const channels = document.animations[0]?.channels.length ?? 0;
  console.log(
    `${CLIP_DIR}/${clip.id}.glb: ${clip.durationMs}ms, ${frameCount(clip)} frames, ${channels} bones, ${(bytes.byteLength / 1024).toFixed(1)} KB`,
  );
}

const library = {
  $comment:
    "The radish raccoon family's clip library (spec 277). Three clips: it stands about, it runs, and it " +
    'pounces. There is no cast to rebase and no death, which is the roster the state machine declares and no ' +
    'more. All three are authored rather than retargeted -- there is no bought library for a rig that exists ' +
    'nowhere but here -- and their source is `src/units/radish-raccoon-clips.ts`; regenerate the bytes with ' +
    '`npx tsx scripts/make-radish-raccoon-clips.ts`. Only `attack` carries events, because an event marks the ' +
    'frame a blow lands and it is the only clip that lands one; its `swing.impact` is at 500 of 900ms, which ' +
    'is `melee.slash`\'s own wind-up, so the frame the picture lands and the frame the damage lands are the ' +
    'same frame.',
  formatVersion: 1,
  id: `${RADISH_RACCOON_FAMILY}.core`,
  skeletonRef: `${RADISH_RACCOON_FAMILY}.skeleton.json`,
  clips: RADISH_RACCOON_LIBRARY.map(({ clip, loop, events }) => ({
    id: clip.id,
    source: `${RADISH_RACCOON_FAMILY}_clips/${clip.id}.glb`,
    durationMs: clip.durationMs,
    loop,
    events,
  })),
};
writeFileSync(LIBRARY, `${JSON.stringify(library, null, 2)}\n`);
console.log(`${LIBRARY}: ${library.clips.length} clips`);
