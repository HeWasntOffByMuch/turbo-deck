/**
 * Play the biped family's `run` in a straighter posture (spec 163).
 *
 *   npx tsx scripts/straighten-run.ts            # report what the clip is in
 *   npx tsx scripts/straighten-run.ts --write    # and move it to RUN_POSTURE
 *
 * The clip was bought, so there is no source document to re-author: the pose is
 * the bytes. This edits them, and everything about how it does that is arranged
 * around being able to run it twice.
 *
 * **The applied table is recorded in the clip.** `animations[0].extras.posture`
 * says what posture the committed bytes are already in, so a run computes the
 * *delta* to `RUN_POSTURE` and a second run computes zero. Without it the file
 * measures its own last output and every regeneration bends the pig a little
 * further -- the ratcheting failure `plant-foot.ts` had to be anchored against,
 * one directory over and in exactly the same shape.
 *
 * **Only rotation channels are touched, and only on the spine and above.** The
 * legs, the hips and the root are the retarget's own and are where the stride
 * lives; nothing here can move a foot.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeGlbContainer } from '../src/units/glb.js';
import { readNodeTree, splitGlb, type GlbBinary, type GlbReadNode } from '../src/units/glb-read.js';
import { bodyFrame, boneNode, namingOf } from '../src/units/pose.js';
import {
  pitchedPose,
  postureDelta,
  readPosture,
  recordedPosture,
  RUN_POSTURE,
  type PostureTable,
} from '../src/units/posture.js';
import type { BoneRole } from '../src/units/naming.js';
import type { PoseRotations } from '../src/units/skin.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLIP = join(repoRoot, 'assets', 'units', 'clips', 'run.glb');

type Quat = [number, number, number, number];

interface Channel {
  readonly node: number;
  /** Where this channel's keys start in the binary chunk, and how many. */
  readonly at: number;
  readonly keys: number;
}

/** Every rotation channel of the clip's first animation, as byte ranges. */
function rotationChannels(glb: GlbBinary): Channel[] {
  const json = glb.json as {
    animations?: { channels: { sampler: number; target: { node: number; path: string } }[]; samplers: { output: number }[] }[];
    accessors?: { bufferView?: number; byteOffset?: number; count?: number; componentType?: number; type?: string }[];
    bufferViews?: { byteOffset?: number; byteStride?: number }[];
  };
  const animation = json.animations?.[0];
  if (!animation) throw new Error('the clip has no animation');

  const out: Channel[] = [];
  for (const channel of animation.channels) {
    if (channel.target.path !== 'rotation') continue;
    const accessor = json.accessors?.[animation.samplers[channel.sampler]?.output ?? -1];
    if (!accessor || accessor.componentType !== 5126 || accessor.type !== 'VEC4') {
      throw new Error('a rotation channel is not tightly packed float32, which this editor does not rewrite');
    }
    const view = json.bufferViews?.[accessor.bufferView ?? -1];
    if (!view || view.byteStride !== undefined) {
      throw new Error('a rotation channel is interleaved, which this editor does not rewrite');
    }
    out.push({
      node: channel.target.node,
      at: (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0),
      keys: accessor.count ?? 0,
    });
  }
  return out;
}

