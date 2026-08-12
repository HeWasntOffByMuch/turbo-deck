/**
 * The clip we author is a clip three loads (spec 139).
 *
 * Everything in `src/units/` can say is that the bytes are the bytes it meant to
 * write. Whether `GLTFLoader` accepts them, and whether the track names it
 * derives bind to the bones the mesh actually has, is a question only three can
 * answer -- and until now the only thing in this repo that could ask it was a
 * script that drives a browser.
 *
 * It turns out it can be asked here: `GLTFLoader.parse` needs no WebGL context
 * and no DOM for a file with no textures in it, which an animation-only clip
 * never has. So the one check that used to need a browser runs in `npm test`.
 *
 * The trap this is aimed at is a real one from this codebase's history: three
 * sanitises `mixamorig:Hips` into `mixamorigHips` when it builds a track name,
 * so a name taken from a document matches nothing, strips nothing, and looks
 * exactly like a clean import. The pig's bones have no punctuation in them and
 * so are safe -- and that is a fact worth *asserting* rather than assuming,
 * because the next rig's might not be.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { AnimationClip } from 'three';
import { readNodeTree, splitGlb } from '../../units/glb-read.js';
import { STRIKE_CLIP_ID, STRIKE_DURATION_MS } from '../../units/pig-strike.js';
import { rootMotionTrackNames, trackTravel } from '../../units/root-motion.js';

const UNIT_DIR = join(process.cwd(), 'assets', 'units', 'pig_a_pose_full');
/** The family's clips, which moved out of the unit folder when the fox joined. */
const CLIP_DIR = join(process.cwd(), 'assets', 'units', 'clips');

function read(path: string): ArrayBuffer {
  const bytes = readFileSync(path);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/**
 * Awaited, not called back.
 *
 * `parse` takes an `onLoad` and looks synchronous for a buffer that is already
 * in hand; it is not, and a test that treated it as such found no animation and
 * blamed the file. `parseAsync` is the same call with the promise exposed.
 */
async function parseClip(path: string): Promise<AnimationClip> {
  const gltf = await new GLTFLoader().parseAsync(read(path), '');
  const clip = gltf.animations[0];
  if (!clip) throw new Error('three parsed the file and found no animation in it');
  return clip;
}

describe('the authored swing, through three’s own loader', async () => {
  const clip = await parseClip(join(CLIP_DIR, `${STRIKE_CLIP_ID}.glb`));
  const meshBones = new Set(
    readNodeTree(splitGlb(new Uint8Array(readFileSync(join(UNIT_DIR, 'pig_a_pose_full.glb'))))).map((node) => node.name),
  );

  it('parses, and is as long as the clip library says', () => {
    expect(clip.name).toBe(STRIKE_CLIP_ID);
    expect(clip.duration).toBeCloseTo(STRIKE_DURATION_MS / 1000, 5);
    expect(clip.tracks.length).toBeGreaterThan(0);
  });

  it('binds every track to a bone the pig mesh actually has', () => {
    // The whole point of writing the clip's nodes out of the rig rather than out
    // of a document. A track naming a bone the mesh does not have is not an
    // error anywhere -- the mixer simply never applies it, and the limb sits in
    // its bind pose through the entire swing.
    const unbound = clip.tracks.map((track) => track.name.split('.')[0] ?? '').filter((bone) => !meshBones.has(bone));
    expect(unbound).toEqual([]);
  });

  it('carries nothing but quaternion tracks', () => {
    const kinds = new Set(clip.tracks.map((track) => track.name.split('.').pop()));
    expect([...kinds]).toEqual(['quaternion']);
  });

  it('gives the importer’s root-motion strip nothing to take', () => {
    // `UnitRig` strips translation on the root chain and complains loudly when
    // it has to. An authored clip should never make it complain: the server owns
    // where the body is, and `glb.ts` will not emit a translation channel at all.
    const names = clip.tracks.map((track) => track.name);
    expect(rootMotionTrackNames(names, ['Root', 'Hip', 'Armature'])).toEqual([]);
  });

  it('gives the travel correction nothing to take either', () => {
    // The other half of spec 118: a bone carrying a stride is found by its
    // *values* rather than by its name, and would be corrected on any bone. With
    // no translation track anywhere there is nothing for it to measure, which is
    // what makes an authored clip play exactly as authored.
    const positions = clip.tracks.filter((track) => track.name.endsWith('.position'));
    expect(positions).toEqual([]);
    for (const track of clip.tracks) {
      expect(trackTravel(track.values).distance).toBeGreaterThanOrEqual(0);
    }
  });
});
