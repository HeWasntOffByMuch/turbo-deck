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
import { RADISH_RACCOON_CLIPS } from '../src/units/radish-raccoon-clips.js';
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
for (const clip of RADISH_RACCOON_CLIPS) {
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
    "The radish raccoon family's clip library (spec 277). Two clips and no more, which is the whole roster this " +
    'animal has: it is scenery with a walk, not a combatant, so there is no swing to author and no cast to ' +
    'rebase. Both are authored rather than retargeted -- there is no bought library for a rig that exists ' +
    'nowhere but here -- and their source is `src/units/radish-raccoon-clips.ts`; regenerate the bytes with ' +
    '`npx tsx scripts/make-radish-raccoon-clips.ts`. Neither carries an event: events mark the frame a blow ' +
    'lands, and nothing here lands one.',
  formatVersion: 1,
  id: `${RADISH_RACCOON_FAMILY}.core`,
  skeletonRef: `${RADISH_RACCOON_FAMILY}.skeleton.json`,
  clips: RADISH_RACCOON_CLIPS.map((clip) => ({
    id: clip.id,
    source: `${RADISH_RACCOON_FAMILY}_clips/${clip.id}.glb`,
    durationMs: clip.durationMs,
    loop: true,
    events: [],
  })),
};
writeFileSync(LIBRARY, `${JSON.stringify(library, null, 2)}\n`);
console.log(`${LIBRARY}: ${library.clips.length} clips`);