function multiply(a: Quat, b: Quat): Quat {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

const conjugate = (q: Quat): Quat => [-q[0], -q[1], -q[2], q[3]];

function main(): void {
  const write = process.argv.includes('--write');
  const glb = splitGlb(new Uint8Array(readFileSync(CLIP)));
  const nodes: readonly GlbReadNode[] = readNodeTree(glb);
  const naming = namingOf(nodes);
  if (naming === 'unknown') throw new Error('the run clip is in no bone vocabulary this project reads');
  const frame = bodyFrame(nodes, naming);
  if (!frame) throw new Error('the run clip has no measurable body frame');

  const channels = rotationChannels(glb);
  const keys = channels[0]?.keys ?? 0;
  if (keys === 0) throw new Error('the clip has no rotation keys');

  // A copy, because `splitGlb` hands back a view into the bytes just read.
  const bin = new Uint8Array(glb.bin);
  const floats = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  const byNode = new Map(nodes.map((node) => [node.index, node]));

  /** The clip's own keys, read once so the write does not re-read its own edits. */
  const original = new Map<number, Quat[]>();
  for (const channel of channels) {
    const at = channel.at;
    const list: Quat[] = [];
    for (let key = 0; key < channel.keys; key += 1) {
      const off = at + key * 16;
      list.push([
        floats.getFloat32(off, true),
        floats.getFloat32(off + 4, true),
        floats.getFloat32(off + 8, true),
        floats.getFloat32(off + 12, true),
      ]);
    }
    original.set(channel.node, list);
  }

  const poseAt = (key: number): PoseRotations => {
    const pose = new Map<string, Quat>();
    for (const [index, list] of original) {
      const node = byNode.get(index);
      const absolute = list[key];
      if (!node || !absolute) continue;
      pose.set(node.name, multiply(conjugate(node.rotation as Quat), absolute));
    }
    return pose;
  };

  const applied = recordedPosture(glb.json);
  const delta = postureDelta(RUN_POSTURE, applied);
  const table = (label: string, entries: PostureTable): string =>
    `${label}: ${Object.entries(entries).map(([role, deg]) => `${role} ${deg > 0 ? '+' : ''}${deg}`).join(', ') || 'none'}`;

  console.log(`  ${table('committed', applied)}`);
  console.log(`  ${table('target   ', RUN_POSTURE)}`);
  console.log(`  ${table('delta    ', delta)}`);

  const moved = (Object.keys(delta) as BoneRole[])
    .map((role) => boneNode(nodes, naming, role))
    .filter((node): node is GlbReadNode => node !== undefined);
  if (moved.length !== Object.keys(delta).length) {
    throw new Error('the run clip is missing a bone the posture table names');
  }

  let gazeBefore = 0;
  let leanBefore = 0;
  let gazeAfter = 0;
  let leanAfter = 0;
  for (let key = 0; key < keys; key += 1) {
    const pose = poseAt(key);
    const before = readPosture(nodes, naming, frame, pose);
    const corrected = pitchedPose(nodes, naming, frame, pose, delta);
    const after = readPosture(nodes, naming, frame, corrected);
    if (!before || !after) throw new Error('the run clip has no head, hips or neck to measure');
    gazeBefore += before.gaze / keys;
    leanBefore += before.lean / keys;
    gazeAfter += after.gaze / keys;
    leanAfter += after.lean / keys;

    if (!write) continue;
    // Only the bones the delta names. Writing back every channel would round
    // every rotation in the clip through a float64 and re-encode it, so a
    // no-op run would still show up as a changed file.
    for (const node of moved) {
      const channel = channels.find((entry) => entry.node === node.index);
      const offset = corrected.get(node.name);
      if (!channel || !offset) continue;
      const absolute = multiply(node.rotation as Quat, offset as Quat);
      const length = Math.hypot(...absolute) || 1;
      const off = channel.at + key * 16;
      for (let component = 0; component < 4; component += 1) {
        floats.setFloat32(off + component * 4, (absolute[component] ?? 0) / length, true);
      }
    }
  }

  const say = (n: number): string => `${n >= 0 ? '+' : ''}${n.toFixed(1)}`;
  console.log(`\n  mean over ${keys} keys, against the rig standing at bind:\n`);
  console.log(`    gaze  ${say(gazeBefore)} -> ${say(gazeAfter)} degrees above the horizon`);
  console.log(`    lean  ${say(leanBefore)} -> ${say(leanAfter)} degrees forward of upright`);

  if (!write) {
    console.log('\n  nothing written. Pass --write to move the clip to RUN_POSTURE.');
    return;
  }
  if (Object.keys(delta).length === 0) {
    // The bytes would come out identical -- the record and every key already
    // say this -- so the file is left alone rather than rewritten to itself.
    console.log('\n  the clip is already in the stated posture. Nothing written.');
    return;
  }

  const json = glb.json as { animations: { extras?: Record<string, unknown> }[] };
  const animation = json.animations[0];
  if (animation) animation.extras = { ...(animation.extras ?? {}), posture: { ...RUN_POSTURE } };
  writeFileSync(CLIP, writeGlbContainer(glb.json, bin));
  console.log(`\n  wrote ${CLIP.slice(repoRoot.length + 1)} -- re-run \`npm run bake:units\` to re-hash it.`);
}

main();
